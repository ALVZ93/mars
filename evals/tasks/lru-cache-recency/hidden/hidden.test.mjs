import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/lru.js";

test("reading refreshes recency", () => {
  const c = new LruCache(2); c.set("a", 1).set("b", 2); c.get("a"); c.set("c", 3);
  assert.deepEqual([c.has("a"), c.has("b"), c.has("c")], [true, false, true]);
});
test("updating an existing key does not evict others", () => {
  const c = new LruCache(2); c.set("a", 1).set("b", 2).set("a", 10);
  assert.deepEqual([c.get("a"), c.get("b"), c.size], [10, 2, 2]);
});
test("updating refreshes recency", () => {
  const c = new LruCache(2); c.set("a", 1).set("b", 2).set("a", 3).set("c", 4);
  assert.deepEqual([c.has("a"), c.has("b")], [true, false]);
});
test("size never exceeds capacity nor drifts", () => {
  const c = new LruCache(3); for (let i = 0; i < 20; i++) c.set(i % 4, i);
  assert.equal(c.size, 3);
});
test("missing keys stay missing", () => { const c = new LruCache(1); assert.equal(c.get("x"), undefined); assert.equal(c.size, 0); });
