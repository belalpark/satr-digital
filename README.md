# جولة المكتب

موقع تفاعلي لتسويق مكتب للإيجار: يستكشف فريق الجهة المستهدفة المكتب على **نموذج ثلاثي الأبعاد**
(Dollhouse بزاوية، مبني في Blender من مخطط الفرش المعتمد)، يختار غرفة فتظهر أولًا في سياقها
ثلاثي الأبعاد مع فرشها الرقمي وما حولها، ثم يدخل صورها الحقيقية وتفاصيلها، ويشاهد مسارات الحركة
لثلاث فئات (الموظفون، الإدارة التنفيذية، الضيوف).

- المواصفة: `docs/superpowers/specs/2026-11-06-office-digital-twin-design.md`
- خطة التنفيذ: `docs/superpowers/plans/2026-11-06-office-digital-twin-v1.md`، وتعديلات الجولة الثانية:
  `docs/superpowers/plans/2026-11-06-office-digital-twin-v2-3d.md`

## التشغيل محليًا

لا توجد خطوة بناء. أي خادم ملفات ثابت يكفي (الملفات تُحمَّل بـ`fetch` فلا يعمل فتح الملف مباشرة):

```bash
npm run serve            # http://127.0.0.1:8080
# أو
python3 -m http.server 8080
```

رابط مخصص لجهة: `index.html?team=اسم+الجهة` — يصبح الترحيب «مرحبًا بفريق …» ويظهر الاسم في شريط المخطط.
من دون `?team=` يكون الترحيب «مرحبًا بكم».

## الهيكل

```
index.html                 صفحة واحدة؛ التطبيق يبدّل المشاهد داخلها
assets/js/app.js           نقطة الدخول: تحميل السجل، التوجيه، الترحيب، لوحة الغرفة
assets/js/router.js        #/ ، #/plan[?scene=paths] ، #/room/:id (اللقطة الثانية) ، #/room/:id/photos ، #/room/:id/details
assets/js/plan.js          النموذج ثلاثي الأبعاد: الصورة + طبقة SVG مُسقطة بالـhomography + تكبير/تحريك + المسارات + اللقطة الثانية
assets/js/room.js          صور الغرفة الحقيقية (معرض)
assets/js/details.js       لوحة التفاصيل (3 أعمدة / تبويبان)، وفي وسطها اللقطة ثلاثية الأبعاد للغرفة
assets/js/geometry.js      دوال هندسية نقية (مختبرة): الإسقاط، الغلاف المحدّب، التكبير
assets/js/state.js         حفظ موضع المخطط لاستعادته عند العودة
data/office.json           سجل المكتب — مصدر الحقيقة الوحيد
media/twin/                رندرات النموذج ثلاثي الأبعاد (WebP بشفافية)
media/rooms, media/hero    الصور الحقيقية المنشورة (WebP) — الأصول خارج المستودع
tools/twin/                النموذج ثلاثي الأبعاد: layout.py (الجدران/الأبواب/الفرش)، build_twin.py (Blender)، finish.py
tools/                     اشتقاق الصور، إزالة الشعارات، تجميع نشرة Pages
tests/unit, tests/e2e      الاختبارات
docs/qa/<تاريخ>/           لقطات الاختبار الشامل لكل تسليم
```

## سجل المكتب `data/office.json`

- `office.welcome`: نص الترحيب، و`highlights` (الإجماليات) وكل رقم فيها محسوب من بنود `office.inventory`
  المذكورة في `from` (اختبار وحدة يتحقق من الجمع).
- `office.plan`: صورة النموذج ثلاثي الأبعاد ومقاسها، و`homography.floor`/`homography.top` (مصفوفتا 3×3)
  تُسقطان أي نقطة من المخطط المرجعي (1309×1201) على الصورة عند مستوى الأرضية وارتفاع قطع الجدران،
  و`focusFrame` (حجم اللقطة الثانية: 0.6 من الكادر الكامل).
- كل غرفة: `id`، `name`، `short`، `kind`، `status` (`ready` مكتملة / `soon` قريبًا / `info` معلومة فقط)،
  `polygon` بإحداثيات المخطط المرجعي، `label`، `summary`، `capacity`، `fixtures`، `use.current`، `photos[]`،
  و`focus` {image, rect} للغرف الجاهزة. لا حقل مساحة بقرار صاحب المشروع.
- `scenes`: `current` (الوضع الحالي) و`paths` (ثلاثة مسارات بألوانها ونقاط توقفها).

## النموذج ثلاثي الأبعاد (Blender)

إجرائي بالكامل (لا نماذج أو خامات من طرف ثالث). يحتاج Blender كوحدة بايثون:

```bash
uv venv --python 3.11 .blender && uv pip install --python .blender/bin/python bpy==5.0.1
.blender/bin/python tools/twin/build_twin.py                            # .twin-render/plan.png + focus-<room>.png + twin.json (≈30 دقيقة على معالجين)
.blender/bin/python tools/twin/build_twin.py --preview                  # معاينة سريعة بثلث الدقة
python3 tools/twin/finish.py --src .twin-render --out media/twin        # WebP + توهج خفيف للإضاءات
```

`finish.py` ينشر `media/twin/twin.json` مع الصور، واختبار وحدة يفشل إن لم تطابقه `homography` و`focus` في `data/office.json` (انسخهما عند تغيير الكاميرا).
الإعدادات المعتمدة هي القيم الافتراضية في `build_twin.py` (كاميرا 50مم، ميل 50°، دوران −14°، Cycles 64 عينة).

## الصور الحقيقية

الأصول (5184×3456) لا تُرفع. `tools/media_manifest.json` يحدد صور كل غرفة، ومناطق
الإزالة (`masks`) للصور التي تظهر فيها شعارات أو أشخاص؛ `tools/clean_photo.py` يزيلها
بنموذج LaMa (أو OpenCV عند غيابه)، و`tools/build_media.py` يشتق WebP بحجمين:

```bash
python3 tools/build_media.py --src "/path/to/الصور" --manifest tools/media_manifest.json \
  --model /path/to/big-lama.pt
```

## الاختبار

```bash
npm test                 # node --test: الهندسة والإسقاط، التوجيه، سلامة السجل والملفات والإجماليات
npm run test:e2e         # Playwright: المسار كاملًا على 1440×900 وiPhone 13 + لقطات في docs/qa/
```

إن كان Playwright مثبتًا خارج المشروع: `PLAYWRIGHT_MODULE=/path/to/playwright/index.js npm run test:e2e`.

## النشر

`.github/workflows/pages.yml` ينشر مع كل دفعة نشرة واحدة على GitHub Pages: `main` على الجذر
وكل فرع آخر على `/preview/<branch>/`، ومعها `build-info.json` (رقم الـcommit والفرع والوقت)
الذي يظهر مختصرًا في زاوية الصفحة.

- دفعة إلى أي فرع: تُشغَّل اختبارات الوحدات، ثم يُطلب تشغيل النشر على `main` (بيئة `github-pages`
  لا تقبل النشر إلا من الفرع الرئيسي)، فيُجمَّع الموقع من كل الفروع ويُنشر.
- رابط معاينة الفرع: `https://belalpark.github.io/satr-digital/preview/<branch>/`
- إعداد لمرة واحدة: Settings → Pages → Source: «GitHub Actions».
