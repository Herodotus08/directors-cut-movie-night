/**
 * Director's Cut — overlay host (content script).
 *
 * One <div> with a shadow root is pinned over the video's bounding box and
 * re-parented into the fullscreen element when the user goes fullscreen (an
 * overlay outside the fullscreen subtree is simply not painted).
 *
 * Layers, bottom to top:
 *   canvas.dc-canvas  shared sketchpad   (pointer-events only while the brush is on)
 *   div.dc-fx         emoji missiles     (pointer-events: none, always)
 *   div.dc-bar        toolbar            (pointer-events: auto)
 */
(() => {
  const NS = globalThis.DirectorsCut;
  const COLORS = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#f8f9fa'];
  const FLUSH_MS = 40;      // stroke-point batching interval
  const TRACK_MS = 500;     // rect re-sync fallback (covers CSS-driven layout)

  class Overlay {
    constructor({ settings, handlers }) {
      this.settings = { ...NS.DEFAULTS, ...settings };
      this.handlers = handlers;
      this.video = null;
      this.host = null;
      this.shadow = null;
      this.brush = false;
      this.raf = 0;
      this.stroke = null;
      this.flushTimer = 0;
      this.trackTimer = 0;
      this.observer = null;
      this.onTrack = () => this.place();
      this.onKey = (ev) => this.handleKey(ev);
    }

    async mount(video) {
      if (this.host) return this.setVideo(video);
      this.host = document.createElement('div');
      this.host.id = 'directors-cut-overlay';
      this.host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;pointer-events:none;';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      await this.loadStyles();
      this.buildDom();
      document.documentElement.appendChild(this.host);

      this.sketch = new NS.Sketchpad(this.canvas, { fadeMs: this.settings.fadeMs });
      this.emoji = new NS.EmojiLayer(this.fx);
      this.setVideo(video);
      this.bindTracking();
      return this;
    }

    /**
     * Styles are fetched (content-script fetches bypass the page's CSP, a <link>
     * would not) and adopted into the shadow root.
     */
    async loadStyles() {
      const url = chrome.runtime.getURL('content/overlay.css');
      try {
        const css = await (await fetch(url)).text();
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        this.shadow.adoptedStyleSheets = [sheet];
      } catch {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        this.shadow.appendChild(link);
      }
    }

    buildDom() {
      const root = document.createElement('div');
      root.className = 'dc-root';
      root.innerHTML = `
        <canvas class="dc-canvas"></canvas>
        <div class="dc-fx"></div>
        <div class="dc-picker" hidden></div>
        <div class="dc-bar">
          <span class="dc-pill" data-role="status">connecting…</span>
          <button class="dc-btn" data-act="brush" title="Shared sketchpad (Alt+D)">✏️</button>
          <span class="dc-swatches"></span>
          <input class="dc-range" type="range" min="2" max="18" step="1"
                 title="Brush size" value="${Number(this.settings.brushWidth) || 5}">
          <button class="dc-btn" data-act="emoji" title="Emoji missiles">🍿</button>
          <button class="dc-btn dc-jolt" data-act="jolt" title="Send a jolt (Alt+J)">⚡</button>
          <button class="dc-btn dc-dim" data-act="hide" title="Hide toolbar (Alt+H)">✕</button>
        </div>`;
      this.shadow.appendChild(root);

      this.root = root;
      this.canvas = root.querySelector('.dc-canvas');
      this.fx = root.querySelector('.dc-fx');
      this.bar = root.querySelector('.dc-bar');
      this.picker = root.querySelector('.dc-picker');
      this.statusEl = root.querySelector('[data-role="status"]');
      this.range = root.querySelector('.dc-range');
      this.buildSwatches(root.querySelector('.dc-swatches'));
      this.buildPicker();
      this.bindControls();
    }

    buildSwatches(wrap) {
      for (const color of COLORS) {
        const dot = document.createElement('button');
        dot.className = 'dc-swatch';
        dot.dataset.color = color;
        dot.style.background = color;
        dot.title = `Brush colour ${color}`;
        wrap.appendChild(dot);
      }
      this.syncSwatches();
    }

    syncSwatches() {
      for (const dot of this.root.querySelectorAll('.dc-swatch')) {
        dot.classList.toggle('is-on', dot.dataset.color === this.settings.brushColor);
      }
    }

    buildPicker() {
      for (const glyph of NS.EMOJI) {
        const btn = document.createElement('button');
        btn.className = 'dc-emoji';
        btn.textContent = glyph;
        btn.dataset.glyph = glyph;
        this.picker.appendChild(btn);
      }
    }

    bindControls() {
      this.bar.addEventListener('click', (ev) => {
        const swatch = ev.target.closest('.dc-swatch');
        if (swatch) return this.setSettings({ brushColor: swatch.dataset.color });
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (act === 'brush') this.setBrush(!this.brush);
        else if (act === 'emoji') this.picker.hidden = !this.picker.hidden;
        else if (act === 'jolt') this.handlers.onJolt();
        else if (act === 'hide') this.setToolbar(false);
      });
      this.range.addEventListener('input', () =>
        this.setSettings({ brushWidth: Number(this.range.value) }));
      this.picker.addEventListener('click', (ev) => {
        const glyph = ev.target.closest('.dc-emoji')?.dataset.glyph;
        if (glyph) this.handlers.onEmoji(glyph);
      });

      this.canvas.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
      this.canvas.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
      this.canvas.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
      this.canvas.addEventListener('pointercancel', (ev) => this.onPointerUp(ev));
    }

    // ---- geometry ---------------------------------------------------------

    setVideo(video) {
      if (!video) return this;
      this.video = video;
      this.observer?.disconnect();
      this.observer = new ResizeObserver(this.onTrack);
      this.observer.observe(video);
      this.place();
      return this;
    }

    bindTracking() {
      addEventListener('scroll', this.onTrack, { passive: true, capture: true });
      addEventListener('resize', this.onTrack, { passive: true });
      document.addEventListener('fullscreenchange', this.onTrack);
      document.addEventListener('keydown', this.onKey, true);
      this.trackTimer = setInterval(this.onTrack, TRACK_MS);
    }

    /**
     * Keep the host glued to the video box. `position: fixed` is viewport-relative,
     * which is exactly right both windowed and fullscreen — but the host must be a
     * descendant of the fullscreen element to be painted at all, hence the move.
     */
    place() {
      if (!this.host || !this.video) return;
      const parent = document.fullscreenElement || document.documentElement;
      if (this.host.parentElement !== parent) parent.appendChild(this.host);

      const r = this.video.getBoundingClientRect();
      const visible = r.width > 40 && r.height > 40 && r.bottom > 0 && r.top < innerHeight;
      this.host.style.display = visible ? 'block' : 'none';
      if (!visible) return;
      this.host.style.left = `${Math.round(r.left)}px`;
      this.host.style.top = `${Math.round(r.top)}px`;
      this.host.style.width = `${Math.round(r.width)}px`;
      this.host.style.height = `${Math.round(r.height)}px`;
      this.resizeCanvas(r);
    }

    resizeCanvas(rect) {
      const dpr = Math.min(devicePixelRatio || 1, 2); // cap: 4K * 3 dpr is wasted work
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width === w && this.canvas.height === h) return;
      this.canvas.width = w;
      this.canvas.height = h;
      this.requestRender(); // normalised strokes survive the resize unchanged
    }

    // ---- render loop ------------------------------------------------------

    /** Only runs while there is ink on screen; idles at zero cost otherwise. */
    requestRender() {
      if (this.raf) return;
      const loop = () => {
        this.raf = 0;
        if (!this.sketch) return;
        this.sketch.render();
        if (!this.sketch.isEmpty) this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    // ---- local drawing ----------------------------------------------------

    toNorm(ev) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: NS.clamp((ev.clientX - r.left) / (r.width || 1), 0, 1),
        y: NS.clamp((ev.clientY - r.top) / (r.height || 1), 0, 1),
      };
    }

    onPointerDown(ev) {
      if (!this.brush || ev.button !== 0) return;
      ev.preventDefault();
      this.canvas.setPointerCapture(ev.pointerId);
      const { x, y } = this.toNorm(ev);
      const id = NS.shortId(8);
      const style = { color: this.settings.brushColor, width: this.settings.brushWidth };
      this.stroke = { id, pending: [], ...style };
      this.sketch.begin(id, { ...style, x, y });
      this.handlers.onStrokeBegin({ id, ...style, x, y });
      this.requestRender();
    }

    onPointerMove(ev) {
      if (!this.stroke) return;
      ev.preventDefault();
      // Coalesced events give us the full sub-frame path instead of one sample.
      const events = ev.getCoalescedEvents?.().length ? ev.getCoalescedEvents() : [ev];
      const flat = [];
      for (const e of events) {
        const { x, y } = this.toNorm(e);
        flat.push(x, y);
      }
      this.sketch.extend(this.stroke.id, flat);
      this.stroke.pending.push(...flat);
      this.requestRender();
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushStroke(), FLUSH_MS);
    }

    flushStroke() {
      clearTimeout(this.flushTimer);
      this.flushTimer = 0;
      if (!this.stroke?.pending.length) return;
      const flat = this.stroke.pending.splice(0);
      // Round to 4 decimals: sub-pixel precision nobody can see, ~40 % fewer bytes.
      this.handlers.onStrokePoints({
        id: this.stroke.id,
        p: flat.map((n) => Math.round(n * 1e4) / 1e4),
        color: this.stroke.color,
        width: this.stroke.width,
      });
    }

    onPointerUp(ev) {
      if (!this.stroke) return;
      ev.preventDefault();
      this.flushStroke();
      this.sketch.end(this.stroke.id);
      this.handlers.onStrokeEnd({ id: this.stroke.id });
      this.stroke = null;
    }

    handleKey(ev) {
      if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const key = ev.key.toLowerCase();
      if (key === 'd') this.setBrush(!this.brush);
      else if (key === 'j') this.handlers.onJolt();
      else if (key === 'h') this.setToolbar(!this.settings.toolbar);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    }

    // ---- public API -------------------------------------------------------

    setBrush(on) {
      this.brush = !!on;
      this.root.classList.toggle('is-drawing', this.brush);
      this.canvas.style.pointerEvents = this.brush ? 'auto' : 'none';
      this.root.querySelector('[data-act="brush"]').classList.toggle('is-on', this.brush);
      if (!this.brush) this.picker.hidden = true;
      this.handlers.onToolState?.({ brush: this.brush });
    }

    setToolbar(on) {
      this.settings.toolbar = !!on;
      this.bar.hidden = !on;
      if (!on) this.picker.hidden = true;
      this.handlers.onToolState?.({ toolbar: this.settings.toolbar });
    }

    setSettings(patch) {
      Object.assign(this.settings, patch);
      if (patch.fadeMs && this.sketch) this.sketch.fadeMs = patch.fadeMs;
      if (patch.brushWidth && this.range) this.range.value = String(patch.brushWidth);
      if (patch.brushColor) this.syncSwatches();
      if (patch.toolbar !== undefined) this.setToolbar(patch.toolbar);
      this.handlers.onSettings?.(patch);
    }

    /** Status pill doubles as the sync read-out: "synced Δ0.04s". */
    setStatus({ link, drift }) {
      if (!this.statusEl) return;
      const label = {
        connected: 'synced', connecting: 'linking…', waiting: 'waiting for peer',
        failed: 'link failed', idle: 'offline',
      }[link] || link;
      const delta = Number.isFinite(drift) ? ` Δ${Math.abs(drift).toFixed(2)}s` : '';
      this.statusEl.textContent = label + delta;
      this.statusEl.dataset.state = link;
      this.statusEl.classList.toggle('is-wide', Boolean(delta));
    }

    launchEmoji(spec) {
      this.emoji?.launch(spec);
    }

    remoteStrokeBegin(msg) {
      this.sketch.begin(msg.id, msg);
      this.requestRender();
    }

    remoteStrokePoints(msg) {
      this.sketch.extend(msg.id, msg.p || [], { color: msg.color, width: msg.width });
      this.requestRender();
    }

    remoteStrokeEnd(msg) {
      this.sketch.end(msg.id);
      this.requestRender();
    }

    /** Visual half of a jolt; the haptic half rides the bridge socket. */
    shake() {
      if (!this.root) return;
      this.root.classList.remove('is-jolt');
      void this.root.offsetWidth; // force style flush so the animation re-triggers
      this.root.classList.add('is-jolt');
      setTimeout(() => this.root?.classList.remove('is-jolt'), 700);
      navigator.vibrate?.(this.settings.joltPattern);
    }

    unmount() {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.flushTimer);
      clearInterval(this.trackTimer);
      removeEventListener('scroll', this.onTrack, { capture: true });
      removeEventListener('resize', this.onTrack);
      document.removeEventListener('fullscreenchange', this.onTrack);
      document.removeEventListener('keydown', this.onKey, true);
      this.observer?.disconnect();
      this.host?.remove();
      this.raf = this.flushTimer = this.trackTimer = 0;
      this.host = this.shadow = this.root = this.sketch = this.emoji = null;
      this.stroke = null;
    }
  }

  NS.Overlay = Overlay;
  NS.OVERLAY_COLORS = COLORS;
})();
