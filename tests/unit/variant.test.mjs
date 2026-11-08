// The neutral (no-broker) deployment must not carry the company's name, logo, numbers or links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_TERMS, neutralHtml, neutralData } from '../../tools/variant.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

test('neutral HTML: brand blocks removed, the page structure kept', () => {
  const src = read('index.html');
  assert.match(src, BRAND_TERMS, 'the source (satr build) still carries the identity');
  const html = neutralHtml(src);
  assert.doesNotMatch(html, BRAND_TERMS, 'brand term left in the neutral HTML');
  for (const id of ['header-owner', 'app-footer', 'welcome-brand', 'welcome-slogan', 'build-sha']) assert.ok(!html.includes(`id="${id}"`), `${id} removed`);
  for (const id of ['welcome-title', 'welcome-location', 'welcome-facts', 'btn-start', 'btn-gallery', 'gallery-grid', 'plan2d-stage', 'room-card']) assert.ok(html.includes(`id="${id}"`), `${id} kept`);
  assert.ok(!html.includes('brand:start') && !html.includes('brand:end'), 'markers consumed');
});

test('neutral data: no brand or footer, no brand term anywhere', () => {
  const data = neutralData(JSON.parse(read('data/office.json')));
  assert.ok(!('brand' in data.office) && !('footer' in data.office));
  assert.doesNotMatch(JSON.stringify(data), BRAND_TERMS);
  assert.ok(data.office.welcome.facts.length >= 2, 'the opportunity figures stay');
});

test('shipped scripts and styles carry no brand term (they ship unchanged in both builds)', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(resolve(root, dir))) {
      const p = `${dir}/${name}`;
      if (statSync(resolve(root, p)).isDirectory()) { if (name !== 'vendor' && name !== 'fonts') walk(p); }
      else if (['.js', '.css', '.mjs'].includes(extname(name))) files.push(p);
    }
  };
  walk('assets');
  assert.ok(files.length >= 8);
  for (const f of files) assert.doesNotMatch(read(f), BRAND_TERMS, `brand term in ${f}`);
});
