# ThermalWatch — SIH26162 MVP

Satellite thermal hot spots come with no explanation. NASA FIRMS tells you *something is hot
at this pixel*; it does not tell you whether that is a refinery flare that runs every night, a
fire at a steel plant, a farmer burning paddy stubble, or a forest fire.

ThermalWatch takes each detection and answers five questions an analyst actually has:

1. **Where is it?** — mapped, with the land around it
2. **What is probably causing it?** — one of five categories, with a score
3. **How persistent is it?** — one-off, recurring or a fixed source running all year
4. **Is it tied to industry?** — nearest mapped facility and distance
5. **Why does the system think so?** — a plain-language evidence list, every time

This is the two official deliverables of SIH26162: classification of industrial fires apart
from natural fires, and a GIS solution that stores the output and shows it over a map.

---

## What is in the box

```
tw.py                     cross-platform task runner (use instead of make)
db/init/01_schema.sql     PostGIS schema (detections, infrastructure, events, labels)
pipeline/                 ingestion, features, classification, training, CLI
  thermalwatch/ingest/    NASA FIRMS + OpenStreetMap / GEM / WRI loaders
  thermalwatch/features/  persistence, proximity, land cover
  thermalwatch/classify/  rule engine (default) and XGBoost model (optional)
  thermalwatch/demo/      synthetic scenario so everything runs with no API keys
  tests/                  16 unit tests covering the logic that decides the answer
api/                      FastAPI service returning GeoJSON
web/                      React + Leaflet analyst dashboard
```

## Requirements

Works on **Windows 10/11, macOS (Intel and Apple Silicon) and Linux**. Two ways to run it:

| | needs | good for |
|---|---|---|
| Docker (recommended) | Docker Desktop (Windows/macOS) or Docker Engine + Compose v2 (Linux) | demos, judging, anyone who does not want to install PostGIS |
| Local Python | Python 3.10+, Node 18+, and a PostGIS database (the Docker one is fine) | developing the pipeline or the dashboard |

Every task runs through `tw.py`, a plain Python script, so there is no `make` requirement and
no shell-specific syntax. On Windows you can also type `tw demo` instead of `python tw.py demo`.

## Quick start (Docker)

```bash
# any OS, from the project folder
python tw.py up          # database + API + dashboard
python tw.py demo        # synthetic scenario: ~5k detections, classified, scored
```

On Windows use `py tw.py up` if `python` is not on your PATH. Then open
<http://localhost:5173> in a browser.

`demo` needs no keys and no internet. It generates a year of realistic synthetic detections
(refinery flares, a steel plant, Jharia-style coal fires, brick kilns, a landfill, Punjab
stubble seasons, Uttarakhand forest fires and two industrial fires), classifies them, and
prints a confusion matrix.

Other tasks: `python tw.py classify | train | evaluate | logs | down | test`. Anything after
the task is passed through, e.g. `python tw.py ingest --days 3 --bbox 69,21,73,24`.

### Running on real data

Copy `.env.example` to `.env` and add a free key from
<https://firms.modaps.eosdis.nasa.gov/api/map_key/>.

```bash
# 1. history first: persistence analysis needs a year of past detections
python tw.py ingest --source VIIRS_SNPP_SP --days 5 --bbox 69,21,73,24   # repeat, or:
docker compose run --rm pipeline backfill-firms --source VIIRS_SNPP_SP \
    --start 2025-09-01 --end 2026-09-01 --bbox 69,21,73,24

# 2. industrial reference data for the region you are demoing
docker compose run --rm pipeline load-osm --bbox 69,21,73,24
docker compose run --rm pipeline load-wri /data/global_power_plant_database.csv
docker compose run --rm pipeline load-gem /data/gem_steel_tracker.xlsx --type steel

# 3. classify, then keep it fresh
python tw.py ingest --days 2
python tw.py classify
```

Put downloaded reference files in the `data` folder; it is mounted at `/data` inside the
container. For a daily refresh use Task Scheduler on Windows or cron on macOS/Linux to run
`python tw.py ingest` followed by `python tw.py classify`. No queue or scheduler service is
needed for the MVP.

### Local development (no Docker for the code)

