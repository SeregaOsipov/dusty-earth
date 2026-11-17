# Dusty Earth (`dusty.earth`)

[![Status](https://img.shields.io/badge/Status-Operational-emerald)]()
[![Platform](https://img.shields.io/badge/Platform-Static%20WebGL%20%2F%20MapLibre-blue)]()
[![Python](https://img.shields.io/badge/Python-3.10%2B-informational)]()

> **Dusty Earth** is a standalone, GPU-accelerated (WebGL / MapLibre GL) interactive visualization platform for operational numerical weather and chemistry forecasts (Windy.com style). Designed specifically for atmospheric mineral dust, aerosols, and regional meteorology.

---

## Key Highlights

- **100% Static File Serving (Tier 1 Architecture)**:
  Zero dynamic Python runtime or heavyweight GIS server required for browsing. The web client is served entirely as static HTML5, CSS, and ES Modules through Nginx, Apache, or cloud object storage.
- **Zero-JSON Gridded Data Payloads**:
  Instead of bloated JSON or slow GeoTIFF decoders, spatial fields are dumped into contiguous, flat **`Float32` Binary (`.bin`)** files. The browser memory-maps them instantly with `new Float32Array(arrayBuffer)` with sub-millisecond overhead.
- **Silky-Smooth 60 FPS Wind Streamlines**:
  Flowing particle animation driven by continuous bilinear sampling of 10m $(U, V)$ vector fields with glowing trail fading and custom density/speed controls (default `1000` particles at `2x` speed).
- **Interactive Weather Probe**:
  Hovering or clicking anywhere on the map bilinearly interpolates active scalar concentrations, wind speed, and meteorological wind direction (16 cardinal points + degrees).
- **Pluggable Species & Variable Registry**:
  Easily add new chemical species (PM10, SO2, O3, NO2, AOD) or meteorological variables by adding a single entry to `src/dusty/registry.py` with custom colormap stops and unit converters.
- **Meteorological Keyboard Shortcuts**:
  Fully controllable via standard weather operations shortcuts (`Space`, `←` / `→`, `↑` / `↓`, `Home` / `End`, `W`, `L`).

---

## Repository Structure

```text
dusty-earth/
├── pyproject.toml               # Python package configuration (dusty-export CLI)
├── README.md                    # System documentation
├── scripts/
│   └── deploy_to_portal.sh      # Operational Stage 4 deployment & retention hook
├── src/
│   └── dusty/
│       ├── __init__.py          # Package initialization
│       ├── cli.py               # dusty-export command-line interface
│       ├── exporter.py          # Multiprocess Float32 binary grid export engine
│       ├── grid_extractor.py    # Robust xarray coordinate & field extractor
│       └── registry.py          # Pluggable variable and colormap registry
├── tests/
│   └── test_dusty_export.py     # End-to-end integration and HTTP verification suite
└── web/                         # Self-contained static WebGL application
    ├── index.html               # Main application layout
    ├── css/
    │   └── styles.css           # Modern dark-mode Windy-style styling
    ├── js/
    │   ├── app.js               # Main application controller
    │   ├── map-engine.js        # MapLibre GL JS wrapper
    │   ├── probe.js             # Bilinear cursor sampling probe
    │   ├── scalar-layer.js      # Float32 grid canvas & colormap LUT renderer
    │   ├── timeline.js          # Lead-time animation scrubber & transport
    │   └── wind-particles.js    # 60 FPS particle streamline engine
    └── vendor/
        ├── maplibre-gl.css      # Offline MapLibre styles
        └── maplibre-gl.js       # Offline MapLibre GL bundle
```

---

## Quick Start & Installation

### 1. Install the Python Exporter CLI

Install `dusty-earth` in editable development mode within your active Python environment:

```bash
cd /home/osipovs/Models/dusty-earth
pip install -e .
```

### 2. Export Model Forecasts to Binary Grids

Run `dusty-export` against any standard WRF-Chem or NetCDF forecast file or directory:

```bash
dusty-export \
  --input /scratch/sims/WRF_run/operational_forecast/ag_weekly_7day_cycle/run \
  --output /scratch/sims/WRF_run/operational_forecast/portal_web \
  --cycle 20261025_00 \
  --workers 6
```

Parameters:
- `-i, --input`: Path to a NetCDF/wrfout file or directory containing model outputs.
- `-o, --output`: Web portal root directory where `index.html`, `manifest.json`, and `cycles/` reside (served at `http://10.161.93.144:8080/`, while the legacy static WebP portal resides at `/static`).
- `-c, --cycle`: (Optional) Forecast cycle ID (e.g. `20261025_00`). Automatically detected if omitted.
- `-v, --variables`: (Optional) Comma-separated variable IDs to export (defaults to all registered).
- `-w, --workers`: Number of parallel multiprocessing workers for grid rendering (default: 4).

### 3. Operational Automation (Stage 4 Integration)

Automatically invoked by `/home/osipovs/Models/operational-forecasting/scripts/run_portal_postproc.sh` at the end of every forecast simulation (or run standalone) to deploy new cycles to the root portal and prune cycles older than 5 days:

```bash
./scripts/deploy_to_portal.sh \
  --input /scratch/sims/WRF_run/operational_forecast/ag_weekly_7day_cycle/run \
  --output /scratch/sims/WRF_run/operational_forecast/portal_web \
  --retention-days 5
```

---

## Variable Registry & Extension

All variables are defined centrally in `src/dusty/registry.py`. To add a new diagnostic (e.g., Sea Salt concentration):

```python
REGISTRY.register(
    VariableConfig(
        id="sconc_seasalt",
        name="Surface Sea Salt Concentration",
        short_name="Sea Salt",
        units="µg/m³",
        category="chemistry",
        candidate_vars=["SEAS_1", "SEAS_2", "seasalt_conc"],
        vmin=0.0,
        vmax=200.0,
        colormap=[
            ColorStop(0.00, (255, 255, 255, 0)),
            ColorStop(0.10, (224, 243, 248, 120)),
            ColorStop(0.50, (69, 117, 180, 200)),
            ColorStop(1.00, (49, 54, 149, 230)),
        ],
        unit_converter=lambda arr, attrs: arr * 1e9,  # e.g. kg/kg to µg/m³
    )
)
```

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | Play / Pause continuous animation loop |
| `←` / `→` | Step backward / forward by 1 timestep |
| `↑` / `↓` | Switch to previous / next forecast variable layer |
| `Home` / `End` | Jump to forecast initialization ($T+00$) / final timestep |
| `W` | Toggle animated wind streamlines overlay |
| `L` | Toggle loop mode (Continuous `Repeat` vs `Bounce`) |

---

## Verification & Testing

Dusty Earth includes an automated end-to-end synthetic test suite verifying binary byte layouts, manifest integrity, and static HTTP serving:

```bash
python tests/test_dusty_export.py
```

---

## Future Improvements & Roadmap

- **Lateral Boundary Relaxation Zone Switch / Diagnostic View**:
  - By design, `dusty-export` exports the full model grid (`0..nx-1`, `0..ny-1`) including the WRF lateral boundary sponge/relaxation zone (`spec_bdy_width = 5`: `1` specified cell + `4` relaxation cells) so boundary conditions can be diagnosed internally.
  - **Planned Feature**: Add a UI toggle (or a dedicated diagnostic view/page) allowing users to dynamically show or hide/mask the lateral boundary relaxation zone (`spec_bdy_width = 5`) on the WebGL canvas.
