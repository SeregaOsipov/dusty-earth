/**
 * Main Application Controller for Dusty Earth.
 * Orchestrates MapEngine, ScalarLayer, WindParticles, Timeline, WeatherProbe,
 * and Windy-style Multi-Model Resolution Switching (Auto-Zoom + Manual Pin).
 */

import { MapEngine } from "./map-engine.js";
import { ScalarLayer } from "./scalar-layer.js";
import { WindParticles } from "./wind-particles.js";
import { BuildingsLayer } from "./buildings-layer.js";
import { WeatherProbe } from "./probe.js";
import { TimelineController } from "./timeline.js";

class DustyApp {
  constructor() {
    this.manifest = null;
    this.activeCycle = null;
    this.activeModel = null;
    this.activeVariable = null;
    this.autoModelMode = false;
    this.tourScope = "standard"; // "standard" | "radionuclide" | null

    this._autoEvalTimer = null;
    this._isProgrammaticMove = false;
    this._progMoveTimer = null;
    this._tourPlayTimer = null;
    this._tourBannerTimer = null;
    this._tourBannerHideTimer = null;
    this._preloadedNextTourKey = null;
    this._preferredAtmoVarId = null;
    this._preferredRnVarId = "rn_i131_sfc";
    this._autoTilted = false;
    this._lastBoundsSig = null;
    this._timestepTicket = 0;
    this._renderInFlight = false;
    this._queuedPlayTimestep = null;
    this._lastWindUpdateMs = 0;
    this._previewState = null;

    this.mapEngine = new MapEngine("map");
    this.scalarLayer = null;
    this.buildingsLayer = null;
    this.windParticles = null;
    this.probe = null;
    this.timeline = null;

    this.showWindOverlay = true;
    this.showBuildings3D = true;
    this.showCanopy3D = true;
    this.showMapLabels = true;

    this.dom = {
      cycleSelect: document.getElementById("cycle-select"),
      modelSelectorBar: document.getElementById("model-selector-bar"),
      modelTourBtn: document.getElementById("btn-model-tour"),
      modelAutoBtn: document.getElementById("btn-model-auto"),
      modelPillsList: document.getElementById("model-pills-list"),
      tourBanner: document.getElementById("tour-stage-banner"),
      tourBannerStep: document.getElementById("tour-stage-step"),
      tourBannerTitle: document.getElementById("tour-stage-title"),
      tourBannerBadge: document.getElementById("tour-stage-badge"),
      domainPreviewCard: document.getElementById("domain-preview-card"),
      domainPreviewOverlay: document.getElementById("domain-preview-overlay"),
      layerDock: document.getElementById("layer-dock-list"),
      windToggleBtn: document.getElementById("btn-toggle-wind"),
      buildingsToggleBtn: document.getElementById("btn-toggle-buildings"),
      canopyToggleBtn: document.getElementById("btn-toggle-canopy"),
      legendDock: document.getElementById("legend-dock"),
      legendTitle: document.getElementById("legend-var-title"),
      legendUnits: document.getElementById("legend-var-units"),
      legendGradient: document.getElementById("legend-gradient"),
      legendMin: document.getElementById("legend-min"),
      legendMax: document.getElementById("legend-max"),
      weatherProbe: document.getElementById("weather-probe"),
      // Timeline DOM references
      playBtn: document.getElementById("btn-play"),
      playIcon: document.getElementById("play-icon"),
      playLabel: document.getElementById("play-label"),
      prevBtn: document.getElementById("btn-prev"),
      nextBtn: document.getElementById("btn-next"),
      firstBtn: document.getElementById("btn-first"),
      lastBtn: document.getElementById("btn-last"),
      slider: document.getElementById("timeline-slider"),
      ticksContainer: document.getElementById("timeline-ticks"),
      validTime: document.getElementById("scrub-valid-time"),
      leadTime: document.getElementById("scrub-lead-time"),
      loopBtn: document.getElementById("btn-loop-mode"),
      fpsSlider: document.getElementById("fps-slider"),
      fpsValue: document.getElementById("fps-value"),
      // Settings panel
      settingsBtn: document.getElementById("btn-settings"),
      settingsPanel: document.getElementById("settings-panel"),
      settingsClose: document.getElementById("settings-close"),
      settingTourBtn: document.getElementById("btn-setting-tour"),
      settingRnTourBtn: document.getElementById("btn-setting-rn-tour"),
      particleCountSlider: document.getElementById("setting-particle-count"),
      particleCountVal: document.getElementById("setting-particle-count-val"),
      particleSpeedSlider: document.getElementById("setting-particle-speed"),
      particleSpeedVal: document.getElementById("setting-particle-speed-val"),
      fieldOpacitySlider: document.getElementById("setting-field-opacity"),
      fieldOpacityVal: document.getElementById("setting-field-opacity-val"),
      bldgOpacitySlider: document.getElementById("setting-bldg-opacity"),
      bldgOpacityVal: document.getElementById("setting-bldg-opacity-val"),
      labelsToggleBtn: document.getElementById("btn-toggle-labels"),
      // Model Info & Scientific Attribution Modal
      modelInfoBtn: document.getElementById("btn-model-info"),
      attrLeadTrigger: document.getElementById("attr-lead-trigger"),
      attrInfoTrigger: document.getElementById("attr-info-trigger"),
      modelInfoBackdrop: document.getElementById("model-info-backdrop"),
      modelInfoModal: document.getElementById("model-info-modal"),
      modelInfoClose: document.getElementById("model-info-close"),
      copyCitationBtn: document.getElementById("btn-copy-citation"),
      citationText: document.getElementById("citation-text"),
    };
  }

  async init() {
    console.info(
      [
        "========================================================================",
        " Dusty Earth — Operational Atmospheric & Air Quality Forecasting System",
        " Build Version : v1.4.0 (WebGL Scene-Graph & 3D Urban Buildings/Canopy)",
        " Modeling Core : WRF-Chem / PALM-4U / ICON-ART Multi-Scale Pipeline",
        " Institution   : QEERI / Hamad Bin Khalifa University (HBKU)",
        " Lead PI & System Architect: Dr. Sergey Osipov (QEERI / HBKU)",
        "========================================================================",
      ].join("\n")
    );

    await this.mapEngine.init([50.0, 25.0], 5.0);

    this.scalarLayer = new ScalarLayer(this.mapEngine);
    this.scalarLayer.attachToMap();
    this.buildingsLayer = new BuildingsLayer(this.mapEngine);
    this.windParticles = new WindParticles(this.mapEngine.particleCanvas, this.mapEngine);
    this.probe = new WeatherProbe(
      this.dom.weatherProbe,
      this.mapEngine,
      this.scalarLayer,
      this.windParticles
    );
    this.probe.setBuildingsLayer(this.buildingsLayer);

    this.mapEngine.onMove(() => {
      this.scalarLayer.render();
      if (this.windParticles && this.showWindOverlay) {
        this.windParticles.clear();
      }
      if (this._previewState) {
        this._updatePreviewOverlay();
      }
    });

    if (this.mapEngine.map) {
      ["dragstart", "zoomstart", "rotatestart", "pitchstart", "boxzoomstart"].forEach((evtName) => {
        this.mapEngine.map.on(evtName, (e) => {
          if (e && e.originalEvent && this.tourScope) {
            this.disableTourMode(`map-${evtName}`);
          }
        });
      });
      const mapContainer = this.mapEngine.map.getContainer ? this.mapEngine.map.getContainer() : null;
      if (mapContainer) {
        mapContainer.addEventListener("pointerdown", (e) => {
          if (e.target && e.target.closest && e.target.closest(".maplibregl-ctrl-group") && this.tourScope) {
            this.disableTourMode("map-nav-ctrl");
          }
        });
      }

      this.mapEngine.map.on("moveend", () => {
        if (!this._isProgrammaticMove) {
          this._scheduleAutoModelEval();
        }
        if (this.windParticles && this.showWindOverlay) {
          const b = this.mapEngine.map.getBounds();
          const sig = b
            ? `${b.getWest().toFixed(2)}:${b.getEast().toFixed(2)}:${this.mapEngine.map.getZoom().toFixed(1)}`
            : null;
          if (sig && sig !== this._lastBoundsSig) {
            this._lastBoundsSig = sig;
            this.windParticles.respawnInView();
          }
        }
      });
    }

    this.timeline = new TimelineController(this.dom);
    this.timeline.onFrameChange((timestep) => {
      this.loadTimestep(timestep);
      if (
        !this.tourScope &&
        this.autoModelMode &&
        this.activeModel &&
        timestep &&
        !this._isModelTemporallyValid(this.activeModel, timestep.valid_time)
      ) {
        this._scheduleAutoModelEval(40);
      }
    });
    this.timeline.onSequenceEnd(() => {
      this._advanceTourToNextModel();
    });
    this.timeline.onUserTransport((action) => {
      if (this.tourScope) {
        this.disableTourMode(`timeline-${action}`);
      }
    });

    this._bindEvents();
    await this.loadManifest();
  }

