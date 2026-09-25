"""ThermalWatch pipeline CLI.

    python -m thermalwatch.cli init-db
    python -m thermalwatch.cli demo                       # synthetic scenario, fully offline
    python -m thermalwatch.cli ingest-firms --days 2      # needs FIRMS_MAP_KEY
    python -m thermalwatch.cli backfill-firms --source VIIRS_SNPP_SP --start 2025-09-01 --end 2026-09-01
    python -m thermalwatch.cli load-osm --bbox 69,21,73,24
    python -m thermalwatch.cli load-wri path/to/global_power_plant_database.csv
    python -m thermalwatch.cli load-gem path/to/steel_tracker.xlsx --type steel
    python -m thermalwatch.cli classify [--landcover worldcover|demo|none] [--reclassify]
    python -m thermalwatch.cli train
    python -m thermalwatch.cli evaluate
"""
from __future__ import annotations

import argparse
import json
from datetime import date, timedelta

import pandas as pd

from thermalwatch import config as C
from thermalwatch import db


def _landcover(kind: str):
    from thermalwatch.features import landcover as lc
    if kind == "demo":
        from thermalwatch.demo import scenario
        return lc.DemoLandCoverProvider(scenario.LANDCOVER_ZONES)
    if kind == "worldcover":
        try:
            return lc.WorldCoverProvider()
        except ImportError:
            print("rasterio is not installed, so land cover is unavailable and affected events will be\n"
                  "flagged for verification. Install it with: pip install 'thermalwatch[raster]'")
    return lc.NullLandCoverProvider()


def cmd_init_db(_):
    db.init_db()
    print("schema applied")


def cmd_ingest_firms(a):
    from thermalwatch.ingest import firms
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else C.INDIA_BBOX
    for src in (a.source or firms.NRT_SOURCES):
        df = firms.parse_firms_csv(firms.fetch_csv(src, bbox, a.days), src)
        print(f"{src}: fetched {len(df)}, inserted {db.insert_detections(df)}")


def cmd_backfill_firms(a):
    from thermalwatch.ingest import firms
    bbox = tuple(float(v) for v in a.bbox.split(",")) if a.bbox else C.INDIA_BBOX
    df = firms.fetch_range(a.source, date.fromisoformat(a.start), date.fromisoformat(a.end), bbox)
    print(f"{a.source}: fetched {len(df)}, inserted {db.insert_detections(df)}")


def cmd_load_osm(a):
    from thermalwatch.ingest import reference
    df = reference.load_osm(tuple(float(v) for v in a.bbox.split(",")))
    print(df["infra_type"].value_counts().to_string() if len(df) else "no features")
    print(f"upserted {db.upsert_infrastructure(df)}")


def cmd_load_wri(a):
    from thermalwatch.ingest import reference
    print(f"upserted {db.upsert_infrastructure(reference.load_wri_gppd(a.path))}")


def cmd_load_gem(a):
    from thermalwatch.ingest import reference
    print(f"upserted {db.upsert_infrastructure(reference.load_gem(a.path, a.type))}")


def run_classification(landcover_kind: str, reclassify: bool = False, use_model: bool = False, batch: int = 50_000):
    from thermalwatch.classify.model import XGBModel
    from thermalwatch.features.proximity import InfraIndex
    from thermalwatch.pipeline import build_features, classify_frame

    infra = db.load_infrastructure()
    index = InfraIndex(infra)
    lc = _landcover(landcover_kind)
    model = XGBModel.load_if_present() if use_model else None
    if use_model and model is None:
        print("no trained model found; run `train` first. Falling back to rules.")
    print(f"infrastructure: {len(infra)}  model: {'xgboost' if model else 'rules only'}")
    total, offset = 0, 0
    while True:
        targets = db.unclassified_detections(batch, reclassify=reclassify, offset=offset)
        if targets.empty:
            break
        history = db.history_for(targets)
        feats = build_features(targets, history, index, lc)
        rule_out = classify_frame(feats)
        final = model.override(feats, rule_out) if model else rule_out
        total += db.write_events(feats, final, rule_out)
        print(f"classified {total}")
        if reclassify:
            offset += len(targets)
        if len(targets) < batch:
            break
    return total


def cmd_classify(a):
    run_classification(a.landcover, a.reclassify, a.use_model)


def cmd_demo(a):
    from thermalwatch.demo import scenario
    db.init_db()
    end = date.fromisoformat(a.end) if a.end else None
    det = scenario.generate(end=end)
    print(f"synthetic detections: {len(det)}")
    print(f"inserted {db.insert_detections(det, truth_col='truth')}")
    print(f"infrastructure upserted {db.upsert_infrastructure(scenario.infrastructure())}")
    run_classification("demo")
    cmd_evaluate(argparse.Namespace(warmup_days=180))


def _features_frame(df: pd.DataFrame) -> pd.DataFrame:
    rows = [json.loads(f) if isinstance(f, str) else f for f in df["features"]]
    return pd.DataFrame(rows, index=df["detection_id"])


