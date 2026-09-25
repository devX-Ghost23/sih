"""Transparent evidence-scoring classifier (the MVP baseline).

Layman: every clue adds points to the categories it supports, like a detective's
scorecard. The category with most points wins, and the clues become the evidence list.

Technical: additive log-odds-style scoring over engineered features, converted to
normalised "rule scores" with a temperature softmax. These are NOT calibrated
probabilities; they express how strongly the evidence pattern matches.
"""
from __future__ import annotations

import math

from thermalwatch import config as C

IF, PI, AG, WF, OT = C.INDUSTRIAL_FIRE, C.PERSISTENT_INDUSTRIAL, C.AGRICULTURAL, C.WILDFIRE, C.OTHER
TEMPERATURE = 2.0

INFRA_WORDS = {
    "refinery": "refinery", "steel": "steel plant", "power_plant": "thermal power plant",
    "industrial_zone": "industrial area", "mine": "mine", "brick_kiln": "brick kiln",
    "flare": "flare / well site", "cement": "cement plant", "other_industrial": "industrial site",
}


def _km(m):
    return f"{m / 1000:.1f} km" if m >= 1000 else f"{m:.0f} m"


def score(f: dict) -> dict:
    """f: feature dict (see pipeline.build_features). Returns classification dict."""
    s = {IF: 0.0, PI: 0.0, AG: 0.0, WF: 0.0, OT: 1.0}
    ev = {k: [] for k in s}          # evidence supporting each class
    caution = []                     # facts that lower certainty whatever the class

    dist = f.get("nearest_infra_dist_m")
    itype = f.get("nearest_infra_type")
    iname = f.get("nearest_infra_name") or INFRA_WORDS.get(itype, "facility")
    near = dist is not None and not math.isnan(dist) and dist <= C.NEAR_INFRA_M
    inside = near and dist == 0
    pclass = f["persistence_class"]
    days, months = f["hist_active_days"], f["hist_active_months"]
    month = f["month"]
    crop = f.get("lc_cropland", 0.0)
    natural = f.get("lc_tree_cover", 0.0) + f.get("lc_shrubland", 0.0) + f.get("lc_grassland", 0.0)
    built = f.get("lc_built_up", 0.0) + f.get("lc_bare_sparse", 0.0)

    # --- infrastructure ---------------------------------------------------
    if near:
        where = f"inside {iname}" if inside else f"{_km(dist)} from {iname}"
        s[PI] += 3.0 + (1.0 if inside else 0.0)
        s[IF] += 2.0 + (1.0 if inside else 0.0)
        ev[PI].append(f"Located {where} ({INFRA_WORDS.get(itype, itype)})")
        ev[IF].append(f"Located {where} ({INFRA_WORDS.get(itype, itype)})")
    elif dist is not None and not math.isnan(dist) and dist <= 3000:
        s[PI] += 1.0
        ev[PI].append(f"{_km(dist)} from {iname}, outside the 1 km association radius")
    else:
        s[AG] += 1.0
        s[WF] += 1.0
        far = "No mapped industrial site within 20 km" if dist is None or math.isnan(dist) else f"Nearest mapped industrial site is {_km(dist)} away"
        ev[AG].append(far)
        ev[WF].append(far)

    # --- persistence -------------------------------------------------------
    hist_txt = f"Hot on {days} days across {months} months in the past year"
    if pclass == "persistent":
        s[PI] += 3.0
        s[OT] += 1.0
        ev[PI].append(f"Persistent source: {hist_txt.lower()}")
        if not near:
            caution.append("Persistent heat but no mapped facility nearby: possibly an unmapped industrial site or a coal-seam fire")
    elif pclass == "recurring":
        rec = f"Recurring, not continuous: {hist_txt.lower()}"
        if crop >= 0.3:
            s[AG] += 1.0
            ev[AG].append(rec)
        s[OT] += 0.5
        ev[OT].append(rec)
        if days >= C.PERSISTENT_MIN_ACTIVE_DAYS:
            s[PI] += 1.5
            ev[PI].append(f"Frequent heat ({days} days) but seen for only {months} months so far: may be an emerging persistent source")
        else:
            s[PI] += 0.5
    else:
        s[WF] += 1.5
        s[AG] += 1.5
        s[IF] += 1.0
        short = "No earlier heat at this spot in the past year" if days == 0 else f"Short-lived: only {days} earlier hot days in the past year"
        for k in (WF, AG, IF):
            ev[k].append(short)

    # --- intensity spike against the source's own baseline ------------------
    if f.get("is_spike"):
        s[IF] += 5.0
        ev[IF].append(f"FRP {f['frp']:.1f} MW is {f['frp_ratio']:.1f}x this spot's usual {f['hist_frp_typical']:.1f} MW (z = {f['frp_z']:.1f})")
    elif near and pclass == "temporary" and f["frp"] >= 15:
        s[IF] += 1.5
        ev[IF].append(f"Strong new heat source at a facility with no heat history (FRP {f['frp']:.1f} MW)")

    # --- land cover ---------------------------------------------------------
    if crop >= 0.5:
        s[AG] += 2.5
        ev[AG].append(f"{crop:.0%} cropland around the pixel")
    if natural >= 0.5:
        s[WF] += 2.5
        ev[WF].append(f"{natural:.0%} forest, shrub or grassland around the pixel")
    if built >= 0.3 and near:
        s[PI] += 1.5
        s[IF] += 1.0
        ev[PI].append(f"{built:.0%} built-up or bare industrial ground around the pixel")
        ev[IF].append(f"{built:.0%} built-up or bare industrial ground around the pixel")
    elif built >= 0.5 and pclass == "persistent":
        s[PI] += 1.5
        ev[PI].append(f"{built:.0%} built-up or bare ground: consistent with an industrial site missing from the maps")
    elif built >= 0.5:
        s[OT] += 1.5
        ev[OT].append(f"{built:.0%} built-up or bare ground but no mapped industry nearby: possibly a landfill, urban or unmapped site")
    if f.get("lc_majority") == "unknown":
        caution.append("Land cover unavailable for this location")

    # --- season -------------------------------------------------------------
    if crop >= 0.3 and month in C.AGRI_PEAK_MONTHS:
        s[AG] += 1.5
        ev[AG].append("Detected in a peak crop-residue burning month")
    elif crop >= 0.3 and month in C.AGRI_SHOULDER_MONTHS:
        s[AG] += 0.5
        ev[AG].append("Detected at the edge of a crop-residue burning season")

    # --- night-time heat at infrastructure ----------------------------------
    if f.get("daynight") == "N" and near:
        s[PI] += 0.5
        ev[PI].append("Seen at night, typical of continuously operating plants")

    # --- normalise ------------------------------------------------------------
    exps = {k: math.exp(v / TEMPERATURE) for k, v in s.items()}
    total = sum(exps.values())
    scores = {k: round(v / total, 3) for k, v in exps.items()}
    ranked = sorted(scores, key=scores.get, reverse=True)
    top, second = ranked[0], ranked[1]
    conf = scores[top]

    evidence = ev[top][:] if ev[top] else ["No strong evidence for any specific source type"]
    if top == IF and f.get("is_spike"):
        evidence.append("Could also be a planned flaring or start-up event; verify before acting")
    evidence += caution
    needs_verification = (top == IF or conf < 0.55 or scores[top] - scores[second] < 0.15
                          or bool(caution and top != OT))
    return {
        "predicted_class": top,
        "confidence": conf,
        "class_scores": scores,
        "evidence": evidence,
        "needs_verification": bool(needs_verification),
        "method": "rules",
        "model_version": "rules-v1",
    }