```bash
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate

python tw.py setup-local        # editable install of the pipeline package
python tw.py db-only            # PostGIS in Docker, everything else local
python tw.py test               # 16 unit tests, no database needed

thermalwatch demo               # the CLI is on your PATH after setup-local

cd api && pip install -r requirements.txt && uvicorn app.main:app --reload
cd web && npm install && npm run dev      # proxies /api to localhost:8000
```

Set `DATABASE_URL` in your shell if the database is not on
`postgresql://thermal:thermal@localhost:5432/thermalwatch`.

### Platform notes

- **Windows.** Docker Desktop needs the WSL 2 backend and file sharing enabled for the drive
  holding this folder. Line endings are pinned to LF by `.gitattributes`, which matters
  because the Linux containers cannot run CRLF scripts. Use PowerShell or Windows Terminal.
- **macOS.** On Apple Silicon everything runs natively; the `postgis/postgis` image has an
  arm64 build. `xgboost` needs OpenMP, so run `brew install libomp` before installing the
  optional `model` extra. The model is off by default, so you can skip this entirely.
- **Linux.** Needs Compose v2 (`docker compose`, not `docker-compose`); `tw.py` detects and
  falls back to v1 if that is all you have.
- **Optional dependencies** are separated for this reason: core requirements are pure-wheel
  and install cleanly everywhere, while `rasterio` (land cover), `xgboost` (model) and
  `openpyxl` (GEM spreadsheets) live in `requirements-optional.txt` and the `[raster]`,
  `[model]`, `[excel]` extras. The system degrades gracefully: without `rasterio` land cover
  is reported as unknown and the classifier flags those events for verification.
- All timestamps are stored and compared in UTC, so results do not change with the machine's
  timezone or locale.

---

## How the classification works

Three signals do almost all the work, and each one is a feature you can point at in the UI.

**1. Persistence.** The map is cut into ~555 m cells. For every detection, the system reads
its own cell plus the eight around it (~1.7 km, which absorbs VIIRS geolocation jitter) and
counts how many *earlier* days and *earlier* months in the past year were hot there.

| behaviour | rule | typical source |
|---|---|---|
| one-off | < 3 hot days | wildfire, a single stubble fire |
| recurring | ≥ 3 days in ≥ 2 months | seasonal burning, landfill fires |
| persistent | ≥ 20 days in ≥ 6 months | flares, furnaces, coal-seam fires |

The month threshold matters: India's two burning seasons span about four months, so a
day-count alone would label the whole Punjab paddy belt a persistent industrial source.
Features only ever use days *before* the detection, so nothing leaks from the future.

**2. Infrastructure proximity.** Detections are matched to OSM industrial polygons, GEM
trackers and WRI power plants with a spatial index; a detection inside a plant boundary gets
distance 0. Within 1 km counts as associated.

**3. Intensity against the source's own baseline.** A steel plant is *always* hot, so absolute
power says little. The system compares each detection to the typical FRP of that same spot
(robust z-score on log FRP) and only calls a spike when it is ≥ 3σ, ≥ 3× typical, and ≥ 15 MW.
That spike is what separates **an industrial fire** from **normal industrial heat** — the
hardest and most valuable distinction in this problem.

Land cover (ESA WorldCover fractions in a 300 m radius) and season then separate cropland
burning from forest fire from built-up industrial ground.

### Rules first, model second — on purpose

The rule engine scores every category from these features and emits the evidence list. The
XGBoost model is built and works, but it is **off by default**, because on this project's own
evaluation it lost:

```
macro-F1  rules 0.99   xgboost 0.96
industrial-fire recall  rules 1.00   xgboost 0.73     (and it reported 1.00 confidence)
```

The reason is instructive and worth saying out loud in a demo: weak labels are generated from
confident rule outputs, but industrial fires are *always* flagged for verification, so almost
none of them reach the training set. A model cannot learn a class it never sees. Turn the
model on with `classify --use-model` only when `evaluate` shows it beating the baseline on
analyst-verified labels.

### Ground truth, honestly

FIRMS detections are **not** ground truth for cause. The system therefore keeps labels
separate from predictions in a `labels` table with a `label_source` column:

- `synthetic_truth` — from the demo generator; useful for wiring, useless as evidence of
  real-world accuracy (the generator and the rules share assumptions, so scores are inflated)
- `analyst` — created when someone presses a category button in the dashboard. This is the
  gold set. `evaluate` reports each source separately and never mixes them.

