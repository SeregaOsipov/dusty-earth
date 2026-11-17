/**
 * GPU & Canvas Wind Particle Streamline Animation Engine for Dusty Earth.
 * Scales particle advection cleanly with MapLibre zoom (regional 10 km -> urban 1 m),
 * constrains spawns to the visible domain viewport, and stops at NaN building obstacles.
 */

import { decodeFieldBuffer } from "./scalar-layer.js";
import { lonLatToGridIndices } from "./grid-coords.js";

export class WindParticles {
  constructor(canvas, mapEngine) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.mapEngine = mapEngine;

    this.uBuffer = null;
    this.vBuffer = null;
    this.gridMeta = null;

    this.particles = [];
    this.numParticles = 1000;
    this.particleSpeed = 0.0007;
    this.maxAge = 75;
    this.lineWidth = 1.25;
    this.trailFade = 0.045;

    this.isRunning = false;
    this.visible = true;
    this.animId = null;

    this.cache = new Map(); // url -> Float32Array
    this.maxCacheEntries = 240;
  }

  async loadBuffer(url, fileEntry = null, component = "u") {
    if (this.cache.has(url)) {
      return this.cache.get(url);
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch wind component: ${url}`);
    }
    const buf = await res.arrayBuffer();
    let wrappedEntry = null;
    if (fileEntry && fileEntry.encoding === "uint16") {
      wrappedEntry = {
        encoding: "uint16",
        qmin: component === "u" ? fileEntry.u_qmin : fileEntry.v_qmin,
        qmax: component === "u" ? fileEntry.u_qmax : fileEntry.v_qmax,
      };
    }
    const f32 = decodeFieldBuffer(buf, wrappedEntry);
    if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(url, f32);
    return f32;
  }

  async setWindField(uUrlOrEntry, vUrlOrGridMeta, maybeGridMeta = null) {
    let uUrl;
    let vUrl;
    let gridMeta;
    let fileEntry = null;

    if (typeof uUrlOrEntry === "object" && uUrlOrEntry !== null) {
      fileEntry = uUrlOrEntry;
      uUrl = fileEntry.u;
      vUrl = fileEntry.v;
      gridMeta = vUrlOrGridMeta;
    } else {
      uUrl = uUrlOrEntry;
      vUrl = vUrlOrGridMeta;
      gridMeta = maybeGridMeta;
    }

    const prevMeta = this.gridMeta;
    const domainChanged =
      !prevMeta ||
      prevMeta.nx !== gridMeta.nx ||
      prevMeta.ny !== gridMeta.ny ||
      Math.abs(prevMeta.lon_min - gridMeta.lon_min) > 1e-4;

    this.gridMeta = gridMeta;
    const [u, v] = await Promise.all([
      this.loadBuffer(uUrl, fileEntry, "u"),
      this.loadBuffer(vUrl, fileEntry, "v"),
    ]);
    this.uBuffer = u;
    this.vBuffer = v;

    if (domainChanged || !this.particles || this.particles.length !== this.numParticles * 4) {
      this.clear();
      this.initParticles();
    }
    if (this.visible && !this.isRunning) {
      this.start();
    }
  }

  _getSpawnBounds() {
    if (!this.gridMeta) return null;
    const { lon_min, lon_max, lat_min, lat_max } = this.gridMeta;

    if (this.mapEngine && this.mapEngine.map) {
      const b = this.mapEngine.map.getBounds();
      if (b) {
        const padLon = (b.getEast() - b.getWest()) * 0.1;
        const padLat = (b.getNorth() - b.getSouth()) * 0.1;
        const iLonMin = Math.max(lon_min, b.getWest() - padLon);
        const iLonMax = Math.min(lon_max, b.getEast() + padLon);
        const iLatMin = Math.max(lat_min, b.getSouth() - padLat);
        const iLatMax = Math.min(lat_max, b.getNorth() + padLat);
        if (iLonMax > iLonMin && iLatMax > iLatMin) {
          return { lonMin: iLonMin, lonMax: iLonMax, latMin: iLatMin, latMax: iLatMax };
        }
      }
    }
    return { lonMin: lon_min, lonMax: lon_max, latMin: lat_min, latMax: lat_max };
  }

  _pickValidCoord(bounds) {
    const spanLon = bounds.lonMax - bounds.lonMin;
    const spanLat = bounds.latMax - bounds.latMin;
    for (let attempt = 0; attempt < 5; attempt++) {
      const lon = bounds.lonMin + Math.random() * spanLon;
      const lat = bounds.latMin + Math.random() * spanLat;
      if (!this.uBuffer || this.sampleVector(lon, lat) !== null) {
        return [lon, lat];
      }
    }
    return [bounds.lonMin + Math.random() * spanLon, bounds.latMin + Math.random() * spanLat];
  }

  initParticles() {
    const bounds = this._getSpawnBounds();
    if (!bounds) return;

    this.particles = new Float32Array(this.numParticles * 4);
    for (let i = 0; i < this.numParticles; i++) {
      const offset = i * 4;
      const [lon, lat] = this._pickValidCoord(bounds);
      this.particles[offset] = lon;
      this.particles[offset + 1] = lat;
      this.particles[offset + 2] = Math.floor(Math.random() * this.maxAge);
      this.particles[offset + 3] = this.maxAge * (0.6 + Math.random() * 0.8);
    }
  }

  respawnInView() {
    if (!this.gridMeta || !this.uBuffer) return;
    this.initParticles();
  }

  sampleVector(lon, lat) {
    if (!this.gridMeta || !this.uBuffer || !this.vBuffer) return null;
    const { nx, ny } = this.gridMeta;
    const pos = lonLatToGridIndices(lon, lat, this.gridMeta);
    if (!pos.inBounds) {
      return null;
    }

    const col = pos.col;
    const row = pos.row;

    const c0 = Math.max(0, Math.min(nx - 1, Math.floor(col)));
    const r0 = Math.max(0, Math.min(ny - 1, Math.floor(row)));
    const c1 = Math.min(nx - 1, c0 + 1);
    const r1 = Math.min(ny - 1, r0 + 1);

    const fx = col - c0;
    const fy = row - r0;

    const idx00 = r0 * nx + c0;
    const idx01 = r0 * nx + c1;
    const idx10 = r1 * nx + c0;
    const idx11 = r1 * nx + c1;

    const u00 = this.uBuffer[idx00];
    const u01 = this.uBuffer[idx01];
    const u10 = this.uBuffer[idx10];
    const u11 = this.uBuffer[idx11];
    const v00 = this.vBuffer[idx00];
    const v01 = this.vBuffer[idx01];
    const v10 = this.vBuffer[idx10];
    const v11 = this.vBuffer[idx11];

    if (
      Number.isNaN(u00) || Number.isNaN(u01) || Number.isNaN(u10) || Number.isNaN(u11) ||
      Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v10) || Number.isNaN(v11)
    ) {
      return null;
    }

    const u0 = (1 - fx) * u00 + fx * u01;
    const u1 = (1 - fx) * u10 + fx * u11;
    const u = (1 - fy) * u0 + fy * u1;

    const v0 = (1 - fx) * v00 + fx * v01;
    const v1 = (1 - fx) * v10 + fx * v11;
    const v = (1 - fy) * v0 + fy * v1;

    return [u, v];
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this._tick();
  }

  stop() {
    this.isRunning = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  clear() {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      this.stop();
      this.clear();
    } else if (this.uBuffer && this.vBuffer) {
      this.start();
    }
  }

  setSpeed(factor) {
    this.particleSpeed = factor;
  }

  setDensity(count) {
    this.numParticles = Math.max(500, Math.min(15000, count));
    this.initParticles();
  }

  _tick() {
    if (!this.isRunning || !this.visible || !this.ctx || !this.gridMeta) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const bounds = this._getSpawnBounds();
    if (!bounds) return;

    this.ctx.save();
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.fillStyle = `rgba(0, 0, 0, ${this.trailFade})`;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.restore();

    const zoom = this.mapEngine && this.mapEngine.map ? this.mapEngine.map.getZoom() : 5.0;
    const zoomScale = Math.pow(2.0, 5.0 - zoom);

    this.ctx.save();
    this.ctx.lineWidth = this.lineWidth;
    this.ctx.lineCap = "round";
    this.ctx.beginPath();
    this.ctx.strokeStyle = "rgba(240, 249, 255, 0.72)";

    for (let i = 0; i < this.numParticles; i++) {
      const offset = i * 4;
      const lon = this.particles[offset];
      const lat = this.particles[offset + 1];
      const age = this.particles[offset + 2];
      const maxAge = this.particles[offset + 3];

      const vec = this.sampleVector(lon, lat);
      const outOfView =
        lon < bounds.lonMin || lon > bounds.lonMax || lat < bounds.latMin || lat > bounds.latMax;

      if (!vec || age >= maxAge || outOfView) {
        const [nLon, nLat] = this._pickValidCoord(bounds);
        this.particles[offset] = nLon;
        this.particles[offset + 1] = nLat;
        this.particles[offset + 2] = 0;
        continue;
      }

      const [u, v] = vec;
      const cosLat = Math.cos((lat * Math.PI) / 180.0) || 1.0;

      const dLon = (u * this.particleSpeed * zoomScale) / cosLat;
      const dLat = v * this.particleSpeed * zoomScale;

      const nextLon = lon + dLon;
      const nextLat = lat + dLat;

      const p0 = this.mapEngine.project(lon, lat);
      const p1 = this.mapEngine.project(nextLon, nextLat);

      if (
        (p0.x >= -50 && p0.x <= width + 50 && p0.y >= -50 && p0.y <= height + 50) ||
        (p1.x >= -50 && p1.x <= width + 50 && p1.y >= -50 && p1.y <= height + 50)
      ) {
        this.ctx.moveTo(p0.x, p0.y);
        this.ctx.lineTo(p1.x, p1.y);
      }

      this.particles[offset] = nextLon;
      this.particles[offset + 1] = nextLat;
      this.particles[offset + 2] = age + 1;
    }

    this.ctx.stroke();
    this.ctx.restore();

    this.animId = requestAnimationFrame(() => this._tick());
  }
}
