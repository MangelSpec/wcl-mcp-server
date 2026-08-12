# wcl-mcp-server

MCP server that exposes the [Warcraft Logs V2 GraphQL API](https://www.warcraftlogs.com/v2-api-docs/warcraft/) as tools for AI agents. Talks stdio, ships six tools (fights, player info, tables, events, rate limit, raw GraphQL), and is designed so an agent can do end-to-end log analysis without ever touching the WCL website.

- Source: [src/](src/)
- Entry point: [src/index.ts](src/index.ts)

---

## Prerequisites

1. **Node.js 18+** (uses the global `fetch`).
2. **A Warcraft Logs V2 API client.** Create a *confidential* (not public) client at https://www.warcraftlogs.com/api/clients/ — you need the Client ID and Client Secret. By default the client-credentials OAuth flow is used; no redirect URI / user login required.
3. *(Optional)* **To read your own private logs**, you additionally need a Redirect URI registered on that same client — see [Private log access](#private-log-access) below.

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

## Private log access

Out of the box the server authenticates as your *API client*, not as *you*. That token can read public and **unlisted** reports, but private reports resolve as not-found no matter who owns them. If the only goal is keeping a log off your public profile, setting its visibility to **unlisted** on the WCL site is the zero-setup answer — the server can already read those by code.

For genuinely private reports, authorize the server against your WCL account once:

1. **Register a redirect URI.** Edit your client at https://www.warcraftlogs.com/api/clients/ and add:
   ```
   http://localhost:4477/callback
   ```
   It must match exactly — scheme, host, port, and path. To use a different port, set `WCL_REDIRECT_URI` in `.env` and register that value instead.

2. **Run the auth flow.**
   ```bash
   npm run auth
   ```
   This builds, opens your browser to WCL's consent screen, catches the redirect on a temporary loopback server, and exchanges the code for a user token. It prints the account name it authorized as.

3. **Done.** The token is written to `~/.wcl-mcp/token.json` (mode 0600, override with `WCL_TOKEN_FILE`). Its presence is what flips the server into user mode — [src/client.ts](src/client.ts) then talks to `https://www.warcraftlogs.com/api/v2/user` instead of `/api/v2/client`, and every existing tool transparently gains access to reports you own. No tool signatures change.

Supporting commands:

```bash
npm run auth:status
```

```bash
npm run auth:logout
```

`auth:status` prints where the token lives, when it expires, and whether it can self-refresh. `auth:logout` deletes it, reverting the server to public-only client credentials.

**Verifying which mode you're in:** call `wcl_get_rate_limit` — its `authMode` field is `"user"` or `"client"`.

Notes and caveats:

- **Scope of access is your account's.** You can read private reports you own or that are shared with you (e.g. your guild's), not arbitrary private logs.
- **The token is a live credential to your WCL account** — more sensitive than the client secret. It lives outside the repo, is written 0600, and is never logged or included in error messages.
- **Refresh is automatic.** If WCL issued a refresh token, [src/auth.ts](src/auth.ts) renews in the background and rewrites the file; a 401 also forces a refresh attempt before failing. If no refresh token was issued, you'll be told to re-run `npm run auth` when it eventually expires.
- **Rate limit points are then billed against your user account** rather than the client.
- **Client credentials remain the fallback.** Delete the token file (or never create it) and behavior is identical to before this feature existed.

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
      "args": ["<absolute-path-to-wcl-mcp-server>/dist/index.js"]
    }
  }
}
```

Replace `<absolute-path-to-wcl-mcp-server>` with wherever you cloned this repo. On Windows, escape backslashes (e.g. `C:\\path\\to\\wcl-mcp-server\\dist\\index.js`).

Credentials are read from the [.env](.env) file at repo root via `dotenv`, which is resolved relative to the compiled script's own location (see [src/index.ts](src/index.ts)) — so `.env` is found regardless of the client's working directory, and you do **not** need to set `cwd` or pass vars through the MCP client's `env` block. If you'd rather inject them explicitly, you can:

```json
{
  "mcpServers": {
    "wcl": {
      "command": "node",
      "args": ["<absolute-path-to-wcl-mcp-server>/dist/index.js"],
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
- Output: `{ limitPerHour, pointsSpentThisHour, pointsResetIn, authMode }` (`pointsResetIn` in seconds).
- `authMode` ∈ `"user" | "client"`. `"user"` means private reports owned by the authorized account are readable; `"client"` means public/unlisted only. Check this first when a report you *know* exists comes back not-found — see [Private log access](#private-log-access).

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
- **Report visibility depends on auth mode.** In the default client-credentials mode only public and unlisted reports resolve; a private report is indistinguishable from a nonexistent one. `wcl_get_rate_limit` reports the current `authMode`.
- **Rate limit budget is per-hour, per-client** (per-*user* once authorized for private access). `wcl_get_events` with `maxPages > 3` or `All` dataType will burn points fast. Check `wcl_get_rate_limit` before and after batch work. On a 429, the server returns a structured error with `kind: "rate_limit"` and a `rateLimit` payload containing reset timing.
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

- **"Missing WCL_CLIENT_ID and/or WCL_CLIENT_SECRET"** — `.env` not found or empty. Confirm it lives at the repo root (not in `dist/`) and that `WCL_CLIENT_ID` / `WCL_CLIENT_SECRET` are both set inside it. `.env` is resolved relative to the compiled script's own location, so cwd shouldn't matter — if it's still not being picked up, verify you ran `npm run build` after creating `.env` (unlikely to be related, but rules out build-cache staleness), or pass the vars explicitly via the MCP client's `env` block.
- **OAuth 401 / "token request failed"** — credentials wrong, or you created a *public* client instead of a *confidential* one. Re-create at https://www.warcraftlogs.com/api/clients/.
- **Tool returns `isError: true` with `"kind": "rate_limit"`** — wait for `rateLimit.pointsResetIn` seconds before retrying. Don't loop on 429s.
- **"report not found" / GraphQL errors** — the `reportCode` is wrong, the report has been deleted, or it's **private and you haven't authorized user access**. Run `npm run auth:status`, or call `wcl_get_rate_limit` and check `authMode`. If it says `client`, see [Private log access](#private-log-access). Otherwise try the same code on the WCL website to confirm it exists.
- **`npm run auth` fails with "invalid redirect uri"** — the URI registered on your WCL client doesn't match `WCL_REDIRECT_URI` (default `http://localhost:4477/callback`) character for character. Trailing slashes and port numbers both count.
- **`npm run auth` fails with "Port 4477 is already in use"** — something else holds the port. Free it, or set `WCL_REDIRECT_URI` to another port and register that exact URI on the WCL client too.
- **"Your Warcraft Logs user token has expired"** — re-run `npm run auth`. This only happens when WCL didn't issue a refresh token; otherwise renewal is automatic.
- **Private logs still not visible after `npm run auth`** — confirm `wcl_get_rate_limit` reports `authMode: "user"`. If it still says `client`, the MCP client is probably running the server as a different OS user (so `~/.wcl-mcp/token.json` resolves elsewhere); set `WCL_TOKEN_FILE` to an absolute path both can read.
- **Server silently hangs on startup** — that's normal. The server only logs to stderr (`wcl-mcp-server running on stdio`) and then blocks on stdin. It's waiting for an MCP client to speak JSON-RPC to it.

## Project layout

```
src/
  index.ts          — MCP server wiring, tool registration, arg validation
  auth.ts           — OAuth2 (client-credentials + user token refresh), token caching
  authorize.ts      — `npm run auth` — one-time interactive authorization-code flow
  tokenStore.ts     — 0600 on-disk persistence for the user token
  client.ts         — GraphQL transport, endpoint routing, error normalization, rate-limit parsing
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
