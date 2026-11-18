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
    this.timestepEpochMs = [];
    this.initTime = null;
    this.currentIndex = 0;
    this.playheadMs = 0;
    this.isPlaying = false;
    this.simHoursPerSec = 3.0; // Constant physical speed across 1h / 15m / 10m / 1m cadences
    this.fps = 3.0;
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
    const baseDate = this.initTime ? this._parseUtcDate(this.initTime) : null;
    const baseMs = baseDate ? baseDate.getTime() : 0;
    this.timestepEpochMs = this.timesteps.map((ts, idx) => {
      const d = this._parseUtcDate(ts && ts.valid_time);
      if (d) return d.getTime();
      const leadSec = ts && typeof ts.lead_seconds === "number" ? ts.lead_seconds : idx * 3600;
      return baseMs + leadSec * 1000;
    });

    if (!preserveIndex || this.currentIndex >= this.timesteps.length) {
      this.currentIndex = 0;
      this.bounceDir = 1;
    }
    this.playheadMs = this.timestepEpochMs[this.currentIndex] ?? 0;

    const maxIdx = Math.max(0, this.timesteps.length - 1);
    this.dom.slider.min = 0;
    this.dom.slider.max = maxIdx;
    this.dom.slider.value = this.currentIndex;

    this._updateStepButtonTitles();
    this._updateSpeedLabel();
    this._buildTicks();
    this.updateUI();
  }

  getStepIntervalSeconds() {
    if (this.timestepEpochMs.length < 2) return 3600;
    const deltas = [];
    for (let i = 1; i < Math.min(this.timestepEpochMs.length, 10); i++) {
      const diff = (this.timestepEpochMs[i] - this.timestepEpochMs[i - 1]) / 1000;
      if (diff > 0) deltas.push(diff);
    }
    if (deltas.length === 0) return 3600;
    deltas.sort((a, b) => a - b);
    return Math.round(deltas[Math.floor(deltas.length / 2)]);
  }

  getTotalSpanSeconds() {
    if (this.timestepEpochMs.length < 2) return 0;
    return Math.max(
      0,
      (this.timestepEpochMs[this.timestepEpochMs.length - 1] - this.timestepEpochMs[0]) / 1000
    );
  }

  getEffectiveSimSecondsPerRealSec() {
    const base = this.simHoursPerSec * 3600;
    const totalSpanSec = this.getTotalSpanSeconds();
    if (totalSpanSec > 0 && totalSpanSec < 1800) {
      const dtSec = Math.max(1, this.getStepIntervalSeconds());
      return Math.min(base, Math.max(dtSec, totalSpanSec / 2.5) * (this.simHoursPerSec / 3.0));
    }
    return base;
  }

  _formatIntervalLabel(dtSec) {
    if (dtSec >= 3600 && dtSec % 3600 === 0) {
      return `${dtSec / 3600}h`;
    }
    if (dtSec >= 60) {
      return `${Math.round(dtSec / 60)}m`;
    }
    return `${dtSec}s`;
  }

  _updateStepButtonTitles() {
    const stepLabel = this._formatIntervalLabel(this.getStepIntervalSeconds());
    if (this.dom.prevBtn) {
      this.dom.prevBtn.title = `Step -${stepLabel} (Left Arrow | Shift: -1h)`;
    }
    if (this.dom.nextBtn) {
      this.dom.nextBtn.title = `Step +${stepLabel} (Right Arrow | Shift: +1h)`;
    }
  }

  _updateSpeedLabel() {
    const cleanNum = Number(this.simHoursPerSec.toFixed(2));
    const valStr = `${cleanNum}h/s`;
    if (this.dom.fpsValue) {
      this.dom.fpsValue.textContent = valStr;
    }
    if (this.dom.fpsSlider) {
      this.dom.fpsSlider.value = String(this.simHoursPerSec);
      const dtSec = Math.max(1, this.getStepIntervalSeconds());
      const effSimRate = this.getEffectiveSimSecondsPerRealSec();
      const effFps = Math.min(60, effSimRate / dtSec);
      const stepLabel = this._formatIntervalLabel(dtSec);
      const tip = `Playback speed: ${this.simHoursPerSec} forecast h/s (~${effFps.toFixed(1)} fps @ ${stepLabel} output)`;
      this.dom.fpsSlider.title = tip;
      if (this.dom.fpsSlider.parentElement) {
        this.dom.fpsSlider.parentElement.title = tip;
      }
    }
  }

  _findNearestIndexMs(targetMs) {
    if (this.timestepEpochMs.length === 0) return 0;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.timestepEpochMs.length; i++) {
      const dist = Math.abs(this.timestepEpochMs[i] - targetMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  findNearestIndexForUtc(targetIso) {
    if (!targetIso || this.timesteps.length === 0) return 0;
    const targetDate = this._parseUtcDate(targetIso);
    if (!targetDate) return 0;
    return this._findNearestIndexMs(targetDate.getTime());
  }

  getPlayheadIso() {
    if (this.timestepEpochMs.length > 0 && Number.isFinite(this.playheadMs) && this.playheadMs > 0) {
      return new Date(this.playheadMs).toISOString();
    }
    const cur = this.getCurrentTimestep();
    return cur ? cur.valid_time : null;
  }

  syncToUtc(targetIso, notify = false) {
    if (this.timesteps.length === 0) return;
    const targetDate = this._parseUtcDate(targetIso);
    if (!targetDate) {
      this.goTo(0, notify, false);
      return;
    }
    const targetMs = targetDate.getTime();
    const idx = this._findNearestIndexMs(targetMs);
    const tFirst = this.timestepEpochMs[0];
    const tLast = this.timestepEpochMs[this.timestepEpochMs.length - 1];
    const dtMs = Math.max(1, this.getStepIntervalSeconds()) * 1000;
    if (targetMs >= tFirst - dtMs && targetMs <= tLast + dtMs) {
      this.playheadMs = Math.min(tLast, Math.max(tFirst, targetMs));
      this.goTo(idx, notify, true);
    } else {
      this.goTo(idx, notify, false);
    }
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

  goTo(index, notify = true, preservePlayhead = false) {
    if (this.timesteps.length === 0) return;
    const clamped = Math.max(0, Math.min(this.timesteps.length - 1, index));
    if (this.currentIndex === clamped && !notify) {
      if (!preservePlayhead && this.timestepEpochMs[clamped] !== undefined) {
        this.playheadMs = this.timestepEpochMs[clamped];
      }
      return;
    }

    this.currentIndex = clamped;
    if (!preservePlayhead && this.timestepEpochMs[clamped] !== undefined) {
      this.playheadMs = this.timestepEpochMs[clamped];
    }
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
    if (!Number.isFinite(this.playheadMs) || this.playheadMs <= 0) {
      this.playheadMs = this.timestepEpochMs[this.currentIndex] ?? 0;
    }
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

  setSpeedHoursPerSec(hoursPerSec) {
    this.simHoursPerSec = Math.max(0.25, Math.min(12.0, Number(hoursPerSec) || 3.0));
    this.fps = this.simHoursPerSec;
    this._updateSpeedLabel();
  }

  setFps(val) {
    this.setSpeedHoursPerSec(val);
  }

  _tick(timestamp) {
    if (!this.isPlaying) return;
    const dtRealSec = Math.min(0.25, Math.max(0, (timestamp - this.lastTickTime) / 1000));
    this.lastTickTime = timestamp;

    if (this.timestepEpochMs.length >= 2) {
      const tFirst = this.timestepEpochMs[0];
      const tLast = this.timestepEpochMs[this.timestepEpochMs.length - 1];
      if (tLast > tFirst) {
        const simSecPerReal = this.getEffectiveSimSecondsPerRealSec();
        this.playheadMs += dtRealSec * simSecPerReal * 1000 * this.bounceDir;

        if (this.loopMode === "bounce") {
          if (this.playheadMs >= tLast) {
            this.playheadMs = Math.max(tFirst, tLast - (this.playheadMs - tLast));
            this.bounceDir = -1;
          } else if (this.playheadMs <= tFirst) {
            this.playheadMs = Math.min(tLast, tFirst + (tFirst - this.playheadMs));
            this.bounceDir = 1;
          }
        } else {
          const dtMs = Math.max(1, this.getStepIntervalSeconds()) * 1000;
          const cycleSpan = (tLast - tFirst) + dtMs;
          if (this.playheadMs >= tLast + dtMs) {
            this.playheadMs = tFirst + ((this.playheadMs - tFirst) % cycleSpan);
          } else if (this.playheadMs < tFirst) {
            this.playheadMs = tFirst;
          }
        }

        const clampedMs = Math.min(tLast, Math.max(tFirst, this.playheadMs));
        const targetIdx = this._findNearestIndexMs(clampedMs);
        if (targetIdx !== this.currentIndex) {
          this.goTo(targetIdx, true, true);
        }
      }
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
    if (includeMinutes || mm !== 0) {
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
    } else if (firstDate && lastDate && spanHours >= 6 && spanHours < 48) {
      const synoptic3hIndices = [];
      for (let i = 0; i < n; i++) {
        const d = this._parseUtcDate(this.timesteps[i].valid_time);
        if (!d) continue;
        if (d.getUTCMinutes() === 0 && d.getUTCHours() % 3 === 0) {
          synoptic3hIndices.push(i);
        }
      }
      if (synoptic3hIndices.length >= 4) {
        selectedIndices = synoptic3hIndices;
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
      this.setSpeedHoursPerSec(Number(e.target.value));
    });
  }
}
