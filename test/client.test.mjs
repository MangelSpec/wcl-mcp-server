import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRequestTimeoutMs } from "../dist/client.js";

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
