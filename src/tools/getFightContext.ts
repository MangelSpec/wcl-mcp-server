import { executeAndUnwrap } from "../client.js";
import { loadEvidence } from "../evidenceCache.js";

export interface GetFightContextArgs {
  fightID: number;
  includeCombatantInfo?: boolean;
  refresh?: boolean;
  reportCode: string;
}

const QUERY = /* GraphQL */ `
  query FightContext(
    $code: String!
    $fightIDs: [Int!]!
    $includeCombatantInfo: Boolean!
  ) {
    reportData {
      report(code: $code) {
        code
        title
        fights(fightIDs: $fightIDs) {
          id
          encounterID
          name
          difficulty
          kill
          size
          startTime
          endTime
          averageItemLevel
          friendlyPlayers
          friendlySpecs
          friendlyItemLevels
        }
        masterData {
          actors(type: "Player") {
            id
            gameID
            name
            server
            type
            subType
          }
        }
        playerDetails(
          fightIDs: $fightIDs
          includeCombatantInfo: $includeCombatantInfo
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

interface FightData {
  averageItemLevel: number | null;
  difficulty: number | null;
  encounterID: number;
  endTime: number;
  friendlyItemLevels: Array<number | null> | null;
  friendlyPlayers: number[] | null;
  friendlySpecs: Array<string | null> | null;
  id: number;
  kill: boolean | null;
  name: string;
  size: number | null;
  startTime: number;
}

interface ActorData {
  gameID: number | null;
  id: number;
  name: string;
  server: string | null;
  subType: string;
  type: string;
}

interface QueryResult {
  reportData: {
    report: {
      code: string;
      fights: FightData[];
      masterData: { actors: ActorData[] } | null;
      playerDetails: unknown;
      title: string;
    } | null;
  };
}

export async function getFightContext(args: GetFightContextArgs) {
  const includeCombatantInfo = args.includeCombatantInfo ?? false;
  return loadEvidence({
    key: {
      fightID: args.fightID,
      includeCombatantInfo,
      operation: "context",
      reportCode: args.reportCode,
    },
    operation: "context",
    refresh: args.refresh,
    loader: async (signal, observeUpstream) => {
      const data = await executeAndUnwrap<QueryResult>(
        QUERY,
        {
          code: args.reportCode,
          fightIDs: [args.fightID],
          includeCombatantInfo,
        },
        { onResponse: observeUpstream, signal },
      );
      const report = data.reportData.report;
      if (!report) throw new Error(`WCL report not found: ${args.reportCode}`);
      const fight = report.fights[0];
      if (!fight)
        throw new Error(
          `Fight ${args.fightID} not found in report ${args.reportCode}`,
        );
      const actors = new Map(
        (report.masterData?.actors ?? []).map((actor) => [actor.id, actor]),
      );
      const combatants = extractCombatants(report.playerDetails);
      const players = (fight.friendlyPlayers ?? []).map((actorID, index) => {
        const actor = actors.get(actorID);
        const combatant = combatants.get(actorID);
        return {
          actorID,
          className: actor?.subType ?? null,
          gameID: actor?.gameID ?? null,
          itemLevel: fight.friendlyItemLevels?.[index] ?? null,
          name: actor?.name ?? null,
          server: actor?.server ?? null,
          specName: fight.friendlySpecs?.[index] ?? null,
          ...(includeCombatantInfo
            ? {
                combatantInfo: combatant
                  ? {
                      healthstoneUse: finiteNumber(combatant.healthstoneUse),
                      potionUse: finiteNumber(combatant.potionUse),
                      talentNodeIDs: extractTalentNodeIDs(
                        combatant.combatantInfo,
                      ),
                    }
                  : null,
              }
            : {}),
        };
      });

      return {
        report: { code: report.code, title: report.title },
        fight: {
          ...fight,
          durationMs: fight.endTime - fight.startTime,
          url: `https://www.warcraftlogs.com/reports/${report.code}#fight=${fight.id}`,
        },
        players,
        composition: summarizeComposition(players),
        combatantInfoIncluded: includeCombatantInfo,
      };
    },
  });
}

function extractCombatants(
  value: unknown,
): Map<number, Record<string, unknown>> {
  if (!value || typeof value !== "object") return new Map();
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return new Map();
  const playerDetails = (data as Record<string, unknown>).playerDetails;
  if (!playerDetails || typeof playerDetails !== "object") return new Map();

  const combatants = new Map<number, Record<string, unknown>>();
  for (const bucket of Object.values(playerDetails)) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id === "number") combatants.set(record.id, record);
    }
  }
  return combatants;
}

function extractTalentNodeIDs(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const talentTree = (value as Record<string, unknown>).talentTree;
  if (!Array.isArray(talentTree)) return [];
  return [
    ...new Set(
      talentTree
        .map((entry) =>
          entry && typeof entry === "object"
            ? finiteNumber((entry as Record<string, unknown>).nodeID)
            : null,
        )
        .filter((nodeID): nodeID is number => nodeID !== null),
    ),
  ];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeComposition(
  players: Array<{ className: string | null; specName: string | null }>,
) {
  const classes: Record<string, number> = {};
  const specs: Record<string, number> = {};
  for (const player of players) {
    if (player.className)
      classes[player.className] = (classes[player.className] ?? 0) + 1;
    if (player.specName)
      specs[player.specName] = (specs[player.specName] ?? 0) + 1;
  }
  return { classes, specs, playerCount: players.length };
}
