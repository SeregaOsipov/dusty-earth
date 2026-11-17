"""
Grid and coordinate extraction engine for Dusty Earth.
Handles regular lat-lon NetCDF outputs (ICON-ART, CAMS), curvilinear WRF-Chem grids,
and metric microscale PALM-4U urban LES outputs (100 m / 10 m / 1 m).
Standardizes grids to contiguous Float32 arrays in regular WGS84 North-to-South / West-to-East
layout while preserving NaN building masks and domain boundaries.
"""

from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from scipy.spatial import cKDTree
import xarray as xr

from .registry import VariableConfig


_REGRID_CACHE_STORE: Dict[Tuple[Any, ...], "RegridCache"] = {}


@dataclass
class GridMetadata:
    """Complete spatial bounding box and resolution metadata."""
    nx: int
    ny: int
    lon_min: float
    lon_max: float
    lat_min: float
    lat_max: float
    dx: float
    dy: float
    dx_m: float = 0.0
    dy_m: float = 0.0
    polygon: Optional[List[List[float]]] = None
    canvas_quad: Optional[List[List[float]]] = None  # [NW, NE, SE, SW] for MapLibre CanvasSource
    has_nan_mask: bool = False
    lat_orientation: str = "north_to_south"  # row 0 is lat_max (North)
    lon_orientation: str = "west_to_east"    # col 0 is lon_min (West)

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "nx": self.nx,
            "ny": self.ny,
            "lon_min": round(self.lon_min, 7),
            "lon_max": round(self.lon_max, 7),
            "lat_min": round(self.lat_min, 7),
            "lat_max": round(self.lat_max, 7),
            "dx": round(self.dx, 8),
            "dy": round(self.dy, 8),
            "dx_m": round(self.dx_m, 2),
            "dy_m": round(self.dy_m, 2),
            "has_nan_mask": self.has_nan_mask,
            "lat_orientation": self.lat_orientation,
            "lon_orientation": self.lon_orientation,
        }
        if self.polygon:
            payload["polygon"] = [[round(pt[0], 7), round(pt[1], 7)] for pt in self.polygon]
        if self.canvas_quad:
            payload["canvas_quad"] = [[round(pt[0], 7), round(pt[1], 7)] for pt in self.canvas_quad]
        return payload


@dataclass
class ExtractedField:
    """Contains extracted 2D Float32 grid(s) and metadata."""
    scalar: np.ndarray  # Shape (ny, nx), dtype=float32 (NaN preserved outside domain / inside buildings)
    u: Optional[np.ndarray] = None  # Shape (ny, nx), dtype=float32 (for vector fields)
    v: Optional[np.ndarray] = None  # Shape (ny, nx), dtype=float32 (for vector fields)
    min_val: float = 0.0
    max_val: float = 0.0
    mean_val: float = 0.0
    has_nans: bool = False


class RegridCache:
    """Reusable KDTree IDW regridder from 2D curvilinear (lat, lon) onto regular WGS84 grid."""

    def __init__(
        self,
        lon_2d: np.ndarray,
        lat_2d: np.ndarray,
        target_lon_1d: np.ndarray,
        target_lat_1d: np.ndarray,
    ):
        self.nx = int(len(target_lon_1d))
        self.ny = int(len(target_lat_1d))
        self.n_tgt = self.nx * self.ny

        lat_mean = float(0.5 * (np.nanmin(lat_2d) + np.nanmax(lat_2d)))
        cos_lat = max(0.1, float(np.cos(np.deg2rad(lat_mean))))

        src_pts = np.column_stack([
            lon_2d.astype(np.float64).ravel() * cos_lat,
            lat_2d.astype(np.float64).ravel(),
        ])
        tgt_lon2d, tgt_lat2d = np.meshgrid(target_lon_1d, target_lat_1d)
        tgt_pts = np.column_stack([
            tgt_lon2d.astype(np.float64).ravel() * cos_lat,
            tgt_lat2d.astype(np.float64).ravel(),
        ])

        tree = cKDTree(src_pts)
        k = min(4, len(src_pts))
        dists, indices = tree.query(tgt_pts, k=k)
        if k == 1:
            dists = dists[:, None]
            indices = indices[:, None]

        self.indices = indices
        self.weights = 1.0 / (np.maximum(dists, 1e-12) ** 2)

        dx_deg = abs(float(target_lon_1d[1] - target_lon_1d[0])) if self.nx > 1 else 0.01
        dy_deg = abs(float(target_lat_1d[1] - target_lat_1d[0])) if self.ny > 1 else 0.01
        cell_diag = float(np.hypot(dx_deg * cos_lat, dy_deg))
        self.outside_mask = dists[:, 0] > 1.35 * cell_diag

    def regrid(self, arr_2d: np.ndarray) -> np.ndarray:
        """Remap 2D field onto North-to-South / West-to-East grid while keeping NaN masks sharp."""
        flat = np.asarray(arr_2d, dtype=np.float64).ravel()
        vals = flat[self.indices]
        finite = np.isfinite(vals)
        center_nan = ~finite[:, 0]

        w = np.where(finite, self.weights, 0.0)
        w_sum = np.sum(w, axis=1)
        valid = (~self.outside_mask) & (~center_nan) & (w_sum > 0.0)

        out = np.full(self.n_tgt, np.nan, dtype=np.float32)
        if np.any(valid):
            num = np.sum(np.where(finite[valid], vals[valid] * w[valid], 0.0), axis=1)
            out[valid] = (num / w_sum[valid]).astype(np.float32)
        return out.reshape(self.ny, self.nx)


