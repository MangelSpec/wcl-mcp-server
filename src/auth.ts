/**
 * OAuth2 for the Warcraft Logs V2 API. Two modes, chosen automatically:
 *
 * - **user** — an authorization-code token minted by `npm run auth` and stored
 *   on disk (see tokenStore.ts). Authenticates *you*, so private reports you
 *   own resolve. Requires the `/api/v2/user` GraphQL endpoint.
 * - **client** — the client-credentials flow. Authenticates the API client
 *   only; public (and unlisted) reports only. Uses `/api/v2/client`.
 *
 * Presence of the stored user token selects user mode; otherwise we fall back
 * to client credentials, so an install that never runs `npm run auth` behaves
 * exactly as it did before this existed.
 *
 * WCL does not document token expiry for either flow; both responses include
 * `expires_in` (seconds), which we honor. On 401 we also invalidate and
 * re-fetch (refreshing the user token if we hold a refresh token), so stale-
 * token cases self-heal.
 */

import { readStoredToken, writeStoredToken, type StoredToken } from "./tokenStore.js";

export const OAUTH_TOKEN_ENDPOINT = "https://www.warcraftlogs.com/oauth/token";
export const OAUTH_AUTHORIZE_ENDPOINT = "https://www.warcraftlogs.com/oauth/authorize";

/** Loopback only — WCL will not redirect to a non-registered URI, and this one never leaves the machine. */
const DEFAULT_REDIRECT_URI = "http://localhost:4477/callback";

export type AuthMode = "user" | "client";

