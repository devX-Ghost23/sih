"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { getEvents, getStats, isApiError, isUsingMockData } from "@/lib/api";
import { useUIStore } from "@/lib/store";
import type { Event } from "@/lib/types";
import EventPanel from "./EventPanel";

/* ==========================================================================
   Map (client-only)
   Leaflet touches `window` on import, so it must never load during SSR.
   ========================================================================== */

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div
      className="map-grid-backdrop flex h-full w-full items-center justify-center bg-[#0d131b] text-[0.8125rem] text-foreground-secondary"
      role="status"
    >
      {message}
    </div>
  );
}

const EventMap = dynamic(() => import("./Map"), {
  ssr: false,
  loading: () => <MapPlaceholder message="Loading map" />,
});

/* ==========================================================================
   Helpers
   ========================================================================== */

const EMPTY_EVENTS: Event[] = [];
const REFRESH_INTERVAL_MS = 60_000;
const DASH = "\u2014";

const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function formatUtc(date: Date): string {
  return `${UTC_FORMAT.format(date)} UTC`;
}

function formatLabel(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced === "" ? "Unknown" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function countBy(events: readonly Event[], read: (event: Event) => string | undefined) {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const key = read(event);
    if (key !== undefined) counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function shareOf(value: number | undefined, total: number | undefined): string | undefined {
  if (value === undefined || total === undefined || total === 0) return undefined;
  return `${Math.round((value / total) * 100)}%`;
}

/* ==========================================================================
   Filter area (inactive placeholder for this build)
   ========================================================================== */

function FilterControls({
  classCounts,
  statusCounts,
}: {
  classCounts: ReadonlyArray<readonly [string, number]>;
  statusCounts: ReadonlyArray<readonly [string, number]>;
}) {
  return (
    <div className="flex flex-col gap-4 p-3.5">
      <fieldset disabled className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-xs font-medium text-foreground-secondary">Classification</legend>
        {classCounts.length === 0 ? (
          <p className="text-xs text-foreground-muted">No classes loaded.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {classCounts.map(([name, count]) => (
              <li key={name}>
                <label className="flex items-center gap-2 text-[0.8125rem] text-foreground-secondary">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-accent" />
                  <span className="min-w-0 flex-1 truncate">{formatLabel(name)}</span>
                  <span className="tabular text-xs text-foreground-muted">{count}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="divider" />

      <fieldset disabled className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-xs font-medium text-foreground-secondary">Confidence</legend>
        <label htmlFor="min-confidence" className="mb-1 flex justify-between text-[0.8125rem] text-foreground-secondary">
          <span>Minimum</span>
          <span className="tabular text-foreground-muted">0%</span>
        </label>
        <input
          id="min-confidence"
          type="range"
          min={0}
          max={100}
          defaultValue={0}
          className="w-full accent-accent"
        />
      </fieldset>

      <div className="divider" />

      <fieldset disabled className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-2 text-xs font-medium text-foreground-secondary">Status</legend>
        {statusCounts.length === 0 ? (
          <p className="text-xs text-foreground-muted">No statuses loaded.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {statusCounts.map(([name, count]) => (
              <li key={name}>
                <label className="flex items-center gap-2 text-[0.8125rem] text-foreground-secondary">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-accent" />
                  <span className="min-w-0 flex-1 truncate">{formatLabel(name)}</span>
                  <span className="tabular text-xs text-foreground-muted">{count}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <button type="button" className="btn w-full" disabled>
        Reset filters
      </button>
      <p className="text-xs leading-relaxed text-foreground-muted">
        Filtering is not active in this build. The map shows all events.
      </p>
    </div>
  );
}

/* ==========================================================================
   Statistics
   ========================================================================== */

function StatCell({
  label,
  value,
  share,
}: {
  label: string;
  value: number | undefined;
  share?: string;
}) {
  return (
    <div className="min-w-0 px-3 py-2 md:px-4">
      <dt className="text-xs leading-tight text-foreground-secondary">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-2">
        <span className="tabular text-lg font-semibold leading-tight text-foreground">
          {value === undefined ? DASH : value.toLocaleString("en-GB")}
        </span>
        {share && <span className="tabular text-xs text-foreground-muted">{share}</span>}
      </dd>
    </div>
  );
}

/* ==========================================================================
   Dashboard
   ========================================================================== */

export default function Dashboard() {
  const selectedEventId = useUIStore((state) => state.selectedEventId);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const usingMock = isUsingMockData();
  const refetchInterval = usingMock ? false : REFRESH_INTERVAL_MS;

  const eventsQuery = useQuery({
    queryKey: ["events"],
    queryFn: () => getEvents(),
    refetchInterval,
  });
  const statsQuery = useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
    refetchInterval,
  });

  const events = eventsQuery.data ?? EMPTY_EVENTS;
  const stats = statsQuery.data;

  const classCounts = useMemo(() => countBy(events, (event) => event.class), [events]);
  const statusCounts = useMemo(() => countBy(events, (event) => event.status), [events]);

  const { refetch: refetchEvents } = eventsQuery;
  const { refetch: refetchStats } = statsQuery;
  const handleRefresh = useCallback(() => {
    void Promise.all([refetchEvents(), refetchStats()]);
  }, [refetchEvents, refetchStats]);

  const isRefreshing = eventsQuery.isFetching || statsQuery.isFetching;
  const lastUpdatedMs = Math.max(eventsQuery.dataUpdatedAt, statsQuery.dataUpdatedAt);
  const lastUpdated = lastUpdatedMs > 0 ? new Date(lastUpdatedMs) : undefined;

  let systemStatus: { label: string; dot: string };
  if (eventsQuery.isError && statsQuery.isError) {
    systemStatus = { label: "Unavailable", dot: "status-dot-danger" };
  } else if (eventsQuery.isError || statsQuery.isError) {
    systemStatus = { label: "Degraded", dot: "status-dot-warning" };
  } else if (eventsQuery.isPending || statsQuery.isPending) {
    systemStatus = { label: "Connecting", dot: "status-dot-warning status-dot-pulse" };
  } else {
    systemStatus = { label: "Operational", dot: "status-dot-success" };
  }

  const eventsError = eventsQuery.error;
  const eventsErrorMessage = isApiError(eventsError)
    ? eventsError.message
    : "Event data could not be loaded.";

  const handleOverlayKeyDown = (keyEvent: KeyboardEvent<HTMLElement>) => {
    if (keyEvent.key === "Escape") setFiltersOpen(false);
  };

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <header className="flex h-12 flex-none items-center justify-between gap-3 border-b border-border bg-surface px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">GeoIntel</h1>
          <span className="hidden truncate text-xs text-foreground-muted lg:inline">
            Geospatial Event Monitoring
          </span>
          <span className="hidden h-4 w-px bg-border md:block" aria-hidden="true" />
          <div className="badge" role="status" aria-live="polite">
            <span className={`status-dot ${systemStatus.dot}`} aria-hidden="true" />
            <span className="sr-only">System status: </span>
            {systemStatus.label}
          </div>
          <div
            className="badge hidden md:inline-flex"
            title={
              usingMock
                ? "Events are generated locally and do not come from a backend."
                : `Data refreshes automatically every ${REFRESH_INTERVAL_MS / 1000} seconds.`
            }
          >
            <span
              className={`status-dot ${usingMock ? "" : "status-dot-success"}`}
              aria-hidden="true"
            />
            {usingMock ? "Simulated data" : "Live feed"}
          </div>
        </div>

        <div className="flex flex-none items-center gap-2">
          <p className="hidden text-xs text-foreground-secondary md:block">
            Updated{" "}
            {lastUpdated ? (
              <time dateTime={lastUpdated.toISOString()} className="tabular text-foreground">
                {formatUtc(lastUpdated)}
              </time>
            ) : (
              <span className="text-foreground-muted">{DASH}</span>
            )}
          </p>
          <button
            type="button"
            className="btn md:hidden"
            aria-expanded={filtersOpen}
            aria-controls="mobile-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            Filters
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleRefresh}
            disabled={isRefreshing}
            title={lastUpdated ? `Last updated ${formatUtc(lastUpdated)}` : "Load data"}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Refresh
          </button>
        </div>
      </header>

      {/* Workspace */}
      <main
        id="main-content"
        className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[13rem_minmax(0,1fr)_16rem] lg:grid-cols-[15rem_minmax(0,1fr)_21rem]"
      >
        <aside
          aria-label="Filters"
          className="hidden min-h-0 flex-col overflow-y-auto border-r border-border bg-surface md:flex"
        >
          <div className="panel-header">
            <h2 className="panel-title">Filters</h2>
          </div>
          <FilterControls classCounts={classCounts} statusCounts={statusCounts} />
        </aside>

        <section aria-label="Event map" className="relative min-h-0 min-w-0">
          <EventMap events={events} />

          {eventsQuery.isPending && (
            <div className="badge absolute left-1/2 top-2 z-[1000] -translate-x-1/2" role="status">
              Loading events
            </div>
          )}

          {eventsQuery.isError && (
            <div
              className="absolute inset-0 z-[1050] flex items-center justify-center bg-background/70 p-4"
              role="alert"
            >
              <div className="panel-elevated flex max-w-sm flex-col gap-3 p-4">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-danger" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-foreground">Events could not be loaded</p>
                    <p className="mt-1 text-[0.8125rem] leading-relaxed text-foreground-secondary">
                      {eventsErrorMessage}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn self-start"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                >
                  Try again
                </button>
              </div>
            </div>
          )}

          {/* Small screens: filters as an overlay */}
          {filtersOpen && (
            <div
              id="mobile-filters"
              role="dialog"
              aria-label="Filters"
              onKeyDown={handleOverlayKeyDown}
              className="panel-elevated absolute inset-x-2 top-10 z-[1100] max-h-[75%] overflow-y-auto md:hidden"
            >
              <div className="panel-header">
                <h2 className="panel-title">Filters</h2>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  aria-label="Close filters"
                  onClick={() => setFiltersOpen(false)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <FilterControls classCounts={classCounts} statusCounts={statusCounts} />
            </div>
          )}

          {/* Small screens: selected event as a bottom sheet */}
          {selectedEventId !== null && (
            <EventPanel className="panel-elevated absolute inset-x-2 bottom-7 z-[1100] max-h-[55%] animate-[panel-rise_150ms_ease-out] md:hidden" key={selectedEventId} />
          )}
        </section>

        <aside
          aria-label="Event details"
          className="hidden min-h-0 flex-col border-l border-border bg-surface md:flex"
        >
          <EventPanel className="h-full w-full" />
        </aside>
      </main>

      {/* Statistics */}
      <footer aria-label="Event statistics" className="flex-none border-t border-border bg-surface">
        <dl className="grid grid-cols-4 divide-x divide-border-subtle">
          <StatCell label="Total events" value={stats?.totalEvents} />
          <StatCell
            label="High confidence"
            value={stats?.highConfidence}
            share={shareOf(stats?.highConfidence, stats?.totalEvents)}
          />
          <StatCell
            label="Persistent"
            value={stats?.persistentEvents}
            share={shareOf(stats?.persistentEvents, stats?.totalEvents)}
          />
          <StatCell
            label="Active"
            value={stats?.activeEvents}
            share={shareOf(stats?.activeEvents, stats?.totalEvents)}
          />
        </dl>
      </footer>
    </div>
  );
}