def _metric_deg_factors(origin_lat: float) -> Tuple[float, float]:
    """Return (meters_per_deg_lat, meters_per_deg_lon) on WGS84 ellipsoid at origin_lat."""
    phi = np.deg2rad(float(origin_lat))
    m_lat = 111132.92 - 559.82 * np.cos(2.0 * phi) + 1.175 * np.cos(4.0 * phi)
    m_lon = 111412.84 * np.cos(phi) - 93.5 * np.cos(3.0 * phi)
    return float(m_lat), max(1000.0, float(m_lon))


def _resolve_2d_or_1d_coords(
    ds: xr.Dataset,
    static_ds: Optional[xr.Dataset] = None,
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], bool]:
    """
    Resolve raw coordinate arrays from ds (or static_ds for PALM).
    Returns (lat_arr, lon_arr, is_metric_palm).
    """
    lat_name = next((c for c in ("lat", "latitude", "LAT", "nav_lat", "XLAT") if c in ds.coords or c in ds), None)
    lon_name = next((c for c in ("lon", "longitude", "LON", "nav_lon", "XLONG") if c in ds.coords or c in ds), None)

    if lat_name and lon_name:
        lat_raw = np.asarray(ds[lat_name].values, dtype=np.float64)
        lon_raw = np.asarray(ds[lon_name].values, dtype=np.float64)
        if lat_raw.ndim >= 3:
            lat_raw = lat_raw[0]
            lon_raw = lon_raw[0]
        return lat_raw, lon_raw, False

    if static_ds is not None and "lat" in static_ds and "lon" in static_ds:
        s_lat = np.asarray(static_ds["lat"].values, dtype=np.float64)
        s_lon = np.asarray(static_ds["lon"].values, dtype=np.float64)
        ny_ds = ds.sizes.get("y")
        nx_ds = ds.sizes.get("x")
        if s_lat.ndim == 2 and ny_ds == s_lat.shape[0] and nx_ds == s_lat.shape[1]:
            return s_lat, s_lon, True

    return None, None, ("origin_lat" in ds.attrs and "origin_lon" in ds.attrs and "x" in ds and "y" in ds)


def _extract_crs_and_origin(ds: xr.Dataset, static_ds: Optional[xr.Dataset] = None) -> Dict[str, Any]:
    """Resolve CRS definition, projected/geographic origin, and rotation_angle from static_ds/ds."""
    info: Dict[str, Any] = {
        "crs_def": None,
        "origin_x": None,
        "origin_y": None,
        "origin_lon": None,
        "origin_lat": None,
        "rotation_angle": 0.0,
    }
    for src in (static_ds, ds):
        if src is None:
            continue
        if info["crs_def"] is None and "crs" in src:
            cvar = src["crs"]
            for attr_name in ("epsg_code", "crs_wkt", "spatial_ref"):
                val = cvar.attrs.get(attr_name)
                if val:
                    info["crs_def"] = str(val)
                    break
        for k in ("origin_x", "origin_y", "origin_lon", "origin_lat"):
            if info[k] is None and k in src.attrs:
                try:
                    info[k] = float(src.attrs[k])
                except Exception:
                    pass
        if info["rotation_angle"] == 0.0 and "rotation_angle" in src.attrs:
            try:
                info["rotation_angle"] = float(src.attrs["rotation_angle"] or 0.0)
            except Exception:
                pass
    return info


