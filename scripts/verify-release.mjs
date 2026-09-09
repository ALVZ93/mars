import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

assert.ok(tag, 'Provide a release tag or set GITHUB_REF_NAME.');
assert.equal(tag, `v${packageJson.version}`, `Release tag ${tag} does not match package version ${packageJson.version}.`);
console.log(`${tag} matches package.json.`);
