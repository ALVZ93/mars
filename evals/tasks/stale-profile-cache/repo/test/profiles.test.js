import test from "node:test";
import assert from "node:assert/strict";
import { profileTitle } from "../src/format.js";
import { resetStore, saveUser } from "../src/store.js";

test("title shows name and role", () => {
  resetStore();
  saveUser({ id: 1, name: "Ana", role: "admin" });
  assert.equal(profileTitle(1), "Ana (admin)");
});
test("unknown users", () => {
  resetStore();
  assert.equal(profileTitle(99), "Unknown user");
});
