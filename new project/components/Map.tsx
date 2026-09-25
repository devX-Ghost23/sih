"use client";

import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import type { Event } from "@/lib/types";
import { useUIStore } from "@/lib/store";

interface MapProps {
  events: Event[];
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
}

/* ==========================================================================
   Tile source
   No API key required. If a keyed provider is ever used, read its key from
   an env var here rather than hardcoding it.
   ========================================================================== */

const TILE_URL =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ??
  "https://{s}.basemaps.cartocdn.com/dark_matter/{z}/{x}/{y}{r}.png";

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/* ==========================================================================
   Classification appearance
   Every class gets its own shape as well as its own color, so meaning does
   not depend on color alone.
   ========================================================================== */

type MarkerShape = "circle" | "diamond" | "triangle" | "square" | "cross";

interface ClassStyle {
  label: string;
  color: string;
  shape: MarkerShape;
}

const CLASS_STYLES: Record<string, ClassStyle> = {
  industrial_fire: { label: "Industrial fire", color: "#d15b5e", shape: "triangle" },
  thermal_source: { label: "Thermal source", color: "#d19a3a", shape: "circle" },
  gas_flare: { label: "Gas flare", color: "#4a8bd4", shape: "diamond" },
  agricultural_burn: { label: "Agricultural burn", color: "#3da57a", shape: "square" },
  unknown: { label: "Unknown", color: "#6b788a", shape: "cross" },
};

const DEFAULT_STYLE: ClassStyle = { label: "Other", color: "#6b788a", shape: "cross" };

function styleForClass(eventClass: string): ClassStyle {
  return CLASS_STYLES[eventClass] ?? DEFAULT_STYLE;
}

/** Raw SVG markup for a shape, used inside the Leaflet divIcon HTML string. */
function shapeMarkup(shape: MarkerShape, color: string): string {
  switch (shape) {
    case "circle":
      return `<circle cx="12" cy="12" r="6" fill="${color}" />`;
    case "diamond":
      return `<rect x="7" y="7" width="10" height="10" fill="${color}" transform="rotate(45 12 12)" />`;
    case "triangle":
      return `<polygon points="12,5 19,18 5,18" fill="${color}" />`;
    case "square":
      return `<rect x="6.5" y="6.5" width="11" height="11" fill="${color}" />`;
    case "cross":
    default:
      return `<path d="M8 8 L16 16 M16 8 L8 16" stroke="${color}" stroke-width="2.5" stroke-linecap="round" />`;
  }
}

/** Same shapes as JSX, for the legend (no dangerouslySetInnerHTML needed here). */
function ShapeGlyph({ shape, color }: { shape: MarkerShape; color: string }) {
  switch (shape) {
    case "circle":
      return <circle cx="12" cy="12" r="6" fill={color} />;
    case "diamond":
      return <rect x="7" y="7" width="10" height="10" fill={color} transform="rotate(45 12 12)" />;
    case "triangle":
      return <polygon points="12,5 19,18 5,18" fill={color} />;
    case "square":
      return <rect x="6.5" y="6.5" width="11" height="11" fill={color} />;
    case "cross":
    default:
      return <path d="M8 8 L16 16 M16 8 L8 16" stroke={color} strokeWidth={2.5} strokeLinecap="round" />;
  }
}

/**
 * Builds a custom divIcon rather than an image-based Leaflet icon: it avoids
 * the broken default-marker-asset problem under Next.js bundling and lets
 * confidence and selection state drive size, halo and glow directly.
 */
