import { executeAndUnwrap } from "../client.js";
import {
  addFightRelativeTimes,
  resolveFightRelativeWindow,
} from "../fightTime.js";
import { resolveFightBounds } from "../reportCache.js";

export const WINDOW_EVENT_TYPES = [
  "Buffs",
  "Casts",
  "DamageDone",
  "DamageTaken",
  "Deaths",
  "Debuffs",
  "Dispels",
  "Healing",
  "Interrupts",
  "Resources",
  "Summons",
] as const;

export type WindowEventType = (typeof WINDOW_EVENT_TYPES)[number];

export interface GetFightWindowContextArgs {
  abilityID?: number;
  dataTypes: WindowEventType[];
  endTime: number;
  fightID: number;
  focusAbilityName?: string;
  reportCode: string;
  sourceID?: number;
  startTime: number;
  targetID?: number;
}

const ALIAS_BY_TYPE: Record<WindowEventType, string> = {
  Buffs: "buffs",
  Casts: "casts",
  DamageDone: "damageDone",
  DamageTaken: "damageTaken",
  Deaths: "deaths",
  Debuffs: "debuffs",
  Dispels: "dispels",
  Healing: "healing",
  Interrupts: "interrupts",
  Resources: "resources",
  Summons: "summons",
};

interface Actor {
  gameID: number | null;
  id: number;
  name: string;
  server: string | null;
  subType: string;
  type: string;
}

interface Ability {
  gameID: number;
  icon: string | null;
  name: string;
  type: string | null;
}

interface EventPage {
  data: unknown;
  nextPageTimestamp: number | null;
}

interface QueryResult {
  reportData: {
    report:
      | ({
          code: string;
          title: string;
          masterData: {
            abilities: Ability[];
            actors: Actor[];
          } | null;
        } & Record<string, unknown>)
      | null;
  };
}

export async function getFightWindowContext(args: GetFightWindowContextArgs) {
  const dataTypes = [...new Set(args.dataTypes)];
  if (dataTypes.length < 1 || dataTypes.length > 6) {
    throw new Error("dataTypes must contain 1 to 6 unique event categories");
  }
  const bounds = await resolveFightBounds(args.reportCode, args.fightID);
  const window = resolveFightRelativeWindow(
    bounds.startTime,
    bounds.endTime,
    args.startTime,
    args.endTime,
  );
  if (window.endTime - window.startTime > 120_000) {
    throw new Error("Fight window cannot exceed 120000 ms");
  }

  const query = buildWindowQuery(dataTypes);
  const data = await executeAndUnwrap<QueryResult>(query, {
    abilityID: args.abilityID ?? null,
    code: args.reportCode,
    endTime: window.reportRelativeEndTime,
    sourceID: args.sourceID ?? null,
    startTime: window.reportRelativeStartTime,
    targetID: args.targetID ?? null,
  });
  const report = data.reportData.report;
  if (!report) throw new Error(`WCL report not found: ${args.reportCode}`);
  const actors = new Map(
    (report.masterData?.actors ?? []).map((actor) => [actor.id, actor]),
  );
  const abilities = new Map(
    (report.masterData?.abilities ?? []).map((ability) => [
      ability.gameID,
      ability,
    ]),
  );
  const channels = dataTypes.map((dataType) => {
    const page = report[ALIAS_BY_TYPE[dataType]] as EventPage | null;
    const rawEvents = parseEvents(page?.data);
    const enriched = rawEvents.map((event, index) =>
      compactEvent(event, {
        abilities,
        actors,
        channel: dataType,
        fightEnd: bounds.endTime,
        fightStart: bounds.startTime,
        index,
      }),
    );
    const focused = focusEvents(enriched, dataType, args.focusAbilityName);
    const selected = selectNearest(
      focused,
      25,
      (window.startTime + window.endTime) / 2,
    );
    return {
      dataType,
      fetchedEvents: rawEvents.length,
      returnedEvents: selected.length,
      upstreamTruncated: page?.nextPageTimestamp != null,
      ...(page?.nextPageTimestamp != null
        ? {
            nextStartTime: Math.max(
              0,
              page.nextPageTimestamp - bounds.startTime,
            ),
          }
        : {}),
      events: selected,
    };
  });
  const timeline = channels
    .flatMap((channel) => channel.events)
    .sort(
      (left, right) =>
        numeric(left.timestamp) - numeric(right.timestamp) ||
        numeric(left._channelOrder) - numeric(right._channelOrder) ||
        numeric(left._eventOrder) - numeric(right._eventOrder),
    )
    .map(({ _channelOrder: _channel, _eventOrder: _event, ...event }) => event);

  return {
    report: { code: report.code, title: report.title },
    fight: {
      id: args.fightID,
      durationMs: window.fightDuration,
      url: `https://www.warcraftlogs.com/reports/${report.code}#fight=${args.fightID}`,
    },
    window: {
      coordinate: "fight-relative-ms" as const,
      durationMs: window.endTime - window.startTime,
      endTime: window.endTime,
      startTime: window.startTime,
    },
    focusAbilityName: args.focusAbilityName ?? null,
    channels: channels.map(({ events: _events, ...channel }) => channel),
    timeline,
    payloadStability: "undocumented-json" as const,
    caveats: [
      "Each channel returns at most 25 events nearest the center of the requested window.",
      "A focusAbilityName filters Buffs and Debuffs by normalized name tokens after WCL ability metadata is joined.",
      "A continuation cursor means that channel has additional upstream events and should be narrowed before paging.",
    ],
  };
}

