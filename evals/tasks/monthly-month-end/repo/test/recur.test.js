import test from "node:test";
import assert from "node:assert/strict";
import { monthlyDates } from "../src/recur.js";

test("mid-month dates", () => assert.deepEqual(monthlyDates("2026-03-15", 3), ["2026-03-15", "2026-04-15", "2026-05-15"]));
test("no occurrences", () => assert.deepEqual(monthlyDates("2026-03-15", 0), []));
