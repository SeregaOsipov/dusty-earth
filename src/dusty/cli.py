"""
Command-Line Interface for Dusty Earth Exporter (dusty-export).
"""

from __future__ import annotations
import argparse
import os
from pathlib import Path
import sys
from typing import Optional, Sequence

from .exporter import export_forecast
from .registry import DEFAULT_REGISTRY, VariableRegistry


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="dusty-export",
        description="High-performance binary grid exporter for Dusty Earth (GPU-accelerated WebGL forecast viewer).",
    )
    parser.add_argument(
        "-i", "--input",
        dest="input_path",
        required=True,
        type=Path,
        help="Path to input NetCDF file or directory containing model outputs (wrfout, icon-art, cams).",
    )
    parser.add_argument(
        "-o", "--output",
        dest="output_dir",
        required=True,
        type=Path,
        help="Output web root directory where binary grids and manifest.json will be written.",
    )
    parser.add_argument(
        "-c", "--cycle",
        dest="cycle_str",
        default=None,
        type=str,
        help="Cycle identifier (e.g. 20261022_00). If omitted, derived from file timestamps.",
    )
    parser.add_argument(
        "-v", "--variables",
        dest="variables",
        nargs="*",
        default=None,
        help=f"Subset of variable IDs to export. Available: {list(DEFAULT_REGISTRY.keys())}",
    )
    parser.add_argument(
        "-w", "--workers",
        dest="workers",
        type=int,
        default=min(8, os.cpu_count() or 4),
        help="Number of parallel worker processes (default: min(8, cpu_count)).",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> None:
    args = parse_args(argv)
    try:
        export_forecast(
            input_path=args.input_path,
            output_dir=args.output_dir,
            cycle_str=args.cycle_str,
            variables=args.variables,
            workers=args.workers,
        )
    except Exception as e:
        print(f"\n[ERROR] dusty-export failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
