import test from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/lru.js";

test("stores values", () => { const c = new LruCache(2); c.set("a", 1); assert.equal(c.get("a"), 1); });
test("evicts the oldest when full", () => { const c = new LruCache(1); c.set("a", 1).set("b", 2); assert.equal(c.has("a"), false); });