export function buildWindowQuery(dataTypes: WindowEventType[]): string {
  const selections = dataTypes
    .map(
      (dataType) => `
        ${ALIAS_BY_TYPE[dataType]}: events(
          startTime: $startTime
          endTime: $endTime
          dataType: ${dataType}
          sourceID: $sourceID
          targetID: $targetID
          abilityID: $abilityID
          limit: 10000
        ) {
          data
          nextPageTimestamp
        }`,
    )
    .join("\n");
  return `
    query FightWindow(
      $code: String!
      $startTime: Float!
      $endTime: Float!
      $sourceID: Int
      $targetID: Int
      $abilityID: Float
    ) {
      reportData {
        report(code: $code) {
          code
          title
          masterData(translate: true) {
            actors { id gameID name server type subType }
            abilities { gameID name type icon }
          }
          ${selections}
        }
      }
      rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }
    }
  `;
}

function parseEvents(value: unknown): Record<string, unknown>[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((event): event is Record<string, unknown> =>
        Boolean(event && typeof event === "object"),
      )
    : [];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return [];
  }
}

function compactEvent(
  event: Record<string, unknown>,
  options: {
    abilities: Map<number, Ability>;
    actors: Map<number, Actor>;
    channel: WindowEventType;
    fightEnd: number;
    fightStart: number;
    index: number;
  },
) {
  const normalized = addFightRelativeTimes(
    event,
    options.fightStart,
    options.fightEnd,
  ) as Record<string, unknown>;
  const output: Record<string, unknown> = {
    channel: options.channel,
    _channelOrder: WINDOW_EVENT_TYPES.indexOf(options.channel),
    _eventOrder: options.index,
  };
  for (const key of [
    "timestamp",
    "fightRelativeTimestamp",
    "reportRelativeTimestamp",
    "type",
    "sourceID",
    "sourceInstance",
    "targetID",
    "targetInstance",
    "abilityGameID",
    "extraAbilityGameID",
    "amount",
    "unmitigatedAmount",
    "absorbed",
    "overkill",
    "hitType",
    "stack",
    "resourceChange",
    "waste",
  ]) {
    if (normalized[key] !== undefined) output[key] = normalized[key];
  }
  const sourceID = numericOrNull(normalized.sourceID);
  const targetID = numericOrNull(normalized.targetID);
  const abilityID = numericOrNull(normalized.abilityGameID);
  const extraAbilityID = numericOrNull(normalized.extraAbilityGameID);
  if (sourceID !== null)
    output.source = compactActor(options.actors.get(sourceID));
  if (targetID !== null)
    output.target = compactActor(options.actors.get(targetID));
  if (abilityID !== null)
    output.ability = compactAbility(
      options.abilities.get(abilityID),
      abilityID,
    );
  if (extraAbilityID !== null) {
    output.extraAbility = compactAbility(
      options.abilities.get(extraAbilityID),
      extraAbilityID,
    );
  }
  return output;
}

function compactActor(actor: Actor | undefined) {
  return actor
    ? {
        id: actor.id,
        name: actor.name,
        type: actor.type,
        subType: actor.subType,
      }
    : null;
}

function compactAbility(ability: Ability | undefined, gameID: number) {
  return ability
    ? { gameID, name: ability.name, type: ability.type, icon: ability.icon }
    : { gameID, name: null };
}

function focusEvents(
  events: Record<string, unknown>[],
  channel: WindowEventType,
  focus: string | undefined,
) {
  if (!focus || (channel !== "Buffs" && channel !== "Debuffs")) return events;
  const tokens = normalize(focus)
    .split(" ")
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) return events;
  const scored = events.map((event) => {
    const ability = event.ability;
    const name =
      ability && typeof ability === "object" && "name" in ability
        ? normalize(String(ability.name ?? ""))
        : "";
    const words = new Set(name.split(" "));
    return { event, score: tokens.filter((token) => words.has(token)).length };
  });
  const maxScore = Math.max(0, ...scored.map((entry) => entry.score));
  return maxScore === 0
    ? []
    : scored
        .filter((entry) => entry.score === maxScore)
        .map((entry) => entry.event);
}

function selectNearest(
  events: Record<string, unknown>[],
  limit: number,
  center: number,
) {
  if (events.length <= limit) return events;
  return [...events]
    .sort(
      (left, right) =>
        Math.abs(numeric(left.timestamp) - center) -
        Math.abs(numeric(right.timestamp) - center),
    )
    .slice(0, limit);
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
