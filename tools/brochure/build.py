"""Build the office brochure (Satr identity, 9:16 pages) as HTML; print_pdf.mjs turns it into the PDF.

    python3 tools/brochure/build.py <outDir> <model3d.jpg>      # then: node tools/brochure/print_pdf.mjs <outDir>/brochure.html <out.pdf>

Every word about the office comes from the site's data (data/office.json) and the film's content table:
names, the two owner figures, photo captions, feature phrases, phones and links. Nothing is added.
"""
import html
import json
import os
import sys

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = sys.argv[1]
MODEL = sys.argv[2]
ASSETS = os.path.join(OUT, 'assets')
os.makedirs(ASSETS, exist_ok=True)

office = json.load(open(os.path.join(REPO, 'data/office.json'), encoding='utf-8'))
content = json.load(open(os.path.join(REPO, 'tools', 'film', 'content.json'), encoding='utf-8'))
o = office['office']
rooms = {r['id']: r for r in office['rooms']}
w, brand, footer = o['welcome'], o['brand'], o['footer']
e = html.escape


def jpg(src, name, width, quality=84, crop=None):
    """A JPEG copy sized for the page: Chromium embeds JPEG as it is (WebP would be stored uncompressed)."""
    im = Image.open(src).convert('RGB')
    if crop:
        im = im.crop(crop)
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(os.path.join(ASSETS, name), 'JPEG', quality=quality, optimize=True, progressive=True)
    return 'assets/' + name


hero = jpg(os.path.join(REPO, 'media/hero/perspective.webp'), 'hero.jpg', 1200, 86)
plan2d = jpg(os.path.join(REPO, o['plan2d']['image']), 'plan2d.jpg', 1100, 86)
model = jpg(MODEL, 'model3d.jpg', 1400, 88)

pages = []
total = 3 + len(content['spaces'])


def foot(n):
    return f'<footer class="foot"><span>{e(brand["name"])}</span><span class="pn" dir="ltr">{n} / {total}</span></footer>'


# ---- 1. cover
facts = ''.join(
    f'<div class="fact"><div class="num"><b dir="ltr">{e(f["value"])}</b>{("<small>" + e(f["unit"]) + "</small>") if f.get("unit") else ""}</div><div class="lbl">{e(f["label"])}</div>{("<div class=note>" + e(f["note"]) + "</div>") if f.get("note") else ""}</div>'
    for f in w['facts'])
pages.append(f'''
<section class="page cover">
  <img class="bg" src="{hero}" alt="">
  <div class="shade"></div>
  <div class="cover-in">
    <div class="brandline"><strong>{e(brand["name"])}</strong><span dir="ltr">{e(brand["nameEn"])}</span></div>
    <div class="eyebrow"><i></i>{e(w["eyebrow"])}</div>
    <p class="lead">{e(w["headlineLead"])}</p>
    <h1>{e(w["location"].split("·")[0].strip())}</h1>
    <p class="city">{e(w["location"].split("·")[1].strip())}</p>
    <div class="facts">{facts}</div>
    <p class="sub">{e(w["subtitle"])}</p>
    <p class="atm">{e(w["atmosphere"])}</p>
  </div>
</section>''')

# ---- 2. the plan
shown = ['reception', 'lounge', 'bleachers', 'meeting-large', 'meeting-medium', 'women-area', 'data-center', 'store']
names = []
for rid in shown:
    nm = rooms[rid]['name']
    if nm not in names:
        names.append(nm)
meeting_count = sum(1 for r in office['rooms'] if r['kind'] == 'meeting')
names = [('غرفتا اجتماعات' if n == 'غرفة اجتماعات' and meeting_count == 2 else n) for n in names]
pages.append(f'''
<section class="page plan">
  <header class="head"><span class="k">{e(w["location"])}</span><h2>مخطط المكتب</h2></header>
  <figure class="model"><img src="{model}" alt=""></figure>
  <div class="plan-body">
    <div class="facts light">{facts}</div>
    <p class="also">يضم أيضًا</p>
    <ul class="tags">{''.join(f"<li>{e(n)}</li>" for n in names)}</ul>
    <div class="plan2"><img src="{plan2d}" alt=""><p>المخطط ثنائي الأبعاد والنموذج ثلاثي الأبعاد توضيحيان، مبنيان من مخطط الفرش المعتمد وصور الموقع.</p></div>
  </div>
  {foot(2)}
</section>''')