def cmd_train(a):
    try:
        from thermalwatch.classify.model import train
    except ImportError:
        print("xgboost is required for training: pip install 'thermalwatch[model]'")
        return
    ev = db.all_event_features()
    f = _features_frame(ev)
    labelled = db.events_with_labels()
    analyst = labelled[labelled["label_source"] == "analyst"].set_index("detection_id")["label"]
    # Labeling functions (weak supervision):
    #  (a) confident, unambiguous rule outputs
    #  (b) intensity spikes at mapped infrastructure -> industrial fire (always verify these)
    confident = (f["rule_confidence"] >= 0.6) & (~f["rule_needs_verification"].astype(bool))
    spike_fire = (f["rule_class"] == C.INDUSTRIAL_FIRE) & f["is_spike"].astype(bool)
    weak = f[confident | spike_fire]["rule_class"]
    labels = weak.copy()
    if a.use_analyst_labels:
        labels.loc[analyst.index.intersection(f.index)] = analyst
    else:
        labels = labels.drop(analyst.index.intersection(labels.index))  # keep gold set out of training
    ids = labels.index
    latlon = ev.set_index("detection_id").loc[ids]
    print(f"training rows: {len(ids)} (weak labels from confident rule outputs)")
    print(labels.value_counts().to_string())
    meta = train(f.loc[ids], labels, latlon["lat"], latlon["lon"])
    print(json.dumps({k: v for k, v in meta["report"].items() if k in C.CLASSES or k == "macro avg"}, indent=1))
    print("NOTE: this test score measures agreement with the rule labels, not real-world accuracy. "
          "Use `evaluate` against analyst-verified labels for honest metrics.")


def cmd_evaluate(a):
    from sklearn.metrics import classification_report, confusion_matrix
    df = db.events_with_labels()
    if df.empty:
        print("no labels yet: verify events in the dashboard to build a gold set")
        return
    if getattr(a, "warmup_days", 0):
        cutoff = pd.to_datetime(df["acq_time"]).min() + pd.Timedelta(days=a.warmup_days)
        df = df[pd.to_datetime(df["acq_time"]) >= cutoff]
        print(f"(skipping first {a.warmup_days} days: persistence needs history to warm up)")
    from sklearn.metrics import f1_score
    df["rule_class"] = [(json.loads(x) if isinstance(x, str) else x).get("rule_class") for x in df["features"]]
    for src, g in df.groupby("label_source"):
        print(f"\n=== labels: {src}  (n={len(g)}) ===")
        if src == "synthetic_truth":
            print("Synthetic scenario: the generator and rules share assumptions, so scores are optimistic.")
        labels = [c for c in C.CLASSES if c in set(g["label"]) | set(g["predicted_class"]) | set(g["rule_class"])]
        methods = ", ".join(sorted(g["method"].unique()))
        print(f"Stored predictions (method: {methods})")
        print(classification_report(g["label"], g["predicted_class"], labels=labels, zero_division=0))
        cm = pd.DataFrame(confusion_matrix(g["label"], g["predicted_class"], labels=labels),
                          index=[f"true:{l}" for l in labels], columns=[f"pred:{l}" for l in labels])
        print(cm.to_string())
        f_stored = f1_score(g["label"], g["predicted_class"], labels=labels, average="macro", zero_division=0)
        f_rules = f1_score(g["label"], g["rule_class"], labels=labels, average="macro", zero_division=0)
        if_rec = lambda col: ((g["label"] == C.INDUSTRIAL_FIRE) & (g[col] == C.INDUSTRIAL_FIRE)).sum() / max((g["label"] == C.INDUSTRIAL_FIRE).sum(), 1)
        print(f"\nmacro-F1  stored={f_stored:.3f}  rules baseline={f_rules:.3f}")
        print(f"industrial-fire recall  stored={if_rec('predicted_class'):.2f}  rules baseline={if_rec('rule_class'):.2f}")
        if "xgboost" in methods and f_stored <= f_rules:
            print("-> The model does not beat the rule baseline. Keep classifying with rules.")


def main():
    p = argparse.ArgumentParser(prog="thermalwatch")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init-db").set_defaults(fn=cmd_init_db)
    s = sub.add_parser("demo"); s.add_argument("--end", help="scenario end date YYYY-MM-DD (default today)"); s.set_defaults(fn=cmd_demo)
    s = sub.add_parser("ingest-firms"); s.add_argument("--days", type=int, default=1)
    s.add_argument("--source", action="append"); s.add_argument("--bbox"); s.set_defaults(fn=cmd_ingest_firms)
    s = sub.add_parser("backfill-firms"); s.add_argument("--source", required=True)
    s.add_argument("--start", required=True); s.add_argument("--end", required=True); s.add_argument("--bbox")
    s.set_defaults(fn=cmd_backfill_firms)
    s = sub.add_parser("load-osm"); s.add_argument("--bbox", required=True, help="west,south,east,north"); s.set_defaults(fn=cmd_load_osm)
    s = sub.add_parser("load-wri"); s.add_argument("path"); s.set_defaults(fn=cmd_load_wri)
    s = sub.add_parser("load-gem"); s.add_argument("path"); s.add_argument("--type", required=True); s.set_defaults(fn=cmd_load_gem)
    s = sub.add_parser("classify"); s.add_argument("--landcover", default="worldcover", choices=["worldcover", "demo", "none"])
    s.add_argument("--reclassify", action="store_true")
    s.add_argument("--use-model", action="store_true", help="use the trained XGBoost model (only if it beats rules in `evaluate`)")
    s.set_defaults(fn=cmd_classify)
    s = sub.add_parser("train"); s.add_argument("--use-analyst-labels", action="store_true"); s.set_defaults(fn=cmd_train)
    s = sub.add_parser("evaluate"); s.add_argument("--warmup-days", type=int, default=0); s.set_defaults(fn=cmd_evaluate)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
