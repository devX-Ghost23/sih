"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PersistencePoint } from "@/lib/types";

/* ==========================================================================
   Shared chart theme
   Pulled from CSS variables so charts stay in step with globals.css.
   ========================================================================== */

const CHART_COLORS = {
  grid: "#1a2432",
  axis: "#6b788a",
  accent: "#4a8bd4",
  accentMuted: "#1d3350",
  tooltipBg: "#182130",
  tooltipBorder: "#33435a",
  text: "#e6ebf2",
};

const TOOLTIP_STYLE = {
  contentStyle: {
    background: CHART_COLORS.tooltipBg,
    border: `1px solid ${CHART_COLORS.tooltipBorder}`,
    borderRadius: 4,
    fontSize: 12,
    padding: "6px 9px",
    boxShadow: "0 4px 12px -2px rgba(0,0,0,0.35)",
  },
  labelStyle: { color: CHART_COLORS.text, fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: CHART_COLORS.text, padding: 0 },
} as const;

const AXIS_TICK = { fill: CHART_COLORS.axis, fontSize: 11 };

function formatLabel(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced === "" ? "Unknown" : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* ==========================================================================
   Empty states
   ========================================================================== */

function ChartEmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[6rem] items-center justify-center px-4 text-center text-xs text-foreground-muted">
      {message}
    </div>
  );
}

/* ==========================================================================
   ProbabilityChart
   Renders a Record<string, number> of class probabilities as horizontal
   bars. Values may arrive as 0-1 fractions or 0-100 percentages; both are
   normalized to a 0-100 percentage before the axis and labels are drawn.
   ========================================================================== */

interface ProbabilityDatum {
  key: string;
  label: string;
  percent: number;
}

function normalizeProbabilityData(
  probabilities: Record<string, number> | undefined
): ProbabilityDatum[] {
  if (!probabilities) return [];

  const entries = Object.entries(probabilities).filter(
    ([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  if (entries.length === 0) return [];

  const largest = Math.max(...entries.map(([, value]) => value));
  const scale = largest > 1 ? 1 : 100; // values already look like 0-100 vs 0-1

  return entries
    .map(([key, value]) => ({
      key,
      label: formatLabel(key),
      percent: Math.round(Math.min(100, value * scale) * 10) / 10,
    }))
    .sort((a, b) => b.percent - a.percent);
}

export function ProbabilityChart({
  probabilities,
  highlightKey,
}: {
  probabilities: Record<string, number> | undefined;
  highlightKey?: string;
}) {
  const data = useMemo(() => normalizeProbabilityData(probabilities), [probabilities]);

  if (data.length === 0) {
    return <ChartEmptyState message="Classification probabilities unavailable." />;
  }

  const rowHeight = 26;
  const chartHeight = Math.max(64, data.length * rowHeight);

  return (
    <div style={{ width: "100%", height: chartHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 28, bottom: 0, left: 0 }}
          barCategoryGap={6}
        >
          <CartesianGrid horizontal={false} stroke={CHART_COLORS.grid} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tick={AXIS_TICK}
            tickFormatter={(value: number) => `${value}%`}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={108}
            tick={AXIS_TICK}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: CHART_COLORS.accentMuted, opacity: 0.4 }}
            formatter={(value: number) => [`${value}%`, "Probability"]}
            {...TOOLTIP_STYLE}
          />
          <Bar dataKey="percent" radius={[0, 2, 2, 0]} maxBarSize={14}>
            {data.map((entry) => (
              <Cell
                key={entry.key}
                fill={CHART_COLORS.accent}
                fillOpacity={entry.key === highlightKey || !highlightKey ? 1 : 0.45}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ==========================================================================
   PersistenceChart
   Plots Event.persistence (timestamp + value) as an area chart over time.
   ========================================================================== */

interface PersistenceDatum {
  timeMs: number;
  timeLabel: string;
  fullLabel: string;
  value: number;
}

const SHORT_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

const FULL_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function normalizePersistenceData(
  points: readonly PersistencePoint[] | undefined
): PersistenceDatum[] {
  if (!points || points.length === 0) return [];

  return points
    .map((point) => {
      const timeMs = Date.parse(point.timestamp);
      if (Number.isNaN(timeMs) || !Number.isFinite(point.value)) return null;
      return {
        timeMs,
        timeLabel: SHORT_TIME.format(new Date(timeMs)),
        fullLabel: `${FULL_TIME.format(new Date(timeMs))} UTC`,
        value: Math.round(Math.min(1, Math.max(0, point.value)) * 1000) / 1000,
      };
    })
    .filter((point): point is PersistenceDatum => point !== null)
    .sort((a, b) => a.timeMs - b.timeMs);
}

export function PersistenceChart({
  persistence,
}: {
  persistence: readonly PersistencePoint[] | undefined;
}) {
  const data = useMemo(() => normalizePersistenceData(persistence), [persistence]);

  if (data.length === 0) {
    return <ChartEmptyState message="Historical persistence unavailable." />;
  }

  // A single point cannot form a line; show it as a labelled value instead.
  if (data.length === 1) {
    return (
      <div className="flex h-16 flex-col items-center justify-center gap-0.5 text-center">
        <span className="tabular text-sm font-semibold text-foreground">
          {Math.round(data[0].value * 100)}%
        </span>
        <span className="text-xs text-foreground-muted">Single observation, {data[0].fullLabel}</span>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: 128 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="persistenceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={CHART_COLORS.accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={CHART_COLORS.grid} vertical={false} />
          <XAxis
            dataKey="timeLabel"
            tick={AXIS_TICK}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={[0, 1]}
            tick={AXIS_TICK}
            tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickLine={false}
            width={34}
          />
          <Tooltip
            labelFormatter={(_label: string, payload: Array<{ payload?: PersistenceDatum }>) =>
              payload?.[0]?.payload ? payload[0].payload.fullLabel : ""
            }
            formatter={(value: number) => [`${Math.round(value * 100)}%`, "Persistence"]}
            {...TOOLTIP_STYLE}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={CHART_COLORS.accent}
            strokeWidth={1.75}
            fill="url(#persistenceFill)"
            dot={false}
            activeDot={{ r: 3, fill: CHART_COLORS.accent, stroke: CHART_COLORS.tooltipBg, strokeWidth: 1.5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
