import test from "node:test";
import assert from "node:assert/strict";
import { formatEuros, formatPrice, toCents } from "../src/money.js";

test("reported case", () => assert.equal(formatPrice(1.005), "1,01 €"));
test("halves that binary floats store just below", () => {
  for (const [amount, cents] of [[2.675, 268], [0.615, 62], [1.255, 126], [8.345, 835], [10.075, 1008], [1.015, 102]]) assert.equal(toCents(amount), cents, String(amount));
});
test("large amounts", () => assert.equal(toCents(12345678.905), 1234567891));
test("negative halves round away from zero", () => {
  assert.equal(toCents(-1.005), -101);
  assert.equal(toCents(-0.125), -13);
  assert.equal(toCents(-2.5), -250);
  assert.equal(formatEuros(toCents(-1.005)), "-1,01 €");
});
test("never -0", () => assert.ok(Object.is(toCents(-0.001), 0)));
test("below half stays down", () => {
  assert.equal(toCents(1.0049), 100);
  assert.equal(toCents(0.004), 0);
});
test("validation kept", () => assert.throws(() => toCents(Infinity), TypeError));
