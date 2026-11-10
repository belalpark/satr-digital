"""Build the rental brochure (Satr identity, 9:16 pages for a phone) as HTML; print_pdf.mjs turns it into the PDF.

    python3 tools/brochure/build.py <outDir> <model3d.jpg>      # then: node tools/brochure/print_pdf.mjs <outDir>/brochure.html <out.pdf>

Owner (2026-11-11): the PDF must be attractive, say plainly that the WHOLE office is for rent, give the main
details and advantages of each part (nothing obvious such as screens, phones or plants), and show each part as
"a picture from the plan, zoomed in on it, then its advantages and its photos".

So every page of a space opens with the plan itself: the high-resolution 2D plan cropped to the space, the space
lit and outlined, the rest of the office dimmed (`spot()`); groups of rooms (the nine offices, the six employee
areas, the service rooms) are lit on the whole plan with their numbers from the door.

What is said about the office comes from the site's data (data/office.json): names and numbers, the two owner
figures, capacities, fixtures and what the photo captions record; each phrase was checked against the photos
used. Three statements come from outside the data and are marked SOURCE below: that the office is offered whole
for rent (the owner, 2026-11-11) and two facts about the location (a third-party listing in the same business
park). There is no price, no lease term and no date here: none was given.
"""
import html
import json
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = sys.argv[1]
MODEL = sys.argv[2]
ASSETS = os.path.join(OUT, 'assets')
os.makedirs(ASSETS, exist_ok=True)

office = json.load(open(os.path.join(REPO, 'data/office.json'), encoding='utf-8'))
o = office['office']
rooms = {r['id']: r for r in office['rooms']}
w, brand, footer = o['welcome'], o['brand'], o['footer']
e = html.escape
NAVY, GOLD = (5, 27, 48), (216, 180, 102)


def jpg(src, name, width, quality=84):
    """A JPEG copy sized for the page: Chromium embeds JPEG as it is (WebP would be stored uncompressed)."""
    im = Image.open(src).convert('RGB')
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(os.path.join(ASSETS, name), 'JPEG', quality=quality, optimize=True, progressive=True)
    return 'assets/' + name


def photo(room_id, n, width=1100):
    return jpg(os.path.join(REPO, rooms[room_id]['photos'][n - 1]['src']), f'{room_id}-{n}.jpg', width)


# ---------- the plan, lit where the page is about ----------
T = o['plan2d']['tiles']
REF_W, REF_H = o['plan']['reference']['width'], o['plan']['reference']['height']
K = T['width'] / REF_W  # plan pixels per reference unit (4.0)
_plan = None


def plan():
    """The high-resolution plan, put together from the site's own tiles."""
    global _plan
    if _plan is None:
        _plan = Image.new('RGB', (T['width'], T['height']))
        for r in range(T['rows']):
            for c in range(T['cols']):
                tile = Image.open(os.path.join(REPO, T['path'].replace('{x}', str(c)).replace('{y}', str(r)))).convert('RGB')
                _plan.paste(tile, (c * T['size'], r * T['size']))
    return _plan


def centroid(poly):
    area = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        c = x1 * y2 - x2 * y1
        area += c
        cx += (x1 + x2) * c
        cy += (y1 + y2) * c
    return cx / (3 * area), cy / (3 * area)


BUILDING = (150, 95, 1160, 1110)  # the office on the plan (reference units), without the page margin around it


def frame(ids, aspect, pad, whole=False):
    """The part of the plan to show: around the rooms (or the whole office), widened to the wanted proportions."""
    if whole:
        x0, y0, x1, y1 = BUILDING
    else:
        pts = [p for i in ids for p in rooms[i]['polygon']]
        x0, y0 = min(p[0] for p in pts) - pad, min(p[1] for p in pts) - pad
        x1, y1 = max(p[0] for p in pts) + pad, max(p[1] for p in pts) + pad
    bw, bh = x1 - x0, y1 - y0
    if bw / bh < aspect:
        x0, x1 = (x0 + x1) / 2 - bh * aspect / 2, (x0 + x1) / 2 + bh * aspect / 2
    else:
        y0, y1 = (y0 + y1) / 2 - bw / aspect / 2, (y0 + y1) / 2 + bw / aspect / 2
    # keep inside the plan image
    dx = -x0 if x0 < 0 else min(0, REF_W - x1)
    dy = -y0 if y0 < 0 else min(0, REF_H - y1)
    return x0 + dx, y0 + dy, x1 + dx, y1 + dy


