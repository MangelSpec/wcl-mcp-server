/**
 * wcl_get_rate_limit — check the current V2 API rate limit status.
 *
 * This is the simplest possible tool and serves as the end-to-end smoke test
 * for auth + GraphQL client + MCP wiring. If this works, everything else is
 * just more of the same pattern.
 */

import { executeAndUnwrap, RateLimitData } from "../client.js";

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

export async function getRateLimit(): Promise<RateLimitData> {
  const data = await executeAndUnwrap<QueryResult>(QUERY);
  if (!data.rateLimitData) {
    throw new Error("WCL response did not include rateLimitData");
  }
  return data.rateLimitData;
}
