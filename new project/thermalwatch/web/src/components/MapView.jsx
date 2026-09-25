import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { CLASS_META } from '../api'

const BASEMAPS = {
  map: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
  },
}

const radius = (frp) => Math.max(3.5, Math.min(11, 3.5 + Math.log1p(frp || 0) * 1.9))

export default function MapView({ events, infrastructure, showInfrastructure, basemap, selected, onSelect }) {
  const el = useRef(null)
  const map = useRef(null)
  const layers = useRef({})

  useEffect(() => {
    map.current = L.map(el.current, { preferCanvas: true, zoomControl: true }).setView([22.5, 79], 5)
    layers.current.base = L.tileLayer(BASEMAPS.map.url, { attribution: BASEMAPS.map.attribution, maxZoom: 18 }).addTo(map.current)
    layers.current.infra = L.layerGroup()
    layers.current.events = L.layerGroup().addTo(map.current)
    layers.current.focus = L.layerGroup().addTo(map.current)
    return () => map.current.remove()
  }, [])

  useEffect(() => {
    const cfg = BASEMAPS[basemap]
    layers.current.base.setUrl(cfg.url)
    map.current.attributionControl.setPrefix('')
    layers.current.base.options.attribution = cfg.attribution
    map.current.attributionControl.removeAttribution(BASEMAPS.map.attribution)
    map.current.attributionControl.removeAttribution(BASEMAPS.satellite.attribution)
    map.current.attributionControl.addAttribution(cfg.attribution)
  }, [basemap])

  useEffect(() => {
    const group = layers.current.events
    group.clearLayers()
    events.forEach((f) => {
      const p = f.properties
      const meta = CLASS_META[p.class]
      const marker = L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        radius: radius(p.frp) * (p.class === 'industrial_fire' ? 1.5 : 1),
        color: p.class === 'industrial_fire' ? '#ffffff' : meta.color,
        weight: p.class === 'industrial_fire' ? 2 : 1,
        fillColor: meta.color,
        fillOpacity: 0.82,
        dashArray: p.needs_verification ? '3 2' : null,
      })
      marker.on('click', () => onSelect(p.id))
      marker.bindTooltip(`${meta.label} · ${Number(p.frp).toFixed(1)} MW`, { direction: 'top' })
      group.addLayer(marker)
    })
  }, [events, onSelect])

  useEffect(() => {
    const group = layers.current.infra
    group.clearLayers()
    infrastructure.forEach((f) => {
      const shape = L.geoJSON(f, {
        style: { color: '#12608F', weight: 1.5, fillOpacity: 0.07, dashArray: '4 3' },
        pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 5, color: '#12608F', weight: 1.5, fillOpacity: 0.15 }),
      })
      shape.bindTooltip(`${f.properties.name || 'Unnamed site'} — ${f.properties.infra_type.replace(/_/g, ' ')}`)
      group.addLayer(shape)
    })
    if (showInfrastructure) group.addTo(map.current)
    else group.remove()
  }, [infrastructure, showInfrastructure])

  useEffect(() => {
    const group = layers.current.focus
    group.clearLayers()
    if (!selected) return
    const [lon, lat] = selected.geometry.coordinates
    L.circleMarker([lat, lon], { radius: 17, color: '#14202B', weight: 2, fill: false }).addTo(group)
    const infra = selected.properties.infrastructure
    if (infra?.geometry) {
      L.geoJSON(infra.geometry, {
        style: { color: '#12608F', weight: 2, fillOpacity: 0.12 },
        pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: 7, color: '#12608F', weight: 2 }),
      }).addTo(group)
    }
    map.current.flyTo([lat, lon], Math.max(map.current.getZoom(), 12), { duration: 0.6 })
  }, [selected])

  return <div className="map" ref={el} />
}
