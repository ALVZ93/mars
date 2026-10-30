import test from "node:test";
import assert from "node:assert/strict";
import { debounce } from "../src/debounce.js";

const recorder = () => {
  const calls = [];
  const fn = function (...args) { calls.push({ self: this, args }); return args[0]; };
  return { calls, fn };
};

test("reported case", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const save = debounce(fn, 100, { leading: true, trailing: true });
  save("click");
  t.mock.timers.tick(250);
  assert.equal(calls.length, 1);
});

test("leading and trailing: start and last call of a burst", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const save = debounce(fn, 100, { leading: true, trailing: true });
  save(1); save(2); save(3);
  t.mock.timers.tick(100);
  assert.deepEqual(calls.map(call => call.args[0]), [1, 3]);
  save(4);
  t.mock.timers.tick(100);
  assert.deepEqual(calls.map(call => call.args[0]), [1, 3, 4]);
});

test("a burst lasts while calls keep coming", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const save = debounce(fn, 100);
  save(1); t.mock.timers.tick(80); save(2); t.mock.timers.tick(80); save(3); t.mock.timers.tick(99);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(calls.map(call => call.args[0]), [3]);
});

test("trailing call keeps this of the last call", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const first = { name: "first" }, last = { name: "last" };
  const save = debounce(fn, 100);
  save.call(first, 1); save.call(last, 2);
  t.mock.timers.tick(100);
  assert.equal(calls[0].self, last);
});

test("returns the latest result", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { fn } = recorder();
  const save = debounce(fn, 100, { leading: true });
  assert.equal(save("a"), "a");
  assert.equal(save("b"), "a");
  t.mock.timers.tick(100);
  assert.equal(save("c"), "c");
});

test("flush runs the pending call now with its this and returns its result", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const self = { name: "form" };
  const save = debounce(fn, 100);
  save.call(self, "x");
  assert.equal(save.flush(), "x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, self);
  t.mock.timers.tick(200);
  assert.equal(calls.length, 1);
});

test("flush with nothing pending does not call fn", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const save = debounce(fn, 100, { leading: true, trailing: true });
  save("only");
  assert.equal(save.flush(), "only");
  assert.equal(calls.length, 1);
});

test("cancel drops the trailing call and starts a new burst next time", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, fn } = recorder();
  const save = debounce(fn, 100, { leading: true, trailing: true });
  save(1); save(2);
  save.cancel();
  t.mock.timers.tick(200);
  assert.deepEqual(calls.map(call => call.args[0]), [1]);
  save(3);
  assert.deepEqual(calls.map(call => call.args[0]), [1, 3]);
});