export interface AuthContext {
  accessToken: string;
  mode: AuthMode;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface CachedToken {
  accessToken: string;
  mode: AuthMode;
  /** epoch ms at which this token should be considered expired */
  expiresAt: number;
}

let cached: CachedToken | null = null;
/** Deduplicate concurrent token fetches so we never hammer the OAuth endpoint. */
let inflight: Promise<AuthContext> | null = null;
/** Set by invalidateToken(); forces a refresh-token round trip even if the clock says we're fine. */
let forceRefresh = false;

/**
 * Negative cache: if token resolution fails (bad credentials, OAuth endpoint
 * down), remember the error briefly so a burst of tool calls doesn't hammer the
 * OAuth endpoint with the same failing request. Short TTL so the user can fix
 * their .env — or run `npm run auth` — and recover on the next call without
 * restarting the server.
 */
interface CachedAuthError {
  error: Error;
  expiresAt: number;
}
let cachedError: CachedAuthError | null = null;
const ERROR_CACHE_TTL_MS = 10_000;

/** Margin applied to expiry checks so we refresh slightly before the real deadline. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Resolve a usable bearer token plus the mode it was issued under. Callers need
 * the mode as well as the token: the two flows are served by different GraphQL
 * endpoints, and sending a user token to `/api/v2/client` silently downgrades
 * you to public-only access rather than erroring.
 */
export async function getAuth(): Promise<AuthContext> {
  if (cached && !forceRefresh && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
    return { accessToken: cached.accessToken, mode: cached.mode };
  }
  if (cachedError && cachedError.expiresAt > Date.now()) {
    throw cachedError.error;
  }
  if (inflight) return inflight;

  inflight = resolveAuth()
    .then((token) => {
      cached = token;
      cachedError = null;
      forceRefresh = false;
      return { accessToken: token.accessToken, mode: token.mode };
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      cachedError = { error, expiresAt: Date.now() + ERROR_CACHE_TTL_MS };
      throw error;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Force the next getAuth() call to re-fetch (refreshing a user token if possible). Call on 401. */
export function invalidateToken(): void {
  cached = null;
  cachedError = null;
  forceRefresh = true;
}

/**
 * Which mode the last successful token resolution used, or null if we haven't
 * resolved one yet. Diagnostics only — never gate a request on this, since it
 * lags behind a token that expired or was just authorized.
 */
export function getCachedAuthMode(): AuthMode | null {
  return cached?.mode ?? null;
}

async function resolveAuth(): Promise<CachedToken> {
  // Re-read the file on every *resolution* rather than caching the parse, so a
  // re-authorized token is picked up without a restart. Note this only helps
  // once the in-memory token actually needs resolving — after a 401, or at
  // expiry. WCL tokens last about a year, so switching modes on a live server
  // still effectively requires a restart; `npm run auth` says so explicitly.
  const stored = readStoredToken();
  if (stored) return resolveUserToken(stored);
  return resolveClientToken();
}

async function resolveUserToken(stored: StoredToken): Promise<CachedToken> {
  const stillValid = stored.expiresAt > Date.now() + EXPIRY_MARGIN_MS;
  if (stillValid && !forceRefresh) {
    return { accessToken: stored.accessToken, mode: "user", expiresAt: stored.expiresAt };
  }

  if (!stored.refreshToken) {
    if (stillValid) {
      // forceRefresh after a 401, but we have no way to refresh. Hand back what
      // we have; the caller's retry will fail loudly rather than silently
      // downgrading to public data.
      return { accessToken: stored.accessToken, mode: "user", expiresAt: stored.expiresAt };
    }
    throw new Error(
      "Your Warcraft Logs user token has expired and no refresh token was stored. " +
        "Re-run `npm run auth` to re-authorize.",
    );
  }

  let refreshed: TokenResponse;
  try {
    refreshed = await postTokenRequest(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refreshToken }),
    );
  } catch (err) {
    throw new Error(
      `Refreshing your Warcraft Logs user token failed: ${
        err instanceof Error ? err.message : String(err)
      }. Re-run \`npm run auth\` to re-authorize.`,
    );
  }

  const next: StoredToken = {
    accessToken: refreshed.access_token,
    // WCL may rotate the refresh token or omit it; keep the old one if so.
    refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    obtainedAt: Date.now(),
  };
  writeStoredToken(next);

  return { accessToken: next.accessToken, mode: "user", expiresAt: next.expiresAt };
}

async function resolveClientToken(): Promise<CachedToken> {
  const body = await postTokenRequest(new URLSearchParams({ grant_type: "client_credentials" }));
  return {
    accessToken: body.access_token,
    mode: "client",
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

/** The client ID/secret from .env. Exported so the `npm run auth` script uses one source of truth. */
export function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing WCL_CLIENT_ID and/or WCL_CLIENT_SECRET environment variables. " +
        "Create a V2 API client at https://www.warcraftlogs.com/api/clients/ and set them in .env.",
    );
  }
  return { clientId, clientSecret };
}

/**
 * The redirect URI for the authorization-code flow. Must match one registered
 * on the WCL client *exactly*, including port and path.
 */
export function getRedirectUri(): string {
  const override = process.env.WCL_REDIRECT_URI;
  return override && override.trim() ? override.trim() : DEFAULT_REDIRECT_URI;
}

/**
 * POST to WCL's token endpoint with HTTP Basic client auth. Shared by all three
 * grant types (client_credentials, authorization_code, refresh_token).
 */
export async function postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const { clientId, clientSecret } = getClientCredentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    // Deliberately do NOT include the request body or Authorization header in
    // the error — would leak the client secret, auth code, or refresh token
    // into logs/tool outputs.
    const text = await res.text().catch(() => "");
    throw new Error(
      `WCL OAuth token request failed: HTTP ${res.status} ${res.statusText}${
        text ? ` — ${truncateErrorBody(text)}` : ""
      }`,
    );
  }

  const parsed = (await res.json()) as TokenResponse;
  if (!parsed.access_token || typeof parsed.expires_in !== "number") {
    throw new Error("WCL OAuth token response missing access_token or expires_in");
  }
  return parsed;
}

// Inlined here rather than imported from client.ts — client.ts already imports
// from this module, and a reverse import would create a cycle. It's ten lines;
// duplication is cheaper than an extra util file.
const AUTH_ERROR_BODY_MAX_CHARS = 500;
function truncateErrorBody(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= AUTH_ERROR_BODY_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, AUTH_ERROR_BODY_MAX_CHARS)}… (+${
    collapsed.length - AUTH_ERROR_BODY_MAX_CHARS
  } chars truncated)`;
}
