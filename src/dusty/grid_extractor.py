"""
Grid and coordinate extraction engine for Dusty Earth.
Handles regular lat-lon NetCDF outputs (WRF-Chem remapped, ICON-ART, CAMS, NWP).
Standardizes grids to contiguous Float32 arrays with complete spatial metadata.
"""

from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
import numpy as np
import xarray as xr

from .registry import VariableConfig


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
    lat_orientation: str = "north_to_south"  # row 0 is lat_max (North)
    lon_orientation: str = "west_to_east"    # col 0 is lon_min (West)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "nx": self.nx,
            "ny": self.ny,
            "lon_min": round(self.lon_min, 5),
            "lon_max": round(self.lon_max, 5),
            "lat_min": round(self.lat_min, 5),
            "lat_max": round(self.lat_max, 5),
            "dx": round(self.dx, 5),
            "dy": round(self.dy, 5),
            "lat_orientation": self.lat_orientation,
            "lon_orientation": self.lon_orientation,
        }


@dataclass
class ExtractedField:
    """Contains extracted 2D Float32 grid(s) and metadata."""
    scalar: np.ndarray  # Shape (ny, nx), dtype=float32
    u: Optional[np.ndarray] = None  # Shape (ny, nx), dtype=float32 (for vector fields)
    v: Optional[np.ndarray] = None  # Shape (ny, nx), dtype=float32 (for vector fields)
    min_val: float = 0.0
    max_val: float = 0.0
    mean_val: float = 0.0


def extract_coordinates(ds: xr.Dataset) -> Tuple[np.ndarray, np.ndarray, GridMetadata]:
    """
    Extracts 1D latitude and longitude arrays and builds GridMetadata.
    Guarantees lons are sorted ascending (West to East) and
    lats are sorted descending (North to South, row 0 is top).
    """
    lat_name = next((c for c in ("lat", "latitude", "LAT", "nav_lat", "XLAT") if c in ds.coords or c in ds), None)
    lon_name = next((c for c in ("lon", "longitude", "LON", "nav_lon", "XLONG") if c in ds.coords or c in ds), None)

    if not lat_name or not lon_name:
        raise ValueError(f"Could not identify latitude/longitude coordinates in dataset. Coords: {list(ds.coords)}")

    lat_raw = ds[lat_name].values
    lon_raw = ds[lon_name].values

    if lat_raw.ndim >= 3:
        lat_raw = lat_raw[0]
        lon_raw = lon_raw[0]

    if lat_raw.ndim == 2:
        ny, nx = lat_raw.shape
        lat_min = float(np.nanmin(lat_raw))
        lat_max = float(np.nanmax(lat_raw))
        lon_min = float(np.nanmin(lon_raw))
        lon_max = float(np.nanmax(lon_raw))
        lat_1d = np.linspace(lat_max, lat_min, ny, dtype=np.float64)
        lon_1d = np.linspace(lon_min, lon_max, nx, dtype=np.float64)
    else:
        lat_1d = np.asarray(lat_raw, dtype=np.float64)
        lon_1d = np.asarray(lon_raw, dtype=np.float64)

        # Ensure lon is strictly ascending
        if lon_1d[0] > lon_1d[-1]:
            lon_1d = lon_1d[::-1]

        # Standardize lat to descending (North to South, row 0 is North)
        if lat_1d[0] < lat_1d[-1]:
            lat_1d = lat_1d[::-1]

        nx = len(lon_1d)
        ny = len(lat_1d)
        lon_min = float(np.nanmin(lon_1d))
        lon_max = float(np.nanmax(lon_1d))
        lat_min = float(np.nanmin(lat_1d))
        lat_max = float(np.nanmax(lat_1d))

    dx = float((lon_max - lon_min) / max(1, nx - 1))
    dy = float((lat_max - lat_min) / max(1, ny - 1))

    grid = GridMetadata(
        nx=nx,
        ny=ny,
        lon_min=lon_min,
        lon_max=lon_max,
        lat_min=lat_min,
        lat_max=lat_max,
        dx=dx,
        dy=dy,
        lat_orientation="north_to_south",
        lon_orientation="west_to_east",
    )
    return lat_1d, lon_1d, grid


def extract_timestamps(ds: xr.Dataset, fallback_start: datetime, file_index: int = 0) -> List[datetime]:
    """Extracts UTC valid datetimes for each time slice in the dataset."""
    if "Times" in ds:
        raw_times = ds["Times"].values
        out = []
        for rt in raw_times:
            if isinstance(rt, (bytes, np.bytes_)):
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
        if tname in ds.coords or tname in ds:
            vals = ds[tname].values
            if np.ndim(vals) == 0:
                vals = [vals]
            out = []
            for idx, v in enumerate(vals):
                if isinstance(v, np.datetime64):
                    ts_sec = float(v.astype("datetime64[s]").astype(np.int64))
                    out.append(datetime.fromtimestamp(ts_sec, tz=timezone.utc))
                else:
                    out.append(fallback_start)
            return out

    return [fallback_start]


