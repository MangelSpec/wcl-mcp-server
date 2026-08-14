/**
 * wcl_get_events — fetch raw combat log events with filtering, paginated.
 *
 * Design contract (from the dev doc):
 *
 * - Caller passes a `fightID` which we resolve to startTime/endTime via
 *   the shared report cache, same pattern as wcl_get_table. Caller can
 *   also override startTime/endTime directly — that's how pagination
 *   continuation works (pass the previous page's nextPageTimestamp as
 *   the next call's startTime).
 *
 * - We auto-paginate *internally* while WCL keeps returning
 *   nextPageTimestamp, up to `maxPages` (default 3). The cap exists to
 *   protect the rate-limit budget on unbounded queries.
 *
 * - When the cap is hit with more data remaining, the response MUST
 *   loudly signal truncation:
 *       { truncated: true, pagesReturned: N, nextPageTimestamp: X }
 *   so the agent can consciously decide to call again with
 *   startTime: nextPageTimestamp. When the query drains naturally,
 *   `truncated: false` and `nextPageTimestamp` is omitted.
 *
 * - `events.data` comes back as an untyped JSON array. We pass it
 *   through unchanged — no reshaping. Consumer does the mapping.
 *
 * The EventDataType enum values used here are the ones WCL's schema
 * exposes. Verify with introspection via wcl_graphql if anything looks
 * off (see scripts/smoke-test.mjs for the introspection query we run).
 */

import { executeAndUnwrap } from "../client.js";
import {
  addFightRelativeTimes,
  resolveFightRelativeWindow,
} from "../fightTime.js";
import { resolveFightBounds } from "../reportCache.js";

/**
 * EventDataType enum values accepted by WCL's `report.events(dataType:)`.
 * Verified at runtime by the smoke test's introspection step. If WCL adds
 * or renames one we'll want to update this list, but the underlying call
 * will still succeed as long as the agent passes a value WCL recognizes.
 */
export const EVENT_DATA_TYPES = [
  "All",
  "Buffs",
  "Casts",
  "CombatantInfo",
  "DamageDone",
  "DamageTaken",
  "Deaths",
  "Debuffs",
  "Dispels",
  "Healing",
  "Interrupts",
  "Resources",
  "Summons",
  "Threat",
] as const;

export type EventDataType = (typeof EVENT_DATA_TYPES)[number];

export interface GetEventsArgs {
  reportCode: string;
  fightID: number;
  dataType: EventDataType;
  sourceID?: number;
  targetID?: number;
  abilityID?: number;
  limit?: number;
  /** Override start time (relative ms). Defaults to fight start. Also the pagination cursor. */
  startTime?: number;
  /** Override end time (relative ms). Defaults to fight end. */
  endTime?: number;
  /** Max auto-pagination pages before signalling truncation. Default 3. */
  maxPages?: number;
}

export interface GetEventsResult {
  reportCode: string;
  fightID: number;
  dataType: EventDataType;
  /** Time window actually queried (post-resolution, post-clamping). */
  startTime: number;
  endTime: number;
  fightStartTime: number;
  fightEndTime: number;
  fightDuration: number;
  /** Event time fields are fight-relative; reportRelative* preserves WCL's raw values. */
  events: unknown[];
  pagesReturned: number;
  /** True iff we stopped because we hit maxPages with more data remaining. */
  truncated: boolean;
  /**
   * Present when truncated===true: pass this back as `startTime` to continue.
   * Omitted when the query drained naturally.
   */
  nextPageTimestamp?: number;
}

