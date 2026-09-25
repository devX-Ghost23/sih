import { useMemo } from 'react'

// One tick per day. Height and colour follow that day's peak FRP, so a persistent
// flare reads as a solid block and a one-off fire as a single mark.
const ramp = (t) => {
  const stops = [
    [0.0, [124, 138, 149]],
    [0.35, [122, 62, 157]],
    [0.7, [210, 59, 46]],
    [1.0, [240, 166, 40]],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (t - t0) / (t1 - t0)
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`
    }
  }
  return 'rgb(240,166,40)'
}

export default function HeatBarcode({ timeline, eventDate }) {
  const { ticks, from, to } = useMemo(() => {
    const end = new Date(`${eventDate}T00:00:00Z`)
    const days = timeline.days || 365
    const start = new Date(end.getTime() - days * 86400000)
    const byDay = new Map(timeline.series.map((d) => [d.date, d.max_frp]))
    const maxFrp = Math.max(1, ...timeline.series.map((d) => d.max_frp || 0))
    const out = []
    for (let i = 0; i <= days; i++) {
      const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10)
      const frp = byDay.get(d)
      out.push({ date: d, frp })
    }
    return { ticks: out.map((t) => ({ ...t, t: t.frp ? Math.min(1, Math.log1p(t.frp) / Math.log1p(maxFrp)) : null })), from: start, to: end }
  }, [timeline, eventDate])

  const label = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })

  return (
    <>
      <div className="barcode" role="img" aria-label={`Heat activity on ${timeline.series.length} days of the past year`}>
        {ticks.map((t) => (
          <i
            key={t.date}
            title={t.frp ? `${t.date}: ${t.frp.toFixed(1)} MW` : t.date}
            style={t.frp ? { background: ramp(t.t), height: `${25 + t.t * 75}%` } : { height: '10%' }}
          />
        ))}
      </div>
      <div className="barcode-axis">
        <span>{label(from)}</span>
        <span>{timeline.series.length} hot days within {timeline.neighbourhood_km} km</span>
        <span>{label(to)}</span>
      </div>
    </>
  )
}
