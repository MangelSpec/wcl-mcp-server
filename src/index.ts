#!/usr/bin/env node
/**
 * WCL MCP Server — entry point.
 *
 * Stdio-transport MCP server that exposes Warcraft Logs V2 GraphQL tools to
 * any MCP-compatible client (Claude Desktop, Claude Code, etc.).
 *
 * Tool contract: every tool returns its payload as a single text-content
 * JSON string. On error, `isError: true` with a human-readable message.
 * Per the dev doc, we surface errors as tool responses rather than throwing
 * so agents can reason about them.
 */

// Resolve .env relative to this script's own location, not the subprocess cwd.
// MCP clients typically launch tool servers with the *client's* cwd (the user's
// project directory), not the server's install path — so a bare `dotenv/config`
// would silently fail to find .env and every tool call would error out with
// "Missing WCL_CLIENT_ID…". Anchoring to __dirname makes .env discovery robust
// regardless of how the server was launched.
import { config as dotenvConfig } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve as pathResolve } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: pathResolve(__dirname, "../.env") });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { WclRateLimitError } from "./client.js";
import { getRateLimit } from "./tools/getRateLimit.js";
import { getFights } from "./tools/getFights.js";
import { getPlayerInfo } from "./tools/getPlayerInfo.js";
import { getTable, TABLE_VIEWS } from "./tools/getTable.js";
import { getEvents, EVENT_DATA_TYPES } from "./tools/getEvents.js";
import {
  EXTERNAL_BUFF_FILTERS,
  findPeerParses,
  PEER_METRICS,
} from "./tools/findPeerParses.js";
import { getFightContext } from "./tools/getFightContext.js";
import { getFightOverview } from "./tools/getFightOverview.js";
import {
  getFightWindowContext,
  WINDOW_EVENT_TYPES,
} from "./tools/getFightWindowContext.js";
import { getPlayerFightSummary } from "./tools/getPlayerFightSummary.js";
import { rankDamageTakenByAbility } from "./tools/rankDamageTakenByAbility.js";
import { runGraphQL } from "./tools/graphql.js";

