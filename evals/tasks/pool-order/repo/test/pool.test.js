import test from "node:test";
import assert from "node:assert/strict";
import { runPool } from "../src/pool.js";

test("runs every task", async () => {
  const results = await runPool([async () => 1, async () => 2, async () => 3], 2);
  assert.deepEqual([...results].sort(), [1, 2, 3]);
});
test("rejects an invalid limit", async () => {
  await assert.rejects(runPool([], 0), RangeError);
});
