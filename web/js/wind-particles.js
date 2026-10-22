/**
 * GPU & Canvas Wind Particle Streamline Animation Engine for Dusty Earth.
 * Delivers a 60 FPS flowing wind streamline experience (Windy.com style).
 */

export class WindParticles {
  constructor(canvas, mapEngine) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.mapEngine = mapEngine;

    this.uBuffer = null;
    this.vBuffer = null;
    this.gridMeta = null;

    this.particles = [];
    this.numParticles = 4500;
    this.particleSpeed = 0.00035;
    this.maxAge = 75;
    this.lineWidth = 1.25;
    this.trailFade = 0.045; // Fading factor per frame

    this.isRunning = false;
    this.visible = true;
    this.animId = null;

    this.cache = new Map(); // url -> Float32Array
  }

  async loadBuffer(url) {
    if (this.cache.has(url)) {
      return this.cache.get(url);
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch wind component: ${url}`);
    }
    const buf = await res.arrayBuffer();
    const f32 = new Float32Array(buf);
    this.cache.set(url, f32);
    return f32;
  }

  async setWindField(uUrl, vUrl, gridMeta) {
    this.gridMeta = gridMeta;
    const [u, v] = await Promise.all([this.loadBuffer(uUrl), this.loadBuffer(vUrl)]);
    this.uBuffer = u;
    this.vBuffer = v;

    this.initParticles();
    if (this.visible && !this.isRunning) {
      this.start();
    }
  }

  initParticles() {
    if (!this.gridMeta) return;
    const { lon_min, lon_max, lat_min, lat_max } = this.gridMeta;
    this.particles = new Float32Array(this.numParticles * 4); // [lon, lat, age, maxAge]

    for (let i = 0; i < this.numParticles; i++) {
      const offset = i * 4;
      this.particles[offset] = lon_min + Math.random() * (lon_max - lon_min);
      this.particles[offset + 1] = lat_min + Math.random() * (lat_max - lat_min);
      this.particles[offset + 2] = Math.floor(Math.random() * this.maxAge); // staggered start age
      this.particles[offset + 3] = this.maxAge * (0.6 + Math.random() * 0.8);
    }
  }

  sampleVector(lon, lat) {
    if (!this.gridMeta || !this.uBuffer || !this.vBuffer) return [0, 0];
    const { nx, ny, lon_min, lon_max, lat_min, lat_max, dx, dy } = this.gridMeta;

    if (lon < lon_min || lon > lon_max || lat < lat_min || lat > lat_max) {
      return null;
    }

    const col = (lon - lon_min) / dx;
    const row = (lat_max - lat) / dy; // North-to-South row orientation

    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const c1 = Math.min(nx - 1, c0 + 1);
    const r1 = Math.min(ny - 1, r0 + 1);

    const fx = col - c0;
    const fy = row - r0;

    const idx00 = r0 * nx + c0;
    const idx01 = r0 * nx + c1;
    const idx10 = r1 * nx + c0;
    const idx11 = r1 * nx + c1;

    // Bilinear interpolation for U
    const u0 = (1 - fx) * this.uBuffer[idx00] + fx * this.uBuffer[idx01];
    const u1 = (1 - fx) * this.uBuffer[idx10] + fx * this.uBuffer[idx11];
    const u = (1 - fy) * u0 + fy * u1;

    // Bilinear interpolation for V
    const v0 = (1 - fx) * this.vBuffer[idx00] + fx * this.vBuffer[idx01];
    const v1 = (1 - fx) * this.vBuffer[idx10] + fx * this.vBuffer[idx11];
    const v = (1 - fy) * v0 + fy * v1;

    return [u, v];
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this._tick();
  }

  stop() {
    this.isRunning = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  clear() {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      this.stop();
      this.clear();
    } else if (this.uBuffer && this.vBuffer) {
      this.start();
    }
  }

  setSpeed(factor) {
    this.particleSpeed = factor;
  }

  setDensity(count) {
    this.numParticles = Math.max(500, Math.min(15000, count));
    this.initParticles();
  }

  _tick() {
    if (!this.isRunning || !this.visible || !this.ctx || !this.gridMeta) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // 1. Trail Fading Effect (fades existing strokes to create glowing streamline trails)
    this.ctx.save();
    this.ctx.globalCompositeOperation = "destination-out";
    this.ctx.fillStyle = `rgba(0, 0, 0, ${this.trailFade})`;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.restore();

    // 2. Advance and Draw Particles
    const { lon_min, lon_max, lat_min, lat_max } = this.gridMeta;
    this.ctx.save();
    this.ctx.lineWidth = this.lineWidth;
    this.ctx.lineCap = "round";

    // Begin path batching for performance
    this.ctx.beginPath();
    this.ctx.strokeStyle = "rgba(240, 249, 255, 0.72)";

    for (let i = 0; i < this.numParticles; i++) {
      const offset = i * 4;
      let lon = this.particles[offset];
      let lat = this.particles[offset + 1];
      let age = this.particles[offset + 2];
      const maxAge = this.particles[offset + 3];

      const vec = this.sampleVector(lon, lat);
      if (!vec || age >= maxAge) {
        // Respawn particle randomly
        this.particles[offset] = lon_min + Math.random() * (lon_max - lon_min);
        this.particles[offset + 1] = lat_min + Math.random() * (lat_max - lat_min);
        this.particles[offset + 2] = 0;
        continue;
      }

      const [u, v] = vec;
      const cosLat = Math.cos((lat * Math.PI) / 180.0) || 1.0;

      const dLon = (u * this.particleSpeed) / cosLat;
      const dLat = v * this.particleSpeed;

      const nextLon = lon + dLon;
      const nextLat = lat + dLat;

      // Project old and new positions to screen pixels
      const p0 = this.mapEngine.project(lon, lat);
      const p1 = this.mapEngine.project(nextLon, nextLat);

      // Only draw if within current viewport
      if (
        (p0.x >= -50 && p0.x <= width + 50 && p0.y >= -50 && p0.y <= height + 50) ||
        (p1.x >= -50 && p1.x <= width + 50 && p1.y >= -50 && p1.y <= height + 50)
      ) {
        this.ctx.moveTo(p0.x, p0.y);
        this.ctx.lineTo(p1.x, p1.y);
      }

      // Update particle state
      this.particles[offset] = nextLon;
      this.particles[offset + 1] = nextLat;
      this.particles[offset + 2] = age + 1;
    }

    this.ctx.stroke();
    this.ctx.restore();

    this.animId = requestAnimationFrame(() => this._tick());
  }
}
