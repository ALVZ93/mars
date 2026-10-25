import test from "node:test";
import assert from "node:assert/strict";
import { withVat } from "../src/tax.js";

test("adds VAT", () => assert.equal(withVat(10000), 12100));
test("zero", () => assert.equal(withVat(0), 0));