def build_palm_local_to_lonlat(ds: Any, static_ds: Optional[Any] = None):
    """
    Build a vectorized mapper local_to_lonlat(x_m, y_m) -> (lon, lat) and outer grid
    bounds for a rectilinear PALM-4U Cartesian grid in meters.
    Works identically with xarray Datasets or netCDF4 Datasets (static_ds optional).
    """
    x_arr = np.asarray(ds["x"][:], dtype=np.float64)
    y_arr = np.asarray(ds["y"][:], dtype=np.float64)
    nx = int(len(x_arr))
    ny = int(len(y_arr))
    dx_m = float(np.median(np.abs(np.diff(x_arr)))) if nx > 1 else float(getattr(ds, "dx", 10.0) or 10.0)
    dy_m = float(np.median(np.abs(np.diff(y_arr)))) if ny > 1 else float(getattr(ds, "dy", 10.0) or 10.0)
    x0 = float(np.min(x_arr)) - 0.5 * dx_m
    x1 = float(np.max(x_arr)) + 0.5 * dx_m
    y0 = float(np.min(y_arr)) - 0.5 * dy_m
    y1 = float(np.max(y_arr)) + 0.5 * dy_m

    def _get_attr(obj, name):
        if hasattr(obj, "attrs") and name in obj.attrs:
            return obj.attrs[name]
        if hasattr(obj, "ncattrs") and name in obj.ncattrs():
            return getattr(obj, name)
        return None

    def _get_var(obj, name):
        if obj is None:
            return None
        try:
            return obj[name] if name in obj.variables else None
        except Exception:
            return None

    crs_def = None
    origin_x = origin_y = origin_lon = origin_lat = None
    rotation_deg = 0.0
    for src in (static_ds, ds):
        if src is None:
            continue
        cvar = _get_var(src, "crs")
        if crs_def is None and cvar is not None:
            for attr_name in ("epsg_code", "crs_wkt", "spatial_ref"):
                val = _get_attr(cvar, attr_name)
                if val:
                    crs_def = str(val)
                    break
        if origin_x is None and _get_attr(src, "origin_x") is not None:
            origin_x = float(_get_attr(src, "origin_x"))
        if origin_y is None and _get_attr(src, "origin_y") is not None:
            origin_y = float(_get_attr(src, "origin_y"))
        if origin_lon is None and _get_attr(src, "origin_lon") is not None:
            origin_lon = float(_get_attr(src, "origin_lon"))
        if origin_lat is None and _get_attr(src, "origin_lat") is not None:
            origin_lat = float(_get_attr(src, "origin_lat"))
        if rotation_deg == 0.0 and _get_attr(src, "rotation_angle") is not None:
            rotation_deg = float(_get_attr(src, "rotation_angle") or 0.0)

    rot = np.deg2rad(rotation_deg)
    cos_r, sin_r = float(np.cos(rot)), float(np.sin(rot))

    if crs_def is not None and origin_x is not None and origin_y is not None:
        from pyproj import Transformer
        transformer = Transformer.from_crs(crs_def, "EPSG:4326", always_xy=True)

        def mapper(x_loc, y_loc):
            xa = np.asarray(x_loc, dtype=np.float64)
            ya = np.asarray(y_loc, dtype=np.float64)
            easting = origin_x + xa * cos_r + ya * sin_r
            northing = origin_y - xa * sin_r + ya * cos_r
            return transformer.transform(easting, northing)

        return mapper, (x0, x1, y0, y1, nx, ny, dx_m, dy_m, rotation_deg)

    # Case B: 2D lat/lon on static_ds (or ds) without projected origin/crs
    for src in (static_ds, ds):
        lat_v = _get_var(src, "lat")
        lon_v = _get_var(src, "lon")
        if lat_v is not None and lon_v is not None and np.ndim(lat_v) == 2:
            s_lat = np.asarray(lat_v[:], dtype=np.float64)
            s_lon = np.asarray(lon_v[:], dtype=np.float64)
            if s_lat.shape == (ny, nx):
                # Extrapolate cell centers by half cell at each corner to outer edges
                sw_lon = s_lon[0, 0] - 0.5 * (s_lon[0, min(1, nx - 1)] - s_lon[0, 0]) - 0.5 * (s_lon[min(1, ny - 1), 0] - s_lon[0, 0])
                sw_lat = s_lat[0, 0] - 0.5 * (s_lat[0, min(1, nx - 1)] - s_lat[0, 0]) - 0.5 * (s_lat[min(1, ny - 1), 0] - s_lat[0, 0])
                se_lon = s_lon[0, -1] + 0.5 * (s_lon[0, -1] - s_lon[0, max(0, nx - 2)]) - 0.5 * (s_lon[min(1, ny - 1), -1] - s_lon[0, -1])
                se_lat = s_lat[0, -1] + 0.5 * (s_lat[0, -1] - s_lat[0, max(0, nx - 2)]) - 0.5 * (s_lat[min(1, ny - 1), -1] - s_lat[0, -1])
                ne_lon = s_lon[-1, -1] + 0.5 * (s_lon[-1, -1] - s_lon[-1, max(0, nx - 2)]) + 0.5 * (s_lon[-1, -1] - s_lon[max(0, ny - 2), -1])
                ne_lat = s_lat[-1, -1] + 0.5 * (s_lat[-1, -1] - s_lat[-1, max(0, nx - 2)]) + 0.5 * (s_lat[-1, -1] - s_lat[max(0, ny - 2), -1])
                nw_lon = s_lon[-1, 0] - 0.5 * (s_lon[-1, min(1, nx - 1)] - s_lon[-1, 0]) + 0.5 * (s_lon[-1, 0] - s_lon[max(0, ny - 2), 0])
                nw_lat = s_lat[-1, 0] - 0.5 * (s_lat[-1, min(1, nx - 1)] - s_lat[-1, 0]) + 0.5 * (s_lat[-1, 0] - s_lat[max(0, ny - 2), 0])

                def mapper(x_loc, y_loc):
                    u = (np.asarray(x_loc, dtype=np.float64) - x0) / max(1e-9, x1 - x0)
                    v = (np.asarray(y_loc, dtype=np.float64) - y0) / max(1e-9, y1 - y0)
                    lon_o = (1 - u) * (1 - v) * sw_lon + u * (1 - v) * se_lon + u * v * ne_lon + (1 - u) * v * nw_lon
                    lat_o = (1 - u) * (1 - v) * sw_lat + u * (1 - v) * se_lat + u * v * ne_lat + (1 - u) * v * nw_lat
                    return lon_o, lat_o

                return mapper, (x0, x1, y0, y1, nx, ny, dx_m, dy_m, rotation_deg)

    # Case C: Ellipsoidal metric offset from origin_lon / origin_lat
    if origin_lon is None or origin_lat is None:
        raise ValueError("PALM dataset lacks CRS/origin_x/y, 2D lat/lon, and origin_lat/origin_lon")
    m_lat, m_lon = _metric_deg_factors(origin_lat)

    def mapper(x_loc, y_loc):
        xa = np.asarray(x_loc, dtype=np.float64)
        ya = np.asarray(y_loc, dtype=np.float64)
        dx_geo = xa * cos_r + ya * sin_r
        dy_geo = -xa * sin_r + ya * cos_r
        return origin_lon + dx_geo / m_lon, origin_lat + dy_geo / m_lat

    return mapper, (x0, x1, y0, y1, nx, ny, dx_m, dy_m, rotation_deg)


