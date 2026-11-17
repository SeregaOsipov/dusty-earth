/**
 * Scene-Graph WebGL Scalar Field Layer for Dusty Earth.
 * Renders Float32 / Uint16 binary (.bin) grids natively inside MapLibre's WebGL scene graph
 * via CanvasSource so 3D camera pitch/bearing, perspective warping, 3D building/canopy
 * extrusions, and vector map labels composite accurately in Z-order.
 */

import { getGridQuad, getDomainPolygonFeature } from "./grid-coords.js";

export function decodeFieldBuffer(arrayBuffer, fileEntry = null) {
  if (fileEntry && fileEntry.encoding === "uint16") {
    const qmin = typeof fileEntry.qmin === "number" ? fileEntry.qmin : 0.0;
    const qmax = typeof fileEntry.qmax === "number" ? fileEntry.qmax : 1.0;
    const span = qmax - qmin;
    const u16 = new Uint16Array(arrayBuffer);
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const code = u16[i];
      if (code === 0) {
        out[i] = Number.NaN;
      } else {
        out[i] = qmin + ((code - 1) / 65534.0) * span;
      }
    }
    return out;
  }
  return new Float32Array(arrayBuffer);
}

const SCALAR_SOURCE_ID = "dusty-scalar-source";
const SCALAR_LAYER_ID = "dusty-scalar-layer";
const FADE_SOURCE_ID = "dusty-scalar-fade-source";
const FADE_LAYER_ID = "dusty-scalar-fade-layer";
const OUTLINE_SOURCE_ID = "dusty-domain-outline-source";
const OUTLINE_LAYER_ID = "dusty-domain-outline-layer";

const EMPTY_FC = { type: "FeatureCollection", features: [] };

export class ScalarLayer {
  constructor(canvasOrMapEngine, maybeMapEngine = null) {
    this.mapEngine = maybeMapEngine || canvasOrMapEngine;

    this.cache = new Map(); // url -> Float32Array
    this.maxCacheEntries = 240;
    this.currentBuffer = null;
    this.gridMeta = null;
    this.varConfig = null;

    this.offscreenCanvas = document.createElement("canvas");
    this.offscreenCanvas.width = 1;
    this.offscreenCanvas.height = 1;
    this.offscreenCtx = this.offscreenCanvas.getContext("2d");

    this.fadeCanvas = document.createElement("canvas");
    this.fadeCanvas.width = 1;
    this.fadeCanvas.height = 1;
    this.fadeCtx = this.fadeCanvas.getContext("2d");
    this.fadeMeta = null;
    this.fadeStartTime = 0;
    this.fadeDurationMs = 200;
    this._fadeAnimId = null;

    this._sourceTickets = {};
    this._hasActiveField = false;

    this.lut = new Uint8ClampedArray(256 * 4);
    this.opacity = 0.85;
    this.visible = true;
    this.showDomainOutline = false;

    if (this.mapEngine && typeof this.mapEngine.onStyleLoad === "function") {
      this.mapEngine.onStyleLoad(() => this.attachToMap());
    }
  }

  attachToMap() {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map || !this.mapEngine.styleReady) return;

    const beforeId = this.mapEngine.getFirstSymbolLayerId();
    const initialQuad = this.gridMeta ? getGridQuad(this.gridMeta) : getGridQuad(null);
    const fadeQuad = this.fadeMeta ? getGridQuad(this.fadeMeta) : initialQuad;

    if (!map.getSource(FADE_SOURCE_ID)) {
      map.addSource(FADE_SOURCE_ID, {
        type: "canvas",
        canvas: this.fadeCanvas,
        animate: false,
        coordinates: fadeQuad,
      });
    }
    if (!map.getLayer(FADE_LAYER_ID)) {
      map.addLayer(
        {
          id: FADE_LAYER_ID,
          type: "raster",
          source: FADE_SOURCE_ID,
          paint: {
            "raster-opacity": 0,
            "raster-fade-duration": 0,
            "raster-resampling": "linear",
          },
        },
        beforeId
      );
    }

    if (!map.getSource(SCALAR_SOURCE_ID)) {
      map.addSource(SCALAR_SOURCE_ID, {
        type: "canvas",
        canvas: this.offscreenCanvas,
        animate: false,
        coordinates: initialQuad,
      });
    }
    if (!map.getLayer(SCALAR_LAYER_ID)) {
      map.addLayer(
        {
          id: SCALAR_LAYER_ID,
          type: "raster",
          source: SCALAR_SOURCE_ID,
          paint: {
            "raster-opacity": this._hasActiveField && this.visible ? this.opacity : 0,
            "raster-fade-duration": 0,
            "raster-resampling": this._getResamplingMode(this.gridMeta),
          },
        },
        beforeId
      );
    }

