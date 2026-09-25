"""Gradient-boosted tree classifier (upgrade over the rule baseline).

Honesty rules baked in:
- Trained on WEAK labels (confident rule outputs) unless analyst labels exist.
  A model trained only on rule labels mostly learns to reproduce the rules,
  so it must be evaluated on analyst-verified labels, never on its own training labels.
- Raw latitude/longitude are never features (the model would memorise places).
- Train/test split is spatially blocked by 1-degree tiles to avoid spatial leakage.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd

from thermalwatch import config as C
from thermalwatch.features.proximity import INFRA_TYPES

NUMERIC = ["hist_active_days", "hist_active_months", "hist_days_since_first", "hist_days_since_last",
           "frp_z", "frp_ratio", "same_day_neighbourhood_count", "infra_within_2km",
           "bright_mir", "bright_tir",
           "lc_tree_cover", "lc_shrubland", "lc_grassland", "lc_cropland", "lc_built_up",
           "lc_bare_sparse", "lc_water"]


def to_matrix(f: pd.DataFrame) -> pd.DataFrame:
    X = pd.DataFrame(index=f.index)
    for c in NUMERIC:
        X[c] = pd.to_numeric(f[c], errors="coerce").astype(float)
    X["log_frp"] = np.log1p(f["frp"].astype(float))
    dist = pd.to_numeric(f["nearest_infra_dist_m"], errors="coerce").fillna(20000).clip(upper=20000)
    X["infra_dist_km"] = dist / 1000
    X["near_infra"] = (dist <= C.NEAR_INFRA_M).astype(float)
    for t in INFRA_TYPES:
        X[f"infra_is_{t}"] = (f["nearest_infra_type"] == t).astype(float) * X["near_infra"]
    X["is_night"] = (f["daynight"] == "N").astype(float)
    m = f["month"].astype(float)
    X["month_sin"] = np.sin(2 * np.pi * m / 12)
    X["month_cos"] = np.cos(2 * np.pi * m / 12)
    return X


def spatial_groups(lat, lon) -> np.ndarray:
    return (np.floor(np.asarray(lat)).astype(int) * 1000 + np.floor(np.asarray(lon)).astype(int))


def train(features: pd.DataFrame, labels: pd.Series, lat, lon, out_path: str = C.MODEL_PATH,
          test_size: float = 0.25, seed: int = 7, min_examples: int = 10) -> dict:
    import xgboost as xgb
    from sklearn.metrics import classification_report
    from sklearn.model_selection import GroupShuffleSplit

    X = to_matrix(features)
    counts_all = labels.value_counts()
    trainable = [c for c in C.CLASSES if counts_all.get(c, 0) >= min_examples]
    skipped = {c: int(counts_all.get(c, 0)) for c in C.CLASSES if c not in trainable}
    keep = labels.isin(trainable)
    X, labels = X[keep.to_numpy()], labels[keep]
    lat, lon = np.asarray(lat)[keep.to_numpy()], np.asarray(lon)[keep.to_numpy()]
    if len(trainable) < 2:
        raise ValueError(f"need at least 2 classes with >= {min_examples} labels; have {counts_all.to_dict()}")
    y = labels.map({c: i for i, c in enumerate(trainable)})
    groups = spatial_groups(lat, lon)
    split = GroupShuffleSplit(n_splits=1, test_size=test_size, random_state=seed)
    tr, te = next(split.split(X, y, groups))

    counts = np.bincount(y.iloc[tr], minlength=len(trainable)).astype(float)
    weights_by_class = np.where(counts > 0, counts.sum() / (len(trainable) * np.maximum(counts, 1)), 0)
    w = weights_by_class[y.iloc[tr].to_numpy()]

    clf = xgb.XGBClassifier(n_estimators=300, max_depth=4, learning_rate=0.08, subsample=0.9,
                            colsample_bytree=0.9, objective="multi:softprob",
                            num_class=len(trainable), eval_metric="mlogloss")
    clf.fit(X.iloc[tr], y.iloc[tr], sample_weight=w)

    pred = clf.predict(X.iloc[te])
    present = sorted(set(y.iloc[te]) | set(pred))
    report = classification_report(y.iloc[te], pred, labels=present,
                                   target_names=[trainable[i] for i in present],
                                   zero_division=0, output_dict=True)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    clf.save_model(out_path)
    meta = {"features": list(X.columns), "classes": trainable, "untrained_classes": skipped,
            "n_train": int(len(tr)),
            "n_test": int(len(te)), "split": "GroupShuffleSplit by 1-degree tile",
            "report": report}
    with open(out_path + ".meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return meta


class XGBModel:
    def __init__(self, path: str = C.MODEL_PATH):
        import xgboost as xgb
        self.clf = xgb.XGBClassifier()
        self.clf.load_model(path)
        with open(path + ".meta.json", encoding="utf-8") as fh:
            self.meta = json.load(fh)
        self.version = f"xgb-{os.path.getmtime(path):.0f}"

    @classmethod
    def load_if_present(cls, path: str = C.MODEL_PATH):
        if not (os.path.exists(path) and os.path.exists(path + ".meta.json")):
            return None
        try:
            return cls(path)
        except ImportError:
            print("xgboost is not installed, so the model cannot be loaded; classifying with rules.\n"
                  "  pip install 'thermalwatch[model]'   (macOS: brew install libomp first)")
            return None

    def override(self, features: pd.DataFrame, rule_out: pd.DataFrame) -> pd.DataFrame:
        """Replace class/confidence/scores with model output; keep rule evidence and add model drivers."""
        import xgboost as xgb
        X = to_matrix(features)[self.meta["features"]]
        proba = self.clf.predict_proba(X)
        booster = self.clf.get_booster()
        contribs = booster.predict(xgb.DMatrix(X), pred_contribs=True)  # (n, classes, features+1)
        out = rule_out.copy()
        known = self.meta["classes"]
        for i, det_id in enumerate(X.index):
            if out.at[det_id, "predicted_class"] not in known:
                # The model never saw enough examples of this class: the rules stay in charge.
                out.at[det_id, "evidence"] = list(out.at[det_id, "evidence"]) + [
                    "Decided by rules: the model has too few labelled examples of this class"]
                continue
            k = int(np.argmax(proba[i]))
            cls = known[k]
            scores = {c: 0.0 for c in C.CLASSES} | {c: round(float(p), 3) for c, p in zip(known, proba[i])}
            top_feats = np.argsort(contribs[i, k, :-1])[::-1][:3]
            drivers = ", ".join(self.meta["features"][j] for j in top_feats if contribs[i, k, j] > 0)
            evidence = list(out.at[det_id, "evidence"])
            if cls != out.at[det_id, "predicted_class"]:
                evidence.append(f"Model disagrees with rule baseline ({out.at[det_id, 'predicted_class']})")
            if drivers:
                evidence.append(f"Main model drivers: {drivers}")
            sorted_p = sorted(scores.values(), reverse=True)
            out.at[det_id, "predicted_class"] = cls
            out.at[det_id, "confidence"] = scores[cls]
            out.at[det_id, "class_scores"] = scores
            out.at[det_id, "evidence"] = evidence
            out.at[det_id, "needs_verification"] = bool(cls == C.INDUSTRIAL_FIRE or sorted_p[0] < 0.55
                                                        or sorted_p[0] - sorted_p[1] < 0.15)
            out.at[det_id, "method"] = "xgboost"
            out.at[det_id, "model_version"] = self.version
        return out
