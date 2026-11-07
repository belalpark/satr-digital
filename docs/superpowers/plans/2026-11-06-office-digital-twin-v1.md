# التوأم الرقمي للمكتب — خطة تنفيذ النسخة الأولى

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** موقع ثابت يمرّ بالمسار: ترحيب → مخطط Dollhouse تفاعلي → غرفة الاجتماعات الكبرى بصورها الحقيقية → العودة لنفس الموضع → لوحة التفاصيل، على الكمبيوتر والجوال، منشور على GitHub Pages من فرع مستقل.

**Architecture:** صفحة واحدة بـES modules بلا بناء؛ `office.json` مصدر الحقيقة؛ المخطط صورة تصيير + طبقة SVG بمضلعات الغرف؛ التوجيه بالـhash؛ التكبير بتحويل CSS محسوب من هندسة المضلع.

**Tech Stack:** HTML/CSS/JS (ES2022, بلا مكتبات)، SVG، Node 22 (`node --test`)، Playwright (مثبت مسبقًا) للاختبار الشامل، GitHub Actions + Pages.

**Spec:** `docs/superpowers/specs/2026-11-06-office-digital-twin-design.md`

## Global Constraints

- لا حقل مساحة ولا ذكر للمساحات في أي شاشة.
- لا شعارات داخل المكتب؛ أي صورة تُنشر تمر على `tools/clean_photo.py` إن ظهر فيها شعار أو شخص.
- الفوتر وبيانات المسوّق مؤجلة لآخر مرحلة (placeholder فارغ الآن).
- كل المسارات نسبية (بلا `/` بادئة) ليعمل الموقع تحت `/preview/<branch>/`.
- الخط IBM Plex Sans Arabic من `assets/fonts/` (لا Google Fonts).
- إحداثيات المضلعات على المرجع 1309×1201 (`office.plan.width/height`) وإن كانت الصورة المنشورة مكبّرة ×2.
- الغرف `status: soon` لا تفتح وتُظهر وسم «قريبًا».

## Review Focus

- رابط بـ`?team=` يحوي عربية مشفّرة (`%D8%...`) أو فارغًا: يجب فك الترميز وإظهار الاسم الافتراضي عند الفراغ، وتعقيم النص (لا HTML). → اختبار في المهمة 2.
- hash لغرفة غير موجودة (`#/room/xyz`) أو `soon`: يجب العودة إلى `#/plan` بدل صفحة فارغة. → اختبار في المهمة 2 و9.
- زر الرجوع في المتصفح من التفاصيل → الغرفة → المخطط يجب أن يعمل دون كسر الحالة. → اختبار في المهمة 9.
- تغيير حجم النافذة أثناء التكبير على غرفة (تدوير الجوال): التحويل يُعاد حسابه من الحالة لا من القيم القديمة. → اختبار وحدة في المهمة 1 (نفس الحدود مع viewport مختلف).
- صورة غرفة لا تُحمّل (مسار خاطئ): اختبار السلامة يفشل قبل النشر. → المهمة 3.

---

### Task 1: الهندسة النقية `assets/js/geometry.js`

**Files:** Create `assets/js/geometry.js`, Test `tests/unit/geometry.test.mjs`

**Interfaces (Produces):**
- `bbox(polygon: number[][]) -> {x, y, w, h}`
- `centroid(polygon) -> {x, y}` (متوسط الرؤوس)
- `pointInPolygon(point: [x,y], polygon) -> boolean` (ray casting)
- `zoomTransform(box, viewport: {w, h}, opts: {padding=0.15, maxScale=4, planW, planH, fitScale}) -> {scale, tx, ty}`
  حيث التحويل يطبَّق على حاوية المخطط المعروضة بمقياس `fitScale` (ملاءمة الشاشة)؛ النتيجة تجعل مركز الصندوق في مركز الـviewport.
- `pathLength(points: number[][]) -> number`

- [ ] Step 1: اكتب الاختبارات: مستطيل `[[0,0],[10,0],[10,20],[0,20]]` → bbox `{x:0,y:0,w:10,h:20}`، centroid `{x:5,y:10}`؛ `pointInPolygon([5,5])` صحيح و`[15,5]` خطأ؛ `zoomTransform({x:100,y:100,w:100,h:100},{w:1000,h:800},{fitScale:0.5,padding:0.1,maxScale:4,planW:1309,planH:1201})` → scale ≤ 4 والمركز المحوَّل = (500,400) بدقة 1e-6؛ تغيير viewport إلى `{w:400,h:800}` يعطي مركزًا (200,400).
- [ ] Step 2: `node --test tests/unit` → يفشل (module not found).
- [ ] Step 3: نفّذ الدوال.
- [ ] Step 4: `node --test tests/unit` → PASS.
- [ ] Step 5: commit `feat: geometry helpers for plan zoom`.

### Task 2: التوجيه والحالة `assets/js/router.js`, `assets/js/state.js`

**Files:** Create `assets/js/router.js`, `assets/js/state.js`, Test `tests/unit/router.test.mjs`