# ---- 3..14. the spaces
for k, sp in enumerate(content['spaces']):
    r = rooms[sp['id']]
    a, b = (r['photos'][n - 1] for n in sp['photos'])
    pa = jpg(os.path.join(REPO, a['src']), f'{sp["id"]}-a.jpg', 1200)
    pb = jpg(os.path.join(REPO, b['src']), f'{sp["id"]}-b.jpg', 1200)
    feats = ''.join(f'<li>{e(t)}</li>' for t in sp['features'])
    pages.append(f'''
<section class="page space">
  <figure class="pa"><img src="{pa}" alt=""><figcaption>{e(a["caption"])}</figcaption></figure>
  <div class="body">
    <span class="k">{e(w["location"])}</span>
    <h2>{e(r["name"])}</h2>
    <ul class="feat">{feats}</ul>
  </div>
  <figure class="pb"><img src="{pb}" alt=""><figcaption>{e(b["caption"])}</figcaption></figure>
  {foot(k + 3)}
</section>''')

# ---- last: contact
handles = ''.join(f'<a href="{e(s["href"])}">{e(s["label"])}</a>' for s in footer['social'])
phones = ''.join(f'<a class="phone" href="tel:{e(p["tel"])}"><small>{e(p["label"])}</small><b dir="ltr">{e(p["display"])}</b></a>' for p in reversed(footer['phones']))
wa = next((p['whatsapp'] for p in footer['phones'] if p.get('whatsapp')), None)
pages.append(f'''
<section class="page contact">
  <div class="frame"></div>
  <div class="contact-in">
    <h2>{e(brand["name"])}</h2>
    <p class="en" dir="ltr">{e(brand["nameEn"])}</p>
    <i class="rule"></i>
    <p class="slogan">{e(brand["slogan"])}</p>
    <p class="about">{e(footer["about"])}</p>
    <div class="phones">{phones}</div>
    {f'<a class="wa" href="{e(wa)}">واتساب</a>' if wa else ''}
    <a class="web" href="{e(footer["website"]["href"])}" dir="ltr">{e(footer["website"]["label"])}</a>
    <div class="social">{handles}</div>
    <p class="loc">{e(footer["location"])}</p>
    <p class="copy">{e(footer["copyright"])}</p>
  </div>
</section>''')

