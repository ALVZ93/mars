import test from "node:test";
import assert from "node:assert/strict";
import { paginate, pageCount } from "../src/paginate.js";

test("rejects invalid page", () => assert.throws(() => paginate([1], 0, 1), RangeError));
test("rejects invalid size", () => assert.throws(() => paginate([1], 1, 0), RangeError));
test("counts pages", () => assert.equal(pageCount(5, 2), 3));
