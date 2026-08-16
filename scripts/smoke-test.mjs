/**
 * Live smoke test: spawn the built MCP server and exercise the six core tools
 * against a real WCL report. Prints concise summaries rather than full
 * JSON dumps.
 *
 * Run:  node scripts/smoke-test.mjs
 *
 * Env:  WCL_CLIENT_ID, WCL_CLIENT_SECRET must be set in .env (repo root)
 *
 * NOTE: This is the existing live-smoke script — NOT a substitute for a
 * proper record/replay harness. It hits the real API and burns rate-limit
 * points. Keep the point budget small. See the dev doc's Testing (TODO)
 * section for plans on a proper fixture-backed test suite.
 */

import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
config({ path: path.join(repoRoot, ".env") });

const TEST_REPORT_CODE = "cqKLtMJC2abXhzNY";
const serverPath = path.join(repoRoot, "dist", "index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buffer = "";
const pending = new Map();
let nextId = 1;

const REQUEST_TIMEOUT_MS = 60_000;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("[non-JSON line]", line);
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    } else {
      console.error("[unsolicited]", msg);
    }
  }
});

// If the child dies mid-request (crash, missing env, bad import), the pending
// promise would hang forever without this. Reject everything in flight so the
// smoke test exits loudly instead of wedging.
child.on("exit", (code, signal) => {
  if (pending.size === 0) return;
  const reason = new Error(
    `MCP server child process exited unexpectedly (code=${code}, signal=${signal}) with ${pending.size} request(s) in flight`,
  );
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(reason);
  }
  pending.clear();
});