FONT = 'file://' + os.path.join(REPO, 'assets/fonts/IBMPlexSansArabic-%s.woff2')
css = '''
@font-face{font-family:Plex;font-weight:400;src:url("%(r)s") format("woff2")}
@font-face{font-family:Plex;font-weight:500;src:url("%(m)s") format("woff2")}
@font-face{font-family:Plex;font-weight:600;src:url("%(s)s") format("woff2")}
@font-face{font-family:Plex;font-weight:700;src:url("%(b)s") format("woff2")}
@page{size:540px 960px;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#051b30}
body{font-family:Plex,sans-serif;color:#fff;direction:rtl;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:540px;height:960px;position:relative;overflow:hidden;break-after:page;background:#051b30}
.page:last-child{break-after:auto}
img{display:block}
.k{color:#d8b466;font-size:12.5px;font-weight:500;letter-spacing:.02em}
.foot{position:absolute;inset:auto 0 0 0;height:38px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;font-size:11.5px;color:rgba(244,236,228,.7);border-top:1px solid rgba(216,180,102,.22)}
.foot .pn{font-variant-numeric:tabular-nums}
/* cover */
.cover .bg{position:absolute;inset:0;width:100%%;height:100%%;object-fit:cover;object-position:50%% 30%%}
.cover .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,27,48,.30) 0%%,rgba(5,27,48,.42) 26%%,rgba(5,27,48,.88) 50%%,#051b30 66%%)}
.cover-in{position:absolute;inset:auto 34px 46px 34px}
.brandline{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding-bottom:16px;margin-bottom:22px;border-bottom:1px solid rgba(216,180,102,.4)}
.brandline strong{font-size:24px;font-weight:700}
.brandline span{font-size:11px;letter-spacing:.42em;color:#d8b466;font-weight:500}
.eyebrow{display:flex;align-items:center;gap:12px;color:#d8b466;font-size:17px;font-weight:500;margin-bottom:10px}
.eyebrow i{width:38px;height:2px;background:#d8b466;display:block}
.lead{font-size:23px;font-weight:600}
.cover h1{font-size:50px;line-height:1.25;font-weight:700;color:#e3c47c;margin:2px 0 4px}
.city{font-size:16px;color:#f4ece4;margin-bottom:20px}
.facts{display:grid;grid-template-columns:1fr 1fr;border:1px solid rgba(216,180,102,.45);border-radius:18px;background:rgba(255,255,255,.04);margin-bottom:22px}
.fact{padding:16px 18px}
.fact+.fact{border-inline-start:1px solid rgba(216,180,102,.3)}
.fact .num{display:flex;align-items:baseline;gap:6px;color:#e3c47c}
.fact .num b{font-size:40px;font-weight:700;line-height:1.1}
.fact .num small{font-size:16px;font-weight:600}
.fact .lbl{font-size:15px;font-weight:600;margin-top:2px}
.fact .note{font-size:11.5px;color:rgba(244,236,228,.72);margin-top:2px}
.sub{font-size:26px;font-weight:700;color:#e3c47c}
.atm{font-size:15.5px;color:#f4ece4;margin-top:6px}
/* plan */
.head{padding:30px 30px 14px}
.head h2{font-size:34px;font-weight:700;color:#e3c47c;line-height:1.3}
.model{height:392px;background:#0b0f15;overflow:hidden}
.model img{width:100%%;height:100%%;object-fit:cover}
.plan-body{padding:18px 30px 0}
.facts.light{margin-bottom:14px}
.facts.light .fact{padding:10px 16px}
.facts.light .fact .num b{font-size:30px}
.facts.light .fact .note{display:none}
.also{font-size:13px;color:#d8b466;font-weight:600;margin-bottom:8px}
.tags{list-style:none;display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px}
.tags li{padding:5px 13px;border-radius:999px;border:1px solid rgba(216,180,102,.5);font-size:13px;background:rgba(255,255,255,.05)}
.plan2{display:grid;grid-template-columns:176px 1fr;gap:16px;align-items:center}
.plan2 img{width:176px;height:162px;object-fit:cover;border-radius:12px;border:1px solid rgba(216,180,102,.35)}
.plan2 p{font-size:11.5px;line-height:1.75;color:rgba(244,236,228,.75)}
/* a space */
.space figure{position:relative}
.space figure img{width:100%%;height:100%%;object-fit:cover}
.space figcaption{position:absolute;inset:auto 12px 10px auto;max-width:86%%;padding:4px 11px;border-radius:999px;background:rgba(5,27,48,.74);font-size:11.5px;color:#f4ece4}
.pa{height:360px}
.space .body{padding:20px 30px 16px}
.space h2{font-size:38px;font-weight:700;color:#e3c47c;line-height:1.3;margin:2px 0 10px}
.feat{list-style:none;display:grid;gap:7px}
.feat li{position:relative;padding-inline-start:20px;font-size:17.5px;font-weight:500}
.feat li::before{content:"";position:absolute;inset-inline-start:0;top:.62em;width:8px;height:8px;border-radius:50%%;background:#d8b466}
.pb{height:318px;margin:0 22px;border-radius:16px;overflow:hidden;border:1px solid rgba(216,180,102,.35)}
/* contact */
.contact{background:linear-gradient(180deg,#051b30,#0b2a47 46%%,#051b30)}
.contact .frame{position:absolute;inset:22px;border:1px solid rgba(216,180,102,.45);border-radius:20px}
.contact-in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 54px;gap:0}
.contact h2{font-size:52px;font-weight:700;line-height:1.3}
.contact .en{font-size:13px;letter-spacing:.44em;color:#d8b466;font-weight:500;margin-top:2px}
.contact .rule{display:block;width:70px;height:2px;background:#d8b466;margin:22px 0}
.slogan{font-size:19px;color:#f4ece4;font-weight:500}
.about{font-size:13px;line-height:1.8;color:rgba(244,236,228,.75);margin:12px 0 34px}
.phones{display:grid;gap:14px;margin-bottom:20px}
.phone{display:grid;gap:1px;color:#fff;text-decoration:none}
.phone small{font-size:13.5px;color:#d8b466;font-weight:600}
.phone b{font-size:30px;font-weight:600;letter-spacing:.01em}
.wa{display:inline-block;padding:9px 30px;border-radius:999px;background:linear-gradient(180deg,#e3c47c,#c9a14f);color:#051b30;font-weight:700;font-size:16px;text-decoration:none;margin-bottom:18px}
.web{color:#e3c47c;font-size:21px;font-weight:600;text-decoration:none}
.social{display:flex;gap:9px;flex-wrap:wrap;justify-content:center;margin:18px 0 30px}
.social a{padding:5px 14px;border-radius:999px;border:1px solid rgba(216,180,102,.5);color:#f4ece4;font-size:13px;text-decoration:none}
.loc{font-size:14px;color:#f4ece4}
.copy{font-size:11.5px;color:rgba(244,236,228,.6);margin-top:8px}
''' % {'r': FONT % 'Regular', 'm': FONT % 'Medium', 's': FONT % 'SemiBold', 'b': FONT % 'Bold'}

doc = f'<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>{e(o["title"])}</title><style>{css}</style></head><body>{"".join(pages)}</body></html>'
with open(os.path.join(OUT, 'brochure.html'), 'w', encoding='utf-8') as fh:
    fh.write(doc)
print(len(pages), 'pages;', sum(os.path.getsize(os.path.join(ASSETS, f)) for f in os.listdir(ASSETS)) // 1024, 'KB of pictures')
