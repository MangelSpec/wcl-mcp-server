/**
 * wcl_get_player_info — map actor IDs to player names/classes/specs for a report.
 *
 * This is the join key between WCL's actor-ID-based data (fights, tables,
 * events) and any external system (like a local combat log parser) that
 * identifies players by name or GUID. Call this once per report, keep the
 * mapping around.
 *
 * Spec resolution:
 *   `masterData.actors` gives us actor kind + class name but NOT spec.
 *   `report.playerDetails(startTime, endTime)` returns a JSON blob that
 *   *does* include spec info per player — but it's role-keyed
 *   (dps/healers/tanks) and gated on a time window. We query it across
 *   the report's full [startTime=0, endTime=report.endTime - report.startTime]
 *   window so players who only appeared in a single fight still show up.
 *
 *   The playerDetails blob is merged into masterData.actors by matching
 *   on gameID (the in-game GUID, stable across all roles). If a player
 *   only appears in masterData we keep them with `spec: null`; if the
 *   playerDetails shape ever changes we degrade gracefully.
 */

import { executeAndUnwrap } from "../client.js";

const QUERY = /* GraphQL */ `
  query ($code: String!) {
    reportData {
      report(code: $code) {
        startTime
        endTime
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
        playerDetails(startTime: 0, endTime: 9999999999)
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
  /** Class name for players (e.g. "Warlock", "Warrior"). */
  subType: string;
  /**
   * Spec name resolved from playerDetails (e.g. "Destruction", "Fury").
   * Null if the player wasn't present in the playerDetails blob or if
   * WCL's shape differed from what we expect.
   */
  spec: string | null;
  /** Role bucket from playerDetails: "dps", "healers", "tanks", or null. */
  role: "dps" | "healers" | "tanks" | null;
}

export interface GetPlayerInfoResult {
  logOwner: string | null;
  actors: PlayerActor[];
}

interface MasterDataActor {
  id: number;
  gameID: number | null;
  name: string;
  server: string | null;
  type: string;
  subType: string;
}

interface QueryResult {
  reportData: {
    report: {
      startTime: number;
      endTime: number;
      owner: { name: string } | null;
      masterData: { actors: MasterDataActor[] } | null;
      playerDetails: unknown;
    } | null;
  };
}

/**
 * Shape of a player entry inside playerDetails. WCL keys it under
 * playerDetails.playerDetails.{dps,healers,tanks}[] with fields:
 *   { name, id, guid, type (class), specs: [{spec, count}...], ... }
 * The `specs` array can have multiple entries if the player switched
 * spec mid-report; we take the most-used one (highest count) as the
 * canonical spec.
 */
interface PlayerDetailsEntry {
  name?: string;
  id?: number;
  guid?: number;
  type?: string;
  specs?: Array<{ spec?: string; count?: number }>;
}

type RoleBucket = "dps" | "healers" | "tanks";
const ROLE_BUCKETS: readonly RoleBucket[] = ["dps", "healers", "tanks"];

export async function getPlayerInfo(reportCode: string): Promise<GetPlayerInfoResult> {
  const data = await executeAndUnwrap<QueryResult>(QUERY, { code: reportCode });
  const report = data.reportData.report;
  if (!report) {
    throw new Error(`WCL report not found: ${reportCode}`);
  }

  const rawActors = report.masterData?.actors ?? [];
  const specMap = buildSpecMap(report.playerDetails);

  const actors: PlayerActor[] = rawActors.map((a) => {
    // Prefer gameID for matching (stable), fall back to actor id, fall back to name.
    const match =
      (a.gameID != null ? specMap.byGuid.get(a.gameID) : undefined) ??
      specMap.byId.get(a.id) ??
      specMap.byName.get(a.name);
    return {
      id: a.id,
      gameID: a.gameID,
      name: a.name,
      server: a.server,
      type: a.type,
      subType: a.subType,
      spec: match?.spec ?? null,
      role: match?.role ?? null,
    };
  });

  return {
    logOwner: report.owner?.name ?? null,
    actors,
  };
}

interface SpecMatch {
  spec: string;
  role: RoleBucket;
}

interface SpecMap {
  byGuid: Map<number, SpecMatch>;
  byId: Map<number, SpecMatch>;
  byName: Map<string, SpecMatch>;
}

function buildSpecMap(playerDetails: unknown): SpecMap {
  const empty: SpecMap = {
    byGuid: new Map(),
    byId: new Map(),
    byName: new Map(),
  };

  // WCL returns playerDetails as { data: { playerDetails: { dps, healers, tanks } } }
  // but the outer `data` wrapper is sometimes absent depending on the query path.
  // Defensively unwrap both shapes.
  if (!playerDetails || typeof playerDetails !== "object") return empty;
  const outer = playerDetails as Record<string, unknown>;
  let inner: Record<string, unknown> | undefined;

  if (outer.playerDetails && typeof outer.playerDetails === "object") {
    inner = outer.playerDetails as Record<string, unknown>;
  } else if (outer.data && typeof outer.data === "object") {
    const d = outer.data as Record<string, unknown>;
    if (d.playerDetails && typeof d.playerDetails === "object") {
      inner = d.playerDetails as Record<string, unknown>;
    }
  }
  if (!inner) return empty;

  for (const role of ROLE_BUCKETS) {
    const list = inner[role];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as PlayerDetailsEntry;
      const spec = pickCanonicalSpec(entry.specs);
      if (!spec) continue;
      const match: SpecMatch = { spec, role };
      if (typeof entry.guid === "number") empty.byGuid.set(entry.guid, match);
      if (typeof entry.id === "number") empty.byId.set(entry.id, match);
      if (typeof entry.name === "string") empty.byName.set(entry.name, match);
    }
  }
  return empty;
}

/** Pick the spec with the highest `count` (most time played). Falls back to the first. */
function pickCanonicalSpec(
  specs: PlayerDetailsEntry["specs"],
): string | null {
  if (!Array.isArray(specs) || specs.length === 0) return null;
  let best: { spec: string; count: number } | null = null;
  for (const s of specs) {
    if (!s || typeof s.spec !== "string") continue;
    const count = typeof s.count === "number" ? s.count : 0;
    if (!best || count > best.count) best = { spec: s.spec, count };
  }
  return best?.spec ?? null;
}