const TOOLS: Tool[] = [
  {
    name: "wcl_get_rate_limit",
    description:
      "Check the current Warcraft Logs V2 API rate limit status. Returns " +
      "limitPerHour, pointsSpentThisHour, and pointsResetIn (seconds), plus " +
      "authMode ('user' = private reports owned by the authorized account are " +
      "readable, 'client' = public/unlisted reports only). Cheap to call and " +
      "useful before running expensive queries, or to diagnose a report that " +
      "resolves as not-found.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_fights",
    description:
      "List fights (boss pulls, trash, etc.) in a WCL report. Returns the " +
      "report's title and timestamps plus an array of fights with their IDs, " +
      "encounter IDs, names, relative-ms time bounds, kill/wipe status, size, " +
      "and difficulty. Optional filters: encounterID to isolate one boss, " +
      "killType to isolate Encounters/Kills/Wipes/Trash. Explicit calls refresh " +
      "the report's fight list by default for live logging; concurrent refreshes " +
      "are deduplicated and internal table/event lookups reuse that fresh list.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: {
          type: "string",
          description:
            "The WCL report code (the alphanumeric ID from the report URL).",
        },
        encounterID: {
          type: "number",
          description: "Optional encounter ID to filter to a single boss.",
        },
        killType: {
          type: "string",
          enum: ["Encounters", "Kills", "Wipes", "Trash"],
          description:
            "Optional kill-type filter. 'Encounters' = all boss fights (kills + wipes), " +
            "'Kills' = successful kills only, 'Wipes' = failed boss attempts, " +
            "'Trash' = non-boss combat.",
        },
        refresh: {
          type: "boolean",
          default: true,
          description:
            "Refresh report metadata before filtering. Keep true for last/latest, ordinals, and unspecified fights. Set false only for an already-known exact fight ID when bounded cached metadata is acceptable.",
        },
      },
      required: ["reportCode"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_player_info",
    description:
      "Fetch the player roster for a report: actor IDs (the internal WCL " +
      "integer used by events/tables), in-game GUIDs, names, servers, " +
      "classes (type field), specs (spec field, e.g. 'Destruction'), and " +
      "role bucket ('dps' | 'healers' | 'tanks'). Also returns the log " +
      "owner. Spec is resolved from report.playerDetails across the whole " +
      "report window; if a player swapped spec mid-run we return the one " +
      "they used most. Call this once per report to build a join key " +
      "between WCL actor data and external systems that identify players " +
      "by name or GUID.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: {
          type: "string",
          description: "The WCL report code.",
        },
      },
      required: ["reportCode"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_table",
    description:
      "Fetch a summary table for a specific fight. This is the workhorse " +
      "tool — it returns the same aggregated data you see on the WCL " +
      "website (damage done, healing done, deaths, etc.). The response " +
      "shape is WCL's untyped JSON blob and varies per view. Get the " +
      "fightID from wcl_get_fights first. In-fight time fields are normalized " +
      "to fight-relative milliseconds; reportRelative* preserves WCL's raw " +
      "value and fightRelative* provides an explicit alias.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: {
          type: "string",
          description: "The WCL report code.",
        },
        fightID: {
          type: "number",
          description: "The fight ID from wcl_get_fights.",
        },
        view: {
          type: "string",
          enum: [...TABLE_VIEWS],
          description:
            "Which summary view to fetch. 'damage-done' and 'healing' are " +
            "the most common; 'deaths' gives per-death details.",
        },
        sourceID: {
          type: "number",
          description:
            "Optional: filter to a single source actor (player/pet).",
        },
        targetID: {
          type: "number",
          description: "Optional: filter to a single target actor.",
        },
        abilityID: {
          type: "number",
          description: "Optional: filter to a single ability (game spell ID).",
        },
      },
      required: ["reportCode", "fightID", "view"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_events",
    description:
      "Fetch raw combat log events for a fight with filtering. Events are " +
      "returned as WCL's untyped JSON blobs (shape varies per dataType). " +
      "Event timestamps are normalized to fight-relative milliseconds. The raw " +
      "WCL value is preserved as reportRelativeTimestamp and an explicit " +
      "fightRelativeTimestamp alias is included. " +
      "Auto-paginates internally up to maxPages (default 3) to protect " +
      "rate-limit budget. If the page cap is hit with more data remaining, " +
      "the response has truncated:true and nextPageTimestamp — pass that " +
      "value back as startTime on a follow-up call to continue. On " +
      "natural drain, truncated:false and nextPageTimestamp is omitted. " +
      "fightID is resolved to time bounds internally (same pattern as " +
      "wcl_get_table).",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: {
          type: "string",
          description: "The WCL report code.",
        },
        fightID: {
          type: "number",
          description: "The fight ID from wcl_get_fights.",
        },
        dataType: {
          type: "string",
          enum: [...EVENT_DATA_TYPES],
          description:
            "WCL EventDataType: DamageDone, DamageTaken, Healing, Casts, " +
            "Buffs, Debuffs, Deaths, Dispels, Summons, Resources, Threat, " +
            "Interrupts, CombatantInfo, or All.",
        },
        sourceID: {
          type: "number",
          description: "Optional: filter to a single source actor.",
        },
        targetID: {
          type: "number",
          description: "Optional: filter to a single target actor.",
        },
        abilityID: {
          type: "number",
          description: "Optional: filter to a single ability (game spell ID).",
        },
        limit: {
          type: "number",
          description: "Max events per page (default 10000).",
        },
        startTime: {
          type: "number",
          description:
            "Override start time in relative ms. Defaults to fight start. " +
            "Also used as the pagination cursor — pass the previous call's " +
            "nextPageTimestamp here to continue a truncated query.",
        },
        endTime: {
          type: "number",
          description:
            "Override end time in relative ms. Defaults to fight end.",
        },
        maxPages: {
          type: "number",
          description:
            "Max pages to auto-paginate through before signalling truncation. Default 3.",
        },
      },
      required: ["reportCode", "fightID", "dataType"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_find_peer_parses",
    description:
      "Find top-ranked same-spec parses near a target fight duration. Scans a bounded number of performance-ordered ranking pages, validates the undocumented ranking JSON, filters by duration and item-level proximity, then returns the highest-performing valid candidates first. Results are discovery candidates only: hydrate candidates with wcl_get_fight_context before comparison. Reports sampling, bracket, and external-buff limitations explicitly.",
    inputSchema: {
      type: "object",
      properties: {
        encounterID: { type: "number" },
        difficulty: { type: "number" },
        className: { type: "string", description: "WCL class slug/name." },
        specName: { type: "string", description: "WCL spec slug/name." },
        targetDurationMs: { type: "number" },
        metric: { type: "string", enum: [...PEER_METRICS] },
        bracket: {
          type: "number",
          description: "Optional WCL item-level ranking bracket.",
        },
        externalBuffs: {
          type: "string",
          enum: [...EXTERNAL_BUFF_FILTERS],
        },
        durationTolerancePercent: { type: "number", default: 15 },
        maxPages: { type: "number", default: 2 },
        resultLimit: { type: "number", default: 5 },
        excludeReportCode: { type: "string" },
      },
      required: [
        "encounterID",
        "difficulty",
        "className",
        "specName",
        "targetDurationMs",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_fight_context",
    description:
      "Hydrate an exact report/fight with typed encounter, difficulty, duration, average item level, fight-specific player specs/item levels, and raid composition. Use to verify ranking candidates before comparing them. Optionally includes compact talent-node and consumable summaries without returning WCL's very large raw CombatantInfo payload.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: { type: "string" },
        fightID: { type: "number" },
        includeCombatantInfo: { type: "boolean", default: false },
      },
      required: ["reportCode", "fightID"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_player_fight_summary",
    description:
      "Fetch damage, distinct boss targets, casts, buffs, resources, deaths, and exact-fight DPS/HPS parse percentiles for one player in one WCL request. Returns deterministic normalized performance metrics, class and item-level class parse percentiles, plus optional fight-relative raw table payloads. Get the fight-specific source actor ID from wcl_get_fight_context.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: { type: "string" },
        fightID: { type: "number" },
        sourceID: { type: "number" },
        includeRawTables: {
          type: "boolean",
          default: false,
          description:
            "Include large raw WCL table payloads in addition to normalized metrics.",
        },
      },
      required: ["reportCode", "fightID", "sourceID"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_fight_overview",
    description:
      "Eagerly fetch a compact fight evidence bundle in parallel: exact roster/composition plus top damage, healing, damage-taken, every death, interrupts, and dispels. Use immediately after resolving a fight instead of making separate generic table and player-info calls.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: { type: "string" },
        fightID: { type: "number" },
        topActors: { type: "number", default: 10 },
      },
      required: ["reportCode", "fightID"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_get_fight_window_context",
    description:
      "Fetch 1-6 correlated event channels for one narrow fight-relative time window in a single WCL GraphQL request, joined to actor and ability names. Use for mechanic, aura, cast, interrupt, defensive, damage, healing, and death questions around an exact timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: { type: "string" },
        fightID: { type: "number" },
        startTime: {
          type: "number",
          description: "Window start in milliseconds from fight start.",
        },
        endTime: {
          type: "number",
          description: "Window end in milliseconds from fight start.",
        },
        dataTypes: {
          type: "array",
          items: { type: "string", enum: [...WINDOW_EVENT_TYPES] },
          minItems: 1,
          maxItems: 6,
        },
        focusAbilityName: {
          type: "string",
          description:
            "Optional fuzzy token filter applied to Buffs and Debuffs after ability names are joined.",
        },
        sourceID: { type: "number" },
        targetID: { type: "number" },
        abilityID: { type: "number" },
      },
      required: ["reportCode", "fightID", "startTime", "endTime", "dataTypes"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_rank_damage_taken_by_ability",
    description:
      "Rank fight-roster players by total damage taken from one or more named abilities. Use for questions such as who soaked or was hit most by Light Quill, Void Quill, or any other specific mechanic. Returns compact combined player totals plus deterministic per-ability rankings and metric leaders without exposing the multi-megabyte raw damage table. Shared fragments such as 'Quills' match singular Light Quill and Void Quill names.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: { type: "string" },
        fightID: { type: "number" },
        abilityNames: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description:
            "Exact names or shared fragments to include, for example ['Light Quill', 'Void Quill'] or ['Quills'].",
        },
        includeNonPlayers: {
          type: "boolean",
          default: false,
          description:
            "Include pets and NPC actors in addition to fight-roster players.",
        },
      },
      required: ["reportCode", "fightID", "abilityNames"],
      additionalProperties: false,
    },
  },
  {
    name: "wcl_graphql",
    description:
      "Raw GraphQL escape hatch — run an arbitrary query against the WCL " +
      "V2 endpoint. Use this when the structured tools don't cover what " +
      "you need, or for schema introspection. Returns the full GraphQL " +
      "response body unchanged (including any `errors` array) so you can " +
      "see exactly what WCL said. This tool does NOT auto-inject " +
      "rateLimitData into your query — if you want visibility, add " +
      "`rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }` " +
      "at the root of your own query, or call wcl_get_rate_limit " +
      "separately.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A GraphQL query string.",
        },
        variables: {
          type: "object",
          description: "Optional GraphQL variables object.",
          additionalProperties: true,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  {
    name: "wcl-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "wcl_get_rate_limit": {
        const data = await getRateLimit();
        return ok(data);
      }

      case "wcl_get_fights": {
        const reportCode = requireString(args, "reportCode");
        const encounterID = optionalNumber(args, "encounterID");
        const killType = optionalEnum(args, "killType", [
          "Encounters",
          "Kills",
          "Wipes",
          "Trash",
        ] as const);
        const refresh = optionalBoolean(args, "refresh");
        const data = await getFights({
          reportCode,
          encounterID,
          killType,
          refresh,
        });
        return ok(data);
      }

      case "wcl_get_player_info": {
        const reportCode = requireString(args, "reportCode");
        const data = await getPlayerInfo(reportCode);
        return ok(data);
      }

      case "wcl_get_table": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const view = requireEnum(args, "view", TABLE_VIEWS);
        const sourceID = optionalNumber(args, "sourceID");
        const targetID = optionalNumber(args, "targetID");
        const abilityID = optionalNumber(args, "abilityID");
        const data = await getTable({
          reportCode,
          fightID,
          view,
          sourceID,
          targetID,
          abilityID,
        });
        return ok(data);
      }

      case "wcl_get_events": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const dataType = requireEnum(args, "dataType", EVENT_DATA_TYPES);
        const sourceID = optionalNumber(args, "sourceID");
        const targetID = optionalNumber(args, "targetID");
        const abilityID = optionalNumber(args, "abilityID");
        const limit = optionalNumber(args, "limit");
        const startTime = optionalNumber(args, "startTime");
        const endTime = optionalNumber(args, "endTime");
        const maxPages = optionalNumber(args, "maxPages");
        const data = await getEvents({
          reportCode,
          fightID,
          dataType,
          sourceID,
          targetID,
          abilityID,
          limit,
          startTime,
          endTime,
          maxPages,
        });
        return ok(data);
      }

      case "wcl_find_peer_parses": {
        const encounterID = requireNumber(args, "encounterID");
        const difficulty = requireNumber(args, "difficulty");
        const className = requireString(args, "className");
        const specName = requireString(args, "specName");
        const targetDurationMs = requireNumber(args, "targetDurationMs");
        const metric = optionalEnum(args, "metric", PEER_METRICS);
        const bracket = optionalNumber(args, "bracket");
        const externalBuffs = optionalEnum(
          args,
          "externalBuffs",
          EXTERNAL_BUFF_FILTERS,
        );
        const durationTolerancePercent = optionalNumber(
          args,
          "durationTolerancePercent",
        );
        const maxPages = optionalNumber(args, "maxPages");
        const resultLimit = optionalNumber(args, "resultLimit");
        const excludeReportCode = optionalString(args, "excludeReportCode");
        const data = await findPeerParses({
          encounterID,
          difficulty,
          className,
          specName,
          targetDurationMs,
          metric,
          bracket,
          externalBuffs,
          durationTolerancePercent,
          maxPages,
          resultLimit,
          excludeReportCode,
        });
        return ok(data);
      }

      case "wcl_get_fight_context": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const includeCombatantInfo = optionalBoolean(
          args,
          "includeCombatantInfo",
        );
        const data = await getFightContext({
          reportCode,
          fightID,
          includeCombatantInfo,
        });
        return ok(data);
      }

      case "wcl_get_fight_overview": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const topActors = optionalNumber(args, "topActors");
        const data = await getFightOverview({ reportCode, fightID, topActors });
        return ok(data);
      }

      case "wcl_get_fight_window_context": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const startTime = requireNumber(args, "startTime");
        const endTime = requireNumber(args, "endTime");
        const dataTypes = requireEnumArray(
          args,
          "dataTypes",
          WINDOW_EVENT_TYPES,
        );
        const focusAbilityName = optionalString(args, "focusAbilityName");
        const sourceID = optionalNumber(args, "sourceID");
        const targetID = optionalNumber(args, "targetID");
        const abilityID = optionalNumber(args, "abilityID");
        const data = await getFightWindowContext({
          reportCode,
          fightID,
          startTime,
          endTime,
          dataTypes,
          focusAbilityName,
          sourceID,
          targetID,
          abilityID,
        });
        return ok(data);
      }

      case "wcl_rank_damage_taken_by_ability": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const abilityNames = requireStringArray(args, "abilityNames", 10);
        const includeNonPlayers = optionalBoolean(args, "includeNonPlayers");
        const data = await rankDamageTakenByAbility({
          reportCode,
          fightID,
          abilityNames,
          includeNonPlayers,
        });
        return ok(data);
      }

      case "wcl_get_player_fight_summary": {
        const reportCode = requireString(args, "reportCode");
        const fightID = requireNumber(args, "fightID");
        const sourceID = requireNumber(args, "sourceID");
        const includeRawTables = optionalBoolean(args, "includeRawTables");
        const data = await getPlayerFightSummary({
          reportCode,
          fightID,
          sourceID,
          includeRawTables,
        });
        return ok(data);
      }

      case "wcl_graphql": {
        const query = requireString(args, "query");
        const variables = optionalObject(args, "variables");
        const data = await runGraphQL({ query, variables });
        return ok(data);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    // Surface WclRateLimitError with its structured rateLimit payload so
    // callers can programmatically see reset timing instead of parsing a
    // human-readable string.
    if (e instanceof WclRateLimitError) {
      return err(e.message, { kind: "rate_limit", rateLimit: e.rateLimit });
    }
    return err(e instanceof Error ? e.message : String(e));
  }
});

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string, details?: Record<string, unknown>) {
  // Default to the plaintext "Error: …" shape. When we have structured context
  // (e.g. a rate-limit payload), emit JSON so callers can parse it alongside
  // the message.
  const text = details
    ? JSON.stringify({ error: message, ...details }, null, 2)
    : `Error: ${message}`;
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

// --- tiny arg validation helpers ---
// MCP clients will already enforce inputSchema, but we re-validate on the
// server side as a defense-in-depth measure (and to get clean types).

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`Argument "${key}" must be a non-empty string`);
  }
  return v.trim();
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(
  args: Record<string, unknown>,
  key: string,
  maxItems: number,
): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new Error(`${key} must contain 1 to ${maxItems} strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${key} must contain only non-empty strings`);
    }
    return entry.trim();
  });
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Argument "${key}" must be a finite number`);
  }
  return v;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`Argument "${key}" must be a finite number if provided`);
  }
  return v;
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const v = args[key];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new Error(
      `Argument "${key}" must be one of: ${allowed.join(", ")} (got ${JSON.stringify(v)})`,
    );
  }
  return v as T;
}

function requireEnumArray<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Argument "${key}" must be a non-empty array`);
  }
  const allowedValues = new Set<string>(allowed);
  for (const entry of value) {
    if (typeof entry !== "string" || !allowedValues.has(entry)) {
      throw new Error(
        `Argument "${key}" contains an unsupported value: ${JSON.stringify(entry)}`,
      );
    }
  }
  return value as T[];
}

function optionalObject(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`Argument "${key}" must be an object if provided`);
  }
  return v as Record<string, unknown>;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return requireEnum(args, key, allowed);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("wcl-mcp-server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting wcl-mcp-server:", err);
  process.exit(1);
});