  _versionAssetUrl(url, vTag) {
    if (!url || !vTag || /[?&]v=/.test(url)) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(vTag)}`;
  }

  _normalizeCycleModels(cycle) {
    const rawModels =
      cycle.models && Array.isArray(cycle.models) && cycle.models.length > 0
        ? cycle.models
        : [
            {
              id: "default",
              name: "Operational Forecast",
              short_name: "Forecast",
              badge: cycle.grid && cycle.grid.dx_m ? `${Math.round(cycle.grid.dx_m / 1000)} km` : "10 km",
              model_family: "wrf",
              resolution_m: cycle.grid && cycle.grid.dx_m ? cycle.grid.dx_m : 10000,
              min_auto_zoom: 0.0,
              exit_auto_zoom: 0.0,
              grid: cycle.grid,
              variables: cycle.variables || [],
              timesteps: cycle.timesteps || [],
            },
          ];

    const vTag = cycle.export_id || cycle.exported_at || (this.manifest && this.manifest.generated_at) || "";
    if (!vTag) return rawModels;

    rawModels.forEach((m) => {
      (m.timesteps || []).forEach((ts) => {
        if (!ts || !ts.files) return;
        Object.values(ts.files).forEach((entry) => {
          if (!entry || typeof entry !== "object") return;
          if (entry.scalar) entry.scalar = this._versionAssetUrl(entry.scalar, vTag);
          if (entry.u) entry.u = this._versionAssetUrl(entry.u, vTag);
          if (entry.v) entry.v = this._versionAssetUrl(entry.v, vTag);
        });
      });
      if (m.buildings_3d && m.buildings_3d.url) {
        m.buildings_3d.url = this._versionAssetUrl(m.buildings_3d.url, vTag);
      }
      if (m.canopy_3d && m.canopy_3d.url) {
        m.canopy_3d.url = this._versionAssetUrl(m.canopy_3d.url, vTag);
      }
    });
    return rawModels;
  }

  async loadManifest() {
    try {
      const res = await fetch(`manifest.json?_t=${Date.now()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      this.manifest = await res.json();
      console.log("[Dusty Earth] Loaded manifest:", this.manifest);

      const cycles = this.manifest.cycles || [];
      if (cycles.length === 0) {
        alert("No forecast cycles found in manifest.json. Run dusty-export first.");
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const urlCycleId = params.get("cycle");
      const urlModelId = params.get("model");
      const urlVarId = params.get("var");
      const urlTourParam = (params.get("tour") || "").trim().toLowerCase();

      if (urlVarId) {
        this._preferredAtmoVarId = urlVarId;
      }

      let initialTourScope = "standard";
      if (urlModelId || ["0", "false", "off", "none"].includes(urlTourParam)) {
        initialTourScope = null;
      } else if (["rn", "radionuclide"].includes(urlTourParam)) {
        initialTourScope = "radionuclide";
      }

      this._populateCycles(cycles);
      const startCycleId =
        urlCycleId && cycles.some((c) => c.id === urlCycleId)
          ? urlCycleId
          : this.manifest.default_cycle || cycles[0].id;
      this.selectCycle(startCycleId, {
        preferredModelId: urlModelId,
        preferredVarId: urlVarId,
        tourScope: initialTourScope,
      });
    } catch (err) {
      console.error("[Dusty Earth] Failed to load manifest.json:", err);
      this.dom.legendTitle.textContent = "Waiting for manifest.json...";
    }
  }

