"""
Pluggable Species & Variable Registry for Dusty Earth.
Defines variables, candidates in model NetCDF files, unit conversions,
and WebGL colormap stops for GPU shader rendering.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple, Any
import numpy as np


@dataclass
class ColormapStop:
    value: float  # Normalized 0.0 to 1.0 or physical value
    color: Tuple[int, int, int, int]  # RGBA (0-255)


@dataclass
class VariableConfig:
    id: str
    name: str
    short_name: str
    units: str
    category: str
    candidate_vars: List[str]
    vmin: float
    vmax: float
    log_scale: bool = False
    is_vector: bool = False
    u_candidates: List[str] = field(default_factory=list)
    v_candidates: List[str] = field(default_factory=list)
    colormap_stops: List[ColormapStop] = field(default_factory=list)
    unit_converter: Optional[Callable[[np.ndarray, Dict[str, Any]], np.ndarray]] = None
    description: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "short_name": self.short_name,
            "units": self.units,
            "category": self.category,
            "vmin": self.vmin,
            "vmax": self.vmax,
            "log_scale": self.log_scale,
            "is_vector": self.is_vector,
            "description": self.description,
            "colormap": [
                {"stop": s.value, "color": list(s.color)}
                for s in self.colormap_stops
            ],
        }


# ------------------------------------------------------------------------------
# Unit Converters
# ------------------------------------------------------------------------------

def convert_sconc_dust(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts dust concentration to µg/m³ based on input units."""
    units = str(meta.get("units", "")).lower().strip()
    if units in ("kg m-3", "kg/m3", "kg m^-3"):
        return arr * 1e9
    if units in ("g m-3", "g/m3", "g m^-3"):
        return arr * 1e6
    if units in ("mg m-3", "mg/m3", "mg m^-3"):
        return arr * 1e3
    if units in ("kg kg-1", "kg/kg"):
        # If air density rho is provided in meta (kg/m3), use it; else fallback to standard rho_air ~ 1.2
        rho = meta.get("rho", 1.2)
        return arr * rho * 1e9
    return arr


