/**
 * Smoke test: spawn the built MCP server and exercise every tool against a
 * real WCL report. Prints concise summaries rather than full JSON dumps.
 *
 * Run:  node smoke-test.mjs
 *
 * Env:  WCL_CLIENT_ID, WCL_CLIENT_SECRET must be set in .env
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, ".env") });

const TEST_REPORT_CODE = "cqKLtMJC2abXhzNY";
const serverPath = path.join(__dirname, "dist", "index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buffer = "";
const pending = new Map();
let nextId = 1;

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
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else {
      console.error("[unsolicited]", msg);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
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

  const firstKill = fights.find((f) => f.kill === true);
  if (!firstKill) {
    throw new Error("No kills found in this report — can't run table smoke test");
  }
  console.error(`\n-> chose fight #${firstKill.id} "${firstKill.name}" for table/player tests`);

  // ---- wcl_get_player_info ----
  section(`wcl_get_player_info — report ${TEST_REPORT_CODE}`);
  const playerInfo = await callTool("wcl_get_player_info", {
    reportCode: TEST_REPORT_CODE,
  });
  console.error(`log owner: ${playerInfo.logOwner ?? "(unknown)"}`);
  console.error(`actors: ${playerInfo.actors.length}`);
  for (const a of playerInfo.actors.slice(0, 5)) {
    console.error(`  [${a.id}] ${a.name} (${a.subType} ${a.type})`);
  }
  if (playerInfo.actors.length > 5) {
    console.error(`  ... and ${playerInfo.actors.length - 5} more`);
  }

  // ---- wcl_get_table damage-done ----
  section(`wcl_get_table — damage-done, fight ${firstKill.id}`);
  const tableResult = await callTool("wcl_get_table", {
    reportCode: TEST_REPORT_CODE,
    fightID: firstKill.id,
    view: "damage-done",
  });
  const tbl = tableResult.table;
  // WCL wraps the data under `data.entries` for most views
  const entries = tbl?.data?.entries ?? [];
  console.error(`entries: ${entries.length}`);
  // Top 5 by total
  const top = [...entries].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 5);
  for (const e of top) {
    const totalM = ((e.total ?? 0) / 1e6).toFixed(1);
    console.error(`  ${e.name.padEnd(18)} ${totalM.padStart(8)}M  (${e.type})`);
  }
  if (entries.length > 5) {
    console.error(`  ... and ${entries.length - 5} more`);
  }

  // ---- wcl_get_rate_limit (after) ----
  section("wcl_get_rate_limit — after");
  const rlAfter = await callTool("wcl_get_rate_limit");
  console.error(rlAfter);
  console.error(
    `\npoints used by smoke test: ${
      rlAfter.pointsSpentThisHour - rlBefore.pointsSpentThisHour
    }`,
  );

  console.error("\n✅ Smoke test passed — all four tools work end-to-end");
  child.stdin.end();
  setTimeout(() => process.exit(0), 500);
} catch (err) {
  console.error("\n❌ Smoke test failed:", err.message ?? err);
  if (err.stack) console.error(err.stack);
  child.kill();
  process.exit(1);
}
