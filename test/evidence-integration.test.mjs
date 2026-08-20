import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { invalidateToken } from "../dist/auth.js";
import {
  clearEvidenceCache,
  withEvidenceTelemetry,
} from "../dist/evidenceCache.js";
import { invalidateReportCache } from "../dist/reportCache.js";
import { err } from "../dist/toolResult.js";
import { getEvents } from "../dist/tools/getEvents.js";
import { getFightContext } from "../dist/tools/getFightContext.js";
import { getFightOverview } from "../dist/tools/getFightOverview.js";
import { getRateLimit } from "../dist/tools/getRateLimit.js";
import { getTable } from "../dist/tools/getTable.js";
import { runGraphQL } from "../dist/tools/graphql.js";
import { rankDamageTakenByAbility } from "../dist/tools/rankDamageTakenByAbility.js";

const originalFetch = globalThis.fetch;

function installMockWcl() {
  const calls = new Map();
  let contextError = null;
  process.env.WCL_CLIENT_ID = "test-client";
  process.env.WCL_CLIENT_SECRET = "test-secret";
  process.env.WCL_TOKEN_FILE = path.resolve("test", "missing-token.json");
  invalidateToken();
  invalidateReportCache();
  clearEvidenceCache();

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/oauth/token")) {
      return Response.json({
        access_token: "test-token",
        expires_in: 3600,
        token_type: "bearer",
      });
    }

    const body = JSON.parse(String(init.body));
    const query = body.query;
    const variables = body.variables ?? {};
    const operation = classify(query);
    calls.set(operation, (calls.get(operation) ?? 0) + 1);

    if (operation === "context" && contextError) {
      return Response.json(contextError);
    }
    return Response.json({ data: responseData(operation, variables) });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
      invalidateToken();
      invalidateReportCache();
      clearEvidenceCache();
    },
    setContextError(value) {
      contextError = value;
    },
  };
}

function classify(query) {
  if (query.includes("FightContext")) return "context";
  if (query.includes("AbilityDamageMasterData")) return "master";
  if (query.includes("phaseTransitions")) return "report";
  if (query.includes("events(")) return "events";
  if (query.includes("table(")) return "table";
  if (query.includes("rateLimitData")) return "rateLimit";
  return "raw";
}

function responseData(operation, variables) {
  const rateLimitData = {
    limitPerHour: 3600,
    pointsResetIn: 100,
    pointsSpentThisHour: 10,
  };
  if (operation === "report") {
    return {
      rateLimitData,
      reportData: {
        report: {
          code: variables.code,
          title: "Test report",
          startTime: 0,
          endTime: 60_000,
          fights: [fight(), fight(2, 80_000, 120_000)],
        },
      },
    };
  }
  if (operation === "context") {
    return {
      rateLimitData,
      reportData: {
        report: {
          code: variables.code,
          title: "Test report",
          fights: [fight(variables.fightIDs?.[0] ?? 1)],
          masterData: {
            actors: [
              {
                gameID: 100,
                id: 1,
                name: "Player",
                server: "Realm",
                subType: "Warrior",
                type: "Player",
              },
            ],
          },
          playerDetails: { data: { playerDetails: {} } },
        },
      },
    };
  }
  if (operation === "table") {
    return {
      rateLimitData,
      reportData: { report: { table: { data: { entries: [] } } } },
    };
  }
  if (operation === "events") {
    return {
      rateLimitData,
      reportData: {
        report: { events: { data: [], nextPageTimestamp: null } },
      },
    };
  }
  if (operation === "master") {
    return {
      rateLimitData,
      reportData: {
        report: {
          masterData: {
            abilities: [{ gameID: 42, name: "Test Quill" }],
            actors: [
              { id: 1, name: "Player", subType: "Warrior", type: "Player" },
            ],
          },
        },
      },
    };
  }
  if (operation === "rateLimit") return { rateLimitData };
  return { echo: variables };
}

function fight(id = 1, startTime = 10_000, endTime = 60_000) {
  return {
    averageItemLevel: 500,
    bossPercentage: null,
    difficulty: 5,
    encounterID: 99,
    endTime,
    fightPercentage: null,
    friendlyItemLevels: [500],
    friendlyPlayers: [1],
    friendlySpecs: ["Arms"],
    id,
    kill: true,
    lastPhase: null,
    lastPhaseAsAbsoluteIndex: null,
    lastPhaseIsIntermission: null,
    name: "Boss",
    phaseTransitions: null,
    size: 20,
    startTime,
  };
}

test("overview and later composite/primitive paths reuse matching evidence exactly", async () => {
  const mock = installMockWcl();
  try {
    await getFightOverview({ fightID: 1, reportCode: "R" });
    assert.equal(mock.calls.get("report"), 1);
    assert.equal(mock.calls.get("context"), 1);
    assert.equal(mock.calls.get("table"), 6);

    await Promise.all(
      ["interrupts", "deaths", "dispels"].map((view) =>
        getTable({ fightID: 1, reportCode: "R", view }),
      ),
    );
    assert.equal(mock.calls.get("table"), 6);

    await rankDamageTakenByAbility({
      abilityNames: ["Test Quill"],
      fightID: 1,
      reportCode: "R",
    });
    assert.equal(mock.calls.get("context"), 1, "composite context is reused");
    assert.equal(mock.calls.get("events"), 1);
    assert.equal(
      mock.calls.get("master"),
      1,
      "uncached composite-only query still runs",
    );
  } finally {
    mock.restore();
  }
});

