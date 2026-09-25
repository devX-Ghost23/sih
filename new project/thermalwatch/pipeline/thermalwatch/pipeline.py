"""Database-independent pipeline: detections in -> classified events out.

Kept free of SQL so it can be unit-tested and reused from notebooks.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from thermalwatch.classify import rules
from thermalwatch.features.landcover import LC_KEYS
from thermalwatch.features.persistence import persistence_features
from thermalwatch.features.proximity import InfraIndex


def build_features(targets: pd.DataFrame, history: pd.DataFrame, infra_index: InfraIndex,
                   landcover) -> pd.DataFrame:
    """One row per target detection (index = detection id) with every feature used downstream."""
    targets = targets.reset_index(drop=True)
    f = persistence_features(targets, history)

    prox = infra_index.features(targets["lat"], targets["lon"])
    prox.index = targets["id"]
    f = f.join(prox)
    f["nearest_infra_name"] = [
        (infra_index.row(i)["name"] if infra_index.row(i) is not None else None) for i in f["nearest_infra_idx"]
    ]
    f["nearest_infra_id"] = [
        (int(infra_index.row(i)["id"]) if infra_index.row(i) is not None and "id" in infra_index.infra else None)
        for i in f["nearest_infra_idx"]
    ]

    # land cover, cached per persistence cell (neighbouring detections share context)
    lc_cache, lc_rows = {}, []
    for lat, lon, cx, cy in targets[["lat", "lon", "cell_x", "cell_y"]].itertuples(index=False):
        key = (cx, cy)
        if key not in lc_cache:
            lc_cache[key] = landcover.fractions(lat, lon)
        lc_rows.append(lc_cache[key])
    lc = pd.DataFrame(lc_rows, index=targets["id"])
    lc = lc.rename(columns={k: f"lc_{k}" for k in LC_KEYS} | {"majority": "lc_majority"})
    f = f.join(lc)

    t = targets.set_index("id")
    acq = pd.to_datetime(t["acq_time"], utc=True)
    f["frp"] = t["frp"].astype(float)
    f["bright_mir"] = t["bright_mir"].astype(float)
    f["bright_tir"] = t["bright_tir"].astype(float)
    f["daynight"] = t["daynight"]
    f["month"] = acq.dt.month
    f["instrument"] = t["instrument"]
    return f


def classify_frame(features: pd.DataFrame, model=None) -> pd.DataFrame:
    """Classify each feature row. Uses the trained model if given, otherwise rules."""
    records = []
    for det_id, row in features.iterrows():
        fd = row.to_dict()
        fd["nearest_infra_dist_m"] = None if pd.isna(fd.get("nearest_infra_dist_m")) else float(fd["nearest_infra_dist_m"])
        res = rules.score(fd)
        records.append({"detection_id": det_id, **res})
    out = pd.DataFrame(records).set_index("detection_id")
    if model is not None:
        out = model.override(features, out)
    return out


def json_safe(v):
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return None if np.isnan(v) else round(float(v), 4)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if v is pd.NA or (isinstance(v, float) and np.isnan(v)):
        return None
    return v
