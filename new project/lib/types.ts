/**
 * Frontend-owned data contract.
 *
 * Every UI module (Dashboard, Map, EventPanel, Charts, ...) must consume only
 * these types. Backend field names never appear here; translation from any
 * backend shape into these types happens exclusively in lib/api.ts.
 */

/** A single observation of an event over time. */
export interface PersistencePoint {
  /** ISO 8601 timestamp of the observation. */
  timestamp: string;
  /** Normalized persistence score in the range 0 to 1. */
  value: number;
}

/** A piece of infrastructure, standalone or associated with an event. */
export interface Infrastructure {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Lowercase snake_case category, for example "refinery" or "power_plant". */
  type: string;
  /** Distance from the related event in kilometres, when associated with one. */
  distanceKm?: number;
}

/** A detected geographic event. */
export interface Event {
  id: string;
  latitude: number;
  longitude: number;
  /** ISO 8601 time of the most recent observation. */
  timestamp?: string;
  /** Lowercase snake_case classification, for example "industrial_fire". */
  class: string;
  /** Classification confidence in the range 0 to 1. */
  confidence?: number;
  /** Lowercase snake_case lifecycle status, for example "active". */
  status?: string;
  /** Class name to probability (0 to 1). Values approximately sum to 1. */
  probabilities?: Record<string, number>;
  /** Human-readable evidence statements supporting the classification. */
  evidence?: string[];
  /** Persistence history ordered from oldest to newest. */
  persistence?: PersistencePoint[];
  /** Infrastructure associated with or near this event. */
  infrastructure?: Infrastructure[];
}

/** Aggregate statistics for the dashboard summary. */
export interface Stats {
  totalEvents: number;
  highConfidence: number;
  persistentEvents: number;
  activeEvents: number;
  /** Event count per class, when available. */
  byClass?: Record<string, number>;
}

export type PersistenceFilter = "all" | "persistent" | "transient";

/** Event filter criteria. Empty arrays and empty strings mean "no restriction". */
export interface Filters {
  /** Restrict to these classes. Empty means all classes. */
  classes: string[];
  /** Minimum confidence in the range 0 to 1. Zero disables the restriction. */
  minConfidence: number;
  /** Restrict to these statuses. Empty means all statuses. */
  statuses: string[];
  persistence: PersistenceFilter;
  /** Inclusive lower bound. ISO 8601 date or date-time. */
  startDate?: string;
  /** Inclusive upper bound. ISO 8601 date or date-time. */
  endDate?: string;
  /** Free-text search across id, class, status, evidence and infrastructure. */
  search: string;
}

/** Map camera position. */
export interface Viewport {
  latitude: number;
  longitude: number;
  zoom: number;
}
