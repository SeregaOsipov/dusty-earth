/**
 * Scene-Graph 3D Buildings & Urban Canopy Layer for Dusty Earth.
 * Renders:
 *   1. Resolved PALM-4U 3D building extrusions & 2D footprints (dissolved from PIDS_STATIC).
 *   2. PALM-4U 3D urban vegetation canopy slabs (tiered from static LAD/zlad).
 *   3. Regional OpenFreeMap/OpenMapTiles 3D context buildings at zoom >= 13
 *      with automatic polygon cutout inside resolved PALM domains.
 */

import { getDomainPolygonFeature } from "./grid-coords.js";

const PALM_BLDG_SOURCE = "dusty-palm-buildings";
const PALM_FOOTPRINT_LAYER = "dusty-palm-footprints";
const PALM_BLDG_AO_LAYER = "dusty-palm-buildings-ao";
const PALM_BLDG_3D_LAYER = "dusty-palm-buildings-3d";

const PALM_CANOPY_SOURCE = "dusty-palm-canopy";
const PALM_CANOPY_LAYERS = [
  { id: "dusty-palm-canopy-1", tier: 1, color: "#15803d", opacity: 0.28 },
  { id: "dusty-palm-canopy-2", tier: 2, color: "#16a34a", opacity: 0.46 },
  { id: "dusty-palm-canopy-3", tier: 3, color: "#22c55e", opacity: 0.62 },
];

const OSM_BLDG_AO_LAYER = "dusty-osm-buildings-ao";
const OSM_BLDG_3D_LAYER = "dusty-osm-buildings-3d";
const BASE_2D_BLDG_FILTER = ["match", ["geometry-type"], ["MultiPolygon", "Polygon"], true, false];
const BASE_OSM_FILTER = [
  "all",
  BASE_2D_BLDG_FILTER,
  ["!", ["has", "hide_3d"]],
];

const EMPTY_FC = { type: "FeatureCollection", features: [] };

export class BuildingsLayer {
  constructor(mapEngine) {
    this.mapEngine = mapEngine;
    this.cache = new Map();
    this.buildingsVisible = true;
    this.canopyVisible = true;
    this.buildingOpacity = 1.0;

    this.activeModel = null;
    this._lastBuildingsData = EMPTY_FC;
    this._lastCanopyData = EMPTY_FC;
    this._requestTicket = 0;
    this.popup = null;

    if (this.mapEngine && typeof this.mapEngine.onStyleLoad === "function") {
      this.mapEngine.onStyleLoad(() => this.attachToMap());
    }
    this.attachToMap();
  }

  attachToMap() {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map || !this.mapEngine.styleReady) return;

    const beforeId =
      typeof this.mapEngine.get3DBeforeLayerId === "function"
        ? this.mapEngine.get3DBeforeLayerId()
        : this.mapEngine.getFirstSymbolLayerId();

    if (map.getLayer("building")) {
      try {
        map.setPaintProperty("building", "fill-color", "#1e293b");
        map.setPaintProperty("building", "fill-outline-color", "#334155");
      } catch (_err) {
        // Optional in fallback raster style
      }
    }

