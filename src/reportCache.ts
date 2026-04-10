/**
 * In-process cache of report metadata + fights list, keyed by report code.
 *
 * Two tools need to resolve a fightID into time bounds (wcl_get_table,
 * wcl_get_events), and one tool exposes the list directly (wcl_get_fights).
 * All three share this cache so repeated calls against the same report
 * don't each cost a `fights` query.
 *
 * The cache is unbounded and lives for the lifetime of the MCP server
 * process. For a single-session stdio server this is fine. If we ever
 * run this as a long-lived shared service we'll want LRU eviction.
 */

import { executeAndUnwrap } from "./client.js";

export interface Fight {
  id: number;
  encounterID: number;
  name: string;
  startTime: number;
  endTime: number;
  kill: boolean | null;
  size: number | null;
  difficulty: number | null;
  bossPercentage: number | null;
}

export interface ReportMeta {
  code: string;
  title: string;
  startTime: number;
  endTime: number;
}

export interface CachedReport {
  report: ReportMeta;
  fights: Fight[];
}

const cache = new Map<string, CachedReport>();
/** Deduplicate concurrent fetches for the same report code. */
const inflight = new Map<string, Promise<CachedReport>>();

const QUERY = /* GraphQL */ `
  query ($code: String!) {
    reportData {
      report(code: $code) {
        code
        title
        startTime
        endTime
        fights {
          id
          encounterID
          name
          startTime
          endTime
          kill
          size
          difficulty
          bossPercentage
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

interface QueryResult {
  reportData: {
    report: {
      code: string;
      title: string;
      startTime: number;
      endTime: number;
      fights: Fight[];
    } | null;
  };
}

export async function getCachedReport(reportCode: string): Promise<CachedReport> {
  const hit = cache.get(reportCode);
  if (hit) return hit;

  const pending = inflight.get(reportCode);
  if (pending) return pending;

  const promise = (async () => {
    const data = await executeAndUnwrap<QueryResult>(QUERY, { code: reportCode });
    const report = data.reportData.report;
    if (!report) {
      throw new Error(`WCL report not found: ${reportCode}`);
    }
    const entry: CachedReport = {
      report: {
        code: report.code,
        title: report.title,
        startTime: report.startTime,
        endTime: report.endTime,
      },
      fights: report.fights,
    };
    cache.set(reportCode, entry);
    return entry;
  })();

  inflight.set(reportCode, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(reportCode);
  }
}

/** Resolve a fightID to its relative-ms time bounds, fetching the report if needed. */
export async function resolveFightBounds(
  reportCode: string,
  fightID: number,
): Promise<{ startTime: number; endTime: number }> {
  const { fights } = await getCachedReport(reportCode);
  const fight = fights.find((f) => f.id === fightID);
  if (!fight) {
    throw new Error(
      `Fight ${fightID} not found in report ${reportCode}. ` +
        `Available fight IDs: ${fights.map((f) => f.id).join(", ") || "(none)"}`,
    );
  }
  return { startTime: fight.startTime, endTime: fight.endTime };
}

/** Test/debugging hook — drop a report from the cache, or clear all. */
export function invalidateReportCache(reportCode?: string): void {
  if (reportCode) cache.delete(reportCode);
  else cache.clear();
}
