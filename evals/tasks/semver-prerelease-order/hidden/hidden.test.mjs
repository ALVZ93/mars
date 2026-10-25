import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/semver.js";

// Precedence example straight from semver.org, section 11.
const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
test("spec precedence chain", () => {
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++)
    assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
});
test("reported case", () => assert.equal(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2"), 1));
test("hyphens inside prerelease identifiers", () => assert.equal(compareVersions("1.0.0-x-y.1", "1.0.0-x-y.2"), -1));
test("build metadata ignored", () => assert.equal(compareVersions("1.0.0-rc.1+build.5", "1.0.0-rc.1+build.9"), 0));
test("core still numeric", () => assert.equal(compareVersions("1.10.0", "1.9.0"), 1));
