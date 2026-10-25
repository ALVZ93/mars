import test from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "../src/emitter.js";

test("once does not skip the next listener", () => {
  const e = new Emitter(); const calls = [];
  e.once("x", () => calls.push("once")); e.on("x", () => calls.push("on"));
  e.emit("x"); e.emit("x");
  assert.deepEqual(calls, ["once", "on", "on"]);
});
test("several once listeners in a row", () => {
  const e = new Emitter(); const calls = [];
  for (const name of ["a", "b", "c"]) e.once("x", () => calls.push(name));
  e.on("x", () => calls.push("d")); e.emit("x");
  assert.deepEqual(calls, ["a", "b", "c", "d"]); assert.equal(e.count("x"), 1);
});
test("listener removing another during emit: snapshot semantics", () => {
  const e = new Emitter(); const calls = []; let offB;
  e.on("x", () => { calls.push("a"); offB(); }); offB = e.on("x", () => calls.push("b"));
  e.emit("x"); e.emit("x");
  assert.deepEqual(calls, ["a", "b", "a"]);
});
test("listener added during emit runs from the next emit", () => {
  const e = new Emitter(); const calls = [];
  e.once("x", () => { calls.push("a"); e.on("x", () => calls.push("late")); });
  e.emit("x"); e.emit("x");
  assert.deepEqual(calls, ["a", "late"]);
});
