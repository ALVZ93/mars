import test from "node:test";
import assert from "node:assert/strict";
import { monthlyDates } from "../src/recur.js";

test("reported case", () => assert.deepEqual(monthlyDates("2026-01-31", 3), ["2026-01-31", "2026-02-28", "2026-03-31"]));
test("short months do not shift later ones", () => {
  assert.deepEqual(monthlyDates("2026-01-31", 6), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
});
test("leap years", () => {
  assert.deepEqual(monthlyDates("2024-01-31", 3), ["2024-01-31", "2024-02-29", "2024-03-31"]);
  assert.deepEqual(monthlyDates("2025-01-29", 3), ["2025-01-29", "2025-02-28", "2025-03-29"]);
});
test("day 30", () => assert.deepEqual(monthlyDates("2026-01-30", 3), ["2026-01-30", "2026-02-28", "2026-03-30"]));
test("across a year boundary", () => {
  assert.deepEqual(monthlyDates("2026-11-30", 4), ["2026-11-30", "2026-12-30", "2027-01-30", "2027-02-28"]);
  assert.deepEqual(monthlyDates("2026-12-31", 3), ["2026-12-31", "2027-01-31", "2027-02-28"]);
});
test("ordinary days", () => assert.deepEqual(monthlyDates("2026-03-15", 3), ["2026-03-15", "2026-04-15", "2026-05-15"]));
