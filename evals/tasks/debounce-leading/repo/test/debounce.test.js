import test from "node:test";
import assert from "node:assert/strict";
import { debounce } from "../src/debounce.js";

test("trailing call with the last arguments", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const save = debounce(value => calls.push(value), 100);
  save(1); save(2); save(3);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(100);
  assert.deepEqual(calls, [3]);
});

test("leading only calls at the start", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const save = debounce(value => calls.push(value), 100, { leading: true, trailing: false });
  save(1); save(2);
  t.mock.timers.tick(100);
  assert.deepEqual(calls, [1]);
});
