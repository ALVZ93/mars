import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "../src/query.js";

test("simple pairs", () => {
  const query = parseQuery("a=1&b=2");
  assert.equal(query.a, "1");
  assert.equal(query.b, "2");
});
test("leading question mark and escapes", () => assert.equal(parseQuery("?x=hello%20world").x, "hello world"));