def spot(name, ids, width, height, pad=70, whole=False, outline=5, dim=0.6):
    """The plan cropped to `ids` (or whole), those rooms lit and outlined in gold, everything else dimmed to navy.
    Returns the picture and a function giving a plan point's place on it in percent (for the number badges)."""
    box = frame(ids, width / height, pad, whole)
    W2, H2 = width * 2, height * 2  # twice the page size: sharp on a phone
    crop = plan().crop(tuple(round(v * K) for v in box)).resize((W2, H2), Image.LANCZOS)
    sx, sy = W2 / (box[2] - box[0]), H2 / (box[3] - box[1])
    to_px = lambda p: ((p[0] - box[0]) * sx, (p[1] - box[1]) * sy)
    mask = Image.new('L', (W2, H2), 0)
    md = ImageDraw.Draw(mask)
    for i in ids:
        md.polygon([to_px(p) for p in rooms[i]['polygon']], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.2))
    dark = Image.blend(ImageEnhance.Color(crop).enhance(0.35), Image.new('RGB', (W2, H2), NAVY), dim)
    lit = ImageEnhance.Brightness(crop).enhance(1.05)
    out = Image.composite(lit, dark, mask)
    d = ImageDraw.Draw(out)
    for i in ids:
        pts = [to_px(p) for p in rooms[i]['polygon']]
        d.line(pts + pts[:2], fill=GOLD, width=outline * 2, joint='curve')
    out.save(os.path.join(ASSETS, name), 'JPEG', quality=88, optimize=True, progressive=True)
    return 'assets/' + name, (lambda p: (100 * (p[0] - box[0]) / (box[2] - box[0]), 100 * (p[1] - box[1]) / (box[3] - box[1])))


def badges(ids, place):
    """The rooms' numbers from the door (the last word of their names on the site), over the lit plan."""
    out = []
    for i in ids:
        x, y = place(centroid(rooms[i]['polygon']))
        out.append(f'<i class="n" style="left:{x:.2f}%;top:{y:.2f}%" dir="ltr">{e(rooms[i]["name"].split()[-1])}</i>')
    return ''.join(out)


def feats(items):
    return '<ul class="feat">' + ''.join(f'<li>{e(t)}</li>' for t in items) + '</ul>'


def shot(src, tag='', cls=''):
    return f'<figure class="shot {cls}"><img src="{src}" alt="">{f"<figcaption>{e(tag)}</figcaption>" if tag else ""}</figure>'


OFFICES = [r['id'] for r in office['rooms'] if r['kind'] == 'office']
OPEN = [r['id'] for r in office['rooms'] if r['kind'] == 'open']
MEETING = [r['id'] for r in office['rooms'] if r['kind'] == 'meeting']
SEATS = rooms['meeting-large']['capacity']['seats']
AREA, COUNT = w['facts'][0], w['facts'][1]
WHOLE = 'المكتب كاملًا للإيجار'  # SOURCE: the owner, 2026-11-11 ("I offer the whole office for rent: make it clear")

pages = []


def page(cls, body):
    pages.append((cls, body))


# ---- 1. cover: the offer in one word
page('cover dark', f'''
  <img class="bg" src="{jpg(os.path.join(REPO, 'media/hero/perspective.webp'), 'hero.jpg', 1300, 86)}" alt="">
  <div class="shade"></div>
  <div class="brandline"><strong>{e(brand["name"])}</strong><span dir="ltr">{e(brand["nameEn"])}</span></div>
  <div class="cover-in">
    <p class="place">{e(w["location"].split("·")[0].strip())}<span>{e(w["location"].split("·")[1].strip())}</span></p>
    <h1 class="kufi">للإيجار</h1>
    <p class="what">مكتب كامل، مفروش ومجهّز</p>
    <div class="figs">
      <div><b dir="ltr">{e(AREA["value"])}</b><small>{e(AREA["unit"])}</small><span>{e(AREA["label"])}</span></div>
      <div><b dir="ltr">{e(COUNT["value"])}</b><small>{e(COUNT["label"])}</small><span>{e(COUNT["note"])}</span></div>
    </div>
    <p class="whole">يُؤجَّر كاملًا لشركة واحدة</p>
  </div>''')

