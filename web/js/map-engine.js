/**
 * Map Engine for Dusty Earth
 * Wraps MapLibre GL JS with custom dark styling, projection helpers, and layer canvases.
 */

export class MapEngine {
  constructor(containerId = "map") {
    this.containerId = containerId;
    this.map = null;
    this.scalarCanvas = document.getElementById("scalar-canvas");
    this.particleCanvas = document.getElementById("particle-canvas");
    this.scalarCtx = this.scalarCanvas ? this.scalarCanvas.getContext("2d") : null;
    this.particleCtx = this.particleCanvas ? this.particleCanvas.getContext("2d") : null;
    this.onMoveCallbacks = [];
  }

  init(initialCenter = [51.5, 25.3], initialZoom = 5.2) {
    // Standard dark-matter style with fallback
    const style = {
      version: 8,
      sources: {
        "carto-dark": {
          type: "raster",
          tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://openstreetmap.org">OSM</a>',
        },
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#070b14" },
        },
        {
          id: "carto-dark-layer",
          type: "raster",
          source: "carto-dark",
          minzoom: 0,
          maxzoom: 20,
        },
      ],
    };

    // Use global maplibregl
    if (typeof maplibregl === "undefined") {
      throw new Error("MapLibre GL JS library is not loaded.");
    }

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: style,
      center: initialCenter,
      zoom: initialZoom,
      pitch: 0,
      bearing: 0,
      antialias: true,
      attributionControl: false,
    });

    // Add navigation controls (zoom, compass) at top-right below layer dock
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");

    this.resizeCanvases();
    window.addEventListener("resize", () => this.resizeCanvases());

    this.map.on("move", () => this._handleMove());
    this.map.on("resize", () => {
      this.resizeCanvases();
      this._handleMove();
    });

    return new Promise((resolve) => {
      this.map.on("load", () => {
        resolve(this.map);
      });
    });
  }

  resizeCanvases() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    [this.scalarCanvas, this.particleCanvas].forEach((canvas) => {
      if (!canvas) return;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
      }
    });
  }

  onMove(callback) {
    this.onMoveCallbacks.push(callback);
  }

  _handleMove() {
    for (const cb of this.onMoveCallbacks) {
      cb();
    }
  }

  project(lon, lat) {
    if (!this.map) return { x: 0, y: 0 };
    return this.map.project([lon, lat]);
  }

  unproject(x, y) {
    if (!this.map) return { lng: 0, lat: 0 };
    return this.map.unproject([x, y]);
  }

  fitBounds(lonMin, latMin, lonMax, latMax, padding = 40) {
    if (!this.map) return;
    this.map.fitBounds(
      [
        [lonMin, latMin],
        [lonMax, latMax],
      ],
      { padding: padding, duration: 1000 }
    );
  }
}
