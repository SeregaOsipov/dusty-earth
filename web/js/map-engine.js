/**
 * Map Engine for Dusty Earth
 * Wraps MapLibre GL JS with custom dark styling, projection helpers, and layer canvases.
 */

export class MapEngine {
  constructor(containerId = "map") {
    this.containerId = containerId;
    this.map = null;
    this.particleCanvas = document.getElementById("particle-canvas");
    this.particleCtx = this.particleCanvas ? this.particleCanvas.getContext("2d") : null;
    this.onMoveCallbacks = [];
    this.onStyleLoadCallbacks = [];
    this.styleReady = false;
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
          attribution: "QEERI / HBKU &middot; Lead: Dr. Sergey Osipov &middot; Tiles &copy; Esri",
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
      maxPitch: 65,
      antialias: true,
      preserveDrawingBuffer: true,
      attributionControl: false,
    });

    this.map.on("style.load", () => {
      this.styleReady = true;
      this._applyEnglishLabels();
      for (const cb of this.onStyleLoadCallbacks) {
        try {
          cb();
        } catch (err) {
          console.warn("[Dusty Earth] style.load callback error:", err);
        }
      }
    });

    let fallbackTriggered = false;
    const triggerFallback = (reason) => {
      if (fallbackTriggered) return;
      fallbackTriggered = true;
      this.styleReady = false;
      console.warn("[Dusty Earth] Vector style unavailable, falling back to ESRI Dark Gray:", reason);
      this.map.setStyle(fallbackEsriStyle);
    };

    this.map.on("error", (e) => {
      if (!fallbackTriggered && !this.styleReady && e && e.error && (e.error.status === 401 || e.error.status === 403 || e.error.status >= 500 || (e.error.message && (e.error.message.includes("style") || e.error.message.includes("Failed to fetch"))))) {
        triggerFallback(e.error);
      }
    });

    // Add navigation controls (zoom, compass, pitch) at bottom-right
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");

    this.resizeCanvases();
    window.addEventListener("resize", () => this.resizeCanvases());

    this.map.on("move", () => this._handleMove());
    this.map.on("resize", () => {
      this.resizeCanvases();
      this._handleMove();
    });

    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve(this.map);
      };

      const styleTimeout = setTimeout(() => {
        if (!this.styleReady) {
          triggerFallback("style load timeout");
        }
        done();
      }, 3500);

      if (this.map.isStyleLoaded && this.map.isStyleLoaded()) {
        clearTimeout(styleTimeout);
        this.styleReady = true;
        this._applyEnglishLabels();
        done();
      } else {
        this.map.once("style.load", () => {
          clearTimeout(styleTimeout);
          done();
        });
        this.map.once("load", () => {
          clearTimeout(styleTimeout);
          this.styleReady = true;
          this._applyEnglishLabels();
          done();
        });
      }
    });
  }

  onStyleLoad(callback) {
    this.onStyleLoadCallbacks.push(callback);
  }

  getFirstSymbolLayerId() {
    if (!this.map) return undefined;
    const style = this.map.getStyle();
    if (!style || !Array.isArray(style.layers)) return undefined;
    const sym = style.layers.find((layer) => layer.type === "symbol");
    return sym ? sym.id : undefined;
  }

  _applyEnglishLabels() {
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style || !Array.isArray(style.layers)) return;
    for (const layer of style.layers) {
      if (
        layer.type === "symbol" &&
        layer.id !== "highway_name_motorway" &&
        layer.layout &&
        layer.layout["text-field"] !== undefined
      ) {
        this.map.setLayoutProperty(layer.id, "text-field", [
          "coalesce",
          ["get", "name:en"],
          ["get", "name_en"],
          ["get", "name:latin"],
          ["case", ["!", ["has", "name:nonlatin"]], ["get", "name"], ""],
        ]);
      }
    }
  }

  resizeCanvases() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    if (this.particleCanvas) {
      this.particleCanvas.width = width * dpr;
      this.particleCanvas.height = height * dpr;
      this.particleCanvas.style.width = `${width}px`;
      this.particleCanvas.style.height = `${height}px`;
      const ctx = this.particleCanvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
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

  fitBounds(lonMin, latMin, lonMax, latMax, padding = 40, extra = {}) {
    if (!this.map) return;
    this.map.fitBounds(
      [
        [lonMin, latMin],
        [lonMax, latMax],
      ],
      { padding: padding, duration: 1000, ...extra }
    );
  }
}
