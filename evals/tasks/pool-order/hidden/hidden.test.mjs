import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { runPool } from "../src/pool.js";

const after = (ms, value) => async () => { await sleep(ms); return value; };

test("reported case", async () => {
  assert.deepEqual(await runPool([after(30, "a"), after(5, "b"), after(15, "c")], 3), ["a", "b", "c"]);
});
test("order kept with a small limit", async () => {
  assert.deepEqual(await runPool([after(20, 1), after(1, 2), after(10, 3), after(1, 4), after(5, 5)], 2), [1, 2, 3, 4, 5]);
});
test("never more than limit running", async () => {
  let running = 0, peak = 0;
  const task = async () => { running++; peak = Math.max(peak, running); await sleep(5); running--; return true; };
  await runPool(Array.from({ length: 8 }, () => task), 3);
  assert.equal(peak, 3);
});
test("a rejection rejects the pool and stops starting tasks", async () => {
  let started = 0;
  const spy = async () => { started++; return "late"; };
  const boom = new Error("boom");
  const tasks = [after(40, "slow"), async () => { await sleep(5); throw boom; }, spy, spy];
  await assert.rejects(runPool(tasks, 2), error => error === boom);
  await sleep(80);
  assert.equal(started, 0);
});
test("a synchronous throw is a rejection", async () => {
  const boom = new Error("sync");
  await assert.rejects(runPool([() => { throw boom; }], 1), error => error === boom);
});
test("empty list", async () => assert.deepEqual(await runPool([], 4), []));
test("fractional limit is rejected", async () => assert.rejects(runPool([async () => 1], 1.5), RangeError));
