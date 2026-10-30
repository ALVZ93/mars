import test from "node:test";
import assert from "node:assert/strict";
import { wrap } from "../src/wrap.js";

test("reported case", () => assert.equal(wrap("👍🏽 👍🏽 👍🏽", 5), "👍🏽 👍🏽 👍🏽"));
test("emoji sequences count as one character", () => {
  assert.equal(wrap("👨‍👩‍👧 ab", 4), "👨‍👩‍👧 ab");
  assert.equal(wrap("🇪🇸 🇫🇷 🇮🇹", 5), "🇪🇸 🇫🇷 🇮🇹");
});
test("combining accents count as one character", () => {
  assert.equal(wrap("café olé", 8), "café olé");
  assert.equal(wrap("café olé", 7), "café\nolé");
});
test("long words are split into chunks", () => {
  assert.equal(wrap("abcdefghij", 4), "abcd\nefgh\nij");
  assert.equal(wrap("ab abcdefgh", 4), "ab\nabcd\nefgh");
  assert.equal(wrap("abcdefg xy", 4), "abcd\nefg\nxy");
});
test("long emoji words are split by character", () => assert.equal(wrap("👍🏽👍🏽👍🏽", 2), "👍🏽👍🏽\n👍🏽"));
test("paragraphs are wrapped on their own", () => {
  assert.equal(wrap("aa bb\ncc dd", 5), "aa bb\ncc dd");
  assert.equal(wrap("aa bb cc\ndd", 5), "aa bb\ncc\ndd");
});
test("plain ascii unchanged", () => assert.equal(wrap("the quick brown fox", 10), "the quick\nbrown fox"));
