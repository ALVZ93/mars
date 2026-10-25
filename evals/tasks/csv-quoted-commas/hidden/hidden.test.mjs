import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "../src/csv.js";

test("comma inside quotes", () => assert.deepEqual(parseCsvLine('1,"García, Ana",Madrid'), ["1", "García, Ana", "Madrid"]));
test("doubled quotes", () => assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', "x"]));
test("quoted empty", () => assert.deepEqual(parseCsvLine('"",b'), ["", "b"]));
test("plain still works", () => assert.deepEqual(parseCsvLine("a,,c"), ["a", "", "c"]));
