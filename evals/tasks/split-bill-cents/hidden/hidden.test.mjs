import test from "node:test";
import assert from "node:assert/strict";
import { splitCents } from "../src/split.js";

const sum = values => values.reduce((a, b) => a + b, 0);
test("reported case", () => assert.deepEqual(splitCents(10000, 3), [3334, 3333, 3333]));
test("sums are exact for many amounts and parts", () => {
  for (let amount = 0; amount <= 2000; amount += 7) for (let parts = 1; parts <= 12; parts++) {
    const shares = splitCents(amount, parts);
    assert.equal(shares.length, parts); assert.equal(sum(shares), amount, `${amount}/${parts}`);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, `${amount}/${parts}`);
    assert.deepEqual(shares, [...shares].sort((a, b) => b - a), `${amount}/${parts} larger first`);
  }
});
test("rounding up would overshoot", () => assert.equal(sum(splitCents(20000, 3)), 20000));
test("zero", () => assert.deepEqual(splitCents(0, 2), [0, 0]));
test("validation kept", () => assert.throws(() => splitCents(1.5, 2), RangeError));
