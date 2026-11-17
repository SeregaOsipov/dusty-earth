"""
End-to-End Verification Test Suite for Dusty Earth.
Validates:
  1. Single-model regular lat-lon export & live HTTP serving (backward compat).
  2. Multi-domain WRF-Chem (d01 10 km + d02 2 km) with native 15-minute timesteps.
  3. Config-agnostic PALM-4U urban/microscale export at 100 m and 1 m resolutions
     with NaN building masks, metric x/y -> WGS84 conversion, and Uint16 quantization.
"""

from __future__ import annotations
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import urllib.request
import numpy as np
import xarray as xr

from dusty.exporter import export_forecast, _write_array_bin


def create_synthetic_forecast(
    nc_path: Path,
    nt: int = 5,
    nx: int = 80,
    ny: int = 60,
    lon_range: tuple = (35.0, 60.0),
    lat_range: tuple = (15.0, 35.0),
) -> Path:
    """Creates a realistic synthetic multi-timestep atmospheric forecast dataset."""
    lons = np.linspace(lon_range[0], lon_range[1], nx, dtype=np.float32)
    lats = np.linspace(lat_range[0], lat_range[1], ny, dtype=np.float32)

    times = [
        np.datetime64("2026-10-22T00:00:00") + np.timedelta64(h * 3, "h")
        for h in range(nt)
    ]

    lon2d, lat2d = np.meshgrid(lons, lats)

    sconc = np.zeros((nt, ny, nx), dtype=np.float32)
    dust_load = np.zeros((nt, ny, nx), dtype=np.float32)
    dod550 = np.zeros((nt, ny, nx), dtype=np.float32)
    t2m = np.zeros((nt, ny, nx), dtype=np.float32)
    u10 = np.zeros((nt, ny, nx), dtype=np.float32)
    v10 = np.zeros((nt, ny, nx), dtype=np.float32)

    for t in range(nt):
        cx = 45.0 + t * 0.8
        cy = 28.0 - t * 0.5
        plume = np.exp(-(((lon2d - cx) ** 2) / 12.0 + ((lat2d - cy) ** 2) / 8.0))

        sconc[t] = (20.0 + 850.0 * plume) * 1e-9
        dust_load[t] = (50.0 + 1800.0 * plume) * 1e-6
        dod550[t] = 0.08 + 1.6 * plume
        t2m[t] = 295.15 + 12.0 * np.sin((t / nt) * np.pi) - 0.3 * (lat2d - 15.0)
        u10[t] = 5.0 + 8.0 * plume
        v10[t] = -6.0 - 10.0 * plume

    ds = xr.Dataset(
        data_vars={
            "sconc_dust": (("time", "lat", "lon"), sconc, {"units": "kg m-3"}),
            "dust_load": (("time", "lat", "lon"), dust_load, {"units": "kg m-2"}),
            "dod550": (("time", "lat", "lon"), dod550, {"units": "1"}),
            "t2m": (("time", "lat", "lon"), t2m, {"units": "K"}),
            "u10": (("time", "lat", "lon"), u10, {"units": "m s-1"}),
            "v10": (("time", "lat", "lon"), v10, {"units": "m s-1"}),
        },
        coords={
            "time": times,
            "lat": ("lat", lats, {"units": "degrees_north"}),
            "lon": ("lon", lons, {"units": "degrees_east"}),
        },
        attrs={"title": "Synthetic Dusty Earth Verification Dataset"},
    )

    nc_path.parent.mkdir(parents=True, exist_ok=True)
    ds.to_netcdf(nc_path)
    return nc_path


