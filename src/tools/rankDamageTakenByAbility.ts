import { executeAndUnwrap } from "../client.js";
import { getEvents } from "./getEvents.js";
import { getFightContext } from "./getFightContext.js";

export interface RankDamageTakenByAbilityArgs {
  abilityNames: string[];
  fightID: number;
  includeNonPlayers?: boolean;
  refresh?: boolean;
  reportCode: string;
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
      masterData: { abilities: Ability[]; actors: Actor[] } | null;
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
  const abilityNames = [
    ...new Set(args.abilityNames.map((name) => name.trim())),
  ]
    .filter(Boolean)
    .slice(0, 10);
  if (abilityNames.length === 0) {
    throw new Error("abilityNames must contain at least one non-empty name");
  }

  const [context, masterDataResult] = await Promise.all([
    getFightContext({
      fightID: args.fightID,
      includeCombatantInfo: false,
      reportCode: args.reportCode,
      ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
    }),
    executeAndUnwrap<MasterDataResult>(MASTER_DATA_QUERY, {
      code: args.reportCode,
    }),
  ]);
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

  const eventSets: AbilityEventSet[] = await Promise.all(
    matchedAbilities.map(async (ability) => {
      const result = await getEvents({
        abilityID: ability.gameID,
        dataType: "DamageTaken",
        fightID: args.fightID,
        maxPages: 3,
        reportCode: args.reportCode,
        ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
      });
      return {
        ability,
        events: result.events,
        truncated: result.truncated,
      };
    }),
  );
  const rosterIDs = new Set(context.players.map((player) => player.actorID));
  const actors = new Map(
    (masterData?.actors ?? []).map((actor) => [actor.id, actor]),
  );
  const players = aggregateAbilityDamageEvents(eventSets, {
    actorName: (actorID) => actors.get(actorID)?.name ?? `Actor ${actorID}`,
    actorType: (actorID) => actors.get(actorID)?.subType ?? null,
    includeActor: (actorID) =>
      args.includeNonPlayers === true || rosterIDs.has(actorID),
  });
  const abilityRankings = buildAbilityRankings(players, matchedAbilities);

  return {
    report: context.report,
    fight: context.fight,
    match: {
      requestedNames: abilityNames,
      matchedAbilities,
      normalization: "case-insensitive words; plural trailing s ignored",
    },
    players,
    abilityRankings,
    matchedPlayers: players.length,
    metricDefinitions: {
      hits: "number of matching WCL damage events, including fully absorbed hits",
      rawDamage: "event amount plus absorbed damage",
      effectiveDamage: "event amount minus overkill",
      unmitigatedDamage: "WCL unmitigatedAmount before mitigation",
    },
    evidenceCompleteness: eventSets.some((set) => set.truncated)
      ? "truncated"
      : "complete",
    caveats: [
      "Results are derived from ability-filtered WCL damage events, not summary-table rankings.",
      "By default only actors in the exact fight roster are returned; set includeNonPlayers true to include pets or NPCs.",
      "Hit count describes logged damage events and does not determine whether a soak was assigned or correct.",
    ],
  };
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
) {
  return abilities.map((ability) => {
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
