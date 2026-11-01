// How strokes look, where they are, and what the eraser touches. Drawing on a canvas is here too, for the board on
// screen, its picture and the thumbnails, so all three come out the same.
import { getStroke } from './vendor/perfect-freehand.js';
import { BACKGROUNDS, SPACING, shade } from './board.js';

// perfect-freehand turns the points into the outline of a pen line: wider where the pen pressed harder. A finger or
// a mouse has no pressure, so their lines get it from speed instead (sim). A highlighter is the same width all along.
function options(s, last) {
  if (s.tool === 'marker') return { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last };
  return {
    size: s.size, thinning: s.sim ? 0.45 : 0.6, smoothing: 0.55, streamline: s.sim ? 0.5 : 0.35,
    simulatePressure: !!s.sim, last, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 },
  };
}

function triples(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

export const outline = (s, last = true) => getStroke(triples(s.pts), options(s, last));

const paths = new WeakMap(), boxes = new WeakMap();

// The outline as a canvas path, made once per stroke (a stroke never changes once it's made).
export function path(s) {
  let p = paths.get(s);
  if (!p) { p = toPath2D(outline(s)); paths.set(s, p); }
  return p;
}
export function toPath2D(poly) {
  const p = new Path2D();
  if (!poly.length) return p;
  p.moveTo(poly[0][0], poly[0][1]);
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}
// The same outline as SVG path data.
export function pathData(poly) {
  if (!poly.length) return '';
  const f = n => Math.round(n * 10) / 10;
  let d = `M${f(poly[0][0])} ${f(poly[0][1])}Q`;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    d += `${f(x0)} ${f(y0)} ${f((x0 + x1) / 2)} ${f((y0 + y1) / 2)} `;
  }
  return d.trimEnd() + 'Z';
}

// The box a stroke fits in, with room for its width.
export function bounds(s) {
  let b = boxes.get(s);
  if (!b) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const r = s.size * 0.8 + 1;
    b = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
    boxes.set(s, b);
  }
  return b;
}

// Everything drawn on a board, or null for an empty one.
export function contentBounds(strokes) {
  if (!strokes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const b = bounds(s);
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
  }
  return { x0, y0, x1, y1 };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return x * x + y * y;
}

// Does the eraser, moving from (ax, ay) to (bx, by) with radius r, touch this stroke?
export function touches(s, ax, ay, bx, by, r) {
  const b = bounds(s);
  if (Math.max(ax, bx) + r < b.x0 || Math.min(ax, bx) - r > b.x1 || Math.max(ay, by) + r < b.y0 || Math.min(ay, by) - r > b.y1) return false;
  const reach = r + s.size * (s.tool === 'marker' ? 0.5 : 0.6);
  const reach2 = reach * reach;
  // Steps along the eraser's move, each no longer than half the eraser, so a quick swipe misses nothing in between.
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r / 2)));
  const p = s.pts;
  for (let k = 0; k <= steps; k++) {
    const ex = ax + (bx - ax) * k / steps, ey = ay + (by - ay) * k / steps;
    if (p.length === 3) { if ((p[0] - ex) ** 2 + (p[1] - ey) ** 2 <= reach2) return true; continue; }
    for (let i = 0; i + 5 < p.length; i += 3) if (segDist2(ex, ey, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach2) return true;
  }
  return false;
}

// ---------- drawing on a canvas ----------
// A view is where the board sits on screen: (x, y) is the board point at the top-left corner and z the zoom, so a
// board point (bx, by) is on screen at ((bx - x) * z, (by - y) * z).

