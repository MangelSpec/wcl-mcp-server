import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  canonicalJson,
  clearEvidenceCache,
  EvidenceCache,
  EVIDENCE_CACHE_LIMITS,
  EVIDENCE_TTLS,
  loadEvidence,
  parseEvidenceCacheLimits,
  withEvidenceTelemetry,
} from "../dist/evidenceCache.js";
import { installEvidenceCacheLifecycle } from "../dist/lifecycle.js";
import { ok } from "../dist/toolResult.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function cache(overrides = {}) {
  return new EvidenceCache({
    maxBytes: 10_000,
    maxEntries: 3,
    maxEntryBytes: 5_000,
    maxInflight: 2,
    ...overrides,
  });
}

test("publishes the exact Step 5 bounds and TTLs", () => {
  assert.deepEqual(EVIDENCE_CACHE_LIMITS, {
    maxBytes: 33_554_432,
    maxEntries: 128,
    maxEntryBytes: 4_194_304,
    maxInflight: 32,
  });
  assert.deepEqual(EVIDENCE_TTLS, {
    context: 60_000,
    events: 30_000,
    table: 60_000,
  });
});

test("loads bounded evidence cache settings from optional environment values", () => {
  assert.deepEqual(parseEvidenceCacheLimits({}), EVIDENCE_CACHE_LIMITS);
  assert.deepEqual(
    parseEvidenceCacheLimits({
      WCL_EVIDENCE_CACHE_MAX_BYTES: " 1000 ",
      WCL_EVIDENCE_CACHE_MAX_ENTRIES: "7",
      WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES: "500",
    }),
    {
      maxBytes: 1_000,
      maxEntries: 7,
      maxEntryBytes: 500,
      maxInflight: 32,
    },
  );
  assert.deepEqual(
    parseEvidenceCacheLimits({
      WCL_EVIDENCE_CACHE_MAX_BYTES: "1073741824",
      WCL_EVIDENCE_CACHE_MAX_ENTRIES: "1024",
      WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES: "1073741824",
    }),
    {
      maxBytes: 1_073_741_824,
      maxEntries: 1_024,
      maxEntryBytes: 1_073_741_824,
      maxInflight: 32,
    },
  );
});

test("rejects unsafe evidence cache environment values", () => {
  for (const [name, value] of [
    ["WCL_EVIDENCE_CACHE_MAX_ENTRIES", "0"],
    ["WCL_EVIDENCE_CACHE_MAX_ENTRIES", "1025"],
    ["WCL_EVIDENCE_CACHE_MAX_BYTES", "1073741825"],
    ["WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES", "1.5"],
    ["WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES", "01"],
    ["WCL_EVIDENCE_CACHE_MAX_ENTRY_BYTES", "1e3"],
  ]) {
    assert.throws(() => parseEvidenceCacheLimits({ [name]: value }));
  }
});

test("canonical keys sort objects, preserve arrays, omit undefined, and reject unsupported JSON", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, x: undefined }, list: [2, 1] }),
    '{"a":{"y":2},"list":[2,1],"z":1}',
  );
  assert.notEqual(
    canonicalJson({ list: [1, 2] }),
    canonicalJson({ list: [2, 1] }),
  );
  assert.equal(canonicalJson(Number.NaN), null);
  assert.equal(canonicalJson(1n), null);
  assert.equal(canonicalJson(new Date()), null);
  assert.equal(canonicalJson([, 1]), null);
  assert.equal(canonicalJson({ [Symbol("key")]: 1 }), null);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(canonicalJson(cyclic), null);
});

test("reuses sequential and concurrent loads and clones every returned value", async () => {
  const subject = cache();
  const pending = deferred();
  let calls = 0;
  const options = {
    key: { reportCode: "R", fightID: 1 },
    operation: "context",
    loader: async () => {
      calls++;
      return pending.promise;
    },
  };
  const first = subject.load(options);
  const second = subject.load(options);
  pending.resolve({ nested: { value: 1 } });
  const [left, right] = await Promise.all([first, second]);
  left.nested.value = 9;
  assert.equal(right.nested.value, 1);
  const third = await subject.load(options);
  assert.equal(third.nested.value, 1);
  assert.equal(calls, 1);
});

