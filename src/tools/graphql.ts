/**
 * wcl_graphql — raw GraphQL escape hatch for the WCL V2 API.
 *
 * Unlike the structured tools, this one calls `executeGraphQL` directly
 * (NOT `executeAndUnwrap`) so that GraphQL-level errors come back in the
 * response body verbatim. The point of this tool is to give agents a
 * full-power fallback for anything the structured tools don't cover —
 * debugging, introspection, exotic fields, experimentation — and part of
 * that is letting them see exactly what WCL said.
 *
 * We intentionally do NOT try to auto-inject `rateLimitData` into the
 * caller's query. Parsing arbitrary GraphQL to splice in a sibling field
 * at the right place is fragile. If the caller wants rate-limit visibility
 * they can append `rateLimitData { limitPerHour pointsSpentThisHour
 * pointsResetIn }` to their own query root, or call wcl_get_rate_limit
 * separately. The tool description tells them so.
 */

import { executeGraphQL, type GraphQLResponse } from "../client.js";

export interface RunGraphQLArgs {
  query: string;
  variables?: Record<string, unknown>;
}

export type RunGraphQLResult = GraphQLResponse<unknown>;

export async function runGraphQL(args: RunGraphQLArgs): Promise<RunGraphQLResult> {
  return executeGraphQL<unknown>(args.query, args.variables);
}