# ---- 2. the offer: a whole headquarters
# SOURCE for the two location lines: the listing of a serviced-office operator in the same business park
# (servcorp.com.sa, "Roshn Business Front, Airport Road", read 2026-11-11). Not from the site's data.
inside = [
    'استقبال بكاونتر خشبي ولاونج للضيوف',
    'مدرّج داخلي للفعاليات واللقاءات',
    f'{len(OFFICES)} مكاتب إدارية مغلقة',
    f'{len(OPEN)} مناطق مكاتب للموظفين',
    f'قاعتا اجتماعات، الكبرى بـ{SEATS} مقعدًا',
    'جلسة نساء، غرفة سيرفر، مستودع ودورات مياه',
]
page('offer dark', f'''
  <header class="head">
    <h2 class="kufi">مقرّ كامل،<br>لا مكتب في مقرّ</h2>
    <p class="lead">المكتب معروض للإيجار كاملًا، وحدةً واحدة. {e(w["atmosphere"])}.</p>
  </header>
  <figure class="model"><img src="{jpg(MODEL, 'model3d.jpg', 1400, 88)}" alt=""></figure>
  <div class="in">
    <h3>في المكتب</h3>
    {feats(inside)}
  </div>
  <div class="where">
    <h3>الموقع</h3>
    <p>واجهة روشن للأعمال، طريق المطار شمال الرياض، مقابل جامعة الأميرة نورة</p>
    <p>نحو 10 دقائق بالسيارة من مطار الملك خالد الدولي</p>
  </div>''')


# ---- pages of one space: the plan zoomed on it, its advantages, its photos
def zoom_page(title, hook, ids, features, shots, note='', pad=70):
    zoom, _ = spot(f'zoom-{ids[0]}.jpg', ids, 500, 270, pad=pad)
    locator, _ = spot(f'loc-{ids[0]}.jpg', ids, 92, 92, whole=True, outline=2, dim=0.72)
    main, a, b = shots
    page('space light', f'''
  <header class="head">
    <div class="t"><h2 class="kufi">{e(title)}</h2><p class="hook">{e(hook)}</p></div>
    <figure class="locator"><img src="{locator}" alt=""></figure>
  </header>
  <figure class="zoom"><img src="{zoom}" alt="">{f'<figcaption>{e(note)}</figcaption>' if note else ''}</figure>
  {feats(features)}
  <div class="shots">{shot(*main, cls="main")}{shot(*a)}{shot(*b)}</div>''')


zoom_page('الاستقبال', 'الانطباع الأول عن شركتك', ['reception'], [
    'كاونتر ترحيب خشبي تعلوه إضاءة سقفية مميزة',
    'رفوف عرض مضاءة خلف الكاونتر',
    'جدار أخضر يرافق الممر إلى الداخل',
    'يتصل مباشرة باللاونج والمدرّج',
], [(photo('reception', 2),), (photo('reception', 4),), (photo('corridors', 4), 'مدخل المكتب')], pad=62)

zoom_page('اللاونج والمدرّج', 'ضيافة وفعاليات داخل مكتبك', ['lounge', 'bleachers'], [
    'لاونج للضيوف على الواجهة الزجاجية بإضاءة طبيعية',
    'مدرّج خشبي داخلي للعروض واللقاءات',
    'سقف خشبي هندسي معلّق يميّز المكان',
    'مقصورة هادئة لاجتماع شخصين',
], [(photo('lounge', 2),), (photo('bleachers', 1), 'المدرّج'), (photo('lounge', 7), 'المقصورة')], pad=60)

zoom_page('مكتب الإدارة', 'مكتب وقاعة اجتماع وصالون في مساحة واحدة', ['ceo'], [
    'طاولة اجتماعات ملحقة بمقاعد جلدية',
    'ركن جلوس مستقل للضيوف',
    'سقف خشبي وواجهة زجاجية بإطلالة',
], [(photo('ceo', 1),), (photo('ceo', 3),), (photo('ceo', 4),)], note=f'{rooms["ceo"]["name"]} على المخطط', pad=60)