// The colour and lines, in screen space, crisp at any zoom. w and h are in CSS pixels; the context is scaled to them.
export function drawBackground(ctx, board, view, w, h) {
  const look = BACKGROUNDS[board.bg] || BACKGROUNDS.white;
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, 0, w, h);
  if (board.pattern === 'blank') return;
  let step = SPACING;
  while (step * view.z < 12) step *= 2; // zoomed far out, every other line, so the board doesn't go solid
  const px = step * view.z;
  const first = v => Math.ceil(v / step) * step;
  const sx = bx => (bx - view.x) * view.z, sy = by => (by - view.y) * view.z;
  const hair = 1 / (ctx.getTransform().a || 1); // one device pixel
  const crisp = v => Math.round(v / hair) * hair + hair / 2;
  if (board.pattern === 'dots') {
    ctx.fillStyle = look.dot;
    const r = Math.max(0.9, Math.min(2.2, 1.3 * Math.sqrt(view.z)));
    for (let by = first(view.y); sy(by) < h + px; by += step) {
      for (let bx = first(view.x); sx(bx) < w + px; bx += step) {
        ctx.beginPath(); ctx.arc(sx(bx), sy(by), r, 0, Math.PI * 2); ctx.fill();
      }
    }
    return;
  }
  ctx.strokeStyle = look.line;
  ctx.lineWidth = hair * Math.max(1, Math.min(2, Math.round(view.z)));
  ctx.beginPath();
  for (let by = first(view.y); sy(by) < h + 1; by += step) { const y = crisp(sy(by)); ctx.moveTo(0, y); ctx.lineTo(w, y); }
  if (board.pattern === 'grid') {
    for (let bx = first(view.x); sx(bx) < w + 1; bx += step) { const x = crisp(sx(bx)); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  }
  ctx.stroke();
}

// How a highlighter goes down: multiplied into the light boards, see-through on the slate.
export function markerMode(bg) { return BACKGROUNDS[bg]?.dark ? { op: 'source-over', alpha: 0.42 } : { op: 'multiply', alpha: 1 }; }

// Strokes, in board space. scale is device pixels per CSS pixel.
export function drawStrokes(ctx, strokes, bg, view, w, h, scale) {
  const x0 = view.x, y0 = view.y, x1 = view.x + w / view.z, y1 = view.y + h / view.z;
  ctx.save();
  ctx.setTransform(scale * view.z, 0, 0, scale * view.z, -view.x * view.z * scale, -view.y * view.z * scale);
  const m = markerMode(bg);
  for (const s of strokes) {
    const b = bounds(s);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    if (s.tool === 'marker') { ctx.globalCompositeOperation = m.op; ctx.globalAlpha = m.alpha; }
    else { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
    ctx.fillStyle = shade(s, bg);
    ctx.fill(path(s));
  }
  ctx.restore();
}

// The view that fits everything drawn (or an empty stretch of board) into w x h, with a margin around it.
export function fitView(board, w, h, margin = 24, maxZoom = 1) {
  const c = contentBounds(board.strokes) || { x0: 0, y0: 0, x1: w, y1: h };
  const cw = Math.max(1, c.x1 - c.x0), ch = Math.max(1, c.y1 - c.y0);
  const z = Math.min(maxZoom, (w - 2 * margin) / cw, (h - 2 * margin) / ch);
  return { x: (c.x0 + c.x1) / 2 - w / 2 / z, y: (c.y0 + c.y1) / 2 - h / 2 / z, z };
}

// The whole board as a picture on a new canvas: everything drawn, with a margin of board around it, at up to two
// pixels per board unit, and never past `max` pixels on a side (phones refuse very big canvases).
export function picture(board, { max = 4096, margin = 40 } = {}) {
  const c = contentBounds(board.strokes) || { x0: 0, y0: 0, x1: 800, y1: 600 };
  const w = c.x1 - c.x0 + 2 * margin, h = c.y1 - c.y0 + 2 * margin;
  const k = Math.min(2, max / w, max / h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  const view = { x: c.x0 - margin, y: c.y0 - margin, z: 1 };
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawBackground(ctx, board, view, w, h);
  drawStrokes(ctx, board.strokes, board.bg, view, w, h, k);
  return canvas;
}

// A small picture for the list of boards.
export function thumbnail(board, w, h, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  const view = fitView(board, w, h, 6, 0.6);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawBackground(ctx, { ...board, pattern: view.z < 0.25 ? 'blank' : board.pattern }, view, w, h);
  drawStrokes(ctx, board.strokes, board.bg, view, w, h, scale);
  return canvas;
}
