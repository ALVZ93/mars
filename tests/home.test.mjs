import test from 'node:test';
import assert from 'node:assert/strict';
import { homeFrame } from '../dist/apps/cli/src/home.js';

test('welcome layout stays inside terminal bounds and sanitizes external labels', () => {
  for (const [width, height] of [[120, 40], [80, 24], [24, 12]]) {
    const frame = homeFrame(width, height, 'fake:scripted', 'C:/project\x1b[2J', 'hello');
    const positions = [...frame.matchAll(/\x1b\[(\d+);(\d+)H/g)];
    for (const [, row, column] of positions) {
      assert.ok(Number(row) <= height);
      assert.ok(Number(column) <= width);
    }
    assert.equal(frame.match(/\x1b\[2J/g).length, 1);
    assert.match(frame, /hello/);
    assert.match(frame, /MARS 0.1/);
  }
  assert.doesNotMatch(homeFrame(80, 24, 'fake:scripted', '/', '', false), /38;2/);
});
