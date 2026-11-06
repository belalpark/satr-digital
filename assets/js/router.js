// Hash router. Routes:
//   #/                      welcome
//   #/plan[?scene=<id>]     plan
//   #/room/<id>             room
//   #/room/<id>/details     details

const ROOM_ID = /^[a-z0-9-]+$/;

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'welcome' };
  if (parts[0] === 'plan') {
    const scene = new URLSearchParams(query).get('scene');
    return scene ? { view: 'plan', scene } : { view: 'plan' };
  }
  if (parts[0] === 'room' && parts[1] && ROOM_ID.test(parts[1])) {
    if (parts[2] === 'details') return { view: 'details', roomId: parts[1] };
    if (parts.length === 2) return { view: 'room', roomId: parts[1] };
  }
  return { view: 'plan' };
}

export function buildHash(route) {
  switch (route.view) {
    case 'welcome':
      return '#/';
    case 'plan':
      return route.scene && route.scene !== 'current' ? `#/plan?scene=${encodeURIComponent(route.scene)}` : '#/plan';
    case 'room':
      return `#/room/${route.roomId}`;
    case 'details':
      return `#/room/${route.roomId}/details`;
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
