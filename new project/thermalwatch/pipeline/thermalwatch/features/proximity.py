"""Spatial association between detections and industrial infrastructure.

Layman: "What is the closest factory / refinery / mine to this hot spot, and how far is it?"
Technical: project to a metric CRS (EPSG:7755, India-wide LCC), build an STRtree
spatial index over infrastructure geometries, and run a nearest-neighbour query.
Distance to a polygon is 0 when the point lies inside it.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer

from thermalwatch import config as C

INFRA_TYPES = ["refinery", "steel", "power_plant", "industrial_zone", "mine",
               "brick_kiln", "flare", "cement", "other_industrial"]

_to_metric = Transformer.from_crs("EPSG:4326", C.METRIC_CRS, always_xy=True)


def _project(geoms):
    return shapely.transform(np.asarray(geoms, dtype=object),
                             lambda xy: np.column_stack(_to_metric.transform(xy[:, 0], xy[:, 1])))


class InfraIndex:
    def __init__(self, infra: pd.DataFrame):
        """infra: DataFrame with id, name, infra_type, operator, source, geometry (shapely, EPSG:4326)."""
        self.infra = infra.reset_index(drop=True)
        self.geoms_m = _project(self.infra["geometry"].to_numpy()) if len(self.infra) else np.array([])
        self.tree = shapely.STRtree(self.geoms_m) if len(self.infra) else None

    def features(self, lat, lon, search_m: float = 20000) -> pd.DataFrame:
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        n = len(lat)
        out = pd.DataFrame({
            "nearest_infra_idx": pd.array([pd.NA] * n, dtype="Int64"),
            "nearest_infra_dist_m": np.full(n, np.nan),
            "nearest_infra_type": [None] * n,
            "infra_within_2km": np.zeros(n, dtype=int),
        })
        if self.tree is None or n == 0:
            return out
        pts = _project(shapely.points(lon, lat))
        (src, dst), dist = self.tree.query_nearest(pts, max_distance=search_m,
                                                    return_distance=True, all_matches=False)
        out.loc[src, "nearest_infra_idx"] = dst
        out.loc[src, "nearest_infra_dist_m"] = np.round(dist, 1)
        out.loc[src, "nearest_infra_type"] = self.infra["infra_type"].to_numpy()[dst]
        pairs = self.tree.query(pts, predicate="dwithin", distance=2000)
        if pairs.size:
            counts = np.bincount(pairs[0], minlength=n)
            out["infra_within_2km"] = counts
        return out

    def row(self, idx):
        return None if pd.isna(idx) else self.infra.iloc[int(idx)]
