// The parts that don't need a page: boards merging, the SVG file, and what the eraser touches.  node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoard, makeStroke, addStrokes, removeStrokes, mergeBoards, contentKey, cleanBoard, untouched, again, nextName, shareable } from '../js/board.js';
import { toSVG, fromSVG } from '../js/svg.js';
import { touches, contentBounds, outline } from '../js/ink.js';
import { recognize, dragShape } from '../js/shapes.js';

const stroke = (x, y, more = {}) => makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [x, y, 0.5, x + 10, y + 5, 0.6, x + 20, y, 0.5], ...more });
const clone = b => JSON.parse(JSON.stringify(b));
const ids = b => b.strokes.map(s => s.id);

test('strokes keep the order they were started in', () => {
  const b = makeBoard('A');
  const s1 = stroke(0, 0), s2 = stroke(10, 10), s3 = stroke(20, 20);
  addStrokes(b, [s1, s3]);
  addStrokes(b, [s2]);
  assert.deepEqual(ids(b), [s1.id, s2.id, s3.id]);
  addStrokes(b, [s2]);
  assert.equal(b.strokes.length, 3, 'the same stroke twice is kept once');
});

test('a stroke taken away stays away, and its copy comes back in its old place', () => {
  const b = makeBoard('A');
  const s1 = stroke(0, 0), s2 = stroke(10, 10), s3 = stroke(20, 20);
  addStrokes(b, [s1, s2, s3]);
  removeStrokes(b, [s2.id]);
  assert.deepEqual(ids(b), [s1.id, s3.id]);
  addStrokes(b, [s2]);
  assert.deepEqual(ids(b), [s1.id, s3.id], 'a removed id is never added back');
  const copy = again(s2);
  addStrokes(b, [copy]);
  assert.deepEqual(ids(b), [s1.id, copy.id, s3.id]);
});

test('two copies merge stroke by stroke', () => {
  const base = makeBoard('Shared');
  const s1 = stroke(0, 0), s2 = stroke(50, 50);
  addStrokes(base, [s1, s2]);
  const a = clone(base), b = clone(base);
  const sa = stroke(100, 0), sb = stroke(0, 100);
  addStrokes(a, [sa]);
  addStrokes(b, [sb]);
  removeStrokes(b, [s1.id]);
  const m1 = mergeBoards(a, b), m2 = mergeBoards(b, a);
  assert.deepEqual(new Set(ids(m1)), new Set([s2.id, sa.id, sb.id]));
  assert.equal(contentKey(m1), contentKey(m2), 'merging is the same either way round');
  assert.equal(contentKey(mergeBoards(m1, a)), contentKey(m1), 'merging again changes nothing');
  assert.ok(m1.gone[s1.id]);
});

test('the later name, colour and lines win', () => {
  const a = makeBoard('Old'), b = clone(a);
  b.name = 'New'; b.nameAt = 2000;
  a.bg = 'slate'; a.bgAt = 3000;
  b.pattern = 'dots'; b.patternAt = 1000;
  const m = mergeBoards(a, b);
  assert.equal(m.name, 'New');
  assert.equal(m.bg, 'slate');
  assert.equal(m.pattern, 'dots');
  assert.equal(contentKey(m), contentKey(mergeBoards(b, a)));
});

test('a board from outside is checked', () => {
  assert.equal(cleanBoard(null), null);
  assert.equal(cleanBoard({ id: 'bad id with spaces' }), null);
  const c = cleanBoard({ id: 'b1', name: '  Notes  ', bg: 'neon', pattern: 'zigzag', strokes: [{ id: 's1', t: 1, tool: 'pen', color: 'mauve', size: 4, pts: [1, 2, 0.5] }, { id: 's2', pts: [1, 2] }, { id: 's3', t: 2, pts: [0, 0, 1] }], gone: { s3: 5 } });
  assert.equal(c.name, 'Notes');
  assert.equal(c.bg, 'white');
  assert.equal(c.pattern, 'grid');
  assert.deepEqual(c.strokes.map(s => s.id), ['s1'], 'broken and removed strokes are dropped');
  assert.equal(c.strokes[0].color, 'ink');
});

test('a fresh board is untouched until something happens to it', () => {
  const b = makeBoard('Board 1');
  assert.ok(untouched(b));
  addStrokes(b, [stroke(0, 0)]);
  assert.ok(!untouched(b));
  assert.equal(nextName([b]), 'Board 2');
  assert.equal(nextName([makeBoard('Board 2')]), 'Board 3');
});