const QUERY = /* GraphQL */ `
  query (
    $code: String!
    $startTime: Float!
    $endTime: Float!
    $dataType: EventDataType
    $sourceID: Int
    $targetID: Int
    $abilityID: Float
    $limit: Int
  ) {
    reportData {
      report(code: $code) {
        events(
          startTime: $startTime
          endTime: $endTime
          dataType: $dataType
          sourceID: $sourceID
          targetID: $targetID
          abilityID: $abilityID
          limit: $limit
        ) {
          data
          nextPageTimestamp
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
      events: {
        data: unknown;
        nextPageTimestamp: number | null;
      } | null;
    } | null;
  };
}

const DEFAULT_LIMIT = 10_000;
const DEFAULT_MAX_PAGES = 3;

export async function getEvents(args: GetEventsArgs): Promise<GetEventsResult> {
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES;
  if (maxPages < 1) {
    throw new Error(`maxPages must be >= 1 (got ${maxPages})`);
  }

  const bounds = await resolveFightBounds(args.reportCode, args.fightID);
  const fightStart = bounds.startTime;
  const fightEnd = bounds.endTime;

  const window = resolveFightRelativeWindow(
    fightStart,
    fightEnd,
    args.startTime,
    args.endTime,
  );

  const limit = args.limit ?? DEFAULT_LIMIT;

  const allEvents: unknown[] = [];
  let cursor = window.reportRelativeStartTime;
  let pagesReturned = 0;
  let nextPageTimestamp: number | null = null;

  for (let i = 0; i < maxPages; i++) {
    const variables: Record<string, unknown> = {
      code: args.reportCode,
      startTime: cursor,
      endTime: window.reportRelativeEndTime,
      dataType: args.dataType,
      limit,
    };
    if (args.sourceID !== undefined) variables.sourceID = args.sourceID;
    if (args.targetID !== undefined) variables.targetID = args.targetID;
    if (args.abilityID !== undefined) variables.abilityID = args.abilityID;

    const data = await executeAndUnwrap<QueryResult>(QUERY, variables);
    const report = data.reportData.report;
    if (!report) {
      throw new Error(`WCL report not found: ${args.reportCode}`);
    }
    const events = report.events;
    pagesReturned++;

    if (!events) {
      // Null events object — treat as no data this page and stop.
      nextPageTimestamp = null;
      break;
    }

    if (Array.isArray(events.data)) {
      allEvents.push(
        ...events.data.map((event) =>
          addFightRelativeTimes(event, fightStart, fightEnd),
        ),
      );
    } else if (events.data != null) {
      // Defensive: WCL may occasionally return a non-array shape for exotic
      // dataTypes. Push the raw value so nothing is silently lost.
      allEvents.push(addFightRelativeTimes(events.data, fightStart, fightEnd));
    }

    nextPageTimestamp = events.nextPageTimestamp;
    if (nextPageTimestamp == null) break;

    // Guard against a pathological cursor that doesn't advance. If we
    // surfaced this as truncated:true with the non-advancing cursor, the
    // caller would loop forever — calling again with the same startTime
    // would land in the same state. Treat it as drained instead and log
    // to stderr so the smoke test surfaces the drift.
    if (nextPageTimestamp <= cursor) {
      console.error(
        `wcl_get_events: WCL returned non-advancing nextPageTimestamp ` +
          `(${nextPageTimestamp} <= cursor ${cursor}) on page ${pagesReturned} ` +
          `for report=${args.reportCode} fight=${args.fightID} dataType=${args.dataType}. ` +
          `Treating as drained to avoid a caller retry loop.`,
      );
      nextPageTimestamp = null;
      break;
    }
    cursor = nextPageTimestamp;
  }

  const truncated = nextPageTimestamp != null;

  const result: GetEventsResult = {
    reportCode: args.reportCode,
    fightID: args.fightID,
    dataType: args.dataType,
    startTime: window.startTime,
    endTime: window.endTime,
    fightStartTime: fightStart,
    fightEndTime: fightEnd,
    fightDuration: fightEnd - fightStart,
    events: allEvents,
    pagesReturned,
    truncated,
  };
  if (truncated && nextPageTimestamp != null) {
    result.nextPageTimestamp = nextPageTimestamp - fightStart;
  }
  return result;
}