def _slice_to_2d(da: xr.DataArray, time_idx: Optional[int] = None) -> np.ndarray:
    """Extracts a 2D surface slice (lat, lon) from a DataArray of arbitrary dimensions."""
    if time_idx is not None:
        for tdim in ("time", "Time", "valid_time"):
            if tdim in da.dims:
                da = da.isel({tdim: time_idx})
                break

    for zdim in ("bottom_top", "lev", "level", "height", "hybrid", "z"):
        if zdim in da.dims:
            # For bottom_top in WRF, 0 is surface.
            if zdim == "bottom_top":
                da = da.isel({zdim: 0})
            else:
                da = da.isel({zdim: -1 if zdim in ("height", "hybrid") else 0})

    arr = np.asarray(da.values, dtype=np.float32)
    # If dimensions are still 3D or 1D, squeeze
    arr = np.squeeze(arr)
    if arr.ndim != 2:
        raise ValueError(f"Expected 2D field after slicing, got shape {arr.shape} for dims {da.dims}")
    return arr


def extract_variable_field(
    ds: xr.Dataset,
    var_config: VariableConfig,
    time_idx: Optional[int] = None,
    target_lats: Optional[np.ndarray] = None,
    target_lons: Optional[np.ndarray] = None,
) -> ExtractedField:
    """
    Extracts, converts units, and aligns a 2D scalar (and optional vector) field
    for the requested VariableConfig.
    """
    lat_name = next((c for c in ("lat", "latitude", "LAT", "nav_lat", "XLAT") if c in ds.coords or c in ds), None)

    # 1. Handle Vector Fields (e.g. wind10m)
    if var_config.is_vector:
        u_var = next((v for v in var_config.u_candidates if v in ds.data_vars), None)
        v_var = next((v for v in var_config.v_candidates if v in ds.data_vars), None)

        if not u_var or not v_var:
            # Check if scalar magnitude already exists
            sc_var = next((v for v in var_config.candidate_vars if v in ds.data_vars), None)
            if not sc_var:
                raise KeyError(f"Vector field {var_config.id} missing candidate variables in dataset.")
            scalar_raw = _slice_to_2d(ds[sc_var], time_idx)
            u_arr = None
            v_arr = None
        else:
            u_raw = _slice_to_2d(ds[u_var], time_idx)
            v_raw = _slice_to_2d(ds[v_var], time_idx)
            scalar_raw = np.hypot(u_raw, v_raw)
            u_arr = u_raw
            v_arr = v_raw
    else:
        # 2. Handle Scalar Fields
        match_var = next((v for v in var_config.candidate_vars if v in ds.data_vars), None)
        if not match_var:
            raise KeyError(f"Variable {var_config.id} candidates {var_config.candidate_vars} not found in dataset.")
        scalar_raw = _slice_to_2d(ds[match_var], time_idx)
        u_arr = None
        v_arr = None

        # Apply unit conversion if registered
        if var_config.unit_converter is not None:
            attrs = dict(ds[match_var].attrs)
            scalar_raw = var_config.unit_converter(scalar_raw, attrs)

    # Ensure latitude is descending (North at index 0, South at index -1)
    # Check if dataset's raw lat orientation is ascending (e.g. WRF south_north 0 -> -1)
    if lat_name:
        raw_lats = ds[lat_name].values
        lats_2d = raw_lats[0] if raw_lats.ndim >= 3 else raw_lats
        should_flip = False
        if lats_2d.ndim == 1 and lats_2d[0] < lats_2d[-1]:
            should_flip = True
        elif lats_2d.ndim >= 2 and lats_2d[0, 0] < lats_2d[-1, 0]:
            should_flip = True

        if should_flip:
            # Flip rows so row 0 is North
            scalar_raw = np.flipud(scalar_raw)
            if u_arr is not None:
                u_arr = np.flipud(u_arr)
            if v_arr is not None:
                v_arr = np.flipud(v_arr)

    # Replace NaNs / Infs with 0.0 or vmin
    scalar_raw = np.nan_to_num(scalar_raw, nan=0.0, posinf=var_config.vmax, neginf=var_config.vmin)
    scalar_32 = np.ascontiguousarray(scalar_raw, dtype=np.float32)

    u_32 = np.ascontiguousarray(np.nan_to_num(u_arr, nan=0.0), dtype=np.float32) if u_arr is not None else None
    v_32 = np.ascontiguousarray(np.nan_to_num(v_arr, nan=0.0), dtype=np.float32) if v_arr is not None else None

    min_val = float(np.min(scalar_32))
    max_val = float(np.max(scalar_32))
    mean_val = float(np.mean(scalar_32))

    return ExtractedField(
        scalar=scalar_32,
        u=u_32,
        v=v_32,
        min_val=round(min_val, 4),
        max_val=round(max_val, 4),
        mean_val=round(mean_val, 4),
    )