def convert_dust_load(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts column integrated dust load to mg/m²."""
    units = str(meta.get("units", "")).lower().strip()
    if units in ("kg m-2", "kg/m2", "kg m^-2"):
        return arr * 1e6
    if units in ("g m-2", "g/m2", "g m^-2"):
        return arr * 1e3
    return arr


def convert_temperature_celsius(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts temperature to °C if input is in Kelvin."""
    units = str(meta.get("units", "")).lower().strip()
    if "k" in units or np.nanmean(arr) > 150.0:
        return arr - 273.15
    return arr


def convert_gas_ppbv(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts trace gas mixing ratio to ppbv."""
    units = str(meta.get("units", "")).lower().strip()
    if "ppm" in units:
        return arr * 1000.0
    return arr


# ------------------------------------------------------------------------------
# Built-in Variable Registry
# ------------------------------------------------------------------------------

DEFAULT_REGISTRY: Dict[str, VariableConfig] = {
    "sconc_dust": VariableConfig(
        id="sconc_dust",
        name="Surface Dust Concentration",
        short_name="Surface Dust",
        units="µg/m³",
        category="dust",
        candidate_vars=["sconc_dust", "dust_sfc", "dustc", "PM10", "pm10", "soila"],
        vmin=0.0,
        vmax=1500.0,
        log_scale=False,
        unit_converter=convert_sconc_dust,
        description="Near-surface atmospheric mineral dust particulate concentration (PM10 scale).",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),     # 0: transparent
            ColormapStop(0.02, (254, 240, 217, 70)),    # ~30: faint beige
            ColormapStop(0.07, (253, 212, 158, 140)),   # ~100: light sandy yellow
            ColormapStop(0.17, (253, 160, 90, 200)),    # ~250: warm amber
            ColormapStop(0.33, (240, 95, 40, 230)),     # ~500: strong orange
            ColormapStop(0.53, (200, 35, 25, 245)),     # ~800: intense dust-storm red
            ColormapStop(0.80, (130, 15, 20, 255)),     # ~1200: severe maroon
            ColormapStop(1.00, (65, 0, 15, 255)),       # 1500+: hazardous deep brown
        ],
    ),
    "dust_load": VariableConfig(
        id="dust_load",
        name="Column Integrated Dust Load",
        short_name="Column Dust",
        units="mg/m²",
        category="dust",
        candidate_vars=["dust_load", "tcol_dust", "DUSTLOAD", "dust_column"],
        vmin=0.0,
        vmax=4000.0,
        log_scale=False,
        unit_converter=convert_dust_load,
        description="Total vertically integrated atmospheric dust mass loading per unit surface area.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.03, (254, 237, 222, 60)),
            ColormapStop(0.10, (253, 190, 133, 130)),
            ColormapStop(0.25, (253, 141, 60, 190)),
            ColormapStop(0.50, (230, 85, 13, 230)),
            ColormapStop(0.75, (166, 54, 3, 250)),
            ColormapStop(1.00, (100, 20, 0, 255)),
        ],
    ),
    "dod550": VariableConfig(
        id="dod550",
        name="Dust Optical Depth (550 nm)",
        short_name="AOD 550nm",
        units="dimensionless",
        category="dust",
        candidate_vars=["dod550", "od550_dust", "aod550", "AOD550", "AOD2D_OUT", "EXTCOF55"],
        vmin=0.0,
        vmax=2.5,
        log_scale=False,
        description="Atmospheric aerosol/dust extinction optical thickness at 550 nm.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.04, (220, 245, 233, 80)),
            ColormapStop(0.12, (150, 225, 170, 140)),
            ColormapStop(0.24, (250, 230, 100, 180)),
            ColormapStop(0.40, (245, 140, 40, 220)),
            ColormapStop(0.60, (215, 45, 60, 245)),
            ColormapStop(0.80, (140, 20, 100, 255)),
            ColormapStop(1.00, (80, 0, 90, 255)),
        ],
    ),
    "wind10m": VariableConfig(
        id="wind10m",
        name="10-Meter Wind Field",
        short_name="Wind",
        units="m/s",
        category="meteo",
        candidate_vars=["wind10m", "ws10", "WSPD10"],
        is_vector=True,
        u_candidates=["u10", "U10", "10u"],
        v_candidates=["v10", "V10", "10v"],
        vmin=0.0,
        vmax=25.0,
        description="10-meter wind speed magnitude overlaid with dynamic GPU-accelerated streamlines.",
        colormap_stops=[
            ColormapStop(0.00, (15, 23, 42, 40)),
            ColormapStop(0.12, (30, 64, 175, 100)),
            ColormapStop(0.24, (14, 165, 233, 160)),
            ColormapStop(0.40, (16, 185, 129, 200)),
            ColormapStop(0.60, (234, 179, 8, 230)),
            ColormapStop(0.80, (239, 68, 68, 250)),
            ColormapStop(1.00, (168, 85, 247, 255)),
        ],
    ),
    "t2m": VariableConfig(
        id="t2m",
        name="2-Meter Temperature",
        short_name="Temperature",
        units="°C",
        category="meteo",
        candidate_vars=["t2m", "T2", "2t", "temp2m"],
        vmin=0.0,
        vmax=48.0,
        unit_converter=convert_temperature_celsius,
        description="2-meter surface air temperature.",
        colormap_stops=[
            ColormapStop(0.00, (49, 54, 149, 210)),    # 0°C: deep cold blue
            ColormapStop(0.20, (69, 117, 180, 220)),   # ~10°C: light blue
            ColormapStop(0.40, (171, 217, 233, 230)),  # ~20°C: soft teal
            ColormapStop(0.55, (254, 224, 144, 235)),  # ~26°C: mild yellow
            ColormapStop(0.70, (253, 174, 97, 240)),   # ~33°C: warm orange
            ColormapStop(0.85, (244, 109, 67, 245)),   # ~40°C: intense heat
            ColormapStop(1.00, (165, 0, 38, 255)),     # 48°C: extreme desert heat
        ],
    ),
    "pm25": VariableConfig(
        id="pm25",
        name="Fine Particulates (PM2.5)",
        short_name="PM2.5",
        units="µg/m³",
        category="aerosol",
        candidate_vars=["pm25", "PM2_5_DRY", "PM25", "sconc_pm25"],
        vmin=0.0,
        vmax=250.0,
        unit_converter=convert_sconc_dust,
        description="Near-surface fine atmospheric particulate matter (aerodynamic diameter ≤ 2.5 µm).",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.05, (0, 228, 0, 100)),       # 0-12 (Good, Green)
            ColormapStop(0.14, (255, 255, 0, 160)),     # 12-35 (Moderate, Yellow)
            ColormapStop(0.22, (255, 126, 0, 200)),     # 35-55 (USG, Orange)
            ColormapStop(0.60, (255, 0, 0, 240)),       # 55-150 (Unhealthy, Red)
            ColormapStop(1.00, (126, 0, 35, 255)),      # 150-250 (Hazardous, Maroon)
        ],
    ),
    "o3": VariableConfig(
        id="o3",
        name="Surface Ozone (O₃)",
        short_name="Ozone",
        units="ppbv",
        category="chemistry",
        candidate_vars=["o3", "O3", "sconc_o3"],
        vmin=0.0,
        vmax=120.0,
        unit_converter=convert_gas_ppbv,
        description="Near-surface ozone volume mixing ratio.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.25, (68, 1, 84, 140)),
            ColormapStop(0.45, (59, 82, 139, 180)),
            ColormapStop(0.65, (33, 145, 140, 210)),
            ColormapStop(0.80, (94, 201, 98, 235)),
            ColormapStop(1.00, (253, 231, 37, 255)),
        ],
    ),
    "so2": VariableConfig(
        id="so2",
        name="Sulfur Dioxide (SO₂)",
        short_name="SO₂",
        units="ppbv",
        category="chemistry",
        candidate_vars=["so2", "SO2", "sconc_so2"],
        vmin=0.0,
        vmax=60.0,
        unit_converter=convert_gas_ppbv,
        description="Near-surface sulfur dioxide volume mixing ratio.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.10, (252, 253, 191, 120)),
            ColormapStop(0.30, (251, 136, 97, 180)),
            ColormapStop(0.60, (182, 54, 121, 220)),
            ColormapStop(0.85, (81, 18, 124, 245)),
            ColormapStop(1.00, (0, 0, 4, 255)),
        ],
    ),
}


class VariableRegistry:
    """Manages registered species and meteorological diagnostic variables."""

    def __init__(self, variables: Optional[Dict[str, VariableConfig]] = None):
        self._registry: Dict[str, VariableConfig] = dict(variables or DEFAULT_REGISTRY)

    def register(self, config: VariableConfig) -> None:
        self._registry[config.id] = config

    def get(self, var_id: str) -> Optional[VariableConfig]:
        return self._registry.get(var_id)

    def list_variables(self) -> List[VariableConfig]:
        return list(self._registry.values())

    def match_available(self, dataset_vars: Sequence[str]) -> List[VariableConfig]:
        """Returns list of variables from registry that match data variables present in dataset."""
        var_set = set(dataset_vars)
        matched = []
        for cfg in self._registry.values():
            if any(c in var_set for c in cfg.candidate_vars):
                matched.append(cfg)
            elif cfg.is_vector and any(u in var_set for u in cfg.u_candidates) and any(v in var_set for v in cfg.v_candidates):
                matched.append(cfg)
        return matched
