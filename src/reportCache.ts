/**
 * In-process cache of report metadata + fights list, keyed by report code.
 *
 * Two tools need to resolve a fightID into time bounds (wcl_get_table,
 * wcl_get_events), and one tool exposes the list directly (wcl_get_fights).
 * All three share this cache so repeated calls against the same report
 * don't each cost a `fights` query.
 *
 * Entries expire after CACHE_TTL_MS (default 60s). This is a deliberate
 * compromise for live raid nights: reports are mutable while being logged
 * (new pulls get appended), so an indefinitely-cached fights list would
 * cause resolveFightBounds to reject freshly-uploaded fight IDs with a
 * misleading "not found" error. A short TTL keeps the savings for busy
 * query bursts while letting new fights surface on the next minute.
 *
 * The cache is unbounded in size; for a single-session stdio server that
 * only ever looks at a handful of reports, this is fine.
 */

import { executeAndUnwrap } from "./client.js";

const CACHE_TTL_MS = 60_000;

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

interface CacheEntry {
  value: CachedReport;
  /** epoch ms at which this entry becomes stale */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
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
  const now = Date.now();
  const hit = cache.get(reportCode);
  if (hit && hit.expiresAt > now) return hit.value;
  if (hit) cache.delete(reportCode); // expired — evict so we don't grow unbounded

  const pending = inflight.get(reportCode);
  if (pending) return pending;

  const promise = (async () => {
    const data = await executeAndUnwrap<QueryResult>(QUERY, { code: reportCode });
    const report = data.reportData.report;
    if (!report) {
      throw new Error(`WCL report not found: ${reportCode}`);
    }
    const value: CachedReport = {
      report: {
        code: report.code,
        title: report.title,
        startTime: report.startTime,
        endTime: report.endTime,
      },
      fights: report.fights,
    };
    cache.set(reportCode, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
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
        `Available fight IDs: ${formatFightIdList(fights)}`,
    );
  }
  return { startTime: fight.startTime, endTime: fight.endTime };
}

const MAX_FIGHT_IDS_IN_ERROR = 10;

function formatFightIdList(fights: Fight[]): string {
  if (fights.length === 0) return "(none)";
  const ids = fights.map((f) => f.id);
  if (ids.length <= MAX_FIGHT_IDS_IN_ERROR) return ids.join(", ");
  const head = ids.slice(0, MAX_FIGHT_IDS_IN_ERROR).join(", ");
  return `${head}, … (+${ids.length - MAX_FIGHT_IDS_IN_ERROR} more)`;
}

/** Test/debugging hook — drop a report from the cache, or clear all. */
export function invalidateReportCache(reportCode?: string): void {
  if (reportCode) cache.delete(reportCode);
  else cache.clear();
}
