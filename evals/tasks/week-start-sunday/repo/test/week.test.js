import test from "node:test";
import assert from "node:assert/strict";
import { startOfWeek } from "../src/week.js";

test("wednesday", () => assert.equal(startOfWeek(new Date("2026-10-21T15:00:00Z")).toISOString(), "2026-10-19T00:00:00.000Z"));
test("monday", () => assert.equal(startOfWeek(new Date("2026-10-19T00:00:00Z")).toISOString(), "2026-10-19T00:00:00.000Z"));
