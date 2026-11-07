// Hash router. Routes:
//   #/                      welcome
//   #/plan[?scene=<id>][&view=2d|3d]   plan (scene: current | paths; view = 2D plan or live 3D model)
//   #/room/<id>[?view=2d|3d]           the room focused in the plan (2D highlight or 3D close-up)
//   #/room/<id>/photos[?view=2d|3d]    real photos of the room
//   #/room/<id>/details[?view=2d|3d]   details panel

const ROOM_ID = /^[a-z0-9-]+$/;

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'welcome' };
  const q = new URLSearchParams(query);
  const mode = q.get('view') === '3d' ? '3d' : q.get('view') === '2d' ? '2d' : null; // optional 2D / 3D view in deep links
  if (parts[0] === 'plan') {
    const scene = q.get('scene');
    const r = scene ? { view: 'plan', scene } : { view: 'plan' };
    if (mode) r.mode = mode;
    return r;
  }
  if (parts[0] === 'room' && parts[1] && ROOM_ID.test(parts[1])) {
    if (parts.length === 2) return mode ? { view: 'room', roomId: parts[1], mode } : { view: 'room', roomId: parts[1] };
    if (parts.length === 3 && (parts[2] === 'photos' || parts[2] === 'details')) {
      const r = { view: parts[2], roomId: parts[1] };
      if (mode) r.mode = mode; // an explicit view in the link wins over the visitor's saved one
      return r;
    }
  }
  return { view: 'plan' };
}

export function buildHash(route) {
  switch (route.view) {
    case 'welcome':
      return '#/';
    case 'plan': {
      const q = [];
      if (route.scene && route.scene !== 'current') q.push(`scene=${encodeURIComponent(route.scene)}`);
      if (route.mode) q.push(`view=${route.mode}`);
      return q.length ? `#/plan?${q.join('&')}` : '#/plan';
    }
    case 'room':
      return route.mode ? `#/room/${route.roomId}?view=${route.mode}` : `#/room/${route.roomId}`;
    case 'photos':
      return route.mode ? `#/room/${route.roomId}/photos?view=${route.mode}` : `#/room/${route.roomId}/photos`;
    case 'details':
      return route.mode ? `#/room/${route.roomId}/details?view=${route.mode}` : `#/room/${route.roomId}/details`;
    default:
      return '#/';
  }
}

/** Team name from `?team=` — decoded, trimmed, capped at 60 chars, defaulted. */
export function teamNameFromSearch(search, fallback) {
  const value = new URLSearchParams(search || '').get('team') || '';
  const clean = value.replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || fallback;
}

export function navigate(route, { replace = false } = {}) {
  const hash = buildHash(route);
  if (replace) {
    history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
}