def _compute_palm_quad_and_bounds(
    ds: xr.Dataset,
    static_ds: Optional[xr.Dataset] = None,
) -> Optional[Tuple[np.ndarray, np.ndarray, GridMetadata]]:
    """Georeference rectilinear PALM-4U grids using exact 4 outer corners (no IDW blurring)."""
    if "x" not in ds or "y" not in ds:
        return None
    if ds["x"].ndim != 1 or ds["y"].ndim != 1:
        return None
    has_palm_ref = (
        static_ds is not None
        or ("origin_lat" in ds.attrs and "origin_lon" in ds.attrs)
        or ("origin_x" in ds.attrs and "origin_y" in ds.attrs)
    )
    if not has_palm_ref:
        return None

    mapper, (x0, x1, y0, y1, nx, ny, dx_m, dy_m, _rot) = build_palm_local_to_lonlat(ds, static_ds=static_ds)
    lons_c, lats_c = mapper([x0, x1, x1, x0], [y0, y0, y1, y1])
    sw = [float(lons_c[0]), float(lats_c[0])]
    se = [float(lons_c[1]), float(lats_c[1])]
    ne = [float(lons_c[2]), float(lats_c[2])]
    nw = [float(lons_c[3]), float(lats_c[3])]

    all_lons = [sw[0], se[0], ne[0], nw[0]]
    all_lats = [sw[1], se[1], ne[1], nw[1]]
    lon_min, lon_max = min(all_lons), max(all_lons)
    lat_min, lat_max = min(all_lats), max(all_lats)
    dx = float((lon_max - lon_min) / max(1, nx))
    dy = float((lat_max - lat_min) / max(1, ny))

    lat_desc = np.linspace(lat_max - 0.5 * dy, lat_min + 0.5 * dy, ny, dtype=np.float64)
    lon_asc = np.linspace(lon_min + 0.5 * dx, lon_max - 0.5 * dx, nx, dtype=np.float64)

    grid = GridMetadata(
        nx=nx,
        ny=ny,
        lon_min=lon_min,
        lon_max=lon_max,
        lat_min=lat_min,
        lat_max=lat_max,
        dx=dx,
        dy=dy,
        dx_m=dx_m,
        dy_m=dy_m,
        polygon=[sw, se, ne, nw, sw],
        canvas_quad=[nw, ne, se, sw],
        has_nan_mask=True,
        lat_orientation="north_to_south",
        lon_orientation="west_to_east",
    )
    return lat_desc, lon_asc, grid