For a real evaluation set, verify a few hundred events across known cases: Jharia coalfield
(persistent), refinery and steel belts (persistent industrial), Punjab in November
(agricultural), Uttarakhand in April–May (wildfire), plus any reported industrial fire with a
news date. Training deliberately excludes analyst labels unless you pass
`train --use-analyst-labels`, so the gold set stays clean.

---

## API

| endpoint | purpose |
|---|---|
| `GET /api/events` | GeoJSON of classified events (`bbox`, `classes`, `start`, `end`, `min_confidence`, `needs_verification`) |
| `GET /api/events/{id}` | full detail: evidence, scores, persistence, infrastructure, land cover, labels |
| `GET /api/events/{id}/timeline` | daily heat history of the event's neighbourhood |
| `GET /api/infrastructure` | mapped industrial sites as GeoJSON |
| `GET /api/stats` | counts per category |
| `GET /api/meta` | what data is loaded, which method classified it |
| `POST /api/events/{id}/labels` | analyst verification (builds the gold set) |

Interactive docs at `http://localhost:8000/docs`.

<details>
<summary>Example response (trimmed)</summary>

```json
{
  "type": "Feature",
  "id": 990,
  "geometry": { "type": "Point", "coordinates": [79.00691, 20.93276] },
  "properties": {
    "classification": {
      "predicted_class": "industrial_fire",
      "confidence": 0.486,
      "confidence_note": "Score from the classifier, not a verified certainty",
      "method": "rules",
      "class_scores": { "industrial_fire": 0.486, "persistent_industrial": 0.486,
                        "other_unclassified": 0.015, "agricultural_burning": 0.007,
                        "wildfire_natural": 0.005 },
      "needs_verification": true
    },
    "evidence": [
      "Located inside Butibori industrial area (industrial area)",
      "FRP 38.6 MW is 14.5x this spot's usual 2.7 MW (z = 7.9)",
      "70% built-up or bare industrial ground around the pixel",
      "Could also be a planned flaring or start-up event; verify before acting"
    ],
    "persistence": { "class": "persistent", "active_days_365": 96, "active_months_365": 12,
                     "typical_frp_mw": 2.66, "frp_ratio": 14.5, "spike": true },
    "infrastructure": { "name": "Butibori industrial area", "type": "industrial_zone",
                        "distance_m": 0.0, "source": "OSM", "within_2km": 1 }
  }
}
```
</details>

---

## Dashboard

Left rail: counts per category, date range, score threshold, "only events needing a check",
and an industrial-sites layer. Map: one dot per detection, colour by category, size by fire
radiative power, dashed outline when the evidence is mixed, industrial fires drawn larger
with a white ring so they survive a crowded stubble season. Satellite basemap for looking at
a facility.

Click an event and the panel shows the category and score (labelled as a score, not a
certainty), the competing categories, the evidence list, the **heat barcode** — 365 day-ticks
coloured by that day's peak power, which makes a flare, a seasonal pattern and a one-off fire
instantly distinguishable — the measurements, the nearest mapped site, and buttons to record
what it really was.

---

## Limits you should state before a judge does

- **375 m pixels, two passes a day.** Small or short fires between overpasses are invisible.
  The system classifies what FIRMS detected; it does not improve detection.
- **Clouds and smoke hide fires.** Gaps in the heat barcode are missing observations, not
  proof the source was cold.
- **OSM and GEM are incomplete**, especially for small units in India. "No facility nearby"
  is weak evidence, which is why persistent heat on built-up land with no mapped site is
  surfaced as a possible unmapped industrial site rather than dismissed.
- **Scores are not probabilities of truth.** A 0.88 score means the evidence pattern matches
  that category strongly, given rules a human wrote.
- **Demo numbers are synthetic.** Any accuracy figure from `make demo` proves the wiring
  works, nothing more.
- **Brick kilns, landfills and gas flares** are the known confusers; the first two are
  handled explicitly, flare-vs-fire separation would improve with VIIRS Nightfire temperature
  data (not in the MVP).

## Where to take it next

1. Verify ~200 real events in the dashboard, then rerun `evaluate` — that is the first real
   number this project can honestly report.
2. Add VIIRS Nightfire (or per-detection temperature estimates) to separate flares from
   combustion fires.
3. Sentinel-2 SWIR thumbnails on demand as confirming evidence in the detail panel.
4. Alerting (email/webhook) for industrial-fire spikes at facilities on a watchlist.