test("applies strict expiry and refresh while coalescing concurrent refreshes", async () => {
  let now = 100;
  const subject = cache({ now: () => now });
  let calls = 0;
  const base = {
    key: { id: 1 },
    operation: "events",
    ttlMs: 30,
    loader: async () => ({ call: ++calls }),
  };
  assert.equal((await subject.load(base)).call, 1);
  now = 129;
  assert.equal((await subject.load(base)).call, 1);
  now = 130;
  assert.equal((await subject.load(base)).call, 2);

  const pending = deferred();
  const refreshed = {
    ...base,
    refresh: true,
    loader: async () => {
      calls++;
      return pending.promise;
    },
  };
  const first = subject.load(refreshed);
  const second = subject.load(refreshed);
  const normal = subject.load({ ...refreshed, refresh: false });
  pending.resolve({ call: calls });
  assert.deepEqual(await Promise.all([first, second, normal]), [
    { call: 3 },
    { call: 3 },
    { call: 3 },
  ]);
  assert.equal(calls, 3);
});

test("clock rollback cannot extend an existing absolute expiry", async () => {
  let now = 100;
  const subject = cache({ now: () => now });
  let calls = 0;
  const options = {
    key: { id: 1 },
    operation: "events",
    ttlMs: 30,
    loader: async () => ({ call: ++calls }),
  };
  await subject.load(options);
  now = 120;
  await subject.load(options);
  now = 50;
  await subject.load(options);
  now = 130;
  assert.equal((await subject.load(options)).call, 2);
});

test("enforces exact key-plus-value byte, per-entry, total-byte, count, and true-LRU bounds", async () => {
  const key = canonicalJson({ id: "a" });
  const value = JSON.stringify({ payload: "1234" });
  const exactBytes = Buffer.byteLength(key) + Buffer.byteLength(value);
  const exact = cache({
    maxBytes: exactBytes,
    maxEntryBytes: exactBytes,
    maxEntries: 1,
  });
  let calls = 0;
  const load = (id, payload = "1234") =>
    exact.load({
      key: { id },
      operation: "table",
      loader: async () => ({ payload, call: ++calls }),
    });

  const exactValueJson = JSON.stringify({ payload: "1234", call: 1 });
  const exactValueBytes =
    Buffer.byteLength(key) + Buffer.byteLength(exactValueJson);
  const accepted = cache({
    maxBytes: exactValueBytes,
    maxEntryBytes: exactValueBytes,
    maxEntries: 1,
  });
  await accepted.load({
    key: { id: "a" },
    operation: "table",
    loader: async () => ({ payload: "1234", call: 1 }),
  });
  assert.equal(accepted.snapshot().bytes, exactValueBytes);

  await load("a", "payload-too-large");
  await load("a", "payload-too-large");
  assert.equal(calls, 2, "oversize results are returned but not retained");

  const lru = cache({ maxEntries: 2 });
  const counts = new Map();
  const get = (id) =>
    lru
      .load({
        key: { id },
        operation: "table",
        loader: async () => ({ id, call: (counts.get(id) ?? 0) + 1 }),
      })
      .then((result) => {
        counts.set(id, result.call);
        return result;
      });
  await get("a");
  await get("b");
  await get("a");
  await get("c");
  await get("b");
  assert.equal(counts.get("a"), 1);
  assert.equal(
    counts.get("b"),
    2,
    "completed hit moved a ahead of b in LRU order",
  );

  const weighted = cache({ maxBytes: 55, maxEntries: 10, maxEntryBytes: 55 });
  await weighted.load({
    key: { id: "a" },
    operation: "table",
    loader: async () => ({ value: "123456" }),
  });
  await weighted.load({
    key: { id: "b" },
    operation: "table",
    loader: async () => ({ value: "123456" }),
  });
  assert.equal(
    weighted.snapshot().entries,
    1,
    "total retained bytes evict the oldest entry",
  );

  const replacement = cache({
    maxBytes: 1_000,
    maxEntries: 2,
    maxEntryBytes: 100,
  });
  await replacement.load({
    key: { id: "same" },
    operation: "table",
    loader: async () => ({ value: "small" }),
  });
  const before = replacement.snapshot().bytes;
  await replacement.load({
    key: { id: "same" },
    operation: "table",
    refresh: true,
    loader: async () => ({ value: "larger-value" }),
  });
  assert.ok(replacement.snapshot().bytes > before);
  await replacement.load({
    key: { id: "same" },
    operation: "table",
    refresh: true,
    loader: async () => ({ value: "x".repeat(200) }),
  });
  assert.equal(
    replacement.snapshot().entries,
    0,
    "oversize replacement does not preserve its predecessor",
  );
});