  _populateCycles(cycles) {
    this.dom.cycleSelect.innerHTML = "";
    cycles.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.label || c.id;
      this.dom.cycleSelect.appendChild(opt);
    });
  }

  _runProgrammaticCamera(actionFn, fallbackMs = 1250) {
    if (!this.mapEngine.map) return;
    this._isProgrammaticMove = true;
    if (this._progMoveTimer) clearTimeout(this._progMoveTimer);
    this.mapEngine.map.once("moveend", () => {
      this._isProgrammaticMove = false;
      if (this._progMoveTimer) {
        clearTimeout(this._progMoveTimer);
        this._progMoveTimer = null;
      }
    });
    actionFn();
    this._progMoveTimer = setTimeout(() => {
      this._isProgrammaticMove = false;
      this._progMoveTimer = null;
    }, fallbackMs);
  }

  _fitBoundsSafe(gridMeta, extra = {}) {
    if (!gridMeta || !this.mapEngine.map) return;
    const dur = typeof extra.duration === "number" ? extra.duration : 1000;
    this._runProgrammaticCamera(
      () => this.mapEngine.fitBounds(gridMeta.lon_min, gridMeta.lat_min, gridMeta.lon_max, gridMeta.lat_max, 45, extra),
      dur + 500
    );
  }

  _updateToggleButtonUI(btn, isOn) {
    if (!btn) return;
    btn.classList.toggle("active", Boolean(isOn));
    const stateEl = btn.querySelector(".toggle-state");
    if (stateEl) {
      stateEl.textContent = isOn ? "ON" : "OFF";
    }
  }

  selectCycle(cycleId, { preferredModelId = null, preferredVarId = null, tourScope = undefined } = {}) {
    const cycle = this.manifest.cycles.find((c) => c.id === cycleId) || this.manifest.cycles[0];
    if (!cycle) return;

    if (this._tourPlayTimer) {
      clearTimeout(this._tourPlayTimer);
      this._tourPlayTimer = null;
    }
    this._preloadedNextTourKey = null;
    this._hideTourStageBanner();

    cycle.models = this._normalizeCycleModels(cycle);
    this.activeCycle = cycle;
    this.activeModel = null;
    this.dom.cycleSelect.value = cycle.id;

    this._populateModels(cycle.models);

    if (this.dom.settingRnTourBtn) {
      this.dom.settingRnTourBtn.hidden = this._getTourPlaylist("radionuclide").length === 0;
    }

    const explicitModel = preferredModelId ? cycle.models.find((m) => m.id === preferredModelId) : null;
    let requestedScope = tourScope !== undefined ? tourScope : this.tourScope;

    if (explicitModel) {
      this.tourScope = null;
      this.autoModelMode = false;
      if (this.timeline) this.timeline.setTourMode(false);
      this.selectModel(explicitModel.id, { fromAuto: false, fitView: true, preferredVarId });
      return;
    }

    if (requestedScope) {
      let playlist = this._getTourPlaylist(requestedScope);
      if (playlist.length === 0 && requestedScope === "radionuclide") {
        requestedScope = "standard";
        playlist = this._getTourPlaylist("standard");
      }
      if (playlist.length > 0) {
        this.enableTourMode(requestedScope, { restartFromFirst: true, preferredVarId });
        return;
      }
    }

    this.tourScope = null;
    this.autoModelMode = true;
    if (this.timeline) this.timeline.setTourMode(false);
    const startModel = cycle.models.find((m) => m.id === cycle.default_model) || cycle.models[0];
    this.selectModel(startModel.id, { fromAuto: true, fitView: true, preferredVarId });
  }

  _getTourPlaylist(scope = "standard") {
    if (!this.activeCycle || !Array.isArray(this.activeCycle.models)) return [];
    const groups = this._groupModelsByFamily(this.activeCycle.models);
    const ordered = [];
    for (const grp of groups) {
      const isRn = grp.meta.key === "radionuclide";
      if (scope === "radionuclide" && !isRn) continue;
      if (scope !== "radionuclide" && isRn) continue;
      ordered.push(...grp.models);
    }
    const playable = ordered.filter((m) => Array.isArray(m.timesteps) && m.timesteps.length >= 2);
    return playable.length > 0
      ? playable
      : ordered.filter((m) => Array.isArray(m.timesteps) && m.timesteps.length > 0);
  }

  enableTourMode(scope = "standard", { restartFromFirst = false, preferredVarId = null } = {}) {
    const playlist = this._getTourPlaylist(scope);
    if (playlist.length === 0) return false;

    if (this._tourPlayTimer) {
      clearTimeout(this._tourPlayTimer);
      this._tourPlayTimer = null;
    }
    this._preloadedNextTourKey = null;
    this.tourScope = scope;
    this.autoModelMode = false;
    if (this.timeline) {
      this.timeline.pause();
      this.timeline.setTourMode(true);
    }

    const currIdx = this.activeModel ? playlist.findIndex((m) => m.id === this.activeModel.id) : -1;
    const targetIdx = !restartFromFirst && currIdx >= 0 ? currIdx : 0;
    const targetModel = playlist[targetIdx];

    const atEnd =
      this.timeline &&
      this.timeline.timesteps.length > 1 &&
      this.timeline.currentIndex >= this.timeline.timesteps.length - 1;
    const resetStart = restartFromFirst || currIdx < 0 || atEnd;

    this.selectModel(targetModel.id, {
      fromTour: true,
      fitView: true,
      fitDurationMs: 1650,
      resetTimelineToStart: resetStart,
      preferredVarId,
    });

    this._showTourStageBanner(targetModel, targetIdx + 1, playlist.length, scope);

    const expectedId = targetModel.id;
    this._tourPlayTimer = setTimeout(() => {
      this._tourPlayTimer = null;
      if (this.tourScope === scope && this.activeModel && this.activeModel.id === expectedId && this.timeline) {
        this.timeline.play();
      }
    }, 1050);
    return true;
  }

  disableTourMode(reason = "manual") {
    if (this._tourPlayTimer) {
      clearTimeout(this._tourPlayTimer);
      this._tourPlayTimer = null;
    }
    this._preloadedNextTourKey = null;
    const wasActive = Boolean(this.tourScope);
    this.tourScope = null;
    if (this.timeline) {
      this.timeline.setTourMode(false);
    }
    this._hideTourStageBanner();
    if (wasActive) {
      console.log(`[Dusty Earth] Presentation tour paused (${reason}).`);
      this._syncModelSelectorUI();
    }
  }

  _advanceTourToNextModel() {
    const scope = this.tourScope;
    if (!scope) return;
    const playlist = this._getTourPlaylist(scope);
    if (playlist.length === 0) {
      this.disableTourMode("empty-playlist");
      return;
    }
    const currIdx = this.activeModel ? playlist.findIndex((m) => m.id === this.activeModel.id) : -1;
    const nextIdx = currIdx >= 0 ? (currIdx + 1) % playlist.length : 0;
    const nextModel = playlist[nextIdx];

    this._preloadedNextTourKey = null;
    this.selectModel(nextModel.id, {
      fromTour: true,
      fitView: true,
      fitDurationMs: 1950,
      resetTimelineToStart: true,
    });

    this._showTourStageBanner(nextModel, nextIdx + 1, playlist.length, scope);

    if (this._tourPlayTimer) {
      clearTimeout(this._tourPlayTimer);
    }
    const expectedId = nextModel.id;
    this._tourPlayTimer = setTimeout(() => {
      this._tourPlayTimer = null;
      if (this.tourScope === scope && this.activeModel && this.activeModel.id === expectedId && this.timeline) {
        this.timeline.play();
      }
    }, 1250);
  }

  _showTourStageBanner(model, indexOneBased, totalCount, scope = "standard") {
    const banner = this.dom.tourBanner;
    if (!banner || !model) return;
    if (this._tourBannerTimer) clearTimeout(this._tourBannerTimer);
    if (this._tourBannerHideTimer) clearTimeout(this._tourBannerHideTimer);

    const fam = this._getModelFamilyMeta(model);
    banner.style.setProperty("--stage-color", fam.color);
    if (this.dom.tourBannerStep) {
      const icon = scope === "radionuclide" ? "☢️" : "🎬";
      this.dom.tourBannerStep.textContent = `${icon} ${indexOneBased}/${totalCount}`;
    }
    if (this.dom.tourBannerTitle) {
      this.dom.tourBannerTitle.textContent = model.name || fam.label;
    }
    if (this.dom.tourBannerBadge) {
      this.dom.tourBannerBadge.textContent = model.badge || this._formatGridSpacing(model.resolution_m);
    }

    banner.classList.remove("fade-out");
    banner.hidden = false;

    this._tourBannerTimer = setTimeout(() => {
      this._tourBannerTimer = null;
      banner.classList.add("fade-out");
      this._tourBannerHideTimer = setTimeout(() => {
        this._tourBannerHideTimer = null;
        banner.hidden = true;
      }, 340);
    }, 2600);
  }

  _hideTourStageBanner() {
    if (this._tourBannerTimer) {
      clearTimeout(this._tourBannerTimer);
      this._tourBannerTimer = null;
    }
    if (this._tourBannerHideTimer) {
      clearTimeout(this._tourBannerHideTimer);
      this._tourBannerHideTimer = null;
    }
    if (this.dom.tourBanner) {
      this.dom.tourBanner.classList.remove("fade-out");
      this.dom.tourBanner.hidden = true;
    }
  }

  _escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  _getModelFamilyMeta(model) {
    const rawFam = String((model && model.model_family) || "").toLowerCase();
    const idName = `${(model && model.id) || ""} ${(model && model.name) || ""}`.toLowerCase();
    let fam = rawFam;
    if (!fam || fam === "generic") {
      if (idName.includes("rn_") || idName.includes("radionuclide")) fam = "radionuclide";
      else if (idName.includes("wrf")) fam = "wrf";
      else if (idName.includes("icon")) fam = "icon";
      else if (idName.includes("palm")) fam = "palm";
      else if (idName.includes("cams")) fam = "cams";
    }
    const table = {
      wrf: {
        key: "wrf",
        label: "WRF-Chem",
        color: "#38bdf8",
        glow: "rgba(56, 189, 248, 0.38)",
        fill: "rgba(56, 189, 248, 0.09)",
      },
      icon: {
        key: "icon",
        label: "ICON-ART",
        color: "#f59e0b",
        glow: "rgba(245, 158, 11, 0.40)",
        fill: "rgba(245, 158, 11, 0.10)",
      },
      palm: {
        key: "palm",
        label: "PALM-4U",
        color: "#10b981",
        glow: "rgba(16, 185, 129, 0.42)",
        fill: "rgba(16, 185, 129, 0.13)",
      },
      cams: {
        key: "cams",
        label: "CAMS",
        color: "#a78bfa",
        glow: "rgba(167, 139, 250, 0.38)",
        fill: "rgba(167, 139, 250, 0.09)",
      },
      radionuclide: {
        key: "radionuclide",
        label: "☢ Radionuclide",
        color: "#f43f5e",
        glow: "rgba(244, 63, 94, 0.42)",
        fill: "rgba(244, 63, 94, 0.11)",
      },
    };
    return (
      table[fam] || {
        key: fam || "generic",
        label: "Forecast",
        color: "#cbd5e1",
        glow: "rgba(203, 213, 225, 0.32)",
        fill: "rgba(203, 213, 225, 0.08)",
      }
    );
  }

  _groupModelsByFamily(models) {
    const groupsMap = new Map();
    (models || []).forEach((m) => {
      const meta = this._getModelFamilyMeta(m);
      if (!groupsMap.has(meta.key)) {
        groupsMap.set(meta.key, { meta, models: [] });
      }
      groupsMap.get(meta.key).models.push(m);
    });

    const groups = Array.from(groupsMap.values());
    groups.forEach((group) => {
      group.models.sort((a, b) => (Number(b.resolution_m) || 0) - (Number(a.resolution_m) || 0));
      const badgeCounts = new Map();
      group.models.forEach((m) => {
        const b = String(m.badge || m.short_name || m.id || "");
        badgeCounts.set(b, (badgeCounts.get(b) || 0) + 1);
      });
      group.chipLabels = new Map();
      group.models.forEach((m) => {
        const b = String(m.badge || m.short_name || m.id || "");
        if ((badgeCounts.get(b) || 0) > 1) {
          const cleanName = String(m.name || m.id || "")
            .replace(/\(.*?\)/g, "")
            .trim()
            .split(/\s+/)
            .slice(-1)[0];
          group.chipLabels.set(m.id, cleanName ? `${b} ${cleanName}` : b);
        } else {
          group.chipLabels.set(m.id, b);
        }
      });
    });

    groups.sort((a, b) => {
      const aRn = a.meta.key === "radionuclide" ? 1 : 0;
      const bRn = b.meta.key === "radionuclide" ? 1 : 0;
      if (aRn !== bRn) return aRn - bRn;
      return (
        (Number(b.models[0] && b.models[0].resolution_m) || 0) -
        (Number(a.models[0] && a.models[0].resolution_m) || 0)
      );
    });
    return groups;
  }

  _populateModels(models) {
    if (!this.dom.modelPillsList) return;
    this.dom.modelPillsList.innerHTML = "";
    this._clearDomainPreview();

    const groups = this._groupModelsByFamily(models);
    groups.forEach((group) => {
      const wrap = document.createElement("div");
      wrap.className = "model-family-group";
      wrap.dataset.family = group.meta.key;
      wrap.style.setProperty("--family-color", group.meta.color);

      const famBtn = document.createElement("button");
      famBtn.type = "button";
      famBtn.className = "model-family-btn";
      famBtn.title = `${group.meta.label} (${group.models.map((m) => m.badge).join(" / ")}) — hover to preview domains, click to select or cycle`;
      famBtn.innerHTML = `<span class="model-family-dot"></span><span class="model-family-name">${this._escapeHtml(group.meta.label)}</span>`;

      const showFamPreview = () => {
        this._showDomainPreview({
          mode: "family",
          familyMeta: group.meta,
          models: group.models,
        });
      };
      famBtn.addEventListener("mouseenter", showFamPreview);
      famBtn.addEventListener("focus", showFamPreview);
      famBtn.addEventListener("click", () => {
        this.disableTourMode("family-btn");
        this.autoModelMode = false;
        const currIdx = this.activeModel ? group.models.findIndex((m) => m.id === this.activeModel.id) : -1;
        let targetModel;
        if (currIdx >= 0 && group.models.length > 1) {
          targetModel = group.models[(currIdx + 1) % group.models.length];
        } else {
          targetModel = group.models.find((m) => this._isModelVisibleInViewport(m)) || group.models[0];
        }
        const needsFit =
          !this._isModelVisibleInViewport(targetModel) ||
          this._getModelViewportFraction(targetModel) < 0.05;
        this.selectModel(targetModel.id, { fromAuto: false, fitView: needsFit });
      });
      wrap.appendChild(famBtn);

      const resList = document.createElement("div");
      resList.className = "model-res-list";

      if (group.meta.key === "radionuclide" && group.models.length > 0) {
        const rnTourBtn = document.createElement("button");
        rnTourBtn.type = "button";
        rnTourBtn.className = "model-pill model-rn-tour-btn";
        rnTourBtn.dataset.family = "radionuclide";
        rnTourBtn.textContent = "▶ Demo";
        rnTourBtn.title = "Cycle through radionuclide dispersion scenarios separately from the main tour";
        const showRnTourPreview = () => {
          this._showDomainPreview({
            mode: "rn-tour",
            familyMeta: group.meta,
            models: this._getTourPlaylist("radionuclide"),
          });
        };
        rnTourBtn.addEventListener("mouseenter", showRnTourPreview);
        rnTourBtn.addEventListener("focus", showRnTourPreview);
        rnTourBtn.addEventListener("click", () => {
          if (this.tourScope === "radionuclide") {
            this.disableTourMode("rn-demo-btn");
          } else {
            this.enableTourMode("radionuclide", { restartFromFirst: false });
          }
        });
        resList.appendChild(rnTourBtn);
      }

      group.models.forEach((m) => {
        const chipLabel = group.chipLabels.get(m.id) || m.badge || m.short_name || m.id;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "model-pill model-res-btn";
        btn.dataset.modelId = m.id;
        btn.dataset.family = group.meta.key;
        btn.textContent = chipLabel;
        btn.title = `${m.name} (${(m.timesteps || []).length} steps)`;

        const showModelPreview = () => {
          this._showDomainPreview({
            mode: "model",
            familyMeta: group.meta,
            models: [m],
          });
        };
        btn.addEventListener("mouseenter", showModelPreview);
        btn.addEventListener("focus", showModelPreview);
        btn.addEventListener("click", () => {
          this.disableTourMode("model-pill");
          this.autoModelMode = false;
          this._syncModelSelectorUI();
          const needsFit =
            !this._isModelVisibleInViewport(m) ||
            this._getModelViewportFraction(m) < 0.05;
          this.selectModel(m.id, { fromAuto: false, fitView: needsFit });
        });
        resList.appendChild(btn);
      });

      wrap.appendChild(resList);
      this.dom.modelPillsList.appendChild(wrap);
    });

    this._syncModelSelectorUI();
  }

  _syncModelSelectorUI() {
    if (this.dom.modelTourBtn) {
      this.dom.modelTourBtn.classList.toggle("active", this.tourScope === "standard");
    }
    if (this.dom.modelAutoBtn) {
      this.dom.modelAutoBtn.classList.toggle("active", !this.tourScope && this.autoModelMode);
    }
    if (this.dom.settingTourBtn) {
      this._updateToggleButtonUI(this.dom.settingTourBtn, this.tourScope === "standard");
    }
    if (this.dom.settingRnTourBtn) {
      this._updateToggleButtonUI(this.dom.settingRnTourBtn, this.tourScope === "radionuclide");
    }
    if (!this.dom.modelPillsList || !this.activeCycle) return;

    const currentTs = this.timeline ? this.timeline.getCurrentTimestep() : null;
    const currentMs = currentTs ? Date.parse(currentTs.valid_time) : Number.NaN;
    const activeFamily = this.activeModel ? this._getModelFamilyMeta(this.activeModel).key : null;

    this.dom.modelPillsList.querySelectorAll(".model-family-group").forEach((grp) => {
      grp.classList.toggle("active-family", Boolean(activeFamily && grp.dataset.family === activeFamily));
    });

    this.dom.modelPillsList.querySelectorAll(".model-rn-tour-btn").forEach((btn) => {
      btn.classList.toggle("active", this.tourScope === "radionuclide");
    });

    this.dom.modelPillsList.querySelectorAll(".model-res-btn").forEach((btn) => {
      const mid = btn.dataset.modelId;
      const m = this.activeCycle.models.find((item) => item.id === mid);
      const isActive = this.activeModel && this.activeModel.id === mid;
      btn.classList.toggle("active", Boolean(isActive));

      let outOfRange = false;
      if (m && m.timesteps && m.timesteps.length > 0 && !Number.isNaN(currentMs)) {
        const t0 = Date.parse(m.timesteps[0].valid_time);
        const t1 = Date.parse(m.timesteps[m.timesteps.length - 1].valid_time);
        outOfRange = currentMs < t0 - 1800 * 1000 || currentMs > t1 + 1800 * 1000;
      }
      btn.classList.toggle("out-of-range", outOfRange && !isActive);
    });

    if (this._previewState) {
      this._updatePreviewOverlay();
    }
  }

  _resolvePreferredVariable(vars, preferredVarId, isRnModel) {
    if (!Array.isArray(vars) || vars.length === 0) return null;
    const desired = preferredVarId || (isRnModel ? this._preferredRnVarId : this._preferredAtmoVarId);
    if (desired) {
      const direct = vars.find((v) => v.id === desired && (!isRnModel || v.category === "radionuclide"));
      if (direct) return direct;
      if (!isRnModel) {
        const synonymGroups = [
          ["sconc_dust", "pm25", "pm10", "dust_load", "dod550"],
          ["no2", "nox"],
        ];
        for (const group of synonymGroups) {
          if (group.includes(desired)) {
            for (const candId of group) {
              const found = vars.find((v) => v.id === candId);
              if (found) return found;
            }
          }
        }
      }
    }
    if (this.activeVariable && (!isRnModel || this.activeVariable.category === "radionuclide")) {
      const currSame = vars.find((v) => v.id === this.activeVariable.id);
      if (currSame) return currSame;
    }
    const fallbacks = isRnModel
      ? ["rn_i131_sfc", "rn_cs137_sfc"]
      : ["wind10m", "pm25", "no2", "sconc_dust"];
    for (const fid of fallbacks) {
      const hit = vars.find((v) => v.id === fid);
      if (hit) return hit;
    }
    return vars[0];
  }

  selectModel(
    modelId,
    {
      fromAuto = false,
      fromTour = false,
      fitView = false,
      fitDurationMs = 1000,
      resetTimelineToStart = false,
      preferredVarId = null,
    } = {}
  ) {
    if (!this.activeCycle || !this.activeCycle.models) return;
    const modelIndex = this.activeCycle.models.findIndex((m) => m.id === modelId);
    const model = modelIndex >= 0 ? this.activeCycle.models[modelIndex] : this.activeCycle.models[0];
    if (!model) return;

    const targetUtc = this.timeline ? this.timeline.getPlayheadIso() : null;
    const wasSameModel = this.activeModel && this.activeModel.id === model.id;

    if (!wasSameModel && this.activeModel) {
      this.scalarLayer.beginModelTransition(fromTour ? 480 : 200);
    }

    this._queuedPlayTimestep = null;
    this.activeModel = model;
    this.scalarLayer.setDomainOutline(modelIndex > 0);
    this.probe.setModelMeta(model);

    if (this.dom.canopyToggleBtn) {
      this.dom.canopyToggleBtn.hidden = !(model.canopy_3d && model.canopy_3d.url);
    }
    if (this.buildingsLayer) {
      this.buildingsLayer.setModel(model);
    }

    const isMicro = Number(model.resolution_m) <= 250;
    const map = this.mapEngine.map;
    if (fitView && model.grid) {
      const camExtra =
        isMicro && this.showBuildings3D
          ? { pitch: 50, bearing: -15, duration: fitDurationMs, essential: true }
          : this._autoTilted || fromTour
          ? { pitch: 0, bearing: 0, duration: fitDurationMs, essential: true }
          : { duration: fitDurationMs, essential: true };
      this._fitBoundsSafe(model.grid, camExtra);
      this._autoTilted = isMicro && this.showBuildings3D;
    } else if (map) {
      if (isMicro && this.showBuildings3D) {
        if (map.getPitch() < 25 && map.getZoom() >= 12.5) {
          this._runProgrammaticCamera(() => map.easeTo({ pitch: 50, bearing: -15, duration: 750 }), 900);
        }
        this._autoTilted = true;
      } else if (!isMicro && this._autoTilted) {
        this._runProgrammaticCamera(() => map.easeTo({ pitch: 0, bearing: 0, duration: 650 }), 800);
        this._autoTilted = false;
      }
    }

    const vars = model.variables || [];
    this._populateVariables(vars);

    const isRnModel = String(model.model_family || "").toLowerCase() === "radionuclide";
    const activeVarObj = this._resolvePreferredVariable(vars, preferredVarId, isRnModel);
    if (activeVarObj) {
      this.activeVariable = activeVarObj;
      this.probe.setVarConfig(activeVarObj);
      this._updateLegend(activeVarObj);
      this.dom.layerDock.querySelectorAll(".layer-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.id === activeVarObj.id);
      });
    }

    this.timeline.setTimesteps(model.timesteps || [], false, this.activeCycle.init_time);
    if (resetTimelineToStart) {
      this.timeline.goTo(0, false);
    } else if (targetUtc) {
      this.timeline.syncToUtc(targetUtc, false);
    } else {
      this.timeline.goTo(0, false);
    }

    this._syncModelSelectorUI();

    const frameTs = this.timeline.getCurrentTimestep();
    if (frameTs) {
      this.loadTimestep(frameTs);
    }
    this.windParticles.respawnInView();

    if (fromAuto) {
      console.log(`[Dusty Earth] Auto-selected model: ${model.name} (${model.badge})`);
    } else if (fromTour) {
      console.log(`[Dusty Earth] Tour presenting model: ${model.name} (${model.badge})`);
    }
  }

  _isModelVisibleInViewport(model) {
    if (!model || !model.grid || !this.mapEngine.map) return true;
    const b = this.mapEngine.map.getBounds();
    if (!b) return true;
    const center = this.mapEngine.map.getCenter();
    const g = model.grid;

    if (center) {
      if (center.lng >= g.lon_min && center.lng <= g.lon_max && center.lat >= g.lat_min && center.lat <= g.lat_max) {
        return true;
      }
    }

    const vW = b.getEast() - b.getWest();
    const vH = b.getNorth() - b.getSouth();
    const oW = Math.max(0, Math.min(b.getEast(), g.lon_max) - Math.max(b.getWest(), g.lon_min));
    const oH = Math.max(0, Math.min(b.getNorth(), g.lat_max) - Math.max(b.getSouth(), g.lat_min));
    if (oW <= 0 || oH <= 0 || vW <= 0 || vH <= 0) return false;

    const viewFrac = (oW * oH) / (vW * vH);
    const gridArea = Math.max(1e-10, (g.lon_max - g.lon_min) * (g.lat_max - g.lat_min));
    const domFrac = (oW * oH) / gridArea;
    return viewFrac >= 0.28 || domFrac >= 0.65;
  }

  _getModelViewportFraction(model) {
    if (!model || !model.grid || !this.mapEngine.map) return 1.0;
    const b = this.mapEngine.map.getBounds();
    if (!b) return 1.0;
    const g = model.grid;
    const vW = b.getEast() - b.getWest();
    const vH = b.getNorth() - b.getSouth();
    const oW = Math.max(0, Math.min(b.getEast(), g.lon_max) - Math.max(b.getWest(), g.lon_min));
    const oH = Math.max(0, Math.min(b.getNorth(), g.lat_max) - Math.max(b.getSouth(), g.lat_min));
    if (oW <= 0 || oH <= 0 || vW <= 0 || vH <= 0) return 0.0;
    return (oW * oH) / (vW * vH);
  }

  _formatGridSpacing(dxM) {
    const val = Number(dxM);
    if (!Number.isFinite(val) || val <= 0) return "";
    if (val >= 1000) {
      const km = val / 1000;
      return `${Math.abs(km - Math.round(km)) < 0.08 ? Math.round(km) : km.toFixed(1)} km`;
    }
    return `${Math.round(val)} m`;
  }

  _showDomainPreview(state) {
    if (!state || !Array.isArray(state.models) || state.models.length === 0) {
      this._clearDomainPreview();
      return;
    }
    this._previewState = state;
    this._updatePreviewOverlay();
  }

  _clearDomainPreview() {
    this._previewState = null;
    if (this.scalarLayer && typeof this.scalarLayer.clearPreviewDomains === "function") {
      this.scalarLayer.clearPreviewDomains();
    }
    if (this.dom.domainPreviewOverlay) {
      this.dom.domainPreviewOverlay.innerHTML = "";
    }
    if (this.dom.domainPreviewCard) {
      this.dom.domainPreviewCard.hidden = true;
      this.dom.domainPreviewCard.innerHTML = "";
    }
  }

  _updatePreviewOverlay() {
    const state = this._previewState;
    if (!state) return;

    const map = this.mapEngine ? this.mapEngine.map : null;
    const models = state.models || [];
    const isMulti = models.length > 1;
    const previewItems = [];
    const tagFragments = [];
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;

    models.forEach((m) => {
      if (!m || !m.grid) return;
      const g = m.grid;
      const fam = this._getModelFamilyMeta(m);
      let pxSpan = 999;
      let isInView = true;

      if (map && typeof map.project === "function") {
        const pNW = map.project([g.lon_min, g.lat_max]);
        const pSE = map.project([g.lon_max, g.lat_min]);
        const pMid = map.project([0.5 * (g.lon_min + g.lon_max), 0.5 * (g.lat_min + g.lat_max)]);
        const boxW = Math.abs(pSE.x - pNW.x);
        const boxH = Math.abs(pSE.y - pNW.y);
        pxSpan = Math.max(boxW, boxH);

        const minX = Math.min(pNW.x, pSE.x);
        const maxX = Math.max(pNW.x, pSE.x);
        const minY = Math.min(pNW.y, pSE.y);
        const maxY = Math.max(pNW.y, pSE.y);
        isInView = maxX >= 0 && minX <= vw && maxY >= 0 && minY <= vh;

        if (isInView) {
          const isSmall = pxSpan < 90;
          const anchorX = isSmall ? pMid.x : Math.min(pNW.x, pSE.x) + 8;
          const anchorY = isSmall ? pMid.y - 16 : Math.min(pNW.y, pSE.y) + 8;
          const clampedX = Math.max(24, Math.min(vw - 24, anchorX));
          const clampedY = Math.max(66, Math.min(vh - 135, anchorY));
          const alignClass = isSmall ? " centered" : "";
          const badgeText = this._escapeHtml(m.badge || this._formatGridSpacing(m.resolution_m));
          const tagText =
            state.mode === "auto" || state.mode === "model" || state.mode === "tour" || state.mode === "rn-tour"
              ? `${this._escapeHtml(fam.label)} · ${badgeText}`
              : badgeText;
          tagFragments.push(
            `<div class="domain-map-tag${alignClass}" style="left:${clampedX.toFixed(1)}px;top:${clampedY.toFixed(1)}px;--tag-color:${fam.color};">${tagText}</div>`
          );
        }
      }

      previewItems.push({
        gridMeta: g,
        lineColor: fam.color,
        fillColor: isMulti ? "rgba(15, 23, 42, 0.04)" : fam.fill,
        glowColor: fam.glow,
        lineWidth: isMulti ? 1.9 : 2.5,
        glowWidth: isMulti ? 5.0 : 7.0,
      });
    });

    if (this.scalarLayer && typeof this.scalarLayer.setPreviewDomains === "function") {
      this.scalarLayer.setPreviewDomains(previewItems);
    }
    if (this.dom.domainPreviewOverlay) {
      this.dom.domainPreviewOverlay.innerHTML = tagFragments.join("");
    }

    const card = this.dom.domainPreviewCard;
    if (!card) return;

    if (state.mode === "tour" || state.mode === "rn-tour") {
      const isRnDemo = state.mode === "rn-tour";
      const chips = models
        .map((m, i) => {
          const fam = this._getModelFamilyMeta(m);
          const isAct = this.activeModel && this.activeModel.id === m.id;
          return `<span class="preview-chip${isAct ? " is-active" : ""}"><span class="model-family-dot" style="background:${fam.color};color:${fam.color};"></span>${i + 1}. ${this._escapeHtml(fam.label)} ${this._escapeHtml(m.badge)}</span>`;
        })
        .join("");
      card.style.setProperty("--preview-color", isRnDemo ? "#f43f5e" : "#38bdf8");
      card.innerHTML = `
        <div class="preview-card-head">
          <span class="preview-card-title">${isRnDemo ? "☢️ Radionuclide Scenario Demo" : "🎬 Presentation Tour Sequence"}</span>
          <span class="preview-card-sub">${models.length} model${models.length === 1 ? "" : "s"} &middot; plays &amp; cycles smoothly</span>
        </div>
        <div class="preview-card-specs">${chips}</div>
      `;
      card.hidden = false;
      return;
    }

    if (state.mode === "auto") {
      const countsByFam = this._groupModelsByFamily(models)
        .map(
          (grp) =>
            `<span class="preview-chip"><span class="model-family-dot" style="background:${grp.meta.color};color:${grp.meta.color};"></span>${this._escapeHtml(grp.meta.label)}: ${grp.models.map((m) => this._escapeHtml(m.badge)).join(" / ")}</span>`
        )
        .join("");
      card.style.setProperty("--preview-color", "#10b981");
      card.innerHTML = `
        <div class="preview-card-head">
          <span class="preview-card-title">&#x2728; Auto Multi-Scale Switching</span>
          <span class="preview-card-sub">${models.length} domains active by zoom</span>
        </div>
        <div class="preview-card-specs">${countsByFam}</div>
      `;
      card.hidden = false;
      return;
    }

    if (state.mode === "family") {
      const fam = state.familyMeta || this._getModelFamilyMeta(models[0]);
      const chips = models
        .map((m) => {
          const g = m.grid || {};
          const dims = g.nx && g.ny ? ` (${g.nx}&times;${g.ny})` : "";
          const isAct = this.activeModel && this.activeModel.id === m.id;
          return `<span class="preview-chip${isAct ? " is-active" : ""}">${this._escapeHtml(m.badge)}${dims}</span>`;
        })
        .join("");
      card.style.setProperty("--preview-color", fam.color);
      card.innerHTML = `
        <div class="preview-card-head">
          <span class="preview-card-title"><span class="model-family-dot" style="background:${fam.color};color:${fam.color};"></span>${this._escapeHtml(fam.label)}</span>
          <span class="preview-card-sub">${models.length} domain${models.length === 1 ? "" : "s"} &middot; click to cycle</span>
        </div>
        <div class="preview-card-specs">${chips}</div>
      `;
      card.hidden = false;
      return;
    }

    const m = models[0];
    const fam = state.familyMeta || this._getModelFamilyMeta(m);
    const g = m.grid || {};
    const stepStr = this._formatGridSpacing(g.dx_m || m.resolution_m);
    const boundsStr =
      Number.isFinite(Number(g.lon_min)) && Number.isFinite(Number(g.lat_min))
        ? `${Number(g.lon_min).toFixed(2)}&deg;&ndash;${Number(g.lon_max).toFixed(2)}&deg;E, ${Number(g.lat_min).toFixed(2)}&deg;&ndash;${Number(g.lat_max).toFixed(2)}&deg;N`
        : "";
    const dimsStr = g.nx && g.ny ? `${g.nx}&times;${g.ny}` : "";
    const stepsCount = (m.timesteps || []).length;
    const isAct = this.activeModel && this.activeModel.id === m.id;
    const offScreen = this._getModelViewportFraction(m) <= 0.0;
    const urbanTag = m.buildings_3d ? `<span class="preview-tag">3D Urban</span>` : "";
    const activeTag = isAct ? `<span class="preview-tag is-active">Active</span>` : "";
    const flyNote = offScreen ? `<span class="preview-tag is-warn">Click to center</span>` : "";

    card.style.setProperty("--preview-color", fam.color);
    card.innerHTML = `
      <div class="preview-card-head">
        <span class="preview-card-title"><span class="model-family-dot" style="background:${fam.color};color:${fam.color};"></span>${this._escapeHtml(m.name)}</span>
        <span class="preview-card-badges">${activeTag}${urbanTag}${flyNote}</span>
      </div>
      <div class="preview-card-specs">
        ${dimsStr ? `<span>${dimsStr} grid</span>` : ""}
        ${stepStr ? `<span>&Delta;x ${this._escapeHtml(stepStr)}</span>` : ""}
        ${boundsStr ? `<span>${boundsStr}</span>` : ""}
        <span>${stepsCount} step${stepsCount === 1 ? "" : "s"}</span>
      </div>
    `;
    card.hidden = false;
  }

  _isModelTemporallyValid(model, utcIso) {
    if (!model || !model.timesteps || model.timesteps.length === 0) return false;
    if (!utcIso) return true;
    const ms = Date.parse(utcIso);
    if (Number.isNaN(ms)) return true;
    const t0 = Date.parse(model.timesteps[0].valid_time);
    const t1 = Date.parse(model.timesteps[model.timesteps.length - 1].valid_time);
    return ms >= t0 - 1800 * 1000 && ms <= t1 + 1800 * 1000;
  }

  _scheduleAutoModelEval(delayMs = 150) {
    if (this._autoEvalTimer) {
      clearTimeout(this._autoEvalTimer);
    }
    this._autoEvalTimer = setTimeout(() => {
      this._autoEvalTimer = null;
      this._evaluateAutoModel();
    }, delayMs);
  }

  _getAutoCandidateModels() {
    if (!this.activeCycle || !Array.isArray(this.activeCycle.models)) return [];
    const nonRn = this.activeCycle.models.filter(
      (m) => this._getModelFamilyMeta(m).key !== "radionuclide"
    );
    if (nonRn.length <= 1) return nonRn;

    const activeFam = this.activeModel ? this._getModelFamilyMeta(this.activeModel).key : "wrf";
    let chain;
    if (activeFam === "icon") {
      chain = nonRn.filter((m) => this._getModelFamilyMeta(m).key === "icon");
    } else {
      chain = nonRn.filter((m) => {
        const k = this._getModelFamilyMeta(m).key;
        return k === "wrf" || k === "palm" || k === "generic";
      });
    }
    return chain.length > 0 ? chain : nonRn;
  }

  _evaluateAutoModel() {
    this._syncModelSelectorUI();
    if (!this.autoModelMode || !this.activeCycle || !this.activeCycle.models || !this.mapEngine.map) {
      return;
    }
    if (this.activeModel && this._getModelFamilyMeta(this.activeModel).key === "radionuclide") {
      return;
    }
    const models = this._getAutoCandidateModels();
    if (models.length <= 1) return;

    const zoom = this.mapEngine.map.getZoom();
    const currentTs = this.timeline ? this.timeline.getCurrentTimestep() : null;
    const targetUtc = currentTs ? currentTs.valid_time : null;
    const currentRes = this.activeModel ? this.activeModel.resolution_m : models[0].resolution_m;

    let chosen = models[0];
    for (let i = models.length - 1; i >= 1; i--) {
      const cand = models[i];
      const alreadyAtOrFiner = currentRes <= cand.resolution_m + 1e-3;
      const minZ = typeof cand.min_auto_zoom === "number" ? cand.min_auto_zoom : 7.0;
      const exitZ = typeof cand.exit_auto_zoom === "number" ? cand.exit_auto_zoom : Math.max(0, minZ - 0.5);
      const threshold = alreadyAtOrFiner ? exitZ : minZ;

      if (zoom >= threshold && this._isModelVisibleInViewport(cand) && this._isModelTemporallyValid(cand, targetUtc)) {
        chosen = cand;
        break;
      }
    }

    if (!this.activeModel || chosen.id !== this.activeModel.id) {
      this.selectModel(chosen.id, { fromAuto: true, fitView: false });
    }
  }

  _populateVariables(variables) {
    this.dom.layerDock.innerHTML = "";
    const icons = {
      pm25: "🔬",
      pm10: "🌫️",
      sconc_dust: "🌪️",
      dust_load: "🌫️",
      dod550: "☀️",
      no2: "🧪",
      nox: "🏭",
      o3: "⚡",
      so2: "🏭",
      co: "💨",
      co2: "🌍",
      ch4: "🔥",
      wind10m: "💨",
      t2m: "🌡️",
      precip_rate: "🌧️",
      precip_acc: "💧",
      cldfra: "☁️",
      swdown: "☀️",
      swnet: "🔆",
      rn_i131_sfc: "☢️",
      rn_i131_col: "☢️",
      rn_i131_dep: "⚠️",
      rn_i131_ddep: "⬇️",
      rn_i131_wdep: "🌧️",
      rn_i131_upt: "🧫",
      rn_i131_gas_pct: "💨",
      rn_i131_coarse_pct: "🌪️",
      rn_cs137_sfc: "☢️",
      rn_cs137_col: "☢️",
      rn_cs137_dep: "⚠️",
      rn_cs137_coarse_pct: "🌪️",
    };

    const categoryMeta = [
      { key: "radionuclide", label: "☢ Radionuclide", match: (c) => c === "radionuclide" },
      { key: "particulates", label: "Particulates & Dust", match: (c) => c === "aerosol" || c === "dust" },
      { key: "chemistry", label: "Trace Gases", match: (c) => c === "chemistry" },
      { key: "ghg", label: "GHGs", match: (c) => c === "ghg" },
      { key: "meteo", label: "Meteorology", match: (c) => c === "meteo" },
      { key: "solar", label: "Solar Energy", match: (c) => c === "solar" },
    ];

    if (!this.collapsedCategories) {
      this.collapsedCategories = new Set();
    }

    const createVarButton = (v) => {
      const btn = document.createElement("button");
      btn.className = `layer-btn${this.activeVariable && this.activeVariable.id === v.id ? " active" : ""}`;
      btn.dataset.id = v.id;
      btn.innerHTML = `
        <span style="display:flex;align-items:center;gap:0.4rem;">
          <span class="layer-icon">${icons[v.id] || "📊"}</span>
          <span>${v.short_name || v.name}</span>
        </span>
        <span class="layer-unit">${v.units}</span>
      `;
      btn.addEventListener("click", () => {
        this.disableTourMode("variable-select");
        this.selectVariable(v.id);
      });
      return btn;
    };

    const assignedIds = new Set();
    categoryMeta.forEach((cat) => {
      const groupVars = variables.filter((v) => cat.match(v.category));
      if (groupVars.length === 0) return;

      if (cat.key === "particulates") {
        const order = ["pm25", "pm10", "sconc_dust", "dust_load", "dod550"];
        groupVars.sort((a, b) => {
          const ia = order.indexOf(a.id);
          const ib = order.indexOf(b.id);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
      } else if (cat.key === "ghg") {
        const order = ["co2", "ch4"];
        groupVars.sort((a, b) => {
          const ia = order.indexOf(a.id);
          const ib = order.indexOf(b.id);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
      } else if (cat.key === "radionuclide") {
        const order = [
          "rn_i131_sfc",
          "rn_i131_col",
          "rn_i131_dep",
          "rn_i131_ddep",
          "rn_i131_wdep",
          "rn_i131_upt",
          "rn_i131_gas_pct",
          "rn_i131_coarse_pct",
          "rn_cs137_sfc",
          "rn_cs137_col",
          "rn_cs137_dep",
          "rn_cs137_coarse_pct",
        ];
        groupVars.sort((a, b) => {
          const ia = order.indexOf(a.id);
          const ib = order.indexOf(b.id);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
      }

      groupVars.forEach((v) => assignedIds.add(v.id));

      const section = document.createElement("div");
      const isCollapsed = this.collapsedCategories.has(cat.key);
      section.className = `layer-category-group${isCollapsed ? " collapsed" : ""}`;
      section.dataset.category = cat.key;

      const headerBtn = document.createElement("button");
      headerBtn.type = "button";
      headerBtn.className = "layer-category-header";
      headerBtn.innerHTML = `
        <span>${cat.label}</span>
        <span class="layer-category-chevron">&#x25BE;</span>
      `;
      headerBtn.addEventListener("click", () => {
        const nowCollapsed = section.classList.toggle("collapsed");
        if (nowCollapsed) {
          this.collapsedCategories.add(cat.key);
        } else {
          this.collapsedCategories.delete(cat.key);
        }
      });

      const itemsWrap = document.createElement("div");
      itemsWrap.className = "layer-category-items";
      groupVars.forEach((v) => itemsWrap.appendChild(createVarButton(v)));

      section.appendChild(headerBtn);
      section.appendChild(itemsWrap);
      this.dom.layerDock.appendChild(section);
    });

    const remaining = variables.filter((v) => !assignedIds.has(v.id));
    if (remaining.length > 0) {
      const section = document.createElement("div");
      section.className = "layer-category-group";
      const itemsWrap = document.createElement("div");
      itemsWrap.className = "layer-category-items";
      remaining.forEach((v) => itemsWrap.appendChild(createVarButton(v)));
      section.appendChild(itemsWrap);
      this.dom.layerDock.appendChild(section);
    }
  }

  selectVariable(varId) {
    if (!this.activeModel) return;
    const v = this.activeModel.variables.find((item) => item.id === varId);
    if (!v) return;

    const isRnModel =
      String((this.activeModel && this.activeModel.model_family) || "").toLowerCase() === "radionuclide" ||
      v.category === "radionuclide";
    if (isRnModel) {
      this._preferredRnVarId = v.id;
    } else {
      this._preferredAtmoVarId = v.id;
    }

    this._queuedPlayTimestep = null;
    this.activeVariable = v;
    this.probe.setVarConfig(v);

    this.dom.layerDock.querySelectorAll(".layer-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.id === varId);
    });

    this._updateLegend(v);

    const currentTimestep = this.timeline.getCurrentTimestep();
    if (currentTimestep) {
      this.loadTimestep(currentTimestep);
    }
  }

  _updateLegend(v) {
    const formatTick = (val) => {
      if (v.log_scale && val > 0 && (val < 0.01 || val >= 1e4)) {
        return val.toExponential(0).replace("+", "");
      }
      return String(val);
    };
    this.dom.legendTitle.textContent = v.short_name || v.name;
    this.dom.legendUnits.textContent = v.log_scale ? `[${v.units}, log₁₀]` : `[${v.units}]`;
    this.dom.legendMin.textContent = `${formatTick(v.vmin)} ${v.units}`;
    this.dom.legendMax.textContent = `${formatTick(v.vmax)} ${v.units}`;

    if (v.colormap && v.colormap.length > 0) {
      const parts = v.colormap.map((s) => {
        const [r, g, b, a] = s.color;
        const alpha = (a / 255).toFixed(2);
        return `rgba(${r}, ${g}, ${b}, ${alpha}) ${(s.stop * 100).toFixed(0)}%`;
      });
      this.dom.legendGradient.style.background = `linear-gradient(to right, ${parts.join(", ")})`;
    }

    if (this.dom.legendDock) {
      let rnEl = document.getElementById("legend-rn-summary");
      const meta = this.activeModel && this.activeModel.radionuclide_meta;
      if (meta && meta.nuclides) {
        if (!rnEl) {
          rnEl = document.createElement("div");
          rnEl.id = "legend-rn-summary";
          rnEl.style.cssText =
            "margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.12);font-size:0.72rem;line-height:1.35;color:#fda4af;";
          this.dom.legendDock.appendChild(rnEl);
        }
        const i131 = meta.nuclides.I131 || {};
        const arrTxt = i131.doha_arrival_hour != null ? `T+${i131.doha_arrival_hour}h` : "none (0 Bq/m³)";
        const peakVal = Number(i131.doha_sfc_peak_bq_m3 || 0);
        const peakTxt = peakVal > 0 ? peakVal.toExponential(1) : "0";
        rnEl.textContent = `Hypothetical (${meta.plant_name || meta.plant_id}) · Doha I-131 arrival: ${arrTxt} · peak: ${peakTxt} Bq/m³`;
        rnEl.style.display = "block";
      } else if (rnEl) {
        rnEl.style.display = "none";
      }
    }
  }

  _isTimestepCached(timestep) {
    if (!timestep || !this.activeVariable || !this.scalarLayer) return false;
    const varFiles = timestep.files && timestep.files[this.activeVariable.id];
    if (varFiles && varFiles.scalar && !this.scalarLayer.cache.has(varFiles.scalar)) {
      return false;
    }
    if (this.showWindOverlay && this.windParticles) {
      const windFiles = timestep.files && timestep.files["wind10m"];
      if (windFiles && windFiles.u && windFiles.v) {
        if (!this.windParticles.cache.has(windFiles.u) || !this.windParticles.cache.has(windFiles.v)) {
          return false;
        }
      }
    }
    return true;
  }

  async loadTimestep(timestep) {
    if (!timestep || !this.activeModel || !this.activeVariable) return;

    const isPlaying = Boolean(this.timeline && this.timeline.isPlaying);
    const isCached = this._isTimestepCached(timestep);
    if (isPlaying && !isCached && this._renderInFlight) {
      this._queuedPlayTimestep = timestep;
      return;
    }

    this._queuedPlayTimestep = null;
    const ticket = ++this._timestepTicket;
    return this._renderTimestepNow(timestep, ticket);
  }

  async _renderTimestepNow(timestep, ticket) {
    this._renderInFlight = true;
    try {
      const gridMeta = this.activeModel.grid;
      const activeVar = this.activeVariable;
      const varFiles = timestep.files[activeVar.id];
      const windFiles = this.showWindOverlay ? timestep.files["wind10m"] : null;

      if (varFiles && varFiles.scalar) {
        try {
          await this.scalarLayer.loadBuffer(varFiles.scalar, varFiles);
          if (ticket !== this._timestepTicket) return;
          await this.scalarLayer.setField(varFiles, gridMeta, activeVar);
        } catch (err) {
          if (ticket !== this._timestepTicket) return;
          console.warn("[Dusty Earth] Failed to load scalar frame:", err);
        }
      } else {
        this.scalarLayer.clear();
      }

      if (ticket !== this._timestepTicket) return;

      const isHighFreqPlay = Boolean(
        this.timeline &&
        this.timeline.isPlaying &&
        this.timeline.getStepIntervalSeconds() <= 120
      );
      const nowMs = performance.now();
      const allowWindTick = !isHighFreqPlay || (nowMs - (this._lastWindUpdateMs || 0) >= 90);

      if (this.showWindOverlay && allowWindTick) {
        if (windFiles && windFiles.u && windFiles.v) {
          try {
            await Promise.all([
              this.windParticles.loadBuffer(windFiles.u, windFiles, "u"),
              this.windParticles.loadBuffer(windFiles.v, windFiles, "v"),
            ]);
            if (ticket !== this._timestepTicket) return;
            this._lastWindUpdateMs = performance.now();
            await this.windParticles.setWindField(windFiles, gridMeta);
          } catch (err) {
            if (ticket !== this._timestepTicket) return;
            console.warn("[Dusty Earth] Failed to load wind field:", err);
          }
        } else {
          this.windParticles.stop();
          this.windParticles.clear();
        }
      }

      if (ticket === this._timestepTicket) {
        this._preloadUpcomingFrames();
      }
    } finally {
      if (ticket === this._timestepTicket) {
        this._renderInFlight = false;
        const queued = this._queuedPlayTimestep;
        if (queued && this.activeModel && this.activeVariable) {
          this._queuedPlayTimestep = null;
          const nextTicket = ++this._timestepTicket;
          void this._renderTimestepNow(queued, nextTicket);
        }
      }
    }
  }

  _preloadUpcomingFrames() {
    if (!this.timeline || !this.timeline.timesteps || !this.activeVariable || !this.activeModel) return;
    const timesteps = this.timeline.timesteps;
    if (timesteps.length <= 1) return;

    const activeFetches =
      (this.scalarLayer.inFlight ? this.scalarLayer.inFlight.size : 0) +
      (this.windParticles && this.windParticles.inFlight ? this.windParticles.inFlight.size : 0);
    if (activeFetches >= 4) return;

    const curr = this.timeline.currentIndex;
    const grid = this.activeModel.grid || {};
    const cells = (grid.nx || 0) * (grid.ny || 0);
    const dtSec = Math.max(1, this.timeline.getStepIntervalSeconds());
    const stride = this.timeline.isPlaying
      ? Math.max(1, Math.round((this.timeline.getEffectiveSimSecondsPerRealSec() * 0.045) / dtSec))
      : 1;
    const lookahead = cells > 1_000_000 ? 3 : 6;

    for (let k = 1; k <= lookahead; k++) {
      const idx = (curr + k * stride) % timesteps.length;
      const ts = timesteps[idx];
      const vf = ts.files[this.activeVariable.id];
      if (vf && vf.scalar) {
        this.scalarLayer.loadBuffer(vf.scalar, vf).catch(() => {});
      }
      if (k <= 3 && this.showWindOverlay) {
        const wf = ts.files["wind10m"];
        if (wf && wf.u && wf.v) {
          this.windParticles.loadBuffer(wf.u, wf, "u").catch(() => {});
          this.windParticles.loadBuffer(wf.v, wf, "v").catch(() => {});
        }
      }
    }

    if (this.tourScope && curr >= Math.floor(timesteps.length * 0.85)) {
      const playlist = this._getTourPlaylist(this.tourScope);
      const cIdx = playlist.findIndex((m) => m.id === this.activeModel.id);
      if (cIdx >= 0 && playlist.length > 1) {
        const nextModel = playlist[(cIdx + 1) % playlist.length];
        const key = `${this.tourScope}:${nextModel.id}`;
        if (this._preloadedNextTourKey !== key && nextModel.timesteps && nextModel.timesteps.length > 0) {
          this._preloadedNextTourKey = key;
          const nextTs0 = nextModel.timesteps[0];
          const isNextRn = String(nextModel.model_family || "").toLowerCase() === "radionuclide";
          const nextVar = this._resolvePreferredVariable(nextModel.variables || [], null, isNextRn);
          if (nextTs0 && nextTs0.files) {
            const nvf = nextVar ? nextTs0.files[nextVar.id] : null;
            if (nvf && nvf.scalar) {
              this.scalarLayer.loadBuffer(nvf.scalar, nvf).catch(() => {});
            }
            if (this.showWindOverlay && nextTs0.files["wind10m"]) {
              const nwf = nextTs0.files["wind10m"];
              if (nwf.u && nwf.v) {
                this.windParticles.loadBuffer(nwf.u, nwf, "u").catch(() => {});
                this.windParticles.loadBuffer(nwf.v, nwf, "v").catch(() => {});
              }
            }
          }
        }
      }
    }
  }

  _bindEvents() {
    this.dom.cycleSelect.addEventListener("change", (e) => {
      this.disableTourMode("cycle-select");
      this.selectCycle(e.target.value, { tourScope: null });
    });

    if (this.dom.modelTourBtn) {
      this.dom.modelTourBtn.addEventListener("click", () => {
        if (this.tourScope === "standard") {
          this.disableTourMode("tour-btn");
        } else {
          this.enableTourMode("standard", { restartFromFirst: false });
        }
      });
      const showTourPreview = () => {
        if (!this.activeCycle || !this.activeCycle.models) return;
        this._showDomainPreview({
          mode: "tour",
          models: this._getTourPlaylist("standard"),
        });
      };
      this.dom.modelTourBtn.addEventListener("mouseenter", showTourPreview);
      this.dom.modelTourBtn.addEventListener("focus", showTourPreview);
    }

    if (this.dom.modelAutoBtn) {
      this.dom.modelAutoBtn.addEventListener("click", () => {
        this.disableTourMode("auto-btn");
        this.autoModelMode = true;
        this._syncModelSelectorUI();
        this._evaluateAutoModel();
      });
      const showAutoPreview = () => {
        if (!this.activeCycle || !this.activeCycle.models) return;
        this._showDomainPreview({
          mode: "auto",
          models: this._getAutoCandidateModels(),
        });
      };
      this.dom.modelAutoBtn.addEventListener("mouseenter", showAutoPreview);
      this.dom.modelAutoBtn.addEventListener("focus", showAutoPreview);
    }

    if (this.dom.modelSelectorBar) {
      this.dom.modelSelectorBar.addEventListener("mouseleave", () => this._clearDomainPreview());
      this.dom.modelSelectorBar.addEventListener("focusout", (e) => {
        if (!e.relatedTarget || !this.dom.modelSelectorBar.contains(e.relatedTarget)) {
          this._clearDomainPreview();
        }
      });
    }

    this.dom.windToggleBtn.addEventListener("click", () => {
      this.showWindOverlay = !this.showWindOverlay;
      this._updateToggleButtonUI(this.dom.windToggleBtn, this.showWindOverlay);
      this.windParticles.setVisible(this.showWindOverlay);
      if (this.showWindOverlay && this.activeModel) {
        const currentTimestep = this.timeline.getCurrentTimestep();
        if (currentTimestep) {
          const wf = currentTimestep.files["wind10m"];
          if (wf) this.windParticles.setWindField(wf, this.activeModel.grid);
        }
      }
    });

    if (this.dom.buildingsToggleBtn) {
      this.dom.buildingsToggleBtn.addEventListener("click", () => {
        this.showBuildings3D = !this.showBuildings3D;
        this._updateToggleButtonUI(this.dom.buildingsToggleBtn, this.showBuildings3D);
        if (this.buildingsLayer) {
          this.buildingsLayer.setBuildingsVisible(this.showBuildings3D);
        }
        const map = this.mapEngine.map;
        if (map) {
          if (this.showBuildings3D && map.getZoom() >= 12.5 && map.getPitch() < 20) {
            this._runProgrammaticCamera(() => map.easeTo({ pitch: 50, bearing: -15, duration: 650 }), 800);
            this._autoTilted = true;
          } else if (!this.showBuildings3D && map.getPitch() > 0) {
            this._runProgrammaticCamera(() => map.easeTo({ pitch: 0, bearing: 0, duration: 550 }), 700);
            this._autoTilted = false;
          }
        }
      });
    }

    if (this.dom.canopyToggleBtn) {
      this.dom.canopyToggleBtn.addEventListener("click", () => {
        this.showCanopy3D = !this.showCanopy3D;
        this._updateToggleButtonUI(this.dom.canopyToggleBtn, this.showCanopy3D);
        if (this.buildingsLayer) {
          this.buildingsLayer.setCanopyVisible(this.showCanopy3D);
        }
      });
    }

    this.dom.settingsBtn.addEventListener("click", () => {
      this.dom.settingsPanel.classList.toggle("open");
    });
    this.dom.settingsClose.addEventListener("click", () => {
      this.dom.settingsPanel.classList.remove("open");
    });

    if (this.dom.settingTourBtn) {
      this.dom.settingTourBtn.addEventListener("click", () => {
        if (this.tourScope === "standard") {
          this.disableTourMode("settings-tour");
        } else {
          this.enableTourMode("standard", { restartFromFirst: false });
        }
      });
    }

    if (this.dom.settingRnTourBtn) {
      this.dom.settingRnTourBtn.addEventListener("click", () => {
        if (this.tourScope === "radionuclide") {
          this.disableTourMode("settings-rn-tour");
        } else {
          this.enableTourMode("radionuclide", { restartFromFirst: false });
        }
      });
    }

    this.dom.particleCountSlider.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      this.dom.particleCountVal.textContent = String(val);
      this.windParticles.setDensity(val);
    });

    this.dom.particleSpeedSlider.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      this.dom.particleSpeedVal.textContent = `${val}x`;
      this.windParticles.setSpeed(val * 0.00035);
    });

    if (this.dom.fieldOpacitySlider) {
      this.dom.fieldOpacitySlider.addEventListener("input", (e) => {
        const val = Number(e.target.value);
        if (this.dom.fieldOpacityVal) {
          this.dom.fieldOpacityVal.textContent = `${Math.round(val * 100)}%`;
        }
        if (this.scalarLayer) {
          this.scalarLayer.setOpacity(val);
        }
      });
    }

    if (this.dom.bldgOpacitySlider) {
      this.dom.bldgOpacitySlider.addEventListener("input", (e) => {
        const val = Number(e.target.value);
        if (this.dom.bldgOpacityVal) {
          this.dom.bldgOpacityVal.textContent = `${Math.round(val * 100)}%`;
        }
        if (this.buildingsLayer) {
          this.buildingsLayer.setBuildingOpacity(val);
        }
      });
    }

    if (this.dom.labelsToggleBtn) {
      this.dom.labelsToggleBtn.addEventListener("click", () => {
        this.showMapLabels = !this.showMapLabels;
        this._updateToggleButtonUI(this.dom.labelsToggleBtn, this.showMapLabels);
        if (this.mapEngine) {
          this.mapEngine.setLabelsVisible(this.showMapLabels);
        }
      });
    }

    const openModal = () => this.openModelInfoModal();
    const closeModal = () => this.closeModelInfoModal();

    if (this.dom.modelInfoBtn) {
      this.dom.modelInfoBtn.addEventListener("click", openModal);
    }
    [this.dom.attrLeadTrigger, this.dom.attrInfoTrigger].forEach((trigger) => {
      if (!trigger) return;
      trigger.addEventListener("click", openModal);
      trigger.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openModal();
        }
      });
    });
    if (this.dom.modelInfoClose) {
      this.dom.modelInfoClose.addEventListener("click", closeModal);
    }
    if (this.dom.modelInfoBackdrop) {
      this.dom.modelInfoBackdrop.addEventListener("click", (e) => {
        if (e.target === this.dom.modelInfoBackdrop) {
          closeModal();
        }
      });
    }
    if (this.dom.copyCitationBtn) {
      this.dom.copyCitationBtn.addEventListener("click", () => this.copyCitation());
    }

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.buildingsLayer && this.buildingsLayer.popup) {
          e.preventDefault();
          this.buildingsLayer.closePopup();
          return;
        }
        if (this.dom.modelInfoBackdrop && this.dom.modelInfoBackdrop.classList.contains("open")) {
          e.preventDefault();
          this.closeModelInfoModal();
          return;
        }
        if (this.dom.settingsPanel && this.dom.settingsPanel.classList.contains("open")) {
          e.preventDefault();
          this.dom.settingsPanel.classList.remove("open");
          return;
        }
      }

      if (document.activeElement && document.activeElement.tagName === "INPUT") return;

      const dtSec = this.timeline ? this.timeline.getStepIntervalSeconds() : 3600;
      const hourStepCount = e.shiftKey && dtSec < 3600 ? Math.max(1, Math.round(3600 / dtSec)) : 1;

      switch (e.key) {
        case " ":
        case "Spacebar":
          e.preventDefault();
          if (
            document.activeElement &&
            document.activeElement.tagName === "BUTTON" &&
            document.activeElement !== this.dom.playBtn
          ) {
            document.activeElement.blur();
          }
          if (this.tourScope) this.disableTourMode("hotkey-space");
          this.timeline.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (this.tourScope) this.disableTourMode("hotkey-arrow-left");
          this.timeline.pause();
          this.timeline.step(-hourStepCount);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (this.tourScope) this.disableTourMode("hotkey-arrow-right");
          this.timeline.pause();
          this.timeline.step(hourStepCount);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.disableTourMode("variable-key");
          this._switchVariableOffset(-1);
          break;
        case "ArrowDown":
          e.preventDefault();
          this.disableTourMode("variable-key");
          this._switchVariableOffset(1);
          break;
        case "Home":
          e.preventDefault();
          if (this.tourScope) this.disableTourMode("hotkey-home");
          this.timeline.first();
          break;
        case "End":
          e.preventDefault();
          if (this.tourScope) this.disableTourMode("hotkey-end");
          this.timeline.last();
          break;
        case "w":
        case "W":
          e.preventDefault();
          this.dom.windToggleBtn.click();
          break;
        case "b":
        case "B":
          if (this.dom.buildingsToggleBtn) {
            e.preventDefault();
            this.dom.buildingsToggleBtn.click();
          }
          break;
        case "t":
        case "T":
          if (this.dom.canopyToggleBtn && !this.dom.canopyToggleBtn.hidden) {
            e.preventDefault();
            this.dom.canopyToggleBtn.click();
          }
          break;
        case "l":
        case "L":
          e.preventDefault();
          if (this.tourScope) this.disableTourMode("hotkey-loop");
          this.timeline.toggleLoopMode();
          break;
        case "p":
        case "P":
          e.preventDefault();
          if (this.tourScope) {
            this.disableTourMode("hotkey-p");
          } else {
            this.enableTourMode("standard", { restartFromFirst: false });
          }
          break;
        case "m":
        case "M":
          if (this.dom.labelsToggleBtn) {
            e.preventDefault();
            this.dom.labelsToggleBtn.click();
          }
          break;
        case "i":
        case "I":
          e.preventDefault();
          this.toggleModelInfoModal();
          break;
      }
    });
  }

  openModelInfoModal() {
    if (!this.dom.modelInfoBackdrop) return;
    this.dom.modelInfoBackdrop.classList.add("open");
    this.dom.modelInfoBackdrop.setAttribute("aria-hidden", "false");
  }

  closeModelInfoModal() {
    if (!this.dom.modelInfoBackdrop) return;
    this.dom.modelInfoBackdrop.classList.remove("open");
    this.dom.modelInfoBackdrop.setAttribute("aria-hidden", "true");
  }

  toggleModelInfoModal() {
    if (!this.dom.modelInfoBackdrop) return;
    if (this.dom.modelInfoBackdrop.classList.contains("open")) {
      this.closeModelInfoModal();
    } else {
      this.openModelInfoModal();
    }
  }

  async copyCitation() {
    if (!this.dom.citationText || !this.dom.copyCitationBtn) return;
    const text = this.dom.citationText.textContent.trim();
    const btn = this.dom.copyCitationBtn;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      if (this._copyTimeout) clearTimeout(this._copyTimeout);
      this._copyTimeout = setTimeout(() => {
        btn.textContent = "Copy Citation";
        btn.classList.remove("copied");
      }, 2000);
    } catch (err) {
      console.warn("[Dusty Earth] Clipboard copy failed:", err);
    }
  }

  _switchVariableOffset(offset) {
    if (!this.activeModel || !this.activeModel.variables) return;
    const vars = this.activeModel.variables;
    const currIdx = vars.findIndex((v) => v.id === this.activeVariable.id);
    const nextIdx = (currIdx + offset + vars.length) % vars.length;
    this.selectVariable(vars[nextIdx].id);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new DustyApp();
  window.dustyApp = app;
  app.init().catch((err) => console.error("Initialization failed:", err));
});
