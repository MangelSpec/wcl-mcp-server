import { executeAndUnwrap } from "../client.js";

export const PEER_METRICS = ["dps", "bossdps", "wdps"] as const;
export const EXTERNAL_BUFF_FILTERS = ["Any", "Exclude", "Require"] as const;

export type PeerMetric = (typeof PEER_METRICS)[number];
export type ExternalBuffFilter = (typeof EXTERNAL_BUFF_FILTERS)[number];

export interface FindPeerParsesArgs {
  bracket?: number;
  className: string;
  difficulty: number;
  durationTolerancePercent?: number;
  encounterID: number;
  excludeReportCode?: string;
  externalBuffs?: ExternalBuffFilter;
  maxPages?: number;
  metric?: PeerMetric;
  resultLimit?: number;
  specName: string;
  targetDurationMs: number;
}

export interface PeerParseCandidate {
  amount: number | null;
  bracketData: number | null;
  className: string | null;
  durationDeltaMs: number;
  durationDeltaPercent: number;
  durationMs: number;
  fightID: number;
  playerName: string | null;
  reportCode: string;
  specName: string | null;
}

const QUERY = /* GraphQL */ `
  query PeerRankings(
    $encounterID: Int!
    $difficulty: Int!
    $className: String!
    $specName: String!
    $metric: CharacterRankingMetricType!
    $page: Int!
    $bracket: Int
    $externalBuffs: ExternalBuffRankFilter
  ) {
    worldData {
      encounter(id: $encounterID) {
        id
        name
        characterRankings(
          difficulty: $difficulty
          className: $className
          specName: $specName
          metric: $metric
          page: $page
          bracket: $bracket
          leaderboard: LogsOnly
          externalBuffs: $externalBuffs
          includeCombatantInfo: false
          includeOtherPlayers: false
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

interface QueryResult {
  worldData: {
    encounter: {
      id: number;
      name: string;
      characterRankings: unknown;
    } | null;
  };
}

interface RankingPage {
  hasMorePages: boolean;
  rankings: unknown[];
}

export async function findPeerParses(args: FindPeerParsesArgs) {
  const maxPages = Math.min(Math.max(args.maxPages ?? 2, 1), 5);
  const resultLimit = Math.min(Math.max(args.resultLimit ?? 5, 1), 10);
  const tolerance = Math.min(
    Math.max(args.durationTolerancePercent ?? 15, 1),
    100,
  );
  let scan = await scanRankingPages(args, maxPages, args.bracket ?? null);
  let peers = selectPeerCandidates(
    scan.candidates,
    tolerance,
    resultLimit,
    args.bracket,
  );
  const bracketFallbackUsed = args.bracket !== undefined && peers.length === 0;
  if (bracketFallbackUsed) {
    scan = await scanRankingPages(args, maxPages, null);
    peers = selectPeerCandidates(
      scan.candidates,
      tolerance,
      resultLimit,
      args.bracket,
    );
  }

  return {
    encounterID: args.encounterID,
    encounterName: scan.encounterName,
    query: {
      bracket: args.bracket ?? null,
      bracketFallbackUsed,
      effectiveBracket: bracketFallbackUsed ? null : (args.bracket ?? null),
      className: args.className,
      difficulty: args.difficulty,
      externalBuffs: args.externalBuffs ?? "Any",
      externalBuffSupport: "unknown",
      metric: args.metric ?? "dps",
      specName: args.specName,
    },
    targetDurationMs: args.targetDurationMs,
    durationTolerancePercent: tolerance,
    pagesRead: scan.pagesRead,
    rankingResultsTruncated: scan.hasMorePages,
    candidatesScanned: scan.candidates.length,
    rejectedEntries: scan.rejectedEntries,
    peers,
    caveats: [
      "The ranking payload is undocumented JSON and was runtime-validated.",
      "Ranking pages are performance-ordered; duration and item level filter eligibility, then the selected metric orders valid candidates.",
      "When an exact item-level bracket returns no rows, the tool falls back to overall rankings and uses bracketData only as a proximity heuristic.",
      "External-buff filter support is not reported by WCL and may be ignored for this encounter.",
      "Hydrate each selected report/fight and verify item level and talents before using it as a peer.",
    ],
  };
}

async function scanRankingPages(
  args: FindPeerParsesArgs,
  maxPages: number,
  bracket: number | null,
) {
  const candidates: PeerParseCandidate[] = [];
  let encounterName: string | null = null;
  let hasMorePages = false;
  let pagesRead = 0;
  let rejectedEntries = 0;

  for (let page = 1; page <= maxPages; page++) {
    const data = await executeAndUnwrap<QueryResult>(QUERY, {
      encounterID: args.encounterID,
      difficulty: args.difficulty,
      className: args.className,
      specName: args.specName,
      metric: args.metric ?? "dps",
      page,
      bracket,
      externalBuffs: args.externalBuffs ?? "Any",
    });
    const encounter = data.worldData.encounter;
    if (!encounter)
      throw new Error(`WCL encounter not found: ${args.encounterID}`);
    encounterName = encounter.name;
    const rankingPage = parseRankingPage(encounter.characterRankings);
    pagesRead++;
    hasMorePages = rankingPage.hasMorePages;
    for (const raw of rankingPage.rankings) {
      const candidate = parsePeerCandidate(raw, args.targetDurationMs);
      if (!candidate) {
        rejectedEntries++;
        continue;
      }
      if (candidate.reportCode === args.excludeReportCode) continue;
      candidates.push(candidate);
    }
    if (!hasMorePages) break;
  }

  return {
    candidates,
    encounterName,
    hasMorePages,
    pagesRead,
    rejectedEntries,
  };
}

export function selectPeerCandidates(
  candidates: PeerParseCandidate[],
  durationTolerancePercent: number,
  resultLimit: number,
  targetItemLevel?: number,
): PeerParseCandidate[] {
  const withinTolerance = candidates.filter(
    (candidate) => candidate.durationDeltaPercent <= durationTolerancePercent,
  );

  const itemLevelMatches =
    targetItemLevel === undefined
      ? []
      : withinTolerance.filter(
          (candidate) =>
            candidate.bracketData !== null &&
            Math.abs(candidate.bracketData - targetItemLevel) <= 5,
        );
  return (itemLevelMatches.length > 0 ? itemLevelMatches : withinTolerance)
    .sort(
      (a, b) =>
        (b.amount ?? 0) - (a.amount ?? 0) ||
        a.durationDeltaPercent - b.durationDeltaPercent,
    )
    .slice(0, resultLimit);
}

export function parseRankingPage(value: unknown): RankingPage {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) return { hasMorePages: false, rankings: parsed };
  if (!parsed || typeof parsed !== "object") {
    return { hasMorePages: false, rankings: [] };
  }
  const record = parsed as Record<string, unknown>;
  return {
    hasMorePages: record.hasMorePages === true,
    rankings: Array.isArray(record.rankings) ? record.rankings : [],
  };
}

export function parsePeerCandidate(
  value: unknown,
  targetDurationMs: number,
): PeerParseCandidate | null {
  if (!value || typeof value !== "object") return null;
  const ranking = value as Record<string, unknown>;
  const report = ranking.report;
  if (!report || typeof report !== "object") return null;
  const reportRecord = report as Record<string, unknown>;
  const reportCode = reportRecord.code;
  const fightID = reportRecord.fightID;
  const duration = ranking.duration;
  if (
    typeof reportCode !== "string" ||
    typeof fightID !== "number" ||
    !Number.isInteger(fightID) ||
    fightID <= 0 ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return null;
  }
  const deltaMs = Math.abs(duration - targetDurationMs);
  return {
    amount: finiteNumber(ranking.amount),
    bracketData: finiteNumber(ranking.bracketData),
    className: stringOrNull(ranking.class),
    durationDeltaMs: deltaMs,
    durationDeltaPercent: Number(
      ((deltaMs / targetDurationMs) * 100).toFixed(2),
    ),
    durationMs: duration,
    fightID,
    playerName: stringOrNull(ranking.name),
    reportCode,
    specName: stringOrNull(ranking.spec),
  };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