function buildDivIcon(event: Event, isSelected: boolean): L.DivIcon {
  const { color, shape } = styleForClass(event.class);
  const confidence = Math.min(1, Math.max(0, event.confidence ?? 0));
  const scale = 0.75 + confidence * 0.5;
  const isHighConfidence = confidence >= HIGH_CONFIDENCE_THRESHOLD;
  const size = 26;

  const halo = isSelected
    ? `<circle cx="12" cy="12" r="10.5" fill="none" stroke="#e6ebf2" stroke-width="1.75" />`
    : isHighConfidence
      ? `<circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="1" opacity="0.5" />`
      : "";

  const glow = isSelected ? "filter: drop-shadow(0 0 4px rgba(230, 235, 242, 0.65));" : "";

  const html = `
    <div style="width:${size}px;height:${size}px;transform:scale(${scale});transform-origin:center;${glow}">
      <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        ${halo}
        ${shapeMarkup(shape, color)}
      </svg>
    </div>`;

  return L.divIcon({
    html,
    className: "geointel-marker",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function formatConfidence(confidence: number | undefined): string {
  if (confidence === undefined) return "—";
  return `${Math.round(confidence * 100)}%`;
}

function formatTimestamp(timestamp: string | undefined): string {
  if (!timestamp) return "Unknown time";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Recenters the map when the selected event changes, without a jarring zoom reset. */
function FlyToSelected({ event }: { event: Event | null }) {
  const map = useMap();

  useEffect(() => {
    if (!event) return;
    map.flyTo([event.latitude, event.longitude], Math.max(map.getZoom(), 8), {
      duration: 0.6,
    });
  }, [event, map]);

  return null;
}

export default function Map({ events, selectedEventId, onSelectEvent }: MapProps) {
  const viewport = useUIStore((state) => state.viewport);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

  const legendEntries = useMemo(() => {
    const present = new Set(events.map((event) => event.class));
    const entries = Object.entries(CLASS_STYLES);
    if (present.size === 0) return entries;
    const filtered = entries.filter(([key]) => present.has(key));
    return filtered.length > 0 ? filtered : entries;
  }, [events]);

  return (
    <div className="map-container">
      <MapContainer
        center={[viewport.latitude, viewport.longitude]}
        zoom={viewport.zoom}
        minZoom={3}
        maxZoom={18}
        zoomControl
        scrollWheelZoom
        attributionControl
        className="h-full w-full"
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <FlyToSelected event={selectedEvent} />

        {events.map((event) => {
          const isSelected = event.id === selectedEventId;
          const style = styleForClass(event.class);

          return (
            <Marker
              key={event.id}
              position={[event.latitude, event.longitude]}
              icon={buildDivIcon(event, isSelected)}
              zIndexOffset={isSelected ? 1000 : 0}
              eventHandlers={{
                click: () => onSelectEvent(event.id),
              }}
            >
              <Tooltip direction="top" offset={[0, -12]} opacity={1} className="geointel-tooltip">
                <span className="font-medium">{style.label}</span>
                {" · "}
                {formatConfidence(event.confidence)} confidence
              </Tooltip>

              <Popup>
                <div className="min-w-[10rem] text-xs">
                  <p className="font-semibold text-foreground">{style.label}</p>
                  <p className="mt-0.5 font-mono text-[0.7rem] text-foreground-muted">{event.id}</p>
                  <dl className="mt-2 space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-foreground-muted">Confidence</dt>
                      <dd className="font-medium text-foreground">{formatConfidence(event.confidence)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-foreground-muted">Status</dt>
                      <dd className="font-medium capitalize text-foreground">{event.status ?? "Unknown"}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-foreground-muted">Observed</dt>
                      <dd className="font-medium text-foreground">{formatTimestamp(event.timestamp)}</dd>
                    </div>
                  </dl>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      <div className="pointer-events-none absolute bottom-2 left-2 z-[1000] max-w-[11rem] rounded border border-border bg-surface/95 p-2 text-[0.7rem] leading-tight text-foreground-secondary shadow-panel backdrop-blur-sm">
        <p className="mb-1.5 text-[0.65rem] font-medium tracking-wide text-foreground-muted">
          Classification
        </p>
        <ul className="space-y-1">
          {legendEntries.map(([key, style]) => (
            <li key={key} className="flex items-center gap-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                <ShapeGlyph shape={style.shape} color={style.color} />
              </svg>
              <span>{style.label}</span>
            </li>
          ))}
        </ul>
      </div>

      {/*
        Leaflet's default control/popup/tooltip chrome is styled for a light
        page. These overrides pull it onto the same dark tokens as the rest
        of the dashboard without touching global stylesheets.
      */}
      <style>{`
        .leaflet-container {
          background-color: #0d131b;
          font-family: inherit;
        }
        .leaflet-control-zoom {
          border: 1px solid var(--border) !important;
          border-radius: var(--radius) !important;
          overflow: hidden;
        }
        .leaflet-control-zoom a {
          background-color: var(--bg-elevated) !important;
          color: var(--text-primary) !important;
          border-color: var(--border) !important;
        }
        .leaflet-control-zoom a:hover {
          background-color: var(--bg-hover) !important;
        }
        .leaflet-control-attribution {
          background-color: rgba(17, 24, 33, 0.75) !important;
          color: var(--text-muted) !important;
        }
        .leaflet-control-attribution a {
          color: var(--text-secondary) !important;
        }
        .leaflet-popup-content-wrapper {
          background-color: var(--bg-elevated);
          color: var(--text-primary);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius);
          box-shadow: var(--shadow-panel);
        }
        .leaflet-popup-tip {
          background-color: var(--bg-elevated);
          box-shadow: none;
        }
        .leaflet-popup-content {
          margin: 0.625rem 0.75rem;
        }
        .leaflet-popup-close-button {
          color: var(--text-muted) !important;
        }
        .geointel-tooltip {
          background-color: var(--bg-elevated) !important;
          color: var(--text-primary) !important;
          border: 1px solid var(--border) !important;
          border-radius: var(--radius) !important;
          font-size: 0.7rem !important;
          padding: 0.25rem 0.5rem !important;
          box-shadow: var(--shadow-panel);
        }
        .geointel-tooltip::before {
          border-top-color: var(--border) !important;
        }
        .geointel-marker {
          background: transparent;
          border: none;
        }
      `}</style>
    </div>
  );
}
