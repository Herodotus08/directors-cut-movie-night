/**
 * Director's Cut — emoji missiles.
 *
 * Pure CSS animation (see overlay.css `@keyframes dc-fly`): the element is handed
 * a few custom properties and the compositor does the rest, so a burst of emoji
 * never steals frames from video decode. The launch parameters travel over the
 * data channel, which makes both screens show the same trajectory.
 */
(() => {
  const NS = globalThis.DirectorsCut;
  const MAX_LIVE = 40; // hard cap: an emoji-spam war must not tank the page

  class EmojiLayer {
    constructor(layer) {
      this.layer = layer;
    }

    /** Build a launch spec locally so it can be mirrored to the peer verbatim. */
    static spec(glyph) {
      return {
        glyph,
        y: 0.12 + Math.random() * 0.7,          // vertical lane, 0..1 of the box
        dur: 2400 + Math.round(Math.random() * 900),
        wob: Math.round(-40 + Math.random() * 80), // px of sine wobble
        rot: Math.round(-25 + Math.random() * 50),
        scale: 0.85 + Math.random() * 0.5,
      };
    }

    launch(spec) {
      if (!spec?.glyph || !this.layer) return;
      while (this.layer.childElementCount >= MAX_LIVE) this.layer.firstElementChild.remove();

      const el = document.createElement('span');
      el.className = 'dc-missile';
      el.textContent = spec.glyph;
      el.style.setProperty('--dc-y', `${NS.clamp(spec.y ?? 0.5, 0, 1) * 100}%`);
      el.style.setProperty('--dc-dur', `${NS.clamp(spec.dur ?? 2600, 600, 8000)}ms`);
      el.style.setProperty('--dc-wob', `${NS.clamp(spec.wob ?? 0, -120, 120)}px`);
      el.style.setProperty('--dc-rot', `${NS.clamp(spec.rot ?? 0, -180, 180)}deg`);
      el.style.setProperty('--dc-scale', String(NS.clamp(spec.scale ?? 1, 0.4, 2.5)));

      const remove = () => el.remove();
      el.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, (spec.dur ?? 2600) + 1200); // safety net if the tab was hidden
      this.layer.appendChild(el);
    }

    clear() {
      if (this.layer) this.layer.replaceChildren();
    }
  }

  NS.EmojiLayer = EmojiLayer;
})();
