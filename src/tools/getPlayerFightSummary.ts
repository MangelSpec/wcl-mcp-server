import { executeAndUnwrap } from "../client.js";
import { addFightRelativeTimes } from "../fightTime.js";
import { resolveFightBounds } from "../reportCache.js";

export interface GetPlayerFightSummaryArgs {
  fightID: number;
  includeRawTables?: boolean;
  reportCode: string;
  sourceID: number;
}

const QUERY = /* GraphQL */ `
  query PlayerFightSummary(
    $code: String!
    $fightIDs: [Int!]!
    $sourceID: Int!
    $includeRawTables: Boolean!
  ) {
    reportData {
      report(code: $code) {
        damage: table(
          fightIDs: $fightIDs
          sourceID: $sourceID
          dataType: DamageDone
        )
        casts: table(fightIDs: $fightIDs, sourceID: $sourceID, dataType: Casts)
        buffs: table(fightIDs: $fightIDs, sourceID: $sourceID, dataType: Buffs)
        resources: table(
          fightIDs: $fightIDs
          sourceID: $sourceID
          dataType: Resources
        ) @include(if: $includeRawTables)
        deaths: table(
          fightIDs: $fightIDs
          sourceID: $sourceID
          dataType: Deaths
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
      buffs: unknown;
      casts: unknown;
      damage: unknown;
      deaths: unknown;
      resources: unknown;
    } | null;
  };
}

export async function getPlayerFightSummary(args: GetPlayerFightSummaryArgs) {
  const bounds = await resolveFightBounds(args.reportCode, args.fightID);
  const data = await executeAndUnwrap<QueryResult>(QUERY, {
    code: args.reportCode,
    fightIDs: [args.fightID],
    sourceID: args.sourceID,
    includeRawTables: args.includeRawTables ?? false,
  });
  const report = data.reportData.report;
  if (!report) throw new Error(`WCL report not found: ${args.reportCode}`);
  const metrics = extractPerformanceMetrics(
    report,
    bounds.startTime,
    bounds.endTime,
  );
  return {
    reportCode: args.reportCode,
    fightID: args.fightID,
    sourceID: args.sourceID,
    fightDurationMs: bounds.endTime - bounds.startTime,
    payloadStability: "undocumented-json",
    metrics,
    rawTablesIncluded: args.includeRawTables ?? false,
    ...(args.includeRawTables
      ? {
          rawTables: {
            damage: addFightRelativeTimes(
              report.damage,
              bounds.startTime,
              bounds.endTime,
            ),
            casts: addFightRelativeTimes(
              report.casts,
              bounds.startTime,
              bounds.endTime,
            ),
            buffs: addFightRelativeTimes(
              report.buffs,
              bounds.startTime,
              bounds.endTime,
            ),
            resources: addFightRelativeTimes(
              report.resources,
              bounds.startTime,
              bounds.endTime,
            ),
            deaths: addFightRelativeTimes(
              report.deaths,
              bounds.startTime,
              bounds.endTime,
            ),
          },
        }
      : {}),
  };
}

export function extractPerformanceMetrics(
  report: {
    buffs: unknown;
    casts: unknown;
    damage: unknown;
    deaths: unknown;
  },
  fightStartTime: number,
  fightEndTime: number,
) {
  const damageEntries = getArray(getData(report.damage), "entries");
  const castEntries = getArray(getData(report.casts), "entries");
  const buffEntries = getArray(getData(report.buffs), "auras");
  const deathEntries = getArray(getData(report.deaths), "entries");
  const durationMs = fightEndTime - fightStartTime;
  const deathTime = deathEntries
    .map((entry) => finiteNumber(entry.deathTime))
    .find((value) => value !== null);

  return {
    aliveTimeMs:
      deathTime === undefined
        ? durationMs
        : Math.min(Math.max(deathTime - fightStartTime, 0), durationMs),
    bossDamage: damageEntries.reduce(
      (total, entry) =>
        total +
        getArray(entry, "targets")
          .filter((target) => target.type === "Boss")
          .reduce((sum, target) => sum + (finiteNumber(target.total) ?? 0), 0),
      0,
    ),
    buffs: buffEntries.map((entry) => ({
      abilityID: finiteNumber(entry.guid),
      name: stringOrNull(entry.name),
      totalUptimeMs: finiteNumber(entry.totalUptime) ?? 0,
      totalUses: finiteNumber(entry.totalUses) ?? 0,
    })),
    casts: castEntries
      .map((entry) => ({
        abilityID: finiteNumber(entry.guid),
        count: finiteNumber(entry.total) ?? 0,
        name: stringOrNull(entry.name),
      }))
      .filter(
        (entry): entry is { abilityID: number; count: number; name: string } =>
          entry.abilityID !== null && entry.name !== null,
      ),
    durationMs,
    totalDamage: damageEntries.reduce(
      (total, entry) => total + (finiteNumber(entry.total) ?? 0),
      0,
    ),
  };
}

function getData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const data = (value as Record<string, unknown>).data;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

function getArray(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const entries = value[key];
  return Array.isArray(entries)
    ? entries.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null,
      )
    : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