def _compute_grid_and_cache(
    ds: xr.Dataset,
    static_ds: Optional[xr.Dataset] = None,
) -> Tuple[np.ndarray, np.ndarray, GridMetadata, Optional[RegridCache]]:
    """Extract standardized (lat_1d, lon_1d, GridMetadata) and optional RegridCache."""
    palm_geo = _compute_palm_quad_and_bounds(ds, static_ds=static_ds)
    if palm_geo is not None:
        lat_desc, lon_asc, grid = palm_geo
        return lat_desc, lon_asc, grid, None

    lat_raw, lon_raw, is_metric_palm = _resolve_2d_or_1d_coords(ds, static_ds=static_ds)
    dx_m_attr = float(ds.attrs.get("DX", 0.0) or 0.0)
    dy_m_attr = float(ds.attrs.get("DY", 0.0) or 0.0)

    if lat_raw is not None and lon_raw is not None and lat_raw.ndim == 2:
        ny, nx = lat_raw.shape
        lat_min = float(np.nanmin(lat_raw))
        lat_max = float(np.nanmax(lat_raw))
        lon_min = float(np.nanmin(lon_raw))
        lon_max = float(np.nanmax(lon_raw))

        lat_1d = np.linspace(lat_max, lat_min, ny, dtype=np.float64)
        lon_1d = np.linspace(lon_min, lon_max, nx, dtype=np.float64)
        dx = float((lon_max - lon_min) / max(1, nx - 1))
        dy = float((lat_max - lat_min) / max(1, ny - 1))

        if dx_m_attr > 0 and dy_m_attr > 0:
            dx_m, dy_m = dx_m_attr, dy_m_attr
        elif is_metric_palm and "x" in ds and "y" in ds and ds.sizes["x"] > 1 and ds.sizes["y"] > 1:
            dx_m = float(np.median(np.abs(np.diff(np.asarray(ds["x"].values, dtype=np.float64)))))
            dy_m = float(np.median(np.abs(np.diff(np.asarray(ds["y"].values, dtype=np.float64)))))
        else:
            m_lat, m_lon = _metric_deg_factors(0.5 * (lat_min + lat_max))
            if nx > 1 and ny > 1:
                dx_m = float(np.hypot((lon_raw[0, 1] - lon_raw[0, 0]) * m_lon, (lat_raw[0, 1] - lat_raw[0, 0]) * m_lat))
                dy_m = float(np.hypot((lon_raw[1, 0] - lon_raw[0, 0]) * m_lon, (lat_raw[1, 0] - lat_raw[0, 0]) * m_lat))
            else:
                dx_m, dy_m = dx * m_lon, dy * m_lat

        polygon = [
            [float(lon_raw[0, 0]), float(lat_raw[0, 0])],
            [float(lon_raw[0, -1]), float(lat_raw[0, -1])],
            [float(lon_raw[-1, -1]), float(lat_raw[-1, -1])],
            [float(lon_raw[-1, 0]), float(lat_raw[-1, 0])],
            [float(lon_raw[0, 0]), float(lat_raw[0, 0])],
        ]

        cache_key = (
            ny,
            nx,
            round(lon_min, 6),
            round(lon_max, 6),
            round(lat_min, 6),
            round(lat_max, 6),
            round(float(lon_raw[0, 0]), 6),
            round(float(lat_raw[-1, -1]), 6),
        )
        regrid_cache = _REGRID_CACHE_STORE.get(cache_key)
        if regrid_cache is None:
            regrid_cache = RegridCache(lon_raw, lat_raw, lon_1d, lat_1d)
            _REGRID_CACHE_STORE[cache_key] = regrid_cache

        canvas_quad = [
            [lon_min - 0.5 * dx, lat_max + 0.5 * dy],
            [lon_max + 0.5 * dx, lat_max + 0.5 * dy],
            [lon_max + 0.5 * dx, lat_min - 0.5 * dy],
            [lon_min - 0.5 * dx, lat_min - 0.5 * dy],
        ]
        grid = GridMetadata(
            nx=nx,
            ny=ny,
            lon_min=lon_min,
            lon_max=lon_max,
            lat_min=lat_min,
            lat_max=lat_max,
            dx=dx,
            dy=dy,
            dx_m=dx_m,
            dy_m=dy_m,
            polygon=polygon,
            canvas_quad=canvas_quad,
            has_nan_mask=True,
            lat_orientation="north_to_south",
            lon_orientation="west_to_east",
        )
        return lat_1d, lon_1d, grid, regrid_cache

    if lat_raw is not None and lon_raw is not None:
        lat_1d = np.asarray(lat_raw, dtype=np.float64)
        lon_1d = np.asarray(lon_raw, dtype=np.float64)
        if lon_1d[0] > lon_1d[-1]:
            lon_1d = lon_1d[::-1]
        if lat_1d[0] < lat_1d[-1]:
            lat_1d = lat_1d[::-1]
        nx = len(lon_1d)
        ny = len(lat_1d)
        lon_min, lon_max = float(np.nanmin(lon_1d)), float(np.nanmax(lon_1d))
        lat_min, lat_max = float(np.nanmin(lat_1d)), float(np.nanmax(lat_1d))
        dx = float((lon_max - lon_min) / max(1, nx - 1))
        dy = float((lat_max - lat_min) / max(1, ny - 1))
        m_lat, m_lon = _metric_deg_factors(0.5 * (lat_min + lat_max))
        dx_m = dx_m_attr if dx_m_attr > 0 else dx * m_lon
        dy_m = dy_m_attr if dy_m_attr > 0 else dy * m_lat
        canvas_quad = [
            [lon_min - 0.5 * dx, lat_max + 0.5 * dy],
            [lon_max + 0.5 * dx, lat_max + 0.5 * dy],
            [lon_max + 0.5 * dx, lat_min - 0.5 * dy],
            [lon_min - 0.5 * dx, lat_min - 0.5 * dy],
        ]
        grid = GridMetadata(
            nx=nx,
            ny=ny,
            lon_min=lon_min,
            lon_max=lon_max,
            lat_min=lat_min,
            lat_max=lat_max,
            dx=dx,
            dy=dy,
            dx_m=dx_m,
            dy_m=dy_m,
            polygon=[
                [lon_min, lat_min],
                [lon_max, lat_min],
                [lon_max, lat_max],
                [lon_min, lat_max],
                [lon_min, lat_min],
            ],
            canvas_quad=canvas_quad,
            has_nan_mask=False,
        )
        return lat_1d, lon_1d, grid, None

    if "x" in ds and "y" in ds and "origin_lat" in ds.attrs and "origin_lon" in ds.attrs:
        x_arr = np.asarray(ds["x"].values, dtype=np.float64)
        y_arr = np.asarray(ds["y"].values, dtype=np.float64)
        origin_lat = float(ds.attrs["origin_lat"])
        origin_lon = float(ds.attrs["origin_lon"])
        m_lat, m_lon = _metric_deg_factors(origin_lat)

        lon_asc = np.sort(origin_lon + x_arr / m_lon)
        lat_desc = np.sort(origin_lat + y_arr / m_lat)[::-1]
        nx = len(lon_asc)
        ny = len(lat_desc)
        lon_min, lon_max = float(lon_asc[0]), float(lon_asc[-1])
        lat_min, lat_max = float(lat_desc[-1]), float(lat_desc[0])
        dx = float((lon_max - lon_min) / max(1, nx - 1))
        dy = float((lat_max - lat_min) / max(1, ny - 1))
        dx_m = float(np.median(np.abs(np.diff(x_arr)))) if len(x_arr) > 1 else dx * m_lon
        dy_m = float(np.median(np.abs(np.diff(y_arr)))) if len(y_arr) > 1 else dy * m_lat

        grid = GridMetadata(
            nx=nx,
            ny=ny,
            lon_min=lon_min,
            lon_max=lon_max,
            lat_min=lat_min,
            lat_max=lat_max,
            dx=dx,
            dy=dy,
            dx_m=dx_m,
            dy_m=dy_m,
            polygon=[
                [lon_min, lat_min],
                [lon_max, lat_min],
                [lon_max, lat_max],
                [lon_min, lat_max],
                [lon_min, lat_min],
            ],
            has_nan_mask=True,
        )
        return lat_desc, lon_asc, grid, None

    raise ValueError(f"Could not identify spatial coordinates in dataset. Coords: {list(ds.coords)}, Dims: {list(ds.dims)}")


