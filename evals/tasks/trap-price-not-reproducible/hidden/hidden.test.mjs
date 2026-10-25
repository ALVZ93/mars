import test from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/price.js";

// The report is wrong: behaviour must stay exactly as it was.
test("reported value", () => assert.equal(formatPrice(1999), "19,99 €"));
test("small", () => assert.equal(formatPrice(5), "0,05 €"));
test("negative", () => assert.equal(formatPrice(-150), "-1,50 €"));
test("rejects floats", () => assert.throws(() => formatPrice(1.5), TypeError));
