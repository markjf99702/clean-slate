// A board and everything that changes it, with no page in sight (so test/unit.test.mjs can run it in Node).
//
// A board is a list of strokes. Each stroke has an id and the time it was started, and strokes are drawn in the
// order they were started. Taking a stroke away (the eraser, undo, Clear) leaves a marker under its id in `gone`, so
// when two copies of the same board meet (two tabs, or this device and Google Drive) they merge stroke by stroke:
// every stroke either side has, minus every stroke either side took away. The name, the colour and the lines each
// carry the time they were last set, and the later one wins.

export const BACKGROUNDS = {
  white: { name: 'White', bg: '#ffffff', line: 'rgba(40, 70, 130, 0.13)', dot: 'rgba(40, 60, 100, 0.30)', dark: false },
  paper: { name: 'Paper', bg: '#fbf5e4', line: 'rgba(130, 95, 40, 0.17)', dot: 'rgba(110, 80, 40, 0.32)', dark: false },
  slate: { name: 'Slate', bg: '#2a3236', line: 'rgba(255, 255, 255, 0.09)', dot: 'rgba(255, 255, 255, 0.22)', dark: true },
};
export const PATTERNS = { blank: 'Blank', grid: 'Grid', lines: 'Lines', dots: 'Dots' };
export const SPACING = 32; // world units between grid lines, ruled lines and dots

// Each colour has a shade for the light boards and one for the slate, so a drawing stays readable when the board
// changes colour. Strokes keep the colour's name, not its shade.
export const INKS = {
  ink: { name: 'Black', light: '#1d1d1f', dark: '#f3f2ec' },
  blue: { name: 'Blue', light: '#1f5ed6', dark: '#8db7ff' },
  red: { name: 'Red', light: '#d3302f', dark: '#ff8f85' },
  green: { name: 'Green', light: '#16804a', dark: '#7fdc9c' },
  orange: { name: 'Orange', light: '#df7400', dark: '#ffc164' },
  purple: { name: 'Purple', light: '#7a3cc4', dark: '#cca6ff' },
};
// Highlighters multiply on the light boards (so ink under them stays black) and are see-through on the slate.
export const MARKERS = {
  yellow: { name: 'Yellow', light: '#ffe838', dark: '#fff176' },
  green: { name: 'Green', light: '#a6f0a0', dark: '#8cf08a' },
  blue: { name: 'Blue', light: '#a5d8ff', dark: '#8fd0ff' },
  pink: { name: 'Pink', light: '#ffb0dc', dark: '#ff9fd6' },
  orange: { name: 'Orange', light: '#ffc98a', dark: '#ffb870' },
};
export const SIZES = { pen: [2, 4, 8], marker: [12, 20, 32], eraser: [14, 30, 64] };
// Stroke kinds: a pen line, a highlighter line, or a rub-out (an eraser line, which clears whatever was drawn before
// it where it passes). A pen or highlighter line can also be a shape: `shape` is 'line', 'arrow' or 'closed' (a
// rectangle, ellipse or triangle, as its corners or as many points around it), and a closed one can be `fill`ed.
export const SHAPES = ['line', 'arrow', 'closed'];

export const shade = (stroke, bg) => {
  if (stroke.tool === 'rub') return BACKGROUNDS[bg]?.bg || '#fff';
  const set = stroke.tool === 'marker' ? MARKERS : INKS;
  const c = set[stroke.color] || Object.values(set)[0];
  return BACKGROUNDS[bg]?.dark ? c.dark : c.light;
};

const rand = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
export const newId = prefix => prefix + Date.now().toString(36) + rand();

let lastT = 0;
// Start times are unique on this device, so strokes started in the same millisecond keep their order.
export const stamp = () => (lastT = Math.max(Date.now(), lastT + 1));

export function makeBoard(name = 'Board', now = Date.now()) {
  return {
    id: newId('b'), name, nameAt: 0, bg: 'white', bgAt: 0, pattern: 'grid', patternAt: 0,
    created: now, changed: now, rev: 0, strokes: [], gone: {},
  };
}

// A stroke as it's kept: points flattened to [x, y, pressure, x, y, pressure, …], rounded so a board stays small.
export function makeStroke({ tool, color, size, pts, sim, shape, fill }, t = stamp()) {
  const flat = [];
  for (let i = 0; i < pts.length; i += 3) flat.push(round(pts[i], 10), round(pts[i + 1], 10), round(pts[i + 2], 100));
  const s = { id: newId('s'), t, tool, color: tool === 'rub' ? '' : color, size: round(size, 100), sim: sim ? 1 : 0, pts: flat };
  if (shape && tool !== 'rub') { s.shape = shape; if (fill && shape === 'closed') s.fill = 1; }
  return s;
}
const round = (v, k) => Math.round(v * k) / k;

