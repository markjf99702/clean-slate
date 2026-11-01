// How strokes look, where they are, and what the eraser touches. Drawing on a canvas is here too, for the board on
// screen, its picture and the thumbnails, so all three come out the same.
import { getStroke } from './vendor/perfect-freehand.js';
import { BACKGROUNDS, SPACING, shade } from './board.js';

// perfect-freehand turns the points into the outline of a pen line: wider where the pen pressed harder. A finger or
// a mouse has no pressure, so their lines get it from speed instead (sim). A highlighter is the same width all along.
function options(s, last) {
  if (s.tool === 'rub') return { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.35, simulatePressure: false, last };
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

// A shape is drawn as clean lines through its points, not as a pen outline: its corners, closed back to the first
// for a rectangle, triangle or ellipse, and with a head on the end of an arrow.
export const headLength = s => Math.max(14, s.size * 3.2);
export function shapeLines(s) {
  const pts = triples(s.pts).map(([x, y]) => [x, y]);
  const lines = [pts];
  if (s.shape === 'arrow' && pts.length >= 2) {
    const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = headLength(s);
    lines.push([[b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)], b, [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)]]);
  }
  return lines;
}

const paths = new WeakMap(), boxes = new WeakMap();

// The stroke as a canvas path, made once per stroke (a stroke never changes once it's made).
export function path(s) {
  let p = paths.get(s);
  if (!p) {
    if (s.shape) {
      p = new Path2D();
      shapeLines(s).forEach((line, i) => {
        line.forEach(([x, y], j) => (j ? p.lineTo(x, y) : p.moveTo(x, y)));
        if (i === 0 && s.shape === 'closed') p.closePath();
      });
    } else p = toPath2D(outline(s));
    paths.set(s, p);
  }
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
    const r = (s.shape === 'arrow' ? headLength(s) : 0) + s.size * 0.8 + 1;
    b = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
    boxes.set(s, b);
  }
  return b;
}

// Everything drawn on a board, or null for an empty one.
export function contentBounds(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    if (s.tool === 'rub') continue; // rubbing out where nothing is drawn doesn't make the drawing bigger
    const b = bounds(s);
    if (b.x0 < x0) x0 = b.x0; if (b.y0 < y0) y0 = b.y0; if (b.x1 > x1) x1 = b.x1; if (b.y1 > y1) y1 = b.y1;
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
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
  const reach = r + s.size * (s.tool === 'marker' || s.shape ? 0.5 : 0.6);
  const reach2 = reach * reach;
  // Steps along the eraser's move, each no longer than half the eraser, so a quick swipe misses nothing in between.
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, r / 2)));
  const lines = s.shape ? shapeLines(s) : [triples(s.pts)];
  if (s.shape === 'closed') lines[0] = [...lines[0], lines[0][0]];
  for (let k = 0; k <= steps; k++) {
    const ex = ax + (bx - ax) * k / steps, ey = ay + (by - ay) * k / steps;
    for (const p of lines) {
      if (p.length === 1) { if ((p[0][0] - ex) ** 2 + (p[0][1] - ey) ** 2 <= reach2) return true; continue; }
      for (let i = 0; i + 1 < p.length; i++) if (segDist2(ex, ey, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]) <= reach2) return true;
    }
    if (s.fill && inside(lines[0], ex, ey)) return true;
  }
  return false;
}
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
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

// One stroke, in board space, on a context already set up for it.
export function drawStroke(ctx, s, bg, m = markerMode(bg)) {
  if (s.tool === 'rub') { ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1; }
  else if (s.tool === 'marker') { ctx.globalCompositeOperation = m.op; ctx.globalAlpha = m.alpha; }
  else { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; }
  const color = s.tool === 'rub' ? '#000' : shade(s, bg);
  if (s.shape) {
    ctx.lineWidth = s.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    if (s.fill) { ctx.fillStyle = color; ctx.fill(path(s)); }
    ctx.stroke(path(s));
  } else {
    ctx.fillStyle = color;
    ctx.fill(path(s));
  }
}

// Strokes, in board space. scale is device pixels per CSS pixel.
export function drawStrokes(ctx, strokes, bg, view, w, h, scale) {
  const x0 = view.x, y0 = view.y, x1 = view.x + w / view.z, y1 = view.y + h / view.z;
  ctx.save();
  ctx.setTransform(scale * view.z, 0, 0, scale * view.z, -view.x * view.z * scale, -view.y * view.z * scale);
  const m = markerMode(bg);
  for (const s of strokes) {
    const b = bounds(s);
    if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1) continue;
    drawStroke(ctx, s, bg, m);
  }
  ctx.restore();
}

// The ink goes on its own transparent layer, so a rub-out clears the ink and leaves the board's colour and lines.
// The layer then goes onto the board multiplied (on the light boards, so highlighters stay see-through over the
// lines) or laid on top (on the slate).
export function layerFor(canvas, layer) {
  const L = layer || document.createElement('canvas');
  if (L.width !== canvas.width || L.height !== canvas.height) { L.width = canvas.width; L.height = canvas.height; }
  return L;
}
export function inkLayer(L, strokes, bg, view, w, h, scale) {
  const lc = L.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = 'source-over';
  lc.globalAlpha = 1;
  lc.clearRect(0, 0, L.width, L.height);
  drawStrokes(lc, strokes, bg, view, w, h, scale);
  return L;
}
export function laydown(ctx, L, bg) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = BACKGROUNDS[bg]?.dark ? 'source-over' : 'multiply';
  ctx.drawImage(L, 0, 0);
  ctx.restore();
}
// The board and its drawing, on ctx (whose transform scales CSS pixels to its own).
export function drawBoard(ctx, board, view, w, h, scale, strokes = board.strokes, layer = null) {
  drawBackground(ctx, board, view, w, h);
  const L = inkLayer(layerFor(ctx.canvas, layer), strokes, board.bg, view, w, h, scale);
  laydown(ctx, L, board.bg);
  return L;
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
  drawBoard(ctx, board, view, w, h, k);
  return canvas;
}

// A small picture for the list of boards.
let thumbLayer = null;
export function thumbnail(board, w, h, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  const view = fitView(board, w, h, 6, 0.6);
  thumbLayer ||= document.createElement('canvas');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawBoard(ctx, { ...board, pattern: view.z < 0.25 ? 'blank' : board.pattern }, view, w, h, scale, board.strokes, thumbLayer);
  return canvas;
}
