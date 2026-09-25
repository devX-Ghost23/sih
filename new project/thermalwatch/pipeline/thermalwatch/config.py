"""Central configuration. Every threshold used in classification lives here
so the team can tune it in one place and explain it to judges."""
import os
from pathlib import Path

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://thermal:thermal@localhost:5432/thermalwatch")
FIRMS_MAP_KEY = os.getenv("FIRMS_MAP_KEY", "")

# India bounding box: west, south, east, north
INDIA_BBOX = (68.0, 6.0, 98.0, 38.0)

# ---- Output classes -------------------------------------------------------
INDUSTRIAL_FIRE = "industrial_fire"
PERSISTENT_INDUSTRIAL = "persistent_industrial"
AGRICULTURAL = "agricultural_burning"
WILDFIRE = "wildfire_natural"
OTHER = "other_unclassified"
CLASSES = [INDUSTRIAL_FIRE, PERSISTENT_INDUSTRIAL, AGRICULTURAL, WILDFIRE, OTHER]

CLASS_LABELS = {
    INDUSTRIAL_FIRE: "Industrial fire",
    PERSISTENT_INDUSTRIAL: "Persistent industrial heat",
    AGRICULTURAL: "Agricultural burning",
    WILDFIRE: "Wildfire / natural",
    OTHER: "Other / unclassified",
}

# ---- Persistence grid -------------------------------------------------------
# ~0.005 deg ~ 555 m. A detection's history is read from its cell and the 8
# neighbours (~1.7 km box) to absorb VIIRS geolocation jitter (375 m pixels).
CELL_DEG = 0.005
HISTORY_DAYS = 365

# temporary / recurring / persistent thresholds (prior 365 days)
PERSISTENT_MIN_ACTIVE_DAYS = 20
PERSISTENT_MIN_ACTIVE_MONTHS = 6   # stubble seasons (Apr-May + Oct-Nov) span only ~4 months
RECURRING_MIN_ACTIVE_DAYS = 3
RECURRING_MIN_ACTIVE_MONTHS = 2

# Spike: current FRP vs the source's own log-FRP history
SPIKE_Z = 3.0
SPIKE_MIN_RATIO = 3.0              # also require FRP >= 3x historical typical FRP
SPIKE_MIN_FRP = 15.0               # and an absolute floor (MW), so small flickers are not "fires"

# ---- Proximity -------------------------------------------------------------
# VIIRS pixel is 375 m at nadir and grows off-nadir; allow ~1 km association.
NEAR_INFRA_M = 1000
# Metric CRS for India-wide distance computations (WGS 84 / India NSF LCC)
METRIC_CRS = "EPSG:7755"

# ---- Land cover (ESA WorldCover codes) ------------------------------------
WORLDCOVER_CLASSES = {
    10: "tree_cover", 20: "shrubland", 30: "grassland", 40: "cropland",
    50: "built_up", 60: "bare_sparse", 70: "snow_ice", 80: "water",
    90: "herbaceous_wetland", 95: "mangroves", 100: "moss_lichen",
}
LANDCOVER_RADIUS_M = 300
WORLDCOVER_URL = ("https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
                  "ESA_WorldCover_10m_2021_v200_{tile}_Map.tif")

# Months in which crop-residue burning is common in India
# (rabi harvest Apr-May, kharif/paddy Oct-Nov; Sept and Dec shoulders)
AGRI_PEAK_MONTHS = {4, 5, 10, 11}
AGRI_SHOULDER_MONTHS = {3, 9, 12}

MODEL_PATH = os.getenv("MODEL_PATH", str(Path(__file__).resolve().parents[1] / "models" / "xgb_model.json"))
