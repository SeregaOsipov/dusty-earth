"""
PALM-4U Static 3D Morphology Extractor for Dusty Earth.
Dissolves connected building footprints (from buildings_2d/buildings_3d + building_id)
and 3D urban tree/vegetation canopy volumes (from lad + zlad) into compact,
exact GeoJSON polygon layers aligned 1:1 with the fluid-dynamics NaN mask.
"""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import netCDF4 as nc
import numpy as np
from rasterio import features
from rasterio.transform import Affine
from shapely.geometry import mapping, shape
from shapely.geometry.polygon import orient

from .grid_extractor import build_palm_local_to_lonlat


def _read_masked_float(ds: nc.Dataset, name: str) -> Optional[np.ndarray]:
    if name not in ds.variables:
        return None
    raw = ds.variables[name][:]
    arr = np.asarray(np.ma.filled(np.ma.asarray(raw, dtype=np.float64), np.nan), dtype=np.float64)
    fv = getattr(ds.variables[name], "_FillValue", None)
    if fv is not None and np.isfinite(float(fv)):
        arr = np.where(arr == float(fv), np.nan, arr)
    return arr


def _read_masked_int(ds: nc.Dataset, name: str, default: int = 0) -> Optional[np.ndarray]:
    if name not in ds.variables:
        return None
    raw = ds.variables[name][:]
    arr = np.ma.asarray(raw)
    mask = np.ma.getmaskarray(arr)
    out = np.asarray(arr.data, dtype=np.int64)
    fv = getattr(ds.variables[name], "_FillValue", None)
    bad = mask.copy()
    if fv is not None:
        bad = bad | (out == int(fv))
    return np.where(bad, default, out)


def _transform_ring(ring: List[List[float]], mapper, x0: float, y0: float, dx_m: float, dy_m: float) -> List[List[float]]:
    coords = np.asarray(ring, dtype=np.float64)
    x_loc = x0 + coords[:, 0] * dx_m
    y_loc = y0 + coords[:, 1] * dy_m
    lons, lats = mapper(x_loc, y_loc)
    pts = [[round(float(lo), 7), round(float(la), 7)] for lo, la in zip(lons, lats)]
    if pts and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def _transform_geojson_geom(geom_dict: Dict[str, Any], mapper, x0: float, y0: float, dx_m: float, dy_m: float) -> Optional[Dict[str, Any]]:
    gtype = geom_dict.get("type")
    if gtype == "Polygon":
        rings = [_transform_ring(r, mapper, x0, y0, dx_m, dy_m) for r in geom_dict["coordinates"]]
        rings = [r for r in rings if len(r) >= 4]
        if not rings:
            return None
        geo_dict = {"type": "Polygon", "coordinates": rings}
    elif gtype == "MultiPolygon":
        polys = []
        for poly_rings in geom_dict["coordinates"]:
            rings = [_transform_ring(r, mapper, x0, y0, dx_m, dy_m) for r in poly_rings]
            rings = [r for r in rings if len(r) >= 4]
            if rings:
                polys.append(rings)
        if not polys:
            return None
        geo_dict = {"type": "MultiPolygon", "coordinates": polys}
    else:
        return None

    try:
        shp = shape(geo_dict)
        if shp.is_empty:
            return None
        if shp.geom_type == "Polygon":
            shp = orient(shp, sign=1.0)
        elif shp.geom_type == "MultiPolygon":
            oriented = type(shp)([orient(p, sign=1.0) for p in shp.geoms])
            shp = oriented
        return mapping(shp)
    except Exception:
        return geo_dict


def _resolve_building_heights(ds: nc.Dataset) -> Tuple[Optional[np.ndarray], str]:
    b2d = _read_masked_float(ds, "buildings_2d")
    if b2d is not None and b2d.ndim == 2:
        return np.where(np.isfinite(b2d) & (b2d > 0.0), b2d, 0.0), "buildings_2d"

    b3d = _read_masked_float(ds, "buildings_3d")
    if b3d is not None and b3d.ndim == 3:
        z_name = next((z for z in ("z", "zu", "zb", "zw") if z in ds.variables), None)
        if z_name is not None:
            z_vals = np.asarray(ds.variables[z_name][:], dtype=np.float64)
            occupied = np.isfinite(b3d) & (b3d > 0)
            dz = float(np.median(np.diff(z_vals))) if len(z_vals) > 1 else 2.0
            top_edges = z_vals + 0.5 * dz
            heights = np.max(np.where(occupied, top_edges[:, None, None], 0.0), axis=0)
            return heights, "buildings_3d"

    return None, ""


