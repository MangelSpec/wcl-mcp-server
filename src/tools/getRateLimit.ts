/**
 * wcl_get_rate_limit — check the current V2 API rate limit status.
 *
 * This is the simplest possible tool and serves as the end-to-end smoke test
 * for auth + GraphQL client + MCP wiring. If this works, everything else is
 * just more of the same pattern.
 */

import { executeAndUnwrap, RateLimitData } from "../client.js";
import { getCachedAuthMode, type AuthMode } from "../auth.js";

const QUERY = /* GraphQL */ `
  query {
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

interface QueryResult {
  rateLimitData: RateLimitData;
}

export interface RateLimitResult extends RateLimitData {
  /**
   * Which OAuth flow served this request. "user" means private reports owned by
   * the authorized account are visible; "client" means public/unlisted only.
   * Reported here because it's the cheapest way for an agent (or a human) to
   * confirm which visibility they're operating under before blaming a missing
   * report on a bad code.
   */
  authMode: AuthMode;
}

export async function getRateLimit(): Promise<RateLimitResult> {
  const data = await executeAndUnwrap<QueryResult>(QUERY);
  if (!data.rateLimitData) {
    throw new Error("WCL response did not include rateLimitData");
  }
  // Safe to read after the call: a successful request means a token resolved.
  return { ...data.rateLimitData, authMode: getCachedAuthMode() ?? "client" };
}
