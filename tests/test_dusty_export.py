"""
End-to-End Verification Test for Dusty Earth.
Generates synthetic regular lat-lon forecast dataset, runs dusty-export,
validates binary Float32 buffer integrity, manifest schema, and static web serving.
"""

from __future__ import annotations
import http.server
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import numpy as np
import xarray as xr

from dusty.exporter import export_forecast
from dusty.registry import DEFAULT_REGISTRY


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
        # Moving Gaussian dust plume (Shamal event SE advection)
        cx = 45.0 + t * 0.8
        cy = 28.0 - t * 0.5
        plume = np.exp(-(((lon2d - cx) ** 2) / 12.0 + ((lat2d - cy) ** 2) / 8.0))

        # Surface dust in kg/m3 (will be converted * 1e9 -> ug/m3)
        sconc[t] = (20.0 + 850.0 * plume) * 1e-9
        # Dust load in kg/m2 (will be converted * 1e6 -> mg/m2)
        dust_load[t] = (50.0 + 1800.0 * plume) * 1e-6
        # AOD 550nm
        dod550[t] = 0.08 + 1.6 * plume
        # 2m Temp in Kelvin
        t2m[t] = 295.15 + 12.0 * np.sin((t / nt) * np.pi) - 0.3 * (lat2d - 15.0)
        # Wind components in m/s
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


def run_verification_test() -> None:
    print("======================================================================")
    print(" Running Dusty Earth End-to-End Verification Test")
    print("======================================================================")

    repo_dir = Path(__file__).resolve().parent.parent

    with tempfile.TemporaryDirectory(prefix="dusty_test_") as tmpdir:
        tmp_path = Path(tmpdir)
        synth_nc = tmp_path / "synthetic_dust.nc"
        web_out = tmp_path / "web_portal"

        nx, ny, nt = 80, 60, 4
        print(f"[1/4] Generating synthetic forecast NetCDF ({nt} steps, {nx}x{ny})...")
        create_synthetic_forecast(synth_nc, nt=nt, nx=nx, ny=ny)
        assert synth_nc.exists(), "Failed to create synthetic NetCDF"

        print("[2/4] Executing dusty-export binary grid engine...")
        manifest_path = export_forecast(
            input_path=synth_nc,
            output_dir=web_out,
            cycle_str="20261022_00",
            workers=2,
        )
        assert manifest_path.exists(), f"manifest.json missing at {manifest_path}"

        print("[3/4] Validating Float32 binary file sizes, buffer layouts & stats...")
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        assert manifest.get("app") == "Dusty Earth"
        assert len(manifest["cycles"]) >= 1
        cycle = manifest["cycles"][0]
        assert cycle["id"] == "20261022_00"

        grid = cycle["grid"]
        assert grid["nx"] == nx and grid["ny"] == ny
        expected_bytes = nx * ny * 4  # 4 bytes per Float32

        timesteps = cycle["timesteps"]
        assert len(timesteps) == nt

        checked_bin_count = 0
        for ts in timesteps:
            assert "sconc_dust" in ts["files"]
            assert "wind10m" in ts["files"]

            # Validate scalar binary
            scalar_rel = ts["files"]["sconc_dust"]["scalar"]
            scalar_bin = web_out / scalar_rel
            assert scalar_bin.exists(), f"Missing binary file: {scalar_bin}"
            assert scalar_bin.stat().st_size == expected_bytes, (
                f"Binary size mismatch: got {scalar_bin.stat().st_size}, expected {expected_bytes}"
            )

            # Read back buffer with numpy to verify data values
            buf = np.frombuffer(scalar_bin.read_bytes(), dtype=np.float32)
            assert not np.isnan(buf).any(), "Found NaN in binary buffer"
            assert float(np.min(buf)) >= 0.0, "Unexpected negative dust concentration"
            checked_bin_count += 1

            # Validate vector binaries (u and v)
            u_rel = ts["files"]["wind10m"]["u"]
            v_rel = ts["files"]["wind10m"]["v"]
            u_bin = web_out / u_rel
            v_bin = web_out / v_rel
            assert u_bin.stat().st_size == expected_bytes
            assert v_bin.stat().st_size == expected_bytes
            checked_bin_count += 2

        print(f"  -> Verified {checked_bin_count} binary (.bin) grid files successfully.")

        print("[4/4] Verifying static web frontend synchronization and HTTP serving...")
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
            check=True,
        )

        for req_asset in ("index.html", "css/styles.css", "js/app.js", "js/scalar-layer.js", "js/wind-particles.js"):
            assert (web_out / req_asset).exists(), f"Missing deployed asset: {req_asset}"

        # Spin up quick ephemeral HTTP server to test real browser fetch
        handler = http.server.SimpleHTTPRequestHandler
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a: handler(*a, directory=str(web_out)))
        port = server.server_address[1]

        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()

        try:
            base_url = f"http://127.0.0.1:{port}"
            # Test manifest
            with urllib.request.urlopen(f"{base_url}/manifest.json") as resp:
                assert resp.status == 200
                data = json.loads(resp.read().decode())
                assert data["app"] == "Dusty Earth"

            # Test index.html
            with urllib.request.urlopen(f"{base_url}/index.html") as resp:
                assert resp.status == 200
                html = resp.read().decode()
                assert "Dusty Earth" in html

            # Test binary grid download
            first_bin = cycle["timesteps"][0]["files"]["sconc_dust"]["scalar"]
            with urllib.request.urlopen(f"{base_url}/{first_bin}") as resp:
                assert resp.status == 200
                raw_bin = resp.read()
                assert len(raw_bin) == expected_bytes
            print(f"  -> HTTP Serving test PASSED on http://127.0.0.1:{port}")
        finally:
            server.shutdown()

    print("======================================================================")
    print(" ALL VERIFICATION CHECKS PASSED (100% OK)")
    print("======================================================================")


if __name__ == "__main__":
    run_verification_test()