def extract_coordinates(
    ds: xr.Dataset,
    static_ds: Optional[xr.Dataset] = None,
) -> Tuple[np.ndarray, np.ndarray, GridMetadata]:
    """
    Extracts 1D latitude and longitude arrays and builds GridMetadata.
    Guarantees lons are sorted ascending (West to East) and
    lats are sorted descending (North to South, row 0 is top).
    """
    lat_1d, lon_1d, grid, _ = _compute_grid_and_cache(ds, static_ds=static_ds)
    return lat_1d, lon_1d, grid


def get_regrid_cache(
    ds: xr.Dataset,
    static_ds: Optional[xr.Dataset] = None,
) -> Optional[RegridCache]:
    """Return a reusable RegridCache if the dataset uses curvilinear 2D coordinates."""
    _, _, _, cache = _compute_grid_and_cache(ds, static_ds=static_ds)
    return cache


def extract_timestamps(ds: xr.Dataset, fallback_start: datetime, file_index: int = 0) -> List[datetime]:
    """Extracts UTC valid datetimes for each time slice in WRF, PALM-4U, or generic NetCDF files."""
    if "Times" in ds:
        raw_times = ds["Times"].values
        out = []
        for rt in raw_times:
            if isinstance(rt, np.ndarray):
                s = (
                    b"".join(
                        x if isinstance(x, (bytes, np.bytes_)) else bytes(x)
                        for x in rt.ravel()
                    )
                    .decode("utf-8", errors="ignore")
                    .strip()
                    .replace("_", " ")
                )
            elif isinstance(rt, (bytes, np.bytes_)):
                s = rt.decode("utf-8", errors="ignore").strip().replace("_", " ")
            else:
                s = str(rt).strip().replace("_", " ")
            try:
                dt_obj = datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            except ValueError:
                dt_obj = fallback_start
            out.append(dt_obj)
        return out

    for tname in ("time", "valid_time", "Time"):
        if tname in ds.coords or tname in ds or tname in ds.variables:
            tvar = ds[tname]
            vals = tvar.values
            if np.ndim(vals) == 0:
                vals = [vals]

            units_str = str(tvar.attrs.get("units", ""))
            m_units = re.search(
                r"(seconds?|minutes?|hours?|days?)\s+since\s+(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?",
                units_str,
                re.IGNORECASE,
            )
            ref_dt: Optional[datetime] = None
            unit_scale = 1.0
            if m_units:
                unit_word = m_units.group(1).lower()
                time_part = m_units.group(3) or "00:00:00"
                if len(time_part) == 5:
                    time_part = f"{time_part}:00"
                ref_dt = datetime.strptime(f"{m_units.group(2)} {time_part}", "%Y-%m-%d %H:%M:%S").replace(
                    tzinfo=timezone.utc
                )
                if unit_word.startswith("minute"):
                    unit_scale = 60.0
                elif unit_word.startswith("hour"):
                    unit_scale = 3600.0
                elif unit_word.startswith("day"):
                    unit_scale = 86400.0
            elif "origin_time" in ds.attrs:
                m_orig = re.search(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})", str(ds.attrs["origin_time"]))
                if m_orig:
                    ref_dt = datetime.strptime(f"{m_orig.group(1)} {m_orig.group(2)}", "%Y-%m-%d %H:%M:%S").replace(
                        tzinfo=timezone.utc
                    )

            out = []
            for v in vals:
                if isinstance(v, np.datetime64):
                    ts_sec = float(v.astype("datetime64[s]").astype(np.int64))
                    out.append(datetime.fromtimestamp(ts_sec, tz=timezone.utc))
                elif isinstance(v, datetime):
                    out.append(v if v.tzinfo else v.replace(tzinfo=timezone.utc))
                elif isinstance(v, (int, float, np.number)) and ref_dt is not None:
                    out.append(ref_dt + timedelta(seconds=float(v) * unit_scale))
                elif hasattr(v, "year") and hasattr(v, "month") and hasattr(v, "day"):
                    out.append(datetime(v.year, v.month, v.day, v.hour, v.minute, v.second, tzinfo=timezone.utc))
                else:
                    out.append(fallback_start)
            return out

    return [fallback_start]


