// brochure.html -> PDF, one 540x960 px page per section (9:16), backgrounds and links kept.
//   node tools/brochure/print_pdf.mjs <brochure.html> <out.pdf>
const pwMod = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chromium } = pwMod.default || pwMod;
const [src, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
await page.goto(`file://${src}`);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const over = await page.evaluate(() => [...document.querySelectorAll('.page')].map((p, i) => ({ i: i + 1, over: [...p.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); const b = p.getBoundingClientRect(); return r.width > 0 && (r.bottom > b.bottom + 0.5 || r.right > b.right + 0.5 || r.left < b.left - 0.5) && !e.closest('figure') && !e.classList.contains('bg'); }).map((e) => e.className || e.tagName).slice(0, 4) })).filter((p) => p.over.length));
console.log('elements outside their page:', JSON.stringify(over));
console.log('fonts:', await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`).join(', ')));
await page.pdf({ path: out, width: '540px', height: '960px', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true });
await browser.close();
console.log('written', out);
