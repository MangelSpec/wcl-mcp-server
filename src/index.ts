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

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { getRateLimit } from "./tools/getRateLimit.js";
import { getFights } from "./tools/getFights.js";
import { getPlayerInfo } from "./tools/getPlayerInfo.js";
import { getTable, TABLE_VIEWS } from "./tools/getTable.js";

const TOOLS: Tool[] = [
  {
    name: "wcl_get_rate_limit",
    description:
      "Check the current Warcraft Logs V2 API rate limit status. Returns " +
      "limitPerHour, pointsSpentThisHour, and pointsResetIn (seconds). Cheap " +
      "to call and useful before running expensive queries.",
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
      "killType to isolate Encounters/Kills/Wipes/Trash.",
    inputSchema: {
      type: "object",
      properties: {
        reportCode: {
          type: "string",
          description: "The WCL report code (the alphanumeric ID from the report URL).",
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
      "classes (type), and specs (subType). Also returns the log owner. " +
      "Call this once per report to build a join key between WCL actor " +
      "data and external systems that identify players by name or GUID.",
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
      "fightID from wcl_get_fights first.",
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
          description: "Optional: filter to a single source actor (player/pet).",
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
        const data = await getFights({ reportCode, encounterID, killType });
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

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
});

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// --- tiny arg validation helpers ---
// MCP clients will already enforce inputSchema, but we re-validate on the
// server side as a defense-in-depth measure (and to get clean types).

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Argument "${key}" must be a non-empty string`);
  }
  return v;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(`Argument "${key}" must be a number`);
  }
  return v;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new Error(`Argument "${key}" must be a number if provided`);
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
