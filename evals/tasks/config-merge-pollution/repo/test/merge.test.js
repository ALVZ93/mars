import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../src/merge.js";

test("nested merge", () => assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } }));
test("arrays replace", () => assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] }));
