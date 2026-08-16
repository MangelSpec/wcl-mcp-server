import { executeAndUnwrap } from "../client.js";
import { addFightRelativeTimes } from "../fightTime.js";
import { getCachedReport, type Fight } from "../reportCache.js";
import { compactTable } from "./getFightOverview.js";
import {
  type TableView,
  VIEW_TO_DATA_TYPE,
} from "./getTable.js";

export const MAX_FIGHT_SET_SIZE = 50;
export const MAX_FIGHT_SET_VIEWS = 4;
export const DEFAULT_FIGHT_SET_ROWS = 40;
export const MAX_FIGHT_SET_ROWS = 100;

export interface AnalyzeFightSetArgs {
  abilityID?: number;
  fightIDs: number[];
  maxRows?: number;
  reportCode: string;
  sourceID?: number;
  targetID?: number;
  views: TableView[];
}

interface QueryResult {
  reportData: {
    report: ({ code: string; title: string } & Record<string, unknown>) | null;
  };
}

export async function analyzeFightSet(args: AnalyzeFightSetArgs) {
  const fightIDs = uniqueBoundedNumbers(
    args.fightIDs,
    "fightIDs",
    MAX_FIGHT_SET_SIZE,
  );
  const views = [...new Set(args.views)];
  if (views.length < 1 || views.length > MAX_FIGHT_SET_VIEWS) {
    throw new Error(
      `views must contain 1 to ${MAX_FIGHT_SET_VIEWS} unique table views`,
    );
  }
  const maxRows = args.maxRows ?? DEFAULT_FIGHT_SET_ROWS;
  if (
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > MAX_FIGHT_SET_ROWS
  ) {
    throw new Error(`maxRows must be an integer from 1 to ${MAX_FIGHT_SET_ROWS}`);
  }

  const cached = await getCachedReport(args.reportCode);
  const fightsByID = new Map(cached.fights.map((fight) => [fight.id, fight]));
  const missingFightIDs = fightIDs.filter((fightID) => !fightsByID.has(fightID));
  if (missingFightIDs.length > 0) {
    throw new Error(
      `Fight IDs not found in report ${args.reportCode}: ${missingFightIDs.join(", ")}`,
    );
  }
  const fights = fightIDs.map((fightID) => fightsByID.get(fightID) as Fight);
  const data = await executeAndUnwrap<QueryResult>(buildFightSetQuery(views), {
    abilityID: args.abilityID ?? null,
    code: args.reportCode,
    fightIDs,
    sourceID: args.sourceID ?? null,
    targetID: args.targetID ?? null,
  });
  const report = data.reportData.report;
  if (!report) throw new Error(`WCL report not found: ${args.reportCode}`);

  return {
    report: { code: report.code, title: report.title },
    scope: {
      fightCount: fights.length,
      fightIDs,
      totalDurationMs: fights.reduce(
        (total, fight) => total + fight.endTime - fight.startTime,
        0,
      ),
      fights: fights.map(compactFight),
    },
    filters: {
      abilityID: args.abilityID ?? null,
      sourceID: args.sourceID ?? null,
      targetID: args.targetID ?? null,
    },
    sections: views.map((view) => ({
      view,
      dataType: VIEW_TO_DATA_TYPE[view],
      ...compactTable(
        normalizeFightSetTable(report[aliasForView(view)], fightsByID),
        {
          maxRows,
          sortByTotal: isScoreboardView(view),
        },
      ),
    })),
    payloadStability: "undocumented-json" as const,
    caveats: [
      "Each section is a WCL aggregate over the complete selected fight set, not one request per fight.",
      "Rows are compacted and capped by maxRows; check each section's truncated and totalRows fields.",
      "Observed casts, interrupts, dispels, damage, and deaths do not by themselves establish assignment, eligibility, cooldown readiness, or responsibility.",
    ],
  };
}

export function buildFightSetQuery(views: TableView[]): string {
  const selections = views
    .map(
      (view) => `
        ${aliasForView(view)}: table(
          fightIDs: $fightIDs
          dataType: ${VIEW_TO_DATA_TYPE[view]}
          sourceID: $sourceID
          targetID: $targetID
          abilityID: $abilityID
        )`,
    )
    .join("\n");
  return `
    query FightSetAnalysis(
      $code: String!
      $fightIDs: [Int!]!
      $sourceID: Int
      $targetID: Int
      $abilityID: Float
    ) {
      reportData {
        report(code: $code) {
          code
          title
          ${selections}
        }
      }
      rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }
    }
  `;
}

export function normalizeFightSetTable(
  value: unknown,
  fightsByID: Map<number, Fight>,
): unknown {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  const data = objectValue(parsed)?.data ?? parsed;
  const entries = objectValue(data)?.entries;
  if (!Array.isArray(entries)) return parsed;
  const onlyFight = fightsByID.size === 1 ? [...fightsByID.values()][0] : null;
  const normalizedEntries = entries.map((entry) => {
    const fightID = numericOrNull(objectValue(entry)?.fight);
    const fight = (fightID === null ? onlyFight : fightsByID.get(fightID)) ?? null;
    return fight
      ? addFightRelativeTimes(entry, fight.startTime, fight.endTime)
      : entry;
  });
  if (objectValue(parsed)?.data && objectValue(data)) {
    return {
      ...(parsed as Record<string, unknown>),
      data: { ...(data as Record<string, unknown>), entries: normalizedEntries },
    };
  }
  return objectValue(parsed)
    ? { ...(parsed as Record<string, unknown>), entries: normalizedEntries }
    : parsed;
}

function compactFight(fight: Fight) {
  return {
    bossPercentage: fight.bossPercentage,
    difficulty: fight.difficulty,
    durationMs: fight.endTime - fight.startTime,
    encounterID: fight.encounterID,
    fightPercentage: fight.fightPercentage,
    id: fight.id,
    kill: fight.kill,
    lastPhase: fight.lastPhase,
    lastPhaseAsAbsoluteIndex: fight.lastPhaseAsAbsoluteIndex,
    lastPhaseIsIntermission: fight.lastPhaseIsIntermission,
    name: fight.name,
    phaseTransitions: fight.phaseTransitions,
  };
}

function aliasForView(view: TableView): string {
  return `view_${view.replaceAll("-", "_")}`;
}

function isScoreboardView(view: TableView): boolean {
  return ["damage-done", "damage-taken", "healing", "resources"].includes(view);
}

function uniqueBoundedNumbers(
  values: number[],
  name: string,
  maxItems: number,
): number[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxItems) {
    throw new Error(`${name} must contain 1 to ${maxItems} numbers`);
  }
  const unique = [...new Set(values)];
  if (
    unique.some(
      (value) => !Number.isInteger(value) || !Number.isSafeInteger(value) || value < 1,
    )
  ) {
    throw new Error(`${name} must contain only positive integers`);
  }
  return unique;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
