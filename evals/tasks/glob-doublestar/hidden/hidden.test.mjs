import test from "node:test";
import assert from "node:assert/strict";
import { matchGlob } from "../src/glob.js";

test("reported case", () => assert.equal(matchGlob("src/**/*.js", "src/index.js"), true));
test("double star segments", () => {
  assert.equal(matchGlob("src/**/*.js", "src/a/b/c.js"), true);
  assert.equal(matchGlob("src/**/*.js", "lib/a.js"), false);
  assert.equal(matchGlob("**/x.js", "x.js"), true);
  assert.equal(matchGlob("**/x.js", "a/b/x.js"), true);
  assert.equal(matchGlob("a/**/b", "a/b"), true);
  assert.equal(matchGlob("a/**/b", "a/x/y/b"), true);
  assert.equal(matchGlob("a/**/b", "a/xb"), false);
});
test("double star inside a segment is a single star", () => {
  assert.equal(matchGlob("a**b", "axxb"), true);
  assert.equal(matchGlob("a**b", "a/b"), false);
});
test("star and question mark never cross a slash", () => {
  assert.equal(matchGlob("*.js", "a/b.js"), false);
  assert.equal(matchGlob("a?b", "a/b"), false);
  assert.equal(matchGlob("a?b", "axb"), true);
});
test("other characters are literal", () => {
  assert.equal(matchGlob("file.js", "fileXjs"), false);
  assert.equal(matchGlob("a+b(1).txt", "a+b(1).txt"), true);
  assert.equal(matchGlob("a+b(1).txt", "aab1.txt"), false);
  assert.equal(matchGlob("$HOME/x", "$HOME/x"), true);
});
test("character classes", () => {
  assert.equal(matchGlob("[abc].txt", "b.txt"), true);
  assert.equal(matchGlob("[abc].txt", "d.txt"), false);
  assert.equal(matchGlob("[a-c]x", "bx"), true);
  assert.equal(matchGlob("[!abc].txt", "d.txt"), true);
  assert.equal(matchGlob("[!abc].txt", "a.txt"), false);
  assert.equal(matchGlob("a[!x]b", "a/b"), false);
});
test("escapes", () => {
  assert.equal(matchGlob("\\*.txt", "*.txt"), true);
  assert.equal(matchGlob("\\*.txt", "a.txt"), false);
});