    // 1. Regional OpenFreeMap 3D context buildings & ground-contact AO (zoom >= 13)
    if (map.getSource("openmaptiles") && !map.getLayer(OSM_BLDG_AO_LAYER)) {
      map.addLayer(
        {
          id: OSM_BLDG_AO_LAYER,
          type: "line",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 13,
          filter: BASE_OSM_FILTER,
          layout: {
            visibility: this.buildingsVisible ? "visible" : "none",
          },
          paint: {
            "line-color": "#020617",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.9, 15.5, 2.2, 18, 3.8],
            "line-blur": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 16, 1.8],
            "line-opacity": Math.min(0.85, 0.72 * this.buildingOpacity),
          },
        },
        beforeId
      );
    }
    if (map.getSource("openmaptiles") && !map.getLayer(OSM_BLDG_3D_LAYER)) {
      map.addLayer(
        {
          id: OSM_BLDG_3D_LAYER,
          type: "fill-extrusion",
          source: "openmaptiles",
          "source-layer": "building",
          minzoom: 13,
          filter: BASE_OSM_FILTER,
          layout: {
            visibility: this.buildingsVisible ? "visible" : "none",
          },
          paint: {
            "fill-extrusion-base": ["coalesce", ["to-number", ["get", "render_min_height"]], 0],
            "fill-extrusion-height": ["coalesce", ["to-number", ["get", "render_height"]], 7],
            "fill-extrusion-color": [
              "interpolate",
              ["linear"],
              ["coalesce", ["to-number", ["get", "render_height"]], 7],
              3,
              "#64748b",
              12,
              "#7c8ea6",
              30,
              "#9fb0c7",
              70,
              "#cbd5e1",
              140,
              "#e2e8f0",
            ],
            "fill-extrusion-opacity": this.buildingOpacity,
            "fill-extrusion-vertical-gradient": true,
          },
        },
        beforeId
      );
    }

    // 2. PALM Static Buildings Source & Layers (2D footprints + 3D extrusions)
    if (!map.getSource(PALM_BLDG_SOURCE)) {
      map.addSource(PALM_BLDG_SOURCE, {
        type: "geojson",
        data: this._lastBuildingsData || EMPTY_FC,
        tolerance: 0,
        maxzoom: 20,
      });
    }
    if (!map.getLayer(PALM_FOOTPRINT_LAYER)) {
      map.addLayer(
        {
          id: PALM_FOOTPRINT_LAYER,
          type: "fill",
          source: PALM_BLDG_SOURCE,
          layout: {
            visibility: this.buildingsVisible ? "none" : "visible",
          },
          paint: {
            "fill-color": "#475569",
            "fill-opacity": 0.52,
            "fill-outline-color": "#cbd5e1",
          },
        },
        beforeId
      );
    }

    // 3. PALM Static Urban Canopy Source & Tiered Layers (LAD / zlad)
    if (!map.getSource(PALM_CANOPY_SOURCE)) {
      map.addSource(PALM_CANOPY_SOURCE, {
        type: "geojson",
        data: this._lastCanopyData || EMPTY_FC,
        tolerance: 0,
        maxzoom: 20,
      });
    }
    PALM_CANOPY_LAYERS.forEach(({ id, tier, color, opacity }) => {
      if (!map.getLayer(id)) {
        map.addLayer(
          {
            id,
            type: "fill-extrusion",
            source: PALM_CANOPY_SOURCE,
            filter: ["==", ["get", "tier"], tier],
            layout: {
              visibility: this.canopyVisible ? "visible" : "none",
            },
            paint: {
              "fill-extrusion-base": ["get", "base_m"],
              "fill-extrusion-height": ["get", "top_m"],
              "fill-extrusion-color": color,
              "fill-extrusion-opacity": opacity,
              "fill-extrusion-vertical-gradient": true,
            },
          },
          beforeId
        );
      }
    });

    // 4. PALM Resolved 3D Buildings & ground-contact AO (above canopy & roads, below place labels)
    if (!map.getLayer(PALM_BLDG_AO_LAYER)) {
      map.addLayer(
        {
          id: PALM_BLDG_AO_LAYER,
          type: "line",
          source: PALM_BLDG_SOURCE,
          layout: {
            visibility: this.buildingsVisible ? "visible" : "none",
          },
          paint: {
            "line-color": "#020617",
            "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.3, 15.5, 2.8, 18, 4.4],
            "line-blur": 1.6,
            "line-opacity": Math.min(0.90, 0.80 * this.buildingOpacity),
          },
        },
        beforeId
      );
    }
    if (!map.getLayer(PALM_BLDG_3D_LAYER)) {
      map.addLayer(
        {
          id: PALM_BLDG_3D_LAYER,
          type: "fill-extrusion",
          source: PALM_BLDG_SOURCE,
          layout: {
            visibility: this.buildingsVisible ? "visible" : "none",
          },
          paint: {
            "fill-extrusion-base": 0,
            "fill-extrusion-height": ["get", "height_agl"],
            "fill-extrusion-color": [
              "interpolate",
              ["linear"],
              ["get", "height_agl"],
              3,
              "#a8a29e",
              10,
              "#d6d3d1",
              22,
              "#e7e5e4",
              50,
              "#fafaf9",
            ],
            "fill-extrusion-opacity": this.buildingOpacity,
            "fill-extrusion-vertical-gradient": true,
          },
        },
        beforeId
      );
    }

    try {
      map.setLight({
        anchor: "map",
        color: "#f8fafc",
        intensity: 0.68,
        position: [1.35, 215, 52],
      });
    } catch (_err) {
      // Optional lighting in older fallback contexts
    }

    this._syncLayerStates();
  }

  async _fetchGeoJson(url) {
    if (this.cache.has(url)) {
      return this.cache.get(url);
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const gj = await res.json();
    this.cache.set(url, gj);
    return gj;
  }

  async setModel(model) {
    const ticket = ++this._requestTicket;
    this.activeModel = model || null;
    this.closePopup();

    const bldgUrl = model && model.buildings_3d && model.buildings_3d.url ? model.buildings_3d.url : null;
    const canopyUrl = model && model.canopy_3d && model.canopy_3d.url ? model.canopy_3d.url : null;

    let bldgData = EMPTY_FC;
    let canopyData = EMPTY_FC;
    try {
      const [bRes, cRes] = await Promise.all([
        bldgUrl ? this._fetchGeoJson(bldgUrl) : Promise.resolve(EMPTY_FC),
        canopyUrl ? this._fetchGeoJson(canopyUrl) : Promise.resolve(EMPTY_FC),
      ]);
      bldgData = bRes || EMPTY_FC;
      canopyData = cRes || EMPTY_FC;
    } catch (err) {
      console.warn("[Dusty Earth] Failed to load 3D morphology layer:", err);
    }

    if (ticket !== this._requestTicket) return { hasPalmBuildings: Boolean(bldgUrl), hasCanopy: Boolean(canopyUrl) };

    this._lastBuildingsData = bldgData;
    this._lastCanopyData = canopyData;

    const map = this.mapEngine ? this.mapEngine.map : null;
    if (map && this.mapEngine.styleReady) {
      if (!map.getSource(PALM_BLDG_SOURCE)) {
        this.attachToMap();
      }
      const bSrc = map.getSource(PALM_BLDG_SOURCE);
      if (bSrc && typeof bSrc.setData === "function") {
        bSrc.setData(bldgData);
      }
      const cSrc = map.getSource(PALM_CANOPY_SOURCE);
      if (cSrc && typeof cSrc.setData === "function") {
        cSrc.setData(canopyData);
      }
      this._syncLayerStates();
    }

    return {
      hasPalmBuildings: Boolean(bldgUrl && bldgData.features && bldgData.features.length > 0),
      hasCanopy: Boolean(canopyUrl && canopyData.features && canopyData.features.length > 0),
    };
  }

  _syncLayerStates() {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map) return;

    const hasPalmBldgs = Boolean(
      this.activeModel &&
      this.activeModel.buildings_3d &&
      this._lastBuildingsData &&
      Array.isArray(this._lastBuildingsData.features) &&
      this._lastBuildingsData.features.length > 0
    );

    const palmVis = this.buildingsVisible && hasPalmBldgs ? "visible" : "none";
    if (map.getLayer(PALM_BLDG_AO_LAYER)) {
      map.setLayoutProperty(PALM_BLDG_AO_LAYER, "visibility", palmVis);
    }
    if (map.getLayer(PALM_BLDG_3D_LAYER)) {
      map.setLayoutProperty(PALM_BLDG_3D_LAYER, "visibility", palmVis);
    }
    if (map.getLayer(PALM_FOOTPRINT_LAYER)) {
      map.setLayoutProperty(PALM_FOOTPRINT_LAYER, "visibility", !this.buildingsVisible && hasPalmBldgs ? "visible" : "none");
    }

    PALM_CANOPY_LAYERS.forEach(({ id }) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", this.canopyVisible ? "visible" : "none");
      }
    });

    let polyFeat = null;
    if (hasPalmBldgs && this.activeModel.grid) {
      try {
        polyFeat = getDomainPolygonFeature(this.activeModel.grid);
      } catch (_err) {
        polyFeat = null;
      }
    }

    const osmVis = this.buildingsVisible ? "visible" : "none";
    [OSM_BLDG_AO_LAYER, OSM_BLDG_3D_LAYER].forEach((layerId) => {
      if (!map.getLayer(layerId)) return;
      map.setLayoutProperty(layerId, "visibility", osmVis);
      if (polyFeat) {
        try {
          map.setFilter(layerId, ["all", BASE_OSM_FILTER, ["!", ["within", polyFeat]]]);
        } catch (_err) {
          map.setLayoutProperty(layerId, "visibility", "none");
        }
      } else {
        try {
          map.setFilter(layerId, BASE_OSM_FILTER);
        } catch (_err) {
          // Ignore if layer missing
        }
      }
    });

    if (map.getLayer("building")) {
      if (this.buildingsVisible) {
        try {
          map.setLayerZoomRange("building", 12, 13);
        } catch (_err) {
          // Ignore if unsupported
        }
        try {
          map.setPaintProperty("building", "fill-opacity", ["step", ["zoom"], 0.30, 13, 0]);
        } catch (_err) {
          // Ignore if unsupported
        }
        try {
          map.setFilter("building", BASE_2D_BLDG_FILTER);
        } catch (_err) {
          // Ignore if unsupported
        }
      } else {
        try {
          map.setLayerZoomRange("building", 12, 24);
        } catch (_err) {
          // Ignore if unsupported
        }
        try {
          map.setPaintProperty("building", "fill-opacity", 0.38);
        } catch (_err) {
          // Ignore if unsupported
        }
        try {
          map.setFilter(
            "building",
            polyFeat ? ["all", BASE_2D_BLDG_FILTER, ["!", ["within", polyFeat]]] : BASE_2D_BLDG_FILTER
          );
        } catch (_err) {
          // Ignore if unsupported
        }
      }
    }
  }

  setBuildingsVisible(visible) {
    this.buildingsVisible = Boolean(visible);
    if (!this.buildingsVisible) {
      this.closePopup();
    }
    this._syncLayerStates();
  }

  setBuildingOpacity(opacity) {
    const val = Math.max(0.3, Math.min(1.0, Number(opacity)));
    this.buildingOpacity = Number.isFinite(val) ? val : 1.0;
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map) return;
    if (map.getLayer(OSM_BLDG_3D_LAYER)) {
      map.setPaintProperty(OSM_BLDG_3D_LAYER, "fill-extrusion-opacity", this.buildingOpacity);
    }
    if (map.getLayer(PALM_BLDG_3D_LAYER)) {
      map.setPaintProperty(PALM_BLDG_3D_LAYER, "fill-extrusion-opacity", this.buildingOpacity);
    }
    if (map.getLayer(OSM_BLDG_AO_LAYER)) {
      map.setPaintProperty(OSM_BLDG_AO_LAYER, "line-opacity", Math.min(0.85, 0.72 * this.buildingOpacity));
    }
    if (map.getLayer(PALM_BLDG_AO_LAYER)) {
      map.setPaintProperty(PALM_BLDG_AO_LAYER, "line-opacity", Math.min(0.90, 0.80 * this.buildingOpacity));
    }
  }

  setCanopyVisible(visible) {
    this.canopyVisible = Boolean(visible);
    this._syncLayerStates();
  }

  queryBuildingAt(point) {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map || !point) return null;

    const layers = (this.buildingsVisible
      ? [PALM_BLDG_3D_LAYER, OSM_BLDG_3D_LAYER]
      : [PALM_FOOTPRINT_LAYER]
    ).filter((id) => Boolean(map.getLayer(id)));

    if (layers.length === 0) return null;
    try {
      const hits = map.queryRenderedFeatures(point, { layers });
      return hits && hits.length > 0 ? hits[0] : null;
    } catch (_err) {
      return null;
    }
  }

  handleMapClick(e, activeModel = null) {
    const hit = this.queryBuildingAt(e.point);
    if (!hit) {
      this.closePopup();
      return false;
    }
    this.showBuildingPopup(hit, e.lngLat, activeModel || this.activeModel);
    return true;
  }

  showBuildingPopup(feature, lngLat, activeModel = null) {
    const map = this.mapEngine ? this.mapEngine.map : null;
    if (!map || !feature) return;

    const props = feature.properties || {};
    const isPalm = feature.layer && (feature.layer.id === PALM_BLDG_3D_LAYER || feature.layer.id === PALM_FOOTPRINT_LAYER);
    const heightM = Number(isPalm ? props.height_agl : props.render_height);
    const heightLabel = Number.isFinite(heightM) ? `${heightM.toFixed(1)} m AGL` : "Unknown height";

    const root = document.createElement("div");
    root.className = "bldg-popup-card";

    const title = document.createElement("div");
    title.className = "bldg-popup-title";
    title.textContent = isPalm ? "PALM-4U Resolved Building" : "OSM 3D Context Building";
    root.appendChild(title);

    const rows = [
      `Height: ${heightLabel}`,
    ];
    if (isPalm) {
      if (props.building_id !== undefined) rows.push(`Building ID: ${props.building_id}`);
      if (props.ground_m !== undefined && Number.isFinite(Number(props.ground_m))) {
        rows.push(`Ground Elev: ${Number(props.ground_m).toFixed(1)} m`);
      }
      if (activeModel && activeModel.badge) {
        rows.push(`Static Driver Grid: ${activeModel.badge} (1:1 fluid mask)`);
      }
    } else if (props.render_min_height && Number(props.render_min_height) > 0) {
      rows.push(`Min Base: ${Number(props.render_min_height).toFixed(1)} m`);
    }

    rows.forEach((lineText) => {
      const line = document.createElement("div");
      line.className = "bldg-popup-row";
      line.textContent = lineText;
      root.appendChild(line);
    });

    this.closePopup();
    this.popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "260px",
    })
      .setLngLat(lngLat)
      .setDOMContent(root)
      .addTo(map);
  }

  closePopup() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
  }
}