def create_synthetic_wrfout(
    wrf_path: Path,
    dx_m: float,
    nx: int,
    ny: int,
    lon_center: float,
    lat_center: float,
    minutes: list[int],
) -> Path:
    """Creates a synthetic WRF-Chem wrfout NetCDF with 15-minute Times and curvilinear XLAT/XLONG."""
    nt = len(minutes)
    dlon = dx_m / 100000.0
    dlat = dx_m / 111000.0
    x = np.arange(nx) - nx / 2.0
    y = np.arange(ny) - ny / 2.0
    xx, yy = np.meshgrid(x, y)
    # Slight curvilinear rotation like Lambert Conformal
    lon2d = lon_center + xx * dlon * 0.998 - yy * dlat * 0.04
    lat2d = lat_center + yy * dlat * 0.998 + xx * dlon * 0.04

    times_chars = []
    for m in minutes:
        hh = m // 60
        mm = m % 60
        s = f"2026-11-14_{hh:02d}:{mm:02d}:00"
        times_chars.append(np.array([c.encode("ascii") for c in s], dtype="|S1"))

    no2 = np.full((nt, 2, ny, nx), 0.015, dtype=np.float32)
    t2 = np.full((nt, ny, nx), 298.15, dtype=np.float32)
    u10 = np.full((nt, ny, nx), 4.0, dtype=np.float32)
    v10 = np.full((nt, ny, nx), -3.0, dtype=np.float32)

    ds = xr.Dataset(
        data_vars={
            "Times": (("Time", "DateStrLen"), np.stack(times_chars)),
            "XLAT": (("Time", "south_north", "west_east"), np.broadcast_to(lat2d, (nt, ny, nx)).astype(np.float32)),
            "XLONG": (("Time", "south_north", "west_east"), np.broadcast_to(lon2d, (nt, ny, nx)).astype(np.float32)),
            "no2": (("Time", "bottom_top", "south_north", "west_east"), no2, {"units": "ppmv"}),
            "T2": (("Time", "south_north", "west_east"), t2, {"units": "K"}),
            "U10": (("Time", "south_north", "west_east"), u10, {"units": "m s-1"}),
            "V10": (("Time", "south_north", "west_east"), v10, {"units": "m s-1"}),
        },
        attrs={"DX": np.float32(dx_m), "DY": np.float32(dx_m)},
    )
    ds.to_netcdf(wrf_path)
    return wrf_path


def create_synthetic_palm_run(
    palm_case_dir: Path,
    cycle_id: str,
    dx_m: float,
    nx: int,
    ny: int,
    origin_lat: float,
    origin_lon: float,
    with_static: bool = False,
) -> Path:
    """Creates a synthetic PALM-4U cycle OUTPUT/DATA_MASK_NETCDF_M001 with building NaNs (+ optional static driver)."""
    out_dir = palm_case_dir / cycle_id / "OUTPUT"
    out_dir.mkdir(parents=True, exist_ok=True)
    mask_fp = out_dir / "DATA_MASK_NETCDF_M001"

    x = (np.arange(nx, dtype=np.float64) + 0.5) * dx_m
    y = (np.arange(ny, dtype=np.float64) + 0.5) * dx_m
    t_sec = np.array([60.0, 120.0, 180.0], dtype=np.float64)

    kc_no2 = np.full((3, 2, ny, nx), 0.025, dtype=np.float32)
    u = np.full((3, 2, ny, nx), 2.5, dtype=np.float32)
    v = np.full((3, 2, ny, nx), -1.2, dtype=np.float32)
    ta = np.full((3, 2, ny, nx), 26.5, dtype=np.float32)

    # Carve a synthetic building block in the center with NaNs
    r0, r1 = ny // 3, ny // 2
    c0, c1 = nx // 3, nx // 2
    kc_no2[:, :, r0:r1, c0:c1] = np.nan
    u[:, :, r0:r1, c0:c1] = np.nan
    v[:, :, r0:r1, c0:c1] = np.nan
    ta[:, :, r0:r1, c0:c1] = np.nan

    ds = xr.Dataset(
        data_vars={
            "kc_NO2": (("time", "ku_above_surf", "y", "x"), kc_no2, {"units": "ppm"}),
            "u": (("time", "ku_above_surf", "y", "x"), u, {"units": "m/s"}),
            "v": (("time", "ku_above_surf", "y", "x"), v, {"units": "m/s"}),
            "ta": (("time", "ku_above_surf", "y", "x"), ta, {"units": "degree_C"}),
        },
        coords={
            "time": ("time", t_sec, {"units": "seconds since 2026-11-14 00:00:00 +00"}),
            "ku_above_surf": ("ku_above_surf", np.array([1.0, 3.0])),
            "x": ("x", x, {"units": "meters"}),
            "y": ("y", y, {"units": "meters"}),
        },
        attrs={
            "origin_lat": np.float64(origin_lat),
            "origin_lon": np.float64(origin_lon),
            "origin_time": "2026-11-14 00:00:00 +00",
        },
    )
    ds.to_netcdf(mask_fp)

    if with_static:
        import netCDF4 as nc
        from pyproj import Transformer
        in_dir = palm_case_dir / cycle_id / "INPUT"
        in_dir.mkdir(parents=True, exist_ok=True)
        static_fp = in_dir / f"{palm_case_dir.name}_static"
        tr = Transformer.from_crs("EPSG:4326", "EPSG:32639", always_xy=True)
        origin_x, origin_y = tr.transform(origin_lon, origin_lat)

        b2d = np.full((ny, nx), -9999.0, dtype=np.float32)
        b2d[r0:r1, c0:c1] = 14.5
        bid = np.full((ny, nx), -9999, dtype=np.int32)
        bid[r0:r1, c0:c1] = 1001
        zt = np.full((ny, nx), 5.0, dtype=np.float32)
        zlad = np.array([0.0, 2.0, 6.0], dtype=np.float32)
        lad = np.full((3, ny, nx), -9999.0, dtype=np.float32)
        lad[1:, 2:5, 2:5] = 0.65

        with nc.Dataset(static_fp, "w") as sds:
            sds.createDimension("y", ny)
            sds.createDimension("x", nx)
            sds.createDimension("zlad", 3)
            sds.origin_x = float(origin_x)
            sds.origin_y = float(origin_y)
            sds.origin_lat = float(origin_lat)
            sds.origin_lon = float(origin_lon)
            sds.rotation_angle = 0.0
            vx = sds.createVariable("x", "f8", ("x",))
            vx[:] = x
            vy = sds.createVariable("y", "f8", ("y",))
            vy[:] = y
            vz = sds.createVariable("zlad", "f4", ("zlad",))
            vz[:] = zlad
            vcrs = sds.createVariable("crs", "i4", ())
            vcrs.epsg_code = "EPSG:32639"
            vzt = sds.createVariable("zt", "f4", ("y", "x"), fill_value=-9999.0)
            vzt[:] = zt
            vb = sds.createVariable("buildings_2d", "f4", ("y", "x"), fill_value=-9999.0)
            vb[:] = b2d
            vbi = sds.createVariable("building_id", "i4", ("y", "x"), fill_value=-9999)
            vbi[:] = bid
            vlad = sds.createVariable("lad", "f4", ("zlad", "y", "x"), fill_value=-9999.0)
            vlad[:] = lad

    return mask_fp


