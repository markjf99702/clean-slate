// Shapes: the ones dragged out with the shapes tool, and the ones a hand-drawn line snaps to when the pen is held
// still at the end of it. No page needed (test/unit.test.mjs runs this in Node).
//
// A shape comes back as { shape, pts }, where pts is a list of [x, y] board points: the two ends of a line or an
// arrow, or the corners of a closed shape (a rectangle's four, a triangle's three, or 72 points around an ellipse).

export const KINDS = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' };

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r1 = v => Math.round(v * 10) / 10;

export function ellipsePoints(cx, cy, rx, ry, rot = 0, n = 72) {
  const c = Math.cos(rot), s = Math.sin(rot), out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n * Math.PI * 2, x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    out.push([r1(cx + x * c - y * s), r1(cy + x * s + y * c)]);
  }
  return out;
}

// A line close to level, upright or diagonal is made exactly so (within a few degrees).
function straighten(a, b, within = 5) {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) > within * Math.PI / 180) return [a, b];
  const len = dist(a, b);
  return [a, [r1(a[0] + Math.cos(snapped) * len), r1(a[1] + Math.sin(snapped) * len)]];
}

// The shapes tool: a drag from (x0, y0) to (x1, y1).
export function dragShape(kind, x0, y0, x1, y1) {
  if (kind === 'line' || kind === 'arrow') return { shape: kind, pts: straighten([x0, y0], [x1, y1]) };
  if (kind === 'ellipse') return { shape: 'closed', pts: ellipsePoints((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2) };
  return { shape: 'closed', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

// ---------- recognising a hand-drawn shape ----------
function length(p) { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; }

// The line as n points evenly spaced along it.
function resample(p, n) {
  const step = length(p) / (n - 1), out = [p[0]];
  let acc = 0, prev = p[0];
  for (let i = 1; i < p.length; i++) {
    let cur = p[i], d = dist(prev, cur);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const q = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
      out.push(q);
      prev = q; d = dist(prev, cur); acc = 0;
    }
    acc += d; prev = cur;
  }
  while (out.length < n) out.push(p[p.length - 1]);
  return out;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

// Douglas-Peucker: the few points that keep the line's shape to within eps.
function simplify(p, eps) {
  if (p.length < 3) return p.slice();
  let worst = 0, at = 0;
  for (let i = 1; i < p.length - 1; i++) { const d = segDist(p[i], p[0], p[p.length - 1]); if (d > worst) { worst = d; at = i; } }
  if (worst <= eps) return [p[0], p[p.length - 1]];
  return [...simplify(p.slice(0, at + 1), eps).slice(0, -1), ...simplify(p.slice(at), eps)];
}

// The corners of a closed loop: simplified, with corners that are hardly corners at all (nearly straight on, or
// right next to another) taken out.
function corners(loop, eps, near) {
  // Start from the point furthest from the middle, which is a corner if there is one.
  const cx = loop.reduce((s, q) => s + q[0], 0) / loop.length, cy = loop.reduce((s, q) => s + q[1], 0) / loop.length;
  let far = 0;
  loop.forEach((q, i) => { if (Math.hypot(q[0] - cx, q[1] - cy) > Math.hypot(loop[far][0] - cx, loop[far][1] - cy)) far = i; });
  const turned = [...loop.slice(far), ...loop.slice(0, far), loop[far]];
  let v = simplify(turned, eps).slice(0, -1);
  for (let changed = true; changed && v.length > 2;) {
    changed = false;
    for (let i = 0; i < v.length; i++) {
      const a = v[(i + v.length - 1) % v.length], b = v[i], c = v[(i + 1) % v.length];
      const ang = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(a[1] - b[1], a[0] - b[0]));
      const turn = Math.min(ang, Math.PI * 2 - ang); // the angle at b: near PI means straight on
      if (turn > Math.PI * 0.86 || dist(a, b) < near) { v.splice(i, 1); changed = true; break; }
    }
  }
  return v;
}

function polygonError(loop, v) {
  let sum = 0;
  for (const q of loop) {
    let best = Infinity;
    for (let i = 0; i < v.length; i++) best = Math.min(best, segDist(q, v[i], v[(i + 1) % v.length]));
    sum += best;
  }
  return sum / loop.length;
}

// A four-cornered shape whose corners are all near right angles, as an exact rectangle (level if it's nearly level).
function rectangle(v, loop) {
  const angs = v.map((a, i) => { const b = v[(i + 1) % 4]; return Math.atan2(b[1] - a[1], b[0] - a[0]); });
  for (let i = 0; i < 4; i++) {
    const d1 = angs[i], d2 = angs[(i + 1) % 4];
    let turn = Math.abs(d2 - d1) % Math.PI;
    if (Math.abs(turn - Math.PI / 2) > 0.33) return null; // about 19 degrees off square
  }
  // The rectangle's direction: the average of its sides' directions, folded into a quarter turn.
  let sx = 0, sy = 0;
  angs.forEach(a => { sx += Math.cos(a * 4); sy += Math.sin(a * 4); });
  let th = Math.atan2(sy, sx) / 4;
  if (Math.abs(th) < 8 * Math.PI / 180) th = 0;
  const c = Math.cos(th), s = Math.sin(th);
  // Each side where most of the drawn edge is: a little in from the furthest points, so a wobble or an overshoot
  // at a corner doesn't stretch it.
  const us = loop.map(q => q[0] * c + q[1] * s).sort((a, b) => a - b);
  const vs = loop.map(q => -q[0] * s + q[1] * c).sort((a, b) => a - b);
  const at = (list, f) => list[Math.min(list.length - 1, Math.max(0, Math.round(f * (list.length - 1))))];
  const u0 = at(us, 0.03), u1 = at(us, 0.97), v0 = at(vs, 0.03), v1 = at(vs, 0.97);
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, w]) => [r1(u * c - w * s), r1(u * s + w * c)]);
}

