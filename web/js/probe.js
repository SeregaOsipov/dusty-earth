/**
 * Interactive Weather Probe Tooltip for Dusty Earth.
 * Bilinearly samples active Float32/Uint16 scalar and vector buffers under the cursor,
 * handles NaN building cutouts gracefully (including 3D height lookup), and shows
 * active model resolution provenance.
 */

import { lonLatToGridIndices } from "./grid-coords.js";

export class WeatherProbe {
  constructor(containerElement, mapEngine, scalarLayer, windParticles) {
    this.el = containerElement;
    this.mapEngine = mapEngine;
    this.scalarLayer = scalarLayer;
    this.windParticles = windParticles;
    this.buildingsLayer = null;

    this.coordsEl = this.el.querySelector(".probe-coords");
    this.scalarEl = this.el.querySelector(".probe-scalar");
    this.windEl = this.el.querySelector(".probe-wind");

    this.pinned = false;
    this.lastLngLat = null;
    this.activeVarConfig = null;
    this.activeModelMeta = null;

    this._bindEvents();
  }

  setVarConfig(varConfig) {
    this.activeVarConfig = varConfig;
  }

  setModelMeta(modelMeta) {
    this.activeModelMeta = modelMeta;
  }

  setBuildingsLayer(buildingsLayer) {
    this.buildingsLayer = buildingsLayer;
  }

  _bindEvents() {
    const map = this.mapEngine.map;
    if (!map) return;

    map.on("mousemove", (e) => {
      if (this.pinned) return;
      this.update(e.lngLat, e.point);
    });

    map.on("click", (e) => {
      if (this.buildingsLayer && this.buildingsLayer.handleMapClick(e, this.activeModelMeta)) {
        this.pinned = false;
        this.el.classList.remove("pinned");
        this.hide();
        return;
      }
      this.pinned = !this.pinned;
      this.update(e.lngLat, e.point);
      if (this.pinned) {
        this.el.classList.add("pinned");
      } else {
        this.el.classList.remove("pinned");
      }
    });

    map.on("mouseout", () => {
      if (!this.pinned) {
        this.hide();
      }
    });

    this.mapEngine.onMove(() => {
      if (this.lastLngLat && this.el.classList.contains("visible")) {
        const point = this.mapEngine.project(this.lastLngLat.lng, this.lastLngLat.lat);
        this._positionTooltip(point.x, point.y);
      }
    });
  }

  sampleScalar(lon, lat) {
    const buf = this.scalarLayer.getCurrentBuffer();
    const meta = this.scalarLayer.gridMeta;
    if (!buf || !meta) return { value: null, inBounds: false };

    const pos = lonLatToGridIndices(lon, lat, meta);
    if (!pos.inBounds) {
      return { value: null, inBounds: false };
    }

    const { nx, ny } = meta;
    const col = pos.col;
    const row = pos.row;

    const c0 = Math.max(0, Math.min(nx - 1, Math.floor(col)));
    const r0 = Math.max(0, Math.min(ny - 1, Math.floor(row)));
    const c1 = Math.min(nx - 1, c0 + 1);
    const r1 = Math.min(ny - 1, r0 + 1);

    const fx = col - c0;
    const fy = row - r0;

    const s00 = buf[r0 * nx + c0];
    const s01 = buf[r0 * nx + c1];
    const s10 = buf[r1 * nx + c0];
    const s11 = buf[r1 * nx + c1];

    if (
      Number.isNaN(s00) || Number.isNaN(s01) || Number.isNaN(s10) || Number.isNaN(s11)
    ) {
      const nc = Math.max(0, Math.min(nx - 1, Math.round(col)));
      const nr = Math.max(0, Math.min(ny - 1, Math.round(row)));
      const nearVal = buf[nr * nx + nc];
      if (Number.isNaN(nearVal)) {
        return { value: null, inBounds: true };
      }
      return { value: nearVal, inBounds: true };
    }

    const v0 = (1 - fx) * s00 + fx * s01;
    const v1 = (1 - fx) * s10 + fx * s11;
    return { value: (1 - fy) * v0 + fy * v1, inBounds: true };
  }

