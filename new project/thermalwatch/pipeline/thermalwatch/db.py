"""PostgreSQL/PostGIS access for the pipeline."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import psycopg
import shapely

from thermalwatch import config as C
from thermalwatch.ingest.firms import DETECTION_COLUMNS
from thermalwatch.pipeline import json_safe

def _find_schema() -> Path:
    """Works from a source checkout, an editable install or the Docker image,
    on any operating system (no hard-coded separators)."""
    here = Path(__file__).resolve()
    candidates = [parent / "db" / "init" / "01_schema.sql" for parent in here.parents[:4]]
    candidates.append(Path.cwd() / "db" / "init" / "01_schema.sql")
    for c in candidates:
        if c.is_file():
            return c
    raise FileNotFoundError("01_schema.sql not found. Run from the project folder or set the schema path explicitly.")


SCHEMA = None  # resolved lazily so importing the module never fails


def connect():
    return psycopg.connect(C.DATABASE_URL, autocommit=False)


def init_db(schema_path: Path | None = None):
    schema_path = Path(schema_path) if schema_path else _find_schema()
    with connect() as con:
        con.execute(schema_path.read_text(encoding="utf-8"))
        con.commit()


def insert_detections(df: pd.DataFrame, truth_col: str | None = None) -> int:
    """Bulk insert (COPY into a temp table, then INSERT .. ON CONFLICT DO NOTHING)."""
    if df.empty:
        return 0
    cols = DETECTION_COLUMNS + ([truth_col] if truth_col else [])
    with connect() as con, con.cursor() as cur:
        cur.execute("""CREATE TEMP TABLE tmp_det (LIKE detections INCLUDING DEFAULTS) ON COMMIT DROP;
                       ALTER TABLE tmp_det DROP COLUMN geom; ALTER TABLE tmp_det DROP COLUMN id;
                       ALTER TABLE tmp_det ADD COLUMN truth TEXT;""")
        with cur.copy(f"COPY tmp_det ({', '.join(c if c != truth_col else 'truth' for c in cols)}) FROM STDIN") as cp:
            for row in df[cols].itertuples(index=False):
                cp.write_row([None if (v is None or (isinstance(v, float) and pd.isna(v))) else v for v in row])
        cur.execute(f"""INSERT INTO detections ({', '.join(DETECTION_COLUMNS)})
                        SELECT {', '.join(DETECTION_COLUMNS)} FROM tmp_det
                        ON CONFLICT (source, acq_time, lat, lon) DO NOTHING""")
        inserted = cur.rowcount
        if truth_col:
            cur.execute("""INSERT INTO labels (detection_id, label, label_source, analyst, note)
                           SELECT d.id, t.truth, 'synthetic_truth', 'generator', 'synthetic demo scenario'
                           FROM tmp_det t JOIN detections d USING (source, acq_time, lat, lon)
                           WHERE t.truth IS NOT NULL
                             AND NOT EXISTS (SELECT 1 FROM labels l WHERE l.detection_id = d.id
                                             AND l.label_source = 'synthetic_truth')""")
        con.commit()
    return inserted


def upsert_infrastructure(df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    rows = [(r.name, r.infra_type, r.operator, r.status, r.capacity, r.source, str(r.source_ref), r.geometry.wkt)
            for r in df.itertuples(index=False)]
    with connect() as con, con.cursor() as cur:
        cur.executemany("""INSERT INTO infrastructure (name, infra_type, operator, status, capacity, source, source_ref, geom)
                           VALUES (%s,%s,%s,%s,%s,%s,%s, ST_GeomFromText(%s, 4326))
                           ON CONFLICT (source, source_ref) DO UPDATE SET
                             name = EXCLUDED.name, infra_type = EXCLUDED.infra_type, operator = EXCLUDED.operator,
                             status = EXCLUDED.status, capacity = EXCLUDED.capacity, geom = EXCLUDED.geom,
                             loaded_at = now()""", rows)
        con.commit()
    return len(rows)


def load_infrastructure() -> pd.DataFrame:
    with connect() as con:
        df = _read(con, "SELECT id, name, infra_type, operator, source, ST_AsBinary(geom) AS wkb FROM infrastructure")
    df["geometry"] = shapely.from_wkb([bytes(b) for b in df["wkb"]]) if len(df) else []
    return df.drop(columns="wkb")


def _read(con, sql, params=None) -> pd.DataFrame:
    with con.cursor() as cur:
        cur.execute(sql, params)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def unclassified_detections(limit: int = 50_000, reclassify: bool = False, offset: int = 0) -> pd.DataFrame:
    where = "" if reclassify else "WHERE e.detection_id IS NULL"
    with connect() as con:
        return _read(con, f"""SELECT d.id, d.source, d.instrument, d.acq_time, d.lat, d.lon, d.bright_mir,
                                     d.bright_tir, d.frp, d.daynight, d.cell_x, d.cell_y
                              FROM detections d LEFT JOIN events e ON e.detection_id = d.id
                              {where} ORDER BY d.acq_time, d.id LIMIT %s OFFSET %s""", (limit, offset))


def history_for(targets: pd.DataFrame) -> pd.DataFrame:
    """All detections in the 3x3 neighbourhood of target cells, from HISTORY_DAYS before the
    earliest target up to the latest target."""
    cells = targets[["cell_x", "cell_y"]].drop_duplicates()
    t0 = pd.to_datetime(targets["acq_time"]).min() - pd.Timedelta(days=C.HISTORY_DAYS + 1)
    t1 = pd.to_datetime(targets["acq_time"]).max()
    with connect() as con, con.cursor() as cur:
        cur.execute("CREATE TEMP TABLE tmp_cells (cx INT, cy INT) ON COMMIT DROP")
        with cur.copy("COPY tmp_cells (cx, cy) FROM STDIN") as cp:
            for cx, cy in cells.itertuples(index=False):
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        cp.write_row((int(cx) + dx, int(cy) + dy))
        cur.execute("CREATE INDEX ON tmp_cells (cx, cy)")
        df = _read(con, """SELECT d.id, d.acq_time, d.frp, d.cell_x, d.cell_y
                           FROM (SELECT DISTINCT cx, cy FROM tmp_cells) c
                           JOIN detections d ON d.cell_x = c.cx AND d.cell_y = c.cy
                           WHERE d.acq_time >= %s AND d.acq_time <= %s""", (t0, t1))
        con.commit()
    return df


def write_events(features: pd.DataFrame, results: pd.DataFrame, rule_results: pd.DataFrame) -> int:
    rows = []
    for det_id, r in results.iterrows():
        f = {k: json_safe(v) for k, v in features.loc[det_id].to_dict().items()}
        rr = rule_results.loc[det_id]
        f["rule_class"] = rr["predicted_class"]
        f["rule_confidence"] = float(rr["confidence"])
        f["rule_needs_verification"] = bool(rr["needs_verification"])
        infra_id = f.get("nearest_infra_id")
        dist = f.get("nearest_infra_dist_m")
        rows.append((int(det_id), r["predicted_class"], float(r["confidence"]), r["method"], r["model_version"],
                     json.dumps(r["class_scores"]), json.dumps(list(r["evidence"])), f["persistence_class"],
                     f.get("lc_majority"), infra_id, dist, bool(r["needs_verification"]), json.dumps(f)))
    with connect() as con, con.cursor() as cur:
        cur.executemany("""INSERT INTO events (detection_id, predicted_class, confidence, method, model_version,
                               class_scores, evidence, persistence_class, land_cover, nearest_infra_id,
                               nearest_infra_dist_m, needs_verification, features)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                           ON CONFLICT (detection_id) DO UPDATE SET
                             predicted_class = EXCLUDED.predicted_class, confidence = EXCLUDED.confidence,
                             method = EXCLUDED.method, model_version = EXCLUDED.model_version,
                             class_scores = EXCLUDED.class_scores, evidence = EXCLUDED.evidence,
                             persistence_class = EXCLUDED.persistence_class, land_cover = EXCLUDED.land_cover,
                             nearest_infra_id = EXCLUDED.nearest_infra_id,
                             nearest_infra_dist_m = EXCLUDED.nearest_infra_dist_m,
                             needs_verification = EXCLUDED.needs_verification, features = EXCLUDED.features,
                             classified_at = now()""", rows)
        con.commit()
    return len(rows)


def events_with_labels() -> pd.DataFrame:
    """Latest label per (detection, label_source), joined to the stored event."""
    with connect() as con:
        return _read(con, """SELECT DISTINCT ON (l.detection_id, l.label_source)
                                    l.detection_id, l.label, l.label_source, e.predicted_class, e.method,
                                    e.features, d.lat, d.lon, d.acq_time
                             FROM labels l JOIN events e ON e.detection_id = l.detection_id
                             JOIN detections d ON d.id = l.detection_id
                             ORDER BY l.detection_id, l.label_source, l.created_at DESC""")


def all_event_features() -> pd.DataFrame:
    with connect() as con:
        return _read(con, """SELECT e.detection_id, e.features, d.lat, d.lon, d.acq_time
                             FROM events e JOIN detections d ON d.id = e.detection_id""")
