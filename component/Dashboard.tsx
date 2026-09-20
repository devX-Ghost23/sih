"use client";

import { useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, SlidersHorizontal, PanelRight, MapPin, X } from "lucide-react";

import { getEvents, getStats, isApiError } from "@/lib/api";
import { useUIStore } from "@/lib/store";
import type { Event, Stats } from "@/lib/types";

const Map = dynamic(() => import("./Map"), {
  ssr: false,
  loading: () => (
    <div className="map-container flex h-full items-center justify-center">
      <p className="text-xs text-foreground-muted">Loading map…</p>
    </div>
  ),
});

/* ==========================================================================
   Shared labels
   Kept in sync with the classes/statuses the mock and real data can produce.
   ========================================================================== */

const CLASS_LABELS: Record<string, string> = {
  industrial_fire: "Industrial fire",
  thermal_source: "Thermal source",
  gas_flare: "Gas flare",
  agricultural_burn: "Agricultural burn",
  unknown: "Unknown",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  monitoring: "Monitoring",
  unverified: "Unverified",
  resolved: "Resolved",
};

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

function formatUpdatedAt(timestamp: number | undefined): string {
  if (!timestamp) return "Not yet loaded";
  return `Updated ${new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}

/* ==========================================================================
   Dashboard
   ========================================================================== */

export default function Dashboard() {
  const selectedEventId = useUIStore((state) => state.selectedEventId);
  const isEventPanelOpen = useUIStore((state) => state.isEventPanelOpen);
  const selectEvent = useUIStore((state) => state.selectEvent);
  const clearSelectedEvent = useUIStore((state) => state.clearSelectedEvent);
  const setEventPanelOpen = useUIStore((state) => state.setEventPanelOpen);

  const [isFilterOpen, setFilterOpen] = useState(false);

  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => getEvents(),
  });

  const statsQuery = useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
  });

  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  );

  const isFetching = eventsQuery.isFetching || statsQuery.isFetching;
  const isError = eventsQuery.isError || statsQuery.isError;
  const isInitialLoading = eventsQuery.isLoading || statsQuery.isLoading;

  const status: "loading" | "operational" | "error" = isError
    ? "error"
    : isInitialLoading
      ? "loading"
      : "operational";

  const errorMessage = isApiError(eventsQuery.error)
    ? eventsQuery.error.message
    : isApiError(statsQuery.error)
      ? statsQuery.error.message
      : "The data service could not be reached.";

  const lastUpdatedAt = Math.max(eventsQuery.dataUpdatedAt, statsQuery.dataUpdatedAt) || undefined;

  const handleRefresh = () => {
    eventsQuery.refetch();
    statsQuery.refetch();
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <Header
        status={status}
        isFetching={isFetching}
        lastUpdatedLabel={formatUpdatedAt(lastUpdatedAt)}
        onRefresh={handleRefresh}
        onOpenFilters={() => setFilterOpen(true)}
        hasSelection={Boolean(selectedEventId)}
        onOpenEventPanel={() => setEventPanelOpen(true)}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-[13rem_1fr_16rem] md:p-3 lg:grid-cols-[16rem_1fr_20rem] lg:gap-3 lg:p-4">
        <section aria-labelledby="filters-heading" className="panel hidden min-h-0 flex-col md:flex">
          <div className="panel-header">
            <h2 id="filters-heading" className="panel-title">
              Filters
            </h2>
          </div>
          <div className="panel-body min-h-0 flex-1 overflow-y-auto">
            <FilterFields />
          </div>
        </section>

        <section
          aria-labelledby="map-heading"
          className="panel relative flex min-h-[22rem] flex-col md:min-h-0"
        >
          <div className="panel-header">
            <h2 id="map-heading" className="panel-title">
              Operational View
            </h2>
            <span className="text-label">
              {isInitialLoading ? "Loading" : `${events.length} tracked`}
            </span>
          </div>

          <div className="relative min-h-0 flex-1">
            <Map events={events} selectedEventId={selectedEventId} onSelectEvent={selectEvent} />

            {isError && (
              <div className="absolute inset-x-3 top-3 z-[500] rounded border border-danger/50 bg-surface-elevated px-3 py-2 text-xs shadow-panel">
                <p className="font-medium text-foreground">Unable to load events</p>
                <p className="mt-0.5 text-foreground-secondary">{errorMessage}</p>
              </div>
            )}
          </div>
        </section>

        <aside aria-labelledby="event-heading" className="panel hidden min-h-0 flex-col md:flex">
          <div className="panel-header">
            <h2 id="event-heading" className="panel-title">
              Event
            </h2>
            {selectedEventId && (
              <button
                type="button"
                onClick={clearSelectedEvent}
                className="btn btn-ghost px-2 py-1 text-xs"
              >
                Clear
              </button>
            )}
          </div>
          <div className="panel-body min-h-0 flex-1 overflow-y-auto">
            <EventPanelContent event={selectedEvent} />
          </div>
        </aside>
      </main>

      <StatisticsBar stats={statsQuery.data} isLoading={statsQuery.isLoading} />

      {isFilterOpen && (
        <MobileOverlay title="Filters" onClose={() => setFilterOpen(false)}>
          <FilterFields />
        </MobileOverlay>
      )}

      {isEventPanelOpen && selectedEventId && (
        <MobileOverlay title="Event" onClose={() => setEventPanelOpen(false)}>
          <EventPanelContent event={selectedEvent} />
        </MobileOverlay>
      )}
    </div>
  );
}

/* ==========================================================================
   Header
   ========================================================================== */

interface HeaderProps {
  status: "loading" | "operational" | "error";
  isFetching: boolean;
  lastUpdatedLabel: string;
  onRefresh: () => void;
  onOpenFilters: () => void;
  hasSelection: boolean;
  onOpenEventPanel: () => void;
}

function Header({
  status,
  isFetching,
  lastUpdatedLabel,
  onRefresh,
  onOpenFilters,
  hasSelection,
  onOpenEventPanel,
}: HeaderProps) {
  const statusDotClass =
    status === "operational"
      ? "status-dot-success status-dot-pulse"
      : status === "error"
        ? "status-dot-danger"
        : "status-dot-warning status-dot-pulse";

  const statusLabel =
    status === "operational" ? "Operational" : status === "error" ? "Service issue" : "Initializing";

  return (
    <header className="flex h-12 flex-none items-center justify-between gap-3 border-b border-border bg-surface px-3 md:px-4">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="text-sm font-semibold tracking-tight text-foreground">GeoIntel</h1>
        <span className="hidden truncate text-xs text-foreground-muted sm:inline">
          Geospatial Event Monitoring
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenFilters}
          className="btn btn-ghost btn-icon md:hidden"
          aria-label="Open filters"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>

        {hasSelection && (
          <button
            type="button"
            onClick={onOpenEventPanel}
            className="btn btn-ghost btn-icon md:hidden"
            aria-label="Open event details"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}

        <span className="hidden text-xs tabular text-foreground-muted sm:inline">
          {lastUpdatedLabel}
        </span>

        <div
          className="badge"
          role="status"
          aria-live="polite"
          aria-label={`System status: ${statusLabel}`}
        >
          <span className={`status-dot ${statusDotClass}`} aria-hidden="true" />
          {statusLabel}
        </div>

        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          className="btn btn-icon"
          aria-label="Refresh data"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </div>
    </header>
  );
}

/* ==========================================================================
   Filter area (temporary, non-functional placeholders)
   ========================================================================== */

function FilterFields() {
  return (
    <div className="space-y-4 text-xs">
      <div>
        <p className="text-label mb-2">Classification</p>
        <div className="space-y-1.5">
          {Object.entries(CLASS_LABELS).map(([key, label]) => (
            <label
              key={key}
              className="flex cursor-not-allowed items-center gap-2 text-foreground-secondary opacity-70"
            >
              <input
                type="checkbox"
                disabled
                className="h-3.5 w-3.5 rounded-sm border-border bg-surface-elevated accent-accent"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="divider" />

      <div>
        <p className="text-label mb-2">Confidence</p>
        <input
          type="range"
          disabled
          min={0}
          max={100}
          defaultValue={0}
          className="w-full cursor-not-allowed accent-accent opacity-60"
        />
        <div className="mt-1 flex justify-between text-[0.7rem] text-foreground-muted">
          <span>Any</span>
          <span>100%</span>
        </div>
      </div>

      <div className="divider" />

      <div>
        <p className="text-label mb-2">Status</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(STATUS_LABELS).map(([key, label]) => (
            <span key={key} className="badge cursor-not-allowed opacity-70">
              {label}
            </span>
          ))}
        </div>
      </div>

      <div className="divider" />

      <button type="button" disabled className="btn w-full cursor-not-allowed opacity-60">
        Reset filters
      </button>

      <p className="text-[0.7rem] leading-relaxed text-foreground-muted">
        Filtering controls are shown for reference and are not yet wired up.
      </p>
    </div>
  );
}

/* ==========================================================================
   Event panel (placeholder — full investigation view comes later)
   ========================================================================== */

function EventPanelContent({ event }: { event: Event | null }) {
  if (!event) {
    return (
      <div className="flex h-full min-h-[10rem] flex-col items-center justify-center gap-2 py-8 text-center">
        <MapPin className="h-5 w-5 text-foreground-muted" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">Select an event</p>
        <p className="max-w-[14rem] text-xs leading-relaxed text-foreground-muted">
          Choose a marker on the map to review its classification, confidence
          and evidence here.
        </p>
      </div>
    );
  }

  const label = CLASS_LABELS[event.class] ?? event.class;
  const statusLabel = event.status ? STATUS_LABELS[event.status] ?? event.status : "Unknown";

  return (
    <div className="space-y-4 text-xs">
      <div>
        <p className="text-label mb-1">Classification</p>
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <p className="mt-0.5 font-mono text-[0.7rem] text-foreground-muted">{event.id}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-label mb-1">Confidence</p>
          <p className="tabular text-sm font-medium text-foreground">
            {event.confidence !== undefined ? `${Math.round(event.confidence * 100)}%` : "—"}
          </p>
        </div>
        <div>
          <p className="text-label mb-1">Status</p>
          <p className="text-sm font-medium text-foreground">{statusLabel}</p>
        </div>
      </div>

      <div>
        <p className="text-label mb-1">Last observed</p>
        <p className="text-sm text-foreground-secondary">{formatTimestamp(event.timestamp)}</p>
      </div>

      <div className="divider" />

      <p className="text-[0.7rem] leading-relaxed text-foreground-muted">
        Full investigation details — evidence, persistence history and
        related infrastructure — are coming in a future update.
      </p>
    </div>
  );
}

/* ==========================================================================
   Statistics
   ========================================================================== */

function StatisticsBar({ stats, isLoading }: { stats: Stats | undefined; isLoading: boolean }) {
  const items: Array<{ label: string; value: number | undefined }> = [
    { label: "Total events", value: stats?.totalEvents },
    { label: "High confidence", value: stats?.highConfidence },
    { label: "Persistent", value: stats?.persistentEvents },
    { label: "Active", value: stats?.activeEvents },
  ];

  return (
    <footer className="flex flex-none divide-x divide-border-subtle overflow-x-auto border-t border-border bg-surface px-1 md:px-2">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-[8rem] flex-1 items-baseline gap-2 px-3.5 py-2.5">
          <span className="text-label">{item.label}</span>
          <span className="tabular text-base font-semibold text-foreground">
            {isLoading ? "—" : (item.value ?? 0).toLocaleString()}
          </span>
        </div>
      ))}
    </footer>
  );
}

/* ==========================================================================
   Mobile overlay
   Converts the filter and event panels into dismissible sheets below the
   md breakpoint, per the responsiveness requirement.
   ========================================================================== */

function MobileOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[1200] flex flex-col justify-end md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div className="panel-elevated relative max-h-[75dvh] overflow-y-auto rounded-t rounded-b-none">
        <div className="panel-header sticky top-0 bg-surface-elevated">
          <h2 className="panel-title">{title}</h2>
          <button type="button" onClick={onClose} className="btn btn-ghost btn-icon" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}