const byTime = (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The same stroke again under a new id, for undoing a removal: the old id stays taken away everywhere, and the copy
// keeps its start time, so it goes back to the same place in the drawing order.
export const again = s => ({ ...s, id: newId('s') });

export function addStrokes(board, strokes) {
  const have = new Set(board.strokes.map(s => s.id));
  let late = false;
  for (const s of strokes) {
    if (have.has(s.id) || board.gone[s.id]) continue;
    if (board.strokes.length && byTime(s, board.strokes[board.strokes.length - 1]) < 0) late = true;
    board.strokes.push(s);
  }
  if (late) board.strokes.sort(byTime);
  return board;
}

export function removeStrokes(board, ids, now = Date.now()) {
  const out = new Set(ids);
  if (!out.size) return board;
  for (const id of out) board.gone[id] = now;
  board.strokes = board.strokes.filter(s => !out.has(s.id));
  return board;
}

const richer = s => s.tool === 'rub' || !!s.shape;

// Which of two settings wins: the one set later; on a tie, the same one on every device.
function later(a, b, key) {
  const at = key + 'At';
  if ((a[at] || 0) !== (b[at] || 0)) return (a[at] || 0) > (b[at] || 0) ? a : b;
  return String(a[key]) >= String(b[key]) ? a : b;
}

// Both copies of one board, as one. Neither copy is changed. `rev` and `view` are this device's own and come from a.
export function mergeBoards(a, b) {
  const gone = { ...a.gone };
  for (const [id, t] of Object.entries(b.gone || {})) gone[id] = Math.max(gone[id] || 0, t);
  const seen = new Map();
  for (const s of [...a.strokes, ...b.strokes]) {
    if (gone[s.id]) continue;
    const had = seen.get(s.id);
    // The first version of Clean Slate didn't know rub-outs or shapes and kept them as plain pen lines. If one of
    // those copies comes back, the stroke as it was made wins.
    if (!had || (!richer(had) && richer(s))) seen.set(s.id, s);
  }
  const n = later(a, b, 'name'), g = later(a, b, 'bg'), p = later(a, b, 'pattern');
  return {
    ...a,
    name: n.name, nameAt: n.nameAt || 0,
    bg: g.bg, bgAt: g.bgAt || 0,
    pattern: p.pattern, patternAt: p.patternAt || 0,
    created: Math.min(a.created || Infinity, b.created || Infinity),
    changed: Math.max(a.changed || 0, b.changed || 0),
    strokes: [...seen.values()].sort(byTime),
    gone,
  };
}

// A short string that's the same for two copies with the same drawing, name and settings.
export function contentKey(b) {
  let h = 0x811c9dc5;
  const mix = str => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
  mix(`${b.name}|${b.nameAt}|${b.bg}|${b.bgAt}|${b.pattern}|${b.patternAt}|`);
  for (const s of b.strokes) mix(s.id + ',');
  mix('|');
  for (const id of Object.keys(b.gone).sort()) mix(id + ',');
  return `${b.strokes.length}.${Object.keys(b.gone).length}.${(h >>> 0).toString(36)}`;
}

// A board that has never been drawn on or set up: there's no point keeping a copy of it anywhere else.
export const untouched = b => !b.strokes.length && !Object.keys(b.gone).length && !b.nameAt && !b.bgAt && !b.patternAt;

// A board that came from outside this page (Drive, a backup file), checked and tidied, or null if it isn't one.
export function cleanBoard(o) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !/^[\w-]{1,64}$/.test(o.id)) return null;
  const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
  const strokes = [];
  for (const s of Array.isArray(o.strokes) ? o.strokes : []) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.pts) || !s.pts.length || s.pts.length % 3) continue;
    const tool = s.tool === 'marker' || s.tool === 'rub' ? s.tool : 'pen';
    const set = tool === 'marker' ? MARKERS : INKS;
    const pts = s.pts.map(v => num(v));
    const c = { id: s.id.slice(0, 64), t: num(s.t), tool, color: tool === 'rub' ? '' : set[s.color] ? s.color : Object.keys(set)[0], size: Math.max(0.1, Math.min(500, num(s.size, 4))), sim: s.sim ? 1 : 0, pts };
    if (tool !== 'rub' && SHAPES.includes(s.shape)) { c.shape = s.shape; if (s.fill && s.shape === 'closed') c.fill = 1; }
    strokes.push(c);
  }
  const gone = {};
  if (o.gone && typeof o.gone === 'object') for (const [id, t] of Object.entries(o.gone)) gone[id.slice(0, 64)] = num(t, 1);
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 80) : 'Board',
    nameAt: num(o.nameAt), bg: BACKGROUNDS[o.bg] ? o.bg : 'white', bgAt: num(o.bgAt),
    pattern: PATTERNS[o.pattern] ? o.pattern : 'grid', patternAt: num(o.patternAt),
    created: num(o.created, Date.now()), changed: num(o.changed, num(o.created, Date.now())),
    rev: 0, strokes: [...new Map(strokes.filter(s => !gone[s.id]).map(s => [s.id, s])).values()].sort(byTime), gone,
  };
}

// What goes into a file: the board without this device's own bits.
export const shareable = b => ({
  id: b.id, name: b.name, nameAt: b.nameAt, bg: b.bg, bgAt: b.bgAt, pattern: b.pattern, patternAt: b.patternAt,
  created: b.created, changed: b.changed, strokes: b.strokes, gone: b.gone,
});

// The next free "Board 3"-style name.
export function nextName(boards) {
  const used = new Set(boards.map(b => b.name));
  for (let i = boards.length + 1; ; i++) if (!used.has(`Board ${i}`)) return `Board ${i}`;
}
