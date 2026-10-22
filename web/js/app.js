/**
 * Main Application Controller for Dusty Earth.
 * Orchestrates MapEngine, ScalarLayer, WindParticles, Timeline, and WeatherProbe.
 */

import { MapEngine } from "./map-engine.js";
import { ScalarLayer } from "./scalar-layer.js";
import { WindParticles } from "./wind-particles.js";
import { WeatherProbe } from "./probe.js";
import { TimelineController } from "./timeline.js";

class DustyApp {
  constructor() {
    this.manifest = null;
    this.activeCycle = null;
    this.activeVariable = null;

    this.mapEngine = new MapEngine("map");
    this.scalarLayer = null;
    this.windParticles = null;
    this.probe = null;
    this.timeline = null;

    this.showWindOverlay = true;

    this.dom = {
      cycleSelect: document.getElementById("cycle-select"),
      layerDock: document.getElementById("layer-dock-list"),
      windToggleBtn: document.getElementById("btn-toggle-wind"),
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
    };
  }

  async init() {
    console.log("[Dusty Earth] Initializing GPU-accelerated forecast engine...");

    // 1. Initialize MapLibre Engine
    await this.mapEngine.init([50.0, 25.0], 5.0);

    // 2. Initialize Visual Renderers
    this.scalarLayer = new ScalarLayer(this.mapEngine.scalarCanvas, this.mapEngine);
    this.windParticles = new WindParticles(this.mapEngine.particleCanvas, this.mapEngine);
    this.probe = new WeatherProbe(
      this.dom.weatherProbe,
      this.mapEngine,
      this.scalarLayer,
      this.windParticles
    );

    // Re-render scalar field and refresh particle canvas on map movement
    this.mapEngine.onMove(() => {
      this.scalarLayer.render();
      if (this.windParticles && this.showWindOverlay) {
        this.windParticles.clear();
      }
    });

    // 3. Initialize Timeline Controller
    this.timeline = new TimelineController(this.dom);
    this.timeline.onFrameChange((timestep) => {
      this.loadTimestep(timestep);
    });

    // 4. Bind UI & Keyboard Events
    this._bindEvents();

    // 5. Fetch Forecast Manifest
    await this.loadManifest();
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

      this._populateCycles(cycles);
      this.selectCycle(this.manifest.default_cycle || cycles[0].id);
    } catch (err) {
      console.error("[Dusty Earth] Failed to load manifest.json:", err);
      // Fallback message
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

  selectCycle(cycleId) {
    const cycle = this.manifest.cycles.find((c) => c.id === cycleId) || this.manifest.cycles[0];
    if (!cycle) return;

    this.activeCycle = cycle;
    this.dom.cycleSelect.value = cycle.id;

    // Zoom to domain bounding box if available
    const g = cycle.grid;
    if (g) {
      this.mapEngine.fitBounds(g.lon_min, g.lat_min, g.lon_max, g.lat_max);
    }

    this._populateVariables(cycle.variables);

    // Default to surface dust or first available variable
    const defaultVarId = cycle.variables.some((v) => v.id === "sconc_dust")
      ? "sconc_dust"
      : cycle.variables[0].id;

    this.timeline.setTimesteps(cycle.timesteps || []);
    this.selectVariable(defaultVarId);
  }

  _populateVariables(variables) {
    this.dom.layerDock.innerHTML = "";
    const icons = {
      sconc_dust: "🌪️",
      dust_load: "🌫️",
      dod550: "☀️",
      wind10m: "💨",
      t2m: "🌡️",
      pm25: "🔬",
      o3: "⚡",
      so2: "🏭",
    };

    variables.forEach((v) => {
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
      this.dom.layerDock.appendChild(btn);
    });
  }

  selectVariable(varId) {
    if (!this.activeCycle) return;
    const v = this.activeCycle.variables.find((item) => item.id === varId);
    if (!v) return;

    this.activeVariable = v;
    this.probe.setVarConfig(v);

    // Update active button state
    Array.from(this.dom.layerDock.children).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.id === varId);
    });

    this._updateLegend(v);

    // Refresh current frame with new variable
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

    // Build CSS linear-gradient string from colormap stops
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
    if (!timestep || !this.activeCycle || !this.activeVariable) return;

    const gridMeta = this.activeCycle.grid;

    // 1. Load & Render Active Scalar Layer
    const varFiles = timestep.files[this.activeVariable.id];
    if (varFiles && varFiles.scalar) {
      try {
        await this.scalarLayer.setField(varFiles.scalar, gridMeta, this.activeVariable);
      } catch (err) {
        console.warn(`[Dusty Earth] Failed to load scalar frame:`, err);
      }
    } else {
      this.scalarLayer.clear();
    }

    // 2. Load & Update Wind Streamlines (always load wind10m if available in timestep)
    if (this.showWindOverlay) {
      const windFiles = timestep.files["wind10m"];
      if (windFiles && windFiles.u && windFiles.v) {
        try {
          await this.windParticles.setWindField(windFiles.u, windFiles.v, gridMeta);
        } catch (err) {
          console.warn("[Dusty Earth] Failed to load wind field:", err);
        }
      }
    }

    // 3. Preload next 3 frames in memory for instant zero-latency scrubbing
    this._preloadUpcomingFrames();
  }

  _preloadUpcomingFrames() {
    if (!this.timeline || !this.timeline.timesteps || !this.activeVariable) return;
    const timesteps = this.timeline.timesteps;
    const curr = this.timeline.currentIndex;

    for (let offset = 1; offset <= 3; offset++) {
      const idx = (curr + offset) % timesteps.length;
      const ts = timesteps[idx];
      const vf = ts.files[this.activeVariable.id];
      if (vf && vf.scalar) {
        this.scalarLayer.loadBuffer(vf.scalar).catch(() => {});
      }
      const wf = ts.files["wind10m"];
      if (wf && wf.u && wf.v) {
        this.windParticles.loadBuffer(wf.u).catch(() => {});
        this.windParticles.loadBuffer(wf.v).catch(() => {});
      }
    }
  }

  _bindEvents() {
    // Cycle dropdown
    this.dom.cycleSelect.addEventListener("change", (e) => {
      this.selectCycle(e.target.value);
    });

    // Wind Streamlines Toggle
    this.dom.windToggleBtn.addEventListener("click", () => {
      this.showWindOverlay = !this.showWindOverlay;
      this.dom.windToggleBtn.classList.toggle("active", this.showWindOverlay);
      this.windParticles.setVisible(this.showWindOverlay);
      if (this.showWindOverlay) {
        const currentTimestep = this.timeline.getCurrentTimestep();
        if (currentTimestep) {
          const wf = currentTimestep.files["wind10m"];
          if (wf) this.windParticles.setWindField(wf.u, wf.v, this.activeCycle.grid);
        }
      }
    });

    // Settings Panel Toggle
    this.dom.settingsBtn.addEventListener("click", () => {
      this.dom.settingsPanel.classList.toggle("open");
    });
    this.dom.settingsClose.addEventListener("click", () => {
      this.dom.settingsPanel.classList.remove("open");
    });

    // Particle Density Slider
    this.dom.particleCountSlider.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      this.dom.particleCountVal.textContent = String(val);
      this.windParticles.setDensity(val);
    });

    // Particle Speed Slider
    this.dom.particleSpeedSlider.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      this.dom.particleSpeedVal.textContent = `${val}x`;
      this.windParticles.setSpeed(val * 0.00035);
    });

    // Weather Standard Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
      if (document.activeElement && document.activeElement.tagName === "INPUT") return;

      switch (e.key) {
        case " ":
        case "Spacebar":
          e.preventDefault();
          this.timeline.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          this.timeline.pause();
          this.timeline.step(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          this.timeline.pause();
          this.timeline.step(1);
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
        case "l":
        case "L":
          e.preventDefault();
          this.timeline.toggleLoopMode();
          break;
      }
    });
  }

  _switchVariableOffset(offset) {
    if (!this.activeCycle || !this.activeCycle.variables) return;
    const vars = this.activeCycle.variables;
    const currIdx = vars.findIndex((v) => v.id === this.activeVariable.id);
    const nextIdx = (currIdx + offset + vars.length) % vars.length;
    this.selectVariable(vars[nextIdx].id);
  }
}

// Bootstrap application on window load
window.addEventListener("DOMContentLoaded", () => {
  const app = new DustyApp();
  app.init().catch((err) => console.error("Initialization failed:", err));
});
