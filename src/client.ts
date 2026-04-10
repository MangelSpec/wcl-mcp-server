/**
 * GraphQL executor for the Warcraft Logs V2 API.
 *
 * - Injects the OAuth bearer token via auth.ts
 * - 30s request timeout
 * - Parses `rateLimitData` out of any response that happens to include it
 *   and caches it in-process (advisory only — see dev doc)
 * - On 401, invalidates the cached token and retries once
 * - On 429, surfaces a structured WclRateLimitError with reset info
 */

import { getAccessToken, invalidateToken } from "./auth.js";

const GRAPHQL_ENDPOINT = "https://www.warcraftlogs.com/api/v2/client";
const REQUEST_TIMEOUT_MS = 30_000;

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
}

export async function executeGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  options: ExecuteOptions = {},
): Promise<GraphQLResponse<T>> {
  const token = await getAccessToken();

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`WCL GraphQL request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  // 401 — token rejected. Invalidate and retry once.
  if (res.status === 401 && !options._retriedOn401) {
    invalidateToken();
    return executeGraphQL<T>(query, variables, { _retriedOn401: true });
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
    const text = await res.text().catch(() => "");
    throw new Error(
      `WCL GraphQL HTTP error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const body = (await res.json()) as GraphQLResponse<T>;

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
): Promise<T> {
  const res = await executeGraphQL<T>(query, variables);
  if (res.errors?.length) {
    const msg = res.errors.map((e) => e.message).join("; ");
    throw new Error(`WCL GraphQL errors: ${msg}`);
  }
  if (!res.data) {
    throw new Error("WCL GraphQL response missing `data`");
  }
  return res.data;
}
