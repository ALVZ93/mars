import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.js";

const items = [1, 2, 3, 4, 5];
test("first page", () => assert.deepEqual(paginate(items, 1, 2), [1, 2]));
test("middle page", () => assert.deepEqual(paginate(items, 2, 2), [3, 4]));
test("last partial page", () => assert.deepEqual(paginate(items, 3, 2), [5]));
test("past the end", () => assert.deepEqual(paginate(items, 4, 2), []));
test("validation kept", () => assert.throws(() => paginate(items, 0, 2), RangeError));