test('the SVG file is a picture with the board inside', () => {
  const b = makeBoard('Fish & <chips>');
  b.pattern = 'lines'; b.patternAt = 5;
  addStrokes(b, [stroke(0, 0), stroke(40, 40, { tool: 'marker', color: 'yellow', size: 20 })]);
  const svg = toSVG(b);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="/);
  assert.match(svg, /<title>Fish &amp; &lt;chips&gt;<\/title>/);
  assert.equal((svg.match(/<path d="M[^"]*Q/g) || []).length, 2, 'one path per stroke');
  assert.match(svg, /mix-blend-mode:multiply/);
  assert.doesNotMatch(svg.split('<metadata')[1].split('</metadata>')[0], /[<&]/, 'nothing in the board reads as markup');
  const back = fromSVG(svg);
  assert.equal(back.name, 'Fish & <chips>');
  assert.equal(contentKey(back), contentKey(b));
  assert.deepEqual(back.strokes[1].pts, b.strokes[1].pts);
  assert.equal(fromSVG('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null, 'any other SVG is not a board');
  assert.equal(fromSVG(JSON.stringify({ cleanSlate: 1, board: shareable(b) })).id, b.id, 'a plain board file opens too');
});

test('the eraser touches a line it crosses, even on a quick swipe', () => {
  const s = makeStroke({ tool: 'pen', color: 'ink', size: 4, sim: 0, pts: [0, 0, 0.5, 100, 0, 0.5] });
  assert.ok(touches(s, 50, 5, 50, 5, 6), 'resting on it');
  assert.ok(!touches(s, 50, 40, 50, 40, 6), 'well clear of it');
  assert.ok(touches(s, 50, -80, 50, 80, 4), 'swiping across it between two events');
  const dot = makeStroke({ tool: 'pen', color: 'ink', size: 6, sim: 0, pts: [10, 10, 0.5] });
  assert.ok(touches(dot, 14, 10, 14, 10, 3), 'a single dot');
  assert.ok(outline(dot).length > 4, 'a dot still has an outline');
});

test('the drawing’s bounds include every stroke and its width', () => {
  const b = makeBoard('A');
  addStrokes(b, [stroke(0, 0), stroke(200, 100)]);
  const c = contentBounds(b.strokes);
  assert.ok(c.x0 < 0 && c.y0 < 0 && c.x1 > 220 && c.y1 > 100);
  assert.equal(contentBounds([]), null);
});

// ---------- shapes and rub-outs ----------
let seed = 5;
const wob = k => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 2 * k; };
const traced = (corners, per = 20, k = 2.5) => {
  const out = [], all = [...corners, corners[0]];
  for (let i = 0; i < corners.length; i++) for (let j = 0; j < per; j++) { const [a, b] = [all[i], all[i + 1]], t = j / per; out.push([a[0] + (b[0] - a[0]) * t + wob(k), a[1] + (b[1] - a[1]) * t + wob(k)]); }
  out.push([corners[0][0] + 3, corners[0][1] + 1]);
  return out;
};
const round = (cx, cy, rx, ry) => Array.from({ length: 80 }, (_, i) => { const t = i / 79 * Math.PI * 2.07; return [cx + Math.cos(t) * rx + wob(3), cy + Math.sin(t) * ry + wob(3)]; });

test('a hand-drawn line, box, triangle or circle is recognised', () => {
  const ln = recognize(Array.from({ length: 30 }, (_, i) => [10 + i * 10 + wob(1), 100 + i * 0.3 + wob(2)]));
  assert.equal(ln.shape, 'line');
  assert.equal(ln.pts[0][1], ln.pts[1][1], 'a nearly level line is made level');
  const box = recognize(traced([[0, 0], [300, 0], [300, 160], [0, 160]]));
  assert.equal(box.shape, 'closed');
  assert.equal(box.pts.length, 4);
  assert.ok(Math.abs(box.pts[1][0] - box.pts[0][0] - 300) < 8 && Math.abs(box.pts[2][1] - box.pts[1][1] - 160) < 8, `the box is the size drawn: ${JSON.stringify(box.pts)}`);
  assert.equal(box.pts[0][1], box.pts[1][1], 'and square to the board');
  assert.equal(recognize(traced([[0, 200], [120, 0], [240, 200]], 25)).pts.length, 3, 'a triangle');
  const circle = recognize(round(200, 200, 100, 96));
  assert.equal(circle.pts.length, 72, 'a circle');
  const r = circle.pts.map(([x, y]) => Math.hypot(x - 200, y - 200));
  assert.ok(Math.max(...r) - Math.min(...r) < 0.5, 'nearly round is made round');
  assert.equal(recognize(round(200, 200, 160, 70)).pts.length, 72, 'an ellipse');
});