**Interfaces (Produces):**
- `parseHash(hash: string) -> {view: 'welcome'|'plan'|'room'|'details', roomId?: string, scene?: string}`
- `buildHash(route) -> string`
- `teamNameFromSearch(search: string, fallback: string) -> string` (يفك الترميز، يقصّ 60 حرفًا، يعيد fallback عند الفراغ)
- `saveViewState(obj)`, `loadViewState() -> obj|null` (sessionStorage مع try/catch)

- [ ] Step 1: اختبارات: `parseHash('')` → welcome؛ `'#/plan?scene=visitor-path'` → plan + scene؛ `'#/room/meeting-large/details'` → details + roomId؛ `teamNameFromSearch('?team=%D8%B4%D8%B1%D9%83%D8%A9%20%D9%86%D9%88%D8%B1','فريقكم')` → `'شركة نور'`؛ فارغ → `'فريقكم'`؛ `'<b>x</b>'` يبقى نصًا (لا يُفسَّر؛ يُعرض بـtextContent).
- [ ] Step 2: يفشل. Step 3: نفّذ. Step 4: يمر. Step 5: commit `feat: hash router and view state`.

### Task 3: سلامة السجل `tests/unit/data.test.mjs`

- [ ] Step 1: اختبار يقرأ `data/office.json` ويتحقق: كل `rooms[].id` فريد؛ كل مضلع ≥ 3 نقاط داخل 0..width/height؛ كل `photos[].src/thumb` موجود على القرص؛ كل `roomId` في المشاهد موجود؛ لا مفتاح اسمه `area` أو يحتوي `area_` في أي غرفة؛ الغرف `ready` لها ≥ 4 صور و`capacity` و`fixtures.items` غير فارغة.
- [ ] Step 2: يفشل الآن لأن صور الغرفة غير موجودة بعد (متوقع) → يمر بعد المهمة 6.
- [ ] Step 3: commit `test: office.json integrity checks`.

### Task 4: الهيكل والترحيب `index.html`, `assets/css/app.css`, `assets/js/app.js`

**Interfaces (Produces):** `app.js` يصدّر `init()`; حاويات: `#view-welcome`, `#view-plan`, `#view-room`, `#view-details`, `#app-footer` (فارغ، للفوتر لاحقًا), `#build-sha`.

- [ ] Step 1: `index.html` بـ`lang="ar" dir="rtl"`، `<title>التوأم الرقمي للمكتب</title>`، تحميل الخط بـ`@font-face`، و`<script type="module" src="assets/js/app.js">`.
- [ ] Step 2: `app.js`: يحمّل `data/office.json` و`build-info.json` (اختياري؛ عند 404 يكتب `dev`), يقرأ `team` من `location.search`، يستمع لـ`hashchange`، ويبدّل `[data-view]` حسب `parseHash`.
- [ ] Step 3: مشهد الترحيب: صورة `office.heroImage` خلفية كاملة، تدرّج، «مرحبًا بفريق {team}»، العنوان الفرعي، زر «ابدأ الجولة» → `#/plan`.
- [ ] Step 4: تحقق يدوي بـPlaywright screenshot على 1440×900 و390×844.
- [ ] Step 5: commit `feat: app shell and welcome view`.

### Task 5: المخطط `assets/js/plan.js`

**Interfaces (Produces):** `createPlan(container, data, {onRoomOpen})` يعيد `{setScene(id), setProposed(bool), zoomToRoom(id) -> Promise, resetZoom(animated), restore(state), getState()}`.

- [ ] Step 1: الصورة داخل `.plan-stage > .plan-world` مع `<svg viewBox>` فوقها؛ المضلعات `path.room[data-id]` مع `title`; الأسماء `text.room-label`.
- [ ] Step 2: التمرير يبرز؛ النقر على `ready` → `zoomToRoom` (700ms) ثم `onRoomOpen(id)`; على `soon` → تلميح «قريبًا» 1.5 ثانية.
- [ ] Step 3: التكبير: احسب `fitScale` من قياس الحاوية، ثم `zoomTransform` على `.plan-world` (`transform: translate(tx,ty) scale(s)`)؛ أعد الحساب عند `resize`.
- [ ] Step 4: المشاهد: `current` (لا طبقات)؛ `visitor-path`: `polyline` بالـwaypoints مع `stroke-dasharray` ورسوم `dashoffset` + دوائر مرقمة للمحطات؛ `team-layout`: تعبئة المضلعات بألوان `groups` (حدود متقطعة) وشارة «تصوّر مقترح»، ودوائر `seatClusters` بالعدد؛ مبدّل الحالي/المقترح يبدّل الوسوم من `use.current/proposed`.
- [ ] Step 5: شريط المشاهد في `index.html` يربط بـ`setScene` ويحدّث `?scene=` في الـhash.
- [ ] Step 6: لقطات تحقق (المشاهد الثلاثة، كمبيوتر وجوال). commit `feat: interactive dollhouse plan with scenes`.

### Task 6: صور الغرفة ومشهد الغرفة `tools/clean_photo.py`, `assets/js/room.js`

