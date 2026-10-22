"""
High-Performance Binary Grid Exporter and Manifest Generator for Dusty Earth.
Dumps gridded scalar and vector fields into flat Float32 binary (.bin) files
and builds a lightweight manifest.json for zero-latency browser memory mapping.
"""

from __future__ import annotations
import concurrent.futures
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple
import numpy as np
import xarray as xr

from .registry import DEFAULT_REGISTRY, VariableConfig, VariableRegistry
from .grid_extractor import (
    GridMetadata,
    extract_coordinates,
    extract_timestamps,
    extract_variable_field,
)


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


def discover_input_files(input_path: Union[str, Path]) -> List[Path]:
    """Finds NetCDF files in directory or returns single file."""
    p = Path(input_path)
    if p.is_file():
        return [p]
    if not p.exists():
        raise FileNotFoundError(f"Input path does not exist: {p}")

    # Check for wrfout files first
    wrfout_files = sorted(p.glob("wrfout_d01_*"))
    if wrfout_files:
        return [f for f in wrfout_files if f.is_file() or f.is_symlink()]

    # Check for general NetCDF files
    nc_files = sorted(p.glob("*.nc"))
    if nc_files:
        # Exclude static/intermediate files
        excluded = ("wrfinput", "wrfbdy", "wrflowinp", "met_em", "geo_em", "wrfchemi")
        filtered = [f for f in nc_files if not f.name.startswith(excluded)]
        return filtered if filtered else nc_files

    raise FileNotFoundError(f"No forecast NetCDF or wrfout files found in {p}")


def _export_timestep_task(
    file_path: str,
    time_idx: int,
    cycle_id: str,
    lead_hour: int,
    valid_iso: str,
    var_configs: List[VariableConfig],
    output_dir: str,
) -> Dict[str, Any]:
    """Worker task that extracts and dumps binary files for a single timestep."""
    out_dir_path = Path(output_dir)
    lead_label = f"T+{lead_hour:02d}" if lead_hour < 100 else f"T+{lead_hour:03d}"

    timestep_entry: Dict[str, Any] = {
        "lead_hour": lead_hour,
        "lead_label": lead_label,
        "valid_time": valid_iso,
        "files": {},
        "stats": {},
    }

    with xr.open_dataset(file_path) as ds:
        for var_cfg in var_configs:
            try:
                extracted = extract_variable_field(ds, var_cfg, time_idx=time_idx)
            except Exception as e:
                # Variable might not exist in this dataset; continue
                continue

            var_dir = out_dir_path / "cycles" / cycle_id / var_cfg.id
            var_dir.mkdir(parents=True, exist_ok=True)

            scalar_rel = f"cycles/{cycle_id}/{var_cfg.id}/{lead_hour:03d}.bin"
            scalar_file = out_dir_path / scalar_rel

            # Write flat Float32 binary directly
            scalar_file.write_bytes(extracted.scalar.tobytes())

            var_files: Dict[str, str] = {"scalar": scalar_rel}

            # If vector field, write U and V binary components
            if var_cfg.is_vector and extracted.u is not None and extracted.v is not None:
                u_rel = f"cycles/{cycle_id}/{var_cfg.id}/{lead_hour:03d}_u.bin"
                v_rel = f"cycles/{cycle_id}/{var_cfg.id}/{lead_hour:03d}_v.bin"
                (out_dir_path / u_rel).write_bytes(extracted.u.tobytes())
                (out_dir_path / v_rel).write_bytes(extracted.v.tobytes())
                var_files["u"] = u_rel
                var_files["v"] = v_rel

            timestep_entry["files"][var_cfg.id] = var_files
            timestep_entry["stats"][var_cfg.id] = {
                "min": extracted.min_val,
                "max": extracted.max_val,
                "mean": extracted.mean_val,
            }

    return timestep_entry


