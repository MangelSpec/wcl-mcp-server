/**
 * GraphQL executor for the Warcraft Logs V2 API.
 *
 * - Injects the OAuth bearer token via auth.ts, and routes to the endpoint that
 *   matches the token's flow: `/api/v2/user` for a user (authorization-code)
 *   token, `/api/v2/client` for client credentials. Sending a user token to the
 *   client endpoint does not error — it just silently drops you back to
 *   public-only visibility, so the pairing matters.
 * - Configurable request timeout (60s by default)
 * - Parses `rateLimitData` out of any response that happens to include it
 *   and caches it in-process (advisory only — see dev doc)
 * - On 401, invalidates the cached token and retries once
 * - On 429, surfaces a structured WclRateLimitError with reset info
 */

import { getAuth, invalidateToken, type AuthMode } from "./auth.js";

const GRAPHQL_ENDPOINTS: Record<AuthMode, string> = {
  user: "https://www.warcraftlogs.com/api/v2/user",
  client: "https://www.warcraftlogs.com/api/v2/client",
};
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 180_000;

export function parseRequestTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("WCL_REQUEST_TIMEOUT_MS must be an integer");
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_REQUEST_TIMEOUT_MS ||
    timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `WCL_REQUEST_TIMEOUT_MS must be between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export interface RateLimitData {
  limitPerHour: number;
  pointsSpentThisHour: number;
  pointsResetIn: number;
}

export interface GraphQLError {
  message: string;
  path?: ReadonlyArray<string | number>;
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
}

export class WclRateLimitError extends Error {
  constructor(
    message: string,
    public readonly rateLimit: RateLimitData | null,
  ) {
    super(message);
    this.name = "WclRateLimitError";
  }
}

let lastRateLimit: RateLimitData | null = null;

/** Returns the most recent rate limit snapshot observed from any query, or null if never seen. */
export function getLastRateLimit(): RateLimitData | null {
  return lastRateLimit;
}

interface ExecuteOptions {
  /** Internal — used to prevent infinite 401 retry loops. */
  _retriedOn401?: boolean;
  /** Internal cancellation for shared structured evidence loads. */
  signal?: AbortSignal;
  /** Internal metrics sink for structured evidence cache telemetry. */
  onResponse?: (metrics: { decodedBytes: number; durationMs: number }) => void;
}

export async function executeGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  options: ExecuteOptions = {},
): Promise<GraphQLResponse<T>> {
  const { accessToken, mode } = await getAuth();
  const endpoint = GRAPHQL_ENDPOINTS[mode];
  const requestTimeoutMs = parseRequestTimeoutMs(
    process.env.WCL_REQUEST_TIMEOUT_MS,
  );

  const controller = new AbortController();
  const requestStartedAt = performance.now();
  let timedOut = false;
  let res: Response | undefined;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: controller.signal,
    });
    const responseText = await readResponseText(res, controller.signal);
    options.onResponse?.({
      decodedBytes: Buffer.byteLength(responseText),
      durationMs: Math.max(0, performance.now() - requestStartedAt),
    });

    // 401 — token rejected. Invalidate and retry once. In user mode the retry
    // also forces a refresh-token round trip, which is what recovers a token that
    // WCL expired earlier than its stated `expires_in`.
    if (res.status === 401 && !options._retriedOn401) {
      await res.body?.cancel();
      invalidateToken();
      return executeGraphQL<T>(query, variables, {
        _retriedOn401: true,
        ...(options.onResponse === undefined
          ? {}
          : { onResponse: options.onResponse }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }

    // A 401 that survives the retry means the credential itself is bad, not stale.
    if (res.status === 401) {
      throw new Error(
        mode === "user"
          ? "WCL rejected your user token (HTTP 401) even after refreshing. " +
              "Re-run `npm run auth` to re-authorize."
          : "WCL rejected the client credentials (HTTP 401). Check WCL_CLIENT_ID / " +
              "WCL_CLIENT_SECRET in .env.",
      );
    }

    // 429 — rate limited. Try to surface the reset interval if we have one cached.
    if (res.status === 429) {
      throw new WclRateLimitError(
        `WCL rate limit exceeded (HTTP 429).${
          lastRateLimit
            ? ` Points resets in ~${lastRateLimit.pointsResetIn}s.`
            : " Try wcl_get_rate_limit to see when points reset."
        }`,
        lastRateLimit,
      );
    }

    if (!res.ok) {
      throw new Error(
        `WCL GraphQL HTTP error: ${res.status} ${res.statusText}${
          responseText ? ` — ${truncateUpstreamBody(responseText)}` : ""
        }`,
      );
    }

    const body = JSON.parse(responseText) as GraphQLResponse<T>;

    // Opportunistically scrape rateLimitData from any response shape that happens
    // to include it at the root of `data`. Structured tools append it to their
    // queries deliberately; wcl_graphql does not. Either way, if it's here, we use it.
    if (body.data && typeof body.data === "object") {
      const maybeRl = (body.data as Record<string, unknown>).rateLimitData;
      if (isRateLimitData(maybeRl)) {
        lastRateLimit = maybeRl;
      }
    }

    return body;
  } catch (err) {
    if (controller.signal.aborted || isAbortError(err)) {
      if (!timedOut && options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new DOMException("The operation was aborted", "AbortError");
      }
      throw new Error(
        `WCL GraphQL request timed out after ${requestTimeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", abortFromCaller);
    if (res && !res.bodyUsed) await res.body?.cancel().catch(() => undefined);
  }
}

async function readResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const abortRead = () =>
    void reader.cancel(signal.reason).catch(() => undefined);
  if (signal.aborted) abortRead();
  else signal.addEventListener("abort", abortRead, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    if (signal.aborted) throw abortError(signal.reason);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Truncate an upstream response body for inclusion in an error message.
 * WCL (or a fronting CDN) can return many KB of HTML on 5xx/edge errors,
 * which would otherwise bloat tool output and risk leaking internal hosts
 * or stack traces. 500 chars is enough to show the useful first line of
 * most JSON or HTML error payloads.
 */
const UPSTREAM_BODY_MAX_CHARS = 500;
export function truncateUpstreamBody(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= UPSTREAM_BODY_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, UPSTREAM_BODY_MAX_CHARS)}… (+${
    collapsed.length - UPSTREAM_BODY_MAX_CHARS
  } chars truncated)`;
}

function isRateLimitData(value: unknown): value is RateLimitData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.limitPerHour === "number" &&
    typeof v.pointsSpentThisHour === "number" &&
    typeof v.pointsResetIn === "number"
  );
}

/**
 * Convenience helper: run a query, throw on GraphQL-level errors, return `data`.
 * Use this from structured tools where any error should bubble up as a rejection.
 * Raw `wcl_graphql` should call executeGraphQL directly so it can return errors
 * in the response body untouched.
 */
export async function executeAndUnwrap<T>(
  query: string,
  variables?: Record<string, unknown>,
  options: Pick<ExecuteOptions, "onResponse" | "signal"> = {},
): Promise<T> {
  const res = await executeGraphQL<T>(query, variables, options);
  if (res.errors?.length) {
    const msg = res.errors.map((e) => e.message).join("; ");
    throw new Error(`WCL GraphQL errors: ${msg}`);
  }
  if (!res.data) {
    throw new Error("WCL GraphQL response missing `data`");
  }
  return res.data;
}
