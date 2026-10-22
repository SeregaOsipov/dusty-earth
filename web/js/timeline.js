/**
 * Timeline & Animation Transport Controller for Dusty Earth.
 * Manages lead-time time-stepping, continuous animation loop, and scrub bar.
 */

export class TimelineController {
  constructor(domElements) {
    this.dom = domElements;
    this.timesteps = [];
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

  setTimesteps(timesteps, preserveIndex = true) {
    this.timesteps = timesteps || [];
    if (!preserveIndex || this.currentIndex >= this.timesteps.length) {
      this.currentIndex = 0;
      this.bounceDir = 1;
    }

    const maxIdx = Math.max(0, this.timesteps.length - 1);
    this.dom.slider.min = 0;
    this.dom.slider.max = maxIdx;
    this.dom.slider.value = this.currentIndex;

    this._buildTicks();
    this.updateUI();
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

  goTo(index) {
    if (this.timesteps.length === 0) return;
    const clamped = Math.max(0, Math.min(this.timesteps.length - 1, index));
    if (this.currentIndex === clamped) return;

    this.currentIndex = clamped;
    this.updateUI();
    this._notifyChange();
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

  updateUI() {
    const current = this.getCurrentTimestep();
    if (!current) return;

    this.dom.slider.value = this.currentIndex;

    const validStr = current.valid_time ? current.valid_time.replace("T", " ").replace("Z", " UTC") : "--";
    const leadStr = current.lead_label || `T+${String(current.lead_hour).padStart(2, "0")}`;

    if (this.dom.validTime) this.dom.validTime.textContent = `Valid: ${validStr}`;
    if (this.dom.leadTime) this.dom.leadTime.textContent = `Lead: ${leadStr}`;

    // Highlight active tick
    if (this.dom.ticksContainer) {
      Array.from(this.dom.ticksContainer.children).forEach((el) => {
        el.classList.toggle("active", Number(el.dataset.index) === this.currentIndex);
      });
    }
  }

  _buildTicks() {
    if (!this.dom.ticksContainer) return;
    this.dom.ticksContainer.innerHTML = "";
    if (this.timesteps.length === 0) return;

    const maxTicks = 12;
    const step = Math.max(1, Math.ceil((this.timesteps.length - 1) / (maxTicks - 1)));
    const tickIndices = new Set();
    for (let i = 0; i < this.timesteps.length; i += step) {
      tickIndices.add(i);
    }
    tickIndices.add(this.timesteps.length - 1);

    Array.from(tickIndices)
      .sort((a, b) => a - b)
      .forEach((idx) => {
        const step = this.timesteps[idx];
        const span = document.createElement("span");
        span.className = `timeline-tick${idx === this.currentIndex ? " active" : ""}`;
        span.dataset.index = String(idx);
        span.textContent = step.lead_label || `T+${step.lead_hour}`;
        span.title = `Jump to ${step.lead_label}`;
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
