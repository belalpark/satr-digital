// Two deployments from one source:
//   satr     — the site as it is (client identity, header link, footer with contacts, build badge)
//   neutral  — no broker: every block between <!-- brand:start --> and <!-- brand:end --> is removed
//              from the HTML, and office.brand / office.footer are dropped from the data, so the
//              shipped files carry no company name, logo, contact number or link at all.
//
//   node tools/variant.mjs --variant neutral --out dist-hosting/neutral   → <out>/public_html + public_html.zip
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Anything that would identify the broker in the neutral build. */
export const BRAND_TERMS = /سطر|SATR|satr|555855057|55 585 5057|544171356|54 417 1356|wa\.me/;

export function neutralHtml(html) {
  return html.replace(/[ \t]*<!-- brand:start -->[\s\S]*?<!-- brand:end -->[ \t]*\n?/g, '');
}

export function neutralData(data) {
  const d = structuredClone(data);
  delete d.office.brand;
  delete d.office.footer;
  return d;
}

const HTACCESS = `Options -Indexes
AddDefaultCharset utf-8
AddType model/gltf-binary .glb
AddType image/webp .webp
AddType application/json .json
AddType text/javascript .mjs .js
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/javascript application/javascript application/json model/gltf-binary image/svg+xml
</IfModule>
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/webp "access plus 30 days"
  ExpiresByType image/png "access plus 30 days"
  ExpiresByType image/jpeg "access plus 30 days"
  ExpiresByType model/gltf-binary "access plus 7 days"
  ExpiresByType text/css "access plus 1 day"
  ExpiresByType text/javascript "access plus 1 day"
  ExpiresByType application/javascript "access plus 1 day"
  ExpiresByType application/json "access plus 5 minutes"
  ExpiresByType text/html "access plus 5 minutes"
</IfModule>
<IfModule mod_headers.c>
  Header set X-Content-Type-Options "nosniff"
  Header set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
`;

export function build(variant, out, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  if (!['satr', 'neutral'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const site = resolve(out, 'public_html');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(site, { recursive: true });
  for (const p of ['assets', 'media']) cpSync(resolve(root, p), resolve(site, p), { recursive: true });
  mkdirSync(resolve(site, 'data'), { recursive: true });
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const data = JSON.parse(readFileSync(resolve(root, 'data/office.json'), 'utf8'));
  writeFileSync(resolve(site, 'index.html'), variant === 'neutral' ? neutralHtml(html) : html);
  writeFileSync(resolve(site, 'data/office.json'), JSON.stringify(variant === 'neutral' ? neutralData(data) : data, null, 2) + '\n');
  writeFileSync(resolve(site, '.htaccess'), HTACCESS);
  if (variant === 'satr') {
    let sha = 'dev';
    let branch = '';
    try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(); branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).toString().trim(); } catch { /* not a checkout */ }
    writeFileSync(resolve(site, 'build-info.json'), JSON.stringify({ sha, branch, builtAt: new Date().toISOString(), host: 'static' }) + '\n');
  }
  if (existsSync(resolve(out, 'public_html.zip'))) rmSync(resolve(out, 'public_html.zip'));
  execFileSync('zip', ['-qr', '../public_html.zip', '.'], { cwd: site });
  return site;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const variant = arg('--variant', 'satr');
  const out = resolve(arg('--out', `dist-hosting/${variant}`));
  const site = build(variant, out);
  console.log(`${variant}: ${site} (+ public_html.zip)`);
}
