import test from 'node:test';
import assert from 'node:assert/strict';
import { Permissions } from '../dist/packages/runtime/src/index.js';

test('session shell permission avoids repeated prompts without granting network or destructive commands', async () => {
  let prompts = 0;
  const permissions = new Permissions('ask', async () => { prompts++; return true; }, { network: 'deny', destructiveShell: 'deny' });
  const signal = new AbortController().signal;
  await permissions.checkShell('python -c "print(1)"', process.cwd(), signal);
  permissions.shell = 'allow';
  await permissions.checkShell('python -c "print(2)"', process.cwd(), signal);
  await permissions.checkShell('python -c "print(3)"', process.cwd(), signal);
  assert.equal(prompts, 1);
  await assert.rejects(permissions.checkShell('curl https://example.com', process.cwd(), signal), /denied/);
  await assert.rejects(permissions.checkShell('rm -rf assets', process.cwd(), signal), /denied/);
  permissions.shell = 'ask';
  await permissions.checkShell('python -c "print(4)"', process.cwd(), signal);
  assert.equal(prompts, 2);
});
