/**
 * Data access layer.
 *
 * This is the ONLY module that talks to backend data. It owns:
 *   - transport (fetch, timeouts, error mapping)
 *   - endpoint paths and query parameter names
 *   - normalization of any backend response shape into the frontend types
 *   - deterministic mock data used when NEXT_PUBLIC_USE_MOCK_DATA=true
 *
 * UI code must call only getEvents, getEvent, getStats and getInfrastructure,
 * and must never call fetch() directly.
 */

import type {
  Event,
  Filters,
  Infrastructure,
  PersistencePoint,
  Stats,
} from "./types";

/* ==========================================================================
   Configuration
   ========================================================================== */

/** Inlined at build time by Next.js, so the reference must stay literal. */
const USE_MOCK_DATA = process.env.NEXT_PUBLIC_USE_MOCK_DATA === "true";

/**
 * Same-origin base path used when running in the browser. BACKEND_API_URL is
 * a server-only variable and is not available in client bundles, so browser
 * requests go through the same-origin Next.js proxy routes under app/api/*,
 * which forward to BACKEND_API_URL server-side.
 */
const BROWSER_BASE_PATH = "/api";

const REQUEST_TIMEOUT_MS = 15_000;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;
const PERSISTENCE_MIN_POINTS = 3;
const PERSISTENCE_RECENT_POINTS = 3;
const PERSISTENCE_THRESHOLD = 0.6;

/** Backend endpoint paths. Change here if the backend uses other names. */
const ENDPOINTS = {
  events: "/events",
  event: (id: string) => `/events/${encodeURIComponent(id)}`,
  stats: "/stats",
  infrastructure: "/infrastructure",
} as const;

export function isUsingMockData(): boolean {
  return USE_MOCK_DATA;
}

/* ==========================================================================
   Errors
   ========================================================================== */

export type ApiErrorCode =
  | "config"
  | "network"
  | "timeout"
  | "unauthorized"
  | "not_found"
  | "server"
  | "request_failed"
  | "invalid_response";

/**
 * Error surfaced to the UI. Messages are safe to display: they never contain
 * backend URLs, response bodies, stack traces or credentials.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status?: number;

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function errorForStatus(status: number): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError("unauthorized", "Access to the data service was denied.", status);
  }
  if (status === 404) {
    return new ApiError("not_found", "The requested data was not found.", status);
  }
  if (status >= 500) {
    return new ApiError("server", "The data service is currently unavailable.", status);
  }
  return new ApiError("request_failed", "The data request could not be completed.", status);
}

/* ==========================================================================
   Transport
   ========================================================================== */

function resolveBaseUrl(): string {
  if (typeof window === "undefined") {
    const serverUrl = process.env.BACKEND_API_URL?.trim();
    if (!serverUrl) {
      throw new ApiError("config", "The data service is not configured.");
    }
    return serverUrl.replace(/\/+$/, "");
  }
  return BROWSER_BASE_PATH;
}