    if (!map.getSource(OUTLINE_SOURCE_ID)) {
      map.addSource(OUTLINE_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_FC,
      });
    }
    if (!map.getLayer(OUTLINE_LAYER_ID)) {
      map.addLayer(
        {
          id: OUTLINE_LAYER_ID,
          type: "line",
          source: OUTLINE_SOURCE_ID,
          paint: {
            "line-color": "rgba(56, 189, 248, 0.85)",
            "line-width": 1.6,
            "line-dasharray": [4, 3],
          },
        },
        beforeId
      );
    }

    if (this._hasActiveField && this.currentBuffer && this.gridMeta && this.varConfig) {
      this._syncScalarToMap();
    }
  }

  _getResamplingMode(meta) {
    if (meta && meta.has_nan_mask && meta.dx_m > 0 && meta.dx_m <= 250) {
      return "nearest";
    }
    return "linear";
  }

  _refreshCanvasSource(sourceId) {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map) return;
    const src = map.getSource(sourceId);
    if (!src) return;
    const ticket = (this._sourceTickets[sourceId] || 0) + 1;
    this._sourceTickets[sourceId] = ticket;

    src.width = 0;
    src.height = 0;
    if (typeof src.play === "function") {
      src.play();
    }
    map.triggerRepaint();

    let attempts = 0;
    const waitAndPause = () => {
      if (this._sourceTickets[sourceId] !== ticket) return;
      attempts += 1;
      const hasTiles = Boolean(src.tiles && Object.keys(src.tiles).length > 0);
      if (hasTiles && src.texture) {
        src.width = 0;
        src.height = 0;
        if (typeof src.pause === "function") {
          src.pause();
        }
        map.triggerRepaint();
      } else if (attempts < 40) {
        map.once("render", waitAndPause);
        map.triggerRepaint();
      } else if (typeof src.pause === "function") {
        src.pause();
      }
    };

    map.once("render", waitAndPause);
  }

  setDomainOutline(visible) {
    this.showDomainOutline = Boolean(visible);
    this._syncOutlineToMap();
  }

  _syncOutlineToMap() {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map) return;
    const src = map.getSource(OUTLINE_SOURCE_ID);
    if (!src) return;
    if (this.showDomainOutline && this.gridMeta) {
      src.setData({
        type: "FeatureCollection",
        features: [getDomainPolygonFeature(this.gridMeta)],
      });
    } else {
      src.setData(EMPTY_FC);
    }
  }

  beginModelTransition() {
    if (!this._hasActiveField || !this.currentBuffer || !this.gridMeta || this.offscreenCanvas.width <= 1) {
      this.fadeStartTime = 0;
      return;
    }
    if (
      this.fadeCanvas.width !== this.offscreenCanvas.width ||
      this.fadeCanvas.height !== this.offscreenCanvas.height
    ) {
      this.fadeCanvas.width = this.offscreenCanvas.width;
      this.fadeCanvas.height = this.offscreenCanvas.height;
    }
    this.fadeCtx.clearRect(0, 0, this.fadeCanvas.width, this.fadeCanvas.height);
    this.fadeCtx.drawImage(this.offscreenCanvas, 0, 0);
    this.fadeMeta = this.gridMeta;
    this.fadeStartTime = performance.now();

    const map = this.mapEngine ? this.mapEngine.map : null;
    if (map) {
      const fadeSrc = map.getSource(FADE_SOURCE_ID);
      if (fadeSrc && typeof fadeSrc.setCoordinates === "function") {
        fadeSrc.setCoordinates(getGridQuad(this.fadeMeta));
      }
      if (map.getLayer(FADE_LAYER_ID)) {
        map.setPaintProperty(FADE_LAYER_ID, "raster-resampling", this._getResamplingMode(this.fadeMeta));
        map.setPaintProperty(FADE_LAYER_ID, "raster-opacity", this.visible ? this.opacity : 0);
      }
      this._refreshCanvasSource(FADE_SOURCE_ID);
    }
  }

  setColormap(stops) {
    if (!stops || stops.length === 0) {
      stops = [
        { stop: 0.0, color: [0, 0, 0, 0] },
        { stop: 1.0, color: [255, 140, 0, 255] },
      ];
    }

    const sorted = [...stops].sort((a, b) => a.stop - b.stop);
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

  async loadBuffer(url, fileEntry = null) {
    if (this.cache.has(url)) {
      return this.cache.get(url);
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch binary grid: ${response.statusText} (${url})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const float32 = decodeFieldBuffer(arrayBuffer, fileEntry);
    if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(url, float32);
    return float32;
  }

  async setField(urlOrEntry, gridMeta, varConfig) {
    const url = typeof urlOrEntry === "string" ? urlOrEntry : urlOrEntry.scalar;
    const fileEntry = typeof urlOrEntry === "object" ? urlOrEntry : null;

    this.gridMeta = gridMeta;
    this.varConfig = varConfig;
    this.setColormap(varConfig.colormap || []);

    const buffer = await this.loadBuffer(url, fileEntry);
    this.currentBuffer = buffer;
    this._hasActiveField = true;

    this._generateTexture(buffer, gridMeta, varConfig);
    this._syncScalarToMap();
    this._renderWithFade();
  }

  _syncScalarToMap() {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map || !this.mapEngine.styleReady) return;
    if (!map.getSource(SCALAR_SOURCE_ID)) {
      this.attachToMap();
      return;
    }
    const src = map.getSource(SCALAR_SOURCE_ID);
    if (src && this.gridMeta && typeof src.setCoordinates === "function") {
      src.setCoordinates(getGridQuad(this.gridMeta));
    }
    if (map.getLayer(SCALAR_LAYER_ID)) {
      map.setPaintProperty(SCALAR_LAYER_ID, "raster-resampling", this._getResamplingMode(this.gridMeta));
      if (this.fadeStartTime === 0) {
        map.setPaintProperty(SCALAR_LAYER_ID, "raster-opacity", this.visible ? this.opacity : 0);
      }
    }
    this._refreshCanvasSource(SCALAR_SOURCE_ID);
    this._syncOutlineToMap();
  }

  _renderWithFade() {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map || !map.getLayer(SCALAR_LAYER_ID)) return;

    if (!this.visible) {
      map.setPaintProperty(SCALAR_LAYER_ID, "raster-opacity", 0);
      if (map.getLayer(FADE_LAYER_ID)) {
        map.setPaintProperty(FADE_LAYER_ID, "raster-opacity", 0);
      }
      this.fadeStartTime = 0;
      this.fadeMeta = null;
      return;
    }

    if (this.fadeStartTime > 0 && this.fadeMeta) {
      const progress = Math.min(1.0, (performance.now() - this.fadeStartTime) / this.fadeDurationMs);
      map.setPaintProperty(SCALAR_LAYER_ID, "raster-opacity", this.opacity * progress);
      if (map.getLayer(FADE_LAYER_ID)) {
        map.setPaintProperty(FADE_LAYER_ID, "raster-opacity", this.opacity * (1.0 - progress));
      }
      if (progress < 1.0) {
        if (!this._fadeAnimId) {
          this._fadeAnimId = requestAnimationFrame(() => {
            this._fadeAnimId = null;
            this._renderWithFade();
          });
        }
      } else {
        this.fadeStartTime = 0;
        this.fadeMeta = null;
      }
    } else {
      map.setPaintProperty(SCALAR_LAYER_ID, "raster-opacity", this.opacity);
      if (map.getLayer(FADE_LAYER_ID)) {
        map.setPaintProperty(FADE_LAYER_ID, "raster-opacity", 0);
      }
    }
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
      if (Number.isNaN(val)) {
        data32[i] = 0;
      } else if (val <= vmin) {
        data32[i] = lut32[0];
      } else if (val >= vmax) {
        data32[i] = lut32[255];
      } else {
        const norm = (val - vmin) / range;
        const lutIdx = Math.min(255, Math.max(0, (norm * 255.0) | 0));
        data32[i] = lut32[lutIdx];
      }
    }

    this.offscreenCtx.putImageData(imgData, 0, 0);
  }

  render() {
    // WebGL CanvasSource inside MapLibre automatically reprojects during camera pan/zoom/pitch.
  }

  clear() {
    if (this._fadeAnimId) {
      cancelAnimationFrame(this._fadeAnimId);
      this._fadeAnimId = null;
    }
    this.fadeStartTime = 0;
    this.fadeMeta = null;
    this._hasActiveField = false;
    this.currentBuffer = null;

    const map = this.mapEngine ? this.mapEngine.map : null;
    if (map) {
      if (map.getLayer(SCALAR_LAYER_ID)) {
        map.setPaintProperty(SCALAR_LAYER_ID, "raster-opacity", 0);
      }
      if (map.getLayer(FADE_LAYER_ID)) {
        map.setPaintProperty(FADE_LAYER_ID, "raster-opacity", 0);
      }
    }
  }

  getCurrentBuffer() {
    return this.currentBuffer;
  }
}
