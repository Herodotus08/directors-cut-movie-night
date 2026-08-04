/**
 * Director's Cut — shared sketchpad model + renderer.
 *
 * Strokes are stored in *normalised* coordinates (0..1 of the video box) so two
 * peers with different window sizes, zoom levels or letterboxing still see the
 * same drawing over the same pixels of the film.
 *
 * Every point carries its own birth timestamp, so a stroke dissolves from tail
 * to head instead of vanishing as a block: full opacity for the first 55 % of
 * the lifetime, then eased to zero at `fadeMs` (3 s by default).
 */
(() => {
  const NS = globalThis.DirectorsCut;
  const REF_HEIGHT = 720; // brush widths are authored against a 720p-tall box

  class Sketchpad {
    constructor(canvas, { fadeMs = NS.DEFAULTS.fadeMs } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.fadeMs = fadeMs;
      this.strokes = new Map();
    }

    get isEmpty() {
      return this.strokes.size === 0;
    }

    /** @param {{color:string,width:number,x:number,y:number,at?:number}} spec */
    begin(id, spec) {
      const at = spec.at || NS.now();
      this.strokes.set(id, {
        color: spec.color || NS.DEFAULTS.brushColor,
        width: spec.width || NS.DEFAULTS.brushWidth,
        open: true,
        pts: [{ x: spec.x, y: spec.y, t: at }],
      });
    }

    /**
     * Append points. `flat` is [x0,y0,x1,y1,...] to keep the wire small.
     * Points may arrive before their stroke-begin (the fx channel is unordered),
     * so an unknown id auto-creates a stroke with the supplied style.
     */
    extend(id, flat, style) {
      let stroke = this.strokes.get(id);
      if (!stroke) {
        if (!flat.length) return;
        this.begin(id, { ...style, x: flat[0], y: flat[1] });
        stroke = this.strokes.get(id);
      }
      const at = NS.now();
      for (let i = 0; i + 1 < flat.length; i += 2) {
        stroke.pts.push({ x: flat[i], y: flat[i + 1], t: at });
      }
    }

    end(id) {
      const stroke = this.strokes.get(id);
      if (stroke) stroke.open = false;
    }

    clear() {
      this.strokes.clear();
    }

    /** 1 while fresh, eased to 0 at `fadeMs`. */
    alphaFor(age) {
      const hold = this.fadeMs * 0.55;
      if (age <= hold) return 1;
      if (age >= this.fadeMs) return 0;
      const t = (age - hold) / (this.fadeMs - hold);
      return Math.pow(1 - t, 1.6);
    }

    /** Drops expired geometry so memory stays bounded during long sessions. */
    prune(now) {
      for (const [id, stroke] of this.strokes) {
        const pts = stroke.pts;
        while (pts.length > 1 && now - pts[1].t > this.fadeMs) pts.shift();
        if (pts.length === 1 && !stroke.open && now - pts[0].t > this.fadeMs) {
          this.strokes.delete(id);
        }
      }
    }

    render(now = NS.now()) {
      const { ctx, canvas } = this;
      const W = canvas.width;
      const H = canvas.height;
      this.prune(now);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const stroke of this.strokes.values()) {
        const lineWidth = Math.max(1, (stroke.width * H) / REF_HEIGHT);
        ctx.strokeStyle = stroke.color;
        ctx.fillStyle = stroke.color;
        ctx.lineWidth = lineWidth;
        ctx.shadowColor = stroke.color;
        ctx.shadowBlur = lineWidth * 1.1;
        const pts = stroke.pts;

        if (pts.length === 1) {
          const alpha = this.alphaFor(now - pts[0].t);
          if (alpha > 0.01) {
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(pts[0].x * W, pts[0].y * H, lineWidth / 2, 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }
        // Per-segment alpha: the tail of a long stroke is already fading while
        // the head is still being drawn.
        for (let i = 1; i < pts.length; i++) {
          const alpha = this.alphaFor(now - pts[i].t);
          if (alpha <= 0.01) continue;
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.moveTo(pts[i - 1].x * W, pts[i - 1].y * H);
          ctx.lineTo(pts[i].x * W, pts[i].y * H);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  }

  NS.Sketchpad = Sketchpad;
})();
