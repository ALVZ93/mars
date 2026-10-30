import test from "node:test";
import assert from "node:assert/strict";
import { wrap } from "../src/wrap.js";

test("breaks between words", () => assert.equal(wrap("the quick brown fox", 10), "the quick\nbrown fox"));
test("short text stays on one line", () => assert.equal(wrap("a b", 10), "a b"));