async function requestJson(path: string, params?: URLSearchParams): Promise<unknown> {
  const base = resolveBaseUrl();
  const query = params?.toString();
  const url = query ? `${base}${path}?${query}` : `${base}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw errorForStatus(response.status);
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ApiError("invalid_response", "The data service returned an unreadable response.");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("timeout", "The data service took too long to respond.");
    }
    throw new ApiError("network", "The data service could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

/* ==========================================================================
   Normalization helpers
   ========================================================================== */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(source: UnknownRecord, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Returns the first defined, non-null value found at any of the given paths. */
function pick(source: UnknownRecord, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function toId(value: unknown): string | undefined {
  // Some document stores serialize identifiers as { "$oid": "..." }.
  if (isRecord(value)) return toText(value["$oid"]);
  return toText(value);
}

function normalizeLabel(text: string): string {
  return text.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function toLabel(value: unknown): string | undefined {
  const text = toText(value);
  return text === undefined ? undefined : normalizeLabel(text);
}

function toCount(value: unknown): number | undefined {
  const parsed = toNumber(value);
  return parsed === undefined || parsed < 0 ? undefined : Math.trunc(parsed);
}

/** Accepts 0-1 fractions or 0-100 percentages and returns a 0-1 fraction. */
function toUnitInterval(value: unknown): number | undefined {
  const parsed = toNumber(value);
  if (parsed === undefined || parsed < 0) return undefined;
  if (parsed <= 1) return parsed;
  if (parsed <= 100) return parsed / 100;
  return undefined;
}

/** Accepts ISO strings, epoch seconds or epoch milliseconds. Returns ISO 8601. */
function toIsoTimestamp(value: unknown): string | undefined {
  let millis: number | undefined;

  if (typeof value === "number" && Number.isFinite(value)) {
    millis = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim() !== "") {
    const text = value.trim();
    if (/^\d+(\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      millis = numeric < 1e12 ? numeric * 1000 : numeric;
    } else {
      millis = Date.parse(text);
    }
  }

  if (millis === undefined || !Number.isFinite(millis)) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compact<T>(items: ReadonlyArray<T | null>): T[] {
  return items.filter((item): item is T => item !== null);
}

function readCoordinates(
  record: UnknownRecord
): { latitude: number; longitude: number } | undefined {
  let latitude = toNumber(
    pick(record, ["latitude", "lat", "location.latitude", "location.lat"])
  );
  let longitude = toNumber(
    pick(record, ["longitude", "lon", "lng", "location.longitude", "location.lon", "location.lng"])
  );

  if (latitude === undefined || longitude === undefined) {
    // GeoJSON-style [longitude, latitude]
    const coordinates = pick(record, [
      "location.coordinates",
      "geometry.coordinates",
      "coordinates",
    ]);
    if (Array.isArray(coordinates) && coordinates.length >= 2) {
      longitude = toNumber(coordinates[0]);
      latitude = toNumber(coordinates[1]);
    }
  }

  if (latitude === undefined || longitude === undefined) return undefined;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  return { latitude, longitude };
}

/* ==========================================================================
   Response unwrapping
   ========================================================================== */

const EVENT_COLLECTION_KEYS = ["events", "data", "results", "items"] as const;
const INFRASTRUCTURE_COLLECTION_KEYS = [
  "infrastructure",
  "data",
  "results",
  "items",
] as const;
const EVENT_RECORD_KEYS = ["event", "data", "result"] as const;
const STATS_RECORD_KEYS = ["stats", "statistics", "data", "result"] as const;

function findCollection(
  payload: unknown,
  keys: readonly string[],
  depth: number
): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload) || depth > 2) return undefined;
  for (const key of keys) {
    const found = findCollection(payload[key], keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function unwrapCollection(payload: unknown, keys: readonly string[]): unknown[] {
  const collection = findCollection(payload, keys, 0);
  if (!collection) {
    throw new ApiError("invalid_response", "The data service returned an unexpected response.");
  }
  return collection;
}

function unwrapRecord(payload: unknown, keys: readonly string[]): UnknownRecord {
  if (!isRecord(payload)) {
    throw new ApiError("invalid_response", "The data service returned an unexpected response.");
  }
  for (const key of keys) {
    const inner = payload[key];
    if (isRecord(inner)) return inner;
  }
  return payload;
}

/* ==========================================================================
   Normalizers: backend shape -> frontend types
   ========================================================================== */

function normalizeProbabilities(value: unknown): Record<string, number> | undefined {
  const entries: Array<[string, number]> = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const label = toLabel(pick(item, ["class", "label", "name", "event_class", "classification"]));
      const probability = toNumber(pick(item, ["probability", "score", "value", "p"]));
      if (label !== undefined && probability !== undefined && probability >= 0) {
        entries.push([label, probability]);
      }
    }
  } else if (isRecord(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const label = toLabel(key);
      const probability = toNumber(raw);
      if (label !== undefined && probability !== undefined && probability >= 0) {
        entries.push([label, probability]);
      }
    }
  }

  if (entries.length === 0) return undefined;

  // Values above 1 indicate percentages rather than fractions.
  const largest = Math.max(...entries.map(([, probability]) => probability));
  const divisor = largest > 1 ? 100 : 1;

  const result: Record<string, number> = {};
  for (const [label, probability] of entries) {
    result[label] = Math.min(1, probability / divisor);
  }
  return result;
}

function normalizeEvidence(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const result: string[] = [];

  for (const item of items) {
    const text = isRecord(item)
      ? toText(pick(item, ["description", "text", "summary", "label", "title"]))
      : toText(item);
    if (text !== undefined) result.push(text);
  }
  return result.length > 0 ? result : undefined;
}

function normalizePersistence(value: unknown): PersistencePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: PersistencePoint[] = [];

  for (const item of value) {
    let timestamp: string | undefined;
    let pointValue: number | undefined;

    if (Array.isArray(item)) {
      timestamp = toIsoTimestamp(item[0]);
      pointValue = toUnitInterval(item[1]);
    } else if (isRecord(item)) {
      timestamp = toIsoTimestamp(
        pick(item, ["timestamp", "time", "date", "ts", "observed_at"])
      );
      pointValue = toUnitInterval(
        pick(item, ["value", "score", "persistence", "intensity", "confidence"])
      );
    }

    if (timestamp !== undefined && pointValue !== undefined) {
      points.push({ timestamp, value: pointValue });
    }
  }

  if (points.length === 0) return undefined;
  return points.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function normalizeInfrastructureItem(value: unknown): Infrastructure | null {
  if (!isRecord(value)) return null;
  const id = toId(pick(value, ["id", "infrastructure_id", "_id"]));
  const coordinates = readCoordinates(value);
  if (id === undefined || coordinates === undefined) return null;

  const item: Infrastructure = {
    id,
    name: toText(pick(value, ["name", "title", "label"])) ?? id,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    type: toLabel(pick(value, ["type", "category", "kind", "infrastructure_type"])) ?? "unknown",
  };

  const distance = toNumber(pick(value, ["distanceKm", "distance_km", "distance"]));
  if (distance !== undefined && distance >= 0) item.distanceKm = distance;
  return item;
}

function normalizeInfrastructureList(value: unknown): Infrastructure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = compact(value.map(normalizeInfrastructureItem));
  return items.length > 0 ? items : undefined;
}

function normalizeEvent(value: unknown): Event | null {
  if (!isRecord(value)) return null;

  const id = toId(pick(value, ["id", "event_id", "_id"]));
  const coordinates = readCoordinates(value);
  if (id === undefined || coordinates === undefined) return null;

  const eventClass =
    toLabel(pick(value, ["class", "event_class", "classification", "event_type"])) ?? "unknown";

  const event: Event = {
    id,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    class: eventClass,
  };

  const timestamp = toIsoTimestamp(
    pick(value, ["timestamp", "time", "detected_at", "observed_at", "created_at", "date"])
  );
  if (timestamp !== undefined) event.timestamp = timestamp;

  const status = toLabel(pick(value, ["status", "state"]));
  if (status !== undefined) event.status = status;

  const probabilities = normalizeProbabilities(
    pick(value, ["probabilities", "class_probabilities"])
  );
  if (probabilities !== undefined) event.probabilities = probabilities;

  const confidence =
    toUnitInterval(pick(value, ["confidence", "probability"])) ?? probabilities?.[eventClass];
  if (confidence !== undefined) event.confidence = confidence;

  const evidence = normalizeEvidence(pick(value, ["evidence"]));
  if (evidence !== undefined) event.evidence = evidence;

  const persistence = normalizePersistence(pick(value, ["persistence", "history"]));
  if (persistence !== undefined) event.persistence = persistence;

  const infrastructure = normalizeInfrastructureList(
    pick(value, ["infrastructure", "nearby_infrastructure"])
  );
  if (infrastructure !== undefined) event.infrastructure = infrastructure;

  return event;
}

function normalizeEventList(payload: unknown): Event[] {
  return compact(unwrapCollection(payload, EVENT_COLLECTION_KEYS).map(normalizeEvent));
}

function normalizeSingleEvent(payload: unknown): Event {
  const event = normalizeEvent(unwrapRecord(payload, EVENT_RECORD_KEYS));
  if (!event) {
    throw new ApiError("invalid_response", "The data service returned an unexpected event.");
  }
  return event;
}

function normalizeStats(payload: unknown): Stats {
  const source = unwrapRecord(payload, STATS_RECORD_KEYS);

  const totalEvents = toCount(
    pick(source, ["totalEvents", "total_events", "total", "count", "events"])
  );
  if (totalEvents === undefined) {
    throw new ApiError("invalid_response", "The data service returned unexpected statistics.");
  }

  const stats: Stats = {
    totalEvents,
    highConfidence:
      toCount(pick(source, ["highConfidence", "high_confidence", "high_confidence_events"])) ?? 0,
    persistentEvents:
      toCount(pick(source, ["persistentEvents", "persistent_events", "persistent"])) ?? 0,
    activeEvents: toCount(pick(source, ["activeEvents", "active_events", "active"])) ?? 0,
  };

  const byClassRaw = pick(source, ["byClass", "by_class", "class_counts"]);
  if (isRecord(byClassRaw)) {
    const byClass: Record<string, number> = {};
    for (const [key, raw] of Object.entries(byClassRaw)) {
      const count = toCount(raw);
      if (count !== undefined) byClass[normalizeLabel(key)] = count;
    }
    if (Object.keys(byClass).length > 0) stats.byClass = byClass;
  }

  return stats;
}

/* ==========================================================================
   Domain logic shared by real and mock data
   ========================================================================== */

/**
 * An event is persistent when it has enough history and its most recent
 * observations remain above the persistence threshold on average.
 */
export function isPersistentEvent(event: Event): boolean {
  const points = event.persistence;
  if (!points || points.length < PERSISTENCE_MIN_POINTS) return false;
  const recent = points.slice(-PERSISTENCE_RECENT_POINTS);
  const average = recent.reduce((sum, point) => sum + point.value, 0) / recent.length;
  return average >= PERSISTENCE_THRESHOLD;
}

function endOfRangeMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  // A date-only value covers the whole day.
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? parsed + 86_399_999 : parsed;
}

function startOfRangeMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matchesSearch(event: Event, term: string): boolean {
  const haystack = [
    event.id,
    event.class,
    event.status ?? "",
    ...(event.evidence ?? []),
    ...(event.infrastructure ?? []).map((item) => item.name),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(term);
}

/** Applies filters client-side so behaviour is identical for mock and real data. */
export function applyFilters(events: readonly Event[], filters?: Partial<Filters>): Event[] {
  if (!filters) return [...events];

  const classes = new Set((filters.classes ?? []).map(normalizeLabel));
  const statuses = new Set((filters.statuses ?? []).map(normalizeLabel));
  const minConfidence = filters.minConfidence ?? 0;
  const persistence = filters.persistence ?? "all";
  const start = startOfRangeMillis(filters.startDate);
  const end = endOfRangeMillis(filters.endDate);
  const term = filters.search?.trim().toLowerCase() ?? "";

  return events.filter((event) => {
    if (classes.size > 0 && !classes.has(event.class)) return false;
    if (statuses.size > 0 && (event.status === undefined || !statuses.has(event.status))) {
      return false;
    }
    if (minConfidence > 0 && (event.confidence === undefined || event.confidence < minConfidence)) {
      return false;
    }
    if (persistence !== "all") {
      const persistent = isPersistentEvent(event);
      if (persistence === "persistent" && !persistent) return false;
      if (persistence === "transient" && persistent) return false;
    }
    if (start !== undefined || end !== undefined) {
      if (event.timestamp === undefined) return false;
      const time = Date.parse(event.timestamp);
      if (start !== undefined && time < start) return false;
      if (end !== undefined && time > end) return false;
    }
    if (term !== "" && !matchesSearch(event, term)) return false;
    return true;
  });
}

function computeStats(events: readonly Event[]): Stats {
  const byClass: Record<string, number> = {};
  let highConfidence = 0;
  let persistentEvents = 0;
  let activeEvents = 0;

  for (const event of events) {
    byClass[event.class] = (byClass[event.class] ?? 0) + 1;
    if ((event.confidence ?? 0) >= HIGH_CONFIDENCE_THRESHOLD) highConfidence += 1;
    if (isPersistentEvent(event)) persistentEvents += 1;
    if (event.status === "active") activeEvents += 1;
  }

  return { totalEvents: events.length, highConfidence, persistentEvents, activeEvents, byClass };
}

/** Query parameter names sent to the backend. Change here if the backend differs. */
function buildEventQuery(filters?: Partial<Filters>): URLSearchParams {
  const params = new URLSearchParams();
  if (!filters) return params;

  if (filters.classes && filters.classes.length > 0) params.set("class", filters.classes.join(","));
  if (filters.statuses && filters.statuses.length > 0) params.set("status", filters.statuses.join(","));
  if (filters.minConfidence !== undefined && filters.minConfidence > 0) {
    params.set("min_confidence", String(filters.minConfidence));
  }
  if (filters.persistence && filters.persistence !== "all") {
    params.set("persistent", filters.persistence === "persistent" ? "true" : "false");
  }
  if (filters.startDate) params.set("start_date", filters.startDate);
  if (filters.endDate) params.set("end_date", filters.endDate);
  if (filters.search && filters.search.trim() !== "") params.set("q", filters.search.trim());
  return params;
}

/* ==========================================================================
   Deterministic mock data
   Seeded generation with a fixed reference time. No Math.random(), no
   Date.now(): the same data is produced on every render, server and client.
   ========================================================================== */

const MOCK_SEED = 1;
const MOCK_REFERENCE_TIME = Date.UTC(2026, 8, 18, 6, 0, 0);
const HOUR_MS = 3_600_000;
const PERSISTENCE_STEP_MS = 6 * HOUR_MS;
const NEARBY_INFRASTRUCTURE_KM = 30;

const MOCK_CLASSES = [
  "industrial_fire",
  "thermal_source",
  "gas_flare",
  "agricultural_burn",
  "unknown",
] as const;
type MockClass = (typeof MOCK_CLASSES)[number];

/** Illustrative infrastructure locations across eastern India. */
const MOCK_INFRASTRUCTURE: readonly Infrastructure[] = [
  { id: "infra-001", name: "Coastal Refinery Complex", latitude: 20.27, longitude: 86.65, type: "refinery" },
  { id: "infra-002", name: "Angul Thermal Power Station", latitude: 20.84, longitude: 85.15, type: "power_plant" },
  { id: "infra-003", name: "Jharsuguda Aluminium Smelter", latitude: 21.85, longitude: 84.03, type: "smelter" },
  { id: "infra-004", name: "Rourkela Steel Works", latitude: 22.23, longitude: 84.87, type: "steel_plant" },
  { id: "infra-005", name: "Kalinganagar Steel Complex", latitude: 20.96, longitude: 86.04, type: "steel_plant" },
  { id: "infra-006", name: "Haldia Petrochemical Complex", latitude: 22.05, longitude: 88.07, type: "chemical_plant" },
  { id: "infra-007", name: "Visakhapatnam Port Terminal", latitude: 17.69, longitude: 83.29, type: "port" },
  { id: "infra-008", name: "Korba Power Cluster", latitude: 22.36, longitude: 82.71, type: "power_plant" },
  { id: "infra-009", name: "Jamshedpur Steel Works", latitude: 22.8, longitude: 86.2, type: "steel_plant" },
  { id: "infra-010", name: "Talcher Coalfield", latitude: 20.95, longitude: 85.23, type: "mine" },
];

const CLASS_COUNTS: Record<MockClass, number> = {
  industrial_fire: 8,
  thermal_source: 8,
  gas_flare: 6,
  agricultural_burn: 4,
  unknown: 4,
};

const CLASS_SITE_TYPES: Record<MockClass, readonly string[]> = {
  industrial_fire: ["refinery", "steel_plant", "chemical_plant", "smelter"],
  thermal_source: ["power_plant", "smelter", "steel_plant", "mine"],
  gas_flare: ["refinery", "chemical_plant", "port"],
  agricultural_burn: [],
  unknown: [],
};

const CLASS_CONFIDENCE_RANGE: Record<MockClass, readonly [number, number]> = {
  industrial_fire: [0.55, 0.97],
  thermal_source: [0.5, 0.95],
  gas_flare: [0.6, 0.98],
  agricultural_burn: [0.5, 0.9],
  unknown: [0.38, 0.55],
};

type Rng = () => number;

const EVIDENCE_TEMPLATES: Record<MockClass, ReadonlyArray<(rng: Rng) => string>> = {
  industrial_fire: [
    (rng) => `Thermal anomaly of ${Math.round(340 + rng() * 120)} K brightness temperature above local baseline`,
    () => "Smoke plume signature visible in shortwave infrared bands",
    () => "Hotspot located inside the facility perimeter",
    (rng) => `Heat signature spans ${(2 + rng() * 14).toFixed(1)} ha, larger than routine process heat`,
    () => "No matching scheduled maintenance record",
  ],
  gas_flare: [
    () => "Stable point-source hotspot consistent with flare stack geometry",
    (rng) => `Radiant heat estimate of ${(4 + rng() * 40).toFixed(1)} MW`,
    () => "Spectral signature dominated by hydrocarbon combustion",
    () => "Repeated detections at the same pixel across consecutive passes",
  ],
  thermal_source: [
    () => "Elevated thermal signature with no visible smoke",
    (rng) => `Surface temperature ${(8 + rng() * 25).toFixed(1)} K above surrounding area`,
    () => "Consistent diurnal heating pattern",
    () => "Location matches a known industrial heat source",
  ],
  agricultural_burn: [
    () => "Irregular fire front over cropland land-cover class",
    () => "Seasonal burn activity pattern for the region",
    () => "Short-lived detections with rapid spatial change",
    () => "Smoke drifting downwind from the burn area",
  ],
  unknown: [
    () => "Thermal anomaly detected but spectral signature is ambiguous",
    () => "Insufficient overlapping observations for classification",
    () => "Detection near cloud edge reduces retrieval quality",
    () => "Conflicting indicators across sensor bands",
  ],
};

type PersistencePattern = "sustained" | "decaying" | "intermittent" | "emerging";

/** Mulberry32: small, fast, seedable pseudo-random generator. */
function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function pickPattern(rng: Rng): PersistencePattern {
  const roll = rng();
  if (roll < 0.3) return "sustained";
  if (roll < 0.6) return "decaying";
  if (roll < 0.85) return "intermittent";
  return "emerging";
}

function statusForPattern(pattern: PersistencePattern, confidence: number, rng: Rng): string {
  switch (pattern) {
    case "sustained":
      return "active";
    case "emerging":
      return confidence < 0.6 ? "unverified" : "active";
    case "intermittent":
      return "monitoring";
    case "decaying":
      return rng() < 0.5 ? "resolved" : "monitoring";
  }
}

function buildProbabilities(
  eventClass: MockClass,
  confidence: number,
  rng: Rng
): Record<string, number> {
  const others = MOCK_CLASSES.filter((candidate) => candidate !== eventClass);
  const weights = others.map(() => 0.5 + rng() * 0.8);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const remaining = 1 - confidence;

  const values: Record<string, number> = {};
  let assigned = 0;
  others.forEach((other, index) => {
    const value = round((remaining * weights[index]) / totalWeight, 3);
    values[other] = value;
    assigned += value;
  });
  values[eventClass] = round(1 - assigned, 3);

  return Object.fromEntries(Object.entries(values).sort((a, b) => b[1] - a[1]));
}

function buildPersistence(
  pattern: PersistencePattern,
  lastObservation: number,
  rng: Rng
): PersistencePoint[] {
  const count = 8 + Math.floor(rng() * 17);
  const points: PersistencePoint[] = [];

  for (let k = 0; k < count; k += 1) {
    const progress = count > 1 ? k / (count - 1) : 1;
    const noise = (rng() - 0.5) * 0.12;
    let value: number;

    switch (pattern) {
      case "sustained":
        value = 0.78 + noise * 1.5;
        break;
      case "decaying":
        value = 0.9 - 0.75 * progress + noise;
        break;
      case "intermittent":
        value = (k % 3 === 0 ? 0.2 : 0.7) + noise;
        break;
      case "emerging":
        value = 0.1 + 0.8 * progress + noise;
        break;
    }

    points.push({
      timestamp: new Date(lastObservation - (count - 1 - k) * PERSISTENCE_STEP_MS).toISOString(),
      value: round(clampUnit(value), 3),
    });
  }
  return points;
}

function buildEvidence(eventClass: MockClass, rng: Rng): string[] {
  const templates = shuffle(EVIDENCE_TEMPLATES[eventClass], rng);
  const count = Math.min(templates.length, 2 + Math.floor(rng() * 3));
  return templates.slice(0, count).map((template) => template(rng));
}

function nearbyInfrastructure(latitude: number, longitude: number): Infrastructure[] {
  return MOCK_INFRASTRUCTURE.map((item) => ({
    item,
    distance: haversineKm(latitude, longitude, item.latitude, item.longitude),
  }))
    .filter(({ distance }) => distance <= NEARBY_INFRASTRUCTURE_KM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 2)
    .map(({ item, distance }) => ({ ...item, distanceKm: round(distance, 1) }));
}

function buildMockEvents(): Event[] {
  const rng = createRng(MOCK_SEED);

  const classPlan: MockClass[] = [];
  for (const eventClass of MOCK_CLASSES) {
    for (let i = 0; i < CLASS_COUNTS[eventClass]; i += 1) classPlan.push(eventClass);
  }

  const events = shuffle(classPlan, rng).map((eventClass, index): Event => {
    const siteTypes = CLASS_SITE_TYPES[eventClass];
    const candidates = MOCK_INFRASTRUCTURE.filter((site) => siteTypes.includes(site.type));

    let latitude: number;
    let longitude: number;
    if (candidates.length > 0) {
      const site = candidates[Math.floor(rng() * candidates.length)];
      latitude = site.latitude + (rng() - 0.5) * 0.06;
      longitude = site.longitude + (rng() - 0.5) * 0.06;
    } else {
      latitude = 19.5 + rng() * 4;
      longitude = 82.5 + rng() * 5.5;
    }
    latitude = round(latitude, 5);
    longitude = round(longitude, 5);

    const [minConfidence, maxConfidence] = CLASS_CONFIDENCE_RANGE[eventClass];
    const requestedConfidence = minConfidence + rng() * (maxConfidence - minConfidence);
    const probabilities = buildProbabilities(eventClass, requestedConfidence, rng);
    const confidence = probabilities[eventClass];

    const pattern = pickPattern(rng);
    const lastObservation = MOCK_REFERENCE_TIME - Math.floor(rng() * 240) * HOUR_MS;
    const persistence = buildPersistence(pattern, lastObservation, rng);

    const event: Event = {
      id: `evt-${String(index + 1).padStart(4, "0")}`,
      latitude,
      longitude,
      timestamp: new Date(lastObservation).toISOString(),
      class: eventClass,
      confidence,
      status: statusForPattern(pattern, confidence, rng),
      probabilities,
      evidence: buildEvidence(eventClass, rng),
      persistence,
    };

    const infrastructure = nearbyInfrastructure(latitude, longitude);
    if (infrastructure.length > 0) event.infrastructure = infrastructure;
    return event;
  });

  return events.sort((a, b) => Date.parse(b.timestamp ?? "") - Date.parse(a.timestamp ?? ""));
}

let mockEventsCache: Event[] | null = null;

function getMockEvents(): Event[] {
  if (!mockEventsCache) mockEventsCache = buildMockEvents();
  return mockEventsCache;
}

/* ==========================================================================
   Public API
   ========================================================================== */

export async function getEvents(filters?: Partial<Filters>): Promise<Event[]> {
  if (USE_MOCK_DATA) {
    return applyFilters(getMockEvents(), filters);
  }
  const payload = await requestJson(ENDPOINTS.events, buildEventQuery(filters));
  return applyFilters(normalizeEventList(payload), filters);
}

export async function getEvent(id: string): Promise<Event> {
  if (USE_MOCK_DATA) {
    const event = getMockEvents().find((candidate) => candidate.id === id);
    if (!event) throw new ApiError("not_found", "The requested event was not found.", 404);
    return event;
  }
  const payload = await requestJson(ENDPOINTS.event(id));
  return normalizeSingleEvent(payload);
}

export async function getStats(): Promise<Stats> {
  if (USE_MOCK_DATA) {
    return computeStats(getMockEvents());
  }
  const payload = await requestJson(ENDPOINTS.stats);
  return normalizeStats(payload);
}

export async function getInfrastructure(): Promise<Infrastructure[]> {
  if (USE_MOCK_DATA) {
    return [...MOCK_INFRASTRUCTURE];
  }
  const payload = await requestJson(ENDPOINTS.infrastructure);
  return compact(
    unwrapCollection(payload, INFRASTRUCTURE_COLLECTION_KEYS).map(normalizeInfrastructureItem)
  );
}
