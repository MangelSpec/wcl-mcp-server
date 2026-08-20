import { getFightContext } from "./getFightContext.js";
import { getTable, type TableView } from "./getTable.js";

export interface GetFightOverviewArgs {
  fightID: number;
  refresh?: boolean;
  reportCode: string;
  topActors?: number;
}

const OVERVIEW_VIEWS = [
  "damage-done",
  "healing",
  "damage-taken",
  "deaths",
  "interrupts",
  "dispels",
] as const satisfies readonly TableView[];

export async function getFightOverview(args: GetFightOverviewArgs) {
  const topActors = Math.min(Math.max(args.topActors ?? 10, 1), 20);
  const [context, tables] = await Promise.all([
    getFightContext({
      fightID: args.fightID,
      includeCombatantInfo: false,
      reportCode: args.reportCode,
      ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
    }),
    Promise.all(
      OVERVIEW_VIEWS.map((view) =>
        getTable({
          fightID: args.fightID,
          reportCode: args.reportCode,
          view,
          ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
        }),
      ),
    ),
  ]);

  return {
    report: context.report,
    fight: context.fight,
    players: context.players,
    composition: context.composition,
    sections: Object.fromEntries(
      OVERVIEW_VIEWS.map((view, index) => [
        camelCase(view),
        compactTable(tables[index]?.table, {
          maxRows:
            view === "deaths" || view === "interrupts" || view === "dispels"
              ? 40
              : topActors,
          sortByTotal:
            view === "damage-done" ||
            view === "healing" ||
            view === "damage-taken",
        }),
      ]),
    ),
    payloadStability: "undocumented-json" as const,
    caveats: [
      "Scoreboards contain aggregate totals for the top rows; use generic table tools only when ability-level breakdowns are required.",
      "Use wcl_get_fight_window_context for casts, aura state, and event timing around a mechanic.",
    ],
  };
}

export function compactTable(
  value: unknown,
  options: { maxRows: number; sortByTotal: boolean },
) {
  const parsed = parseJson(value);
  const data = objectValue(parsed)?.data ?? parsed;
  const entries = objectValue(data)?.entries;
  const rows = Array.isArray(entries)
    ? entries.filter((entry) => entry && typeof entry === "object")
    : [];
  const ordered = options.sortByTotal
    ? [...rows].sort(
        (left, right) => numeric(right, "total") - numeric(left, "total"),
      )
    : rows;
  return {
    rows: ordered
      .slice(0, options.maxRows)
      .map((row) =>
        options.sortByTotal
          ? compactScoreboardRow(row as Record<string, unknown>)
          : compactMechanicRow(row as Record<string, unknown>),
      ),
    totalRows: rows.length,
    truncated: rows.length > options.maxRows,
  };
}

function compactScoreboardRow(row: Record<string, unknown>) {
  return copyFields(row, [
    "name",
    "id",
    "guid",
    "type",
    "icon",
    "itemLevel",
    "total",
    "totalReduced",
    "activeTime",
    "activeTimeReduced",
    "overheal",
    "totalRDPSTaken",
    "totalRDPSGiven",
  ]);
}

function compactMechanicRow(row: Record<string, unknown>) {
  if ("killingBlow" in row || "deathWindow" in row) {
    return copyFields(row, [
      "name",
      "id",
      "guid",
      "type",
      "icon",
      "timestamp",
      "deathTime",
      "fightRelativeTimestamp",
      "fightRelativeDeathTime",
      "reportRelativeTimestamp",
      "reportRelativeDeathTime",
      "fight",
      "overkill",
      "killingBlow",
    ]);
  }
  return compactValue(row, 0);
}

function copyFields(row: Record<string, unknown>, keys: string[]) {
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    if (row[key] === undefined) continue;
    output[key] = compactValue(row[key], 1);
  }
  return output;
}

function compactValue(value: unknown, depth: number): unknown {
  if (depth >= 5) return "[nested data omitted]";
  if (Array.isArray(value)) {
    return value
      .slice(0, depth <= 1 ? 20 : 8)
      .map((entry) => compactValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 500
      ? `${value.slice(0, 500)}…`
      : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 48)) {
    if (["gear", "talents", "bands", "series"].includes(key)) continue;
    if (key === "abilities" || key === "damageAbilities") {
      output[key] = Array.isArray(child)
        ? child.slice(0, 5).map((entry) => compactValue(entry, depth + 1))
        : [];
      continue;
    }
    output[key] = compactValue(child, depth + 1);
  }
  return output;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
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

function numeric(value: unknown, key: string): number {
  const field = objectValue(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}
