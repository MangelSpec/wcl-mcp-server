/**
 * wcl_get_player_info — map actor IDs to player names/classes/specs for a report.
 *
 * This is the join key between WCL's actor-ID-based data (fights, tables,
 * events) and any external system (like a local combat log parser) that
 * identifies players by name or GUID. Call this once per report, keep the
 * mapping around.
 */

import { executeAndUnwrap } from "../client.js";

const QUERY = /* GraphQL */ `
  query ($code: String!) {
    reportData {
      report(code: $code) {
        owner {
          name
        }
        masterData(translate: true) {
          actors(type: "Player") {
            id
            gameID
            name
            server
            type
            subType
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

export interface PlayerActor {
  /** Internal WCL actor ID within this report. */
  id: number;
  /** In-game GUID (stable across reports). */
  gameID: number | null;
  name: string;
  server: string | null;
  /** Actor kind — for this query always "Player". */
  type: string;
  /**
   * Class name for players (e.g. "Warlock", "Warrior"). NOT the spec —
   * masterData.actors does not expose spec information. For specs, a
   * separate tool using `report.playerDetails` or CombatantInfo events
   * would be needed.
   */
  subType: string;
}

export interface GetPlayerInfoResult {
  logOwner: string | null;
  actors: PlayerActor[];
}

interface QueryResult {
  reportData: {
    report: {
      owner: { name: string } | null;
      masterData: {
        actors: PlayerActor[];
      } | null;
    } | null;
  };
}

export async function getPlayerInfo(reportCode: string): Promise<GetPlayerInfoResult> {
  const data = await executeAndUnwrap<QueryResult>(QUERY, { code: reportCode });
  const report = data.reportData.report;
  if (!report) {
    throw new Error(`WCL report not found: ${reportCode}`);
  }
  return {
    logOwner: report.owner?.name ?? null,
    actors: report.masterData?.actors ?? [],
  };
}
