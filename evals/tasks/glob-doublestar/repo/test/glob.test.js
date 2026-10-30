import test from "node:test";
import assert from "node:assert/strict";
import { matchGlob } from "../src/glob.js";

test("star within a segment", () => {
  assert.equal(matchGlob("*.js", "index.js"), true);
  assert.equal(matchGlob("src/*/x.js", "src/a/x.js"), true);
});
test("question mark", () => assert.equal(matchGlob("a?c", "abc"), true));
test("double star across folders", () => assert.equal(matchGlob("src/**/*.js", "src/a/b/c.js"), true));
