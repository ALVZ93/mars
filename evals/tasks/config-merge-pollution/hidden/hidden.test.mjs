import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../src/merge.js";

test("JSON __proto__ does not pollute Object.prototype", () => {
  deepMerge({}, JSON.parse('{"__proto__": {"isAdmin": true}}'));
  assert.equal({}.isAdmin, undefined);
});
test("constructor.prototype does not pollute", () => {
  deepMerge({}, JSON.parse('{"constructor": {"prototype": {"polluted": 1}}}'));
  assert.equal({}.polluted, undefined);
});
test("normal merging still works", () => {
  assert.deepEqual(deepMerge({ a: { b: 1 }, l: [1] }, { a: { c: 2 }, l: [2], s: "x" }), { a: { b: 1, c: 2 }, l: [2], s: "x" });
});
test("does not mutate sources", () => { const a = { n: { v: 1 } }; deepMerge(a, { n: { w: 2 } }); assert.deepEqual(a, { n: { v: 1 } }); });
