"""Build the rental brochure (Satr identity, 9:16 pages for a phone) as HTML; print_pdf.mjs turns it into the PDF.

    python3 tools/brochure/build.py <outDir> <model3d.jpg>      # then: node tools/brochure/print_pdf.mjs <outDir>/brochure.html <out.pdf>

Owner (2026-11-11): the PDF must be attractive, say plainly that the WHOLE office is for rent, give the main
details and advantages of each part (nothing obvious such as screens, phones or plants), and show each part as
"a picture from the plan, zoomed in on it, then its advantages and its photos".

So every page of a space opens with the plan itself: the high-resolution 2D plan cropped to the space, the space
lit and outlined, the rest of the office dimmed (`spot()`); groups of rooms (the ten offices, the six employee
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
# Two editions (owner, 2026-11-11): `satr` carries the company; `general` carries no company name, logo or site and
# one number only, "for contact and viewing". Each links to its own site: «ابدأ الجولة الافتراضية».
EDITION = sys.argv[3] if len(sys.argv) > 3 else 'satr'
assert EDITION in ('satr', 'general'), EDITION
# owner (2026-11-11): satr.maspro4it.com does not open; both editions lead to the tour at roshen.maspro4it.com
TOUR = 'https://roshen.maspro4it.com/#/'
SATR = EDITION == 'satr'
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


def lerp(stops, v):
    for (a, x), (b, y) in zip(stops, stops[1:]):
        if a <= v <= b:
            return x + (y - x) * (v - a) / (b - a)
    return stops[-1][1]


def cover_picture():
    """The cover's photo with its navy fade painted in. A PDF made from CSS shadows and see-through gradients
    carries soft masks; the iPhone's viewer draws some of them as a pale rectangle (owner, 2026-11-11). So
    every fade in this brochure is part of a picture, and nothing has a shadow."""
    W2, H2, top = 1080, 1920, 1160
    hero = Image.open(os.path.join(REPO, 'media/hero/perspective.webp')).convert('RGB')
    s = max(W2 / hero.width, top / hero.height)
    hero = hero.resize((round(hero.width * s), round(hero.height * s)), Image.LANCZOS)
    x = round((hero.width - W2) * 0.42)
    y = round((hero.height - top) * 0.5)
    page_ = Image.new('RGB', (W2, H2), NAVY)
    page_.paste(hero.crop((x, y, x + W2, y + top)), (0, 0))
    stops = [(0, .62), (.16, .08), (.32, .1), (.52, .88), (.60, 1), (1, 1)]
    alpha = Image.new('L', (1, H2))
    alpha.putdata([round(255 * lerp(stops, i / (H2 - 1))) for i in range(H2)])
    page_ = Image.composite(Image.new('RGB', (W2, H2), NAVY), page_, alpha.resize((W2, H2)))
    page_.save(os.path.join(ASSETS, 'cover.jpg'), 'JPEG', quality=88, optimize=True, progressive=True)
    return 'assets/cover.jpg'


def model_picture():
    """The 3D model picture with its four edges faded into the page colour (painted in, as on the cover)."""
    W2, H2 = 1080, 660
    im = Image.open(MODEL).convert('RGB')
    s = max(W2 / im.width, H2 / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x, y = round((im.width - W2) * 0.5), round((im.height - H2) * 0.46)
    im = im.crop((x, y, x + W2, y + H2))
    edge = lambda v, w: max(0.0, 1 - min(v, 1 - v) / w)
    ax = Image.new('L', (W2, 1)); ax.putdata([round(255 * edge(i / (W2 - 1), .12)) for i in range(W2)])
    ay = Image.new('L', (1, H2)); ay.putdata([round(255 * edge(i / (H2 - 1), .16)) for i in range(H2)])
    from PIL import ImageChops
    alpha = ImageChops.lighter(ax.resize((W2, H2)), ay.resize((W2, H2)))
    im = Image.composite(Image.new('RGB', (W2, H2), NAVY), im, alpha)
    im.save(os.path.join(ASSETS, 'model3d.jpg'), 'JPEG', quality=88, optimize=True, progressive=True)
    return 'assets/model3d.jpg'


OFFICES = [r['id'] for r in office['rooms'] if r['kind'] == 'office']
OPEN = [r['id'] for r in office['rooms'] if r['kind'] == 'open']
MEETING = [r['id'] for r in office['rooms'] if r['kind'] == 'meeting']
SEATS = rooms['meeting-large']['capacity']['seats']
AREA, COUNT = w['facts'][0], w['facts'][1]
WHOLE = 'المكتب كاملًا للإيجار'  # SOURCE: the owner, 2026-11-11 ("I offer the whole office for rent: make it clear")

pages = []


def page(cls, body):
    pages.append((cls, body))


# ---- 1. cover: the owner's own two lines (the site's welcome), what is inside in one sentence, the offer in a small tag
# Owner (2026-11-11): "the huge «للإيجار» disfigured the report; use «مساحة تليق بأعمالك» and «مقر إداري مفروش
# ومجهّز يجمع فريقك في مكان واحد», with a little more, better content".
NUM = {6: 'ست', 9: 'تسعة', 10: 'عشرة'}
head1, head2 = w['subtitle'].rsplit(' ', 1)
page('cover dark', f'''
  <img class="bg" src="{cover_picture()}" alt="">
  {f'<div class="brandline"><strong>{e(brand["name"])}</strong><span dir="ltr">{e(brand["nameEn"])}</span></div>' if SATR else ''}
  <div class="cover-in">
    <p class="place">{e(w["location"].split("·")[0].strip())}<span>{e(w["location"].split("·")[1].strip())}</span></p>
    <h1 class="display">{e(head1)}<br>{e(head2)}</h1>
    <p class="what">{e(w["atmosphere"])}</p>
    <div class="figs">
      <div><b dir="ltr">{e(AREA["value"])}</b><small>{e(AREA["unit"])}</small><span>{e(AREA["label"])}</span></div>
      <div><b dir="ltr">{e(COUNT["value"])}</b><small>{e(COUNT["label"])}</small><span>{e(COUNT["note"])}</span></div>
    </div>
    <p class="has">استقبال ولاونج ومدرّج داخلي، قاعتا اجتماعات، {NUM.get(len(OFFICES), len(OFFICES))} مكاتب مغلقة و{NUM.get(len(OPEN), len(OPEN))} مناطق لفرق العمل</p>
    <p class="acts"><span class="whole">{e(WHOLE)}</span><a class="tour" href="{TOUR}">ابدأ الجولة الافتراضية</a></p>
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
    <h2 class="display">مقرّ كامل،<br>لا مكتب في مقرّ</h2>
    <p class="lead">المكتب معروض للإيجار كاملًا، وحدةً واحدة: استقبالك وقاعات اجتماعاتك ومكاتب فريقك خلف باب واحد.</p>
  </header>
  <figure class="model"><img src="{model_picture()}" alt=""></figure>
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
    <div class="t"><h2 class="display">{e(title)}</h2><p class="hook">{e(hook)}</p></div>
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
    <div class="t"><h2 class="display">قاعتا الاجتماعات</h2><p class="hook">كبرى لـ{SEATS} شخصًا، وثانية بإطلالة</p></div>
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
  <header class="head"><h2 class="display">{e(title)}</h2><p class="hook">{e(hook)}</p></header>
  <div class="row">
    {feats(features)}
    <figure class="map"><img src="{m}" alt="">{badges(ids, place) if numbered else ''}</figure>
  </div>
  <div class="grid">{''.join(shot(*s) for s in shots)}</div>''')


group_page('المكاتب الإدارية', f'{NUM.get(len(OFFICES), len(OFFICES))} مكاتب مغلقة لقيادات فريقك', OFFICES, [
    'مكاتب على الواجهة بإضاءة طبيعية',
    'مكاتب داخلية بواجهات زجاجية على الممر',
    'بعضها بطاولة اجتماع خاصة',
    f'مرقّمة من 1 إلى {len(OFFICES)} بدءًا من الباب',
], [(photo('coo', 1, 700), rooms['coo']['name']),
    # the two glass offices stand side by side (owner, 2026-11-11: "they are two separate offices"): the photo shows both
    (photo('inner-5', 1, 700), f'{rooms["inner-5"]["name"]} و{rooms["inner-4"]["name"]}'),
    (photo('cfo', 5, 700), rooms['cfo']['name']), (photo('office-r2', 1, 700), rooms['office-r2']['name'])])

group_page('مكاتب الموظفين', f'{NUM.get(len(OPEN), len(OPEN))} مناطق عمل تتسع لفرقك', OPEN, [
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


phones = list(reversed(footer['phones'])) if SATR else footer['phones'][1:2]  # general: the second number only (owner)
company = f'''<i class="rule"></i>
    <p class="brand">{e(brand["name"])}<span dir="ltr">{e(brand["nameEn"])}</span></p>
    <p class="slogan">{e(brand["slogan"])}</p>
    <a class="web" href="{e(footer["website"]["href"])}" dir="ltr">{e(footer["website"]["label"])}</a>''' if SATR else '<i class="rule"></i>'
page('contact dark', f'''
  <div class="frame"></div>
  <div class="contact-in">
    <p class="tag">{e(WHOLE)}</p>
    <h2 class="display">عاين المكتب<br>بنفسك</h2>
    <p class="ask">للمعاينة وتفاصيل الإيجار راسلنا على واتساب</p>
    <div class="phones">{''.join(phone(p) for p in phones)}</div>
    <a class="tour" href="{TOUR}">ابدأ الجولة الافتراضية</a>
    {company}
    <p class="loc">{e(footer["location"])}</p>
    <p class="fine">الصور للمكتب بوضعه الحالي. المخطط والنموذج ثلاثي الأبعاد توضيحيان.</p>
  </div>''')

total = len(pages)
body = ''.join(
    f'<section class="page {cls}">{inner}'
    + ('' if 'cover' in cls or 'contact' in cls else f'<footer class="foot"><span class="w">{e(WHOLE)}</span><span class="b">{e(brand["name"]) if SATR else ''}<i dir="ltr">{n} / {total}</i></span></footer>')
    + '</section>'
    for n, (cls, inner) in enumerate(pages, 1))

# The typeface: Alexandria (SIL Open Font License, tools/brochure/fonts), one family for the whole brochure:
# semibold for the headings, light and regular for the text. Owner (2026-11-11): "a better font, one that really
# suits it"; the heavy Kufi headings went with the huge word on the cover. Each weight is two files, Arabic and
# Latin (digits, the company's English name), told apart by unicode-range.
FONT_DIR = os.path.join(REPO, 'tools/brochure/fonts')
FONTS = {'Head': [500, 600, 700], 'Body': [300, 400, 500, 600, 700]}
ARABIC = 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC'
LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+2215'
faces = ''.join(
    f'@font-face{{font-family:{family};font-weight:{weight};src:url("file://{FONT_DIR}/alexandria-{script}-{weight}-normal.woff2") format("woff2");unicode-range:{rng}}}\n'
    for family, weights in FONTS.items() for weight in weights for script, rng in (('arabic', ARABIC), ('latin', LATIN)))
css = '''
/* solid colours only: see cover_picture() */
@page{size:540px 960px;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#051b30}
body{font-family:Body,sans-serif;direction:rtl;-webkit-print-color-adjust:exact;print-color-adjust:exact}
img{display:block}
.display{font-family:Head,Body,sans-serif}
.page{width:540px;height:960px;position:relative;overflow:hidden;break-after:page}
.page:last-child{break-after:auto}
.dark{background:#051b30;color:#fff}
.light{background:#f6f1ea;color:#0e2034}
.foot{position:absolute;inset:auto 0 0 0;height:40px;padding:0 26px;display:flex;align-items:center;justify-content:space-between;font-size:11.5px}
.foot .w{font-weight:600}
.foot .b{display:flex;gap:12px;align-items:center;font-weight:400}
.foot .b i{font-style:normal;font-variant-numeric:tabular-nums}
.dark .foot{color:#bfbebc;border-top:1px solid #333d3c}
.dark .foot .w{color:#e3c47c}
.light .foot{color:#6b5a45;border-top:1px solid #e1d4c4}
.light .foot .w{color:#966c3c}
/* the advantages: one short line each, marked with the site's own diamond */
.feat{list-style:none;display:grid;gap:9px}
.feat li{position:relative;padding-inline-start:22px;font-size:15.5px;font-weight:500;line-height:1.6;text-wrap:balance}
.feat li::before{content:"";position:absolute;inset-inline-start:2px;top:.52em;width:9px;height:9px;border-radius:2px;background:linear-gradient(135deg,#e3c47c,#966c3c);transform:rotate(45deg)}
.shot{position:relative;overflow:hidden;border-radius:14px;background:#0b1622}
.shot img{width:100%;height:100%;object-fit:cover}
.shot figcaption{position:absolute;inset:auto 10px 9px auto;padding:3px 11px;border-radius:999px;background:#051b30;color:#f4ece4;font-size:11.5px;font-weight:500}

/* 1. cover */
.cover .bg{position:absolute;inset:0;width:100%;height:100%}
.brandline{position:absolute;inset:30px 34px auto auto;display:flex;flex-direction:column;gap:1px}
.brandline strong{font-size:20px;font-weight:600}
.brandline span{font-size:9px;letter-spacing:.4em;color:#e3c47c;font-weight:500}
.cover-in{position:absolute;inset:auto 36px 46px 36px}
.place{font-size:15px;font-weight:500;color:#e3c47c;display:flex;align-items:baseline;gap:10px}
.place span{font-size:13px;font-weight:400;color:#d3cfcb}
.cover h1{font-size:60px;font-weight:600;line-height:1.36;margin:8px 0 10px;color:#fff}
.what{font-size:16.5px;font-weight:300;line-height:1.8;color:#f4ece4;white-space:nowrap}
.figs{display:grid;grid-template-columns:auto auto;justify-content:start;gap:0 36px;margin:20px 0 14px;padding-top:18px;border-top:1px solid #595846}
.figs div{display:grid;grid-template-columns:auto auto;justify-content:start;align-items:baseline;column-gap:7px}
.figs b{font-size:40px;font-weight:600;line-height:1.15;color:#e3c47c}
.figs small{font-size:16px;font-weight:500;color:#e3c47c}
.figs span{grid-column:1/-1;font-size:12.5px;color:#c9c6c4}
.has{font-size:12.5px;font-weight:300;line-height:1.9;color:#dcd6d0;margin-bottom:20px;text-wrap:balance}
.acts{display:flex;gap:10px;align-items:center}
.tour{display:inline-block;padding:8px 20px;border-radius:999px;border:1px solid #d8b466;color:#e3c47c;font-size:14px;font-weight:600;text-decoration:none}
.contact .tour{margin-top:26px;font-size:15px;padding:10px 26px}
.whole{display:inline-block;padding:8px 20px;border-radius:999px;background:linear-gradient(180deg,#e3c47c,#c9a14f);color:#051b30;font-size:14px;font-weight:600}

/* 2. the offer */
.offer .head{padding:38px 32px 0}
.offer h2{font-size:36px;line-height:1.45;font-weight:600;color:#e3c47c}
.offer .lead{font-size:15px;font-weight:300;line-height:1.85;color:#f4ece4;margin-top:10px}
.offer .model{height:330px;margin-top:6px;position:relative}
.offer .model img{width:100%;height:100%}
.offer h3{font-size:13.5px;font-weight:600;color:#e3c47c;margin-bottom:10px}
.offer .in{padding:4px 32px 0}
.offer .in .feat{grid-template-columns:1fr 1fr;gap:9px 18px}
.offer .in .feat li{font-size:13.5px;font-weight:400}
.offer .where{position:absolute;inset:auto 0 40px 0;padding:14px 32px 16px;background:#0b2743;border-top:1px solid #444940}
.offer .where h3{margin-bottom:5px}
.offer .where p{font-size:13.5px;font-weight:300;line-height:1.8;color:#f4ece4}

/* a space: the plan zoomed on it, then its advantages, then its photos */
.space .head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:30px 28px 0 20px}
.space h2{font-size:33px;font-weight:600;line-height:1.5;color:#051b30}
.space .hook{font-size:15px;font-weight:400;color:#966c3c;margin-top:0}
.locator{flex:0 0 auto;width:92px;height:92px;border-radius:16px;overflow:hidden}
.locator img{width:100%;height:100%}
.zoom{position:relative;margin:16px 20px 0;height:270px;border-radius:20px;overflow:hidden}
.zoom img{width:100%;height:100%;object-fit:cover}
.zoom figcaption{position:absolute;inset:12px 12px auto auto;padding:4px 13px;border-radius:999px;background:#d8b466;color:#051b30;font-size:12px;font-weight:600}
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
.group h2{font-size:34px;font-weight:600;line-height:1.5;color:#e3c47c}
.group .hook{font-size:15.5px;font-weight:300;color:#f4ece4;margin-top:0}
.group .row{display:grid;grid-template-columns:1fr 268px;gap:14px;align-items:center;padding:18px 20px 0 30px}
.group .feat li{font-size:14px;font-weight:400}
.map{position:relative;height:270px;border-radius:18px;overflow:hidden;border:1px solid #595846}
.map img{width:100%;height:100%}
.map .n{position:absolute;transform:translate(-50%,-50%);min-width:21px;height:21px;padding:0 4px;border-radius:999px;background:#d8b466;color:#051b30;font-style:normal;font-size:12px;font-weight:600;line-height:21px;text-align:center;border:1px solid #051b30}
.grid{position:absolute;inset:auto 20px 54px 20px;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.grid .shot{height:234px}
.two .grid{grid-template-columns:1fr}
.two .grid .shot{height:220px}

/* last page */
.contact{background:linear-gradient(180deg,#051b30,#0b2a47 46%,#051b30)}
.contact .frame{position:absolute;inset:22px;border:1px solid #646048;border-radius:22px}
.contact-in{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 50px}
.contact .tag{padding:7px 18px;border-radius:999px;background:linear-gradient(180deg,#e3c47c,#c9a14f);color:#051b30;font-size:13.5px;font-weight:600;margin-bottom:22px}
.contact h2{font-size:48px;font-weight:600;line-height:1.42;color:#fff}
.contact .ask{font-size:15px;font-weight:300;color:#f4ece4;margin:14px 0 30px}
.phones{display:grid;gap:16px}
.phone{display:grid;gap:1px;color:#fff;text-decoration:none}
.phone small{font-size:12.5px;color:#e3c47c;font-weight:500}
.phone b{font-size:28px;font-weight:500;letter-spacing:.02em}
.contact .rule{display:block;width:64px;height:2px;background:#d8b466;margin:26px 0 20px}
.contact .brand{font-size:20px;font-weight:600;display:flex;flex-direction:column;gap:3px}
.contact .brand span{font-size:10px;letter-spacing:.42em;color:#e3c47c;font-weight:500}
.slogan{font-size:13px;font-weight:300;color:#f4ece4;margin-top:10px}
.web{color:#e3c47c;font-size:16px;font-weight:500;text-decoration:none;margin-top:10px}
.loc{font-size:12px;font-weight:300;color:#d0cdc9;margin-top:22px}
.fine{font-size:10.5px;font-weight:300;color:#94989c;margin-top:8px}
'''
css = faces + css

doc = f'<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>للإيجار: مكتب كامل في {e(w["location"].split("·")[0].strip())}</title><style>{css}</style></head><body>{body}</body></html>'
with open(os.path.join(OUT, 'brochure.html'), 'w', encoding='utf-8') as fh:
    fh.write(doc)
print(total, 'pages;', sum(os.path.getsize(os.path.join(ASSETS, f)) for f in os.listdir(ASSETS)) // 1024, 'KB of pictures')
