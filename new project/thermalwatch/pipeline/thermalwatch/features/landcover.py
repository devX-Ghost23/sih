"""Land-cover context around a detection.

Layman: "Is this hot spot on farmland, in a forest, or in a built-up/industrial area?"
Technical: read ESA WorldCover 10 m (v200, 2021) in a ~300 m radius window and
return class fractions. A VIIRS pixel (375 m) covers many 10 m WorldCover pixels,
so fractions are more honest than a single centre-pixel class.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

import numpy as np

from thermalwatch import config as C

LC_KEYS = ["tree_cover", "shrubland", "grassland", "cropland", "built_up", "bare_sparse", "water"]


def empty_fractions() -> dict:
    return {k: 0.0 for k in LC_KEYS} | {"majority": "unknown"}


def _with_majority(fr: dict) -> dict:
    vals = {k: fr.get(k, 0.0) for k in LC_KEYS}
    best = max(vals, key=vals.get)
    return vals | {"majority": best if vals[best] > 0 else "unknown"}


class WorldCoverProvider:
    """Reads WorldCover Cloud-Optimized GeoTIFFs over HTTP (or from a local folder).

    Requires `rasterio` (pip install rasterio). Tiles are 3x3 degrees, named by
    their south-west corner, e.g. N21E078.
    """

    def __init__(self, local_dir: str | None = None, url_template: str = C.WORLDCOVER_URL):
        import rasterio  # noqa: F401  (fail early with a clear ImportError)
        self.local_dir = local_dir
        self.url_template = url_template

    @staticmethod
    def tile_name(lat: float, lon: float) -> str:
        la = int(math.floor(lat / 3) * 3)
        lo = int(math.floor(lon / 3) * 3)
        return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"

    @lru_cache(maxsize=32)
    def _open(self, tile: str):
        import rasterio
        if self.local_dir:
            path = str(Path(self.local_dir) / f"ESA_WorldCover_10m_2021_v200_{tile}_Map.tif")
        else:
            path = self.url_template.format(tile=tile)
        return rasterio.open(path)

    def fractions(self, lat: float, lon: float) -> dict:
        from rasterio.windows import Window
        try:
            ds = self._open(self.tile_name(lat, lon))
        except Exception:
            return empty_fractions()
        row, col = ds.index(lon, lat)
        px_deg = abs(ds.transform.a)
        r_px = max(1, int((C.LANDCOVER_RADIUS_M / 111_320) / px_deg))
        win = Window(col - r_px, row - r_px, 2 * r_px + 1, 2 * r_px + 1)
        data = ds.read(1, window=win, boundless=True, fill_value=0)
        valid = data[data > 0]
        if valid.size == 0:
            return empty_fractions()
        codes, counts = np.unique(valid, return_counts=True)
        fr = {}
        for code, cnt in zip(codes, counts):
            name = C.WORLDCOVER_CLASSES.get(int(code))
            if name in LC_KEYS:
                fr[name] = round(cnt / valid.size, 3)
        return _with_majority(fr)


class DemoLandCoverProvider:
    """Synthetic land cover for the offline demo scenario (see thermalwatch/demo)."""

    def __init__(self, zones):
        # zones: list of (shapely geometry, fractions dict)
        self.zones = zones

    def fractions(self, lat: float, lon: float) -> dict:
        from shapely.geometry import Point
        p = Point(lon, lat)
        for geom, fr in self.zones:
            if geom.contains(p):
                return _with_majority(fr)
        return _with_majority({"cropland": 0.45, "shrubland": 0.25, "grassland": 0.15,
                               "tree_cover": 0.1, "built_up": 0.05})


class NullLandCoverProvider:
    def fractions(self, lat: float, lon: float) -> dict:
        return empty_fractions()