test('scribbles, curves and tiny marks are left as drawn', () => {
  assert.equal(recognize(Array.from({ length: 30 }, (_, i) => [10 + i * 10, 100 + Math.sin(i / 5) * 40])), null, 'a curve');
  assert.equal(recognize(Array.from({ length: 60 }, (_, i) => [Math.sin(i * 1.7) * 80 + i * 3, Math.cos(i * 2.3) * 60])), null, 'a scribble');
  assert.equal(recognize(round(10, 10, 3, 3)), null, 'a tiny loop');
});

test('the shapes tool makes exact shapes', () => {
  assert.deepEqual(dragShape('rect', 10, 20, 110, 70).pts, [[10, 20], [110, 20], [110, 70], [10, 70]]);
  assert.equal(dragShape('ellipse', 0, 0, 100, 50).pts.length, 72);
  const arrow = dragShape('arrow', 0, 0, 100, 4);
  assert.equal(arrow.shape, 'arrow');
  assert.deepEqual(arrow.pts[1], [100.1, 0], 'nearly level is level');
});

test('rub-outs and shapes go into the SVG and come back out', () => {
  const b = makeBoard('Blob');
  const fat = stroke(0, 0, { size: 40 });
  const rub = makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [10, 4, 0.5, 12, 5, 0.5] });
  const box = makeStroke({ tool: 'pen', color: 'blue', size: 3, sim: 0, pts: [0, 50, 0.5, 80, 50, 0.5, 80, 90, 0.5, 0, 90, 0.5], shape: 'closed', fill: true });
  const arrow = makeStroke({ tool: 'pen', color: 'red', size: 3, sim: 0, pts: [100, 0, 0.5, 200, 0, 0.5], shape: 'arrow' });
  addStrokes(b, [fat, rub, box, arrow]);
  assert.equal(rub.color, '');
  const svg = toSVG(b);
  assert.match(svg, /<mask id="r0"/, 'a rub-out is a mask');
  assert.match(svg, /<g mask="url\(#r0\)"><path d="M[^"]*Q[^"]*" fill="#1d1d1f"\/><\/g>/, 'over what was drawn before it, and nothing after');
  assert.match(svg, /fill="#1f5ed6" stroke="#1f5ed6" stroke-width="3"/, 'a filled box');
  assert.match(svg, /<path d="M100 0L200 0M[^"]+" fill="none" stroke="#d3302f"/, 'an arrow with its head');
  const back = fromSVG(svg);
  assert.equal(back.strokes[1].tool, 'rub');
  assert.equal(back.strokes[2].shape, 'closed');
  assert.equal(back.strokes[2].fill, 1);
  assert.equal(back.strokes[3].shape, 'arrow');
  assert.equal(contentKey(back), contentKey(b));
});

test('a rub-out or a shape that came back as a plain line from the first version stays what it was', () => {
  const b = makeBoard('A');
  const rub = makeStroke({ tool: 'rub', size: 10, sim: 0, pts: [1, 1, 0.5] });
  const box = makeStroke({ tool: 'pen', color: 'ink', size: 3, sim: 0, pts: [0, 0, 0.5, 9, 0, 0.5, 9, 9, 0.5], shape: 'closed' });
  addStrokes(b, [rub, box]);
  const old = clone(b);
  old.strokes = old.strokes.map(s => { const { shape, ...rest } = s; return { ...rest, tool: 'pen', color: 'ink' }; });
  for (const m of [mergeBoards(b, old), mergeBoards(old, b)]) {
    assert.equal(m.strokes[0].tool, 'rub');
    assert.equal(m.strokes[1].shape, 'closed');
  }
});

test('the eraser touches a filled shape anywhere inside it, and an outline only on its edge', () => {
  const pts = [0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5, 0, 100, 0.5];
  const filled = makeStroke({ tool: 'pen', color: 'ink', size: 3, sim: 0, pts, shape: 'closed', fill: true });
  const outlined = makeStroke({ tool: 'pen', color: 'ink', size: 3, sim: 0, pts, shape: 'closed' });
  assert.ok(touches(filled, 50, 50, 50, 50, 4));
  assert.ok(!touches(outlined, 50, 50, 50, 50, 4));
  assert.ok(touches(outlined, 2, 50, 2, 50, 4), 'the side closing it back to the start counts');
});
