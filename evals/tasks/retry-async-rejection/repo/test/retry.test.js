import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("returns the value", async () => assert.equal(await retry(() => 42), 42));
test("retries sync throws", async () => {
  let calls = 0;
  assert.equal(await retry(() => { if (++calls < 2) throw new Error("x"); return "ok"; }), "ok");
});
