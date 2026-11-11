// The hosting build: scripts/styles in a content-named folder (long cache), every reference resolving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../tools/variant.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

for (const variant of ['neutral', 'satr']) {
  test(`${variant} build: versioned assets, every page reference and module import resolves`, () => {
    const out = mkdtempSync(join(tmpdir(), `site-${variant}-`));
    try {
      const site = build(variant, out, root);
      const dirs = readdirSync(resolve(site, 'assets')).filter((d) => d.startsWith('r-'));
      assert.equal(dirs.length, 1, 'one release folder');
      for (const p of ['js', 'css', 'vendor']) assert.ok(!existsSync(resolve(site, 'assets', p)), `assets/${p} moved into the release folder`);
      const html = readFileSync(resolve(site, 'index.html'), 'utf8');
      const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
      assert.ok(refs.some((r) => r.includes(`assets/${dirs[0]}/js/app.js`)), 'the page loads the versioned app.js');
      for (const r of refs) assert.ok(existsSync(resolve(site, r)), `index.html → ${r} exists`);
      // relative imports between modules (static and dynamic)
      const jsDir = resolve(site, 'assets', dirs[0], 'js');
      for (const f of readdirSync(jsDir)) {
        const src = readFileSync(resolve(jsDir, f), 'utf8');
        for (const m of src.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) assert.ok(existsSync(resolve(jsDir, m[1])), `${f} → ${m[1]} exists`);
      }
      const css = readFileSync(resolve(site, 'assets', dirs[0], 'css', 'app.css'), 'utf8');
      const fonts = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
      assert.ok(fonts.length >= 4);
      for (const u of fonts) assert.ok(existsSync(resolve(site, 'assets', dirs[0], 'css', u)), `app.css → ${u} exists`);
      const ht = readFileSync(resolve(site, '.htaccess'), 'utf8');
      assert.match(ht, /text\/javascript "access plus 1 year"/);
      assert.match(ht, /text\/html "access plus 5 minutes"/);
      assert.ok(existsSync(resolve(out, 'public_html.zip')));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

test('the welcome photo starts loading from the HTML (it is the same file the data names)', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const data = JSON.parse(readFileSync(resolve(root, 'data/office.json'), 'utf8'));
  const m = html.match(/<img id="welcome-photo"[^>]*\bsrc="([^"]+)"/);
  assert.ok(m, 'welcome photo has a src in the HTML');
  assert.equal(m[1], data.office.heroImage);
});
