import { create } from "zustand";
import type { Filters, Viewport } from "./types";

/**
 * UI state only. Server data (events, stats, infrastructure) belongs in
 * React Query and must never be copied into this store.
 */

export const DEFAULT_FILTERS: Filters = {
  classes: [],
  minConfidence: 0,
  statuses: [],
  persistence: "all",
  startDate: undefined,
  endDate: undefined,
  search: "",
};

export const DEFAULT_VIEWPORT: Viewport = {
  latitude: 21.0,
  longitude: 85.5,
  zoom: 6,
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 19;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeViewport(current: Viewport, patch: Partial<Viewport>): Viewport {
  const next = { ...current };
  if (patch.latitude !== undefined && Number.isFinite(patch.latitude)) {
    next.latitude = clamp(patch.latitude, -90, 90);
  }
  if (patch.longitude !== undefined && Number.isFinite(patch.longitude)) {
    next.longitude = clamp(patch.longitude, -180, 180);
  }
  if (patch.zoom !== undefined && Number.isFinite(patch.zoom)) {
    next.zoom = clamp(patch.zoom, MIN_ZOOM, MAX_ZOOM);
  }
  return next;
}

export interface UIState {
  selectedEventId: string | null;
  isEventPanelOpen: boolean;
  filters: Filters;
  viewport: Viewport;

  /** Select an event and open the investigation panel. */
  selectEvent: (id: string) => void;
  /** Clear the selection and close the investigation panel. */
  clearSelectedEvent: () => void;
  setEventPanelOpen: (open: boolean) => void;
  /** Merge a partial set of filters into the current filters. */
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  /** Merge a partial viewport into the current viewport. */
  setViewport: (patch: Partial<Viewport>) => void;
}

export const useUIStore = create<UIState>()((set) => ({
  selectedEventId: null,
  isEventPanelOpen: false,
  filters: DEFAULT_FILTERS,
  viewport: DEFAULT_VIEWPORT,

  selectEvent: (id) => set({ selectedEventId: id, isEventPanelOpen: true }),

  clearSelectedEvent: () => set({ selectedEventId: null, isEventPanelOpen: false }),

  setEventPanelOpen: (open) => set({ isEventPanelOpen: open }),

  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),

  resetFilters: () => set({ filters: DEFAULT_FILTERS }),

  setViewport: (patch) =>
    set((state) => ({ viewport: sanitizeViewport(state.viewport, patch) })),
}));
