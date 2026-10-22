/**
 * Interactive Weather Probe Tooltip for Dusty Earth.
 * Bilinearly samples active Float32 scalar and vector buffers under the cursor
 * and renders a sleek floating telemetry badge.
 */

export class WeatherProbe {
  constructor(containerElement, mapEngine, scalarLayer, windParticles) {
    this.el = containerElement;
    this.mapEngine = mapEngine;
    this.scalarLayer = scalarLayer;
    this.windParticles = windParticles;

    this.coordsEl = this.el.querySelector(".probe-coords");
    this.scalarEl = this.el.querySelector(".probe-scalar");
    this.windEl = this.el.querySelector(".probe-wind");

    this.pinned = false;
    this.lastLngLat = null;
    this.activeVarConfig = null;

    this._bindEvents();
  }

  setVarConfig(varConfig) {
    this.activeVarConfig = varConfig;
  }

  _bindEvents() {
    const map = this.mapEngine.map;
    if (!map) return;

    map.on("mousemove", (e) => {
      if (this.pinned) return;
      this.update(e.lngLat, e.point);
    });

    map.on("click", (e) => {
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
    if (!buf || !meta) return null;

    const { nx, ny, lon_min, lon_max, lat_min, lat_max, dx, dy } = meta;
    if (lon < lon_min || lon > lon_max || lat < lat_min || lat > lat_max) {
      return null;
    }

    const col = (lon - lon_min) / dx;
    const row = (lat_max - lat) / dy; // North-to-South row orientation

    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = Math.min(nx - 1, c0 + 1);
    const r1 = Math.min(ny - 1, r0 + 1);

    const fx = col - c0;
    const fy = row - r0;

    const idx00 = r0 * nx + c0;
    const idx01 = r0 * nx + c1;
    const idx10 = r1 * nx + c0;
    const idx11 = r1 * nx + c1;

    const v0 = (1 - fx) * buf[idx00] + fx * buf[idx01];
    const v1 = (1 - fx) * buf[idx10] + fx * buf[idx11];
    return (1 - fy) * v0 + fy * v1;
  }

  update(lngLat, point) {
    this.lastLngLat = lngLat;
    const lon = lngLat.lng;
    const lat = lngLat.lat;

    const scalarVal = this.sampleScalar(lon, lat);
    const windVec = this.windParticles.sampleVector(lon, lat);

    if (scalarVal === null && windVec === null) {
      this.hide();
      return;
    }

    // Coordinates Display
    const latDir = lat >= 0 ? "°N" : "°S";
    const lonDir = lon >= 0 ? "°E" : "°W";
    this.coordsEl.textContent = `${Math.abs(lat).toFixed(2)}${latDir}, ${Math.abs(lon).toFixed(2)}${lonDir}`;

    // Active Scalar Value Display
    if (scalarVal !== null && this.activeVarConfig) {
      const units = this.activeVarConfig.units || "";
      const name = this.activeVarConfig.short_name || this.activeVarConfig.name;
      const formatted = scalarVal >= 100 ? scalarVal.toFixed(0) : scalarVal >= 10 ? scalarVal.toFixed(1) : scalarVal.toFixed(2);
      this.scalarEl.textContent = `${name}: ${formatted} ${units}`;
      this.scalarEl.style.display = "block";
    } else {
      this.scalarEl.style.display = "none";
    }

    // Wind Speed & Cardinal Direction Display
    if (windVec) {
      const [u, v] = windVec;
      const speed = Math.hypot(u, v);
      // Meteorological wind direction (direction wind is coming FROM)
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
    const tooltipW = 200;
    const tooltipH = 80;

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
