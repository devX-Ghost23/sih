"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Crosshair, MapPin, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { getEvent, isApiError } from "@/lib/api";
import { useUIStore } from "@/lib/store";
import type { Event } from "@/lib/types";
import { PersistenceChart, ProbabilityChart } from "./Charts";

/* ==========================================================================
   Formatting helpers
   ========================================================================== */

const FULL_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const CLOCK_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function formatLabel(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced === "" ? "Unknown" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function confidenceTier(confidence: number | undefined): string {
  if (confidence === undefined) return "Unknown confidence";
  if (confidence >= 0.8) return "High confidence";
  if (confidence >= 0.5) return "Moderate confidence";
  return "Low confidence";
}

function confidenceDotClass(confidence: number | undefined): string {
  if (confidence === undefined) return "";
  if (confidence >= 0.8) return "status-dot-success";
  if (confidence >= 0.5) return "status-dot-warning";
  return "status-dot-danger";
}

function statusDotClass(status: string | undefined): string {
  switch (status) {
    case "active":
      return "status-dot-success";
    case "monitoring":
    case "unverified":
      return "status-dot-warning";
    case "resolved":
      return "";
    default:
      return "status-dot-accent";
  }
}

/* ==========================================================================
   Sections
   ========================================================================== */

function SectionHeading({ children }: { children: string }) {
  return <h3 className="panel-title px-3.5 pt-3.5">{children}</h3>;
}

function EventHeader({ event, onClose }: { event: Event; onClose: () => void }) {
  const confidencePercent =
    event.confidence === undefined ? undefined : Math.round(event.confidence * 100);

  return (
    <div className="panel-header flex-none">
      <div className="min-w-0">
        <p className="text-label mb-0.5">
          Event <span className="font-mono normal-case tracking-normal">{event.id}</span>
        </p>
        <h2 className="truncate text-sm font-semibold text-foreground">{formatLabel(event.class)}</h2>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground-secondary">
          <span className={`status-dot ${confidenceDotClass(event.confidence)}`} aria-hidden="true" />
          {confidenceTier(event.confidence)}
        </p>
      </div>

      <div className="flex flex-none items-start gap-3">
        {confidencePercent !== undefined && (
          <div className="text-right">
            <p className="tabular text-lg font-semibold leading-tight text-foreground">
              {confidencePercent}%
            </p>
            <p className="text-[0.6875rem] text-foreground-muted">Confidence</p>
          </div>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Close event panel"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function SummarySection({ event }: { event: Event }) {
  const date = event.timestamp ? new Date(event.timestamp) : undefined;
  const validDate = date && !Number.isNaN(date.getTime()) ? date : undefined;

  return (
    <div className="grid grid-cols-3 divide-x divide-border-subtle border-b border-border-subtle">
      <div className="px-3.5 py-2.5">
        <p className="text-[0.6875rem] text-foreground-muted">Status</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[0.8125rem] text-foreground">
          <span className={`status-dot ${statusDotClass(event.status)}`} aria-hidden="true" />
          {event.status ? formatLabel(event.status) : "Not available"}
        </p>
      </div>
      <div className="px-3.5 py-2.5">
        <p className="text-[0.6875rem] text-foreground-muted">Date</p>
        <p className="tabular mt-0.5 text-[0.8125rem] text-foreground">
          {validDate ? FULL_TIME.format(validDate) : "Not available"}
        </p>
      </div>
      <div className="px-3.5 py-2.5">
        <p className="text-[0.6875rem] text-foreground-muted">Time</p>
        <p className="tabular mt-0.5 text-[0.8125rem] text-foreground">
          {validDate ? `${CLOCK_TIME.format(validDate)} UTC` : "Not available"}
        </p>
      </div>
    </div>
  );
}

function LocationSection({ event }: { event: Event }) {
  return (
    <section aria-labelledby="location-heading" className="border-b border-border-subtle">
      <SectionHeading>Location</SectionHeading>
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <MapPin className="h-3.5 w-3.5 flex-none text-foreground-muted" aria-hidden="true" />
        <dl className="grid grid-cols-2 gap-x-4 text-[0.8125rem]">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-foreground-muted">Lat</dt>
            <dd className="tabular text-foreground">{event.latitude.toFixed(5)}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-foreground-muted">Lon</dt>
            <dd className="tabular text-foreground">{event.longitude.toFixed(5)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function EvidenceSection({ evidence }: { evidence: string[] | undefined }) {
  return (
    <section aria-labelledby="evidence-heading" className="border-b border-border-subtle">
      <SectionHeading>Evidence</SectionHeading>
      <div className="px-3.5 py-2.5">
        {!evidence || evidence.length === 0 ? (
          <p className="text-[0.8125rem] text-foreground-muted">No evidence available.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {evidence.map((item, index) => (
              <li
                // Evidence has no stable id from the backend; index is fine
                // since this list is not reordered or filtered client-side.
                key={index}
                className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-foreground-secondary"
              >
                <span className="mt-[0.4em] h-1 w-1 flex-none rounded-full bg-foreground-muted" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ProbabilitySection({ event }: { event: Event }) {
  return (
    <section aria-labelledby="probability-heading" className="border-b border-border-subtle">
      <SectionHeading>Classification Probability</SectionHeading>
      <div className="px-3.5 pb-3 pt-2">
        <ProbabilityChart probabilities={event.probabilities} highlightKey={event.class} />
      </div>
    </section>
  );
}

function PersistenceSection({ event }: { event: Event }) {
  return (
    <section aria-labelledby="persistence-heading" className="border-b border-border-subtle">
      <SectionHeading>Persistence History</SectionHeading>
      <div className="px-3.5 pb-3 pt-2">
        <PersistenceChart persistence={event.persistence} />
      </div>
    </section>
  );
}

function InfrastructureSection({ event }: { event: Event }) {
  const infrastructure = event.infrastructure ?? [];
  if (infrastructure.length === 0) return null;

  return (
    <section aria-labelledby="infrastructure-heading">
      <SectionHeading>Nearby Infrastructure</SectionHeading>
      <ul className="flex flex-col divide-y divide-border-subtle px-3.5 py-1">
        {infrastructure.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-[0.8125rem] text-foreground">{item.name}</p>
              <p className="text-xs text-foreground-muted">{formatLabel(item.type)}</p>
            </div>
            {item.distanceKm !== undefined && (
              <span className="badge flex-none">{item.distanceKm.toFixed(1)} km</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ==========================================================================
   States: empty, loading, error
   ========================================================================== */

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-border-strong text-foreground-muted"
        aria-hidden="true"
      >
        <Crosshair className="h-5 w-5" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">Select an event</p>
        <p className="mx-auto mt-1 max-w-[15rem] text-[0.8125rem] leading-relaxed text-foreground-secondary">
          Choose a marker on the map to review its classification, evidence and history.
        </p>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10" role="status">
      <p className="text-[0.8125rem] text-foreground-muted">Loading event</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center" role="alert">
      <AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-foreground">Event could not be loaded</p>
        <p className="mx-auto mt-1 max-w-[15rem] text-[0.8125rem] leading-relaxed text-foreground-secondary">
          {message}
        </p>
      </div>
      <button type="button" className="btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/* ==========================================================================
   EventPanel
   ========================================================================== */

export default function EventPanel({ className = "" }: { className?: string }) {
  const selectedEventId = useUIStore((state) => state.selectedEventId);
  const clearSelectedEvent = useUIStore((state) => state.clearSelectedEvent);

  const eventQuery = useQuery({
    queryKey: ["event", selectedEventId],
    queryFn: () => getEvent(selectedEventId as string),
    enabled: selectedEventId !== null,
  });

  // Focus the panel when a new event is selected so keyboard and screen
  // reader users land on the content rather than staying on the map.
  const headingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selectedEventId !== null) headingRef.current?.focus();
  }, [selectedEventId]);

  const containerClass = `flex min-h-0 flex-col ${className}`;

  if (selectedEventId === null) {
    return (
      <div className={containerClass}>
        <div className="panel-header flex-none">
          <h2 className="panel-title">Event Details</h2>
        </div>
        <EmptyState />
      </div>
    );
  }

  if (eventQuery.isPending) {
    return (
      <div className={containerClass}>
        <div className="panel-header flex-none">
          <h2 className="panel-title">Event Details</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Close event panel"
            onClick={clearSelectedEvent}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <LoadingState />
      </div>
    );
  }

  if (eventQuery.isError || !eventQuery.data) {
    const message = isApiError(eventQuery.error)
      ? eventQuery.error.message
      : "This event's details could not be retrieved.";
    return (
      <div className={containerClass}>
        <div className="panel-header flex-none">
          <h2 className="panel-title">Event Details</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Close event panel"
            onClick={clearSelectedEvent}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <ErrorState message={message} onRetry={() => eventQuery.refetch()} />
      </div>
    );
  }

  const event = eventQuery.data;

  return (
    <div className={containerClass}>
      {/* -1 keeps this focusable programmatically without adding a tab stop */}
      <div ref={headingRef} tabIndex={-1} className="sr-only">
        {formatLabel(event.class)} details for event {event.id}
      </div>

      <EventHeader event={event} onClose={clearSelectedEvent} />

      <div
        key={event.id}
        className="min-h-0 flex-1 overflow-y-auto animate-[content-fade_150ms_ease-out]"
      >
        <SummarySection event={event} />
        <LocationSection event={event} />
        <EvidenceSection evidence={event.evidence} />
        <ProbabilitySection event={event} />
        <PersistenceSection event={event} />
        <InfrastructureSection event={event} />
      </div>
    </div>
  );
}
