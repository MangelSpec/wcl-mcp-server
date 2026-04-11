# wcl-mcp-server

MCP server that exposes the [Warcraft Logs V2 GraphQL API](https://www.warcraftlogs.com/v2-api-docs/warcraft/) as tools for AI agents. Talks stdio, ships six tools (fights, player info, tables, events, rate limit, raw GraphQL), and is designed so an agent can do end-to-end log analysis without ever touching the WCL website.

- Source: [src/](src/)
- Entry point: [src/index.ts](src/index.ts)

---

## Prerequisites

1. **Node.js 18+** (uses the global `fetch`).
2. **A Warcraft Logs V2 API client.** Create a *confidential* (not public) client at https://www.warcraftlogs.com/api/clients/ — you need the Client ID and Client Secret. The client-credentials OAuth flow is used; no redirect URI / user login required.

## Setup

```bash
# 1. install deps
npm install

# 2. create .env from the template and fill in WCL credentials
cp .env.example .env
#   then edit .env:
#     WCL_CLIENT_ID=<your client id>
#     WCL_CLIENT_SECRET=<your client secret>

# 3. build (compiles src/ -> dist/ via tsc)
npm run build
```

`npm install` also runs `prepare` (which runs `tsc`), so after a fresh clone + install, [dist/](dist/) should already exist. Re-run `npm run build` after editing any file under [src/](src/).

## Running the server

The server speaks MCP over stdio. You don't run it interactively — an MCP client launches it as a subprocess and talks to it via stdin/stdout.

- **Production (compiled):** `node dist/index.js` — this is what MCP clients should invoke.
- **Development (no build step):** `npm run dev` — runs [src/index.ts](src/index.ts) through `tsx`. Handy for iterating, but MCP clients should point at the compiled `dist/index.js` path.
- **Manual sanity check:** running `node dist/index.js` in a terminal should print `wcl-mcp-server running on stdio` to **stderr** and then block waiting for JSON-RPC on stdin. That's the expected state — kill it with Ctrl-C.

## Wiring it into an MCP client

### Claude Desktop / Claude Code

Add an entry to your MCP client config (e.g. `claude_desktop_config.json` or the equivalent for your client). Use the absolute path to `dist/index.js`.

```json
{
  "mcpServers": {
    "wcl": {
      "command": "node",
      "args": ["C:\\Users\\adria\\_dev\\wcl-mcp-server\\dist\\index.js"]
    }
  }
}
```

Credentials are read from the [.env](.env) file at repo root via `dotenv`, so you do **not** need to pass them through the MCP client's `env` block. If you'd rather inject them explicitly, you can:

```json
{
  "mcpServers": {
    "wcl": {
      "command": "node",
      "args": ["C:\\Users\\adria\\_dev\\wcl-mcp-server\\dist\\index.js"],
      "env": {
        "WCL_CLIENT_ID": "…",
        "WCL_CLIENT_SECRET": "…"
      }
    }
  }
}
```

After editing the config, restart the MCP client. Then you should see the `wcl_*` tools in its tool list.

---

## Tools (agent reference)

All tools return a single `text` content block whose body is a JSON string. On error, `isError: true` and the text is either `Error: <message>` or a JSON object with `error` + structured context (e.g. `rateLimit` on 429). **Validate inputs carefully — every tool re-checks its arguments server-side and will refuse malformed requests.**

### `wcl_get_rate_limit`
Check current V2 API rate limit state. **Call this before expensive queries** — WCL enforces a points-per-hour budget, and [src/tools/getEvents.ts](src/tools/getEvents.ts) especially can burn a lot if you set `maxPages` high.
- Input: `{}`
- Output: `{ limitPerHour, pointsSpentThisHour, pointsResetIn }` (seconds).

### `wcl_get_fights`
List fights in a report. This is almost always the **first** tool you call for a new report — you need the `fightID`s it returns before you can fetch tables or events.
- Input: `{ reportCode, encounterID?, killType? }`
  - `reportCode` — the alphanumeric code from a WCL URL like `https://www.warcraftlogs.com/reports/<reportCode>`.
  - `killType` ∈ `"Encounters" | "Kills" | "Wipes" | "Trash"`. `Encounters` = all boss fights.
- Output: `{ report: { title, startTime, endTime, ... }, fights: [{ id, encounterID, name, startTime, endTime, kill, size, difficulty, bossPercentage, ... }] }`.

### `wcl_get_player_info`
Fetch the actor roster for a report. Use this **once per report** to build a join table: WCL actor `id` ↔ in-game GUID ↔ character name ↔ class/spec/role. Spec is resolved across the whole report window; if a player swapped specs mid-run, the most-used spec wins.
- Input: `{ reportCode }`
- Output: `{ logOwner, actors: [{ id, guid, name, server, type, subType, spec, role }] }` where `role ∈ "dps" | "healers" | "tanks"`.

### `wcl_get_table`
The workhorse summary tool — same aggregated data the WCL website shows (damage done, healing, deaths, etc.). The response shape is WCL's untyped JSON blob and **varies per view**, so treat it as dynamic.
- Input: `{ reportCode, fightID, view, sourceID?, targetID?, abilityID? }`
  - `view` — canonical views include `"damage-done"`, `"damage-taken"`, `"healing"`, `"deaths"`, `"casts"`, `"buffs"`, `"debuffs"`, `"summons"`, `"resources"`, `"interrupts"`, `"dispels"`, `"threat"`. Check [src/tools/getTable.ts](src/tools/getTable.ts) for the authoritative `TABLE_VIEWS` list.
- Output: `{ table: <WCL's raw JSON>, fightWindow: { startTime, endTime } }`.
- Pattern: get `fightID` from `wcl_get_fights` first, then call this.

### `wcl_get_events`
Raw combat log events with filtering. Auto-paginates up to `maxPages` (default 3) to protect rate-limit budget.
- Input: `{ reportCode, fightID, dataType, sourceID?, targetID?, abilityID?, limit?, startTime?, endTime?, maxPages? }`
  - `dataType` — one of `"DamageDone" | "DamageTaken" | "Healing" | "Casts" | "Buffs" | "Debuffs" | "Deaths" | "Dispels" | "Summons" | "Resources" | "Threat" | "Interrupts" | "CombatantInfo" | "All"`. See `EVENT_DATA_TYPES` in [src/tools/getEvents.ts](src/tools/getEvents.ts).
  - `limit` — max events per page (default 10000).
- Output: `{ events: [...], pagesReturned, truncated, nextPageTimestamp? }`.
- **Pagination contract:** if `truncated: true`, more data remains. Pass the returned `nextPageTimestamp` back as `startTime` on a follow-up call to continue. If `truncated: false`, `nextPageTimestamp` is omitted and you have everything.

### `wcl_graphql`
Raw GraphQL escape hatch. Use this when the structured tools don't cover what you need, or for schema introspection. **Does not auto-inject `rateLimitData`** — call `wcl_get_rate_limit` separately or add `rateLimitData { limitPerHour pointsSpentThisHour pointsResetIn }` to your own query.
- Input: `{ query, variables? }`
- Output: the raw GraphQL response body (including any `errors` array).

---

## Agent-facing notes and gotchas

- **Always call `wcl_get_fights` first** for a new report — you can't get meaningful tables or events without a `fightID`.
- **Call `wcl_get_player_info` once per report** and cache the mapping. Every other tool identifies players by numeric `id`, but you'll usually want to reason in names/specs.
- **Times are relative-ms from report start**, not wall-clock. The fight window (`startTime`/`endTime` in ms) is what `wcl_get_table` and `wcl_get_events` use internally.
- **Rate limit budget is per-hour, per-client.** `wcl_get_events` with `maxPages > 3` or `All` dataType will burn points fast. Check `wcl_get_rate_limit` before and after batch work. On a 429, the server returns a structured error with `kind: "rate_limit"` and a `rateLimit` payload containing reset timing.
- **Error shape:** routine failures come back as `isError: true` with a text message. Rate-limit errors come back as `isError: true` with a JSON body (`{ error, kind: "rate_limit", rateLimit: {...} }`). Parse accordingly.
- **Report caching:** per-report metadata is cached in-process by [src/reportCache.ts](src/reportCache.ts). Repeated calls against the same `reportCode` within one server lifetime are cheap.

---

## Smoke test

[scripts/smoke-test.mjs](scripts/smoke-test.mjs) spawns the compiled server, exercises every tool against a known public report (`cqKLtMJC2abXhzNY`), and prints concise per-tool summaries. It hits the real API and burns ~15 rate-limit points.

```bash
npm run build
node scripts/smoke-test.mjs
```

Useful as a pre-push sanity check. It also introspects WCL's schema for `EventDataType` and `TableDataType` and warns if the hardcoded enum lists in [src/tools/getEvents.ts](src/tools/getEvents.ts) / [src/tools/getTable.ts](src/tools/getTable.ts) have drifted from upstream.

## Troubleshooting

- **"Missing WCL_CLIENT_ID and/or WCL_CLIENT_SECRET"** — `.env` not found or empty. Confirm it lives at the repo root (not in `dist/`) and the MCP client's working directory is the repo root, or pass the vars via the client config's `env` block.
- **OAuth 401 / "token request failed"** — credentials wrong, or you created a *public* client instead of a *confidential* one. Re-create at https://www.warcraftlogs.com/api/clients/.
- **Tool returns `isError: true` with `"kind": "rate_limit"`** — wait for `rateLimit.pointsResetIn` seconds before retrying. Don't loop on 429s.
- **"report not found" / GraphQL errors** — the `reportCode` is wrong, private, or the report has been deleted. Try the same code on the WCL website to confirm.
- **Server silently hangs on startup** — that's normal. The server only logs to stderr (`wcl-mcp-server running on stdio`) and then blocks on stdin. It's waiting for an MCP client to speak JSON-RPC to it.

## Project layout

```
src/
  index.ts          — MCP server wiring, tool registration, arg validation
  auth.ts           — OAuth2 client-credentials + token caching
  client.ts         — GraphQL transport, error normalization, rate-limit parsing
  reportCache.ts    — per-report metadata cache
  tools/
    getRateLimit.ts
    getFights.ts
    getPlayerInfo.ts
    getTable.ts     — canonical TABLE_VIEWS list
    getEvents.ts    — canonical EVENT_DATA_TYPES list + pagination
    graphql.ts      — raw query escape hatch
scripts/
  smoke-test.mjs    — live end-to-end test
references/
  wcl-mcp-server-dev-doc.md       — design notes
  wcl-mcp-server-post-mortem.md   — what broke, what got fixed
```
