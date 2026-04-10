/**
 * OAuth2 client-credentials flow for the Warcraft Logs V2 API.
 *
 * WCL does not document token expiry for this flow; the response does include
 * an `expires_in` (seconds) field, which we honor. On 401 we also invalidate
 * and re-fetch, so stale-token cases self-heal.
 */

const TOKEN_ENDPOINT = "https://www.warcraftlogs.com/oauth/token";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface CachedToken {
  accessToken: string;
  /** epoch ms at which this token should be considered expired */
  expiresAt: number;
}

let cached: CachedToken | null = null;
/** Deduplicate concurrent token fetches so we never hammer the OAuth endpoint. */
let inflight: Promise<string> | null = null;

/** Margin applied to expiry checks so we refresh slightly before the real deadline. */
const EXPIRY_MARGIN_MS = 60_000;

export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
    return cached.accessToken;
  }
  if (inflight) return inflight;

  inflight = fetchToken()
    .then((token) => {
      cached = token;
      return token.accessToken;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** Force the next getAccessToken() call to re-fetch. Call on 401. */
export function invalidateToken(): void {
  cached = null;
}

async function fetchToken(): Promise<CachedToken> {
  const clientId = process.env.WCL_CLIENT_ID;
  const clientSecret = process.env.WCL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing WCL_CLIENT_ID and/or WCL_CLIENT_SECRET environment variables. " +
        "Create a V2 API client at https://www.warcraftlogs.com/api/clients/ and set them in .env."
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    // Deliberately do NOT include the request body or Authorization header in
    // the error — would leak the client secret into logs/tool outputs.
    const text = await res.text().catch(() => "");
    throw new Error(
      `WCL OAuth token request failed: HTTP ${res.status} ${res.statusText}${
        text ? ` — ${text}` : ""
      }`
    );
  }

  const body = (await res.json()) as TokenResponse;
  if (!body.access_token || typeof body.expires_in !== "number") {
    throw new Error("WCL OAuth token response missing access_token or expires_in");
  }

  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}
