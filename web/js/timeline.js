/**
 * Timeline & Animation Transport Controller for Dusty Earth.
 * Supports sub-hourly (e.g., 15-min WRF, 1-min PALM-4U) and hourly model outputs
 * with UTC valid-time matching across resolution switches.
 */

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export class TimelineController {
  constructor(domElements) {
    this.dom = domElements;
    this.timesteps = [];
    this.initTime = null;
    this.currentIndex = 0;
    this.isPlaying = false;
    this.fps = 4;
    this.loopMode = "repeat"; // "repeat" | "bounce"
    this.bounceDir = 1;

    this.timerId = null;
    this.lastTickTime = 0;
    this.onFrameChangeCallbacks = [];

    this._bindEvents();
  }

  setTimesteps(timesteps, preserveIndex = true, initTime = null) {
    this.timesteps = timesteps || [];
    this.initTime = initTime || (this.timesteps[0] ? this.timesteps[0].valid_time : null);
    if (!preserveIndex || this.currentIndex >= this.timesteps.length) {
      this.currentIndex = 0;
      this.bounceDir = 1;
    }

    const maxIdx = Math.max(0, this.timesteps.length - 1);
    this.dom.slider.min = 0;
    this.dom.slider.max = maxIdx;
    this.dom.slider.value = this.currentIndex;

    this._updateStepButtonTitles();
    this._buildTicks();
    this.updateUI();
  }

  getStepIntervalSeconds() {
    if (this.timesteps.length < 2) return 3600;
    const deltas = [];
    for (let i = 1; i < Math.min(this.timesteps.length, 10); i++) {
      const d0 = this._parseUtcDate(this.timesteps[i - 1].valid_time);
      const d1 = this._parseUtcDate(this.timesteps[i].valid_time);
      if (d0 && d1) {
        const diff = (d1.getTime() - d0.getTime()) / 1000;
        if (diff > 0) deltas.push(diff);
      }
    }
    if (deltas.length === 0) return 3600;
    deltas.sort((a, b) => a - b);
    return Math.round(deltas[Math.floor(deltas.length / 2)]);
  }

  _updateStepButtonTitles() {
    const dtSec = this.getStepIntervalSeconds();
    let stepLabel;
    if (dtSec >= 3600 && dtSec % 3600 === 0) {
      stepLabel = `${dtSec / 3600}h`;
    } else if (dtSec >= 60) {
      stepLabel = `${Math.round(dtSec / 60)}m`;
    } else {
      stepLabel = `${dtSec}s`;
    }
    if (this.dom.prevBtn) {
      this.dom.prevBtn.title = `Step -${stepLabel} (Left Arrow | Shift: -1h)`;
    }
    if (this.dom.nextBtn) {
      this.dom.nextBtn.title = `Step +${stepLabel} (Right Arrow | Shift: +1h)`;
    }
  }

  findNearestIndexForUtc(targetIso) {
    if (!targetIso || this.timesteps.length === 0) return 0;
    const targetDate = this._parseUtcDate(targetIso);
    if (!targetDate) return 0;
    const targetMs = targetDate.getTime();
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.timesteps.length; i++) {
      const d = this._parseUtcDate(this.timesteps[i].valid_time);
      if (!d) continue;
      const dist = Math.abs(d.getTime() - targetMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  onFrameChange(callback) {
    this.onFrameChangeCallbacks.push(callback);
  }

  _notifyChange() {
    const current = this.getCurrentTimestep();
    for (const cb of this.onFrameChangeCallbacks) {
      cb(current, this.currentIndex);
    }
  }

  getCurrentTimestep() {
    if (this.timesteps.length === 0) return null;
    return this.timesteps[this.currentIndex] || this.timesteps[0];
  }

  goTo(index, notify = true) {
    if (this.timesteps.length === 0) return;
    const clamped = Math.max(0, Math.min(this.timesteps.length - 1, index));
    if (this.currentIndex === clamped && !notify) return;

    this.currentIndex = clamped;
    this.updateUI();
    if (notify) {
      this._notifyChange();
    }
  }

  step(delta) {
    if (this.timesteps.length <= 1) return;

    if (this.loopMode === "bounce") {
      let next = this.currentIndex + delta * this.bounceDir;
      if (next >= this.timesteps.length) {
        this.bounceDir = -1;
        next = Math.max(0, this.timesteps.length - 2);
      } else if (next < 0) {
        this.bounceDir = 1;
        next = Math.min(this.timesteps.length - 1, 1);
      }
      this.goTo(next);
    } else {
      const next = (this.currentIndex + delta + this.timesteps.length) % this.timesteps.length;
      this.goTo(next);
    }
  }

  first() {
    this.bounceDir = 1;
    this.goTo(0);
  }

  last() {
    this.goTo(Math.max(0, this.timesteps.length - 1));
  }

  play() {
    if (this.timesteps.length <= 1) return;
    this.isPlaying = true;
    this.dom.playBtn.classList.add("playing");
    this.dom.playIcon.innerHTML = "&#x23F8;";
    this.dom.playLabel.textContent = "Pause";
    this.lastTickTime = performance.now();
    this.timerId = requestAnimationFrame((t) => this._tick(t));
  }

  pause() {
    this.isPlaying = false;
    this.dom.playBtn.classList.remove("playing");
    this.dom.playIcon.innerHTML = "&#x25B6;";
    this.dom.playLabel.textContent = "Play";
    if (this.timerId !== null) {
      cancelAnimationFrame(this.timerId);
      this.timerId = null;
    }
  }

  togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  toggleLoopMode() {
    if (this.loopMode === "repeat") {
      this.loopMode = "bounce";
      this.bounceDir = 1;
      this.dom.loopBtn.innerHTML = "&#x2194;&#xFE0F; Bounce";
    } else {
      this.loopMode = "repeat";
      this.bounceDir = 1;
      this.dom.loopBtn.innerHTML = "&#x1F501; Repeat";
    }
  }

  setFps(fps) {
    this.fps = Math.max(1, Math.min(10, fps));
    this.dom.fpsValue.textContent = String(this.fps);
  }

  _tick(timestamp) {
    if (!this.isPlaying) return;
    const interval = 1000 / this.fps;
    if (timestamp - this.lastTickTime >= interval) {
      this.lastTickTime = timestamp;
      this.step(1);
    }
    this.timerId = requestAnimationFrame((t) => this._tick(t));
  }

  _parseUtcDate(isoStr) {
    if (!isoStr) return null;
    const normalized = isoStr.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(isoStr) ? isoStr : `${isoStr}Z`;
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  _formatValidHeaderHtml(isoStr) {
    const d = this._parseUtcDate(isoStr);
    if (!d) {
      const raw = isoStr ? isoStr.replace("T", " ").replace("Z", " UTC") : "-- UTC";
      return `<span class="valid-utc-main">${raw}</span>`;
    }

    const dow = DAYS_SHORT[d.getUTCDay()];
    const day = String(d.getUTCDate()).padStart(2, "0");
    const mon = MONTHS_SHORT[d.getUTCMonth()];
    const yr = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");

    const astDate = new Date(d.getTime() + 3 * 3600 * 1000);
    const astHh = String(astDate.getUTCHours()).padStart(2, "0");
    const astMm = String(astDate.getUTCMinutes()).padStart(2, "0");

    return (
      `<span class="valid-utc-main">${dow}, ${day} ${mon} ${yr} &middot; ${hh}:${mm} UTC</span>` +
      `<span class="valid-local-pill" title="Qatar Local Time (Arabia Standard Time, UTC+3)">${astHh}:${astMm} AST (+03)</span>`
    );
  }

  _formatInitBadge(isoStr) {
    const d = this._parseUtcDate(isoStr);
    if (!d) return null;
    const yr = d.getUTCFullYear();
    const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    return `${yr}-${mon}-${day} ${hh}Z`;
  }

  _formatLeadBadge(step) {
    if (typeof step.lead_seconds === "number") {
      const totalMin = Math.round(step.lead_seconds / 60);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (m === 0) return `T+${String(h).padStart(3, "0")}h`;
      return `T+${String(h).padStart(3, "0")}h ${String(m).padStart(2, "0")}m`;
    }
    const leadHourNum = typeof step.lead_hour === "number" ? step.lead_hour : this.currentIndex;
    return `T+${String(Math.floor(leadHourNum)).padStart(3, "0")}h`;
  }

  _formatTickDateLabel(isoStr, includeHour = false, includeMinutes = false) {
    const d = this._parseUtcDate(isoStr);
    if (!d) return "--";
    const dow = DAYS_SHORT[d.getUTCDay()];
    const day = String(d.getUTCDate()).padStart(2, "0");
    const mon = MONTHS_SHORT[d.getUTCMonth()];
    const hh = d.getUTCHours();
    const mm = d.getUTCMinutes();
    if (includeMinutes) {
      return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}Z`;
    }
    if (includeHour || hh !== 0) {
      return `${dow} ${day} ${mon} ${String(hh).padStart(2, "0")}Z`;
    }
    return `${dow} ${day} ${mon}`;
  }

  updateUI() {
    const current = this.getCurrentTimestep();
    if (!current) return;

    this.dom.slider.value = this.currentIndex;

    if (this.dom.validTime) {
      this.dom.validTime.innerHTML = this._formatValidHeaderHtml(current.valid_time);
    }

    if (this.dom.leadTime) {
      const leadFormatted = this._formatLeadBadge(current);
      const initBadge = this._formatInitBadge(this.initTime);
      this.dom.leadTime.textContent = initBadge
        ? `Init: ${initBadge} · Lead: ${leadFormatted}`
        : `Lead: ${leadFormatted}`;
    }

    if (this.dom.ticksContainer && this.dom.ticksContainer.children.length > 0) {
      const tickEls = Array.from(this.dom.ticksContainer.children);
      let nearestEl = tickEls[0];
      let minDist = Infinity;

      for (const el of tickEls) {
        const idx = Number(el.dataset.index);
        const dist = Math.abs(idx - this.currentIndex);
        if (dist < minDist) {
          minDist = dist;
          nearestEl = el;
        }
      }

      for (const el of tickEls) {
        const idx = Number(el.dataset.index);
        el.classList.toggle("active", el === nearestEl);
        el.classList.toggle("exact", idx === this.currentIndex);
      }
    }
  }

  _buildTicks() {
    if (!this.dom.ticksContainer) return;
    this.dom.ticksContainer.innerHTML = "";
    if (this.timesteps.length === 0) return;

    const n = this.timesteps.length;
    const firstDate = this._parseUtcDate(this.timesteps[0].valid_time);
    const lastDate = this._parseUtcDate(this.timesteps[n - 1].valid_time);
    const spanHours =
      firstDate && lastDate
        ? (lastDate.getTime() - firstDate.getTime()) / (3600 * 1000)
        : n - 1;

    let selectedIndices = [];
    let showHourOnTicks = false;
    const showMinutesOnTicks = spanHours > 0 && spanHours < 3;

    if (firstDate && lastDate && spanHours >= 48) {
      const zeroUtcIndices = [];
      const synoptic12hIndices = [];

      for (let i = 0; i < n; i++) {
        const d = this._parseUtcDate(this.timesteps[i].valid_time);
        if (!d) continue;
        if (d.getUTCMinutes() === 0 && d.getUTCHours() === 0) {
          zeroUtcIndices.push(i);
        }
        if (d.getUTCMinutes() === 0 && (d.getUTCHours() === 0 || d.getUTCHours() === 12)) {
          synoptic12hIndices.push(i);
        }
      }

      if (zeroUtcIndices.length >= 4) {
        selectedIndices = zeroUtcIndices;
      } else if (synoptic12hIndices.length >= 4) {
        selectedIndices = synoptic12hIndices;
        showHourOnTicks = true;
      }
    }

    if (selectedIndices.length < 3) {
      showHourOnTicks = true;
      const maxTicks = 9;
      const step = Math.max(1, Math.ceil((n - 1) / (maxTicks - 1)));
      const tickSet = new Set();
      for (let i = 0; i < n; i += step) {
        tickSet.add(i);
      }
      tickSet.add(n - 1);
      selectedIndices = Array.from(tickSet).sort((a, b) => a - b);
    } else {
      const edgeGap = Math.max(3, Math.round(n / 18));
      if (selectedIndices[0] !== 0) {
        if (selectedIndices[0] >= edgeGap) {
          selectedIndices.unshift(0);
        } else {
          selectedIndices[0] = 0;
        }
      }
      const lastTickIdx = selectedIndices[selectedIndices.length - 1];
      if (lastTickIdx !== n - 1) {
        if (n - 1 - lastTickIdx >= edgeGap) {
          selectedIndices.push(n - 1);
        } else {
          selectedIndices[selectedIndices.length - 1] = n - 1;
        }
      }
    }

    selectedIndices.forEach((idx) => {
      const step = this.timesteps[idx];
      const leadLabel = step.lead_label || `T+${String(step.lead_hour ?? idx).padStart(2, "0")}`;
      const dateLabel = this._formatTickDateLabel(step.valid_time, showHourOnTicks, showMinutesOnTicks);

      const span = document.createElement("span");
      span.className = `timeline-tick${idx === this.currentIndex ? " active" : ""}`;
      span.dataset.index = String(idx);
      span.innerHTML = `<span class="tick-date">${dateLabel}</span><span class="tick-lead">${leadLabel}</span>`;
      span.title = `Jump to ${dateLabel} (${leadLabel})`;
      span.addEventListener("click", () => {
        this.pause();
        this.goTo(idx);
      });
      this.dom.ticksContainer.appendChild(span);
    });
  }

  _bindEvents() {
    this.dom.playBtn.addEventListener("click", () => this.togglePlay());
    this.dom.prevBtn.addEventListener("click", () => {
      this.pause();
      this.step(-1);
    });
    this.dom.nextBtn.addEventListener("click", () => {
      this.pause();
      this.step(1);
    });
    this.dom.firstBtn.addEventListener("click", () => {
      this.pause();
      this.first();
    });
    this.dom.lastBtn.addEventListener("click", () => {
      this.pause();
      this.last();
    });

    this.dom.slider.addEventListener("input", (e) => {
      this.pause();
      this.goTo(Number(e.target.value));
    });

    this.dom.loopBtn.addEventListener("click", () => this.toggleLoopMode());

    this.dom.fpsSlider.addEventListener("input", (e) => {
      this.setFps(Number(e.target.value));
    });
  }
}