test("primitive keys separate every accepted option and normalize effective defaults", async () => {
  const mock = installMockWcl();
  try {
    await getFightContext({ fightID: 1, reportCode: "R" });
    await getFightContext({
      fightID: 1,
      includeCombatantInfo: false,
      reportCode: "R",
    });
    await getFightContext({
      fightID: 1,
      includeCombatantInfo: true,
      reportCode: "R",
    });
    await getFightContext({ fightID: 2, reportCode: "R" });
    await getFightContext({ fightID: 1, reportCode: "R2" });
    assert.equal(mock.calls.get("context"), 4);

    const baseTable = { fightID: 1, reportCode: "R", view: "damage-done" };
    await getTable(baseTable);
    await getTable({ ...baseTable, refresh: false });
    await getTable({ ...baseTable, sourceID: 1 });
    await getTable({ ...baseTable, targetID: 2 });
    await getTable({ ...baseTable, abilityID: 3 });
    await getTable({ ...baseTable, view: "healing" });
    await getTable({ ...baseTable, fightID: 2 });
    await getTable({ ...baseTable, reportCode: "R2" });
    assert.equal(mock.calls.get("table"), 7);

    const baseEvents = { dataType: "Casts", fightID: 1, reportCode: "R" };
    await getEvents(baseEvents);
    await getEvents({
      ...baseEvents,
      limit: 10_000,
      maxPages: 3,
      refresh: false,
    });
    await getEvents({ ...baseEvents, sourceID: 1 });
    await getEvents({ ...baseEvents, targetID: 2 });
    await getEvents({ ...baseEvents, abilityID: 3 });
    await getEvents({ ...baseEvents, dataType: "Deaths" });
    await getEvents({ ...baseEvents, limit: 100 });
    await getEvents({ ...baseEvents, maxPages: 1 });
    await getEvents({ ...baseEvents, startTime: 1_000 });
    await getEvents({ ...baseEvents, endTime: 2_000 });
    await getEvents({ ...baseEvents, fightID: 2 });
    await getEvents({ ...baseEvents, reportCode: "R2" });
    assert.equal(mock.calls.get("events"), 11);
  } finally {
    mock.restore();
  }
});

test("refresh bypasses completed evidence and GraphQL errors including partial data are uncached", async () => {
  const mock = installMockWcl();
  try {
    const args = { fightID: 1, reportCode: "R" };
    await getFightContext(args);
    await getFightContext({ ...args, refresh: false });
    await getFightContext({ ...args, refresh: true });
    assert.equal(mock.calls.get("context"), 2);

    clearEvidenceCache();
    mock.setContextError({ errors: [{ message: "failed" }] });
    await assert.rejects(getFightContext(args), /WCL GraphQL errors: failed/);
    await assert.rejects(getFightContext(args), /WCL GraphQL errors: failed/);
    assert.equal(mock.calls.get("context"), 4);

    mock.setContextError({
      data: responseData("context", { code: "R" }),
      errors: [{ message: "partial" }],
    });
    await assert.rejects(getFightContext(args), /WCL GraphQL errors: partial/);
    await assert.rejects(getFightContext(args), /WCL GraphQL errors: partial/);
    assert.equal(mock.calls.get("context"), 6);
  } finally {
    mock.restore();
  }
});

test("GraphQL failures report decoded bytes and duration once for the actual load", async () => {
  const mock = installMockWcl();
  const envelope = { errors: [{ message: "failed" }] };
  try {
    mock.setContextError(envelope);
    const result = await withEvidenceTelemetry(async () => {
      try {
        await getFightContext({ fightID: 1, reportCode: "R" });
        throw new Error("expected GraphQL failure");
      } catch (error) {
        return err(error.message);
      }
    });
    const events = result._meta?.["raidlens/cache"]?.events;
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "load_error");
    assert.equal(
      events[0].decodedBytes,
      Buffer.byteLength(JSON.stringify(envelope)),
    );
    assert.ok(Number.isFinite(events[0].durationMs));
    assert.ok(events[0].durationMs >= 0);
  } finally {
    mock.restore();
  }
});

test("raw GraphQL and rate-limit tools remain outside evidence caching", async () => {
  const mock = installMockWcl();
  try {
    await runGraphQL({ query: "query Raw { raw }" });
    await runGraphQL({ query: "query Raw { raw }" });
    assert.equal(mock.calls.get("raw"), 2);

    await getRateLimit();
    await getRateLimit();
    assert.equal(mock.calls.get("rateLimit"), 2);
  } finally {
    mock.restore();
  }
});