def test_single_model_and_http_serving() -> None:
    repo_dir = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="dusty_test_") as tmpdir:
        tmp_path = Path(tmpdir)
        synth_nc = tmp_path / "synthetic_dust.nc"
        web_out = tmp_path / "web_portal"

        nx, ny, nt = 80, 60, 4
        print(f"[Test 1] Synthetic regular lat-lon ({nt} steps, {nx}x{ny}) + HTTP serving...")
        create_synthetic_forecast(synth_nc, nt=nt, nx=nx, ny=ny)

        manifest_path = export_forecast(
            input_path=synth_nc,
            output_dir=web_out,
            cycle_str="20261022_00",
            workers=2,
        )
        assert manifest_path.exists()
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        assert manifest.get("app") == "Dusty Earth"
        cycle = manifest["cycles"][0]
        assert cycle["id"] == "20261022_00"
        assert len(cycle["models"]) == 1
        grid = cycle["grid"]
        assert grid["nx"] == nx and grid["ny"] == ny
        expected_bytes = nx * ny * 4
        timesteps = cycle["timesteps"]
        assert len(timesteps) == nt

        for ts in timesteps:
            scalar_bin = web_out / ts["files"]["sconc_dust"]["scalar"]
            assert scalar_bin.stat().st_size == expected_bytes
            buf = np.frombuffer(scalar_bin.read_bytes(), dtype=np.float32)
            assert not np.isnan(buf).any()
            assert float(np.min(buf)) >= 0.0

        deploy_script = repo_dir / "scripts" / "deploy_to_portal.sh"
        subprocess.run(
            [
                "bash",
                str(deploy_script),
                "--input", str(synth_nc),
                "--cycle", "20261022_00",
                "--output", str(web_out),
                "--workers", "2",
            ],
            env={**dict(__import__("os").environ), "PALM_RUN_ROOT": str(tmp_path / "no_palm")},
            check=True,
        )
        for req_asset in (
            "index.html",
            "css/styles.css",
            "js/app.js",
            "js/scalar-layer.js",
            "js/buildings-layer.js",
            "js/grid-coords.js",
            "js/wind-particles.js",
            "js/map-engine.js",
        ):
            assert (web_out / req_asset).exists(), f"Missing deployed asset: {req_asset}"

        handler = http.server.SimpleHTTPRequestHandler
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a: handler(*a, directory=str(web_out)))
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            base_url = f"http://127.0.0.1:{port}"
            with urllib.request.urlopen(f"{base_url}/manifest.json") as resp:
                assert resp.status == 200
            with urllib.request.urlopen(f"{base_url}/js/map-engine.js") as resp:
                assert "_applyEnglishLabels" in resp.read().decode()
        finally:
            server.shutdown()
        print("  -> Test 1 PASSED.")