# ---- the two meeting rooms: two zooms side by side
z1, _ = spot('zoom-meeting-1.jpg', ['meeting-large'], 296, 250, pad=55)
z2, _ = spot('zoom-meeting-2.jpg', ['meeting-medium'], 196, 250, pad=45)
loc_m, _ = spot('loc-meeting.jpg', MEETING, 92, 92, whole=True, outline=2, dim=0.72)
page('space light meet', f'''
  <header class="head">
    <div class="t"><h2 class="kufi">قاعتا الاجتماعات</h2><p class="hook">كبرى لـ{SEATS} شخصًا، وثانية بإطلالة</p></div>
    <figure class="locator"><img src="{loc_m}" alt=""></figure>
  </header>
  <div class="zooms">
    <figure class="zoom"><img src="{z1}" alt=""><figcaption>{e(rooms["meeting-large"]["name"])}</figcaption></figure>
    <figure class="zoom"><img src="{z2}" alt=""><figcaption>{e(rooms["meeting-medium"]["name"])}</figcaption></figure>
  </div>
  {feats([
      f'القاعة 1: طاولة واحدة طويلة بـ{SEATS} مقعدًا',
      'مجهّزة للعروض والاجتماعات عن بُعد',
      'واجهة زجاجية على الممر الداخلي',
      'القاعة 2: على الواجهة الزجاجية بإطلالة',
  ])}
  <div class="shots">{shot(photo('meeting-large', 2), cls="main")}{shot(photo('meeting-large', 1), 'القاعة 1')}{shot(photo('meeting-medium', 2), 'القاعة 2')}</div>''')


# ---- pages of a group of rooms: lit on the whole plan with their numbers from the door
def group_page(title, hook, ids, features, shots, numbered=True, cls=''):
    m, place = spot(f'map-{ids[0]}.jpg', ids, 268, 270, whole=True, outline=3, dim=0.66)
    page(f'group dark {cls}', f'''
  <header class="head"><h2 class="kufi">{e(title)}</h2><p class="hook">{e(hook)}</p></header>
  <div class="row">
    {feats(features)}
    <figure class="map"><img src="{m}" alt="">{badges(ids, place) if numbered else ''}</figure>
  </div>
  <div class="grid">{''.join(shot(*s) for s in shots)}</div>''')


group_page('المكاتب الإدارية', 'تسعة مكاتب مغلقة لقيادات فريقك', OFFICES, [
    'مكاتب على الواجهة بإضاءة طبيعية',
    'مكاتب داخلية بواجهات زجاجية على الممر',
    'بعضها بطاولة اجتماع خاصة',
    f'مرقّمة من 1 إلى {len(OFFICES)} بدءًا من الباب',
], [(photo('coo', 1, 700), rooms['coo']['name']), (photo('inner-4', 1, 700), rooms['inner-4']['name']),
    (photo('cfo', 5, 700), rooms['cfo']['name']), (photo('office-r2', 1, 700), rooms['office-r2']['name'])])

group_page('مكاتب الموظفين', 'ست مناطق عمل تتسع لفرقك', OPEN, [
    'أكبرها على طول الواجهات الزجاجية بإضاءة طبيعية',
    'صفوف وتجمعات تناسب فرقًا مختلفة الأحجام',
    'إحداها بـ14 محطة عمل',
    f'مرقّمة من 1 إلى {len(OPEN)} بدءًا من الباب',
], [(photo('hr-pmo-ops', 7, 700), rooms['hr-pmo-ops']['name']), (photo('research', 1, 700), rooms['research']['name']),
    (photo('open-a', 1, 700), rooms['open-a']['name']), (photo('field-qc', 6, 700), rooms['field-qc']['name'])])

group_page('المرافق', 'كل ما يلزم داخل المكتب نفسه', ['women-area', 'wc-women', 'wc-men', 'store', 'data-center'], [
    'جلسة نساء مستقلة',
    'دورات مياه للرجال والنساء',
    'غرفة سيرفر',
    'مستودع',
], [(photo('women-area', 1, 900), rooms['women-area']['name']), (photo('wc-men', 1, 900), 'دورات المياه')], numbered=False, cls='two')


