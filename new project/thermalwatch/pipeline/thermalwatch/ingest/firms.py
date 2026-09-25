"""NASA FIRMS ingestion.

Get a free MAP_KEY at https://firms.modaps.eosdis.nasa.gov/api/map_key/
Area API: /api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}[/{YYYY-MM-DD}]
"""
from __future__ import annotations

import io
from datetime import date, timedelta

import pandas as pd
import requests

from thermalwatch.config import FIRMS_MAP_KEY, INDIA_BBOX
from thermalwatch.features.persistence import cell_of

FIRMS_AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/{bbox}/{days}"

NRT_SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "VIIRS_SNPP_NRT", "MODIS_NRT"]
# Standard-processing (archive) sources for historical backfill
ARCHIVE_SOURCES = ["VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "MODIS_SP"]

MAX_DAYS_PER_CALL = 5  # keep calls small; FIRMS limits the day range per request

DETECTION_COLUMNS = ["source", "instrument", "satellite", "acq_time", "lat", "lon",
                     "bright_mir", "bright_tir", "frp", "scan", "track",
                     "confidence", "daynight", "cell_x", "cell_y"]


def fetch_csv(source: str, bbox=INDIA_BBOX, days: int = 1, start: date | None = None,
              map_key: str = FIRMS_MAP_KEY, timeout: int = 120) -> str:
    if not map_key:
        raise RuntimeError("FIRMS_MAP_KEY is not set. Get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/")
    url = FIRMS_AREA_URL.format(key=map_key, source=source,
                                bbox=",".join(str(v) for v in bbox), days=days)
    if start:
        url += f"/{start.isoformat()}"
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    text = resp.text
    if text.lstrip().lower().startswith(("invalid", "error")):
        raise RuntimeError(f"FIRMS error for {source}: {text[:200]}")
    return text


def parse_firms_csv(text: str, source: str) -> pd.DataFrame:
    """Normalise VIIRS and MODIS CSVs into the detections schema."""
    if not text.strip():
        return pd.DataFrame(columns=DETECTION_COLUMNS)
    raw = pd.read_csv(io.StringIO(text))
    if raw.empty:
        return pd.DataFrame(columns=DETECTION_COLUMNS)

    is_viirs = "bright_ti4" in raw.columns
    out = pd.DataFrame()
    out["lat"] = raw["latitude"].astype(float)
    out["lon"] = raw["longitude"].astype(float)
    out["bright_mir"] = raw["bright_ti4" if is_viirs else "brightness"].astype(float)
    out["bright_tir"] = raw["bright_ti5" if is_viirs else "bright_t31"].astype(float)
    out["frp"] = raw["frp"].astype(float)
    out["scan"] = raw.get("scan")
    out["track"] = raw.get("track")
    out["confidence"] = raw["confidence"].astype(str)
    out["daynight"] = raw.get("daynight", "D")
    out["satellite"] = raw.get("satellite").astype(str) if "satellite" in raw else None
    out["instrument"] = "VIIRS" if is_viirs else "MODIS"
    out["source"] = source
    hhmm = raw["acq_time"].astype(int).astype(str).str.zfill(4)
    out["acq_time"] = pd.to_datetime(raw["acq_date"] + " " + hhmm, format="%Y-%m-%d %H%M", utc=True)
    cx, cy = cell_of(out["lat"].to_numpy(), out["lon"].to_numpy())
    out["cell_x"], out["cell_y"] = cx, cy
    return out[DETECTION_COLUMNS]


def fetch_range(source: str, start: date, end: date, bbox=INDIA_BBOX) -> pd.DataFrame:
    """Fetch [start, end] inclusive in small chunks (for backfilling history)."""
    frames, cur = [], start
    while cur <= end:
        days = min(MAX_DAYS_PER_CALL, (end - cur).days + 1)
        frames.append(parse_firms_csv(fetch_csv(source, bbox, days, cur), source))
        cur += timedelta(days=days)
    frames = [f for f in frames if not f.empty]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=DETECTION_COLUMNS)