def export_forecast(
    input_path: Union[str, Path],
    output_dir: Union[str, Path],
    cycle_str: Optional[str] = None,
    variables: Optional[List[str]] = None,
    workers: int = 4,
    registry: Optional[VariableRegistry] = None,
) -> Path:
    """
    Main export engine:
      1. Discovers input files and coordinate grid.
      2. Matches active variables against registry.
      3. Uses ProcessPoolExecutor to dump binary Float32 arrays.
      4. Compiles and updates manifest.json.
    """
    files = discover_input_files(input_path)
    reg = registry or VariableRegistry()
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Read first file to inspect grid and available variables
    with xr.open_dataset(files[0]) as ds0:
        _, _, grid_meta = extract_coordinates(ds0)
        ds_vars = list(ds0.data_vars.keys())

        matched_configs = reg.match_available(ds_vars)
        if variables:
            var_filter = set(variables)
            matched_configs = [c for c in matched_configs if c.id in var_filter]

        if not matched_configs:
            raise RuntimeError(
                f"No variables from registry matched dataset variables: {ds_vars}"
            )

        # Derive cycle ID if not provided
        if not cycle_str:
            if "Times" in ds0:
                t0_str = str(ds0["Times"].values[0])
                clean_t = re.sub(r"[^0-9]", "", t0_str)[:10]
                cycle_str = clean_t
            else:
                cycle_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H")

    cycle_id, cycle_dt = parse_cycle_id(cycle_str)

    print(f"[Dusty Earth] Cycle ID: {cycle_id} ({cycle_dt.strftime('%Y-%m-%d %H:%M UTC')})")
    print(f"[Dusty Earth] Grid: {grid_meta.nx}x{grid_meta.ny} (lon: [{grid_meta.lon_min}, {grid_meta.lon_max}], lat: [{grid_meta.lat_min}, {grid_meta.lat_max}])")
    print(f"[Dusty Earth] Exporting {len(matched_configs)} variables: {[c.id for c in matched_configs]}")

    # 2. Collect all timesteps across all input files
    tasks = []
    seen_valid_times = set()

    for file_idx, fpath in enumerate(files):
        with xr.open_dataset(fpath) as ds:
            timestamps = extract_timestamps(ds, fallback_start=cycle_dt, file_index=file_idx)
            for t_idx, valid_dt in enumerate(timestamps):
                valid_iso = valid_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
                if valid_iso in seen_valid_times:
                    continue
                seen_valid_times.add(valid_iso)

                lead_hours = int(round((valid_dt - cycle_dt).total_seconds() / 3600.0))
                if lead_hours < 0:
                    lead_hours = file_idx if len(timestamps) == 1 else t_idx

                tasks.append({
                    "file_path": str(fpath),
                    "time_idx": t_idx,
                    "cycle_id": cycle_id,
                    "lead_hour": lead_hours,
                    "valid_iso": valid_iso,
                    "var_configs": matched_configs,
                    "output_dir": str(out_dir),
                })

    print(f"[Dusty Earth] Processing {len(tasks)} timestep(s) using {workers} worker(s)...")

    timesteps_results = []
    if workers <= 1 or len(tasks) <= 1:
        for t in tasks:
            res = _export_timestep_task(**t)
            timesteps_results.append(res)
    else:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
            future_to_task = {
                executor.submit(_export_timestep_task, **t): t for t in tasks
            }
            for fut in concurrent.futures.as_completed(future_to_task):
                res = fut.result()
                timesteps_results.append(res)

    # Sort timesteps by lead hour
    timesteps_results.sort(key=lambda x: x["lead_hour"])

    # 3. Update manifest.json
    manifest_path = update_manifest(
        output_dir=out_dir,
        cycle_id=cycle_id,
        cycle_dt=cycle_dt,
        grid_meta=grid_meta,
        variables=matched_configs,
        timesteps=timesteps_results,
    )

    print(f"[Dusty Earth] Export completed successfully! Manifest: {manifest_path}")
    return manifest_path


def update_manifest(
    output_dir: Path,
    cycle_id: str,
    cycle_dt: datetime,
    grid_meta: GridMetadata,
    variables: List[VariableConfig],
    timesteps: List[Dict[str, Any]],
) -> Path:
    """Atomically writes or updates manifest.json in output_dir."""
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

    existing_cycles[cycle_id] = {
        "id": cycle_id,
        "label": f"{cycle_dt.strftime('%Y-%m-%d %H:%M')} UTC ({cycle_id})",
        "init_time": cycle_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grid": grid_meta.to_dict(),
        "variables": [v.to_dict() for v in variables],
        "timesteps": timesteps,
    }

    # Sort cycles newest first
    sorted_cycles = sorted(existing_cycles.values(), key=lambda c: c["id"], reverse=True)

    manifest_payload = {
        "app": "Dusty Earth",
        "version": "0.1.0",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "default_cycle": sorted_cycles[0]["id"] if sorted_cycles else cycle_id,
        "cycles": sorted_cycles,
    }

    tmp_file = output_dir / "manifest.json.tmp"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(manifest_payload, f, indent=2)
    tmp_file.replace(manifest_file)
    return manifest_file