child.on("error", (err) => {
  const reason = new Error(`MCP server child process error: ${err.message}`);
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(reason);
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`Request ${id} (${method}) timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function callTool(name, args = {}) {
  const res = await request("tools/call", { name, arguments: args });
  if (res.error) {
    throw new Error(`${name} failed: ${JSON.stringify(res.error)}`);
  }
  if (res.result?.isError) {
    throw new Error(`${name} returned isError: ${res.result.content?.[0]?.text}`);
  }
  const text = res.result?.content?.[0]?.text;
  if (!text) throw new Error(`${name} returned no text content`);
  return JSON.parse(text);
}

function section(title) {
  console.error("\n" + "=".repeat(60));
  console.error(title);
  console.error("=".repeat(60));
}

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  notify("notifications/initialized");

  // ---- tools/list ----
  section("tools/list");
  const list = await request("tools/list", {});
  const tools = list.result.tools;
  console.error(`registered: ${tools.map((t) => t.name).join(", ")}`);

  // ---- wcl_get_rate_limit (baseline) ----
  section("wcl_get_rate_limit — baseline");
  const rlBefore = await callTool("wcl_get_rate_limit");
  console.error(rlBefore);

  // ---- wcl_graphql — introspection of EventDataType + TableDataType ----
  // Free ground-truth for the enum values we hardcode elsewhere. Catches
  // drift the moment the schema changes. Very cheap (no report data).
  section("wcl_graphql — introspect EventDataType + TableDataType");
  const introspection = await callTool("wcl_graphql", {
    query: `{
      event: __type(name: "EventDataType") { enumValues { name } }
      table: __type(name: "TableDataType") { enumValues { name } }
    }`,
  });
  if (introspection.errors?.length) {
    throw new Error(`introspection returned errors: ${JSON.stringify(introspection.errors)}`);
  }
  const eventEnum = introspection.data?.event?.enumValues?.map((v) => v.name) ?? [];
  const tableEnum = introspection.data?.table?.enumValues?.map((v) => v.name) ?? [];
  console.error(`EventDataType values (${eventEnum.length}): ${eventEnum.join(", ")}`);
  console.error(`TableDataType values (${tableEnum.length}): ${tableEnum.join(", ")}`);

  // Compare against what getEvents.ts and getTable.ts expect. Both modules
  // are imported from dist/ so the test is checking the actual source-of-
  // truth constants, not a hand-copied duplicate — drift can't hide.
  const { EVENT_DATA_TYPES } = await import(
    pathToFileURL(path.join(repoRoot, "dist", "tools", "getEvents.js")).href,
  );
  const { VIEW_TO_DATA_TYPE } = await import(
    pathToFileURL(path.join(repoRoot, "dist", "tools", "getTable.js")).href,
  );
  const missingFromEventEnum = EVENT_DATA_TYPES.filter((v) => !eventEnum.includes(v));
  if (missingFromEventEnum.length > 0) {
    console.error(
      `⚠  getEvents.ts lists EventDataType values WCL doesn't recognize: ${missingFromEventEnum.join(", ")}`,
    );
  }

  const tableMismatches = Object.entries(VIEW_TO_DATA_TYPE).filter(
    ([, dt]) => !tableEnum.includes(dt),
  );
  if (tableMismatches.length > 0) {
    console.error(
      `⚠  getTable.ts VIEW_TO_DATA_TYPE has values WCL doesn't recognize: ${tableMismatches
        .map(([v, dt]) => `${v}→${dt}`)
        .join(", ")}`,
    );
  } else {
    console.error(
      `✔  all ${Object.keys(VIEW_TO_DATA_TYPE).length} TableDataType values in getTable.ts verified`,
    );
  }

  // ---- wcl_get_fights ----
  section(`wcl_get_fights — report ${TEST_REPORT_CODE}`);
  const fightsResult = await callTool("wcl_get_fights", {
    reportCode: TEST_REPORT_CODE,
    killType: "Encounters",
  });
  const { report, fights } = fightsResult;
  console.error(`report: "${report.title}" (${new Date(report.startTime).toISOString()})`);
  console.error(`boss fights: ${fights.length}`);
  for (const f of fights) {
    const outcome = f.kill ? "KILL" : `wipe @ ${f.bossPercentage ?? "?"}%`;
    const dur = ((f.endTime - f.startTime) / 1000).toFixed(0);
    console.error(`  [${f.id}] ${f.name} — ${outcome} (${dur}s, size ${f.size})`);
  }

  const kills = fights.filter((f) => f.kill === true);
  if (kills.length === 0) {
    throw new Error("No kills found in this report — can't run table smoke test");
  }
  const firstKill = kills[0];
  // Prefer the second kill if it exists (per dev doc test report has two Chimaerus kills).
  const eventsFight = kills[1] ?? firstKill;
  console.error(
    `\n-> chose fight #${firstKill.id} "${firstKill.name}" for table/player tests`,
  );
  console.error(
    `-> chose fight #${eventsFight.id} "${eventsFight.name}" for events test`,
  );

  // ---- wcl_get_player_info ----
  section(`wcl_get_player_info — report ${TEST_REPORT_CODE}`);
  const playerInfo = await callTool("wcl_get_player_info", {
    reportCode: TEST_REPORT_CODE,
  });
  console.error(`log owner: ${playerInfo.logOwner ?? "(unknown)"}`);
  console.error(`actors: ${playerInfo.actors.length}`);
  const withSpec = playerInfo.actors.filter((a) => a.spec != null);
  console.error(`  with spec resolved: ${withSpec.length}/${playerInfo.actors.length}`);
  for (const a of playerInfo.actors.slice(0, 5)) {
    const spec = a.spec ?? "?";
    const role = a.role ?? "?";
    console.error(`  [${a.id}] ${a.name} — ${spec} ${a.subType} (${role})`);
  }
  if (playerInfo.actors.length > 5) {
    console.error(`  ... and ${playerInfo.actors.length - 5} more`);
  }
  if (withSpec.length === 0) {
    console.error("⚠  no specs were resolved — playerDetails shape may have drifted");
  }

  // ---- wcl_analyze_fight_set ----
  section(`wcl_analyze_fight_set — ${kills.length} kills`);
  const fightSetResult = await callTool("wcl_analyze_fight_set", {
    reportCode: TEST_REPORT_CODE,
    fightIDs: kills.map((fight) => fight.id),
    views: ["damage-done", "deaths"],
    maxRows: 10,
  });
  console.error(
    `fights: ${fightSetResult.scope.fightCount}, sections: ${fightSetResult.sections.length}`,
  );
  for (const aggregate of fightSetResult.sections) {
    console.error(
      `  ${aggregate.view}: ${aggregate.rows.length}/${aggregate.totalRows} rows${aggregate.truncated ? " (truncated)" : ""}`,
    );
  }
  if (fightSetResult.scope.fightCount !== kills.length) {
    throw new Error("fight-set result did not include every selected fight");
  }
  if (fightSetResult.sections.length !== 2) {
    throw new Error("fight-set result did not include every requested view");
  }

  // ---- wcl_get_table damage-done ----
  section(`wcl_get_table — damage-done, fight ${firstKill.id}`);
  const tableResult = await callTool("wcl_get_table", {
    reportCode: TEST_REPORT_CODE,
    fightID: firstKill.id,
    view: "damage-done",
  });
  const tbl = tableResult.table;
  const entries = tbl?.data?.entries ?? [];
  console.error(`entries: ${entries.length}`);
  const top = [...entries].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 5);
  for (const e of top) {
    const totalM = ((e.total ?? 0) / 1e6).toFixed(1);
    console.error(`  ${e.name.padEnd(18)} ${totalM.padStart(8)}M  (${e.type})`);
  }
  if (entries.length > 5) {
    console.error(`  ... and ${entries.length - 5} more`);
  }

  // ---- wcl_get_table healing ----
  section(`wcl_get_table — healing, fight ${firstKill.id}`);
  const healingResult = await callTool("wcl_get_table", {
    reportCode: TEST_REPORT_CODE,
    fightID: firstKill.id,
    view: "healing",
  });
  const healEntries = healingResult.table?.data?.entries ?? [];
  console.error(`entries: ${healEntries.length}`);
  const topHeal = [...healEntries].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 3);
  for (const e of topHeal) {
    const totalM = ((e.total ?? 0) / 1e6).toFixed(1);
    console.error(`  ${e.name.padEnd(18)} ${totalM.padStart(8)}M  (${e.type})`);
  }

  // ---- wcl_get_table deaths ----
  section(`wcl_get_table — deaths, fight ${firstKill.id}`);
  const deathsResult = await callTool("wcl_get_table", {
    reportCode: TEST_REPORT_CODE,
    fightID: firstKill.id,
    view: "deaths",
  });
  const deathEntries = deathsResult.table?.data?.entries ?? [];
  console.error(`death entries: ${deathEntries.length}`);
  for (const d of deathEntries.slice(0, 3)) {
    console.error(`  ${d.name ?? "?"} @ ${d.deathTime ?? "?"}ms`);
  }

  // ---- wcl_get_events damage on fight #2 ----
  section(`wcl_get_events — DamageDone, fight ${eventsFight.id}`);
  const eventsResult = await callTool("wcl_get_events", {
    reportCode: TEST_REPORT_CODE,
    fightID: eventsFight.id,
    dataType: "DamageDone",
  });
  console.error(
    `events: ${eventsResult.events.length}  pages: ${eventsResult.pagesReturned}  truncated: ${eventsResult.truncated}`,
  );
  if (eventsResult.truncated) {
    console.error(`  nextPageTimestamp: ${eventsResult.nextPageTimestamp}`);
  }
  if (eventsResult.events.length > 0) {
    console.error("  first event:");
    console.error("    " + JSON.stringify(eventsResult.events[0]));
  }

  // ---- wcl_get_rate_limit (after) ----
  section("wcl_get_rate_limit — after");
  const rlAfter = await callTool("wcl_get_rate_limit");
  console.error(rlAfter);
  const pointsUsed = rlAfter.pointsSpentThisHour - rlBefore.pointsSpentThisHour;
  console.error(`\npoints used by smoke test: ${pointsUsed}`);
  if (pointsUsed > 35) {
    console.error(`⚠  point budget exceeded (expected <=35, used ${pointsUsed})`);
  }

  console.error("\n✅ Smoke test passed — core tools work end-to-end");
  child.stdin.end();
  setTimeout(() => process.exit(0), 500);
} catch (err) {
  console.error("\n❌ Smoke test failed:", err.message ?? err);
  if (err.stack) console.error(err.stack);
  child.kill();
  process.exit(1);
}
