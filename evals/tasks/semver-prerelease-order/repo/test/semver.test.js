import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../src/semver.js";

test("core versions", () => { assert.equal(compareVersions("1.2.3", "1.10.0"), -1); assert.equal(compareVersions("2.0.0", "2.0.0"), 0); });
test("release beats prerelease", () => assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1));
