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
    if (typeof maplibregl === "undefined") {
      throw new Error("MapLibre GL JS library is not loaded.");
    }

    // Fallback dark raster style via ESRI World Dark Gray Canvas (100% free, no API key required)
    const fallbackEsriStyle = {
      version: 8,
      sources: {
        "esri-dark": {
          type: "raster",
          tiles: [
            "https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
        },
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#070b14" },
        },
        {
          id: "esri-dark-layer",
          type: "raster",
          source: "esri-dark",
          minzoom: 0,
          maxzoom: 18,
        },
      ],
    };

    // Primary: OpenFreeMap Dark vector style (open source, no API key required, zero watermark)
    const primaryStyle = "https://tiles.openfreemap.org/styles/dark";

    this.map = new maplibregl.Map({
      container: this.containerId,
      style: primaryStyle,
      center: initialCenter,
      zoom: initialZoom,
      pitch: 0,
      bearing: 0,
      antialias: true,
      attributionControl: false,
    });

    let fallbackTriggered = false;
    this.map.on("error", (e) => {
      if (!fallbackTriggered && e && e.error && (e.error.status === 401 || e.error.status === 403 || (e.error.message && e.error.message.includes("style")))) {
        fallbackTriggered = true;
        console.warn("[Dusty Earth] Vector style error, falling back to ESRI Dark Gray:", e);
        this.map.setStyle(fallbackEsriStyle);
      }
    });

    // Add navigation controls (zoom, compass) at bottom-right
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "bottom-right");

    this.resizeCanvases();
    window.addEventListener("resize", () => this.resizeCanvases());

    this.map.on("move", () => this._handleMove());
    this.map.on("resize", () => {
      this.resizeCanvases();
      this._handleMove();
    });

    return new Promise((resolve) => {
      if (this.map.loaded()) {
        resolve(this.map);
      } else {
        this.map.once("load", () => {
          resolve(this.map);
        });
      }
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
