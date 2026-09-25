"""Unit tests for the parts that decide the answer. Run: pytest -q (from pipeline/)"""
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest
from shapely.geometry import Point, box

from thermalwatch import config as C
from thermalwatch.classify import rules
from thermalwatch.features.landcover import DemoLandCoverProvider
from thermalwatch.features.persistence import cell_of, persistence_features
from thermalwatch.features.proximity import InfraIndex
from thermalwatch.ingest.firms import parse_firms_csv
from thermalwatch.pipeline import build_features, classify_frame

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def make_detections(rows):
    """rows: list of (day_offset, lat, lon, frp)"""
    df = pd.DataFrame([{"id": i + 1, "acq_time": T0 + timedelta(days=d), "lat": lat, "lon": lon,
                        "frp": frp, "bright_mir": 330.0, "bright_tir": 295.0, "daynight": "D",
                        "instrument": "VIIRS"}
                       for i, (d, lat, lon, frp) in enumerate(rows)])
    cx, cy = cell_of(df["lat"].to_numpy(), df["lon"].to_numpy())
    df["cell_x"], df["cell_y"] = cx, cy
    return df


# --------------------------------------------------------------- persistence
def test_persistence_uses_only_prior_days():
    det = make_detections([(0, 21.0, 79.0, 5.0), (1, 21.0, 79.0, 6.0), (2, 21.0, 79.0, 7.0)])
    f = persistence_features(det, det)
    assert f.loc[1, "hist_active_days"] == 0          # first detection has no history
    assert f.loc[2, "hist_active_days"] == 1
    assert f.loc[3, "hist_active_days"] == 2


def test_neighbourhood_absorbs_geolocation_jitter():
    # two detections ~400 m apart fall in neighbouring cells but share a history
    det = make_detections([(0, 21.0000, 79.0000, 5.0), (1, 21.0036, 79.0036, 5.0)])
    f = persistence_features(det, det)
    assert f.loc[2, "hist_active_days"] == 1


def test_classes_temporary_recurring_persistent():
    one_off = make_detections([(0, 21.0, 79.0, 5.0)])
    assert persistence_features(one_off, one_off).loc[1, "persistence_class"] == "temporary"

    # seasonal: two burning seasons, 4 months total -> recurring, never persistent
    rows = [(d, 30.0, 75.0, 5.0) for d in list(range(0, 60, 2)) + list(range(180, 240, 2))]
    rows.append((250, 30.0, 75.0, 5.0))
    seasonal = make_detections(rows)
    assert persistence_features(seasonal, seasonal).iloc[-1]["persistence_class"] == "recurring"

    # continuous: hot every third day all year -> persistent
    rows = [(d, 22.0, 70.0, 5.0) for d in range(0, 360, 3)]
    rows.append((361, 22.0, 70.0, 5.0))
    steady = make_detections(rows)
    assert persistence_features(steady, steady).iloc[-1]["persistence_class"] == "persistent"


def test_spike_detection_needs_history_and_absolute_floor():
    base = [(d, 22.0, 70.0, 3.0) for d in range(0, 300, 3)]
    small = make_detections(base + [(301, 22.0, 70.0, 12.0)])
    assert not persistence_features(small, small).iloc[-1]["is_spike"]      # 12 MW < floor
    big = make_detections(base + [(301, 22.0, 70.0, 45.0)])
    row = persistence_features(big, big).iloc[-1]
    assert row["is_spike"] and row["frp_ratio"] > 3


def test_matches_brute_force_counts():
    rng = np.random.default_rng(0)
    rows = [(int(rng.integers(0, 400)), 21 + rng.normal(0, 0.01), 79 + rng.normal(0, 0.01), float(rng.uniform(1, 20)))
            for _ in range(300)]
    det = make_detections(rows)
    f = persistence_features(det, det)
    d = det.copy()
    d["date"] = pd.to_datetime(d["acq_time"]).dt.tz_localize(None).dt.normalize()
    for i in d["id"].sample(20, random_state=1):
        r = d[d["id"] == i].iloc[0]
        m = d[(abs(d.cell_x - r.cell_x) <= 1) & (abs(d.cell_y - r.cell_y) <= 1)
              & (d.date < r.date) & (d.date >= r.date - pd.Timedelta(days=C.HISTORY_DAYS))]
        assert f.loc[i, "hist_active_days"] == m["date"].nunique()
        assert f.loc[i, "hist_active_months"] == m["date"].dt.to_period("M").nunique()


# ---------------------------------------------------------------- proximity
def test_point_inside_polygon_is_zero_distance():
    infra = pd.DataFrame([{"id": 1, "name": "Works", "infra_type": "industrial_zone", "operator": None,
                           "source": "TEST", "geometry": box(78.99, 20.99, 79.01, 21.01)},
                          {"id": 2, "name": "Kiln", "infra_type": "brick_kiln", "operator": None,
                           "source": "TEST", "geometry": Point(79.5, 21.5)}])
    idx = InfraIndex(infra)
    out = idx.features([21.0, 21.4999], [79.0, 79.5])
    assert out.loc[0, "nearest_infra_dist_m"] == 0
    assert out.loc[0, "nearest_infra_type"] == "industrial_zone"
    assert 0 < out.loc[1, "nearest_infra_dist_m"] < 200


