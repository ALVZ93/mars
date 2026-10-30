import test from "node:test";
import assert from "node:assert/strict";
import { formatEuros, formatPrice, toCents } from "../src/money.js";

test("whole and simple amounts", () => {
  assert.equal(toCents(1.5), 150);
  assert.equal(toCents(2), 200);
});
test("formatting", () => {
  assert.equal(formatEuros(150), "1,50 €");
  assert.equal(formatPrice(2), "2,00 €");
});
test("rejects non-numbers", () => assert.throws(() => toCents(Number.NaN), TypeError));
