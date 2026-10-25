import test from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/price.js";

test("zero", () => assert.equal(formatPrice(0), "0,00 €"));
