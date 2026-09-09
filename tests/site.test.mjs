import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/site/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../apps/site/styles.css', import.meta.url), 'utf8');

test('MARS landing shell includes the first editorial sections', () => {
  for (const id of ['product', 'install', 'how-it-works']) assert.ok(html.includes('id="' + id + '"'));
  for (const asset of ['mars-planet-halftone.svg', 'mars-bust-halftone.svg']) assert.ok(html.includes(asset));
  assert.ok(html.includes('Many models.<br><em>One system.</em>'));
});

test('MARS landing styles keep the bone, red, serif and mono system', () => {
  for (const token of ['#B51E16', '#8B1E16', '#F7F2EB', '--font-display', '--font-mono', '--paper-line']) {
    assert.ok(css.includes(token), 'missing design token: ' + token);
  }
  assert.ok(css.includes('prefers-reduced-motion'));
  assert.ok(css.includes('border-radius: 2px'));
});