# ---- last: come and see it
def phone(p):
    href = p.get('whatsapp') or f'tel:{p["tel"]}'
    label = ' · '.join(x for x in (p.get('label'), 'واتساب' if p.get('whatsapp') else None) if x)
    return f'<a class="phone" href="{e(href)}"><small>{e(label)}</small><b dir="ltr">{e(p["display"])}</b></a>'


page('contact dark', f'''
  <div class="frame"></div>
  <div class="contact-in">
    <p class="tag">{e(WHOLE)}</p>
    <h2 class="kufi">عاين المكتب<br>بنفسك</h2>
    <p class="ask">للمعاينة وتفاصيل الإيجار راسلنا على واتساب</p>
    <div class="phones">{''.join(phone(p) for p in reversed(footer['phones']))}</div>
    <i class="rule"></i>
    <p class="brand">{e(brand["name"])}<span dir="ltr">{e(brand["nameEn"])}</span></p>
    <p class="slogan">{e(brand["slogan"])}</p>
    <a class="web" href="{e(footer["website"]["href"])}" dir="ltr">{e(footer["website"]["label"])}</a>
    <p class="loc">{e(footer["location"])}</p>
    <p class="fine">الصور للمكتب بوضعه الحالي. المخطط والنموذج ثلاثي الأبعاد توضيحيان.</p>
  </div>''')

total = len(pages)
body = ''.join(
    f'<section class="page {cls}">{inner}'
    + ('' if 'cover' in cls or 'contact' in cls else f'<footer class="foot"><span class="w">{e(WHOLE)}</span><span class="b">{e(brand["name"])}<i dir="ltr">{n} / {total}</i></span></footer>')
    + '</section>'
    for n, (cls, inner) in enumerate(pages, 1))

