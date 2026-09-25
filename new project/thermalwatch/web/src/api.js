export const CLASS_META = {
  industrial_fire: { label: 'Industrial fire', color: '#D23B2E', note: 'Heat at a facility that is unusual for that facility' },
  persistent_industrial: { label: 'Persistent industrial heat', color: '#7A3E9D', note: 'A fixed source that runs most of the year' },
  agricultural_burning: { label: 'Agricultural burning', color: '#C8891A', note: 'Crop residue fires, seasonal and on farmland' },
  wildfire_natural: { label: 'Wildfire or natural', color: '#1E7F5C', note: 'Fire in forest, shrub or grassland' },
  other_unclassified: { label: 'Other or unclear', color: '#7C8A95', note: 'Evidence does not point to one source type' },
}
export const CLASSES = Object.keys(CLASS_META)

export const PERSISTENCE_LABEL = {
  temporary: 'One-off',
  recurring: 'Recurring',
  persistent: 'Persistent',
}

async function get(path, params = {}) {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v)
  })
  const res = await fetch(`/api${path}${q.toString() ? `?${q}` : ''}`)
  if (!res.ok) throw new Error(`${path} failed (${res.status})`)
  return res.json()
}

export const api = {
  meta: () => get('/meta'),
  stats: (p) => get('/stats', p),
  events: (p) => get('/events', p),
  event: (id) => get(`/events/${id}`),
  timeline: (id) => get(`/events/${id}/timeline`),
  infrastructure: (p) => get('/infrastructure', p),
  addLabel: async (id, body) => {
    const res = await fetch(`/api/events/${id}/labels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('Could not save the verification')
    return res.json()
  },
}

export function daysAgoISO(days) {
  const d = new Date(Date.now() - days * 86400000)
  return d.toISOString().slice(0, 19)
}

export const fmt = {
  frp: (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)} MW`),
  temp: (v) => (v ? `${Number(v).toFixed(1)} K` : '—'),
  pct: (v) => `${Math.round(v * 100)}%`,
  when: (iso) =>
    new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC',
  dist: (m) => (m === null || m === undefined ? 'no mapped site nearby' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`),
}