def test_no_infrastructure_gives_no_match():
    out = InfraIndex(pd.DataFrame(columns=["id", "name", "infra_type", "operator", "source", "geometry"])) \
        .features([21.0], [79.0])
    assert pd.isna(out.loc[0, "nearest_infra_dist_m"])


# -------------------------------------------------------------------- rules
def base_features(**kw):
    f = {"persistence_class": "temporary", "hist_active_days": 0, "hist_active_months": 0,
         "hist_frp_typical": 0.0, "frp_z": 0.0, "frp_ratio": 1.0, "is_spike": False,
         "frp": 5.0, "month": 6, "daynight": "D", "nearest_infra_dist_m": float("nan"),
         "nearest_infra_type": None, "nearest_infra_name": None,
         "lc_cropland": 0.0, "lc_tree_cover": 0.0, "lc_shrubland": 0.0, "lc_grassland": 0.0,
         "lc_built_up": 0.0, "lc_bare_sparse": 0.0, "lc_majority": "cropland"}
    return f | kw


def test_persistent_heat_at_a_refinery_is_industrial():
    r = rules.score(base_features(persistence_class="persistent", hist_active_days=140, hist_active_months=12,
                                  nearest_infra_dist_m=0.0, nearest_infra_type="refinery",
                                  nearest_infra_name="Test refinery", lc_built_up=0.6, lc_majority="built_up"))
    assert r["predicted_class"] == C.PERSISTENT_INDUSTRIAL
    assert any("refinery" in e for e in r["evidence"])


def test_spike_at_known_plant_is_an_industrial_fire_and_always_verified():
    r = rules.score(base_features(persistence_class="persistent", hist_active_days=120, hist_active_months=12,
                                  hist_frp_typical=3.0, frp=45.0, frp_z=8.0, frp_ratio=15.0, is_spike=True,
                                  nearest_infra_dist_m=0.0, nearest_infra_type="steel",
                                  nearest_infra_name="Test steel plant", lc_built_up=0.7, lc_majority="built_up"))
    assert r["predicted_class"] == C.INDUSTRIAL_FIRE
    assert r["needs_verification"] is True


def test_november_cropland_fire_is_agricultural():
    r = rules.score(base_features(month=11, lc_cropland=0.9, lc_majority="cropland"))
    assert r["predicted_class"] == C.AGRICULTURAL


def test_forest_fire_is_natural():
    r = rules.score(base_features(month=5, lc_tree_cover=0.8, lc_majority="tree_cover"))
    assert r["predicted_class"] == C.WILDFIRE


def test_urban_heat_with_no_industry_is_not_called_industrial():
    r = rules.score(base_features(persistence_class="recurring", hist_active_days=12, hist_active_months=4,
                                  lc_built_up=0.8, lc_majority="built_up"))
    assert r["predicted_class"] in (C.OTHER, C.AGRICULTURAL)
    assert r["predicted_class"] != C.PERSISTENT_INDUSTRIAL


def test_scores_sum_to_one_and_low_evidence_is_flagged():
    r = rules.score(base_features())
    assert abs(sum(r["class_scores"].values()) - 1) < 0.01  # rounded to 3 dp
    assert r["needs_verification"] is True


# -------------------------------------------------------------------- FIRMS
VIIRS_CSV = """country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
IND,21.19458,81.39152,338.2,0.42,0.38,2026-09-15,2014,N,VIIRS,n,2.0NRT,295.1,12.4,N
IND,30.21,75.44,352.7,0.51,0.45,2026-09-15,801,N20,VIIRS,h,2.0NRT,310.2,8.1,D
"""

MODIS_CSV = """latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight
21.2,81.4,325.6,1.1,1.0,2026-09-15,805,Terra,MODIS,74,6.1NRT,290.4,15.2,D
"""


def test_parse_viirs_and_modis_into_one_schema():
    v = parse_firms_csv(VIIRS_CSV, "VIIRS_NOAA20_NRT")
    assert len(v) == 2 and v.loc[0, "bright_mir"] == 338.2 and v.loc[0, "daynight"] == "N"
    assert v.loc[0, "acq_time"] == pd.Timestamp("2026-09-15 20:14", tz="UTC")
    m = parse_firms_csv(MODIS_CSV, "MODIS_NRT")
    assert m.loc[0, "instrument"] == "MODIS" and m.loc[0, "bright_tir"] == 290.4
    assert list(v.columns) == list(m.columns)


def test_parse_empty_response():
    assert parse_firms_csv("", "VIIRS_NOAA20_NRT").empty


# ------------------------------------------------------------- end-to-end
def test_end_to_end_on_the_demo_scenario():
    from thermalwatch.demo import scenario
    det = scenario.generate(end=date(2026, 9, 16), seed=3)
    det["id"] = range(1, len(det) + 1)
    infra = scenario.infrastructure()
    infra["id"] = range(1, len(infra) + 1)
    feats = build_features(det, det, InfraIndex(infra), DemoLandCoverProvider(scenario.LANDCOVER_ZONES))
    out = classify_frame(feats)
    # only judge detections after the history warm-up period
    warm = det[pd.to_datetime(det["acq_time"]) >= pd.Timestamp("2026-03-01", tz="UTC")]["id"]
    acc = (out.loc[warm, "predicted_class"].to_numpy() == det.set_index("id").loc[warm, "truth"].to_numpy()).mean()
    assert acc > 0.9   # synthetic data, so this checks wiring, not real-world accuracy
    assert out.loc[warm, "needs_verification"].any()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