test("bounds distinct inflight keys while identical keys still join", async () => {
  const subject = cache({ maxInflight: 1 });
  const pending = deferred();
  let sharedCalls = 0;
  let bypassCalls = 0;
  const shared = {
    key: { id: "shared" },
    operation: "context",
    loader: async () => {
      sharedCalls++;
      return pending.promise;
    },
  };
  const first = subject.load(shared);
  const joined = subject.load(shared);
  const bypass = await subject.load({
    key: { id: "distinct" },
    operation: "context",
    loader: async () => ({ call: ++bypassCalls }),
  });
  pending.resolve({ call: sharedCalls });
  assert.deepEqual(await Promise.all([first, joined]), [
    { call: 1 },
    { call: 1 },
  ]);
  assert.equal(bypass.call, 1);
  assert.equal(sharedCalls, 1);
  assert.equal(subject.snapshot().entries, 1);
});

test("caller abort detaches without cancelling a shared load", async () => {
  const subject = cache();
  const pending = deferred();
  let sourceAborted = false;
  const caller = new AbortController();
  const options = {
    key: { id: 1 },
    operation: "events",
    loader: async (signal) => {
      signal.addEventListener("abort", () => (sourceAborted = true));
      return pending.promise;
    },
  };
  const detached = subject.load({ ...options, signal: caller.signal });
  const joined = subject.load(options);
  caller.abort();
  await assert.rejects(detached, { name: "AbortError" });
  assert.equal(sourceAborted, false);
  pending.resolve({ ok: true });
  assert.deepEqual(await joined, { ok: true });
  assert.deepEqual(await subject.load(options), { ok: true });
});