def _slice_to_2d(da: xr.DataArray, time_idx: Optional[int] = None) -> np.ndarray:
    """Extracts a 2D surface slice (y/lat, x/lon) from a DataArray of arbitrary dimensions."""
    if time_idx is not None:
        for tdim in ("time", "Time", "valid_time"):
            if tdim in da.dims:
                da = da.isel({tdim: time_idx})
                break

    for zdim in (
        "bottom_top",
        "ku_above_surf",
        "kw_above_surf",
        "zu_xy",
        "zu1_xy",
        "zw_xy",
        "zs_xy",
        "zu_3d",
        "zw_3d",
        "zs_3d",
        "zpc_3d",
        "lev",
        "level",
        "height",
        "hybrid",
        "z",
    ):
        if zdim in da.dims:
            if zdim in ("bottom_top", "ku_above_surf", "kw_above_surf", "zu_xy", "zu1_xy", "zw_xy", "zs_xy", "zu_3d", "zw_3d", "zs_3d", "zpc_3d"):
                da = da.isel({zdim: 0})
            else:
                da = da.isel({zdim: -1 if zdim in ("height", "hybrid") else 0})

    arr = np.asarray(da.values, dtype=np.float32)
    arr = np.squeeze(arr)
    if arr.ndim != 2:
        raise ValueError(f"Expected 2D field after slicing, got shape {arr.shape} for dims {da.dims}")
    return arr


def _orient_array(
    arr: np.ndarray,
    ds: xr.Dataset,
    regrid_cache: Optional[RegridCache],
) -> np.ndarray:
    """Align raw 2D array to North-to-South / West-to-East regular WGS84 layout."""
    if regrid_cache is not None:
        return regrid_cache.regrid(arr)

    lat_name = next((c for c in ("lat", "latitude", "LAT", "nav_lat", "XLAT") if c in ds.coords or c in ds), None)
    lon_name = next((c for c in ("lon", "longitude", "LON", "nav_lon", "XLONG") if c in ds.coords or c in ds), None)

    out = arr
    if lat_name:
        raw_lats = ds[lat_name].values
        lats_2d = raw_lats[0] if raw_lats.ndim >= 3 else raw_lats
        if (lats_2d.ndim == 1 and lats_2d[0] < lats_2d[-1]) or (lats_2d.ndim >= 2 and lats_2d[0, 0] < lats_2d[-1, 0]):
            out = np.flipud(out)
    elif "y" in ds:
        y_vals = ds["y"].values
        if len(y_vals) > 1 and y_vals[0] < y_vals[-1]:
            out = np.flipud(out)

    if lon_name:
        raw_lons = ds[lon_name].values
        lons_2d = raw_lons[0] if raw_lons.ndim >= 3 else raw_lons
        if lons_2d.ndim == 1 and lons_2d[0] > lons_2d[-1]:
            out = np.fliplr(out)
    elif "x" in ds:
        x_vals = ds["x"].values
        if len(x_vals) > 1 and x_vals[0] > x_vals[-1]:
            out = np.fliplr(out)

    return out


