# جولة المكتب

موقع تفاعلي لتسويق مكتب للإيجار: يستكشف فريق الجهة المستهدفة المكتب على **مخطط المكتب** (منظور علوي
ثنائي الأبعاد، الافتراضي) أو على **النموذج ثلاثي الأبعاد الحي** (three.js، مبني في Blender من مخطط الفرش
المعتمد ومُصدَّر glTF): تدوير 360° حول محور ثابت وتكبير، إضاءة نهارية أو مسائية، نقطتان وامضتان في كل
غرفة (زرقاء ← عرض الغرفة، حمراء ← تفاصيل الغرفة وصورها)، قائمة غرف ثابتة على اليمين، ومسارات حركة لثلاث
فئات (الموظفون، الإدارة التنفيذية، الضيوف). أسماء الغرف ورموزها وتوزيع الصور عليها تتبع «دليل المساحات»
المرجعي من صاحب المشروع (`tools/key_index.json`، المخطط KP-08).

- المواصفة: `docs/superpowers/specs/2026-11-06-office-digital-twin-design.md`
- خطة التنفيذ: `docs/superpowers/plans/2026-11-06-office-digital-twin-v1.md`، تعديلات الجولة الثانية:
  `docs/superpowers/plans/2026-11-06-office-digital-twin-v2-3d.md`، والثالثة: `docs/superpowers/plans/2026-11-06-office-digital-twin-v3-live.md`
- دليل تصوير 360° لتجربة VR: `docs/vr-360-shooting-guide.md`

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
assets/js/app.js           نقطة الدخول: التوجيه، الهيدر، الترحيب، القائمة الجانبية وبطاقة الغرفة، المشاهد
assets/js/router.js        #/ ، #/plan[?scene=paths] ، #/room/:id (المنظور القريب) ، #/room/:id/photos ، #/room/:id/details
assets/js/plan2d.js        مخطط المكتب ثنائي الأبعاد: الصورة + طبقة SVG (الغرف، التعتيم، المسارات)، سحب وتكبير — الواجهة نفسها التي يقدمها العارض الحي
assets/js/twin3d.js        العارض الحي (three.js): تحميل glTF، التدوير حول محور ثابت/التكبير، نهار/مساء، مُنظِّم جودة تكيفي، التركيز على غرفة، المسارات، الإسقاط للشاشة
assets/js/overlay.js       النقاط الوامضة والمسميات (داخل المخطط أو خارجه بأسهم) فوق العارض
assets/js/room.js          صور الغرفة الحقيقية (معرض)
assets/js/details.js       لوحة التفاصيل (3 أعمدة / تبويبان)، وفي وسطها رندر الغرفة أو لقطة من النموذج الحي
assets/js/geometry.js      دوال هندسية نقية (مختبرة)
assets/vendor/three-bundle.js  three.js 0.187 + GLTFLoader + OrbitControls + RoomEnvironment (حزمة واحدة، بلا CDN)
data/office.json           سجل المكتب — مصدر الحقيقة الوحيد
media/plan/office-2d.webp  مخطط المكتب (النسخة الأولى، 2× المخطط المرجعي 1309×1201)
media/twin/web/            النموذج للمتصفح: office.glb + scene.json (الإضاءات ومراسي الغرف) + خامات مخبوزة
media/twin/rooms/          لقطات Cycles قريبة لكل غرفة (تُعرض في صفحة التفاصيل)
media/twin/                رندرات Cycles الثابتة (اللقطة الثانية لغرفة الاجتماعات، للتفاصيل)
media/rooms, media/hero    الصور الحقيقية المنشورة (WebP) — الأصول خارج المستودع
tools/twin/                layout.py (الجدران/الأبواب/الفرش)، build_twin.py (Blender/Cycles)، export_web.py (glTF)، finish.py
tools/key_index.json       دليل المساحات من صاحب المشروع: رمز كل فراغ ← أرقام صوره (المرجع المعتمد لتوزيع الصور)
tools/photos_proposal.json التوزيع المقترح السابق (قبل الدليل) مع أسباب استبعاد الصور
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
- كل غرفة أيضًا: `key` (رمزها في دليل المساحات)، `hasModel` (نقطة زرقاء؛ `false` لفراغ يظهر في القائمة فقط مثل الممرات)،
  `hasPhotos` (نقطة حمراء)، و`render` (لقطة Cycles للتفاصيل إن وُجدت).
- `office.plan2d`: صورة مخطط المكتب ثنائي الأبعاد، و`office.defaultView` (`2d`).
- `office.brand`: هوية سطر العقارية في الترحيب والهيدر (الاسم، الشعار اللفظي، `logo` = مسار ملف الشعار عند توفره وإلا `null`، الألوان)، و`office.welcome.location` (الموقع العام: واجهة روشن للأعمال)، و`office.footer` (فوتر مختصر من satr-ksa.com: الهاتفان، الموقع، الحسابات، الروابط النظامية، الحقوق).
- `office.model`: مسارات النموذج الحي (glb + scene.json).
- `scenes`: `current` («توزيعات المكاتب») و`paths` (ثلاثة مسارات بألوانها ونقاط توقفها؛ اختبار وحدة يضمن أنها لا تعبر الغرف).
- التوجيه: `#/plan[?scene=paths][&view=2d|3d]` و`#/room/<id>[?view=…]` و`#/room/<id>/photos` و`#/room/<id>/details`؛ طريقة العرض تُحفظ للزائر.

## النموذج ثلاثي الأبعاد (Blender → المتصفح)

إجرائي بالكامل (لا نماذج أو خامات من طرف ثالث). يحتاج Blender كوحدة بايثون:

```bash
uv venv --python 3.11 .blender && uv pip install --python .blender/bin/python bpy==5.0.1
.blender/bin/python tools/twin/export_web.py --out media/twin/web       # office.glb + scene.json + خامات مخبوزة (≈3 دقائق)
.blender/bin/python tools/twin/build_twin.py                            # رندرات Cycles الثابتة (≈30 دقيقة على معالجين)
.blender/bin/python tools/twin/build_twin.py --preview                  # معاينة سريعة بثلث الدقة
.blender/bin/python tools/twin/build_twin.py --room lounge,ceo --daylight --res 1600x1000 --samples 48 --out .twin-render   # لقطات قريبة للغرف (أضف --camera-report لمعرفة اتجاه الكاميرا ونسبة الأرضية المرئية دون رندر)
python3 tools/twin/finish.py --src .twin-render --out media/twin        # WebP + توهج خفيف للإضاءات
```

حزمة three.js: `npm pack three@0.187.0` ثم esbuild على `entry.js` (three + GLTFLoader + OrbitControls + RoomEnvironment) → `assets/vendor/three-bundle.js`.

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
npm test                 # node --test: الهندسة، التوجيه، سلامة السجل والملفات، المسارات، مطابقة بيانات النموذج
npm run test:e2e         # Playwright (WebGL عبر SwiftShader): المسار كاملًا على 1440×900 وiPhone 13 + لقطات في docs/qa/
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
