// Live 3D office model (three.js): 360° orbit, pan, zoom, day / evening lighting,
// room picking, focus fly-to with neighbour dimming, route ribbons, and screen
// anchors so the page can place its dots and labels over the model.
//
// Coordinates: the model is exported from Blender (metres, z-up) as glTF (y-up),
// so a plan point (x, y) maps to three.js (X = x_m, Z = -y_m) with world height Y.
import * as T from '../vendor/three-bundle.js';

const DEG = Math.PI / 180;

export async function createTwin3D(container, data, opts = {}) {
  const base = opts.base || 'media/twin/web/';
  const res = await fetch(`${base}scene.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`scene.json: ${res.status}`);
  const info = await res.json();
  const rooms = new Map(data.rooms.map((r) => [r.id, r]));
  const anchors = new Map(info.rooms.map((r) => [r.id, r]));

  // ---------- renderer / scene ----------
  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // the sun and the model never move: one shadow pass per lighting change
  renderer.domElement.className = 'twin-canvas';
  container.append(renderer.domElement);

  const scene = new T.Scene();
  const pmrem = new T.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new T.RoomEnvironment(), 0.04).texture;

  const camera = new T.PerspectiveCamera(30, 1, 0.3, 500);
  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = 78 * DEG;
  controls.minPolarAngle = 8 * DEG;
  controls.minDistance = 6;
  controls.maxDistance = 120;
  controls.enablePan = true;
  controls.zoomToCursor = true;

  // ---------- lighting rigs ----------
  const sun = new T.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-16, 34, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 100 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  const sky = new T.HemisphereLight(0xd6e6ff, 0x4a4036, 0.9);
  scene.add(sun, sky);

  // Evening rig: a budget of real point lights (GPU cost grows with each one) placed
  // by clustering the exported ceiling pools, plus the model's own emissive strips.
  const nightGroup = new T.Group();
  const LIGHT_BUDGET = 18;
  const pools = info.lights.filter((l) => !l.lamp).map((l) => ({ x: l.pos[0], z: -l.pos[1], y: l.pos[2], c: l.color }));
  const clusters = kmeans(pools, Math.min(LIGHT_BUDGET, pools.length));
  for (const cl of clusters) {
    const p = new T.PointLight(new T.Color(1.0, 0.8, 0.56), 0, 12 + 1.6 * Math.sqrt(cl.n), 1.6);
    p.userData.on = 30 * Math.sqrt(cl.n);
    p.position.set(cl.x, 3.0, cl.z);
    nightGroup.add(p);
  }
  for (const l of info.lights.filter((x) => x.lamp)) {
    const p = new T.PointLight(new T.Color(...l.color), 0, 6, 2);
    p.userData.on = 7;
    p.position.set(l.pos[0], l.pos[2], -l.pos[1]);
    nightGroup.add(p);
  }
  scene.add(nightGroup);

  function kmeans(points, k) {
    if (!points.length) return [];
    let centres = points.filter((_, i) => i % Math.max(1, Math.floor(points.length / k)) === 0).slice(0, k).map((p) => ({ x: p.x, z: p.z }));
    let groups = [];
    for (let iter = 0; iter < 12; iter++) {
      groups = centres.map(() => []);
      for (const p of points) {
        let best = 0;
        let bd = Infinity;
        centres.forEach((c, i) => { const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2; if (d < bd) { bd = d; best = i; } });
        groups[best].push(p);
      }
      centres = centres.map((c, i) => groups[i].length ? { x: groups[i].reduce((a, p) => a + p.x, 0) / groups[i].length, z: groups[i].reduce((a, p) => a + p.z, 0) / groups[i].length } : c);
    }
    return centres.map((c, i) => ({ ...c, n: groups[i].length })).filter((c) => c.n > 0);
  }

  let mode = 'day';
  function setLighting(next) {
    mode = next === 'night' ? 'night' : 'day';
    const night = mode === 'night';
    sun.intensity = night ? 0.05 : 2.4;
    sun.color.set(night ? 0x9fb4ff : 0xfff1dc);
    sky.intensity = night ? 0.12 : 0.9;
    sky.color.set(night ? 0x3a4a7a : 0xd6e6ff);
    for (const l of nightGroup.children) l.intensity = night ? l.userData.on : 0;
    renderer.toneMappingExposure = night ? 1.25 : 0.95;
    scene.environmentIntensity = night ? 0.12 : 1.0;
    container.dataset.lighting = mode;
    for (const m of emissives) m.emissiveIntensity = night ? m.userData.nightEmissive : m.userData.dayEmissive;
    renderer.shadowMap.needsUpdate = true;
    requestRender();
  }

  // ---------- model ----------
  const loader = new T.GLTFLoader();
  const gltf = await loader.loadAsync(`${base}office.glb`);
  const model = gltf.scene;
  const emissives = [];
  const roomOf = new Map(); // mesh -> room id (by floor polygon containment of the mesh centre)
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (m.transparent) {
        o.castShadow = false;
        m.depthWrite = false;
        m.opacity = Math.min(m.opacity, 0.28);
      }
      if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05) {
        m.userData.dayEmissive = Math.min(m.emissiveIntensity, 0.6);
        m.userData.nightEmissive = Math.min(m.emissiveIntensity, 6);
        m.emissiveIntensity = m.userData.dayEmissive;
        emissives.push(m);
      }
    }
  });
  scene.add(model);

  // ground shadow catcher below the slab
  const ground = new T.Mesh(new T.PlaneGeometry(400, 400), new T.ShadowMaterial({ opacity: 0.38 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -info.slab - 0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- room floors: pick targets + highlight/dim overlays ----------
  const roomGroup = new T.Group();
  const roomMeshes = new Map();
  for (const a of info.rooms) {
    const shape = new T.Shape(a.floor.map(([x, y]) => new T.Vector2(x, y)));
    const geo = new T.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2); // shape (x, y) -> (x, 0, -y)
    const mat = new T.MeshBasicMaterial({ color: 0x3fd0b0, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new T.Mesh(geo, mat);
    mesh.position.y = 0.012;
    mesh.userData.roomId = a.id;
    mesh.renderOrder = 2;
    roomGroup.add(mesh);
    roomMeshes.set(a.id, mesh);
  }
  scene.add(roomGroup);

  // dimming veil used in focus: dark translucent prisms over every other room
  const veilGroup = new T.Group();
  veilGroup.visible = false;
  for (const a of info.rooms) {
    const shape = new T.Shape(a.floor.map(([x, y]) => new T.Vector2(x, y)));
    const geo = new T.ExtrudeGeometry(shape, { depth: info.wallHeight + 0.3, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ color: 0x0b0d10, transparent: true, opacity: 0.42, depthWrite: false }));
    mesh.position.y = 0.01;
    mesh.userData.roomId = a.id;
    mesh.renderOrder = 3;
    veilGroup.add(mesh);
  }
  scene.add(veilGroup);

  // ---------- routes ----------
  const animatedMaps = [];
  function stripeTexture() {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 4;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 4);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(36, 0, 28, 4);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = T.RepeatWrapping;
    tex.wrapT = T.ClampToEdgeWrapping;
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }
  const routeGroup = new T.Group();
  routeGroup.visible = false;
  const routeMeshes = new Map();
  // plan px -> three.js: X = (x - cx) / scale, Z = (y - cy) / scale (plan y grows downward = +Z toward the viewer)
  const toWorld = ([x, y]) => new T.Vector3((x - info.origin.cx) / info.scale, 0.08, (y - info.origin.cy) / info.scale);
  if (data.scenes && data.scenes.paths) {
    data.scenes.paths.routes.forEach((route, i) => {
      const pts = route.points.map(toWorld).map((p) => p.add(new T.Vector3(0, 0.3 + 0.03 * i, 0)));
      const curve = new T.CatmullRomCurve3(pts, false, 'catmullrom', 0.12);
      const segs = Math.max(96, pts.length * 32);
      const outline = new T.Mesh(
        new T.TubeGeometry(curve, segs, 0.24, 10, false),
        new T.MeshBasicMaterial({ color: 0x0b0d10, transparent: true, opacity: 0.4, depthWrite: false }),
      );
      const tube = new T.Mesh(
        new T.TubeGeometry(curve, segs, 0.17, 10, false),
        new T.MeshBasicMaterial({ color: new T.Color(route.color), map: stripeTexture(), transparent: false, toneMapped: false }),
      );
      tube.material.map.repeat.set(Math.round(curve.getLength() / 1.2), 1);
      animatedMaps.push(tube.material.map);
      outline.renderOrder = 4;
      tube.renderOrder = 5;
      const g = new T.Group();
      g.add(outline, tube);
      // stop markers
      route.stops.forEach((s, j) => {
        const p = toWorld(s.at);
        const ring = new T.Mesh(
          new T.RingGeometry(0.5, 0.78, 32),
          new T.MeshBasicMaterial({ color: new T.Color(route.color), side: T.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(p.x, 0.32 + 0.03 * i, p.z);
        ring.renderOrder = 4;
        g.add(ring);
        if (j === 0) {
          const start = new T.Mesh(new T.CircleGeometry(0.45, 24), new T.MeshBasicMaterial({ color: 0xffffff, depthWrite: false }));
          start.rotation.x = -Math.PI / 2;
          start.position.set(p.x, 0.33 + 0.03 * i, p.z);
          g.add(start);
        }
      });
      g.userData.routeId = route.id;
      routeGroup.add(g);
      routeMeshes.set(route.id, g);
    });
  }
  scene.add(routeGroup);

  // ---------- camera framing ----------
  let userMoved = false; // set on the first pointer/wheel interaction: resizes then keep the visitor's view
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bounds = new T.Box3().setFromObject(model);
  const centre = bounds.getCenter(new T.Vector3());
  const size = bounds.getSize(new T.Vector3());
  const home = { target: new T.Vector3(centre.x, 0.6, centre.z), azimuth: -14 * DEG, polar: 40 * DEG, distance: 0 };

  function fitDistance(radius) {
    const vFov = camera.fov * DEG;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const fov = Math.min(vFov, hFov);
    return radius / Math.sin(fov / 2) * 1.06;
  }

  /** Distance at which the 8 corners of `box` all fit the frame from (azimuth, polar) looking at `target`. */
  function fitBox(box, target, azimuth, polar, margin = 0.06) {
    const savedPos = camera.position.clone();
    const savedTarget = controls.target.clone();
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new T.Vector3(x, y, z));
    let lo = 4;
    let hi = 300;
    const tmp = new T.Vector3();
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      placeCamera(target, azimuth, polar, mid);
      camera.updateMatrixWorld();
      let ok = true;
      for (const c of corners) {
        tmp.copy(c).project(camera);
        if (Math.abs(tmp.x) > 1 - margin * 2 || Math.abs(tmp.y) > 1 - margin * 2 || tmp.z > 1) { ok = false; break; }
      }
      if (ok) hi = mid;
      else lo = mid;
    }
    camera.position.copy(savedPos);
    controls.target.copy(savedTarget);
    controls.update();
    camera.updateMatrixWorld();
    return hi;
  }

  function placeCamera(target, azimuth, polar, distance) {
    camera.position.set(
      target.x + distance * Math.sin(polar) * Math.sin(azimuth),
      target.y + distance * Math.cos(polar),
      target.z + distance * Math.sin(polar) * Math.cos(azimuth),
    );
    controls.target.copy(target);
    controls.update();
  }

  // tweening between camera states
  let tween = null;
  let tweenResolve = null;
  /** Ends the flight in progress (its promise resolves) so a direct placement is not undone by later frames. */
  function cancelTween() {
    if (!tween && !tweenResolve) return;
    const r = tweenResolve;
    tween = null;
    tweenResolve = null;
    if (r) r();
  }
  /** Immediate camera placement that also supersedes any flight in progress. */
  function jumpTo(target, azimuth, polar, distance) {
    cancelTween();
    placeCamera(target, azimuth, polar, distance);
  }
  function flyTo(target, azimuth, polar, distance, ms = 1100) {
    cancelTween(); // supersede the flight in progress
    if (reducedMotion) { placeCamera(target, azimuth, polar, distance); requestRender(); return Promise.resolve(); }
    const from = {
      target: controls.target.clone(),
      azimuth: Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z),
      polar: Math.acos(Math.min(1, Math.max(-1, (camera.position.y - controls.target.y) / camera.position.distanceTo(controls.target)))),
      distance: camera.position.distanceTo(controls.target),
    };
    // shortest way round
    let dAz = azimuth - from.azimuth;
    while (dAz > Math.PI) dAz -= 2 * Math.PI;
    while (dAz < -Math.PI) dAz += 2 * Math.PI;
    const t0 = performance.now();
    return new Promise((resolve) => {
      tweenResolve = resolve;
      tween = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        const tgt = from.target.clone().lerp(target, e);
        placeCamera(tgt, from.azimuth + dAz * e, from.polar + (polar - from.polar) * e, from.distance + (distance - from.distance) * e);
        if (k >= 1) {
          tween = null;
          tweenResolve = null;
          resolve();
        }
      };
      requestRender();
    });
  }

  function roomCircle(id) {
    const a = anchors.get(id);
    const xs = a.floor.map((p) => p[0]);
    const ys = a.floor.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2; // half of the longer side
    return { centre: new T.Vector3(cx, 0.5, -cy), radius: r };
  }

  let focusId = null;
  async function focusRoom(id, { animate = true } = {}) {
    if (!anchors.has(id)) return;
    focusId = id;
    const { centre: c, radius } = roomCircle(id);
    // frame the room plus a ring of neighbours; a short, wide stage (phone above the
    // sheet) gets a tighter ring and a steeper view so the room stays large
    const short = viewH < 420 || viewH < viewW * 0.6;
    // the room fills roughly 45-55% of the stage; the rest is its neighbours
    const r = Math.max(radius * (short ? 1.25 : 1.6), short ? 3.5 : 4.5);
    const polar = (short ? 36 : 44) * DEG;
    const box = new T.Box3(new T.Vector3(c.x - r, -info.slab, c.z - r), new T.Vector3(c.x + r, info.wallHeight + 0.4, c.z + r));
    const distance = fitBox(box, c, home.azimuth, polar, 0.04);
    for (const [rid, v] of veilGroup.children.map((m) => [m.userData.roomId, m])) v.visible = rid !== id;
    veilGroup.visible = true;
    for (const [rid, m] of roomMeshes) m.material.opacity = rid === id ? 0.16 : 0;
    container.dataset.focus = id;
    const az = home.azimuth;
    if (animate) await flyTo(c, az, polar, distance);
    else jumpTo(c, az, polar, distance);
    requestRender();
  }

  async function unfocus({ animate = true } = {}) {
    focusId = null;
    veilGroup.visible = false;
    for (const m of roomMeshes.values()) m.material.opacity = 0;
    delete container.dataset.focus;
    const d = home.distance || fitBox(bounds, home.target, home.azimuth, home.polar);
    if (animate) await flyTo(home.target, home.azimuth, home.polar, d);
    else jumpTo(home.target, home.azimuth, home.polar, d);
    requestRender();
  }

  function fitHome(animate = false) {
    home.distance = fitBox(bounds, home.target, home.azimuth, home.polar);
    if (!focusId) {
      if (animate) flyTo(home.target, home.azimuth, home.polar, home.distance, 700);
      else jumpTo(home.target, home.azimuth, home.polar, home.distance);
    }
  }

  // ---------- picking ----------
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();
  function roomAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(roomGroup.children, false)[0];
    return hit ? hit.object.userData.roomId : null;
  }

  // ---------- screen anchors ----------
  const v3 = new T.Vector3();
  let viewW = 1;
  let viewH = 1;
  function project(x, y, z = 0) {
    v3.set(x, z, -y).project(camera);
    return { x: (v3.x + 1) / 2 * viewW, y: (1 - v3.y) / 2 * viewH, depth: v3.z, visible: v3.z < 1 };
  }
  function anchorFor(id) {
    const a = anchors.get(id);
    if (!a) return null;
    return project(a.label[0], a.label[1], info.wallHeight + 0.15);
  }

  // ---------- render loop (on demand) ----------
  let needsRender = true;
  let rafId = 0;
  let stageVisible = false; // kept current by the IntersectionObserver below
  const listeners = new Set();
  function requestRender() {
    needsRender = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  // the route stripes keep moving (while the stage is on screen) even when the camera is still
  const routesAnimating = () => routeGroup.visible && !reducedMotion && stageVisible && !document.hidden;
  function frame(now) {
    rafId = 0;
    if (tween) {
      tween(now);
      needsRender = true;
    }
    const animating = routesAnimating();
    if (animating) {
      for (const m of animatedMaps) m.offset.x = -(now / 1400) % 1;
      needsRender = true;
    }
    const moved = controls.update();
    if (moved || needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
      for (const fn of listeners) fn();
    }
    if (tween || moved || needsRender || animating) rafId = requestAnimationFrame(frame);
  }
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', () => container.classList.add('is-orbiting'));
  controls.addEventListener('end', () => container.classList.remove('is-orbiting'));

  // slow idle turntable until the visitor interacts: only while the stage is on screen
  let idle = !!opts.idleSpin && !reducedMotion;
  let idleRaf = 0;
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver((entries) => {
      stageVisible = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.2);
      if (stageVisible) requestRender(); // resumes the route animation and the idle spin
      if (stageVisible && idle && !idleRaf) idleRaf = requestAnimationFrame(spin);
    }, { threshold: [0, 0.2, 0.6] }).observe(container);
  } else {
    stageVisible = true;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    requestRender();
    if (idle && stageVisible && !idleRaf) idleRaf = requestAnimationFrame(spin);
  });
  function spin() {
    idleRaf = 0;
    if (!idle || focusId || !stageVisible || document.hidden) return;
    if (tween) { idleRaf = requestAnimationFrame(spin); return; } // never fight a flight in progress
    const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) + 0.0009;
    const polar = Math.acos((camera.position.y - controls.target.y) / camera.position.distanceTo(controls.target));
    placeCamera(controls.target, az, polar, camera.position.distanceTo(controls.target));
    requestRender();
    idleRaf = requestAnimationFrame(spin);
  }
  const stopIdle = () => { idle = false; if (idleRaf) { cancelAnimationFrame(idleRaf); idleRaf = 0; } };
  renderer.domElement.addEventListener('pointerdown', () => { stopIdle(); userMoved = true; }, { once: true });
  renderer.domElement.addEventListener('wheel', () => { stopIdle(); userMoved = true; }, { once: true, passive: true });

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    viewW = w;
    viewH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // keep the visitor's own view on resize; only re-fit when nobody has moved the camera yet
    if (!userMoved && !focusId) fitHome(false);
    else if (focusId && !userMoved) focusRoom(focusId, { animate: false });
    requestRender();
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
  else window.addEventListener('resize', resize);
  resize();
  setLighting(opts.lighting || 'day');
  if (idle && stageVisible) idleRaf = requestAnimationFrame(spin);

  return {
    element: renderer.domElement,
    focusRoom,
    unfocus,
    getFocus: () => focusId,
    setLighting,
    getLighting: () => mode,
    setRoutesVisible: (on) => { routeGroup.visible = !!on; requestRender(); },
    setRouteVisible: (id, on) => { const g = routeMeshes.get(id); if (g) { g.visible = !!on; requestRender(); } },
    roomAt,
    anchorFor,
    project,
    /** Screen-space bounding box of a room's floor polygon (px within the stage). */
    roomScreenBox: (id) => {
      const a = anchors.get(id);
      if (!a) return null;
      const pts = a.floor.map(([x, y]) => project(x, y, 0));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    },
    /** On-screen size (px) of the office's long side at the current camera: a zoom measure for the overlay. */
    planPixelSize: () => {
      const a = project(bounds.min.x, -bounds.min.z, 0);
      const b = project(bounds.max.x, -bounds.max.z, 0);
      return Math.hypot(a.x - b.x, a.y - b.y);
    },
    onFrame: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    requestRender,
    resetView: () => (focusId ? focusRoom(focusId) : fitHome(true)),
    zoom: (factor) => {
      const d = camera.position.distanceTo(controls.target) / factor;
      const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
      const polar = Math.acos((camera.position.y - controls.target.y) / camera.position.distanceTo(controls.target));
      flyTo(controls.target.clone(), az, polar, Math.min(controls.maxDistance, Math.max(controls.minDistance, d)), 500);
    },
    stopIdle,
    /** JPEG data URL of the current frame on the stage colour (used by the details panel). */
    snapshot: (quality = 0.86) => {
      renderer.render(scene, camera);
      const c = document.createElement('canvas');
      c.width = renderer.domElement.width;
      c.height = renderer.domElement.height;
      const g = c.getContext('2d');
      g.fillStyle = '#1b1e24';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(renderer.domElement, 0, 0); // right after render: the buffer is still intact
      return c.toDataURL('image/jpeg', quality);
    },
    dispose: () => { renderer.dispose(); pmrem.dispose(); },
  };
}