function ellipse(loop) {
  const n = loop.length;
  const mx = loop.reduce((s, q) => s + q[0], 0) / n, my = loop.reduce((s, q) => s + q[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of loop) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  let th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(th), s = Math.sin(th);
  const us = loop.map(([x, y]) => (x - mx) * c + (y - my) * s), vs = loop.map(([x, y]) => -(x - mx) * s + (y - my) * c);
  const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
  let a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const cx = mx + cu * c - cv * s, cy = my + cu * s + cv * c;
  if (a < 1 || b < 1) return null;
  let err = 0;
  us.forEach((u, i) => { err += Math.abs(Math.hypot((u - cu) / a, (vs[i] - cv) / b) - 1); });
  err /= n;
  // Nearly round is round; nearly level is level.
  if (Math.max(a, b) / Math.min(a, b) < 1.15) { a = b = (a + b) / 2; th = 0; }
  else {
    const q = Math.round(th / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(th - q) < 8 * Math.PI / 180) th = q;
  }
  return { err, pts: ellipsePoints(cx, cy, a, b, th) };
}

// What a hand-drawn line looks like it was meant to be: a straight line, a triangle, a rectangle (or another
// four-cornered shape) or an ellipse, or null if it doesn't look like any of them. xy is [[x, y], …]; anything
// smaller across than minSize is left as it is.
export function recognize(xy, minSize = 12) {
  if (xy.length < 3) return null;
  const xs = xy.map(q => q[0]), ys = xy.map(q => q[1]);
  const D = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (D < minSize) return null;
  const L = length(xy);
  const p = resample(xy, 96);
  const a = p[0], b = p[p.length - 1], chord = dist(a, b);

  // Mostly one way, start to end: a straight line, or nothing.
  if (chord > 0.75 * L) {
    const dev = Math.max(...p.map(q => segDist(q, a, b)));
    return dev < Math.max(0.06 * chord, 2) ? { shape: 'line', pts: straighten(a, b).map(q => q.map(r1)) } : null;
  }
  // Otherwise it has to come back round to where it started.
  if (chord > 0.25 * L && chord > 0.3 * D) return null;
  // Most people overshoot when they close a shape: stop at the point nearest the start, in the last third.
  let end = p.length - 1;
  for (let i = Math.floor(p.length * 2 / 3); i < p.length; i++) if (dist(p[i], a) < dist(p[end], a)) end = i;
  const loop = p.slice(0, end + 1);
  if (loop.length < 12) return null;

  const v = corners(loop, 0.07 * D, 0.14 * D);
  const perr = (v.length === 3 || v.length === 4) ? polygonError(loop, v) / D : Infinity;
  if (v.length === 3 && perr < 0.035) return { shape: 'closed', pts: v.map(q => q.map(r1)) };
  if (v.length === 4 && perr < 0.035) return { shape: 'closed', pts: rectangle(v, loop) || v.map(q => q.map(r1)) };
  const e = ellipse(loop);
  if (e && e.err < 0.11) return { shape: 'closed', pts: e.pts };
  return null;
}
