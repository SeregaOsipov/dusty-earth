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
    if "ug/kg" in units or "ug kg-1" in units:
        rho = meta.get("rho", 1.2)
        return arr * rho
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
    finite_vals = arr[np.isfinite(arr)]
    mean_val = float(np.mean(finite_vals)) if finite_vals.size > 0 else 0.0
    if units == "k" or units.startswith("kelvin") or mean_val > 150.0:
        return arr - 273.15
    return arr


def convert_gas_ppbv(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts trace gas mixing ratio to ppbv."""
    units = str(meta.get("units", "")).lower().strip()
    if "ppm" in units:
        return arr * 1000.0
    return arr


def convert_co2_ppm(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts CO2 mixing ratio (WRF ppmv, CAMS kg/kg, or ppbv) to dry mole fraction in ppm."""
    units = str(meta.get("units", "")).lower().strip()
    if units in ("kg kg-1", "kg/kg"):
        return arr * (28.9644 / 44.0095) * 1.0e6
    if "ppb" in units:
        return arr * 1.0e-3
    if units in ("mol mol-1", "mol/mol"):
        return arr * 1.0e6
    return arr


def convert_ch4_ppbv(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts CH4 mixing ratio (WRF ppmv, CAMS kg/kg, or ppbv) to dry mole fraction in ppbv."""
    units = str(meta.get("units", "")).lower().strip()
    if units in ("kg kg-1", "kg/kg"):
        return arr * (28.9644 / 16.043) * 1.0e9
    if "ppm" in units:
        return arr * 1000.0
    if units in ("mol mol-1", "mol/mol"):
        return arr * 1.0e9
    return arr


def convert_rain_rate_mm_h(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts instantaneous precipitation rate to mm/h."""
    units = str(meta.get("units", "")).lower().strip()
    if units in ("mm/s", "mm s-1", "mm s^-1", "kg m-2 s-1", "kg/m2/s"):
        return np.clip(arr * 3600.0, 0.0, None)
    return np.clip(arr, 0.0, None)


def convert_cloud_pct(arr: np.ndarray, meta: Dict[str, Any]) -> np.ndarray:
    """Converts cloud fraction (0-1) to percentage (0-100%)."""
    units = str(meta.get("units", "")).lower().strip()
    finite_vals = arr[np.isfinite(arr)]
    max_val = float(np.max(finite_vals)) if finite_vals.size > 0 else 0.0
    if "%" not in units and max_val <= 1.05:
        return np.clip(arr * 100.0, 0.0, 100.0)
    return np.clip(arr, 0.0, 100.0)


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
        candidate_vars=["sconc_dust", "soila", "dust_sfc", "dustc", "salsa_s_DU", "salsa_s_DU_xy"],
        vmin=0.0,
        vmax=1500.0,
        log_scale=False,
        unit_converter=convert_sconc_dust,
        description="Near-surface coarse mode soil dust aerosol concentration (soila).",
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
    # Temporarily disabled: AOD2D_OUT is unpopulated in RACM-MADE-SORGAM (chem_opt=108);
    # requires vertical integration of 3D EXTCOF55 over layer thickness dz.
    # "dod550": VariableConfig(
    #     id="dod550",
    #     name="Dust Optical Depth (550 nm)",
    #     short_name="AOD 550nm",
    #     units="dimensionless",
    #     category="dust",
    #     candidate_vars=["dod550", "od550_dust", "aod550", "AOD550", "AOD2D_OUT", "EXTCOF55"],
    #     vmin=0.0,
    #     vmax=2.5,
    #     log_scale=False,
    #     description="Atmospheric aerosol/dust extinction optical thickness at 550 nm.",
    #     colormap_stops=[
    #         ColormapStop(0.00, (255, 255, 255, 0)),
    #         ColormapStop(0.04, (220, 245, 233, 80)),
    #         ColormapStop(0.12, (150, 225, 170, 140)),
    #         ColormapStop(0.24, (250, 230, 100, 180)),
    #         ColormapStop(0.40, (245, 140, 40, 220)),
    #         ColormapStop(0.60, (215, 45, 60, 245)),
    #         ColormapStop(0.80, (140, 20, 100, 255)),
    #         ColormapStop(1.00, (80, 0, 90, 255)),
    #     ],
    # ),
    "pm25": VariableConfig(
        id="pm25",
        name="Fine Particulates (PM2.5)",
        short_name="PM2.5",
        units="µg/m³",
        category="aerosol",
        candidate_vars=["pm25", "PM2_5_DRY", "PM25", "sconc_pm25", "salsa_PM2.5", "salsa_PM2.5_xy"],
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
    "pm10": VariableConfig(
        id="pm10",
        name="Coarse Particulates (PM10)",
        short_name="PM10",
        units="µg/m³",
        category="aerosol",
        candidate_vars=["pm10", "PM10", "sconc_pm10", "salsa_PM10", "kc_PM10", "salsa_PM10_xy", "kc_PM10_xy"],
        vmin=0.0,
        vmax=500.0,
        unit_converter=convert_sconc_dust,
        description="Near-surface coarse atmospheric particulate matter (aerodynamic diameter ≤ 10 µm).",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.10, (0, 228, 0, 100)),       # 0-50 (Good, Green)
            ColormapStop(0.30, (255, 255, 0, 160)),     # 50-150 (Moderate, Yellow)
            ColormapStop(0.50, (255, 126, 0, 200)),     # 150-250 (USG, Orange)
            ColormapStop(0.70, (255, 0, 0, 240)),       # 250-350 (Unhealthy, Red)
            ColormapStop(1.00, (126, 0, 35, 255)),      # 350-500+ (Hazardous, Maroon)
        ],
    ),
    "no2": VariableConfig(
        id="no2",
        name="Nitrogen Dioxide (NO₂)",
        short_name="NO₂",
        units="ppbv",
        category="chemistry",
        candidate_vars=["no2", "NO2", "sconc_no2", "kc_NO2", "kc_NO2_xy"],
        vmin=0.0,
        vmax=80.0,
        unit_converter=convert_gas_ppbv,
        description="Near-surface nitrogen dioxide volume mixing ratio.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.08, (224, 243, 248, 90)),
            ColormapStop(0.20, (116, 173, 209, 150)),
            ColormapStop(0.40, (254, 224, 144, 195)),
            ColormapStop(0.65, (244, 109, 67, 230)),
            ColormapStop(0.85, (165, 0, 38, 250)),
            ColormapStop(1.00, (85, 0, 45, 255)),
        ],
    ),
    "nox": VariableConfig(
        id="nox",
        name="Nitrogen Oxides (NOx = NO + NO₂)",
        short_name="NOx",
        units="ppbv",
        category="chemistry",
        candidate_vars=["nox", "NOx", "no2", "no", "kc_NO2", "kc_NO", "kc_NO2_xy", "kc_NO_xy"],
        vmin=0.0,
        vmax=150.0,
        unit_converter=convert_gas_ppbv,
        description="Near-surface total reactive nitrogen oxides (NO + NO₂) mixing ratio.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.07, (215, 240, 250, 90)),
            ColormapStop(0.20, (100, 180, 220, 150)),
            ColormapStop(0.40, (253, 210, 110, 200)),
            ColormapStop(0.65, (240, 90, 50, 235)),
            ColormapStop(0.85, (160, 10, 40, 250)),
            ColormapStop(1.00, (75, 0, 50, 255)),
        ],
    ),
    "o3": VariableConfig(
        id="o3",
        name="Surface Ozone (O₃)",
        short_name="Ozone",
        units="ppbv",
        category="chemistry",
        candidate_vars=["o3", "O3", "sconc_o3", "kc_O3", "kc_O3_xy"],
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
        candidate_vars=["so2", "SO2", "sconc_so2", "kc_SO2", "kc_SO2_xy"],
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
    "co": VariableConfig(
        id="co",
        name="Carbon Monoxide (CO)",
        short_name="CO",
        units="ppbv",
        category="chemistry",
        candidate_vars=["co", "CO", "sconc_co", "kc_CO", "kc_CO_xy"],
        vmin=0.0,
        vmax=1000.0,
        unit_converter=convert_gas_ppbv,
        description="Near-surface carbon monoxide volume mixing ratio.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.10, (235, 248, 250, 70)),
            ColormapStop(0.25, (140, 210, 190, 140)),
            ColormapStop(0.45, (250, 215, 110, 195)),
            ColormapStop(0.70, (235, 110, 55, 230)),
            ColormapStop(0.90, (165, 20, 45, 250)),
            ColormapStop(1.00, (80, 0, 35, 255)),
        ],
    ),
    "co2": VariableConfig(
        id="co2",
        name="Carbon Dioxide (CO₂)",
        short_name="CO₂",
        units="ppm",
        category="ghg",
        candidate_vars=["co2", "CO2", "sconc_co2", "xco2", "kc_CO2", "kc_CO2_xy"],
        vmin=415.0,
        vmax=465.0,
        unit_converter=convert_co2_ppm,
        description="Near-surface carbon dioxide dry air mole fraction (ppm).",
        colormap_stops=[
            ColormapStop(0.00, (30, 58, 138, 55)),
            ColormapStop(0.16, (14, 165, 233, 105)),
            ColormapStop(0.30, (16, 185, 129, 150)),
            ColormapStop(0.50, (250, 204, 21, 195)),
            ColormapStop(0.72, (249, 115, 22, 230)),
            ColormapStop(0.88, (220, 38, 38, 245)),
            ColormapStop(1.00, (127, 29, 29, 255)),
        ],
    ),
    "ch4": VariableConfig(
        id="ch4",
        name="Methane (CH₄)",
        short_name="CH₄",
        units="ppbv",
        category="ghg",
        candidate_vars=["ch4", "CH4", "ch4_c", "sconc_ch4", "xch4", "kc_CH4", "kc_CH4_xy"],
        vmin=1850.0,
        vmax=2650.0,
        unit_converter=convert_ch4_ppbv,
        description="Near-surface methane dry air mixing ratio (ppbv).",
        colormap_stops=[
            ColormapStop(0.00, (49, 46, 129, 55)),
            ColormapStop(0.18, (6, 182, 212, 110)),
            ColormapStop(0.35, (52, 211, 153, 155)),
            ColormapStop(0.55, (250, 204, 21, 200)),
            ColormapStop(0.78, (249, 115, 22, 235)),
            ColormapStop(1.00, (190, 24, 93, 255)),
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
        u_candidates=["u10", "U10", "10u", "u", "u_xy"],
        v_candidates=["v10", "V10", "10v", "v", "v_xy"],
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
        candidate_vars=["t2m", "T2", "2t", "temp2m", "ta", "ta*_xy", "theta", "tsurf*_xy"],
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
    "precip_rate": VariableConfig(
        id="precip_rate",
        name="Surface Precipitation Rate",
        short_name="Rain Rate",
        units="mm/h",
        category="meteo",
        candidate_vars=["precip_rate", "QRAINXY", "PRATE", "RAINRATE"],
        vmin=0.0,
        vmax=15.0,
        unit_converter=convert_rain_rate_mm_h,
        description="Instantaneous surface liquid precipitation rate.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.02, (186, 230, 253, 110)),   # ~0.3 mm/h: light drizzle
            ColormapStop(0.10, (56, 189, 248, 170)),    # ~1.5 mm/h: light rain
            ColormapStop(0.25, (37, 99, 235, 210)),     # ~3.8 mm/h: moderate rain
            ColormapStop(0.50, (16, 185, 129, 230)),    # ~7.5 mm/h: heavy rain
            ColormapStop(0.75, (245, 158, 11, 245)),    # ~11 mm/h: intense rain
            ColormapStop(1.00, (220, 38, 38, 255)),     # 15+ mm/h: severe downpour
        ],
    ),
    "precip_acc": VariableConfig(
        id="precip_acc",
        name="Accumulated Total Precipitation",
        short_name="Accum. Rain",
        units="mm",
        category="meteo",
        candidate_vars=["precip_acc", "AFWA_TOTPRECIP", "RAINNC", "RAINC"],
        vmin=0.0,
        vmax=50.0,
        description="Total accumulated precipitation (grid-scale + convective) since cycle initialization.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.02, (191, 219, 254, 100)),   # 1 mm
            ColormapStop(0.10, (59, 130, 246, 165)),    # 5 mm
            ColormapStop(0.25, (16, 185, 129, 205)),    # 12.5 mm
            ColormapStop(0.50, (234, 179, 8, 230)),     # 25 mm
            ColormapStop(0.75, (239, 68, 68, 245)),     # 37.5 mm
            ColormapStop(1.00, (147, 51, 234, 255)),    # 50+ mm
        ],
    ),
    "cldfra": VariableConfig(
        id="cldfra",
        name="Total Cloud Cover",
        short_name="Cloud Cover",
        units="%",
        category="meteo",
        candidate_vars=["cldfra", "CLDFRA", "TCC", "tcc", "cloud_cover"],
        vmin=0.0,
        vmax=100.0,
        unit_converter=convert_cloud_pct,
        description="Maximum column cloud fraction across atmospheric model levels.",
        colormap_stops=[
            ColormapStop(0.00, (255, 255, 255, 0)),
            ColormapStop(0.15, (148, 163, 184, 65)),
            ColormapStop(0.40, (203, 213, 225, 130)),
            ColormapStop(0.70, (226, 232, 240, 195)),
            ColormapStop(1.00, (248, 250, 252, 240)),
        ],
    ),
    "swdown": VariableConfig(
        id="swdown",
        name="Surface Downward Shortwave (GHI)",
        short_name="Solar GHI",
        units="W/m²",
        category="solar",
        candidate_vars=["SWDOWN", "SWDNB", "swdown", "ssrd", "rad_sw_in*_xy", "rad_sw_in"],
        vmin=0.0,
        vmax=1000.0,
        description="Downward global horizontal shortwave solar irradiance at the ground surface.",
        colormap_stops=[
            ColormapStop(0.00, (15, 23, 42, 0)),        # Night / 0 W/m²
            ColormapStop(0.10, (49, 46, 129, 110)),     # ~100 W/m²: dawn/dusk
            ColormapStop(0.30, (14, 165, 233, 165)),    # ~300 W/m²: low sun / cloudy
            ColormapStop(0.55, (250, 204, 21, 205)),    # ~550 W/m²: moderate solar
            ColormapStop(0.80, (249, 115, 22, 235)),    # ~800 W/m²: strong solar
            ColormapStop(1.00, (254, 240, 138, 255)),   # 1000 W/m²: peak desert irradiance
        ],
    ),
    "swnet": VariableConfig(
        id="swnet",
        name="Surface Net Shortwave Radiation",
        short_name="Net Solar SW",
        units="W/m²",
        category="solar",
        candidate_vars=["swnet", "SWNET", "FSA", "SWDNB", "rad_net*_xy", "rad_net"],
        vmin=0.0,
        vmax=850.0,
        description="Net shortwave solar radiation absorbed at the surface (SW↓ − SW↑).",
        colormap_stops=[
            ColormapStop(0.00, (15, 23, 42, 0)),
            ColormapStop(0.12, (67, 56, 202, 115)),
            ColormapStop(0.35, (6, 182, 212, 170)),
            ColormapStop(0.60, (234, 179, 8, 210)),
            ColormapStop(0.85, (239, 68, 68, 240)),
            ColormapStop(1.00, (254, 249, 195, 255)),
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
