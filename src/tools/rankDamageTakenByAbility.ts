import { executeAndUnwrap } from "../client.js";
import { getCachedReport, type Fight } from "../reportCache.js";
import { getEvents } from "./getEvents.js";
import { getFightContext } from "./getFightContext.js";

export const MAX_ABILITY_FIGHT_SET_SIZE = 20;
export const MAX_ABILITY_EVENT_QUERIES = 50;
export const ABILITY_EVENT_CONCURRENCY = 4;
export const ABILITY_RANKING_TIMEOUT_MS = 90_000;

export interface RankDamageTakenByAbilityArgs {
  abilityNames: string[];
  fightID?: number;
  fightIDs?: number[];
  includeNonPlayers?: boolean;
  refresh?: boolean;
  reportCode: string;
  /** Internal composite deadline override used by focused tests. */
  deadlineMs?: number;
  /** Internal caller cancellation; not exposed by the MCP tool schema. */
  signal?: AbortSignal;
}

interface Actor {
  id: number;
  name: string;
  subType: string;
  type: string;
}

interface Ability {
  gameID: number;
  name: string;
}

interface MasterDataResult {
  reportData: {
    report: {
      code: string;
      masterData: { abilities: Ability[]; actors: Actor[] } | null;
      title: string;
    } | null;
  };
}

interface AbilityEventSet {
  ability: Ability;
  events: unknown[];
  truncated: boolean;
}

interface AbilityTotal {
  absorbed: number;
  effectiveDamage: number;
  gameID: number;
  hits: number;
  mitigated: number;
  name: string;
  rawDamage: number;
  timestamps: number[];
  unmitigatedDamage: number;
}

