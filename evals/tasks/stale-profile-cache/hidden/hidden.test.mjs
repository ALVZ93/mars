import test from "node:test";
import assert from "node:assert/strict";
import { profileTitle } from "../src/format.js";
import { getUser, renameUser, resetStore, saveUser } from "../src/store.js";

test("reported case", () => {
  resetStore();
  saveUser({ id: 1, name: "Ana", role: "admin" });
  assert.equal(profileTitle(1), "Ana (admin)");
  renameUser(1, "Ana María");
  assert.equal(profileTitle(1), "Ana María (admin)");
});
test("saving a user again replaces what readers see", () => {
  resetStore();
  saveUser({ id: 2, name: "Luis", role: "user" });
  assert.equal(getUser(2).role, "user");
  saveUser({ id: 2, name: "Luis", role: "admin" });
  assert.equal(getUser(2).role, "admin");
  assert.equal(profileTitle(2), "Luis (admin)");
});
test("a user saved after a failed lookup is found", () => {
  resetStore();
  assert.equal(getUser(3), undefined);
  assert.equal(profileTitle(3), "Unknown user");
  saveUser({ id: 3, name: "Eva", role: "user" });
  assert.equal(getUser(3)?.name, "Eva");
  assert.equal(profileTitle(3), "Eva (user)");
});
test("titles keep their format", () => {
  resetStore();
  saveUser({ id: 4, name: "Leo", role: "guest" });
  assert.equal(profileTitle(4), "Leo (guest)");
  assert.equal(profileTitle(404), "Unknown user");
});
