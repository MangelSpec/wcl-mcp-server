/**
 * wcl_get_fights — list fights in a WCL report, with optional client-side filters.
 *
 * Under the hood this reads from the report cache (see reportCache.ts). The
 * first call for a given reportCode hits the API; subsequent calls (including
 * from wcl_get_table / wcl_get_events bounds resolution) are free.
 *
 * Filtering is done client-side on the returned array rather than via
 * GraphQL variables — the fights list is small, and this avoids depending
 * on WCL enum spellings we'd otherwise have to keep in sync.
 */

import { getCachedReport, type Fight, type ReportMeta } from "../reportCache.js";

export type KillTypeFilter = "Encounters" | "Kills" | "Wipes" | "Trash";

export interface GetFightsArgs {
  reportCode: string;
  encounterID?: number;
  killType?: KillTypeFilter;
}

export interface GetFightsResult {
  report: ReportMeta;
  fights: Fight[];
}

export async function getFights(args: GetFightsArgs): Promise<GetFightsResult> {
  const cached = await getCachedReport(args.reportCode);
  let fights = cached.fights;

  if (typeof args.encounterID === "number") {
    fights = fights.filter((f) => f.encounterID === args.encounterID);
  }

  if (args.killType) {
    switch (args.killType) {
      case "Encounters":
        // Any boss encounter (kills + wipes), excluding trash.
        fights = fights.filter((f) => f.encounterID !== 0);
        break;
      case "Kills":
        fights = fights.filter((f) => f.kill === true);
        break;
      case "Wipes":
        fights = fights.filter((f) => f.encounterID !== 0 && f.kill === false);
        break;
      case "Trash":
        fights = fights.filter((f) => f.encounterID === 0);
        break;
    }
  }

  return { report: cached.report, fights };
}