- [ ] Step 1: `tools/clean_photo.py --in IMG --out OUT --mask x,y,w,h[;...]` يزيل المناطق (LaMa إن توفر، وإلا `cv2.inpaint` Telea). نظّف علم الشركة الصغير في صور غرفة الاجتماعات المختارة (0287، 0273، 0283، 0286، 0272، 0282، 0288، 0284) وراجع النتيجة بصريًا.
- [ ] Step 2: `tools/media_manifest.json` ثم `python3 tools/build_media.py --manifest` → 8 صور + مصغّرات. شغّل `node --test tests/unit` → data.test يمر.
- [ ] Step 3: `createRoom(container, data)` يعيد `{show(roomId, {fromPlan: boolean})}`: صورة كبيرة `img.room-photo` مع تعليق، شريط مصغّرات، أسهم، لوحة مفاتيح (←/→)، سحب لمسي بسيط؛ عنوان الغرفة والملخص وشارة السعة؛ أزرار `#btn-back-plan` و`#btn-details` و`#btn-pano` (مخفي عند `pano: null`).
- [ ] Step 4: الانتقال: المخطط يُثبّت تحويل التكبير ثم يتلاشى مشهد الغرفة فوقه؛ «العودة للمخطط» تعكس: إظهار المخطط بالتحويل المحفوظ ثم `resetZoom(true)` ثم استعادة المشهد.
- [ ] Step 5: لقطات تحقق. commit `feat: room view with cleaned photos`.

### Task 7: لوحة التفاصيل `assets/js/details.js`

- [ ] Step 1: `createDetails(container, data, plan)` يعيد `{show(roomId)}`؛ تخطيط `grid` بثلاثة أعمدة ≥1024px (صور | مخطط | مميزات) وتبويبان تحتها دون ذلك (`role=tablist`).
- [ ] Step 2: المخطط في الوسط: نسخة ثانية من المخطط (`createPlan` بوضع `static: true`) مكبّرة على الغرفة مع إبراز.
- [ ] Step 3: المميزات: السعة + الأساس، التجهيزات + المصدر، الاستخدام الحالي/المقترح (بشارتين مميزتين).
- [ ] Step 4: زر إغلاق → `#/room/:id`. لقطات. commit `feat: room details panel`.

### Task 8: النشر `.github/workflows/pages.yml`, `build-info`

- [ ] Step 1: workflow على `push` لكل الفروع + `workflow_dispatch`: job `build` يستنسخ المستودع كاملًا (`fetch-depth: 0`)، ينسخ ملفات الموقع من `main` إلى `dist/`، ومن كل فرع بعيد غير main إلى `dist/preview/<branch>/`، يكتب `build-info.json` في كل نسخة، `actions/configure-pages@v5` مع `enablement: true`، `upload-pages-artifact@v3`، ثم job `deploy` بـ`deploy-pages@v4`. `concurrency: pages`.
- [ ] Step 2: `app.js` يعرض `sha.slice(0,7)` في `#build-sha` و`dev` محليًا.
- [ ] Step 3: `.nojekyll`، `README.md` (التشغيل محليًا: `python3 -m http.server`؛ الاختبارات).
- [ ] Step 4: commit `ci: GitHub Pages deploy with per-branch previews`.

### Task 9: الاختبار الشامل `tests/e2e/flow.mjs`

- [ ] Step 1: خادم ثابت محلي (`node:http`) على منفذ عشوائي؛ Playwright chromium؛ لكل من desktop(1440×900) و`devices['iPhone 13']`: افتح `/?team=شركة نور` → تحقق من نص الترحيب → انقر «ابدأ الجولة» → `#/plan` → انقر مضلع `meeting-large` → انتظر `#/room/meeting-large` والصورة محمّلة (`naturalWidth>0`) → «العودة للمخطط» → `#/plan` → افتح الغرفة مجددًا → «تفاصيل الغرفة» → `#/room/meeting-large/details` → على الجوال انقر تبويب «المميزات» → زر الرجوع في المتصفح ×2 → `#/plan`. لقطة بعد كل خطوة في `docs/qa/<yyyy-mm-dd>/<device>-<nn>-<step>.png`.
- [ ] Step 2: أضف: `#/room/nope` → يعيد `#/plan`؛ نقر غرفة `soon` لا يغيّر الـhash.
- [ ] Step 3: شغّل وأصلح حتى يمر. commit `test: end-to-end visitor flow with screenshots`.

### Task 10: الفرع والـPR

- [ ] Step 1: ادفع `main` (README + هيكل) ثم الفرع `feat/office-tour-v1` بكل العمل.
- [ ] Step 2: تحقق من نجاح الـworkflow وفتح رابط المعاينة وأن `build-info.json` فيه sha الفرع.
- [ ] Step 3: افتح PR بالعربية: الرابط، sha، ما نُفّذ، ما اختُبر (مع لقطات)، نقاط القرار (وجهة زر الحجز، التصوّر المقترح لتوزيع الفريق، الفوتر، الصور الملغاة شعاراتها).
