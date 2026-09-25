"""Industrial infrastructure reference data.

Every loader returns a DataFrame with columns:
    name, infra_type, operator, status, capacity, source, source_ref, geometry (shapely, EPSG:4326)

Sources
- OpenStreetMap via Overpass API (ODbL)       -> load_osm(bbox)
- WRI Global Power Plant Database CSV (CC BY)  -> load_wri_gppd(path)
- Global Energy Monitor tracker XLSX/CSV (CC BY) -> load_gem(path, infra_type)
"""
from __future__ import annotations

import pandas as pd
import requests
from shapely.geometry import Point, Polygon, LineString

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
REF_COLUMNS = ["name", "infra_type", "operator", "status", "capacity", "source", "source_ref", "geometry"]

# OSM tag -> infra_type. Order matters: first match wins.
OSM_TAG_RULES = [
    (("industrial", "refinery"), "refinery"),
    (("industrial", "oil"), "refinery"),
    (("industrial", "steelmaker"), "steel"),
    (("industrial", "steel"), "steel"),
    (("industrial", "brickyard"), "brick_kiln"),
    (("man_made", "kiln"), "brick_kiln"),
    (("industrial", "cement"), "cement"),
    (("man_made", "flare"), "flare"),
    (("power", "plant"), "power_plant"),
    (("industrial", "mine"), "mine"),
    (("landuse", "quarry"), "mine"),
    (("man_made", "petroleum_well"), "flare"),
    (("man_made", "works"), "industrial_zone"),
    (("landuse", "industrial"), "industrial_zone"),
]


def overpass_query(bbox) -> str:
    w, s, e, n = bbox
    b = f"({s},{w},{n},{e})"
    selectors = [
        'nwr["landuse"="industrial"]', 'nwr["man_made"="works"]', 'nwr["industrial"]',
        'nwr["power"="plant"]', 'nwr["man_made"="flare"]', 'nwr["man_made"="kiln"]',
        'nwr["landuse"="quarry"]', 'nwr["man_made"="petroleum_well"]',
    ]
    body = "".join(f"{sel}{b};" for sel in selectors)
    return f"[out:json][timeout:180];({body});out geom tags;"


def _osm_type(tags: dict) -> str | None:
    for (k, v), infra in OSM_TAG_RULES:
        if tags.get(k) == v:
            return infra
    if "industrial" in tags:
        return "other_industrial"
    return None


def _osm_geometry(el: dict):
    if el["type"] == "node":
        return Point(el["lon"], el["lat"])
    if el["type"] == "way" and el.get("geometry"):
        coords = [(p["lon"], p["lat"]) for p in el["geometry"]]
        if len(coords) >= 4 and coords[0] == coords[-1]:
            return Polygon(coords)
        return LineString(coords) if len(coords) >= 2 else None
    if el["type"] == "relation" and el.get("bounds"):
        # MVP simplification: represent multipolygon relations by their bounding box
        bd = el["bounds"]
        return Polygon([(bd["minlon"], bd["minlat"]), (bd["maxlon"], bd["minlat"]),
                        (bd["maxlon"], bd["maxlat"]), (bd["minlon"], bd["maxlat"])])
    return None


def parse_overpass(payload: dict) -> pd.DataFrame:
    rows = []
    for el in payload.get("elements", []):
        tags = el.get("tags", {})
        infra = _osm_type(tags)
        geom = _osm_geometry(el)
        if not infra or geom is None or geom.is_empty:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        rows.append({
            "name": tags.get("name") or tags.get("name:en"),
            "infra_type": infra,
            "operator": tags.get("operator") or tags.get("owner"),
            "status": None,
            "capacity": tags.get("plant:output:electricity"),
            "source": "OSM",
            "source_ref": f"{el['type']}/{el['id']}",
            "geometry": geom,
        })
    return pd.DataFrame(rows, columns=REF_COLUMNS)


def load_osm(bbox, timeout: int = 200) -> pd.DataFrame:
    """Query Overpass for one region. Use state-sized boxes, not all of India at once."""
    resp = requests.post(OVERPASS_URL, data={"data": overpass_query(bbox)}, timeout=timeout)
    resp.raise_for_status()
    return parse_overpass(resp.json())


THERMAL_FUELS = {"Coal", "Gas", "Oil", "Biomass", "Waste", "Petcoke", "Cogeneration"}


def load_wri_gppd(path: str, country: str = "IND") -> pd.DataFrame:
    df = pd.read_csv(path, low_memory=False)
    df = df[(df["country"] == country) & (df["primary_fuel"].isin(THERMAL_FUELS))]
    return pd.DataFrame({
        "name": df["name"],
        "infra_type": "power_plant",
        "operator": df.get("owner"),
        "status": None,
        "capacity": df["capacity_mw"].astype(str) + " MW " + df["primary_fuel"],
        "source": "WRI_GPPD",
        "source_ref": df["gppd_idnr"],
        "geometry": [Point(xy) for xy in zip(df["longitude"], df["latitude"])],
    }, columns=REF_COLUMNS)


def _pick(df: pd.DataFrame, candidates):
    lower = {c.lower().strip(): c for c in df.columns}
    for cand in candidates:
        if cand in lower:
            return df[lower[cand]]
    return pd.Series([None] * len(df), index=df.index)


def load_gem(path: str, infra_type: str, country: str = "India", sheet=0) -> pd.DataFrame:
    """Generic loader for Global Energy Monitor trackers (steel, power, oil & gas).

    GEM column names differ between trackers and releases, so common variants are matched.
    Check the file and extend the candidate lists if a column is not found.
    """
    df = pd.read_excel(path, sheet_name=sheet) if path.endswith((".xlsx", ".xls")) else pd.read_csv(path)
    ctry = _pick(df, ["country/area", "country", "country/area 1"])
    if ctry.notna().any():
        df = df[ctry.astype(str).str.strip() == country]
    lat = pd.to_numeric(_pick(df, ["latitude", "lat"]), errors="coerce")
    lon = pd.to_numeric(_pick(df, ["longitude", "lon", "long"]), errors="coerce")
    ok = lat.notna() & lon.notna()
    df, lat, lon = df[ok], lat[ok], lon[ok]
    ref = _pick(df, ["gem unit id", "gem unit/phase id", "gem location id", "plant id", "gem plant id", "unit id"])
    if ref.isna().all():
        ref = pd.Series([f"row{i}" for i in df.index], index=df.index)
    return pd.DataFrame({
        "name": _pick(df, ["plant name", "project name", "unit name", "plant name (english)", "name"]),
        "infra_type": infra_type,
        "operator": _pick(df, ["owner", "parent", "operator", "owner name"]),
        "status": _pick(df, ["status", "operating status"]),
        "capacity": _pick(df, ["capacity (mw)", "nominal crude steel capacity (ttpa)", "capacity"]).astype(str),
        "source": "GEM",
        "source_ref": ref.astype(str),
        "geometry": [Point(xy) for xy in zip(lon, lat)],
    }, columns=REF_COLUMNS)
