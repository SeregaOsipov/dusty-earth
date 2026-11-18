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
    this.autoModelMode = true;

    this._autoEvalTimer = null;
    this._isProgrammaticMove = false;
    this._progMoveTimer = null;
    this._autoTilted = false;
    this._lastBoundsSig = null;
    this._timestepTicket = 0;
    this._lastWindUpdateMs = 0;

    this.mapEngine = new MapEngine("map");
    this.scalarLayer = null;
    this.buildingsLayer = null;
    this.windParticles = null;
    this.probe = null;
    this.timeline = null;

    this.showWindOverlay = true;
    this.showBuildings3D = true;
    this.showCanopy3D = true;

    this.dom = {
      cycleSelect: document.getElementById("cycle-select"),
      modelSelectorBar: document.getElementById("model-selector-bar"),
      modelAutoBtn: document.getElementById("btn-model-auto"),
      modelPillsList: document.getElementById("model-pills-list"),
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
      particleCountSlider: document.getElementById("setting-particle-count"),
      particleCountVal: document.getElementById("setting-particle-count-val"),
      particleSpeedSlider: document.getElementById("setting-particle-speed"),
      particleSpeedVal: document.getElementById("setting-particle-speed-val"),
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
    });

    if (this.mapEngine.map) {
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
      if (this.autoModelMode) {
        this._scheduleAutoModelEval(40);
      }
    });

    this._bindEvents();
    await this.loadManifest();
  }

  _normalizeCycleModels(cycle) {
    if (cycle.models && Array.isArray(cycle.models) && cycle.models.length > 0) {
      return cycle.models;
    }
    return [
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

      this._populateCycles(cycles);
      const startCycleId =
        urlCycleId && cycles.some((c) => c.id === urlCycleId)
          ? urlCycleId
          : this.manifest.default_cycle || cycles[0].id;
      this.selectCycle(startCycleId, {
        preferredModelId: urlModelId,
        preferredVarId: urlVarId,
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
    this._runProgrammaticCamera(
      () => this.mapEngine.fitBounds(gridMeta.lon_min, gridMeta.lat_min, gridMeta.lon_max, gridMeta.lat_max, 45, extra),
      1250
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

  selectCycle(cycleId, { preferredModelId = null, preferredVarId = null } = {}) {
    const cycle = this.manifest.cycles.find((c) => c.id === cycleId) || this.manifest.cycles[0];
    if (!cycle) return;

    cycle.models = this._normalizeCycleModels(cycle);
    this.activeCycle = cycle;
    this.activeModel = null;
    this.dom.cycleSelect.value = cycle.id;

    this._populateModels(cycle.models);

    const explicitModel = preferredModelId ? cycle.models.find((m) => m.id === preferredModelId) : null;
    this.autoModelMode = !explicitModel;
    const startModel = explicitModel || cycle.models.find((m) => m.id === cycle.default_model) || cycle.models[0];
    this.selectModel(startModel.id, { fromAuto: !explicitModel, fitView: true, preferredVarId });
  }

  _populateModels(models) {
    if (!this.dom.modelPillsList) return;
    this.dom.modelPillsList.innerHTML = "";

    models.forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-pill";
      btn.dataset.modelId = m.id;
      btn.innerHTML = `<span>${m.short_name || m.name}</span><span class="model-pill-badge">${m.badge}</span>`;
      btn.title = `${m.name} (${m.timesteps.length} steps)`;
      btn.addEventListener("click", () => {
        this.autoModelMode = false;
        this._syncModelSelectorUI();
        const needsFit = !this._isModelVisibleInViewport(m);
        this.selectModel(m.id, { fromAuto: false, fitView: needsFit });
      });
      this.dom.modelPillsList.appendChild(btn);
    });

    this._syncModelSelectorUI();
  }

  _syncModelSelectorUI() {
    if (this.dom.modelAutoBtn) {
      this.dom.modelAutoBtn.classList.toggle("active", this.autoModelMode);
    }
    if (!this.dom.modelPillsList || !this.activeCycle) return;

    const currentTs = this.timeline ? this.timeline.getCurrentTimestep() : null;
    const currentMs = currentTs ? Date.parse(currentTs.valid_time) : Number.NaN;

    this.dom.modelPillsList.querySelectorAll(".model-pill").forEach((btn) => {
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
  }

  selectModel(modelId, { fromAuto = false, fitView = false, preferredVarId = null } = {}) {
    if (!this.activeCycle || !this.activeCycle.models) return;
    const modelIndex = this.activeCycle.models.findIndex((m) => m.id === modelId);
    const model = modelIndex >= 0 ? this.activeCycle.models[modelIndex] : this.activeCycle.models[0];
    if (!model) return;

    const targetUtc = this.timeline ? this.timeline.getPlayheadIso() : null;
    const wasSameModel = this.activeModel && this.activeModel.id === model.id;

    if (!wasSameModel && this.activeModel) {
      this.scalarLayer.beginModelTransition();
    }

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
          ? { pitch: 50, bearing: -15 }
          : this._autoTilted
          ? { pitch: 0, bearing: 0 }
          : {};
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

    let defaultVarId = vars.length > 0 ? vars[0].id : null;
    if (preferredVarId && vars.some((v) => v.id === preferredVarId)) {
      defaultVarId = preferredVarId;
    } else if (this.activeVariable && vars.some((v) => v.id === this.activeVariable.id)) {
      defaultVarId = this.activeVariable.id;
    } else if (vars.some((v) => v.id === "pm25")) {
      defaultVarId = "pm25";
    } else if (vars.some((v) => v.id === "no2")) {
      defaultVarId = "no2";
    } else if (vars.some((v) => v.id === "sconc_dust")) {
      defaultVarId = "sconc_dust";
    }

    const activeVarObj = vars.find((v) => v.id === defaultVarId) || vars[0];
    if (activeVarObj) {
      this.activeVariable = activeVarObj;
      this.probe.setVarConfig(activeVarObj);
      this._updateLegend(activeVarObj);
      this.dom.layerDock.querySelectorAll(".layer-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.id === activeVarObj.id);
      });
    }

    this.timeline.setTimesteps(model.timesteps || [], false, this.activeCycle.init_time);
    if (targetUtc) {
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

  _evaluateAutoModel() {
    this._syncModelSelectorUI();
    if (!this.autoModelMode || !this.activeCycle || !this.activeCycle.models || !this.mapEngine.map) {
      return;
    }
    const models = this.activeCycle.models;
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
    };

    const categoryMeta = [
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
      btn.addEventListener("click", () => this.selectVariable(v.id));
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
    this.dom.legendTitle.textContent = v.short_name || v.name;
    this.dom.legendUnits.textContent = `[${v.units}]`;
    this.dom.legendMin.textContent = `${v.vmin} ${v.units}`;
    this.dom.legendMax.textContent = `${v.vmax} ${v.units}`;

    if (v.colormap && v.colormap.length > 0) {
      const parts = v.colormap.map((s) => {
        const [r, g, b, a] = s.color;
        const alpha = (a / 255).toFixed(2);
        return `rgba(${r}, ${g}, ${b}, ${alpha}) ${(s.stop * 100).toFixed(0)}%`;
      });
      this.dom.legendGradient.style.background = `linear-gradient(to right, ${parts.join(", ")})`;
    }
  }

  async loadTimestep(timestep) {
    if (!timestep || !this.activeModel || !this.activeVariable) return;

    const ticket = ++this._timestepTicket;
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
      ? Math.max(1, Math.floor((this.timeline.getEffectiveSimSecondsPerRealSec() / 60) / dtSec))
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
  }

  _bindEvents() {
    this.dom.cycleSelect.addEventListener("change", (e) => {
      this.selectCycle(e.target.value);
    });

    if (this.dom.modelAutoBtn) {
      this.dom.modelAutoBtn.addEventListener("click", () => {
        this.autoModelMode = true;
        this._syncModelSelectorUI();
        this._evaluateAutoModel();
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
          this.timeline.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.timeline.pause();
          this.timeline.step(-hourStepCount);
          break;
        case "ArrowRight":
          e.preventDefault();
          this.timeline.pause();
          this.timeline.step(hourStepCount);
          break;
        case "ArrowUp":
          e.preventDefault();
          this._switchVariableOffset(-1);
          break;
        case "ArrowDown":
          e.preventDefault();
          this._switchVariableOffset(1);
          break;
        case "Home":
          e.preventDefault();
          this.timeline.first();
          break;
        case "End":
          e.preventDefault();
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
          this.timeline.toggleLoopMode();
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
