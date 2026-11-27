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
    this.labelsVisible = true;
    this._permanentlyHiddenSymbols = new Set([
      "road_oneway",
      "road_oneway_opposite",
      "highway_name_motorway",
      "place_state",
      "place_other",
    ]);
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
          paint: { "background-color": "#060b14" },
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
      this._customizeBasemapAesthetics();
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
      }, 6500);

      if (this.map.isStyleLoaded && this.map.isStyleLoaded()) {
        clearTimeout(styleTimeout);
        this.styleReady = true;
        this._customizeBasemapAesthetics();
        this._applyEnglishLabels();
        done();
      } else {
        this.map.once("style.load", () => {
          clearTimeout(styleTimeout);
          done();
        });
        this.map.once("load", () => {
          clearTimeout(styleTimeout);
          if (!this.styleReady) {
            this.styleReady = true;
            this._customizeBasemapAesthetics();
            this._applyEnglishLabels();
          }
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

  getScalarBeforeLayerId() {
    if (!this.map) return undefined;
    const anchors = ["dusty-coastline-casing", "dusty-coastline", "boundary_country_z0-4", "boundary_country_z5-"];
    for (const id of anchors) {
      if (this.map.getLayer(id)) return id;
    }
    return this.getFirstSymbolLayerId();
  }

  get3DBeforeLayerId() {
    if (!this.map) return undefined;
    const style = this.map.getStyle();
    if (!style || !Array.isArray(style.layers)) return undefined;
    let last2DIdx = -1;
    for (let i = 0; i < style.layers.length; i++) {
      const lyr = style.layers[i];
      if (lyr.id && lyr.id.startsWith("dusty-") && lyr.id !== "dusty-coastline-casing" && lyr.id !== "dusty-coastline") {
        continue;
      }
      if (lyr.type === "background" || lyr.type === "raster" || lyr.type === "fill" || lyr.type === "line") {
        last2DIdx = i;
      }
    }
    if (last2DIdx >= 0 && last2DIdx + 1 < style.layers.length) {
      return style.layers[last2DIdx + 1].id;
    }
    return undefined;
  }

  setLabelsVisible(visible) {
    this.labelsVisible = Boolean(visible);
    if (!this.map) return;
    const style = this.map.getStyle();
    if (!style || !Array.isArray(style.layers)) return;
    for (const layer of style.layers) {
      if (layer.type !== "symbol") continue;
      const vis = this._permanentlyHiddenSymbols.has(layer.id)
        ? "none"
        : this.labelsVisible
        ? "visible"
        : "none";
      try {
        this.map.setLayoutProperty(layer.id, "visibility", vis);
      } catch (_err) {
        // Ignore immutable fallback layer states
      }
    }
  }

  _customizeBasemapAesthetics() {
    const map = this.map;
    if (!map) return;

    const hasLayer = (id) => Boolean(map.getLayer(id));
    const safePaint = (id, prop, val) => {
      if (!hasLayer(id)) return;
      try {
        map.setPaintProperty(id, prop, val);
      } catch (_err) {
        // Ignore mismatched layer types
      }
    };
    const safeLayout = (id, prop, val) => {
      if (!hasLayer(id)) return;
      try {
        map.setLayoutProperty(id, prop, val);
      } catch (_err) {
        // Ignore immutable layout properties
      }
    };
    const safeZoom = (id, minz, maxz = 24) => {
      if (!hasLayer(id)) return;
      try {
        map.setLayerZoomRange(id, minz, maxz);
      } catch (_err) {
        // Ignore
      }
    };
    const hideLayer = (id) => safeLayout(id, "visibility", "none");

    // 1. Harmonized dark oceanographic/atmospheric palette (water darker than land)
    safePaint("background", "background-color", "#101724");
    safePaint("water", "fill-color", "#060b14");
    safePaint("water", "fill-antialias", true);
    safePaint("waterway", "line-color", "#08101d");
    safePaint("waterway", "line-opacity", ["interpolate", ["linear"], ["zoom"], 6, 0.35, 12, 0.7]);
    safeZoom("landuse_residential", 9, 24);
    safePaint("landuse_residential", "fill-color", "#151f30");
    safePaint("landuse_residential", "fill-opacity", ["interpolate", ["linear"], ["zoom"], 9, 0.0, 11, 0.25, 14, 0.35]);
    safeZoom("landuse_park", 11, 24);
    safePaint("landuse_park", "fill-color", "#0e2022");
    safePaint("landuse_park", "fill-opacity", 0.25);
    ["landcover_wood", "landcover_ice_shelf", "landcover_glacier"].forEach(hideLayer);

    // 2. Eliminate offshore maritime/nautical lines (maritime == 1) and sub-national borders
    hideLayer("boundary_state");
    hideLayer("place_state");
    if (hasLayer("boundary_country_z0-4")) {
      map.setFilter("boundary_country_z0-4", [
        "all",
        ["==", ["get", "admin_level"], 2],
        ["!", ["has", "claimed_by"]],
        ["!=", ["coalesce", ["get", "maritime"], 0], 1],
        ["!=", ["coalesce", ["get", "disputed"], 0], 1],
      ]);
    }
    if (hasLayer("boundary_country_z5-")) {
      map.setFilter("boundary_country_z5-", [
        "all",
        ["==", ["get", "admin_level"], 2],
        ["!=", ["coalesce", ["get", "maritime"], 0], 1],
      ]);
    }
    for (const bid of ["boundary_country_z0-4", "boundary_country_z5-"]) {
      safePaint(bid, "line-color", "rgba(148, 163, 184, 0.36)");
      safePaint(bid, "line-blur", 0);
      safePaint(bid, "line-width", ["interpolate", ["linear"], ["zoom"], 2, 0.6, 6, 0.85, 12, 1.25]);
    }

    // 3. Declutter regional roads, rails, one-way arrows, and aeroways
    [
      "road_oneway",
      "road_oneway_opposite",
      "highway_path",
      "railway_transit",
      "railway_transit_dashline",
      "railway_minor",
      "railway_minor_dashline",
      "railway",
      "railway_dashline",
      "highway_name_motorway",
      "highway_motorway_subtle",
      "highway_major_subtle",
      "highway_motorway_casing",
      "highway_major_casing",
      "aeroway-runway-casing",
    ].forEach(hideLayer);

    safeZoom("aeroway-area", 12.5, 24);
    safePaint("aeroway-area", "fill-color", "#0b121e");
    safeZoom("aeroway-runway", 12.5, 24);
    safePaint("aeroway-runway", "line-color", "#0b121e");
    safeZoom("aeroway-taxiway", 12.5, 24);
    safePaint("aeroway-taxiway", "line-color", "#0b121e");

    safeZoom("highway_motorway_inner", 8.5, 24);
    safePaint("highway_motorway_inner", "line-color", "rgba(51, 65, 85, 0.42)");
    safePaint("highway_motorway_inner", "line-width", ["interpolate", ["exponential", 1.35], ["zoom"], 8.5, 0.5, 12, 1.4, 16, 4.5]);
    safeZoom("highway_major_inner", 10.5, 24);
    safePaint("highway_major_inner", "line-color", "rgba(51, 65, 85, 0.32)");
    safePaint("highway_major_inner", "line-width", ["interpolate", ["exponential", 1.35], ["zoom"], 10.5, 0.45, 14, 1.6, 18, 6.0]);
    safeZoom("highway_minor", 13.0, 24);
    safePaint("highway_minor", "line-color", "rgba(30, 41, 59, 0.38)");
    safePaint("highway_minor", "line-width", ["interpolate", ["exponential", 1.4], ["zoom"], 13, 0.5, 17, 2.8]);
    safeZoom("highway_name_other", 14.5, 24);
    safePaint("highway_name_other", "text-color", "rgba(148, 163, 184, 0.55)");
    safePaint("highway_name_other", "text-halo-color", "rgba(7, 11, 20, 0.85)");

    // 4. Fix water_name Z-order (move above roads/boundaries right before place labels)
    const style = map.getStyle();
    if (style && Array.isArray(style.layers) && hasLayer("water_name")) {
      const firstPlace = style.layers.find((lyr) => lyr.id && lyr.id.startsWith("place_"));
      if (firstPlace && firstPlace.id !== "water_name") {
        try {
          map.moveLayer("water_name", firstPlace.id);
        } catch (_err) {
          // Ignore move errors
        }
      }
    }

    // 5. Insert tile-seam-free 10m Natural Earth vector coastline above scalar field
    if (!map.getSource("dusty-coastline-source")) {
      map.addSource("dusty-coastline-source", {
        type: "geojson",
        data: "assets/coastline_mena.geojson",
      });
    }
    const coastAnchor = hasLayer("boundary_country_z0-4")
      ? "boundary_country_z0-4"
      : this.getFirstSymbolLayerId();

    if (!hasLayer("dusty-coastline-casing")) {
      map.addLayer(
        {
          id: "dusty-coastline-casing",
          type: "line",
          source: "dusty-coastline-source",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "rgba(6, 11, 20, 0.58)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1.4, 8, 2.0, 11, 1.6],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 0.85, 10.6, 0.0],
          },
        },
        coastAnchor
      );
    }
    if (!hasLayer("dusty-coastline")) {
      map.addLayer(
        {
          id: "dusty-coastline",
          type: "line",
          source: "dusty-coastline-source",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "rgba(226, 232, 240, 0.52)",
            "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.7, 7, 0.95, 10.5, 1.0],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 8.5, 1.0, 10.6, 0.0],
          },
        },
        coastAnchor
      );
    }

    // 6. Clean typographic hierarchy across cities, countries, and sea labels
    hideLayer("place_other");
    safeZoom("place_village", 12.5, 24);
    safeZoom("place_suburb", 12.5, 24);
    safeZoom("place_town", 7.5, 24);

    safePaint("water_name", "text-color", "rgba(125, 162, 198, 0.60)");
    safePaint("water_name", "text-halo-color", "rgba(6, 11, 20, 0.82)");
    safePaint("water_name", "text-halo-width", 1.3);
    safeLayout("water_name", "text-letter-spacing", 0.14);

    safePaint("place_city_large", "text-color", "#e2e8f0");
    safePaint("place_city_large", "text-halo-color", "rgba(7, 11, 20, 0.88)");
    safePaint("place_city_large", "text-halo-width", 1.6);
    safePaint("place_city_large", "icon-opacity", 0.5);

    for (const pid of ["place_city", "place_town", "place_village", "place_suburb"]) {
      safePaint(pid, "text-color", "#cbd5e1");
      safePaint(pid, "text-halo-color", "rgba(7, 11, 20, 0.85)");
      safePaint(pid, "text-halo-width", 1.4);
      safePaint(pid, "icon-opacity", 0.4);
    }

    for (const cid of ["place_country_major", "place_country_minor", "place_country_other"]) {
      safePaint(cid, "text-color", "rgba(148, 163, 184, 0.72)");
      safePaint(cid, "text-halo-color", "rgba(7, 11, 20, 0.85)");
      safePaint(cid, "text-halo-width", 1.5);
      safeLayout(cid, "text-letter-spacing", 0.12);
    }

    this.setLabelsVisible(this.labelsVisible);
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