test("a load may finish and populate after all waiters abort", async () => {
  const subject = cache();
  const pending = deferred();
  let calls = 0;
  const firstCaller = new AbortController();
  const secondCaller = new AbortController();
  const options = {
    key: { id: 1 },
    operation: "events",
    loader: async () => {
      calls++;
      return pending.promise;
    },
  };
  const first = subject.load({ ...options, signal: firstCaller.signal });
  const second = subject.load({ ...options, signal: secondCaller.signal });
  firstCaller.abort();
  secondCaller.abort();
  await Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  pending.resolve({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await subject.load(options), { ok: true });
  assert.equal(calls, 1);
});

test("shutdown aborts owned loads, prevents insertion, and clears retained bytes", async () => {
  const subject = cache();
  let sourceAborted = false;
  const pending = subject.load({
    key: { id: 1 },
    operation: "events",
    loader: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sourceAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  subject.shutdown();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(sourceAborted, true);
  assert.deepEqual(subject.snapshot(), {
    bytes: 0,
    entries: 0,
    inflight: 0,
    shutdown: true,
  });
});

test("shutdown rejects in-flight and later loads without running later loaders", async () => {
  const subject = cache();
  const pending = deferred();
  let calls = 0;
  const inFlight = subject.load({
    key: { id: "in-flight" },
    operation: "events",
    loader: async () => {
      calls++;
      return pending.promise;
    },
  });

  subject.shutdown();
  await assert.rejects(inFlight, { name: "AbortError" });
  await assert.rejects(
    subject.load({
      key: { id: "after-shutdown" },
      operation: "events",
      loader: async () => {
        calls++;
        return { ok: true };
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
  pending.resolve({ ok: true });
});

test("lifecycle hooks shut down on signals and normal exit without using process", () => {
  class FakeProcess extends EventEmitter {
    exitCode = null;

    exit(code) {
      this.exitCode = code;
    }
  }

  for (const [event, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["beforeExit", null],
    ["exit", null],
  ]) {
    const target = new FakeProcess();
    let shutdowns = 0;
    const remove = installEvidenceCacheLifecycle(target, () => shutdowns++);
    target.emit(event, 0);
    assert.equal(shutdowns, 1);
    assert.equal(target.exitCode, exitCode);
    remove();
  }
});

test("errors, unsupported results, and oversize results are never cached", async () => {
  const events = [];
  const subject = cache({
    maxEntryBytes: 30,
    observer: (event) => events.push(event),
  });
  let errors = 0;
  const failed = {
    key: { id: "error" },
    operation: "context",
    loader: async () => {
      errors++;
      throw new Error("upstream");
    },
  };
  await assert.rejects(subject.load(failed), /upstream/);
  await assert.rejects(subject.load(failed), /upstream/);
  assert.equal(errors, 2);

  let unsupported = 0;
  const unsupportedLoad = {
    key: { id: "unsupported" },
    operation: "context",
    loader: async () => ({ value: () => ++unsupported }),
  };
  await subject.load(unsupportedLoad);
  await subject.load(unsupportedLoad);
  assert.equal(subject.snapshot().entries, 0);

  let oversize = 0;
  const large = {
    key: { id: "large" },
    operation: "context",
    loader: async () => ({ call: ++oversize, payload: "x".repeat(100) }),
  };
  await subject.load(large);
  await subject.load(large);
  assert.equal(oversize, 2);
  assert.ok(events.some((event) => event.outcome === "load_error"));
  assert.ok(events.some((event) => event.outcome === "bypass"));
  assert.ok(events.some((event) => event.outcome === "skip_oversize"));
});

test("folds eviction into one caller outcome", async () => {
  const events = [];
  const subject = cache({
    maxEntries: 1,
    observer: (event) => events.push(event),
  });
  for (const id of ["a", "b"]) {
    await subject.load({
      key: { id },
      operation: "table",
      loader: async () => ({ id }),
    });
  }
  assert.deepEqual(
    events.map((event) => event.outcome),
    ["miss", "evicted"],
  );
});

test("reports failed actual-load metrics once across coalesced callers", async () => {
  const events = [];
  const subject = cache({ observer: (event) => events.push(event) });
  const pending = deferred();
  const options = {
    key: { id: "failure" },
    operation: "context",
    loader: async (_signal, observeUpstream) => {
      observeUpstream({ decodedBytes: 123, durationMs: 7 });
      await pending.promise;
      throw new Error("upstream");
    },
  };
  const first = subject.load(options);
  const joined = subject.load(options);
  pending.resolve();
  await Promise.all([
    assert.rejects(first, /upstream/),
    assert.rejects(joined, /upstream/),
  ]);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.outcome === "load_error"));
  assert.equal(
    events.filter((event) => Object.hasOwn(event, "decodedBytes")).length,
    1,
  );
  assert.deepEqual(
    events.filter((event) => event.decodedBytes !== undefined),
    [
      {
        cache: "evidence",
        decodedBytes: 123,
        durationMs: 7,
        operation: "context",
        outcome: "load_error",
        source: "wcl",
      },
    ],
  );
});

test("observer failures do not affect cache behavior and warn only once", async () => {
  const original = console.error;
  let warnings = 0;
  console.error = () => warnings++;
  try {
    const subject = cache({
      observer: () => {
        throw new Error("observer");
      },
    });
    const options = {
      key: { id: 1 },
      operation: "table",
      loader: async () => ({ ok: true }),
    };
    assert.deepEqual(await subject.load(options), { ok: true });
    assert.deepEqual(await subject.load(options), { ok: true });
    assert.equal(warnings, 1);
  } finally {
    console.error = original;
  }
});

test("successful tool results attach cache telemetry only in non-model-visible metadata", async () => {
  clearEvidenceCache();
  const result = await withEvidenceTelemetry(async () => {
    const options = {
      key: { fightID: 1, operation: "context", reportCode: "R" },
      operation: "context",
      loader: async () => ({ reportCode: "R" }),
    };
    await loadEvidence(options);
    const data = await loadEvidence(options);
    return ok(data);
  });
  assert.deepEqual(result.structuredContent, { reportCode: "R" });
  assert.equal("_meta" in result.structuredContent, false);
  const events = result._meta?.["raidlens/cache"]?.events;
  assert.deepEqual(
    events.map(({ operation, outcome, source }) => ({
      operation,
      outcome,
      source,
    })),
    [
      { operation: "context", outcome: "miss", source: "wcl" },
      { operation: "context", outcome: "hit", source: "wcl" },
    ],
  );
  assert.ok(events.every((event) => !JSON.stringify(event).includes("R")));
  clearEvidenceCache();
});