PLEX = 'file://' + os.path.join(REPO, 'assets/fonts/IBMPlexSansArabic-%s.woff2')
KUFI = 'file://' + os.path.join(REPO, 'tools/brochure/fonts/NotoKufiArabic-%s.woff2')
css = '''
@font-face{font-family:Plex;font-weight:400;src:url("PLEX_R") format("woff2")}
@font-face{font-family:Plex;font-weight:500;src:url("PLEX_M") format("woff2")}
@font-face{font-family:Plex;font-weight:600;src:url("PLEX_S") format("woff2")}
@font-face{font-family:Plex;font-weight:700;src:url("PLEX_B") format("woff2")}
@font-face{font-family:Kufi;font-weight:700;src:url("KUFI_B") format("woff2")}
@font-face{font-family:Kufi;font-weight:800;src:url("KUFI_X") format("woff2")}
@page{size:540px 960px;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#051b30}
body{font-family:Plex,sans-serif;direction:rtl;-webkit-print-color-adjust:exact;print-color-adjust:exact}
img{display:block}
.kufi{font-family:Kufi,Plex,sans-serif}
.page{width:540px;height:960px;position:relative;overflow:hidden;break-after:page}
.page:last-child{break-after:auto}
.dark{background:#051b30;color:#fff}
.light{background:#f6f1ea;color:#0e2034}
.foot{position:absolute;inset:auto 0 0 0;height:40px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;font-size:12px}
.foot .w{font-weight:700}
.foot .b{display:flex;gap:12px;align-items:center;font-weight:500}
.foot .b i{font-style:normal;font-variant-numeric:tabular-nums;opacity:.7}
.dark .foot{color:rgba(244,236,228,.78);border-top:1px solid rgba(216,180,102,.22)}
.dark .foot .w{color:#e3c47c}
.light .foot{color:#6b5a45;border-top:1px solid rgba(150,108,60,.22)}
.light .foot .w{color:#966c3c}
/* the advantages: one short line each, marked with the site's own diamond */
.feat{list-style:none;display:grid;gap:9px}
.feat li{position:relative;padding-inline-start:22px;font-size:16.5px;font-weight:600;line-height:1.5}
.feat li::before{content:"";position:absolute;inset-inline-start:2px;top:.52em;width:9px;height:9px;border-radius:2px;background:linear-gradient(135deg,#e3c47c,#966c3c);transform:rotate(45deg)}
.shot{position:relative;overflow:hidden;border-radius:14px;background:#0b1622}
.shot img{width:100%;height:100%;object-fit:cover}
.shot figcaption{position:absolute;inset:auto 10px 9px auto;padding:3px 11px;border-radius:999px;background:rgba(5,27,48,.8);color:#f4ece4;font-size:12px;font-weight:600}

/* 1. cover */
.cover .bg{position:absolute;inset:0 0 auto 0;width:100%;height:600px;object-fit:cover;object-position:42% 50%}
.cover .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,27,48,.62) 0%,rgba(5,27,48,.08) 16%,rgba(5,27,48,.12) 36%,rgba(5,27,48,.9) 56%,#051b30 64%)}
.brandline{position:absolute;inset:30px 34px auto auto;display:flex;flex-direction:column;gap:1px}
.brandline strong{font-size:21px;font-weight:700}
.brandline span{font-size:9.5px;letter-spacing:.4em;color:#e3c47c;font-weight:500}
.cover-in{position:absolute;inset:auto 34px 44px 34px}
.place{font-size:19px;font-weight:600;color:#fff;display:flex;align-items:baseline;gap:12px}
.place span{font-size:15px;font-weight:500;color:#e3c47c}
.cover h1{font-size:132px;font-weight:800;line-height:1.28;margin:-8px 0 -4px;color:#dfbd72;text-shadow:0 6px 30px rgba(5,27,48,.55)}
.what{font-size:27px;font-weight:700}
.figs{display:grid;grid-template-columns:auto auto;justify-content:start;gap:0 34px;margin:20px 0 22px;padding-top:18px;border-top:1px solid rgba(216,180,102,.4)}
.figs div{display:grid;grid-template-columns:auto auto;justify-content:start;align-items:baseline;column-gap:7px}
.figs b{font-size:42px;font-weight:700;line-height:1.1;color:#e3c47c}
.figs small{font-size:17px;font-weight:600;color:#e3c47c}
.figs span{grid-column:1/-1;font-size:13px;color:rgba(244,236,228,.82)}
.whole{display:inline-block;padding:9px 20px;border-radius:999px;background:linear-gradient(180deg,#e3c47c,#c9a14f);color:#051b30;font-size:16px;font-weight:700}

/* 2. the offer */
.offer .head{padding:38px 32px 0}
.offer h2{font-size:41px;line-height:1.42;font-weight:800;color:#e3c47c}
.offer .lead{font-size:16.5px;line-height:1.75;color:#f4ece4;margin-top:10px}
.offer .model{height:330px;margin-top:6px;position:relative}
.offer .model img{width:100%;height:100%;object-fit:cover;object-position:50% 46%}
.offer .model::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,#051b30 0%,rgba(5,27,48,0) 16%,rgba(5,27,48,0) 84%,#051b30 100%),linear-gradient(90deg,#051b30 0%,rgba(5,27,48,0) 12%,rgba(5,27,48,0) 88%,#051b30 100%)}
.offer h3{font-size:14px;font-weight:700;color:#e3c47c;margin-bottom:10px}
.offer .in{padding:4px 32px 0}
.offer .in .feat{grid-template-columns:1fr 1fr;gap:9px 18px}
.offer .in .feat li{font-size:14.5px;font-weight:600}
.offer .where{position:absolute;inset:auto 0 40px 0;padding:14px 32px 16px;background:#0b2743;border-top:1px solid rgba(216,180,102,.3)}
.offer .where h3{margin-bottom:5px}
.offer .where p{font-size:14.5px;line-height:1.7;color:#f4ece4}

/* a space: the plan zoomed on it, then its advantages, then its photos */
.space .head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:30px 28px 0 20px}
.space h2{font-size:38px;font-weight:800;line-height:1.5;color:#051b30}
.space .hook{font-size:17px;font-weight:600;color:#966c3c;margin-top:-2px}
.locator{flex:0 0 auto;width:92px;height:92px;border-radius:16px;overflow:hidden;box-shadow:0 6px 18px rgba(5,27,48,.25)}
.locator img{width:100%;height:100%}
.zoom{position:relative;margin:16px 20px 0;height:270px;border-radius:20px;overflow:hidden;box-shadow:0 10px 28px rgba(5,27,48,.22)}
.zoom img{width:100%;height:100%;object-fit:cover}
.zoom figcaption{position:absolute;inset:12px 12px auto auto;padding:4px 13px;border-radius:999px;background:#d8b466;color:#051b30;font-size:12.5px;font-weight:700}
.space .feat{padding:18px 30px 0}
.space .feat li{color:#0e2034}
.shots{position:absolute;inset:auto 20px 54px 20px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.shots .main{grid-column:1/-1;height:200px}
.shots .shot:not(.main){height:128px}
.zooms{display:grid;grid-template-columns:296px 196px;gap:8px;margin:16px 20px 0}
.zooms .zoom{margin:0;height:250px}
.meet .shots .main{height:196px}
.meet .shots .shot:not(.main){height:124px}

/* a group of rooms, lit on the whole plan */
.group .head{padding:34px 30px 0}
.group h2{font-size:40px;font-weight:800;line-height:1.5;color:#e3c47c}
.group .hook{font-size:17.5px;font-weight:600;color:#f4ece4;margin-top:-2px}
.group .row{display:grid;grid-template-columns:1fr 268px;gap:14px;align-items:center;padding:18px 20px 0 30px}
.group .feat li{font-size:15.5px}
.map{position:relative;height:270px;border-radius:18px;overflow:hidden;border:1px solid rgba(216,180,102,.4)}
.map img{width:100%;height:100%}
.map .n{position:absolute;transform:translate(-50%,-50%);min-width:21px;height:21px;padding:0 4px;border-radius:999px;background:#d8b466;color:#051b30;font-style:normal;font-size:12.5px;font-weight:700;line-height:21px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.45)}
.grid{position:absolute;inset:auto 20px 54px 20px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid .shot{height:234px}
.two .grid{grid-template-columns:1fr}
.two .grid .shot{height:220px}

/* last page */
.contact{background:linear-gradient(180deg,#051b30,#0b2a47 46%,#051b30)}
.contact .frame{position:absolute;inset:22px;border:1px solid rgba(216,180,102,.45);border-radius:22px}
.contact-in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 50px}
.contact .tag{padding:7px 18px;border-radius:999px;background:linear-gradient(180deg,#e3c47c,#c9a14f);color:#051b30;font-size:14.5px;font-weight:700;margin-bottom:20px}
.contact h2{font-size:58px;font-weight:800;line-height:1.38;color:#fff}
.contact .ask{font-size:17px;color:#f4ece4;margin:12px 0 30px}
.phones{display:grid;gap:16px}
.phone{display:grid;gap:1px;color:#fff;text-decoration:none}
.phone small{font-size:13.5px;color:#e3c47c;font-weight:600}
.phone b{font-size:32px;font-weight:700;letter-spacing:.01em}
.contact .rule{display:block;width:64px;height:2px;background:#d8b466;margin:30px 0 22px}
.contact .brand{font-size:22px;font-weight:700;display:flex;flex-direction:column;gap:2px}
.contact .brand span{font-size:10px;letter-spacing:.42em;color:#e3c47c;font-weight:500}
.slogan{font-size:14.5px;color:#f4ece4;margin-top:10px}
.web{color:#e3c47c;font-size:18px;font-weight:600;text-decoration:none;margin-top:10px}
.loc{font-size:13px;color:rgba(244,236,228,.85);margin-top:22px}
.fine{font-size:11px;color:rgba(244,236,228,.55);margin-top:8px}
'''
for key, val in {'PLEX_R': PLEX % 'Regular', 'PLEX_M': PLEX % 'Medium', 'PLEX_S': PLEX % 'SemiBold', 'PLEX_B': PLEX % 'Bold',
                 'KUFI_B': KUFI % 'Bold', 'KUFI_X': KUFI % 'ExtraBold'}.items():
    css = css.replace(key, val)

doc = f'<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>للإيجار: مكتب كامل في {e(w["location"].split("·")[0].strip())}</title><style>{css}</style></head><body>{body}</body></html>'
with open(os.path.join(OUT, 'brochure.html'), 'w', encoding='utf-8') as fh:
    fh.write(doc)
print(total, 'pages;', sum(os.path.getsize(os.path.join(ASSETS, f)) for f in os.listdir(ASSETS)) // 1024, 'KB of pictures')