def extract_variable_field(
    ds: xr.Dataset,
    var_config: VariableConfig,
    time_idx: Optional[int] = None,
    regrid_cache: Optional[RegridCache] = None,
    static_ds: Optional[xr.Dataset] = None,
) -> ExtractedField:
    """
    Extracts, converts units, and aligns a 2D scalar (and optional vector) field
    for the requested VariableConfig. Preserves NaNs (buildings / outside rotated domain).
    """
    if regrid_cache is None:
        regrid_cache = get_regrid_cache(ds, static_ds=static_ds)

    if var_config.is_vector:
        u_var = next((v for v in var_config.u_candidates if v in ds.data_vars), None)
        v_var = next((v for v in var_config.v_candidates if v in ds.data_vars), None)

        if not u_var or not v_var:
            sc_var = next((v for v in var_config.candidate_vars if v in ds.data_vars), None)
            if not sc_var:
                raise KeyError(f"Vector field {var_config.id} missing candidate variables in dataset.")
            scalar_raw = _slice_to_2d(ds[sc_var], time_idx)
            u_arr = None
            v_arr = None
        else:
            u_raw = _slice_to_2d(ds[u_var], time_idx)
            v_raw = _slice_to_2d(ds[v_var], time_idx)
            rot_deg = 0.0
            for src in (static_ds, ds):
                if src is not None and "rotation_angle" in src.attrs:
                    rot_deg = float(src.attrs["rotation_angle"] or 0.0)
                    if abs(rot_deg) > 1e-4:
                        break
            if abs(rot_deg) > 1e-4 and "x" in ds and "y" in ds:
                rot_rad = np.deg2rad(rot_deg)
                cos_r, sin_r = float(np.cos(rot_rad)), float(np.sin(rot_rad))
                u_arr = u_raw * cos_r + v_raw * sin_r
                v_arr = -u_raw * sin_r + v_raw * cos_r
            else:
                u_arr = u_raw
                v_arr = v_raw
            scalar_raw = np.hypot(u_arr, v_arr)
    else:
        u_arr = None
        v_arr = None

        if var_config.id == "nox" and not any(k in ds.data_vars for k in ("nox", "NOx")) and ("no" in ds.data_vars and "no2" in ds.data_vars):
            no_2d = _slice_to_2d(ds["no"], time_idx)
            no2_2d = _slice_to_2d(ds["no2"], time_idx)
            scalar_raw = no_2d + no2_2d
            if var_config.unit_converter is not None:
                scalar_raw = var_config.unit_converter(scalar_raw, dict(ds["no2"].attrs))
        elif var_config.id == "nox" and not any(k in ds.data_vars for k in ("nox", "NOx")) and ("kc_NO" in ds.data_vars and "kc_NO2" in ds.data_vars):
            no_2d = _slice_to_2d(ds["kc_NO"], time_idx)
            no2_2d = _slice_to_2d(ds["kc_NO2"], time_idx)
            scalar_raw = no_2d + no2_2d
            if var_config.unit_converter is not None:
                scalar_raw = var_config.unit_converter(scalar_raw, dict(ds["kc_NO2"].attrs))
        elif var_config.id == "precip_acc" and "RAINNC" in ds.data_vars and "RAINC" in ds.data_vars:
            scalar_raw = _slice_to_2d(ds["RAINNC"], time_idx) + _slice_to_2d(ds["RAINC"], time_idx)
            if "RAINSH" in ds.data_vars:
                scalar_raw = scalar_raw + _slice_to_2d(ds["RAINSH"], time_idx)
            scalar_raw = np.where(np.isfinite(scalar_raw), np.clip(scalar_raw, 0.0, None), np.nan)
        elif var_config.id == "cldfra" and "CLDFRA" in ds.data_vars and "bottom_top" in ds["CLDFRA"].dims:
            da_cld = ds["CLDFRA"]
            if time_idx is not None:
                for tdim in ("time", "Time", "valid_time"):
                    if tdim in da_cld.dims:
                        da_cld = da_cld.isel({tdim: time_idx})
                        break
            z_axis = da_cld.dims.index("bottom_top")
            raw_vals = np.asarray(da_cld.values, dtype=np.float32)
            scalar_raw = np.nanmax(raw_vals, axis=z_axis)
            if var_config.unit_converter is not None:
                scalar_raw = var_config.unit_converter(scalar_raw, dict(ds["CLDFRA"].attrs))
        elif var_config.id == "swnet" and "SWDNB" in ds.data_vars and "SWUPB" in ds.data_vars:
            diff_sw = _slice_to_2d(ds["SWDNB"], time_idx) - _slice_to_2d(ds["SWUPB"], time_idx)
            scalar_raw = np.where(np.isfinite(diff_sw), np.clip(diff_sw, 0.0, None), np.nan)
        else:
            match_var = next((v for v in var_config.candidate_vars if v in ds.data_vars), None)
            if not match_var:
                raise KeyError(f"Variable {var_config.id} candidates {var_config.candidate_vars} not found in dataset.")
            scalar_raw = _slice_to_2d(ds[match_var], time_idx)

            if var_config.unit_converter is not None:
                attrs = dict(ds[match_var].attrs)
                if "ALT" in ds.data_vars and "kg" in str(attrs.get("units", "")).lower():
                    alt_2d = _slice_to_2d(ds["ALT"], time_idx)
                    attrs["rho"] = np.where(alt_2d > 0, 1.0 / alt_2d, 1.2)
                scalar_raw = var_config.unit_converter(scalar_raw, attrs)

    scalar_aligned = _orient_array(scalar_raw, ds, regrid_cache)
    scalar_aligned = np.where(np.isposinf(scalar_aligned), var_config.vmax, scalar_aligned)
    scalar_aligned = np.where(np.isneginf(scalar_aligned), var_config.vmin, scalar_aligned)
    scalar_32 = np.ascontiguousarray(scalar_aligned, dtype=np.float32)

    u_32 = None
    v_32 = None
    if u_arr is not None and v_arr is not None:
        u_aligned = _orient_array(u_arr, ds, regrid_cache)
        v_aligned = _orient_array(v_arr, ds, regrid_cache)
        u_aligned = np.where(np.isinf(u_aligned), np.nan, u_aligned)
        v_aligned = np.where(np.isinf(v_aligned), np.nan, v_aligned)
        u_32 = np.ascontiguousarray(u_aligned, dtype=np.float32)
        v_32 = np.ascontiguousarray(v_aligned, dtype=np.float32)

    finite = scalar_32[np.isfinite(scalar_32)]
    has_nans = bool(np.isnan(scalar_32).any())
    min_val = float(np.min(finite)) if finite.size > 0 else 0.0
    max_val = float(np.max(finite)) if finite.size > 0 else 0.0
    mean_val = float(np.mean(finite)) if finite.size > 0 else 0.0

    return ExtractedField(
        scalar=scalar_32,
        u=u_32,
        v=v_32,
        min_val=round(min_val, 4),
        max_val=round(max_val, 4),
        mean_val=round(mean_val, 4),
        has_nans=has_nans,
    )
