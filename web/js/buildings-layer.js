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
const PALM_BLDG_3D_LAYER = "dusty-palm-buildings-3d";

const PALM_CANOPY_SOURCE = "dusty-palm-canopy";
const PALM_CANOPY_LAYERS = [
  { id: "dusty-palm-canopy-1", tier: 1, color: "#15803d", opacity: 0.28 },
  { id: "dusty-palm-canopy-2", tier: 2, color: "#16a34a", opacity: 0.46 },
  { id: "dusty-palm-canopy-3", tier: 3, color: "#22c55e", opacity: 0.62 },
];

const OSM_BLDG_3D_LAYER = "dusty-osm-buildings-3d";
const BASE_OSM_FILTER = [
  "all",
  ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
  ["!", ["has", "hide_3d"]],
];

const EMPTY_FC = { type: "FeatureCollection", features: [] };

export class BuildingsLayer {
  constructor(mapEngine) {
    this.mapEngine = mapEngine;
    this.cache = new Map();
    this.buildingsVisible = true;
    this.canopyVisible = true;

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

    const beforeId = this.mapEngine.getFirstSymbolLayerId();

    // 1. Regional OpenFreeMap 3D context buildings (zoom >= 13)
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
            "fill-extrusion-height": ["coalesce", ["to-number", ["get", "render_height"]], 6],
            "fill-extrusion-color": [
              "interpolate",
              ["linear"],
              ["coalesce", ["to-number", ["get", "render_height"]], 6],
              3,
              "#334155",
              25,
              "#64748b",
              80,
              "#94a3b8",
            ],
            "fill-extrusion-opacity": 0.80,
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
            "fill-color": "#334155",
            "fill-opacity": 0.60,
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

    // 4. PALM Resolved 3D Buildings (above canopy & scalar field, below labels)
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
              "#64748b",
              12,
              "#94a3b8",
              25,
              "#cbd5e1",
              60,
              "#f1f5f9",
            ],
            "fill-extrusion-opacity": 0.94,
            "fill-extrusion-vertical-gradient": true,
          },
        },
        beforeId
      );
    }

    try {
      map.setLight({
        anchor: "viewport",
        color: "#f8fafc",
        intensity: 0.42,
        position: [1.4, 200, 42],
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

    if (map.getLayer(PALM_BLDG_3D_LAYER)) {
      map.setLayoutProperty(PALM_BLDG_3D_LAYER, "visibility", this.buildingsVisible && hasPalmBldgs ? "visible" : "none");
    }
    if (map.getLayer(PALM_FOOTPRINT_LAYER)) {
      map.setLayoutProperty(PALM_FOOTPRINT_LAYER, "visibility", !this.buildingsVisible && hasPalmBldgs ? "visible" : "none");
    }

    PALM_CANOPY_LAYERS.forEach(({ id }) => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", this.canopyVisible ? "visible" : "none");
      }
    });

    if (map.getLayer(OSM_BLDG_3D_LAYER)) {
      map.setLayoutProperty(OSM_BLDG_3D_LAYER, "visibility", this.buildingsVisible ? "visible" : "none");
      if (hasPalmBldgs && this.activeModel.grid) {
        try {
          const polyFeat = getDomainPolygonFeature(this.activeModel.grid);
          map.setFilter(OSM_BLDG_3D_LAYER, ["all", BASE_OSM_FILTER, ["!", ["within", polyFeat]]]);
        } catch (_err) {
          map.setLayoutProperty(OSM_BLDG_3D_LAYER, "visibility", "none");
        }
      } else {
        try {
          map.setFilter(OSM_BLDG_3D_LAYER, BASE_OSM_FILTER);
        } catch (_err) {
          // Ignore if layer missing
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
