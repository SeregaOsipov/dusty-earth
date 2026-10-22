/**
 * GPU & Canvas Scalar Field Layer for Dusty Earth.
 * Loads raw Float32 binary (.bin) grids into memory, applies fast colormap LUT,
 * and renders smooth bilinear-interpolated concentration textures aligned to geographic bounds.
 */

export class ScalarLayer {
  constructor(canvas, mapEngine) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.mapEngine = mapEngine;

    this.cache = new Map(); // url -> Float32Array
    this.currentBuffer = null;
    this.gridMeta = null;
    this.varConfig = null;
    this.offscreenCanvas = document.createElement("canvas");
    this.offscreenCtx = this.offscreenCanvas.getContext("2d");
    this.lut = new Uint8ClampedArray(256 * 4); // 256 RGBA stops
    this.opacity = 0.85;
    this.visible = true;
  }

  setColormap(stops) {
    if (!stops || stops.length === 0) {
      // Default fallback gradient
      stops = [
        { stop: 0.0, color: [0, 0, 0, 0] },
        { stop: 1.0, color: [255, 140, 0, 255] },
      ];
    }

    // Sort stops ascending
    const sorted = [...stops].sort((a, b) => a.stop - b.stop);

    // Build 256-entry lookup table
    for (let i = 0; i < 256; i++) {
      const t = i / 255.0;
      let left = sorted[0];
      let right = sorted[sorted.length - 1];

      for (let s = 0; s < sorted.length - 1; s++) {
        if (t >= sorted[s].stop && t <= sorted[s + 1].stop) {
          left = sorted[s];
          right = sorted[s + 1];
          break;
        }
      }

      const span = right.stop - left.stop || 0.0001;
      const frac = Math.max(0, Math.min(1, (t - left.stop) / span));

      const r = Math.round(left.color[0] + frac * (right.color[0] - left.color[0]));
      const g = Math.round(left.color[1] + frac * (right.color[1] - left.color[1]));
      const b = Math.round(left.color[2] + frac * (right.color[2] - left.color[2]));
      const a = Math.round(left.color[3] + frac * (right.color[3] - left.color[3]));

      const offset = i * 4;
      this.lut[offset] = r;
      this.lut[offset + 1] = g;
      this.lut[offset + 2] = b;
      this.lut[offset + 3] = a;
    }
  }

  async loadBuffer(url) {
    if (this.cache.has(url)) {
      return this.cache.get(url);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch binary grid: ${response.statusText} (${url})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const float32 = new Float32Array(arrayBuffer);
    this.cache.set(url, float32);
    return float32;
  }

  async setField(url, gridMeta, varConfig) {
    this.gridMeta = gridMeta;
    this.varConfig = varConfig;
    this.setColormap(varConfig.colormap || []);

    const buffer = await this.loadBuffer(url);
    this.currentBuffer = buffer;

    this._generateTexture(buffer, gridMeta, varConfig);
    this.render();
  }

  _generateTexture(buffer, gridMeta, varConfig) {
    const nx = gridMeta.nx;
    const ny = gridMeta.ny;

    if (this.offscreenCanvas.width !== nx || this.offscreenCanvas.height !== ny) {
      this.offscreenCanvas.width = nx;
      this.offscreenCanvas.height = ny;
    }

    const imgData = this.offscreenCtx.createImageData(nx, ny);
    const data32 = new Uint32Array(imgData.data.buffer);
    const lut32 = new Uint32Array(this.lut.buffer);

    const vmin = varConfig.vmin;
    const vmax = varConfig.vmax;
    const range = vmax - vmin || 1.0;
    const len = nx * ny;

    for (let i = 0; i < len; i++) {
      const val = buffer[i];
      if (isNaN(val) || val <= vmin) {
        data32[i] = lut32[0];
      } else if (val >= vmax) {
        data32[i] = lut32[255];
      } else {
        const norm = (val - vmin) / range;
        const lutIdx = (norm * 255.0) | 0;
        data32[i] = lut32[lutIdx];
      }
    }

    this.offscreenCtx.putImageData(imgData, 0, 0);
  }

  render() {
    if (!this.visible || !this.ctx || !this.currentBuffer || !this.gridMeta) {
      return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    this.ctx.clearRect(0, 0, width, height);

    const { lon_min, lat_min, lon_max, lat_max } = this.gridMeta;

    // Project bounding box corners
    const tl = this.mapEngine.project(lon_min, lat_max);
    const br = this.mapEngine.project(lon_max, lat_min);

    const renderW = br.x - tl.x;
    const renderH = br.y - tl.y;

    if (renderW <= 0 || renderH <= 0) return;

    this.ctx.save();
    this.ctx.globalAlpha = this.opacity;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";

    this.ctx.drawImage(
      this.offscreenCanvas,
      0,
      0,
      this.offscreenCanvas.width,
      this.offscreenCanvas.height,
      tl.x,
      tl.y,
      renderW,
      renderH
    );

    this.ctx.restore();
  }

  clear() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    this.currentBuffer = null;
  }

  getCurrentBuffer() {
    return this.currentBuffer;
  }
}