const MASTER_DATA_QUERY = /* GraphQL */ `
  query AbilityDamageMasterData($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        masterData(translate: true) {
          actors {
            id
            name
            type
            subType
          }
          abilities {
            gameID
            name
          }
        }
      }
    }
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

export async function rankDamageTakenByAbility(
  args: RankDamageTakenByAbilityArgs,
) {
  const fightIDs = selectedFightIDs(args);
  const abilityNames = [
    ...new Set(args.abilityNames.map((name) => name.trim())),
  ]
    .filter(Boolean)
    .slice(0, 10);
  if (abilityNames.length === 0) {
    throw new Error("abilityNames must contain at least one non-empty name");
  }

  const deadlineMs = args.deadlineMs ?? ABILITY_RANKING_TIMEOUT_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("deadlineMs must be a positive safe integer");
  }
  const deadlineController = new AbortController();
  const deadlineHandle = setTimeout(
    () => deadlineController.abort(),
    deadlineMs,
  );
  const signal = args.signal
    ? AbortSignal.any([args.signal, deadlineController.signal])
    : deadlineController.signal;

  try {
    signal.throwIfAborted();
    const contextPromise =
      fightIDs.length === 1
        ? getFightContext({
            fightID: fightIDs[0] as number,
            includeCombatantInfo: false,
            reportCode: args.reportCode,
            ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
            signal,
          })
        : null;
    const [cached, context, masterDataResult] = await Promise.all([
      getCachedReport(
        args.reportCode,
        args.refresh === undefined ? {} : { refresh: args.refresh },
      ),
      contextPromise,
      executeAndUnwrap<MasterDataResult>(
        MASTER_DATA_QUERY,
        { code: args.reportCode },
        { signal },
      ),
    ]);
    signal.throwIfAborted();
    const selectedFights = validatedFights(
      cached.fights,
      fightIDs,
      args.reportCode,
    );
    const report = masterDataResult.reportData.report;
    if (!report) throw new Error(`WCL report not found: ${args.reportCode}`);
    const masterData = report.masterData;
    const matchedAbilities = matchAbilities(
      masterData?.abilities ?? [],
      abilityNames,
    );
    if (matchedAbilities.length > 10) {
      throw new Error(
        `Ability names matched ${matchedAbilities.length} abilities; use more specific names (maximum 10).`,
      );
    }
    const queryCount = fightIDs.length * matchedAbilities.length;
    if (queryCount > MAX_ABILITY_EVENT_QUERIES) {
      throw new Error(
        `The selected fights and matched abilities require ${queryCount} event queries; narrow the request to at most ${MAX_ABILITY_EVENT_QUERIES}.`,
      );
    }

    const jobs = fightIDs.flatMap((fightID) =>
      matchedAbilities.map((ability) => ({ ability, fightID })),
    );
    const eventSets = await mapWithConcurrency(
      jobs,
      ABILITY_EVENT_CONCURRENCY,
      async ({ ability, fightID }) => {
        const result = await getEvents({
          abilityID: ability.gameID,
          dataType: "DamageTaken",
          fightID,
          maxPages: 3,
          reportCode: args.reportCode,
          ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
          signal,
        });
        return {
          ability,
          events: result.events,
          truncated: result.truncated,
        };
      },
      signal,
    );
    const actors = new Map(
      (masterData?.actors ?? []).map((actor) => [actor.id, actor]),
    );
    const rosterIDs = context
      ? new Set(context.players.map((player) => player.actorID))
      : null;
    const aggregatedPlayers = aggregateAbilityDamageEvents(eventSets, {
      actorName: (actorID) => actors.get(actorID)?.name ?? `Actor ${actorID}`,
      actorType: (actorID) => actors.get(actorID)?.subType ?? null,
      includeActor: (actorID) => {
        if (args.includeNonPlayers === true) return true;
        return (
          rosterIDs?.has(actorID) ?? actors.get(actorID)?.type === "Player"
        );
      },
    });
    const evidenceCompleteness = eventSets.some((set) => set.truncated)
      ? "truncated"
      : "complete";
    const totalHits = aggregatedPlayers.reduce(
      (sum, player) => sum + player.hits,
      0,
    );
    const players = addHitShares(
      aggregatedPlayers,
      evidenceCompleteness === "complete" ? totalHits : null,
    );
    const abilityRankings = buildAbilityRankings(
      players,
      matchedAbilities,
      evidenceCompleteness,
    );

    return {
      report: { code: report.code, title: report.title },
      ...(context ? { fight: context.fight } : {}),
      scope: {
        fightCount: selectedFights.length,
        fightIDs,
        fights: selectedFights.map(compactFight),
      },
      match: {
        requestedNames: abilityNames,
        matchedAbilities,
        normalization: "case-insensitive words; plural trailing s ignored",
      },
      players,
      abilityRankings,
      matchedPlayers: players.length,
      totalHits: evidenceCompleteness === "complete" ? totalHits : null,
      percentageDenominator:
        evidenceCompleteness === "complete"
          ? "all matching damage events across the selected fights"
          : null,
      metricDefinitions: {
        hits: "number of matching WCL damage events, including fully absorbed hits",
        hitSharePercent:
          "player hits divided by all matching player hits across the selected fights",
        rawDamage: "event amount plus absorbed damage",
        effectiveDamage: "event amount minus overkill",
        unmitigatedDamage: "WCL unmitigatedAmount before mitigation",
      },
      evidenceCompleteness,
      caveats: [
        "Results are derived from ability-filtered WCL damage events, not summary-table rankings.",
        "By default only player actors hit during the selected fights are returned; set includeNonPlayers true to include pets or NPCs.",
        ...(evidenceCompleteness === "complete"
          ? []
          : [
              "At least one event stream hit its pagination cap, so hit-share percentages and their denominator are withheld.",
            ]),
        "Hit count describes logged damage events and does not determine whether a soak was assigned or correct.",
      ],
    };
  } catch (error) {
    if (deadlineController.signal.aborted && !args.signal?.aborted) {
      throw new Error(
        `Ability damage ranking exceeded its ${deadlineMs}ms deadline`,
      );
    }
    throw error;
  } finally {
    clearTimeout(deadlineHandle);
  }
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive safe integer");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        signal?.throwIfAborted();
        const index = nextIndex++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function matchAbilities(
  abilities: Ability[],
  requestedNames: string[],
): Ability[] {
  const queries = requestedNames.map(normalizedWords).filter(Boolean);
  return [
    ...new Map(
      abilities
        .filter((ability) =>
          queries.some((query) => abilityMatches(ability.name, query)),
        )
        .map((ability) => [ability.gameID, ability]),
    ).values(),
  ];
}

export function aggregateAbilityDamageEvents(
  eventSets: AbilityEventSet[],
  options: {
    actorName: (actorID: number) => string;
    actorType: (actorID: number) => string | null;
    includeActor?: (actorID: number) => boolean;
  },
) {
  const actors = new Map<
    number,
    {
      abilities: Map<number, AbilityTotal>;
      actorID: number;
      name: string;
      type: string | null;
    }
  >();
  for (const eventSet of eventSets) {
    for (const value of eventSet.events) {
      const event = objectValue(value);
      const actorID = numericOrNull(event?.targetID);
      if (
        !event ||
        actorID === null ||
        options.includeActor?.(actorID) === false
      ) {
        continue;
      }
      const actor = actors.get(actorID) ?? {
        abilities: new Map<number, AbilityTotal>(),
        actorID,
        name: options.actorName(actorID),
        type: options.actorType(actorID),
      };
      const ability = actor.abilities.get(eventSet.ability.gameID) ?? {
        absorbed: 0,
        effectiveDamage: 0,
        gameID: eventSet.ability.gameID,
        hits: 0,
        mitigated: 0,
        name: eventSet.ability.name,
        rawDamage: 0,
        timestamps: [],
        unmitigatedDamage: 0,
      };
      const amount = numeric(event.amount);
      const absorbed = numeric(event.absorbed);
      const overkill = numeric(event.overkill);
      ability.hits++;
      ability.rawDamage += amount + absorbed;
      ability.effectiveDamage += Math.max(0, amount - overkill);
      ability.absorbed += absorbed;
      ability.mitigated += numeric(event.mitigated);
      ability.unmitigatedDamage += numeric(event.unmitigatedAmount);
      const timestamp = numericOrNull(
        event.fightRelativeTimestamp ?? event.timestamp,
      );
      if (timestamp !== null) ability.timestamps.push(timestamp);
      actor.abilities.set(eventSet.ability.gameID, ability);
      actors.set(actorID, actor);
    }
  }

  return [...actors.values()]
    .map((actor) => {
      const abilities = [...actor.abilities.values()].sort(
        (left, right) => right.rawDamage - left.rawDamage,
      );
      return {
        actorID: actor.actorID,
        name: actor.name,
        type: actor.type,
        hits: abilities.reduce((sum, ability) => sum + ability.hits, 0),
        rawDamage: abilities.reduce(
          (sum, ability) => sum + ability.rawDamage,
          0,
        ),
        effectiveDamage: abilities.reduce(
          (sum, ability) => sum + ability.effectiveDamage,
          0,
        ),
        absorbed: abilities.reduce((sum, ability) => sum + ability.absorbed, 0),
        mitigated: abilities.reduce(
          (sum, ability) => sum + ability.mitigated,
          0,
        ),
        unmitigatedDamage: abilities.reduce(
          (sum, ability) => sum + ability.unmitigatedDamage,
          0,
        ),
        abilities,
      };
    })
    .sort(
      (left, right) =>
        right.hits - left.hits || right.rawDamage - left.rawDamage,
    );
}

export function buildAbilityRankings(
  players: ReturnType<typeof aggregateAbilityDamageEvents>,
  abilities: Ability[],
  evidenceCompleteness: "complete" | "truncated" = "complete",
) {
  return abilities.map((ability) => {
    const totalAbilityHits = rowsHitTotal(players, ability.gameID);
    const rows = players.flatMap((player) => {
      const total = player.abilities.find(
        (candidate) => candidate.gameID === ability.gameID,
      );
      return total
        ? [
            {
              actorID: player.actorID,
              name: player.name,
              type: player.type,
              hits: total.hits,
              hitSharePercent:
                evidenceCompleteness === "complete"
                  ? percentage(total.hits, totalAbilityHits)
                  : null,
              rawDamage: total.rawDamage,
              effectiveDamage: total.effectiveDamage,
              absorbed: total.absorbed,
              mitigated: total.mitigated,
              unmitigatedDamage: total.unmitigatedDamage,
            },
          ]
        : [];
    });
    const rankings = [...rows]
      .sort(
        (left, right) =>
          right.hits - left.hits || right.rawDamage - left.rawDamage,
      )
      .map((row, index) => ({ rank: index + 1, ...row }));
    const leader = (
      metric: "effectiveDamage" | "hits" | "rawDamage" | "unmitigatedDamage",
    ) =>
      [...rows].sort(
        (left, right) =>
          right[metric] - left[metric] ||
          right.hits - left.hits ||
          right.rawDamage - left.rawDamage,
      )[0] ?? null;
    return {
      ability,
      leaders: {
        highestEffectiveDamage: leader("effectiveDamage"),
        highestRawDamage: leader("rawDamage"),
        highestUnmitigatedDamage: leader("unmitigatedDamage"),
        mostHits: leader("hits"),
      },
      rankings,
    };
  });
}

function addHitShares<T extends { hits: number }>(
  players: T[],
  totalHits: number | null,
): Array<T & { hitSharePercent: number | null }> {
  return players.map((player) => ({
    ...player,
    hitSharePercent:
      totalHits === null ? null : percentage(player.hits, totalHits),
  }));
}

function rowsHitTotal(
  players: ReturnType<typeof aggregateAbilityDamageEvents>,
  abilityID: number,
): number {
  return players.reduce(
    (sum, player) =>
      sum +
      (player.abilities.find((ability) => ability.gameID === abilityID)?.hits ??
        0),
    0,
  );
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 100;
}

function selectedFightIDs(args: RankDamageTakenByAbilityArgs): number[] {
  if (args.fightID !== undefined && args.fightIDs !== undefined) {
    throw new Error('Provide exactly one of "fightID" or "fightIDs"');
  }
  const values =
    args.fightIDs ?? (args.fightID === undefined ? [] : [args.fightID]);
  if (values.length < 1 || values.length > MAX_ABILITY_FIGHT_SET_SIZE) {
    throw new Error(
      `fightIDs must contain 1 to ${MAX_ABILITY_FIGHT_SET_SIZE} fights`,
    );
  }
  const unique = [...new Set(values)];
  if (
    unique.some(
      (fightID) =>
        !Number.isSafeInteger(fightID) ||
        !Number.isInteger(fightID) ||
        fightID < 1,
    )
  ) {
    throw new Error("fight IDs must be positive safe integers");
  }
  return unique;
}

function validatedFights(
  fights: Fight[],
  fightIDs: number[],
  reportCode: string,
): Fight[] {
  const fightsByID = new Map(fights.map((fight) => [fight.id, fight]));
  const missing = fightIDs.filter((fightID) => !fightsByID.has(fightID));
  if (missing.length > 0) {
    throw new Error(
      `Fight IDs not found in report ${reportCode}: ${missing.join(", ")}`,
    );
  }
  return fightIDs.map((fightID) => fightsByID.get(fightID) as Fight);
}

function compactFight(fight: Fight) {
  return {
    difficulty: fight.difficulty,
    durationMs: fight.endTime - fight.startTime,
    encounterID: fight.encounterID,
    id: fight.id,
    kill: fight.kill,
    name: fight.name,
  };
}

function abilityMatches(name: string, query: string): boolean {
  const words = normalizedWords(name).split(" ");
  return query.split(" ").every((word) => words.includes(word));
}

function normalizedWords(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
    )
    .join(" ");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number {
  return numericOrNull(value) ?? 0;
}

function numericOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
