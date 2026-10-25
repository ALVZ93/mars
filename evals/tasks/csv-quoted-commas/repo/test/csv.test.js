import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "../src/csv.js";

test("plain fields", () => assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]));
test("empty fields", () => assert.deepEqual(parseCsvLine("a,,c"), ["a", "", "c"]));
