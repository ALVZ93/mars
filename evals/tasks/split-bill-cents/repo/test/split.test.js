import test from "node:test";
import assert from "node:assert/strict";
import { splitCents } from "../src/split.js";

test("even split", () => assert.deepEqual(splitCents(900, 3), [300, 300, 300]));
test("validates parts", () => assert.throws(() => splitCents(100, 0), RangeError));
