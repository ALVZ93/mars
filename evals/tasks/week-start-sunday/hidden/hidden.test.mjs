import test from "node:test";
import assert from "node:assert/strict";
import { startOfWeek } from "../src/week.js";

const iso = value => startOfWeek(new Date(value)).toISOString();
test("sunday belongs to the previous monday", () => assert.equal(iso("2026-10-25T23:30:00Z"), "2026-10-19T00:00:00.000Z"));
test("saturday", () => assert.equal(iso("2026-10-24T08:00:00Z"), "2026-10-19T00:00:00.000Z"));
test("monday", () => assert.equal(iso("2026-10-26T00:00:00Z"), "2026-10-26T00:00:00.000Z"));
test("across a month boundary", () => assert.equal(iso("2026-11-01T12:00:00Z"), "2026-10-26T00:00:00.000Z"));
