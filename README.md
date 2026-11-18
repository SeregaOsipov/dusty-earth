# Dusty Earth (`dusty.earth`)

[![Status](https://img.shields.io/badge/Status-Operational-emerald)]()
[![Platform](https://img.shields.io/badge/Platform-Static%20WebGL%20%2F%20MapLibre-blue)]()
[![Python](https://img.shields.io/badge/Python-3.10%2B-informational)]()

> **Dusty Earth** is a standalone, GPU-accelerated (WebGL / MapLibre GL) multi-scale visualization platform for operational numerical weather, air quality, and greenhouse gas forecasts (`WRF-Chem`, `PALM-4U`, `ICON-ART`). Designed to zoom seamlessly from synoptic/regional dust storms (`10 km` / `2 km`) down to city-scale SLUrb (`100 m`) and building-resolving urban LES (`10 m` / `1 m`) at sub-hourly and `1-minute` temporal cadences.

---

## Key Highlights

- **Windy-Style Multi-Model Switching & Auto-Zoom Hysteresis**:
  Co-registers `WRF-Chem 10 km` (`d01`), `WRF-Chem 2 km` (`d02`), `PALM-4U 100 m` (`SLUrb`), and `PALM-4U 10 m / 1 m` inside a single cycle manifest (`manifest.json`), with automatic zoom-driven switching hysteresis (`6.8/6.3`, `10.5/10.0`, `12.2/11.7`, `14.0/13.5`), auto-tilt on urban LES zoom-in, and manual model pinning.
- **WebGL Scene-Graph `CanvasSource` & 3D Urban Morphology**:
  Renders scalar fields natively inside MapLibre's WebGL scene graph via `CanvasSource` (`nearest` texel filtering on PALM building masks), overlaid with 1:1 dissolved 3D static-driver buildings and 3-tier LAD tree canopy polygons (`buildings_extractor.py`, `buildings-layer.js`) plus a regional OpenFreeMap 3D context cutout.
- **Four Operational Variable Tabs (`Dust & Aerosols`, `Gases`, `GHGs`, `Meteorology`)**:
  Covers `Surface Dust`, `Column Dust`, `PM2.5`, `PM10`, `NO₂`, `NOx`, `Ozone (O₃)`, `SO₂`, `CO`, **greenhouse gases (`CO₂` in `ppm` [415–465], `CH₄` in `ppbv` [1850–2650] with model-agnostic `ppmv` / `kg kg-1` / `mol mol-1` converters and `0.1 ppm` CO₂ probe precision)**, `10m Wind`, `2m Temperature`, `Rain Rate`, `Accum. Rain`, `Cloud Cover`, `Solar GHI`, and `Net Solar SW`.
- **Constant Physical Playback Speed (`0.25–8 h/s`) Across Mixed Cadences**:
  Driven by a virtual UTC forecast clock (`playheadMs` / `syncToUtc`, default **`3h/s`**) so real-world advection speed stays constant when switching between `1 h`, `15 min`, `10 min` WRF, and `1 min` PALM outputs — finer output frequencies simply play smoother.
- **`1 m` Spatial & `1-Minute` (`1,440`-Step) Streaming Scalability**:
  - Worker-batched NetCDF extraction (`_export_timestep_batch_task`) reusing open file handles and KDTree weights.
  - Automatic **`Uint16` (`2 bytes/cell`) quantization** (`decodeFieldBuffer`) when frames exceed `1,000,000` cells or cycles exceed `40,000,000` total cell-steps (50% payload & memory reduction).
  - Compact `manifest.json` (`1.04 MB` at `1,440` steps), byte-budgeted LRU caches (`256 MB` scalar, `128 MB` wind), `inFlight` HTTP fetch deduplication, persistent `ImageData` reuse, and WebGL `MAX_TEXTURE_SIZE` downsampling stride.
- **Silky-Smooth 60 FPS Wind Streamlines & Urban Weather Probe**:
  Zoom-adaptive particle streamlines (default `1000` particles at `2x` speed) constrained to visible bounds and masked around NaN building obstacles, plus a bilinear cursor probe displaying concentration, wind speed/direction, and 3D building heights.
- **Meteorological Keyboard Shortcuts**:
  Full keyboard control (`Space`, `←` / `→`, `Shift + ←` / `→`, `↑` / `↓`, `Home` / `End`, `W`, `B`, `T`, `L`, `I`).

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
│       ├── buildings_extractor.py # Dissolved 3D PALM static buildings & 3-tier LAD canopy GeoJSON
│       ├── cli.py               # dusty-export command-line interface
│       ├── exporter.py          # Batched multiprocess Float32/Uint16 exporter & manifest compiler
│       ├── grid_extractor.py    # Robust xarray/pyproj coordinate, KDTree & field extractor
│       └── registry.py          # Pluggable variable, unit-converter & colormap registry (incl. GHGs)
├── tests/
│   └── test_dusty_export.py     # End-to-end multi-model, Uint16, 3D building & HTTP test suite
└── web/                         # Self-contained static WebGL application
    ├── index.html               # Main application layout
    ├── css/
    │   └── styles.css           # Modern dark-mode Windy-style styling
    ├── js/
    │   ├── app.js               # Multi-model auto-zoom, layer dock & attribution controller
    │   ├── buildings-layer.js   # MapLibre 3D PALM buildings, 3-tier canopy & OSM cutout layer
    │   ├── grid-coords.js       # Exact geographic grid quad & lon/lat bilinear index helpers
    │   ├── map-engine.js        # MapLibre GL JS wrapper & WebGL capability helpers
    │   ├── probe.js             # Bilinear scalar/wind + 3D building cursor sampling probe
    │   ├── scalar-layer.js      # CanvasSource WebGL scalar renderer (Uint16/Float32 + 256MB LRU)
    │   ├── timeline.js          # Virtual UTC clock (h/s speed) & sub-hourly timeline scrubber
    │   └── wind-particles.js    # Zoom-scaled 60 FPS particle streamline engine (128MB LRU)
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
  --input /scratch/sims/WRF_run/operational_forecast/ag_weekly_7day_cycle/output/20261114_00 \
  --palm-root /scratch/sims/PALM_run/operational_forecast \
  --output /scratch/sims/WRF_run/operational_forecast/portal_web \
  --cycle 20261114_00 \
  --workers 6
```

Parameters:
- `-i, --input`: Path to a NetCDF/wrfout file or directory containing model outputs.
- `-o, --output`: Web portal root directory where `index.html`, `manifest.json`, and `cycles/` reside (served at `http://10.161.93.144:8080/`, while the legacy static WebP portal resides at `/static`).
- `-c, --cycle`: (Optional) Forecast cycle ID (e.g. `20261114_00`). Automatically detected if omitted.
- `--palm-root`: (Optional) Root directory of PALM-4U runs (`doha_forecast_100m`, `doha_forecast_chem`) to auto-discover and co-register matching cycle runs alongside static 3D buildings/canopy.
- `--extra-input`: (Optional) Additional model output directories/files to co-register in the cycle.
- `-v, --variables`: (Optional) Comma-separated / space-separated variable IDs to export (defaults to all registered).
- `-w, --workers`: Number of parallel multiprocessing workers for batched grid extraction (default: `min(8, cpu_count)`).

### 3. Operational Automation (Stage 4 Integration)

Automatically invoked by `/home/osipovs/Models/operational-forecasting/scripts/run_portal_postproc.sh` at the end of every forecast simulation (or run standalone) to deploy new cycles (including auto-detected PALM-4U runs via `--palm-root`) to the root portal and prune cycles older than 5 days:

```bash
./scripts/deploy_to_portal.sh \
  --input /scratch/sims/WRF_run/operational_forecast/ag_weekly_7day_cycle/output/20261114_00 \
  --palm-root /scratch/sims/PALM_run/operational_forecast \
  --output /scratch/sims/WRF_run/operational_forecast/portal_web \
  --retention-days 5
```

---

## Variable Registry & Extension

All variables are defined centrally in `src/dusty/registry.py`, grouped across four UI tabs (`Dust & Aerosols`, `Gases`, `GHGs`, `Meteorology`). Model-agnostic converters (`convert_co2_ppm`, `convert_ch4_ppbv`, `convert_sconc_dust`, etc.) automatically normalize `kg/kg`, `ppmv`, `mol/mol`, `kg/m³`, or `K` inputs. To add a new diagnostic (e.g., Sea Salt concentration):

```python
DEFAULT_REGISTRY["sconc_seasalt"] = VariableConfig(
    id="sconc_seasalt",
    name="Surface Sea Salt Concentration",
    short_name="Sea Salt",
    units="µg/m³",
    category="aerosol",
    candidate_vars=["SEAS_1", "SEAS_2", "seasalt_conc", "salsa_s_SS", "salsa_s_SS_xy"],
    vmin=0.0,
    vmax=200.0,
    colormap_stops=[
        ColormapStop(0.00, (255, 255, 255, 0)),
        ColormapStop(0.10, (224, 243, 248, 120)),
        ColormapStop(0.50, (69, 117, 180, 200)),
        ColormapStop(1.00, (49, 54, 149, 230)),
    ],
    unit_converter=lambda arr, meta: arr * 1e9,  # e.g. kg/m³ to µg/m³
)
```

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Space` | Play / Pause continuous animation loop (`h/s` constant speed) |
| `←` / `→` | Step backward / forward by 1 native timestep (e.g. `1h`, `10m`, or `1m`) |
| `Shift + ←` / `→` | Jump backward / forward by ±1 hour UTC across sub-hourly frames |
| `↑` / `↓` | Switch to previous / next forecast variable layer |
| `Home` / `End` | Jump to forecast initialization ($T+00$) / final timestep |
| `W` | Toggle animated wind streamlines overlay |
| `B` | Toggle 3D urban buildings layer |
| `T` | Toggle 3D PALM vegetation canopy layer |
| `L` | Toggle loop mode (Continuous `Repeat` vs `Bounce`) |
| `I` | Open System & Scientific Attribution modal (`Esc` to close) |

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
