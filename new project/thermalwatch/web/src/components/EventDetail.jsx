import { useState } from 'react'
import { CLASS_META, CLASSES, PERSISTENCE_LABEL, api, fmt } from '../api'
import HeatBarcode from './HeatBarcode'

export default function EventDetail({ event, timeline, onClose, onLabelled }) {
  const [saved, setSaved] = useState(null)
  const [error, setError] = useState(null)
  const p = event.properties
  const c = p.classification
  const meta = CLASS_META[c.predicted_class]
  const pers = p.persistence
  const infra = p.infrastructure

  const verify = async (label) => {
    try {
      await api.addLabel(p.id, { label, analyst: 'analyst' })
      setSaved(CLASS_META[label].label)
      setError(null)
      onLabelled?.()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <aside className="detail">
      <header>
        <div className="title">
          <h3 style={{ color: meta.color }}>{meta.label}</h3>
          <p className="sub">
            Event {p.id} · {fmt.when(p.detection.acq_time)} ·{' '}
            {p.detection.daynight === 'N' ? 'night pass' : 'day pass'}
          </p>
        </div>
        <button className="close" onClick={onClose} aria-label="Close event details">×</button>
      </header>

      <div className="detail-body">
        <div className="block">
          <div className="conf-bar">
            <i style={{ width: `${c.confidence * 100}%`, background: meta.color }} />
          </div>
          <p className="conf-note">
            Score {fmt.pct(c.confidence)} from the {c.method === 'rules' ? 'evidence rules' : 'trained model'}.
            This is how well the evidence matches this category, not proof of what happened.
            {c.needs_verification && ' Check this one before acting.'}
          </p>
          {c.needs_verification && <span className="tag verify-flag" style={{ marginTop: 8, display: 'inline-block' }}>Needs verification</span>}
          <div className="scores">
            {CLASSES.filter((k) => (c.class_scores[k] || 0) > 0.01).map((k) => (
              <div className="score" key={k}>
                <div className="track">
                  <i style={{ width: `${c.class_scores[k] * 100}%`, background: CLASS_META[k].color }} />
                </div>
                <div className="val">{fmt.pct(c.class_scores[k])}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="block">
          <h4>Why</h4>
          <ul className="evidence">
            {p.evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>

        <div className="block">
          <h4>Heat history</h4>
          {timeline ? <HeatBarcode timeline={timeline} eventDate={timeline.event_date} /> : <p>Loading…</p>}
          <div className="facts" style={{ marginTop: 10 }}>
            <div className="fact"><span>Behaviour</span>{PERSISTENCE_LABEL[pers.class]}</div>
            <div className="fact"><span>Hot days / months (year)</span>{pers.active_days_365} days · {pers.active_months_365} months</div>
            <div className="fact"><span>Usual power here</span>{fmt.frp(pers.typical_frp_mw)}</div>
            <div className="fact"><span>Now</span>{fmt.frp(p.detection.frp_mw)}{pers.spike ? ` (${pers.frp_ratio}× usual)` : ''}</div>
          </div>
        </div>

        <div className="block">
          <h4>Nearest industrial site</h4>
          {infra ? (
            <>
              <p>{infra.name || 'Unnamed site'} — {infra.type.replace(/_/g, ' ')}, {fmt.dist(infra.distance_m)} away{infra.operator ? `, operated by ${infra.operator}` : ''}.</p>
              <p className="conf-note">From {infra.source}. {infra.within_2km} mapped site(s) within 2 km.</p>
            </>
          ) : (
            <p>No mapped industrial site within 20 km. Industrial maps are incomplete, so this is weak evidence rather than proof.</p>
          )}
        </div>

        <div className="block">
          <h4>Measurements</h4>
          <div className="facts">
            <div className="fact"><span>Fire radiative power</span>{fmt.frp(p.detection.frp_mw)}</div>
            <div className="fact"><span>Brightness (mid-infrared)</span>{fmt.temp(p.detection.bright_mir_k)}</div>
            <div className="fact"><span>Brightness (thermal)</span>{fmt.temp(p.detection.bright_tir_k)}</div>
            <div className="fact"><span>Land cover</span>{(p.land_cover.majority || 'unknown').replace(/_/g, ' ')}</div>
            <div className="fact"><span>Position</span>{p.detection.lat.toFixed(4)}, {p.detection.lon.toFixed(4)}</div>
            <div className="fact"><span>Satellite</span>{p.detection.instrument} {p.detection.satellite || ''} ({p.detection.source})</div>
          </div>
        </div>

        <div className="block">
          <h4>Verify this event</h4>
          <p className="conf-note">Your call becomes ground truth: it is stored as an analyst label and used to measure accuracy.</p>
          <div className="verify">
            {CLASSES.map((k) => (
              <button key={k} onClick={() => verify(k)}>{CLASS_META[k].label}</button>
            ))}
          </div>
          {saved && <p className="saved">Saved as {saved}.</p>}
          {error && <p className="saved" style={{ color: '#a52c20' }}>{error}</p>}
          {p.labels.length > 0 && (
            <p className="conf-note" style={{ marginTop: 8 }}>
              Existing labels: {p.labels.map((l) => `${CLASS_META[l.label]?.label || l.label} (${l.label_source})`).join(', ')}
            </p>
          )}
        </div>
      </div>
    </aside>
  )
}
