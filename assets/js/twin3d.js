// Live 3D office model (three.js): 360° orbit, pan, zoom, day / evening lighting,
// room picking, focus fly-to with neighbour dimming, route ribbons, and screen
// anchors so the page can place its dots and labels over the model.
//
// Lighting is baked: tools/twin/bake_light.py path-traces the light arriving at every surface
// seen from above (sun, sky, ceiling pools, coloured bounce, soft and contact shadows) into two
// top-down maps per mood, and the materials here multiply their own textures by those maps.
// No real-time lights and no shadow maps: it looks rendered and it is lighter on the GPU.
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
  // 1.5x is plenty for a model this size; the adaptive governor below drops to 1x on weak GPUs
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = T.NeutralToneMapping; // true material colours up to the highlights, which roll off instead of clipping
  renderer.domElement.className = 'twin-canvas';
  renderer.domElement.style.visibility = 'hidden'; // shown with its light on (setLighting): never a frame of an unlit model
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
  // the model orbits around a fixed pivot (the office centre, or the focused room): no free panning,
  // and zooming keeps the pivot, so the model can never drift off the stage
  controls.enablePan = false;
  controls.zoomToCursor = false;

  // ---------- baked lighting ----------
  const LIGHT = info.light; // { rect, gain, static, moods: { day: [a, b], night: [a, b] } }
  const texLoader = new T.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  // phones and low-memory devices get the maps at half size (a quarter of the GPU memory) and keep one mood at a time
  const compact = Math.max(window.screen.width, window.screen.height) < 1000 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  const COMPACT_SIDE = 2048;
  const loadMap = async (file) => {
    let t = await texLoader.loadAsync(`${base}${file}`);
    const img = t.image;
    if (compact && Math.max(img.width, img.height) > COMPACT_SIDE) {
      const k = COMPACT_SIDE / Math.max(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      t.dispose();
      t = new T.CanvasTexture(c);
    }
    t.colorSpace = T.SRGBColorSpace; // stored through the sRGB curve: the GPU hands the shader linear light
    t.anisotropy = Math.min(4, maxAniso);
    return t;
  };
  const moodMaps = new Map(); // mood -> Promise<[a, b]>
  const loadMood = (m) => {
    if (!moodMaps.has(m)) {
      const p = Promise.all(LIGHT.moods[m].map(loadMap));
      p.catch(() => moodMaps.delete(m)); // a failed download can be retried by toggling again
      moodMaps.set(m, p);
    }
    return moodMaps.get(m);
  };
  // one set of uniforms shared by every material: switching the mood swaps two textures
  const bake = {
    a: { value: null },
    b: { value: null },
    rect: { value: new T.Vector4(LIGHT.rect.x0, LIGHT.rect.y0, 1 / LIGHT.rect.w, 1 / LIGHT.rect.h) },
    gain: { value: LIGHT.gain * Math.PI }, // map texel = radiance of a white surface = irradiance / pi
    fill: { value: 0.12 },                 // share of the environment's diffuse light kept as a soft fill
  };
  const BAKE_VERT_DECL = 'varying vec3 vBakeWorld;\nvarying vec3 vBakeNormal;';
  const BAKE_VERT_MAIN = 'vBakeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tvBakeNormal = normalize( mat3( modelMatrix ) * objectNormal );';
  // The maps are looked up by world position (x, z): exact for every upward face. A vertical face has no
  // texel of its own, so it takes the (mip-averaged) light of the floor just in front of it, which already
  // knows whether that side is sunlit, shaded or tucked behind furniture, and brightens toward its top edge.
  const bakeFrag = (furniture) => `
uniform sampler2D bakeA;
uniform sampler2D bakeB;
uniform vec4 bakeRect;
uniform float bakeGain;
uniform float bakeFill;
varying vec3 vBakeWorld;
varying vec3 vBakeNormal;
vec2 bakeUv( vec2 p ) { return vec2( ( p.x - bakeRect.x ) * bakeRect.z, ( - p.y - bakeRect.y ) * bakeRect.w ); }
// mip level whose texels are about that many metres wide: a soft average of the floor, whatever the map's size
float bakeLod( float metres ) { return max( 0.0, log2( metres * float( textureSize( bakeA, 0 ).x ) * bakeRect.z ) ); }
vec3 bakedIrradiance() {
	vec3 n = normalize( vBakeNormal );
	#ifdef DOUBLE_SIDED
		if ( ! gl_FrontFacing ) n = - n;
	#endif
	vec2 p = vBakeWorld.xz;
	float up = smoothstep( 0.45, 0.8, n.y );
	float down = smoothstep( 0.45, 0.8, - n.y );
	vec2 out2 = length( n.xz ) > 0.001 ? normalize( n.xz ) : vec2( 0.0 );
	${furniture ? `
	vec3 nearFloor = textureLod( bakeA, bakeUv( p + out2 * 0.2 ), bakeLod( 0.18 ) ).rgb;
	vec3 top = texture2D( bakeB, bakeUv( p ) ).rgb;
	vec3 topIn = texture2D( bakeB, bakeUv( p - out2 * 0.05 ) ).rgb;
	float h = smoothstep( 0.0, 0.85, vBakeWorld.y );
	vec3 side = mix( nearFloor, 0.5 * ( nearFloor + topIn ), h ) * mix( 0.78, 1.0, h );` : `
	// a wall takes the averaged light of the strip of floor in front of it: the shadows of single chairs
	// must not climb the wall as stripes
	vec3 nearFloor = textureLod( bakeA, bakeUv( p + out2 * 0.38 ), bakeLod( 0.42 ) ).rgb;
	vec3 top = texture2D( bakeA, bakeUv( p ) ).rgb;
	float h = smoothstep( 0.0, 1.3, vBakeWorld.y );
	vec3 side = nearFloor * mix( 0.74, 1.04, h );`}
	vec3 e = mix( side, top, up );
	e = mix( e, nearFloor * 0.45, down );
	return e * bakeGain;
}`;
  const bakedMaterials = new Map();
  function bakedMaterial(src, furniture) {
    const key = `${src.uuid}:${furniture ? 'f' : 's'}`;
    let m = bakedMaterials.get(key);
    if (m) return m;
    m = src.clone();
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { bakeA: bake.a, bakeB: bake.b, bakeRect: bake.rect, bakeGain: bake.gain, bakeFill: bake.fill });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BAKE_VERT_DECL}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n\t${BAKE_VERT_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${bakeFrag(furniture)}`)
        .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n#if defined( RE_IndirectDiffuse )\n\tirradiance += bakedIrradiance();\n\tiblIrradiance *= bakeFill;\n#endif');
    };
    m.customProgramCacheKey = () => (furniture ? 'baked-furniture' : 'baked-static');
    bakedMaterials.set(key, m);
    return m;
  }

  const MOOD = {
    day: { exposure: 0.82, env: 0.45, fill: 0.10 },
    night: { exposure: 1.18, env: 0.16, fill: 0.05 },
  };
  let mode = 'day';
  let moodSeq = 0;
  async function setLighting(next) {
    mode = next === 'night' ? 'night' : 'day';
    container.dataset.lighting = mode; // the button reflects the choice at once; the maps follow when loaded
    const seq = ++moodSeq;
    let maps;
    try {
      maps = await loadMood(mode);
    } catch (err) {
      if (!container.dataset.lit) throw err; // nothing to show at all: the caller reports it
      if (seq === moodSeq) { mode = container.dataset.lit; container.dataset.lighting = mode; } // keep the light that is on
      return;
    }
    if (seq !== moodSeq) return; // switched again while the maps were loading
    const [a, b] = maps;
    const night = mode === 'night';
    const previous = [bake.a.value, bake.b.value];
    bake.a.value = a;
    bake.b.value = b;
    if (compact && previous[0] && previous[0] !== a) {
      // free the other mood's maps; they download again from the browser cache if the visitor switches back
      for (const t of previous) t.dispose();
      for (const [k, p] of moodMaps) if (k !== mode) { moodMaps.delete(k); p.catch(() => {}); }
    }
    bake.fill.value = MOOD[mode].fill;
    renderer.toneMappingExposure = MOOD[mode].exposure;
    scene.environmentIntensity = MOOD[mode].env;
    for (const m of emissives) m.emissiveIntensity = night ? m.userData.nightEmissive : m.userData.dayEmissive;
    container.dataset.lit = mode; // the mood whose light is on screen (data-lighting is the mood asked for)
    renderer.domElement.style.visibility = '';
    requestRender();
  }

  // ---------- model ----------
  loadMood(opts.lighting === 'night' ? 'night' : 'day'); // the light maps download alongside the model
  const loader = new T.GLTFLoader();
  const gltf = await loader.loadAsync(`${base}${info.glb || 'office.glb'}`);
  const model = gltf.scene;
  const emissives = [];
  // the building (floors, walls, joinery) reads map A; loose furniture reads map B for its own top faces
  const staticRe = new RegExp(`^(${LIGHT.static.join('|')})(\\d{3})?(_\\d+)?$`);
  const isStatic = (o) => { for (let p = o; p && p !== model; p = p.parent) if (staticRe.test(p.name)) return true; return false; };
  model.traverse((o) => {
    if (!o.isMesh) return;
    const furniture = !isStatic(o);
    const src = Array.isArray(o.material) ? o.material : [o.material];
    const out = src.map((m0) => {
      if (!m0) return m0;
      const m = bakedMaterial(m0, furniture);
      if (m.transparent) m.depthWrite = false;
      if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.05 && !emissives.includes(m)) {
        m.userData.dayEmissive = Math.min(m.emissiveIntensity, 0.6);
        m.userData.nightEmissive = Math.min(m.emissiveIntensity, 6);
        m.emissiveIntensity = m.userData.dayEmissive;
        emissives.push(m);
      }
      return m;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  scene.add(model);

  // the table the model stands on: a matte sheet that carries the building's baked shadow (map A holds
  // the light on the ground around the building) and fades into the page background toward its edges
  {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    // opaque under and around the building, a soft ramp over the outer band (nested rounded rects: no canvas filter needed)
    const band = 46;
    for (let i = 0; i <= band; i++) {
      const k = i / band;
      const v = Math.round(255 * k * k * (3 - 2 * k));
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.beginPath();
      if (g.roundRect) g.roundRect(i, i, 256 - 2 * i, 256 - 2 * i, 70 - i * 0.6);
      else g.rect(i, i, 256 - 2 * i, 256 - 2 * i);
      g.fill();
    }
    const fade = new T.CanvasTexture(c);
    const stageMat = bakedMaterial(new T.MeshStandardMaterial({ color: 0x3d4149, roughness: 1, metalness: 0, transparent: true, alphaMap: fade, depthWrite: false }), false);
    const stage = new T.Mesh(new T.PlaneGeometry(LIGHT.rect.w, LIGHT.rect.h), stageMat);
    stage.rotation.x = -Math.PI / 2;
    stage.position.set(LIGHT.rect.x0 + LIGHT.rect.w / 2, -info.slab - 0.01, -(LIGHT.rect.y0 + LIGHT.rect.h / 2));
    stage.renderOrder = -1;
    scene.add(stage);
  }

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
  let tweenDone = Promise.resolve(); // resolves when the flight in progress ends (or is superseded)
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
  /** Lands the flight in progress at its destination now (its promise resolves): used when nobody can see it. */
  function finishTween() {
    if (tween) tween(Infinity);
  }
  function flyTo(target, azimuth, polar, distance, ms = 1100) {
    cancelTween(); // supersede the flight in progress
    // a flight nobody can see (another page covers the stage, hidden tab) is not animated: the camera lands at once
    if (reducedMotion || unseen()) { placeCamera(target, azimuth, polar, distance); requestRender(); return Promise.resolve(); }
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
    tweenDone = new Promise((resolve) => {
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
    return tweenDone;
  }
  /** Resolves once no camera flight is in progress (immediately when the camera is at rest). */
  const settled = () => (tween ? tweenDone : Promise.resolve());

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
    // the focused room keeps its true rendered colours; the veil over its neighbours is what singles it out
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

  // ---------- adaptive quality: weak GPUs get 1x pixels ----------
  // fed with the time between consecutive rendered frames (turntable / flights / route animation):
  // under 30 fps on average means the GPU cannot keep up, so the viewer steps down and stays there
  let frameSamples = 0;
  let frameSum = 0;
  let qualityStep = 0; // 0 = full, 1 = 1x pixels
  const createdAt = performance.now();
  function governor(ms) {
    if (qualityStep >= 1 || pixelRatio <= 1) return;
    // the first seconds compile shaders and upload textures on any GPU; a single long gap is a
    // hitch (tab switch, GC), not sustained load — neither says anything about the GPU
    if (performance.now() - createdAt < 2500 || ms > 250) return;
    frameSamples += 1;
    frameSum += ms;
    if (frameSamples < 24) return;
    const avg = frameSum / frameSamples;
    frameSamples = 0;
    frameSum = 0;
    if (avg <= 34) return;
    qualityStep = 1;
    pixelRatio = 1;
    renderer.setPixelRatio(1);
    container.dataset.quality = 'reduced';
    requestRender();
  }

  // ---------- render loop (on demand) ----------
  let needsRender = true;
  let lastFrameAt = 0;
  let rafId = 0;
  let stageVisible = false; // kept current by the IntersectionObserver below
  let active = opts.active !== false; // false while the page shows another view over the stage (views hide by visibility, not display)
  const onScreen = () => active && stageVisible && !document.hidden;
  // nobody can see the stage: another page covers it, the 2D plan is the one shown, or the tab is hidden
  const unseen = () => !active || document.hidden;
  const listeners = new Set();
  // `paced` = the caller drives one frame per animation tick (the turntable), so the gap to the
  // previous frame measures the GPU; any other request after an idle loop starts a new pacing chain
  let inFrame = false; // requests raised while a frame runs (controls' change event) keep the chain
  function requestRender(paced = false) {
    needsRender = true;
    // behind another page (or in a hidden tab) nothing is drawn: the frame is owed until the stage is seen
    // again (setActive and visibilitychange below ask for it)
    if (unseen()) return;
    if (!rafId) {
      if (paced !== true && !inFrame) lastFrameAt = 0;
      rafId = requestAnimationFrame(frame);
    }
  }
  // the route stripes keep moving (while the stage is on screen) even when the camera is still
  // the stripes only need frames while at least one route can actually be seen: the paths scene
  // shows the group, and the chips toggle the individual routes inside it
  const anyRouteVisible = () => { for (const g of routeMeshes.values()) if (g.visible) return true; return false; };
  const routesAnimating = () => routeGroup.visible && anyRouteVisible() && !reducedMotion && onScreen();
  function frame(now) {
    rafId = 0;
    if (unseen()) {
      // the page changed while this frame was queued: draw nothing behind it, and land a flight in progress
      // (frames drawn unseen are wasted work, and on a slow GPU they pile up and freeze the page on return)
      finishTween();
      lastFrameAt = 0;
      return;
    }
    inFrame = true;
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
      // frame pacing over consecutive rendered frames is the honest proxy for GPU load
      if (lastFrameAt) governor(now - lastFrameAt);
      lastFrameAt = now;
      needsRender = false;
      for (const fn of listeners) fn();
    } else {
      lastFrameAt = 0;
    }
    // controls.update() above may already have queued the next frame through its
    // synchronous 'change' event; never queue a second callback for the same tick
    if (!rafId && (tween || moved || needsRender || animating)) rafId = requestAnimationFrame(frame);
    inFrame = false;
  }
  controls.addEventListener('change', () => requestRender());
  controls.addEventListener('start', () => container.classList.add('is-orbiting'));
  controls.addEventListener('end', () => container.classList.remove('is-orbiting'));

  // slow idle turntable until the visitor interacts: only while the stage is on screen
  let idle = !!opts.idleSpin && !reducedMotion;
  let idleRaf = 0;
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver((entries) => {
      stageVisible = entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.2);
      if (onScreen()) requestRender(); // resumes the route animation and the idle spin
      if (onScreen() && idle && !idleRaf) idleRaf = requestAnimationFrame(spin);
    }, { threshold: [0, 0.2, 0.6] }).observe(container);
  } else {
    stageVisible = true;
  }
  document.addEventListener('visibilitychange', () => {
    if (unseen()) return;
    requestRender(); // the frame owed while the tab was hidden
    if (onScreen() && idle && !idleRaf) idleRaf = requestAnimationFrame(spin);
  });
  /** The page tells the viewer whether its view is the one on screen; nothing animates behind another view. */
  function setActive(on) {
    active = !!on;
    if (!active) { finishTween(); return; } // the flight would be drawn unseen: land now, the frame is owed
    requestRender();
    if (onScreen() && idle && !idleRaf) idleRaf = requestAnimationFrame(spin);
  }
  const idleStart = performance.now();
  function spin() {
    idleRaf = 0;
    if (!idle || focusId || !onScreen()) return;
    if (performance.now() - idleStart > 30000) { idle = false; return; } // the turntable stops by itself after half a minute
    if (tween) { idleRaf = requestAnimationFrame(spin); return; } // never fight a flight in progress
    const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z) + 0.0009;
    const polar = Math.acos((camera.position.y - controls.target.y) / camera.position.distanceTo(controls.target));
    requestRender(true); // before placeCamera: its synchronous 'change' request then finds the frame already queued
    placeCamera(controls.target, az, polar, camera.position.distanceTo(controls.target));
    idleRaf = requestAnimationFrame(spin);
  }
  const stopIdle = () => { idle = false; if (idleRaf) { cancelAnimationFrame(idleRaf); idleRaf = 0; } };
  // every manual interaction (drag, pinch, wheel — OrbitControls' 'start') takes over: the turntable
  // stops, the framing is the visitor's, and a flight in progress ends instead of overwriting the gesture
  controls.addEventListener('start', () => { stopIdle(); userMoved = true; cancelTween(); });

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
  await setLighting(opts.lighting || 'day'); // the first frame is drawn with its light: no flash of an unlit model
  if (idle && onScreen()) idleRaf = requestAnimationFrame(spin);

  return {
    element: renderer.domElement,
    focusRoom,
    unfocus,
    settled,
    setActive,
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
    // the reset returns the framing to the automatic one (a later resize re-fits it again)
    resetView: () => { userMoved = false; return focusId ? focusRoom(focusId) : fitHome(true); },
    // the +/− buttons are the visitor's input like a drag, the wheel or a pinch: the framing is theirs
    // from now on, so a resize keeps it instead of re-fitting the home view or re-framing the room
    zoom: (factor) => {
      stopIdle();
      userMoved = true;
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
