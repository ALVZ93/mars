import test from "node:test";
import assert from "node:assert/strict";
import { VAT_RATE, withVat } from "../src/tax.js";

// The production code was right: the fix belongs in the outdated test, not in the rate.
test("rate stays at the current 21 %", () => assert.equal(VAT_RATE, 0.21));
test("amount with VAT", () => assert.equal(withVat(10000), 12100));
test("rounding", () => assert.equal(withVat(1), 1));
