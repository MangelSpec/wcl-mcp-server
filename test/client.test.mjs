import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { invalidateToken } from "../dist/auth.js";
import { executeGraphQL, parseRequestTimeoutMs } from "../dist/client.js";

const originalFetch = globalThis.fetch;

function installStalledBodyFetch() {
  let bodyCancelled = false;
  let responseReady;
  const ready = new Promise((resolve) => (responseReady = resolve));
  process.env.WCL_CLIENT_ID = "test-client";
  process.env.WCL_CLIENT_SECRET = "test-secret";
  process.env.WCL_REQUEST_TIMEOUT_MS = "5000";
  process.env.WCL_TOKEN_FILE = path.resolve("test", "missing-token.json");
  invalidateToken();

  globalThis.fetch = async (url) => {
    if (String(url).includes("/oauth/token")) {
      return Response.json({
        access_token: "test-token",
        expires_in: 3600,
        token_type: "bearer",
      });
    }
    const body = new ReadableStream({
      cancel() {
        bodyCancelled = true;
      },
    });
    responseReady();
    return new Response(body, { status: 200 });
  };

  return {
    bodyCancelled: () => bodyCancelled,
    ready,
    restore() {
      globalThis.fetch = originalFetch;
      delete process.env.WCL_REQUEST_TIMEOUT_MS;
      invalidateToken();
    },
  };
}

test("uses a 60-second request timeout by default", () => {
  assert.equal(parseRequestTimeoutMs(undefined), 60_000);
  assert.equal(parseRequestTimeoutMs(""), 60_000);
});

test("accepts bounded request timeout overrides", () => {
  assert.equal(parseRequestTimeoutMs("5000"), 5_000);
  assert.equal(parseRequestTimeoutMs(" 90000 "), 90_000);
  assert.equal(parseRequestTimeoutMs("180000"), 180_000);
});

test("rejects invalid request timeout overrides", () => {
  assert.throws(() => parseRequestTimeoutMs("slow"), /must be an integer/);
  assert.throws(() => parseRequestTimeoutMs("4999"), /between 5000 and 180000/);
  assert.throws(
    () => parseRequestTimeoutMs("180001"),
    /between 5000 and 180000/,
  );
});

test("keeps the deadline active after headers and cancels a stalled body", async () => {
  const mock = installStalledBodyFetch();
  try {
    const startedAt = performance.now();
    await assert.rejects(
      executeGraphQL("query Test { rateLimitData { limitPerHour } }"),
      /timed out after 5000ms/,
    );
    assert.ok(performance.now() - startedAt >= 4_900);
    assert.equal(mock.bodyCancelled(), true);
  } finally {
    mock.restore();
  }
});

test("relays caller abort after headers and cancels a stalled body", async () => {
  const mock = installStalledBodyFetch();
  const caller = new AbortController();
  try {
    const pending = executeGraphQL(
      "query Test { rateLimitData { limitPerHour } }",
      {},
      { signal: caller.signal },
    );
    await mock.ready;
    caller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(mock.bodyCancelled(), true);
  } finally {
    mock.restore();
  }
});
