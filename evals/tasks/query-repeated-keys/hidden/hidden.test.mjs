import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery } from "../src/query.js";

const plain = value => ({ ...value });

test("reported case", () => assert.deepEqual(parseQuery("?tags=a&tags=b").tags, ["a", "b"]));
test("three repeats keep order", () => assert.deepEqual(parseQuery("t=a&t=b&t=c").t, ["a", "b", "c"]));
test("plus and percent escapes", () => {
  assert.equal(parseQuery("q=caf%C3%A9+con+leche").q, "café con leche");
  assert.equal(parseQuery("q=1%2B1").q, "1+1");
});
test("fragment is ignored", () => assert.deepEqual(plain(parseQuery("a=1#b=2")), { a: "1" }));
test("key without equals sign", () => assert.deepEqual(plain(parseQuery("flag&x=1")), { flag: "", x: "1" }));
test("value containing equals signs", () => assert.equal(parseQuery("token=a=b==").token, "a=b=="));
test("empty pairs and empty keys are skipped", () => assert.deepEqual(plain(parseQuery("a=1&&=2&b=")), { a: "1", b: "" }));
test("malformed escapes are kept", () => assert.deepEqual(plain(parseQuery("q=100%&x=%41&y=%E0%A4+z")), { q: "100%", x: "A", y: "%E0%A4 z" }));
test("no prototype", () => {
  const query = parseQuery("__proto__=x&constructor=y");
  assert.equal(Object.getPrototypeOf(query), null);
  assert.equal(query.__proto__, "x");
  assert.equal(query.constructor, "y");
  assert.equal(({}).x, undefined);
});
