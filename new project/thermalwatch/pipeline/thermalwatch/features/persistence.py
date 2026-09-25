"""Temporal persistence analysis.

Idea (layman): split the map into ~550 m squares. For every new hot spot, look at
its square plus the 8 around it and ask "on how many days in the past year, and in
how many different months, was this spot hot before today? How hot usually?"

Why a grid instead of DBSCAN clustering: clustering chains dense seasonal fires
(e.g. thousands of Punjab stubble fires in November) into one giant "source"
that looks persistent. A fixed small neighbourhood keeps persistence local, and
cell ids are stable between runs.

Leakage rule: features only use days strictly BEFORE the detection's date.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from thermalwatch import config as C


def cell_of(lat, lon):
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    return np.floor(lon / C.CELL_DEG).astype(int), np.floor(lat / C.CELL_DEG).astype(int)


def persistence_features(targets: pd.DataFrame, history: pd.DataFrame) -> pd.DataFrame:
    """Compute persistence features for `targets`.

    targets: detections to classify; needs id, cell_x, cell_y, acq_time, frp
    history: detections covering >= HISTORY_DAYS before the earliest target
             (targets may or may not be included; they are added if missing)
    Returns a DataFrame indexed by target id.
    """
    cols = ["id", "cell_x", "cell_y", "acq_time", "frp"]
    hist = pd.concat([history[cols], targets[cols]], ignore_index=True).drop_duplicates("id")
    hist["date"] = pd.to_datetime(hist["acq_time"], utc=True).dt.tz_localize(None).dt.normalize()

    daily = (hist.groupby(["cell_x", "cell_y", "date"])
                 .agg(frp_max=("frp", "max"), n=("frp", "size")).reset_index())

    target_cells = targets[["cell_x", "cell_y"]].drop_duplicates().rename(columns={"cell_x": "tx", "cell_y": "ty"})

    # Spread each cell-day to its 3x3 neighbourhood, keep only cells we need
    spread = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            s = daily.assign(tx=daily["cell_x"] + dx, ty=daily["cell_y"] + dy)
            spread.append(s.merge(target_cells, on=["tx", "ty"]))
    nb = (pd.concat(spread, ignore_index=True)
            .groupby(["tx", "ty", "date"])
            .agg(frp_max=("frp_max", "max"), n=("n", "sum")).reset_index()
            .sort_values(["tx", "ty", "date"]))

    nb["log_frp"] = np.log1p(nb["frp_max"].clip(lower=0))
    nb["month_ord"] = (nb["date"].dt.year * 12 + nb["date"].dt.month).astype(float)
    nb["day_ord"] = (nb["date"] - pd.Timestamp("1970-01-01")).dt.days.astype(float)

    # Vectorised rolling window over strictly-prior days, per target cell.
    # Rows are sorted by (cell, date) with one row per active day, so for row i the
    # window is rows [i0, i) where i0 is the first row of the same cell within HISTORY_DAYS.
    nb = nb.reset_index(drop=True)
    grp = nb.groupby(["tx", "ty"], sort=False).ngroup().to_numpy().astype(np.int64)
    day = nb["day_ord"].to_numpy()
    key = grp * 1_000_000 + day.astype(np.int64)
    idx = np.arange(len(nb))
    i0 = np.searchsorted(key, key - C.HISTORY_DAYS, side="left")
    cnt = idx - i0

    lf = nb["log_frp"].to_numpy()
    cs1 = np.concatenate([[0.0], np.cumsum(lf)])
    cs2 = np.concatenate([[0.0], np.cumsum(lf ** 2)])
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = (cs1[idx] - cs1[i0]) / cnt
        var = (cs2[idx] - cs2[i0]) / cnt - mean ** 2
        std = np.sqrt(np.clip(var, 0, None) * cnt / np.maximum(cnt - 1, 1))
    mean[cnt == 0] = np.nan
    std[cnt < 2] = np.nan

    mo = nb["month_ord"].to_numpy()
    chg = np.ones(len(nb), dtype=np.int64)
    chg[1:] = ((mo[1:] != mo[:-1]) | (grp[1:] != grp[:-1])).astype(np.int64)
    pc = np.concatenate([[0], np.cumsum(chg)])
    months = np.where(cnt > 0, 1 + pc[idx] - pc[np.minimum(i0 + 1, idx)], 0)

    same_grp_prev = np.zeros(len(nb), dtype=bool)
    same_grp_prev[1:] = grp[1:] == grp[:-1]
    prev_day = np.where(same_grp_prev, np.concatenate([[np.nan], day[:-1]]), np.nan)

    feats = pd.DataFrame({
        "tx": nb["tx"], "ty": nb["ty"], "date": nb["date"], "day_ord": day,
        "hist_active_days": cnt, "hist_log_frp_mean": mean, "hist_log_frp_std": std,
        "hist_first_day": np.where(cnt > 0, day[np.minimum(i0, len(nb) - 1)], np.nan),
        "hist_active_months": months, "hist_days_since_last": day - prev_day,
        "same_day_neighbourhood_count": nb["n"],
    })

    t = targets[cols].copy()
    t["date"] = pd.to_datetime(t["acq_time"], utc=True).dt.tz_localize(None).dt.normalize()
    out = t.merge(feats, left_on=["cell_x", "cell_y", "date"], right_on=["tx", "ty", "date"], how="left")

    out["hist_active_days"] = out["hist_active_days"].fillna(0).astype(int)
    out["hist_active_months"] = out["hist_active_months"].fillna(0).astype(int)
    first = out["hist_first_day"]
    out["hist_days_since_first"] = np.where(first.notna(), out["day_ord"] - first, 0).astype(int)
    # a previous active day older than the window is not "history"
    dsl = out["hist_days_since_last"]
    out["hist_days_since_last"] = np.where(dsl.notna() & (dsl <= C.HISTORY_DAYS), dsl, C.HISTORY_DAYS + 1).astype(int)

    typical = np.expm1(out["hist_log_frp_mean"])
    out["hist_frp_typical"] = typical.round(2)
    std = out["hist_log_frp_std"].fillna(0).clip(lower=0.3)
    enough = out["hist_active_days"] >= 5
    z = (np.log1p(out["frp"].clip(lower=0)) - out["hist_log_frp_mean"]) / std
    out["frp_z"] = np.where(enough, z, 0.0).round(2)
    out["frp_ratio"] = np.where(enough & (typical > 0), out["frp"] / typical, 1.0).round(2)
    out["is_spike"] = (enough & (out["frp_z"] >= C.SPIKE_Z) & (out["frp_ratio"] >= C.SPIKE_MIN_RATIO)
                     & (out["frp"] >= C.SPIKE_MIN_FRP))
    out["persistence_class"] = [persistence_class(d, m) for d, m in
                                zip(out["hist_active_days"], out["hist_active_months"])]

    keep = ["id", "hist_active_days", "hist_active_months", "hist_days_since_first",
            "hist_days_since_last", "hist_frp_typical", "frp_z", "frp_ratio", "is_spike",
            "same_day_neighbourhood_count", "persistence_class"]
    return out[keep].set_index("id")


def persistence_class(active_days: int, active_months: int) -> str:
    if active_days >= C.PERSISTENT_MIN_ACTIVE_DAYS and active_months >= C.PERSISTENT_MIN_ACTIVE_MONTHS:
        return "persistent"
    if active_days >= C.RECURRING_MIN_ACTIVE_DAYS and active_months >= C.RECURRING_MIN_ACTIVE_MONTHS:
        return "recurring"
    return "temporary"
