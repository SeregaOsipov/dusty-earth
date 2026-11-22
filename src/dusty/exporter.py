"""
High-Performance Multi-Model Binary Grid Exporter and Manifest Generator for Dusty Earth.
Discovers WRF-Chem nested domains (e.g., 10 km d01, 2 km d02), PALM-4U urban LES runs
(e.g., 100 m, 10 m, 1 m), or generic NetCDF outputs; preserves native sub-hourly steps
and NaN building masks; and compiles manifest.json v2 for GPU WebGL rendering.
"""

from __future__ import annotations
import concurrent.futures
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union
import numpy as np
import xarray as xr

from .registry import DEFAULT_REGISTRY, VariableConfig, VariableRegistry
from .buildings_extractor import extract_palm_3d_layers
from .grid_extractor import (
    GridMetadata,
    extract_coordinates,
    extract_timestamps,
    extract_variable_field,
    get_regrid_cache,
)


QUANTIZE_CELL_THRESHOLD = 1_000_000
QUANTIZE_TOTAL_CELL_STEPS_THRESHOLD = 40_000_000


@dataclass
class ModelSourceSpec:
    """Describes one forecast model/domain stream exported inside a cycle."""
    id: str
    name: str
    short_name: str
    badge: str
    model_family: str  # "wrf" | "palm" | "generic"
    resolution_m: float
    files: List[Path]
    aux_file: Optional[Path] = None
    static_file: Optional[Path] = None
    domain_tag: str = "d01"
    min_auto_zoom: float = 0.0
    exit_auto_zoom: float = 0.0
    primary_var_ids: List[str] = field(default_factory=list)
    aux_var_ids: List[str] = field(default_factory=list)


def open_dataset_safe(path: Union[str, Path]) -> xr.Dataset:
    """Open NetCDF cleanly without failing on PALM-4U or WRF time unit strings."""
    return xr.open_dataset(path, decode_times=False)


def format_resolution_badge(dx_m: float) -> str:
    """Format horizontal grid spacing in meters into a compact badge ('10 km', '2 km', '100 m', '1 m')."""
    if dx_m >= 1000.0:
        km = dx_m / 1000.0
        return f"{int(round(km))} km" if abs(km - round(km)) < 0.15 else f"{km:.1f} km"
    if dx_m >= 1.0:
        m_int = int(round(dx_m))
        return f"{m_int} m" if abs(dx_m - m_int) < 0.15 else f"{dx_m:.1f} m"
    return f"{dx_m:.2f} m"


def derive_auto_zoom_thresholds(resolution_m: float) -> Tuple[float, float]:
    """Derive (min_auto_zoom, exit_auto_zoom) with hysteresis directly from grid spacing."""
    if resolution_m >= 5000.0:
        return 0.0, 0.0
    if resolution_m >= 1000.0:
        return 6.8, 6.3
    if resolution_m >= 40.0:
        return 10.5, 10.0
    if resolution_m >= 5.0:
        return 12.2, 11.7
    return 14.0, 13.5


def format_lead_label(lead_seconds: int) -> str:
    """Format lead time in seconds as 'T+12' (whole hours) or 'T+12:15' / 'T+00:03'."""
    h = lead_seconds // 3600
    rem = lead_seconds % 3600
    m = rem // 60
    if rem == 0 or (m == 0 and rem < 30):
        return f"T+{h:02d}" if h < 100 else f"T+{h:03d}"
    if rem % 60 >= 30:
        m += 1
        if m == 60:
            h += 1
            m = 0
            return f"T+{h:02d}" if h < 100 else f"T+{h:03d}"
    h_str = f"{h:02d}" if h < 100 else f"{h:03d}"
    return f"T+{h_str}:{m:02d}"


