#!/usr/bin/env bash
# ==============================================================================
# Dusty Earth Operational Integration & Deployment Hook (Stage 4)
#
# Automatically executes after forecast completion:
#   1. Resolves completed forecast NetCDF/wrfout outputs.
#   2. Syncs Dusty Earth static frontend assets (`web/`) into the portal root.
#   3. Runs `dusty-export` to generate zero-overhead Float32 binary grids (.bin)
#      and manifest.json.
#   4. Prunes rendered cycles older than RETENTION_DAYS (default: 5 days).
# ==============================================================================
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Default Configuration
CYCLE=""
INPUT_DIR=""
OUTPUT_DIR="/scratch/sims/WRF_run/operational_forecast/portal_web"
WORKERS=16
RETENTION_DAYS=5

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Exports operational numerical forecast fields to Dusty Earth GPU-accelerated binary format.

Options:
  --input PATH          Path to directory or file containing model outputs (wrfout, icon, etc.)
  --cycle ID            Forecast cycle ID (e.g. 20261022_00). Auto-derived if omitted.
  --output PATH         Target web portal directory (default: ${OUTPUT_DIR})
  --workers N           Number of parallel export processes (default: ${WORKERS})
  --retention-days N    Number of daily cycles to retain (default: ${RETENTION_DAYS})
  -h, --help            Show this help message
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --input)
            INPUT_DIR="$2"
            shift 2
            ;;
        --cycle)
            CYCLE="$2"
            shift 2
            ;;
        --output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --workers)
            WORKERS="$2"
            shift 2
            ;;
        --retention-days)
            RETENTION_DAYS="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# 1. Bootstrap Python Environment
PYTHON_BIN=""
if [ -x "${HOME}/apps/miniforge3/envs/py312/bin/python" ]; then
    PYTHON_BIN="${HOME}/apps/miniforge3/envs/py312/bin/python"
elif command -v python3 &>/dev/null; then
    PYTHON_BIN="$(command -v python3)"
else
    echo "ERROR: Python 3 not found!"
    exit 1
fi

# 2. Locate Latest Model Output Directory if not specified
if [ -z "${INPUT_DIR}" ]; then
    CANDIDATE_RUN_DIRS=(
        "/scratch/sims/WRF_run/operational_forecast/ag_daily_1day_cycle/run"
        "/scratch/sims/WRF_run/operational_forecast/ag_weekly_7day_cycle/run"
        "/scratch/sims/WRF_run/operational_forecast/wrf_ag_2026_test/run"
    )
    for d in "${CANDIDATE_RUN_DIRS[@]}"; do
        if [ -d "${d}" ] && compgen -G "${d}/wrfout_d01_*" > /dev/null; then
            INPUT_DIR="${d}"
            break
        fi
    done
fi

if [ -z "${INPUT_DIR}" ] || [ ! -e "${INPUT_DIR}" ]; then
    echo "ERROR: Could not find valid forecast output in INPUT_DIR: '${INPUT_DIR}'"
    exit 1
fi

# 3. Synchronize Web Frontend Assets into Target Web Root
echo "[Dusty Earth] Synchronizing static WebGL frontend to ${OUTPUT_DIR}..."
mkdir -p "${OUTPUT_DIR}/cycles"
cp -f "${REPO_DIR}/web/index.html" "${OUTPUT_DIR}/index.html"
mkdir -p "${OUTPUT_DIR}/css" "${OUTPUT_DIR}/js" "${OUTPUT_DIR}/vendor"
cp -rf "${REPO_DIR}/web/css/"* "${OUTPUT_DIR}/css/"
cp -rf "${REPO_DIR}/web/js/"* "${OUTPUT_DIR}/js/"
if [ -d "${REPO_DIR}/web/vendor" ]; then
    cp -rf "${REPO_DIR}/web/vendor/"* "${OUTPUT_DIR}/vendor/"
fi

# 4. Execute dusty-export Binary Grid Pipeline
echo "[Dusty Earth] Exporting binary Float32/Uint16 grids from ${INPUT_DIR}..."
CMD=("${PYTHON_BIN}" -m dusty.cli -i "${INPUT_DIR}" -o "${OUTPUT_DIR}" -w "${WORKERS}")
if [ -n "${CYCLE}" ]; then
    CMD+=(-c "${CYCLE}")
fi
PALM_RUN_ROOT="${PALM_RUN_ROOT:-${WORK_DIR:-/scratch/sims}/PALM_run/operational_forecast}"
if [ -n "${PALM_RUN_ROOT}" ] && [ -d "${PALM_RUN_ROOT}" ]; then
    CMD+=(--palm-root "${PALM_RUN_ROOT}")
fi

"${CMD[@]}"

# 5. Prune Old Rendered Cycles (Keep newest RETENTION_DAYS cycles)
if [ -d "${OUTPUT_DIR}/cycles" ] && [ "${RETENTION_DAYS}" -gt 0 ]; then
    mapfile -t ALL_CYCLES < <(find "${OUTPUT_DIR}/cycles" -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort -r)
    TOTAL_CYCLES="${#ALL_CYCLES[@]}"
    if [ "${TOTAL_CYCLES}" -gt "${RETENTION_DAYS}" ]; then
        echo "[Dusty Earth Retention] Pruning $(( TOTAL_CYCLES - RETENTION_DAYS )) expired cycle(s)..."
        for (( i=RETENTION_DAYS; i<TOTAL_CYCLES; i++ )); do
            OLD_CYCLE="${ALL_CYCLES[$i]}"
            echo "  -> Removing expired cycle: ${OUTPUT_DIR}/cycles/${OLD_CYCLE}"
            rm -rf "${OUTPUT_DIR}/cycles/${OLD_CYCLE}"
        done

        # Clean manifest.json atomically
    fi
    "${PYTHON_BIN}" - "${OUTPUT_DIR}/manifest.json" "${OUTPUT_DIR}/cycles" << 'PYEOF'
import json, sys
from pathlib import Path
mpath = Path(sys.argv[1])
cdir = Path(sys.argv[2])
if mpath.exists():
    with open(mpath, "r", encoding="utf-8") as f:
        data = json.load(f)
    kept = [c for c in data.get("cycles", []) if (cdir / c.get("id", "")).exists()]
    data["cycles"] = kept
    data["default_cycle"] = kept[0]["id"] if kept else None
    tmp = mpath.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    tmp.replace(mpath)
PYEOF
fi

echo "[Dusty Earth] Stage 4 Deployment complete: ${OUTPUT_DIR}/manifest.json"