def _extract_buildings_geojson(
    ds: nc.Dataset,
    out_path: Path,
    mapper,
    x0: float,
    y0: float,
    dx_m: float,
    dy_m: float,
    heights: np.ndarray,
    height_source: str,
) -> Optional[Dict[str, Any]]:
    ny, nx = heights.shape
    occ = np.isfinite(heights) & (heights > 0.0)
    if not np.any(occ):
        return None

    b_ids = _read_masked_int(ds, "building_id", default=0)
    if b_ids is None or b_ids.shape != (ny, nx):
        b_ids = np.zeros((ny, nx), dtype=np.int64)
    b_types = _read_masked_int(ds, "building_type", default=0)
    if b_types is None or b_types.shape != (ny, nx):
        b_types = np.zeros((ny, nx), dtype=np.int64)
    zt = _read_masked_float(ds, "zt")
    if zt is None or zt.shape != (ny, nx):
        zt = np.zeros((ny, nx), dtype=np.float64)
    zt_clean = np.where(np.isfinite(zt), zt, 0.0)

    # Group contiguous cells sharing identical (building_id, quantized height_cm)
    h_cm = np.rint(heights * 100.0).astype(np.int64)
    occ_r, occ_c = np.where(occ)
    pair_arr = np.column_stack([b_ids[occ_r, occ_c], h_cm[occ_r, occ_c]])
    uniq_pairs, inv = np.unique(pair_arr, axis=0, return_inverse=True)

    label_grid = np.zeros((ny, nx), dtype=np.int32)
    label_ids = np.arange(1, len(uniq_pairs) + 1, dtype=np.int32)
    label_grid[occ_r, occ_c] = label_ids[inv]

    counts = np.bincount(label_grid.ravel(), minlength=len(uniq_pairs) + 1)
    zt_sums = np.bincount(label_grid.ravel(), weights=zt_clean.ravel(), minlength=len(uniq_pairs) + 1)
    type_max = np.zeros(len(uniq_pairs) + 1, dtype=np.int64)
    np.maximum.at(type_max, label_grid[occ_r, occ_c], b_types[occ_r, occ_c])

    geojson_features: List[Dict[str, Any]] = []
    for feat_idx, (geom_dict, lbl_val) in enumerate(
        features.shapes(label_grid, mask=(label_grid > 0), connectivity=4, transform=Affine.identity())
    ):
        lbl = int(lbl_val)
        bid, h_c = int(uniq_pairs[lbl - 1, 0]), int(uniq_pairs[lbl - 1, 1])
        height_m = round(h_c / 100.0, 2)
        cnt = max(1, int(counts[lbl]))
        ground_m = round(float(zt_sums[lbl] / cnt), 1)
        btype = int(type_max[lbl])

        transformed = _transform_geojson_geom(geom_dict, mapper, x0, y0, dx_m, dy_m)
        if transformed is None:
            continue

        geojson_features.append({
            "type": "Feature",
            "id": feat_idx + 1,
            "properties": {
                "height_agl": height_m,
                "building_id": bid if bid > 0 else feat_idx + 1,
                "building_type": btype,
                "ground_m": ground_m,
            },
            "geometry": transformed,
        })

    if not geojson_features:
        return None

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"type": "FeatureCollection", "features": geojson_features}
    tmp_fp = out_path.with_suffix(".geojson.tmp")
    with open(tmp_fp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    tmp_fp.replace(out_path)

    all_h = [f["properties"]["height_agl"] for f in geojson_features]
    return {
        "feature_count": len(geojson_features),
        "occupied_cells": int(np.sum(occ)),
        "min_height_m": round(float(min(all_h)), 2),
        "max_height_m": round(float(max(all_h)), 2),
        "height_source": height_source,
        "source_file": static_name_hint(ds),
    }


def static_name_hint(ds: nc.Dataset) -> str:
    return Path(ds.filepath()).name if hasattr(ds, "filepath") else "static"


def _extract_canopy_geojson(
    ds: nc.Dataset,
    out_path: Path,
    mapper,
    x0: float,
    y0: float,
    dx_m: float,
    dy_m: float,
    bldg_heights: Optional[np.ndarray],
) -> Optional[Dict[str, Any]]:
    if "lad" not in ds.variables or "zlad" not in ds.variables:
        return None

    lad = _read_masked_float(ds, "lad")
    zlad = _read_masked_float(ds, "zlad")
    if lad is None or zlad is None or lad.ndim != 3 or zlad.ndim != 1:
        return None

    nz, ny, nx = lad.shape
    if len(zlad) != nz:
        return None

    pos_mask = np.isfinite(lad) & (lad > 0.01)
    if not np.any(pos_mask):
        return None

    max_lad = float(np.max(lad[pos_mask]))
    if max_lad <= 0.01:
        return None

    # Build contiguous vertical bounds around zlad centers
    interfaces = np.zeros(nz + 1, dtype=np.float64)
    for k in range(1, nz):
        interfaces[k] = 0.5 * (zlad[k - 1] + zlad[k])
    interfaces[0] = max(0.0, float(zlad[0])) if zlad[0] <= 0.1 else 0.0
    if nz > 1:
        interfaces[nz] = max(interfaces[nz - 1] + 0.5, float(zlad[-1] + 0.5 * (zlad[-1] - zlad[-2])))
    else:
        interfaces[1] = float(zlad[0]) + 3.0

    bldg = bldg_heights if (bldg_heights is not None and bldg_heights.shape == (ny, nx)) else np.zeros((ny, nx), dtype=np.float64)

    t1 = 0.25 * max_lad
    t2 = 0.60 * max_lad

    geojson_features: List[Dict[str, Any]] = []
    feat_id = 1
    for k in range(nz):
        slab_base = float(interfaces[k])
        slab_top = float(interfaces[k + 1])
        if slab_top <= slab_base + 0.05:
            continue

        slice_lad = lad[k]
        valid = np.isfinite(slice_lad) & (slice_lad > 0.01) & (bldg < slab_top - 0.1)
        if not np.any(valid):
            continue

        # Tier: 1=low, 2=medium, 3=dense
        tier_grid = np.zeros((ny, nx), dtype=np.uint8)
        tier_grid[valid & (slice_lad < t1)] = 1
        tier_grid[valid & (slice_lad >= t1) & (slice_lad < t2)] = 2
        tier_grid[valid & (slice_lad >= t2)] = 3

        # Combine tier with quantized roof elevation step (0 if ground, else 1m bin) so rooftop gardens stay raised cleanly
        base_elev = np.where(bldg > slab_base, np.ceil(bldg), slab_base)
        base_cm = np.rint(base_elev * 10.0).astype(np.int64)
        occ_r, occ_c = np.where(tier_grid > 0)
        pair_arr = np.column_stack([tier_grid[occ_r, occ_c].astype(np.int64), base_cm[occ_r, occ_c]])
        uniq_pairs, inv = np.unique(pair_arr, axis=0, return_inverse=True)

        lbl_grid = np.zeros((ny, nx), dtype=np.int32)
        lbl_ids = np.arange(1, len(uniq_pairs) + 1, dtype=np.int32)
        lbl_grid[occ_r, occ_c] = lbl_ids[inv]

        lad_clean = np.where(valid, slice_lad, 0.0)
        counts = np.bincount(lbl_grid.ravel(), minlength=len(uniq_pairs) + 1)
        lad_sums = np.bincount(lbl_grid.ravel(), weights=lad_clean.ravel(), minlength=len(uniq_pairs) + 1)

        for geom_dict, lbl_val in features.shapes(lbl_grid, mask=(lbl_grid > 0), connectivity=4, transform=Affine.identity()):
            lbl = int(lbl_val)
            tier = int(uniq_pairs[lbl - 1, 0])
            b_m = round(float(uniq_pairs[lbl - 1, 1]) / 10.0, 2)
            t_m = round(slab_top, 2)
            if t_m <= b_m + 0.05:
                continue
            mean_lad = round(float(lad_sums[lbl] / max(1, int(counts[lbl]))), 3)

            transformed = _transform_geojson_geom(geom_dict, mapper, x0, y0, dx_m, dy_m)
            if transformed is None:
                continue

            geojson_features.append({
                "type": "Feature",
                "id": feat_id,
                "properties": {
                    "tier": tier,
                    "base_m": b_m,
                    "top_m": t_m,
                    "lad": mean_lad,
                },
                "geometry": transformed,
            })
            feat_id += 1

    if not geojson_features:
        return None

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"type": "FeatureCollection", "features": geojson_features}
    tmp_fp = out_path.with_suffix(".geojson.tmp")
    with open(tmp_fp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    tmp_fp.replace(out_path)

    return {
        "feature_count": len(geojson_features),
        "voxel_count": int(np.sum(pos_mask)),
        "max_lad": round(max_lad, 3),
        "max_height_m": round(float(interfaces[-1]), 2),
    }


def extract_palm_3d_layers(static_path: Path, model_out_dir: Path) -> Dict[str, Any]:
    """
    Extract dissolved 3D static-driver buildings and canopy GeoJSON files into model_out_dir.
    Returns metadata dictionary {"buildings_3d": ..., "canopy_3d": ...}.
    """
    out: Dict[str, Any] = {"buildings_3d": None, "canopy_3d": None}
    static_path = Path(static_path)
    if not static_path.exists():
        return out

    with nc.Dataset(static_path, "r") as ds:
        if "x" not in ds.variables or "y" not in ds.variables:
            return out
        mapper, (x0, _x1, y0, _y1, _nx, _ny, dx_m, dy_m, _rot) = build_palm_local_to_lonlat(ds)
        bldg_heights, height_source = _resolve_building_heights(ds)
        if bldg_heights is not None:
            bldg_fp = Path(model_out_dir) / "buildings.geojson"
            bldg_meta = _extract_buildings_geojson(
                ds, bldg_fp, mapper, x0, y0, dx_m, dy_m, bldg_heights, height_source
            )
            if bldg_meta is not None:
                out["buildings_3d"] = {"path": bldg_fp, **bldg_meta}

        canopy_fp = Path(model_out_dir) / "canopy.geojson"
        canopy_meta = _extract_canopy_geojson(
            ds, canopy_fp, mapper, x0, y0, dx_m, dy_m, bldg_heights
        )
        if canopy_meta is not None:
            out["canopy_3d"] = {"path": canopy_fp, **canopy_meta}

    return out
