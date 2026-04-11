/**
 * wcl_get_table — summary table for a fight (damage, healing, deaths, etc.).
 *
 * The response shape varies per view and WCL returns it as an untyped JSON
 * blob. We pass it through unchanged — the consumer does any mapping.
 * This matches the "mirror WCL's shapes" design principle from the dev doc.
 *
 * Input takes a `fightID` (convenient) which is resolved to startTime/endTime
 * time bounds via the report cache. First call per report costs an extra
 * fights query; subsequent calls are free.
 *
 * The `view` parameter uses the friendly URL-slug names from WCL's website
 * (`damage-done`, `healing`, ...) and we map them to the corresponding
 * TableDataType enum values accepted by the API.
 */

import { executeAndUnwrap } from "../client.js";
import { resolveFightBounds } from "../reportCache.js";

/**
 * Mapping from friendly view slug → WCL's `TableDataType` enum value.
 *
 * Verified against live introspection of the WCL schema (see the
 * scripts/smoke-test.mjs introspection step — it re-verifies this on
 * every run). As of verification, WCL's TableDataType enum values are:
 *   Summary, Buffs, Casts, DamageDone, DamageTaken, Deaths, Debuffs,
 *   Dispels, Healing, Interrupts, Resources, Summons, Survivability, Threat
 *
 * The WCL website URL slug `resources-gains` has no distinct TableDataType
 * — `Resources` alone is what you want. We drop `resources-gains` rather
 * than guess a synonym. If you need resource gains specifically, use
 * wcl_get_events with `dataType: Resources` instead.
 */
export const VIEW_TO_DATA_TYPE = {
  "damage-done": "DamageDone",
  healing: "Healing",
  "damage-taken": "DamageTaken",
  casts: "Casts",
  buffs: "Buffs",
  debuffs: "Debuffs",
  deaths: "Deaths",
  survivability: "Survivability",
  resources: "Resources",
  summons: "Summons",
  dispels: "Dispels",
  interrupts: "Interrupts",
  threat: "Threat",
  summary: "Summary",
} as const satisfies Record<string, string>;

export type TableView = keyof typeof VIEW_TO_DATA_TYPE;

export const TABLE_VIEWS = Object.keys(VIEW_TO_DATA_TYPE) as TableView[];

export interface GetTableArgs {
  reportCode: string;
  fightID: number;
  view: TableView;
  sourceID?: number;
  targetID?: number;
  abilityID?: number;
}

export interface GetTableResult {
  reportCode: string;
  fightID: number;
  view: TableView;
  startTime: number;
  endTime: number;
  /** WCL's table payload, shape varies by view. */
  table: unknown;
}

const QUERY = /* GraphQL */ `
  query (
    $code: String!
    $startTime: Float!
    $endTime: Float!
    $dataType: TableDataType
    $sourceID: Int
    $targetID: Int
    $abilityID: Float
  ) {
    reportData {
      report(code: $code) {
        table(
          startTime: $startTime
          endTime: $endTime
          dataType: $dataType
          sourceID: $sourceID
          targetID: $targetID
          abilityID: $abilityID
        )
      }
    }
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

interface QueryResult {
  reportData: {
    report: {
      table: unknown;
    } | null;
  };
}

export async function getTable(args: GetTableArgs): Promise<GetTableResult> {
  // args.view is typed as TableView and the MCP boundary re-validates with
  // requireEnum(TABLE_VIEWS), so the lookup is guaranteed to hit a value.
  const dataType = VIEW_TO_DATA_TYPE[args.view];

  const { startTime, endTime } = await resolveFightBounds(args.reportCode, args.fightID);

  const variables: Record<string, unknown> = {
    code: args.reportCode,
    startTime,
    endTime,
    dataType,
  };
  if (args.sourceID !== undefined) variables.sourceID = args.sourceID;
  if (args.targetID !== undefined) variables.targetID = args.targetID;
  if (args.abilityID !== undefined) variables.abilityID = args.abilityID;

  const data = await executeAndUnwrap<QueryResult>(QUERY, variables);
  if (!data.reportData.report) {
    throw new Error(`WCL report not found: ${args.reportCode}`);
  }

  return {
    reportCode: args.reportCode,
    fightID: args.fightID,
    view: args.view,
    startTime,
    endTime,
    table: data.reportData.report.table,
  };
}