def parse_cycle_id(cycle_str: str) -> Tuple[str, datetime]:
    """Parses cycle string like '20261022_00' or '2026-10-22' into (id, UTC datetime)."""
    digits = re.sub(r"[^0-9]", "", cycle_str)
    if len(digits) >= 10:
        dt = datetime.strptime(digits[:10], "%Y%m%d%H").replace(tzinfo=timezone.utc)
        cycle_id = f"{digits[:8]}_{digits[8:10]}"
    elif len(digits) >= 8:
        dt = datetime.strptime(digits[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
        cycle_id = f"{digits[:8]}_00"
    else:
        dt = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        cycle_id = dt.strftime("%Y%m%d_%H")
    return cycle_id, dt


def filter_files_for_cycle(files: List[Path], cycle_dt: datetime) -> List[Path]:
    """
    Filters wrfout_d0*_* files so only contiguous files belonging to `cycle_dt`
    (starting at >= cycle_dt with no multi-day gap between files) are included.
    """
    wrf_pattern = re.compile(r"wrfout_d\d+_(\d{4}-\d{2}-\d{2})_(\d{2})[_:](\d{2})[_:](\d{2})")
    dated_files: List[Tuple[datetime, Path]] = []
    other_files: List[Path] = []

    for f in files:
        m = wrf_pattern.search(f.name)
        if m:
            dt_str = f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}"
            f_dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            dated_files.append((f_dt, f))
        else:
            other_files.append(f)

    if not dated_files:
        return files

    dated_files.sort(key=lambda x: x[0])
    valid = [(dt, f) for dt, f in dated_files if dt >= cycle_dt]
    if not valid:
        return [f for _, f in dated_files]

    contiguous = [valid[0][1]]
    prev_dt = valid[0][0]
    for cur_dt, f in valid[1:]:
        if (cur_dt - prev_dt).total_seconds() > 48 * 3600:
            break
        contiguous.append(f)
        prev_dt = cur_dt

    return contiguous + other_files


def discover_input_files(input_path: Union[str, Path]) -> List[Path]:
    """Finds primary NetCDF files in directory or returns single file."""
    p = Path(input_path)
    if p.is_file():
        return [p]
    if not p.exists():
        raise FileNotFoundError(f"Input path does not exist: {p}")

    wrfout_files = sorted(p.glob("wrfout_d01_*"))
    if wrfout_files:
        return [f for f in wrfout_files if f.is_file() or f.is_symlink()]

    nc_files = sorted(p.glob("*.nc"))
    if nc_files:
        excluded = ("wrfinput", "wrfbdy", "wrflowinp", "met_em", "geo_em", "wrfchemi")
        filtered = [f for f in nc_files if not f.name.startswith(excluded)]
        return filtered if filtered else nc_files

    raise FileNotFoundError(f"No forecast NetCDF or wrfout files found in {p}")


def _is_palm_cycle_or_output_dir(p: Path) -> bool:
    if not p.is_dir():
        return False
    if (p / "OUTPUT").is_dir():
        return True
    for name in ("DATA_MASK_NETCDF", "DATA_MASK_NETCDF_M001", "DATA_2D_XY_NETCDF"):
        if (p / name).exists():
            return True
    return any(p.glob("DATA_MASK_NETCDF*")) or any(p.glob("DATA_2D_XY*"))


def _match_static_for_palm(primary_file: Path, palm_dir: Path, nest_key: str) -> Optional[Path]:
    candidate_dirs = [
        palm_dir / "INPUT",
        palm_dir,
        palm_dir.parent / "INPUT",
        palm_dir.parent,
    ]
    statics: List[Path] = []
    seen_dirs = set()
    for d in candidate_dirs:
        resolved_d = d.resolve() if d.exists() else d
        if resolved_d in seen_dirs or not d.is_dir():
            continue
        seen_dirs.add(resolved_d)
        for f in sorted(d.glob("*_static*")):
            if f.is_file() or f.is_symlink():
                statics.append(f)

    if not statics:
        return None

    with open_dataset_safe(primary_file) as pds:
        ny, nx = pds.sizes.get("y"), pds.sizes.get("x")

    candidates = []
    if nest_key != "N01":
        candidates.extend([f for f in statics if f"_{nest_key}" in f.name])
    else:
        candidates.extend([f for f in statics if not re.search(r"_N\d{2}", f.name)])
    candidates.extend(statics)

    seen = set()
    for st in candidates:
        if st in seen:
            continue
        seen.add(st)
        try:
            with open_dataset_safe(st) as sds:
                if "lat" in sds and "lon" in sds and sds["lat"].ndim == 2:
                    if sds["lat"].shape == (ny, nx):
                        return st
                if ny is not None and nx is not None and sds.sizes.get("y") == ny and sds.sizes.get("x") == nx:
                    return st
        except Exception:
            continue
    return None


def _discover_palm_models_in_dir(palm_dir: Path, case_name: str) -> List[ModelSourceSpec]:
    """Config-agnostic discovery of PALM-4U 2D/mask domains inside a cycle or OUTPUT directory."""
    output_dir = palm_dir / "OUTPUT" if (palm_dir / "OUTPUT").is_dir() else palm_dir
    if not output_dir.is_dir():
        return []

    mask_files: Dict[Tuple[str, str], List[Path]] = {}
    xy_files: Dict[str, List[Path]] = {}

    for item in sorted(output_dir.iterdir()):
        if not (item.is_file() or item.is_symlink()):
            continue
        name = item.name
        if name in ("RUN_CONTROL", "PARIN", "HEADER", "CPU_MEASURES", "DATA_3D_NETCDF") or "3D" in name:
            continue

        is_mask = "DATA_MASK_NETCDF" in name or "_masked" in name.lower()
        is_xy = "DATA_2D_XY" in name or "_2d" in name.lower() or "_xy" in name.lower()
        if not (is_mask or is_xy):
            continue

        m_nest = re.search(r"_N(\d{2})", name)
        nest_key = f"N{m_nest.group(1)}" if m_nest else "N01"
        m_mask = re.search(r"_M(\d{3})", name)
        mask_key = f"M{m_mask.group(1)}" if m_mask else ""

        if is_mask:
            mask_files.setdefault((nest_key, mask_key), []).append(item)
        else:
            xy_files.setdefault(nest_key, []).append(item)

    specs: List[ModelSourceSpec] = []
    slug_case = re.sub(r"[^a-z0-9]+", "_", case_name.lower()).strip("_") or "urban"

    def _build_palm_spec(primary_list: List[Path], aux_list: Optional[List[Path]], nest_key: str, mask_key: str) -> Optional[ModelSourceSpec]:
        static_fp = _match_static_for_palm(primary_list[0], palm_dir, nest_key)
        static_ds = open_dataset_safe(static_fp) if static_fp else None
        try:
            with open_dataset_safe(primary_list[0]) as ds0:
                _, _, grid_meta = extract_coordinates(ds0, static_ds=static_ds)
        except Exception as exc:
            print(f"[Dusty Earth] Skipping PALM output {primary_list[0]}: {exc}")
            return None
        finally:
            if static_ds is not None:
                static_ds.close()

        res_m = grid_meta.dx_m if grid_meta.dx_m > 0 else 10.0
        badge = format_resolution_badge(res_m)
        min_z, exit_z = derive_auto_zoom_thresholds(res_m)

        nest_part = f"_{nest_key.lower()}" if nest_key != "N01" else ""
        mask_part = f"_{mask_key.lower()}" if mask_key else ""
        res_part = badge.replace(" ", "").replace(".", "_")
        model_id = f"palm_{slug_case}{nest_part}{mask_part}_{res_part}"

        mask_label = f" {mask_key}" if mask_key else ""
        nest_label = f" {nest_key}" if nest_key != "N01" else ""
        short_name = f"PALM {badge}"
        nice_case = case_name.replace("_", " ").strip().title()
        full_name = f"PALM-4U {nice_case}{nest_label}{mask_label} ({badge})"

        return ModelSourceSpec(
            id=model_id,
            name=full_name,
            short_name=short_name,
            badge=badge,
            model_family="palm",
            resolution_m=res_m,
            files=primary_list,
            aux_file=aux_list[0] if aux_list else None,
            static_file=static_fp,
            domain_tag=f"{nest_key}{mask_part}",
            min_auto_zoom=min_z,
            exit_auto_zoom=exit_z,
        )

    handled_nests = set()
    for (nest_key, mask_key), flist in sorted(mask_files.items()):
        handled_nests.add(nest_key)
        spec = _build_palm_spec(flist, xy_files.get(nest_key), nest_key, mask_key)
        if spec is not None:
            specs.append(spec)

    for nest_key, flist in sorted(xy_files.items()):
        if nest_key in handled_nests:
            continue
        spec = _build_palm_spec(flist, None, nest_key, "")
        if spec is not None:
            specs.append(spec)

    return specs


def _discover_models(
    input_path: Union[str, Path],
    cycle_str: Optional[str],
    palm_root: Optional[Union[str, Path]] = None,
    icon_root: Optional[Union[str, Path]] = None,
    extra_inputs: Optional[Sequence[Union[str, Path]]] = None,
) -> Tuple[str, datetime, List[ModelSourceSpec]]:
    """Discover all model streams (WRF d01..d0N, PALM-4U domains, or generic NetCDF) for the cycle."""
    p = Path(input_path)
    specs: List[ModelSourceSpec] = []

    if not p.exists():
        raise FileNotFoundError(f"Input path does not exist: {p}")

    # Resolve cycle_id and cycle_dt early if omitted
    if cycle_str:
        cycle_id, cycle_dt = parse_cycle_id(cycle_str)
    else:
        probe_files = []
        if _is_palm_cycle_or_output_dir(p):
            palm_probes = _discover_palm_models_in_dir(p, p.parent.name if p.name == "OUTPUT" else p.parent.name)
            if palm_probes:
                probe_files = palm_probes[0].files
        if not probe_files:
            probe_files = discover_input_files(p)
        with open_dataset_safe(probe_files[0]) as ds0:
            if "Times" in ds0:
                t0 = str(ds0["Times"].values[0])
                clean = re.sub(r"[^0-9]", "", t0)[:10]
                cycle_id, cycle_dt = parse_cycle_id(clean)
            else:
                ts_list = extract_timestamps(ds0, datetime.now(timezone.utc))
                first_dt = ts_list[0]
                cycle_id = first_dt.strftime("%Y%m%d_%H")
                cycle_dt = first_dt.replace(minute=0, second=0, microsecond=0)

    # 1. Inspect primary input path
    if p.is_file():
        with open_dataset_safe(p) as ds0:
            _, _, gm = extract_coordinates(ds0)
            fam = "wrf" if "XLAT" in ds0 else "generic"
        res_m = gm.dx_m if gm.dx_m > 0 else 10000.0
        badge = format_resolution_badge(res_m)
        specs.append(ModelSourceSpec(
            id="primary_d01",
            name=f"Forecast ({badge})",
            short_name=f"Forecast {badge}",
            badge=badge,
            model_family=fam,
            resolution_m=res_m,
            files=[p],
        ))
    elif _is_palm_cycle_or_output_dir(p):
        case_name = p.parent.name if p.parent.name not in ("", "operational_forecast", "PALM_run") else p.name
        specs.extend(_discover_palm_models_in_dir(p, case_name))
    else:
        wrf_domains: Dict[str, List[Path]] = {}
        for f in sorted(p.glob("wrfout_d*_*")):
            if not (f.is_file() or f.is_symlink()):
                continue
            m = re.match(r"^wrfout_(d\d{2})_", f.name)
            if m:
                wrf_domains.setdefault(m.group(1), []).append(f)

        if wrf_domains:
            for dom_tag, dfiles in sorted(wrf_domains.items()):
                valid_files = filter_files_for_cycle(dfiles, cycle_dt)
                if not valid_files:
                    continue
                with open_dataset_safe(valid_files[0]) as ds0:
                    _, _, gm = extract_coordinates(ds0)
                res_m = gm.dx_m if gm.dx_m > 0 else (10000.0 if dom_tag == "d01" else 2000.0)
                badge = format_resolution_badge(res_m)
                min_z, exit_z = derive_auto_zoom_thresholds(res_m)
                label_area = "Regional" if dom_tag == "d01" else "Qatar"
                specs.append(ModelSourceSpec(
                    id=f"wrf_{dom_tag}",
                    name=f"WRF-Chem {label_area} ({badge})",
                    short_name=f"WRF {badge}",
                    badge=badge,
                    model_family="wrf",
                    resolution_m=res_m,
                    files=valid_files,
                    domain_tag=dom_tag,
                    min_auto_zoom=min_z,
                    exit_auto_zoom=exit_z,
                ))
        else:
            generic_files = discover_input_files(p)
            with open_dataset_safe(generic_files[0]) as ds0:
                _, _, gm = extract_coordinates(ds0)
            res_m = gm.dx_m if gm.dx_m > 0 else 10000.0
            badge = format_resolution_badge(res_m)
            specs.append(ModelSourceSpec(
                id="forecast_d01",
                name=f"Forecast ({badge})",
                short_name=f"Model {badge}",
                badge=badge,
                model_family="generic",
                resolution_m=res_m,
                files=generic_files,
            ))

    # 2. Discover PALM-4U simulations for matching cycle_id under palm_root
    if palm_root is not None:
        pr = Path(palm_root)
        if pr.is_dir():
            palm_cycle_dirs: List[Tuple[str, Path]] = []
            direct_candidate = pr / cycle_id
            if _is_palm_cycle_or_output_dir(direct_candidate):
                palm_cycle_dirs.append((pr.name, direct_candidate))
            for case_dir in sorted(pr.iterdir()):
                if not case_dir.is_dir():
                    continue
                cyc_dir = case_dir / cycle_id
                if _is_palm_cycle_or_output_dir(cyc_dir):
                    palm_cycle_dirs.append((case_dir.name, cyc_dir))
            for case_name, cyc_dir in palm_cycle_dirs:
                specs.extend(_discover_palm_models_in_dir(cyc_dir, case_name))

    # 2b. Discover ICON-ART regional LAM simulations for matching cycle_id under icon_root
    if icon_root is not None:
        ir = Path(icon_root)
        if ir.is_dir():
            icon_files: List[Path] = []
            for base_cand in (ir / "output" / cycle_id, ir / cycle_id, ir):
                if base_cand.is_dir():
                    found = sorted(base_cand.glob("icon_art_*.nc"))
                    if found:
                        icon_files = found
                        break
            if icon_files:
                specs.append(ModelSourceSpec(
                    id="icon_art_5km",
                    name="ICON-ART 5 km (Gulf / Arabia)",
                    short_name="ICON 5 km",
                    badge="5 km",
                    model_family="icon",
                    resolution_m=4920.0,
                    files=icon_files,
                    domain_tag="dom01",
                ))

    # 3. Discover any explicit extra inputs
    if extra_inputs:
        for ei in extra_inputs:
            ep = Path(ei)
            if not ep.exists():
                continue
            if _is_palm_cycle_or_output_dir(ep):
                cname = ep.parent.name if ep.name == cycle_id else ep.name
                specs.extend(_discover_palm_models_in_dir(ep, cname))

    if not specs:
        raise FileNotFoundError(f"No valid forecast model outputs found for {input_path}")

    # Deduplicate model IDs if multiple sources collide
    seen_ids: Dict[str, int] = {}
    for sp in specs:
        cnt = seen_ids.get(sp.id, 0) + 1
        seen_ids[sp.id] = cnt
        if cnt > 1:
            sp.id = f"{sp.id}_{cnt}"

    # Order coarsest (lowest zoom) -> finest (highest zoom)
    specs.sort(key=lambda s: (-s.resolution_m, s.id))
    specs[0].min_auto_zoom = 0.0
    specs[0].exit_auto_zoom = 0.0

    return cycle_id, cycle_dt, specs


def _is_field_valid_at_t0(ds: xr.Dataset, var_cfg: VariableConfig, static_ds: Optional[xr.Dataset]) -> bool:
    try:
        ext = extract_variable_field(ds, var_cfg, time_idx=0, static_ds=static_ds)
        return bool(np.isfinite(ext.scalar).any())
    except Exception:
        return False


def _write_array_bin(arr: np.ndarray, out_path: Path, use_uint16: bool) -> Dict[str, Any]:
    """Write contiguous Little-Endian Float32 or Uint16-quantized buffer to disk."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not use_uint16:
        arr.astype("<f4", copy=False).tofile(out_path)
        return {"encoding": "float32"}

    finite = arr[np.isfinite(arr)]
    qmin = float(np.min(finite)) if finite.size > 0 else 0.0
    qmax = float(np.max(finite)) if finite.size > 0 else 1.0
    span = qmax - qmin
    q = np.zeros(arr.shape, dtype="<u2")
    if span > 1e-12:
        norm = np.clip((arr - qmin) / span, 0.0, 1.0)
        q_vals = np.rint(norm * 65534.0) + 1.0
        valid_mask = np.isfinite(arr)
        q[valid_mask] = q_vals[valid_mask].astype("<u2")
    else:
        valid_mask = np.isfinite(arr)
        q[valid_mask] = 1
        qmax = qmin + 1.0

    q.tofile(out_path)
    return {
        "encoding": "uint16",
        "qmin": round(qmin, 6),
        "qmax": round(qmax, 6),
    }


def _process_open_timestep(
    *,
    ds: xr.Dataset,
    regrid_cache: Any,
    aux_ds: Optional[xr.Dataset],
    aux_cache: Any,
    static_ds: Optional[xr.Dataset],
    time_idx: int,
    cycle_id: str,
    model_id: str,
    lead_seconds: int,
    valid_iso: str,
    primary_var_configs: List[VariableConfig],
    aux_var_configs: List[VariableConfig],
    output_dir: str,
    aux_time_idx: Optional[int] = None,
    use_uint16: bool = False,
    include_stats: bool = True,
) -> Dict[str, Any]:
    """Extract and write binary buffers for one open timestep using cached NetCDF handles."""
    out_dir_path = Path(output_dir)
    lead_minutes = round(lead_seconds / 60.0, 2)
    raw_hours = lead_seconds / 3600.0
    lead_hour: Union[int, float] = int(round(raw_hours)) if lead_seconds % 3600 == 0 else round(raw_hours, 4)
    lead_label = format_lead_label(lead_seconds)
    file_stem = f"s{lead_seconds:06d}.bin"

    timestep_entry: Dict[str, Any] = {
        "lead_hour": lead_hour,
        "lead_minutes": lead_minutes,
        "lead_seconds": lead_seconds,
        "lead_label": lead_label,
        "valid_time": valid_iso,
        "files": {},
    }
    if include_stats:
        timestep_entry["stats"] = {}

    for var_cfg in primary_var_configs:
        try:
            extracted = extract_variable_field(
                ds,
                var_cfg,
                time_idx=time_idx,
                regrid_cache=regrid_cache,
                static_ds=static_ds,
            )
        except Exception:
            continue

        var_dir = out_dir_path / "cycles" / cycle_id / model_id / var_cfg.id
        scalar_rel = f"cycles/{cycle_id}/{model_id}/{var_cfg.id}/{file_stem}"
        enc_meta = _write_array_bin(extracted.scalar, var_dir / file_stem, use_uint16=use_uint16)

        file_entry: Dict[str, Any] = {"scalar": scalar_rel, **enc_meta}
        if var_cfg.is_vector and extracted.u is not None and extracted.v is not None:
            u_name = f"s{lead_seconds:06d}_u.bin"
            v_name = f"s{lead_seconds:06d}_v.bin"
            u_enc = _write_array_bin(extracted.u, var_dir / u_name, use_uint16=use_uint16)
            v_enc = _write_array_bin(extracted.v, var_dir / v_name, use_uint16=use_uint16)
            file_entry["u"] = f"cycles/{cycle_id}/{model_id}/{var_cfg.id}/{u_name}"
            file_entry["v"] = f"cycles/{cycle_id}/{model_id}/{var_cfg.id}/{v_name}"
            if use_uint16:
                file_entry["u_qmin"] = u_enc["qmin"]
                file_entry["u_qmax"] = u_enc["qmax"]
                file_entry["v_qmin"] = v_enc["qmin"]
                file_entry["v_qmax"] = v_enc["qmax"]

        timestep_entry["files"][var_cfg.id] = file_entry
        if include_stats:
            timestep_entry["stats"][var_cfg.id] = {
                "min": extracted.min_val,
                "max": extracted.max_val,
                "mean": extracted.mean_val,
            }

    if aux_var_configs and aux_ds is not None and aux_time_idx is not None:
        for var_cfg in aux_var_configs:
            try:
                extracted = extract_variable_field(
                    aux_ds,
                    var_cfg,
                    time_idx=aux_time_idx,
                    regrid_cache=aux_cache,
                    static_ds=static_ds,
                )
            except Exception:
                continue
            var_dir = out_dir_path / "cycles" / cycle_id / model_id / var_cfg.id
            scalar_rel = f"cycles/{cycle_id}/{model_id}/{var_cfg.id}/{file_stem}"
            enc_meta = _write_array_bin(extracted.scalar, var_dir / file_stem, use_uint16=use_uint16)
            timestep_entry["files"][var_cfg.id] = {"scalar": scalar_rel, **enc_meta}
            if include_stats:
                timestep_entry["stats"][var_cfg.id] = {
                    "min": extracted.min_val,
                    "max": extracted.max_val,
                    "mean": extracted.mean_val,
                }

    return timestep_entry


def _export_timestep_batch_task(batch: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Worker batch task that reuses open NetCDF datasets and KDTree caches across frames."""
    if not batch:
        return []
    open_primary: Dict[str, Tuple[xr.Dataset, Any]] = {}
    open_aux: Dict[str, Tuple[xr.Dataset, Any]] = {}
    open_static: Dict[str, xr.Dataset] = {}
    results: List[Dict[str, Any]] = []

    try:
        for t in batch:
            s_path = t.get("static_file_path")
            static_ds = None
            if s_path:
                static_ds = open_static.get(s_path)
                if static_ds is None:
                    static_ds = open_dataset_safe(s_path)
                    open_static[s_path] = static_ds

            f_path = t["file_path"]
            if f_path not in open_primary:
                pds = open_dataset_safe(f_path)
                open_primary[f_path] = (pds, get_regrid_cache(pds, static_ds=static_ds))
            pds, pcache = open_primary[f_path]

            a_path = t.get("aux_file_path")
            aux_ds = None
            aux_cache = None
            if a_path and t.get("aux_var_configs") and t.get("aux_time_idx") is not None:
                if a_path not in open_aux:
                    ads = open_dataset_safe(a_path)
                    open_aux[a_path] = (ads, get_regrid_cache(ads, static_ds=static_ds))
                aux_ds, aux_cache = open_aux[a_path]

            results.append(
                _process_open_timestep(
                    ds=pds,
                    regrid_cache=pcache,
                    aux_ds=aux_ds,
                    aux_cache=aux_cache,
                    static_ds=static_ds,
                    time_idx=t["time_idx"],
                    cycle_id=t["cycle_id"],
                    model_id=t["model_id"],
                    lead_seconds=t["lead_seconds"],
                    valid_iso=t["valid_iso"],
                    primary_var_configs=t["primary_var_configs"],
                    aux_var_configs=t["aux_var_configs"],
                    output_dir=t["output_dir"],
                    aux_time_idx=t.get("aux_time_idx"),
                    use_uint16=bool(t.get("use_uint16", False)),
                    include_stats=bool(t.get("include_stats", True)),
                )
            )
    finally:
        for ds, _ in open_primary.values():
            ds.close()
        for ds, _ in open_aux.values():
            ds.close()
        for ds in open_static.values():
            ds.close()

    return results


def _export_timestep_task(
    file_path: str,
    time_idx: int,
    cycle_id: str,
    model_id: str,
    lead_seconds: int,
    valid_iso: str,
    primary_var_configs: List[VariableConfig],
    aux_var_configs: List[VariableConfig],
    output_dir: str,
    aux_file_path: Optional[str] = None,
    aux_time_idx: Optional[int] = None,
    static_file_path: Optional[str] = None,
    use_uint16: bool = False,
    include_stats: bool = True,
) -> Dict[str, Any]:
    """Worker task that extracts and writes binary buffers for a single model timestep."""
    return _export_timestep_batch_task([{
        "file_path": file_path,
        "time_idx": time_idx,
        "cycle_id": cycle_id,
        "model_id": model_id,
        "lead_seconds": lead_seconds,
        "valid_iso": valid_iso,
        "primary_var_configs": primary_var_configs,
        "aux_var_configs": aux_var_configs,
        "output_dir": output_dir,
        "aux_file_path": aux_file_path,
        "aux_time_idx": aux_time_idx,
        "static_file_path": static_file_path,
        "use_uint16": use_uint16,
        "include_stats": include_stats,
    }])[0]


def export_forecast(
    input_path: Union[str, Path],
    output_dir: Union[str, Path],
    cycle_str: Optional[str] = None,
    variables: Optional[List[str]] = None,
    workers: int = 4,
    registry: Optional[VariableRegistry] = None,
    palm_root: Optional[Union[str, Path]] = None,
    icon_root: Optional[Union[str, Path]] = None,
    extra_inputs: Optional[Sequence[Union[str, Path]]] = None,
) -> Path:
    """
    Main multi-model export engine:
      1. Discovers WRF nested domains, ICON-ART, PALM-4U LES simulations, or generic NetCDFs.
      2. Matches valid variables per model against registry (filtering all-NaN dummies).
      3. Uses ProcessPoolExecutor batches to dump Float32 / Uint16 binary buffers at native timesteps.
      4. Compiles and updates manifest.json with backward-compatible top-level defaults + models[].
    """
    reg = registry or VariableRegistry()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cycle_id, cycle_dt, specs = _discover_models(
        input_path=input_path,
        cycle_str=cycle_str,
        palm_root=palm_root,
        icon_root=icon_root,
        extra_inputs=extra_inputs,
    )

    print(f"[Dusty Earth] Cycle ID: {cycle_id} ({cycle_dt.strftime('%Y-%m-%d %H:%M UTC')})")
    print(f"[Dusty Earth] Discovered {len(specs)} model stream(s): {[f'{s.id} ({s.badge})' for s in specs]}")

    cycle_out_dir = out_dir / "cycles" / cycle_id
    if cycle_out_dir.exists():
        shutil.rmtree(cycle_out_dir, ignore_errors=True)

    models_meta: List[Dict[str, Any]] = []
    var_filter = set(variables) if variables else None

    for sp in specs:
        static_ds = open_dataset_safe(sp.static_file) if sp.static_file else None
        try:
            with open_dataset_safe(sp.files[0]) as ds0:
                _, _, grid_meta = extract_coordinates(ds0, static_ds=static_ds)
                ds_vars = list(ds0.data_vars.keys())
                candidates = reg.match_available(ds_vars)
                if var_filter:
                    candidates = [c for c in candidates if c.id in var_filter]
                primary_vars = [c for c in candidates if _is_field_valid_at_t0(ds0, c, static_ds)]
        finally:
            if static_ds is not None:
                static_ds.close()

        primary_ids = {c.id for c in primary_vars}
        aux_vars: List[VariableConfig] = []
        if sp.aux_file is not None and sp.aux_file.exists():
            static_ds = open_dataset_safe(sp.static_file) if sp.static_file else None
            try:
                with open_dataset_safe(sp.aux_file) as aux0:
                    aux_cands = reg.match_available(list(aux0.data_vars.keys()))
                    if var_filter:
                        aux_cands = [c for c in aux_cands if c.id in var_filter]
                    aux_vars = [
                        c for c in aux_cands
                        if c.id not in primary_ids and _is_field_valid_at_t0(aux0, c, static_ds)
                    ]
            finally:
                if static_ds is not None:
                    static_ds.close()

        all_model_vars = primary_vars + aux_vars
        if not all_model_vars:
            print(f"[Dusty Earth] WARNING: No valid matched variables for model {sp.id}; skipping.")
            continue

        # Ensure grid_meta.has_nan_mask reflects actual NaN presence in primary variable
        static_ds = open_dataset_safe(sp.static_file) if sp.static_file else None
        try:
            with open_dataset_safe(sp.files[0]) as ds0:
                probe_var = primary_vars[0] if primary_vars else aux_vars[0]
                if primary_vars:
                    test_ext = extract_variable_field(ds0, probe_var, time_idx=0, static_ds=static_ds)
                    if test_ext.has_nans:
                        grid_meta.has_nan_mask = True
        finally:
            if static_ds is not None:
                static_ds.close()

        aux_timestamps: List[datetime] = []
        if aux_vars and sp.aux_file is not None:
            with open_dataset_safe(sp.aux_file) as aux_ds:
                aux_timestamps = extract_timestamps(aux_ds, fallback_start=cycle_dt, file_index=0)

        tasks = []
        seen_lead_seconds = set()
        for file_idx, fpath in enumerate(sp.files):
            with open_dataset_safe(fpath) as ds:
                timestamps = extract_timestamps(ds, fallback_start=cycle_dt, file_index=file_idx)
                for t_idx, valid_dt in enumerate(timestamps):
                    lead_seconds = int(round((valid_dt - cycle_dt).total_seconds()))
                    if lead_seconds < 0 or lead_seconds in seen_lead_seconds:
                        continue
                    seen_lead_seconds.add(lead_seconds)

                    aux_idx: Optional[int] = None
                    if aux_timestamps:
                        diffs = [abs((at - valid_dt).total_seconds()) for at in aux_timestamps]
                        best_i = int(np.argmin(diffs))
                        if diffs[best_i] <= 5.0:
                            aux_idx = best_i

                    tasks.append({
                        "file_path": str(fpath),
                        "time_idx": t_idx,
                        "cycle_id": cycle_id,
                        "model_id": sp.id,
                        "lead_seconds": lead_seconds,
                        "valid_iso": valid_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "primary_var_configs": primary_vars,
                        "aux_var_configs": aux_vars,
                        "output_dir": str(out_dir),
                        "aux_file_path": str(sp.aux_file) if sp.aux_file else None,
                        "aux_time_idx": aux_idx,
                        "static_file_path": str(sp.static_file) if sp.static_file else None,
                    })

        n_tasks = len(tasks)
        total_cell_steps = grid_meta.nx * grid_meta.ny * max(1, n_tasks)
        use_uint16 = (
            (grid_meta.nx * grid_meta.ny) > QUANTIZE_CELL_THRESHOLD
            or total_cell_steps > QUANTIZE_TOTAL_CELL_STEPS_THRESHOLD
        )
        for task_i, t in enumerate(tasks):
            t["use_uint16"] = use_uint16
            t["include_stats"] = (task_i == 0) or (n_tasks <= 300)

        encoding_label = "uint16" if use_uint16 else "float32"
        print(
            f"[Dusty Earth] [{sp.id}] {sp.name}: grid={grid_meta.nx}x{grid_meta.ny} ({grid_meta.dx_m:.1f} m, {encoding_label}), "
            f"lon=[{grid_meta.lon_min:.4f}, {grid_meta.lon_max:.4f}], lat=[{grid_meta.lat_min:.4f}, {grid_meta.lat_max:.4f}], "
            f"vars={len(all_model_vars)}"
        )

        print(f"[Dusty Earth] [{sp.id}] Processing {n_tasks} timestep(s) using {workers} worker(s)...")
        timesteps_results: List[Dict[str, Any]] = []
        if workers <= 1 or n_tasks <= 4:
            timesteps_results.extend(_export_timestep_batch_task(tasks))
        else:
            batch_size = max(1, min(64, math.ceil(n_tasks / max(1, workers * 2))))
            batches = [tasks[i:i + batch_size] for i in range(0, n_tasks, batch_size)]
            with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
                future_to_batch = {executor.submit(_export_timestep_batch_task, b): b for b in batches}
                for fut in concurrent.futures.as_completed(future_to_batch):
                    timesteps_results.extend(fut.result())

        timesteps_results.sort(key=lambda x: x["lead_seconds"])

        model_entry: Dict[str, Any] = {
            "id": sp.id,
            "name": sp.name,
            "short_name": sp.short_name,
            "badge": sp.badge,
            "model_family": sp.model_family,
            "resolution_m": round(sp.resolution_m, 2),
            "min_auto_zoom": sp.min_auto_zoom,
            "exit_auto_zoom": sp.exit_auto_zoom,
            "grid": grid_meta.to_dict(),
            "variables": [v.to_dict() for v in all_model_vars],
            "timesteps": timesteps_results,
        }

        if sp.static_file is not None and sp.static_file.exists():
            try:
                model_dir = out_dir / "cycles" / cycle_id / sp.id
                layers_3d = extract_palm_3d_layers(sp.static_file, model_dir)
                b_info = layers_3d.get("buildings_3d")
                if b_info is not None:
                    b_path = Path(b_info.pop("path"))
                    b_info["url"] = f"cycles/{cycle_id}/{sp.id}/{b_path.name}"
                    model_entry["buildings_3d"] = b_info
                    print(
                        f"[Dusty Earth] [{sp.id}] Extracted {b_info['feature_count']} dissolved 3D buildings "
                        f"({b_info['min_height_m']}-{b_info['max_height_m']} m AGL) -> {b_path.name}"
                    )
                c_info = layers_3d.get("canopy_3d")
                if c_info is not None:
                    c_path = Path(c_info.pop("path"))
                    c_info["url"] = f"cycles/{cycle_id}/{sp.id}/{c_path.name}"
                    model_entry["canopy_3d"] = c_info
                    print(
                        f"[Dusty Earth] [{sp.id}] Extracted {c_info['feature_count']} 3D canopy patches "
                        f"({c_info['voxel_count']} LAD voxels) -> {c_path.name}"
                    )
            except Exception as exc:
                print(f"[Dusty Earth] WARNING: Failed 3D morphology extraction for {sp.id}: {exc}")

        models_meta.append(model_entry)

    if not models_meta:
        raise RuntimeError(f"No valid forecast variables exported for cycle {cycle_id}")

    manifest_path = update_manifest(
        output_dir=out_dir,
        cycle_id=cycle_id,
        cycle_dt=cycle_dt,
        models=models_meta,
    )
    print(f"[Dusty Earth] Export completed successfully! Manifest: {manifest_path}")
    return manifest_path


def update_manifest(
    output_dir: Path,
    cycle_id: str,
    cycle_dt: datetime,
    grid_meta: Optional[GridMetadata] = None,
    variables: Optional[List[VariableConfig]] = None,
    timesteps: Optional[List[Dict[str, Any]]] = None,
    models: Optional[List[Dict[str, Any]]] = None,
) -> Path:
    """Atomically writes or updates manifest.json in output_dir (schema v2 with v1 compatibility)."""
    manifest_file = output_dir / "manifest.json"
    existing_cycles: Dict[str, Any] = {}

    if manifest_file.exists():
        try:
            with open(manifest_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                for c in data.get("cycles", []):
                    cid = c.get("id")
                    if cid and (output_dir / "cycles" / cid).exists():
                        existing_cycles[cid] = c
        except Exception as e:
            print(f"[Dusty Earth] Notice: Rebuilding manifest.json ({e})")

    if models is None:
        if grid_meta is None or variables is None or timesteps is None:
            raise ValueError("Either `models` or (`grid_meta`, `variables`, `timesteps`) must be provided.")
        models = [{
            "id": "default",
            "name": "Forecast",
            "short_name": "Forecast",
            "badge": format_resolution_badge(grid_meta.dx_m if grid_meta.dx_m > 0 else 10000.0),
            "model_family": "generic",
            "resolution_m": round(grid_meta.dx_m if grid_meta.dx_m > 0 else 10000.0, 2),
            "min_auto_zoom": 0.0,
            "exit_auto_zoom": 0.0,
            "grid": grid_meta.to_dict(),
            "variables": [v.to_dict() for v in variables],
            "timesteps": timesteps,
        }]

    primary_model = models[0]
    existing_cycles[cycle_id] = {
        "id": cycle_id,
        "label": f"{cycle_dt.strftime('%Y-%m-%d %H:%M')} UTC ({cycle_id})",
        "init_time": cycle_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "default_model": primary_model["id"],
        "models": models,
        # Top-level v1 compatibility mirrors primary (coarsest) model
        "grid": primary_model["grid"],
        "variables": primary_model["variables"],
        "timesteps": primary_model["timesteps"],
    }

    sorted_cycles = sorted(existing_cycles.values(), key=lambda c: c["id"], reverse=True)
    manifest_payload = {
        "app": "Dusty Earth",
        "version": "0.2.0",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "default_cycle": sorted_cycles[0]["id"] if sorted_cycles else cycle_id,
        "cycles": sorted_cycles,
    }

    tmp_file = output_dir / "manifest.json.tmp"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(manifest_payload, f, separators=(",", ":"))
    tmp_file.replace(manifest_file)
    return manifest_file
