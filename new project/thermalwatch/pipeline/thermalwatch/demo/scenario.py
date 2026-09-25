"""Synthetic but realistic demo scenario for offline development and judging demos.

EVERYTHING HERE IS SYNTHETIC. Facility locations are approximate and only chosen so the
story is recognisable (refinery belt, steel belt, Jharia coalfield, Punjab paddy belt,
Uttarakhand forests). Replace with real FIRMS + OSM/GEM data for any real claim.

Each generated detection carries a known "truth" label so the evaluation workflow
can be demonstrated end-to-end. Those labels are stored with label_source='synthetic_truth'.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
from shapely.geometry import Point, box

from thermalwatch import config as C
from thermalwatch.features.persistence import cell_of

SOURCE = "DEMO_SYNTHETIC"


def _rect(lat, lon, half_km):
    d_lat = half_km / 111.0
    d_lon = half_km / (111.0 * np.cos(np.radians(lat)))
    return box(lon - d_lon, lat - d_lat, lon + d_lon, lat + d_lat)


# name, type, operator, lat, lon, half-size km (polygon) or None (point)
FACILITIES = [
    ("Jamnagar refinery complex (demo, approx.)", "refinery", "Demo operator", 22.355, 69.870, 2.5),
    ("Bhilai steel plant (demo, approx.)", "steel", "Demo operator", 21.195, 81.395, 2.0),
    ("Butibori industrial area (demo)", "industrial_zone", None, 20.935, 79.005, 1.2),
    ("Dahej chemical zone (demo)", "industrial_zone", None, 21.705, 72.585, 1.5),
    ("Jharia coalfield mines (demo, approx.)", "mine", "Demo operator", 23.755, 86.405, 3.0),
    ("Mundka thermal power station (demo)", "power_plant", None, 24.020, 82.600, None),
]
BRICK_KILNS = [(28.66 + 0.02 * i, 77.52 + 0.025 * (i % 3)) for i in range(6)]

LANDCOVER_ZONES = [
    (_rect(22.355, 69.870, 4), {"built_up": 0.45, "bare_sparse": 0.3, "shrubland": 0.15, "water": 0.1}),
    (_rect(21.195, 81.395, 4), {"built_up": 0.6, "bare_sparse": 0.15, "cropland": 0.15, "tree_cover": 0.1}),
    (_rect(20.935, 79.005, 3), {"built_up": 0.5, "bare_sparse": 0.2, "cropland": 0.3}),
    (_rect(21.705, 72.585, 3), {"built_up": 0.45, "bare_sparse": 0.25, "cropland": 0.2, "water": 0.1}),
    (_rect(23.755, 86.405, 5), {"bare_sparse": 0.45, "built_up": 0.25, "shrubland": 0.15, "cropland": 0.15}),
    (_rect(24.020, 82.600, 3), {"built_up": 0.4, "bare_sparse": 0.3, "tree_cover": 0.3}),
    (_rect(21.300, 81.700, 2), {"built_up": 0.4, "bare_sparse": 0.25, "cropland": 0.35}),
    (_rect(28.620, 77.330, 1.5), {"built_up": 0.75, "bare_sparse": 0.2, "grassland": 0.05}),
    (_rect(28.710, 77.545, 6), {"cropland": 0.55, "bare_sparse": 0.2, "built_up": 0.25}),
    (box(75.2, 29.9, 76.5, 30.7), {"cropland": 0.88, "built_up": 0.07, "grassland": 0.05}),
    (box(78.8, 29.4, 79.9, 30.3), {"tree_cover": 0.72, "shrubland": 0.15, "grassland": 0.08, "cropland": 0.05}),
    (box(76.0, 14.0, 78.5, 16.0), {"shrubland": 0.45, "grassland": 0.3, "cropland": 0.2, "bare_sparse": 0.05}),
]


def infrastructure() -> pd.DataFrame:
    rows = []
    for i, (name, t, op, lat, lon, half) in enumerate(FACILITIES):
        geom = _rect(lat, lon, half) if half else Point(lon, lat)
        rows.append(dict(name=name, infra_type=t, operator=op, status="operating", capacity=None,
                         source=SOURCE, source_ref=f"fac{i}", geometry=geom))
    for i, (lat, lon) in enumerate(BRICK_KILNS):
        rows.append(dict(name=f"Brick kiln {i + 1} (demo)", infra_type="brick_kiln", operator=None,
                         status="operating", capacity=None, source=SOURCE, source_ref=f"kiln{i}",
                         geometry=Point(lon, lat)))
    return pd.DataFrame(rows)


class _Gen:
    def __init__(self, end: date, seed: int = 26162):
        self.rng = np.random.default_rng(seed)
        self.end = end
        self.start = end - timedelta(days=420)
        self.rows = []

    def days(self):
        d = self.start
        while d <= self.end:
            yield d
            d += timedelta(days=1)

    def add(self, d: date, lat, lon, frp, truth, night=None, jitter_m=180, hot=False):
        r = self.rng
        night = bool(r.random() < 0.5) if night is None else night
        dlat = r.normal(0, jitter_m / 111_000)
        dlon = r.normal(0, jitter_m / (111_000 * np.cos(np.radians(lat))))
        # VIIRS overpasses over India: ~13:30 IST (08:00 UTC) and ~01:30 IST (20:00 UTC prev day)
        if night:
            t = datetime(d.year, d.month, d.day, 20, int(r.integers(0, 50)), tzinfo=timezone.utc) - timedelta(days=1)
        else:
            t = datetime(d.year, d.month, d.day, 7, int(r.integers(30, 59)), tzinfo=timezone.utc)
        mir = float(np.clip((345 if hot else 330) + 4 * np.log1p(frp) + r.normal(0, 5) - (12 if night else 0), 300, 367))
        tir = float(np.clip(292 + 2.2 * np.log1p(frp) + r.normal(0, 3) - (8 if night else 0), 270, 330))
        self.rows.append(dict(
            source=SOURCE, instrument="VIIRS", satellite=str(r.choice(["N20", "N", "N21"])),
            acq_time=t, lat=round(lat + dlat, 5), lon=round(lon + dlon, 5),
            bright_mir=round(mir, 2), bright_tir=round(tir, 2), frp=round(float(frp), 2),
            scan=round(float(r.uniform(0.39, 0.7)), 2), track=round(float(r.uniform(0.36, 0.7)), 2),
            confidence=str(r.choice(["n", "n", "h"])), daynight="N" if night else "D", truth=truth))


def generate(end: date | None = None, seed: int = 26162) -> pd.DataFrame:
    end = end or datetime.now(timezone.utc).date()
    g = _Gen(end, seed)
    r = g.rng
    PI, IF, AG, WF, OT = C.PERSISTENT_INDUSTRIAL, C.INDUSTRIAL_FIRE, C.AGRICULTURAL, C.WILDFIRE, C.OTHER

    # 1) Refinery flares: several stacks, hot most days
    stacks = [(22.350, 69.862), (22.361, 69.879), (22.346, 69.884)]
    for d in g.days():
        for lat, lon in stacks:
            if r.random() < 0.45:
                g.add(d, lat, lon, r.lognormal(np.log(6), 0.5), PI, hot=True)

    # 2) Steel plant: blast furnaces / coke ovens
    for d in g.days():
        for lat, lon in [(21.192, 81.389), (21.200, 81.402)]:
            if r.random() < 0.35:
                g.add(d, lat, lon, r.lognormal(np.log(9), 0.45), PI)

    # 3) Butibori: low persistent heat, then an industrial fire 3 days before `end`
    fire_days = {end - timedelta(days=3), end - timedelta(days=2)}
    for d in g.days():
        if d in fire_days:
            for _ in range(int(r.integers(3, 5))):
                g.add(d, 20.936, 79.006, r.uniform(38, 70), IF, jitter_m=250, hot=True)
        elif r.random() < 0.3:
            g.add(d, 20.936, 79.006, r.lognormal(np.log(2.5), 0.4), PI)

    # 4) Dahej: fire at a facility with no heat history, 1 day before `end`
    for _ in range(3):
        g.add(end - timedelta(days=1), 21.707, 72.588, r.uniform(18, 35), IF, night=False, jitter_m=300)

    # 5) Jharia: many small persistent coal-seam fires across the field
    seams = [(23.745 + r.uniform(-0.02, 0.02), 86.40 + r.uniform(-0.025, 0.025)) for _ in range(8)]
    for d in g.days():
        for lat, lon in seams:
            if r.random() < 0.12:
                g.add(d, lat, lon, r.lognormal(np.log(3), 0.5), PI, jitter_m=220)

    # 6) Power plant (point feature)
    for d in g.days():
        if r.random() < 0.25:
            g.add(d, 24.021, 82.601, r.lognormal(np.log(4), 0.5), PI)

    # 7) Brick kilns: seasonal Dec-Jun
    for d in g.days():
        if d.month in (12, 1, 2, 3, 4, 5, 6):
            for lat, lon in BRICK_KILNS:
                if r.random() < 0.18:
                    g.add(d, lat, lon, r.lognormal(np.log(2), 0.4), PI, jitter_m=150)

    # 8) Unmapped persistent industrial site (no infrastructure record)
    for d in g.days():
        if r.random() < 0.3:
            g.add(d, 21.301, 81.702, r.lognormal(np.log(5), 0.5), PI)

    # 9) Landfill fires: recurring, urban, not industrial infrastructure
    for d in g.days():
        if d.month in (3, 4, 5, 10, 11) and r.random() < 0.12:
            g.add(d, 28.622, 77.328, r.lognormal(np.log(4), 0.6), OT, jitter_m=200)

    # 10) Punjab stubble burning: many scattered fields, peak Oct-Nov, smaller Apr-May
    for d in g.days():
        rate = {10: 25, 11: 45, 4: 10, 5: 8, 9: 1.5, 12: 1}.get(d.month, 0)
        for _ in range(r.poisson(rate)):
            lat, lon = r.uniform(29.95, 30.65), r.uniform(75.25, 76.45)
            g.add(d, lat, lon, r.lognormal(np.log(5), 0.7), AG, night=False, jitter_m=100)

    # 11) Uttarakhand forest fires: Apr-Jun, clustered fire fronts over a few days
    for d in g.days():
        if d.month in (4, 5, 6) and r.random() < 0.25:
            clat, clon = r.uniform(29.45, 30.25), r.uniform(78.85, 79.85)
            for k in range(int(r.integers(2, 8))):
                g.add(d + timedelta(days=int(k // 3)), clat + r.normal(0, 0.01), clon + r.normal(0, 0.01),
                      r.lognormal(np.log(8), 0.8), WF, night=False)

    # 12) Deccan scrub/grass fires: Feb-May, isolated
    for d in g.days():
        if d.month in (2, 3, 4, 5):
            for _ in range(r.poisson(1.2)):
                g.add(d, r.uniform(14.1, 15.9), r.uniform(76.1, 78.4), r.lognormal(np.log(4), 0.6), WF, night=False)

    df = pd.DataFrame(g.rows)
    df = df[pd.to_datetime(df["acq_time"]).dt.date <= end]
    cx, cy = cell_of(df["lat"].to_numpy(), df["lon"].to_numpy())
    df["cell_x"], df["cell_y"] = cx, cy
    return df.drop_duplicates(subset=["source", "acq_time", "lat", "lon"]).reset_index(drop=True)