  update(lngLat, point) {
    this.lastLngLat = lngLat;
    const lon = lngLat.lng;
    const lat = lngLat.lat;

    const scalarRes = this.sampleScalar(lon, lat);
    const scalarVal = scalarRes.value;
    const windVec = this.windParticles.sampleVector(lon, lat);

    const meta = this.scalarLayer.gridMeta;
    const isMicroMask = Boolean(
      scalarRes.inBounds && scalarVal === null && meta && meta.has_nan_mask && meta.dx_m > 0 && meta.dx_m <= 250
    );

    if (scalarVal === null && windVec === null && !isMicroMask) {
      this.hide();
      return;
    }

    const resM = meta && meta.dx_m ? meta.dx_m : 10000;
    const decimals = resM < 50 ? 5 : resM < 500 ? 4 : resM < 5000 ? 3 : 2;
    const latDir = lat >= 0 ? "°N" : "°S";
    const lonDir = lon >= 0 ? "°E" : "°W";
    const modelTag = this.activeModelMeta ? ` · ${this.activeModelMeta.short_name}` : "";
    this.coordsEl.textContent = `${Math.abs(lat).toFixed(decimals)}${latDir}, ${Math.abs(lon).toFixed(decimals)}${lonDir}${modelTag}`;

    if (scalarVal !== null && this.activeVarConfig) {
      const units = this.activeVarConfig.units || "";
      const name = this.activeVarConfig.short_name || this.activeVarConfig.name;
      const formatted =
        this.activeVarConfig.id === "co2"
          ? scalarVal.toFixed(1)
          : scalarVal >= 100
          ? scalarVal.toFixed(0)
          : scalarVal >= 10
          ? scalarVal.toFixed(1)
          : scalarVal.toFixed(2);
      this.scalarEl.textContent = `${name}: ${formatted} ${units}`;
      this.scalarEl.style.display = "block";
    } else if (isMicroMask) {
      const bHit = this.buildingsLayer ? this.buildingsLayer.queryBuildingAt(point) : null;
      const bH = bHit && bHit.properties ? Number(bHit.properties.height_agl ?? bHit.properties.render_height) : Number.NaN;
      this.scalarEl.textContent = Number.isFinite(bH) ? `🏢 Building (${bH.toFixed(1)} m AGL)` : "Building / Obstacle";
      this.scalarEl.style.display = "block";
    } else {
      this.scalarEl.style.display = "none";
    }

    if (windVec) {
      const [u, v] = windVec;
      const speed = Math.hypot(u, v);
      let deg = (Math.atan2(-u, -v) * 180.0) / Math.PI;
      if (deg < 0) deg += 360.0;

      const cardinals = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
      const cardIdx = Math.round(deg / 22.5) % 16;
      const cardinal = cardinals[cardIdx];

      this.windEl.innerHTML = `<span>💨 ${speed.toFixed(1)} m/s</span> <span style="color:var(--text-muted)">(${cardinal} ${deg.toFixed(0)}°)</span>`;
      this.windEl.style.display = "flex";
    } else {
      this.windEl.style.display = "none";
    }

    this._positionTooltip(point.x, point.y);
    this.show();
  }

  _positionTooltip(x, y) {
    const margin = 16;
    const tooltipW = 225;
    const tooltipH = 85;

    let posX = x + margin;
    let posY = y + margin;

    if (posX + tooltipW > window.innerWidth) {
      posX = x - tooltipW - margin;
    }
    if (posY + tooltipH > window.innerHeight) {
      posY = y - tooltipH - margin;
    }

    this.el.style.left = `${posX}px`;
    this.el.style.top = `${posY}px`;
  }

  show() {
    this.el.classList.add("visible");
  }

  hide() {
    if (!this.pinned) {
      this.el.classList.remove("visible");
    }
  }
}
