import { useCallback, useEffect, useMemo, useState } from 'react'
import { CLASSES, CLASS_META, api, daysAgoISO } from './api'
import MapView from './components/MapView'
import EventDetail from './components/EventDetail'

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '12 months', days: 365 },
]

export default function App() {
  const [meta, setMeta] = useState(null)
  const [days, setDays] = useState(365)
  const [active, setActive] = useState(CLASSES)
  const [minConfidence, setMinConfidence] = useState(0)
  const [verifyOnly, setVerifyOnly] = useState(false)
  const [showInfra, setShowInfra] = useState(true)
  const [basemap, setBasemap] = useState('map')
  const [events, setEvents] = useState([])
  const [stats, setStats] = useState(null)
  const [infra, setInfra] = useState([])
  const [selected, setSelected] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const [collapsed, setCollapsed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const params = useMemo(() => ({
    start: daysAgoISO(days),
    min_confidence: minConfidence || undefined,
    needs_verification: verifyOnly ? true : undefined,
  }), [days, minConfidence, verifyOnly])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ev, st] = await Promise.all([api.events(params), api.stats({ start: params.start })])
      setEvents(ev.features)
      setStats(st)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [params])

  useEffect(() => { api.meta().then(setMeta).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { api.infrastructure({}).then((d) => setInfra(d.features)).catch(() => {}) }, [])

  const select = useCallback(async (id) => {
    setTimeline(null)
    const ev = await api.event(id)
    setSelected(ev)
    api.timeline(id).then(setTimeline).catch(() => {})
  }, [])

  const shown = useMemo(() => events.filter((f) => active.includes(f.properties.class)), [events, active])
  const attention = shown.filter((f) => f.properties.needs_verification).length

  const toggleClass = (k) => setActive((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]))

  return (
    <div className="app">
      <div className={`rail${collapsed ? ' collapsed' : ''}`}>
        <div className="masthead">
          <h1>ThermalWatch</h1>
          <p>Satellite hot spots, sorted by what is probably causing them.</p>
        </div>

        {meta?.synthetic && (
          <div className="banner">
            Showing the synthetic demo scenario, not real satellite data. Run the FIRMS ingestion to switch to live detections.
          </div>
        )}
        {error && <div className="banner" style={{ borderColor: '#a52c20', background: '#fdf0ee', color: '#7a2318' }}>
          {error}. Check that the API is running.
        </div>}

        <div className="section">
          <div className="total">
            {loading ? '…' : shown.length.toLocaleString()}
            <span>events in view{loading ? '' : ` · last ${days} days`}</span>
          </div>
          <div className="attention"><b>{attention.toLocaleString()}</b> need a human check</div>
        </div>

        <div className="section">
          <h2>Categories</h2>
          {CLASSES.map((k) => {
            const n = shown.filter((f) => f.properties.class === k).length
            return (
              <button key={k} className="class-row" aria-pressed={active.includes(k)} onClick={() => toggleClass(k)}
                      title={CLASS_META[k].note}>
                <i className="swatch" style={{ background: CLASS_META[k].color }} />
                <span className="name">{CLASS_META[k].label}</span>
                <span className="count">{n.toLocaleString()}</span>
              </button>
            )
          })}
        </div>

        <div className="section">
          <h2>Filters</h2>
          <div className="chips">
            {RANGES.map((r) => (
              <button key={r.days} className="chip" aria-pressed={days === r.days} onClick={() => setDays(r.days)}>{r.label}</button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="conf">Minimum score {Math.round(minConfidence * 100)}%</label>
            <input id="conf" type="range" min="0" max="0.9" step="0.05" value={minConfidence}
                   onChange={(e) => setMinConfidence(Number(e.target.value))} />
          </div>
          <label className="toggle">
            <input type="checkbox" checked={verifyOnly} onChange={(e) => setVerifyOnly(e.target.checked)} />
            Only events needing a check
          </label>
          <label className="toggle">
            <input type="checkbox" checked={showInfra} onChange={(e) => setShowInfra(e.target.checked)} />
            Show mapped industrial sites
          </label>
          <div className="chips" style={{ marginTop: 12 }}>
            <button className="chip" aria-pressed={basemap === 'map'} onClick={() => setBasemap('map')}>Map</button>
            <button className="chip" aria-pressed={basemap === 'satellite'} onClick={() => setBasemap('satellite')}>Satellite</button>
          </div>
        </div>

        <div className="section">
          <h2>Reading the map</h2>
          <p className="hint">
            Circle size follows fire radiative power. A dashed outline means the evidence is mixed and an analyst should look.
            Industrial fires are drawn larger with a white ring so they stay visible in a crowded season.
          </p>
        </div>

        <button className="rail-toggle" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'Show filters' : 'Hide filters'}
        </button>
      </div>

      <div className="map-area">
        <MapView events={shown} infrastructure={infra} showInfrastructure={showInfra} basemap={basemap}
                 selected={selected} onSelect={select} />
        {!selected && !loading && shown.length === 0 && (
          <div className="map-note">No events match these filters. Widen the date range or turn categories back on.</div>
        )}
        {!selected && shown.length > 0 && <div className="map-note">Select a hot spot to see the evidence behind its category.</div>}
        {selected && (
          <EventDetail event={selected} timeline={timeline} onClose={() => setSelected(null)}
                       onLabelled={() => select(selected.properties.id)} />
        )}
      </div>
    </div>
  )
}