def test_multidomain_15min_and_config_agnostic_palm() -> None:
    print("[Test 2] Multi-domain WRF (10 km + 2 km, 15-min) + PALM-4U (100 m + 1 m configs) + Uint16...")
    with tempfile.TemporaryDirectory(prefix="dusty_multi_") as tmpdir:
        tmp_path = Path(tmpdir)
        wrf_dir = tmp_path / "wrf_run"
        wrf_dir.mkdir()
        palm_root = tmp_path / "palm_oper"
        web_out = tmp_path / "portal"

        mins = [0, 15, 30, 45, 60]
        create_synthetic_wrfout(wrf_dir / "wrfout_d01_2026-11-14_00_00_00", 10000.0, 30, 25, 51.0, 25.5, mins)
        create_synthetic_wrfout(wrf_dir / "wrfout_d02_2026-11-14_00_00_00", 2000.0, 28, 24, 51.5, 25.3, mins)

        # Two completely different PALM configs (100m urban + 1m microscale street canyon w/ static buildings+canopy)
        create_synthetic_palm_run(palm_root / "doha_urban_100m", "20261114_00", 100.0, 24, 24, 25.25, 51.48)
        create_synthetic_palm_run(palm_root / "doha_micro_1m", "20261114_00", 1.0, 32, 32, 25.285, 51.505, with_static=True)

        mpath = export_forecast(
            input_path=wrf_dir,
            output_dir=web_out,
            cycle_str="20261114_00",
            workers=2,
            palm_root=palm_root,
        )
        manifest = json.loads(mpath.read_text(encoding="utf-8"))
        cycle = manifest["cycles"][0]
        models = cycle["models"]
        assert len(models) == 4, f"Expected 4 models (10km, 2km, 100m, 1m), got {[m['id'] for m in models]}"

        # Verify sorting: coarsest -> finest
        resolutions = [m["resolution_m"] for m in models]
        assert resolutions == sorted(resolutions, reverse=True), f"Unsorted resolutions: {resolutions}"
        badges = [m["badge"] for m in models]
        assert badges == ["10 km", "2 km", "100 m", "1 m"], f"Unexpected badges: {badges}"

        # Verify native 15-min steps preserved on WRF d01 & d02
        wrf_steps = models[0]["timesteps"]
        assert [t["lead_seconds"] for t in wrf_steps] == [0, 900, 1800, 2700, 3600]
        assert [t["lead_label"] for t in wrf_steps] == ["T+00", "T+00:15", "T+00:30", "T+00:45", "T+01"]

        # Verify PALM NaN building cutout, native quad, dissolved 3D buildings, and canopy
        palm_1m = models[-1]
        assert palm_1m["grid"]["has_nan_mask"] is True
        assert isinstance(palm_1m["grid"].get("canvas_quad"), list) and len(palm_1m["grid"]["canvas_quad"]) == 4
        assert palm_1m.get("buildings_3d") is not None, "Expected buildings_3d metadata for 1m static driver"
        assert palm_1m["buildings_3d"]["feature_count"] == 1, f"Expected 1 dissolved polygon, got {palm_1m['buildings_3d']}"
        assert palm_1m["buildings_3d"]["max_height_m"] == 14.5
        assert (web_out / palm_1m["buildings_3d"]["url"]).exists()
        assert palm_1m.get("canopy_3d") is not None and palm_1m["canopy_3d"]["feature_count"] >= 1
        assert (web_out / palm_1m["canopy_3d"]["url"]).exists()

        bin_1m = web_out / palm_1m["timesteps"][0]["files"]["no2"]["scalar"]
        arr_1m = np.frombuffer(bin_1m.read_bytes(), dtype=np.float32)
        assert np.isnan(arr_1m).any(), "Expected NaN building mask to be preserved!"
        assert np.nanmean(arr_1m) > 20.0, "Expected kc_NO2 (0.025 ppm -> 25 ppbv)"

        # Verify Uint16 round-trip with NaN mask
        big = np.array([[np.nan, 10.0], [25.5, 40.0]], dtype=np.float32)
        u16_fp = tmp_path / "test_u16.bin"
        meta = _write_array_bin(big, u16_fp, use_uint16=True)
        assert meta["encoding"] == "uint16"
        codes = np.frombuffer(u16_fp.read_bytes(), dtype=np.uint16).reshape(2, 2)
        assert codes[0, 0] == 0
        decoded = meta["qmin"] + ((codes[0, 1] - 1) / 65534.0) * (meta["qmax"] - meta["qmin"])
        assert abs(decoded - 10.0) < 1e-3

        print("  -> Test 2 PASSED.")


def run_verification_test() -> None:
    print("======================================================================")
    print(" Running Dusty Earth Multi-Model Verification Suite")
    print("======================================================================")
    test_single_model_and_http_serving()
    test_multidomain_15min_and_config_agnostic_palm()
    print("======================================================================")
    print(" ALL VERIFICATION CHECKS PASSED (100% OK)")
    print("======================================================================")


if __name__ == "__main__":
    run_verification_test()
