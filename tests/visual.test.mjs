import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { MARS_ART, renderMarsFrame } from '../dist/apps/cli/src/visual.js';

test('MARS startup visual is red-capable ASCII with an extruded shadow', () => {
  const frame = renderMarsFrame(2);
  const plain = stripVTControlCharacters(frame);
  assert.equal(MARS_ART.length, 5);
  assert.match(plain, /MARS \/\/ INITIALIZING \[···  \]/);
  assert.ok(frame.includes('\u001b[91m'));
  assert.ok(plain.split('\n').length > MARS_ART.length);
});
