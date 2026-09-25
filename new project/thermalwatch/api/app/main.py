"""ThermalWatch API: serves classified thermal events as GeoJSON for the dashboard."""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Literal

import psycopg
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://thermal:thermal@localhost:5432/thermalwatch")
CLASSES = ["industrial_fire", "persistent_industrial", "agricultural_burning", "wildfire_natural", "other_unclassified"]
CELL_DEG = 0.005

app = FastAPI(title="ThermalWatch API", version="0.1.0",
              description="Classification of satellite thermal anomalies (SIH26162 MVP)")
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
                   allow_methods=["*"], allow_headers=["*"])


def get_db():
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as con:
        yield con


def _bbox(bbox: str | None):
    if not bbox:
        return None
    try:
        w, s, e, n = (float(v) for v in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox must be west,south,east,north")
    return w, s, e, n


def _filters(bbox, classes, start, end, min_confidence, needs_verification):
    where, params = [], []
    b = _bbox(bbox)
    if b:
        where.append("d.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)")
        params += list(b)
    if classes:
        cl = [c for c in classes.split(",") if c]
        bad = set(cl) - set(CLASSES)
        if bad:
            raise HTTPException(400, f"unknown classes: {sorted(bad)}")
        where.append("e.predicted_class = ANY(%s)")
        params.append(cl)
    if start:
        where.append("d.acq_time >= %s")
        params.append(start)
    if end:
        where.append("d.acq_time <= %s")
        params.append(end)
    if min_confidence is not None:
        where.append("e.confidence >= %s")
        params.append(min_confidence)
    if needs_verification is not None:
        where.append("e.needs_verification = %s")
        params.append(needs_verification)
    return (" AND ".join(where) or "TRUE"), params


@app.get("/api/health")
def health(con=Depends(get_db)):
    con.execute("SELECT 1")
    return {"status": "ok"}


@app.get("/api/meta")
def meta(con=Depends(get_db)):
    sources = con.execute("""SELECT source, count(*) AS detections, min(acq_time) AS first, max(acq_time) AS last
                             FROM detections GROUP BY source ORDER BY source""").fetchall()
    methods = con.execute("SELECT method, model_version, count(*) AS n FROM events GROUP BY 1, 2").fetchall()
    labels = con.execute("SELECT label_source, count(*) AS n FROM labels GROUP BY 1").fetchall()
    infra = con.execute("SELECT source, infra_type, count(*) AS n FROM infrastructure GROUP BY 1, 2 ORDER BY 1, 2").fetchall()
    return {"sources": sources, "methods": methods, "labels": labels, "infrastructure": infra,
            "synthetic": any(s["source"] == "DEMO_SYNTHETIC" for s in sources), "classes": CLASSES}


@app.get("/api/events")
def events(bbox: str | None = None, classes: str | None = None,
           start: datetime | None = None, end: datetime | None = None,
           min_confidence: float | None = Query(None, ge=0, le=1),
           needs_verification: bool | None = None,
           limit: int = Query(20000, ge=1, le=100000), con=Depends(get_db)):
    where, params = _filters(bbox, classes, start, end, min_confidence, needs_verification)
    rows = con.execute(f"""
        SELECT d.id, d.lon, d.lat, d.acq_time, d.frp, d.daynight,
               e.predicted_class, e.confidence, e.persistence_class, e.needs_verification
        FROM events e JOIN detections d ON d.id = e.detection_id
        WHERE {where}
        ORDER BY (e.predicted_class = 'industrial_fire'), d.acq_time
        LIMIT %s""", params + [limit]).fetchall()
    return {"type": "FeatureCollection", "features": [{
        "type": "Feature", "id": r["id"],
        "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
        "properties": {"id": r["id"], "class": r["predicted_class"], "confidence": round(r["confidence"], 3),
                       "frp": r["frp"], "acq_time": r["acq_time"].isoformat(), "daynight": r["daynight"],
                       "persistence": r["persistence_class"], "needs_verification": r["needs_verification"]},
    } for r in rows], "truncated": len(rows) == limit}


@app.get("/api/events/{event_id}")
def event_detail(event_id: int, con=Depends(get_db)):
    r = con.execute("""
        SELECT d.*, d.confidence AS detection_confidence, ST_AsGeoJSON(d.geom)::json AS geometry, e.predicted_class, e.confidence, e.method,
               e.model_version, e.class_scores, e.evidence, e.persistence_class, e.land_cover,
               e.nearest_infra_dist_m, e.needs_verification, e.features, e.classified_at,
               i.id AS infra_id, i.name AS infra_name, i.infra_type, i.operator AS infra_operator,
               i.source AS infra_source, ST_AsGeoJSON(i.geom, 6)::json AS infra_geometry
        FROM events e JOIN detections d ON d.id = e.detection_id
        LEFT JOIN infrastructure i ON i.id = e.nearest_infra_id
        WHERE e.detection_id = %s""", (event_id,)).fetchone()
    if not r:
        raise HTTPException(404, "event not found")
    labels = con.execute("""SELECT label, label_source, analyst, note, created_at FROM labels
                            WHERE detection_id = %s ORDER BY created_at DESC""", (event_id,)).fetchall()
    f = r["features"]
    lc = {k[3:]: v for k, v in f.items() if k.startswith("lc_") and k != "lc_majority" and v}
    return {
        "type": "Feature", "id": r["id"], "geometry": r["geometry"],
        "properties": {
            "id": r["id"],
            "classification": {
                "predicted_class": r["predicted_class"], "confidence": round(r["confidence"], 3),
                "confidence_note": "Score from the classifier, not a verified certainty",
                "method": r["method"], "model_version": r["model_version"],
                "class_scores": r["class_scores"], "needs_verification": r["needs_verification"],
                "rule_baseline": f.get("rule_class"), "classified_at": r["classified_at"].isoformat(),
            },
            "evidence": r["evidence"],
            "detection": {
                "source": r["source"], "instrument": r["instrument"], "satellite": r["satellite"],
                "acq_time": r["acq_time"].isoformat(), "lat": r["lat"], "lon": r["lon"],
                "frp_mw": r["frp"], "bright_mir_k": r["bright_mir"], "bright_tir_k": r["bright_tir"],
                "firms_confidence": r["detection_confidence"], "daynight": r["daynight"],
            },
            "persistence": {
                "class": r["persistence_class"], "active_days_365": f.get("hist_active_days"),
                "active_months_365": f.get("hist_active_months"), "days_since_first": f.get("hist_days_since_first"),
                "days_since_last": f.get("hist_days_since_last"), "typical_frp_mw": f.get("hist_frp_typical"),
                "frp_z": f.get("frp_z"), "frp_ratio": f.get("frp_ratio"), "spike": f.get("is_spike"),
                "same_day_nearby_detections": f.get("same_day_neighbourhood_count"),
            },
            "infrastructure": None if r["infra_id"] is None else {
                "id": r["infra_id"], "name": r["infra_name"], "type": r["infra_type"], "operator": r["infra_operator"],
                "source": r["infra_source"], "distance_m": r["nearest_infra_dist_m"], "geometry": r["infra_geometry"],
                "within_2km": f.get("infra_within_2km"),
            },
            "land_cover": {"majority": r["land_cover"], "fractions": lc},
            "labels": [{**l, "created_at": l["created_at"].isoformat()} for l in labels],
        },
    }


@app.get("/api/events/{event_id}/timeline")
def timeline(event_id: int, days: int = Query(365, ge=7, le=1000), con=Depends(get_db)):
    """Daily heat history of the event's ~1.7 km neighbourhood (same 3x3 cells used for persistence)."""
    d = con.execute("SELECT cell_x, cell_y, acq_time FROM detections WHERE id = %s", (event_id,)).fetchone()
    if not d:
        raise HTTPException(404, "event not found")
    rows = con.execute("""
        SELECT (acq_time AT TIME ZONE 'UTC')::date AS day, count(*) AS detections, max(frp) AS max_frp
        FROM detections
        WHERE cell_x BETWEEN %s AND %s AND cell_y BETWEEN %s AND %s
          AND acq_time > %s - make_interval(days => %s) AND acq_time <= %s + interval '1 day'
        GROUP BY 1 ORDER BY 1""",
        (d["cell_x"] - 1, d["cell_x"] + 1, d["cell_y"] - 1, d["cell_y"] + 1,
         d["acq_time"], days, d["acq_time"])).fetchall()
    return {"event_id": event_id, "days": days, "event_date": d["acq_time"].date().isoformat(),
            "neighbourhood_km": round(3 * CELL_DEG * 111, 1),
            "series": [{"date": r["day"].isoformat(), "detections": r["detections"], "max_frp": r["max_frp"]} for r in rows]}


@app.get("/api/infrastructure")
def infrastructure(bbox: str | None = None, types: str | None = None, con=Depends(get_db)):
    where, params = [], []
    b = _bbox(bbox)
    if b:
        where.append("geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)")
        params += list(b)
    if types:
        where.append("infra_type = ANY(%s)")
        params.append(types.split(","))
    rows = con.execute(f"""SELECT id, name, infra_type, operator, source, ST_AsGeoJSON(geom, 6)::json AS geometry
                           FROM infrastructure WHERE {' AND '.join(where) or 'TRUE'} LIMIT 20000""", params).fetchall()
    return {"type": "FeatureCollection", "features": [{
        "type": "Feature", "id": r["id"], "geometry": r["geometry"],
        "properties": {k: r[k] for k in ("id", "name", "infra_type", "operator", "source")}} for r in rows]}


@app.get("/api/stats")
def stats(bbox: str | None = None, start: datetime | None = None, end: datetime | None = None,
          con=Depends(get_db)):
    where, params = _filters(bbox, None, start, end, None, None)
    rows = con.execute(f"""SELECT e.predicted_class AS class, count(*) AS n,
                                  sum(e.needs_verification::int) AS needs_verification
                           FROM events e JOIN detections d ON d.id = e.detection_id
                           WHERE {where} GROUP BY 1""", params).fetchall()
    by = {r["class"]: {"n": r["n"], "needs_verification": r["needs_verification"]} for r in rows}
    return {"total": sum(v["n"] for v in by.values()),
            "by_class": {c: by.get(c, {"n": 0, "needs_verification": 0}) for c in CLASSES}}


class LabelIn(BaseModel):
    label: Literal["industrial_fire", "persistent_industrial", "agricultural_burning",
                   "wildfire_natural", "other_unclassified"]
    analyst: str | None = Field(None, max_length=100)
    note: str | None = Field(None, max_length=1000)


@app.post("/api/events/{event_id}/labels", status_code=201)
def add_label(event_id: int, body: LabelIn, con=Depends(get_db)):
    if not con.execute("SELECT 1 FROM detections WHERE id = %s", (event_id,)).fetchone():
        raise HTTPException(404, "event not found")
    row = con.execute("""INSERT INTO labels (detection_id, label, label_source, analyst, note)
                         VALUES (%s, %s, 'analyst', %s, %s) RETURNING id, created_at""",
                      (event_id, body.label, body.analyst, body.note)).fetchone()
    con.commit()
    return {"id": row["id"], "detection_id": event_id, "label": body.label, "created_at": row["created_at"].isoformat()}
