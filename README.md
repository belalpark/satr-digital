# التوأم الرقمي للمكتب

موقع تفاعلي لتسويق مكتب للإيجار: يستكشف فريق الجهة المستهدفة المكتب على منظور Dollhouse،
يدخل الغرف بصورها الحقيقية، يقرأ تفاصيل كل غرفة، ويشاهد مشاهد «مسار الزائر» و«توزيع فريقكم»
قبل حجز المعاينة.

- المواصفة: `docs/superpowers/specs/2026-11-06-office-digital-twin-design.md`
- خطة التنفيذ: `docs/superpowers/plans/2026-11-06-office-digital-twin-v1.md`

## التشغيل محليًا

لا توجد خطوة بناء. أي خادم ملفات ثابت يكفي (الملفات تُحمَّل بـ`fetch` فلا يعمل فتح الملف مباشرة):

```bash
npm run serve            # http://127.0.0.1:8080
# أو
python3 -m http.server 8080
```

رابط مخصص لجهة: `index.html?team=اسم+الجهة` — يظهر الاسم في الترحيب وفي شريط المخطط.

## الهيكل

```
index.html                 صفحة واحدة؛ التطبيق يبدّل المشاهد داخلها
assets/js/app.js           نقطة الدخول: تحميل السجل، التوجيه، تركيب المشاهد
assets/js/router.js        توجيه بالـhash: #/ ، #/plan?scene=… ، #/room/:id ، #/room/:id/details
assets/js/plan.js          منظور Dollhouse: الصورة + طبقة SVG + تكبير/تحريك + المشاهد
assets/js/room.js          مشهد الغرفة (معرض الصور)
assets/js/details.js       لوحة التفاصيل (3 أعمدة / تبويبان)
assets/js/geometry.js      دوال هندسية نقية (مختبرة)
assets/js/state.js         حفظ موضع المخطط لاستعادته عند العودة
data/office.json           سجل المكتب — مصدر الحقيقة الوحيد
media/                     الصور المنشورة (WebP) — الأصول خارج المستودع
tools/                     اشتقاق الصور، إزالة الشعارات، تجميع نشرة Pages
tests/unit, tests/e2e      الاختبارات
docs/qa/<تاريخ>/           لقطات الاختبار الشامل لكل تسليم
```

## سجل المكتب `data/office.json`

كل غرفة سجل واحد: `id`، `name`، `short`، `kind`، `status` (`ready` مكتملة / `soon` قريبًا /
`info` معلومة فقط)، `polygon` بإحداثيات صورة المخطط المرجعية (1309×1201)، `label`،
`summary`، `capacity` {seats, basis}، `fixtures` {source, items}، `use` {current, proposed}،
`photos[]` {src, thumb, caption}، `pano`. لا حقل مساحة بقرار صاحب المشروع.

## الصور

الأصول (5184×3456) لا تُرفع. `tools/media_manifest.json` يحدد صور كل غرفة، ومناطق
الإزالة (`masks`) للصور التي تظهر فيها شعارات أو أشخاص؛ `tools/clean_photo.py` يزيلها
بنموذج LaMa (أو OpenCV عند غيابه)، و`tools/build_media.py` يشتق WebP بحجمين:

```bash
python3 tools/build_media.py --src "/path/to/الصور" --manifest tools/media_manifest.json \
  --model /path/to/big-lama.pt
```

## الاختبار

```bash
npm test                 # node --test: الهندسة، التوجيه، سلامة السجل والملفات
npm run test:e2e         # Playwright: المسار كاملًا على 1440×900 وiPhone 13 + لقطات في docs/qa/
```

إن كان Playwright مثبتًا خارج المشروع: `PLAYWRIGHT_MODULE=/path/to/playwright/index.js npm run test:e2e`.

## النشر

`.github/workflows/pages.yml` ينشر مع كل دفعة نشرة واحدة على GitHub Pages: `main` على الجذر
وكل فرع آخر على `/preview/<branch>/`، ومعها `build-info.json` (رقم الـcommit والفرع والوقت)
الذي يظهر مختصرًا في زاوية الصفحة.
