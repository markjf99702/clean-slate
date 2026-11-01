// The parts that don't need a page: boards merging, the SVG file, and what the eraser touches.  node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBoard, makeStroke, addStrokes, removeStrokes, mergeBoards, contentKey, cleanBoard, untouched, again, nextName, shareable } from '../js/board.js';
import { toSVG, fromSVG } from '../js/svg.js';
import { touches, contentBounds, outline } from '../js/ink.js';

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
