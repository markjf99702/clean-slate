// Clean Slate: a board to draw on with a pen, a finger or a mouse. This file wires the page together: the toolbar,
// the list of boards, the menu, undo, pictures and backups.
import * as store from './store.js';
import { settings, saveSettings } from './store.js';
import { addStrokes, removeStrokes, again, INKS, MARKERS, SIZES, BACKGROUNDS, PATTERNS, shareable, cleanBoard, shade } from './board.js';
import { createSurface } from './surface.js';
import { picture, thumbnail } from './ink.js';
import { toSVG, fromSVG } from './svg.js';
import { KINDS } from './shapes.js';
import { initSync, chip, card, sync, syncState } from './sync.js';
import { $, esc, icon, toast, ago, twoStep, fileName } from './ui.js';

const single = 'single' in document.documentElement.dataset; // the one-file copy (no service worker, no downloads)
let current = '';
const history = new Map(); // board id -> { undo: [], redo: [] }
const hist = id => history.get(id) || history.set(id, { undo: [], redo: [] }).get(id);
const board = () => store.get(current);

await store.init();
current = store.get(settings.board) ? settings.board : newest().id;

const surface = createSurface($('#board'), {
  board,
  settings,
  onBegin: closePop,
  onStroke(s) {
    store.edit(current, b => addStrokes(b, [s]));
    remember({ add: [s] });
  },
  onErase(ids) {
    const b = board();
    const gone = b.strokes.filter(s => ids.includes(s.id));
    store.edit(current, x => removeStrokes(x, ids));
    remember({ remove: gone });
  },
  onView: view => { showZoom(view); keepView(); },
  onUndo: undo,
  onRedo: redo,
  onPenSeen() {
    saveSettings();
    if (settings.fingers === 'auto') toast('Pen found. It draws now, and fingers move the board.', 4200);
    hint();
  },
});
// For the tests and the screenshots.
window.cleanSlate = { store, surface, settings, open: openBoard, current: () => current, sync, syncState };

function newest() { return store.list().sort((a, b) => b.changed - a.changed)[0]; }

// ---------- undo ----------
function remember(step) {
  const h = hist(current);
  h.undo.push(step);
  if (h.undo.length > 300) h.undo.shift();
  h.redo.length = 0;
  tools();
}
// Undoing a removal puts the strokes back as copies (the originals stay removed on every device that saw them go).
function apply(step, backwards) {
  const adding = backwards ? step.remove : step.add;
  const taking = backwards ? step.add : step.remove;
  if (taking) store.edit(current, b => removeStrokes(b, taking.map(s => s.id)));
  if (adding) {
    const copies = adding.map(again);
    store.edit(current, b => addStrokes(b, copies));
    if (backwards) step.remove = copies; else step.add = copies;
  }
}
function undo() {
  const h = hist(current), step = h.undo.pop();
  if (!step) return;
  apply(step, true);
  h.redo.push(step);
  tools();
}
function redo() {
  const h = hist(current), step = h.redo.pop();
  if (!step) return;
  apply(step, false);
  h.undo.push(step);
  tools();
}

// ---------- the toolbar ----------
const TOOLS = [['pen', 'Pen', icon.pen], ['marker', 'Highlighter', icon.marker], ['shape', 'Shapes', icon.rect], ['eraser', 'Eraser', icon.eraser]];
const SIZE_NAMES = ['Fine', 'Medium', 'Bold'];
const ERASER_NAMES = ['Small', 'Medium', 'Large'];
const MODES = { rub: ['Rub out', 'Rubs out just where it touches'], lines: ['Whole lines', 'Takes away every line it touches'] };
const wide = () => !matchMedia('(max-width: 859px)').matches;

function toolbarHTML() {
  return `<div class="group" role="group" aria-label="Tools">${TOOLS.map(([k, label, svg]) => `<button type="button" class="tool" data-tool="${k}" aria-label="${label}" title="${label}">${svg}</button>`).join('')}</div>
    <span class="sep wide"></span><div class="group wide swatches" role="group" aria-label="Colour"></div>
    <span class="sep wide"></span><div class="group wide sizes" role="group" aria-label="Size"></div>
    <span class="sep narrow"></span><button type="button" class="tool style narrow" id="styleBtn" aria-label="Colour and size" aria-haspopup="true"><i></i></button>
    <span class="sep"></span><div class="group" role="group" aria-label="Undo and redo"><button type="button" class="tool" id="undo" aria-label="Undo" title="Undo (two-finger tap)">${icon.undo}</button><button type="button" class="tool" id="redo" aria-label="Redo" title="Redo (three-finger tap)">${icon.redo}</button></div>`;
}
const toolbar = $('#tools');
toolbar.innerHTML = toolbarHTML();
toolbar.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tool) {
    const same = settings.tool === b.dataset.tool;
    setTool(b.dataset.tool);
    // The shapes tool always offers its shapes; a tool tapped again on a narrow screen offers its colours and sizes.
    if (b.dataset.tool === 'shape') { if (same && !pop.hidden) closePop(); else openPop(); }
    else if (same && !wide()) togglePop();
    else closePop();
  } else if (b.dataset.color) { settings[penTool()].color = b.dataset.color; saveSettings(); tools(); }
  else if (b.dataset.size) { settings[sizeTool()].size = +b.dataset.size; saveSettings(); tools(); }
  else if (b.dataset.mode) { settings.eraser.mode = b.dataset.mode; saveSettings(); tools(); }
  else if (b.id === 'styleBtn') togglePop();
  else if (b.id === 'undo') undo();
  else if (b.id === 'redo') redo();
});
const penTool = () => (settings.tool === 'marker' ? 'marker' : 'pen');
const sizeTool = () => (settings.tool === 'eraser' ? 'eraser' : penTool());
function setTool(t) { settings.tool = t; saveSettings(); tools(); surface.redraw(); }

// Colours and sizes for the tool in hand: in the toolbar on a wide screen, in a small pop-up on a narrow one.
// (Shapes take the pen's colour and size. The eraser has its two ways of erasing where the colours would be.)
function modesHTML() {
  return Object.entries(MODES).map(([k, [label, title]]) => `<button type="button" class="mode" data-mode="${k}" title="${title}" aria-pressed="${settings.eraser.mode === k}">${label}</button>`).join('');
}
function kindsHTML() {
  return `<div class="kinds">${Object.entries(KINDS).map(([k, label]) => `<button type="button" class="tool" data-kind="${k}" aria-label="${label}" title="${label}" aria-pressed="${settings.shape.kind === k}">${icon[k]}</button>`).join('')}
    <span class="sep"></span><button type="button" class="tool" data-fill aria-label="Filled" title="Filled rectangles and ellipses" aria-pressed="${settings.shape.fill}">${icon.filled}</button></div>`;
}
function swatchesHTML() {
  if (settings.tool === 'eraser') return modesHTML();
  const set = settings.tool === 'marker' ? MARKERS : INKS, bg = board().bg, mine = settings[penTool()].color;
  return Object.entries(set).map(([k, c]) => `<button type="button" class="swatch" data-color="${k}" aria-label="${c.name}" title="${c.name}" aria-pressed="${k === mine}" style="--c:${shade({ tool: penTool(), color: k }, bg)}"></button>`).join('');
}
function sizesHTML() {
  const t = sizeTool(), names = t === 'eraser' ? ERASER_NAMES : SIZE_NAMES, mine = settings[t].size;
  const dot = i => (t === 'eraser' ? [8, 13, 19] : t === 'marker' ? [7, 11, 16] : [3.5, 6, 10])[i];
  return SIZES[t].map((_, i) => `<button type="button" class="size" data-size="${i}" aria-label="${names[i]}" title="${names[i]}" aria-pressed="${i === mine}"><i style="--d:${dot(i)}px"></i></button>`).join('');
}
function tools() {
  toolbar.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === settings.tool)));
  $('.swatches', toolbar).innerHTML = swatchesHTML();
  toolbar.classList.toggle('erasing', settings.tool === 'eraser');
  $('[data-tool="shape"]', toolbar).innerHTML = icon[settings.shape.kind] || icon.rect;
  $('.sizes', toolbar).innerHTML = sizesHTML();
  const h = hist(current);
  $('#undo').disabled = !h.undo.length;
  $('#redo').disabled = !h.redo.length;
  const style = $('#styleBtn');
  const t = sizeTool();
  style.style.setProperty('--c', settings.tool === 'eraser' ? 'transparent' : shade({ tool: penTool(), color: settings[penTool()].color }, board().bg));
  style.style.setProperty('--d', `${[0.5, 0.72, 1][settings[t].size] * 20}px`);
  style.classList.toggle('erasing', settings.tool === 'eraser');
  if (!pop.hidden) fillPop();
  document.body.dataset.using = settings.tool;
}

const pop = $('#pop');
function fillPop() {
  const shape = settings.tool === 'shape' ? kindsHTML() : '';
  const rest = wide() ? '' : `<div class="swatches${settings.tool === 'eraser' ? ' modes' : ''}">${swatchesHTML()}</div><div class="sizes">${sizesHTML()}</div>`;
  pop.innerHTML = shape + rest;
  if (!pop.innerHTML) closePop();
}
function openPop() { fillPop(); pop.hidden = !pop.innerHTML; }
function togglePop() { if (pop.hidden) openPop(); else closePop(); }
function closePop() { pop.hidden = true; }
pop.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.color) settings[penTool()].color = b.dataset.color;
  if (b.dataset.size) settings[sizeTool()].size = +b.dataset.size;
  if (b.dataset.mode) settings.eraser.mode = b.dataset.mode;
  if (b.dataset.kind) settings.shape.kind = b.dataset.kind;
  if ('fill' in b.dataset) settings.shape.fill = !settings.shape.fill;
  saveSettings();
  tools();
  if (b.dataset.size || (b.dataset.kind && wide())) closePop();
});

// ---------- zoom ----------
const zoomBtn = $('#zoom');
let zoomTimer = 0;
function showZoom(view) {
  const pct = Math.round(view.z * 100);
  zoomBtn.textContent = pct + '%';
  zoomBtn.hidden = pct === 100;
  zoomBtn.classList.add('on');
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => zoomBtn.classList.remove('on'), 1500);
}
zoomBtn.addEventListener('click', () => surface.zoomTo(1));
let viewTimer = 0;
function keepView() { clearTimeout(viewTimer); const id = current; viewTimer = setTimeout(() => store.setView(id, surface.view), 400); }

// ---------- the hint on an empty board ----------
const coarse = matchMedia('(any-pointer: coarse)').matches;
function hint() {
  const el = $('#hint');
  const empty = !board().strokes.length;
  el.hidden = !empty;
  if (el.hidden) return;
  el.innerHTML = coarse
    ? `<b>Draw anywhere.</b> ${settings.penSeen && settings.fingers !== 'draw' ? 'Your pen draws; one finger moves the board.' : 'Use a pen or a finger.'} Two fingers move and zoom. Tap with two fingers to undo.`
    : `<b>Draw anywhere.</b> Scroll to move the board; pinch or Ctrl + scroll to zoom. Space + drag moves it too.`;
}

// ---------- boards ----------
function openBoard(id) {
  if (!store.get(id)) return;
  surface.cancel();
  current = id;
  settings.board = id;
  saveSettings();
  const b = board();
  surface.setView(b.view || { x: 0, y: 0, z: 1 }, true);
  showZoom(surface.view);
  zoomBtn.classList.remove('on');
  $('#boardName').textContent = b.name;
  document.title = `${b.name} · Clean Slate`;
  document.body.dataset.bg = b.bg;
  tools();
  hint();
  if (!menu.hidden) fillMenu();
}

const boardsSheet = $('#boards');
function fillBoards() {
  const list = store.list().sort((a, b) => b.changed - a.changed);
  $('#boardList').innerHTML = list.map(b => `<li${b.id === current ? ' class="here"' : ''}>
      <button type="button" class="open" data-id="${b.id}"><span class="thumb" data-thumb="${b.id}"></span><span class="what"><b>${esc(b.name)}</b><small>${b.strokes.length ? `Changed ${ago(b.changed)}` : 'Empty'}</small></span></button>
      <button type="button" class="del icon-btn" data-del="${b.id}" aria-label="Delete ${esc(b.name)}" title="Delete">${icon.trash}</button></li>`).join('');
  const scale = Math.min(2, devicePixelRatio || 1);
  for (const el of boardsSheet.querySelectorAll('[data-thumb]')) {
    const b = store.get(el.dataset.thumb);
    el.append(thumbnail(b, 88, 62, scale));
  }
  boardsSheet.querySelectorAll('[data-del]').forEach(btn => twoStep(btn, 'Delete?', () => deleteBoard(btn.dataset.del)));
}
function deleteBoard(id) {
  const name = store.get(id)?.name;
  store.remove(id);
  history.delete(id);
  if (!store.list().length) store.create();
  if (id === current) openBoard(newest().id);
  fillBoards();
  toast(`Deleted ${name}.`);
}
$('#boardList').addEventListener('click', e => {
  const b = e.target.closest('button.open');
  if (b) { openBoard(b.dataset.id); closeSheets(); }
});
$('#newBoard').addEventListener('click', () => { const b = store.create(); openBoard(b.id); closeSheets(); });
$('#boardsBtn').addEventListener('click', () => openSheet(boardsSheet));

// ---------- the menu ----------
const menu = $('#menu');
function fillMenu() {
  const b = board();
  $('#nameInput').value = b.name;
  $('#bgs').innerHTML = Object.entries(BACKGROUNDS).map(([k, v]) => `<button type="button" class="chip bgchip" data-bg="${k}" aria-pressed="${b.bg === k}"><i style="background:${v.bg}"></i>${v.name}</button>`).join('');
  $('#patterns').innerHTML = Object.entries(PATTERNS).map(([k, v]) => `<button type="button" class="chip" data-pattern="${k}" aria-pressed="${b.pattern === k}"><i class="pat ${k}"></i>${v}</button>`).join('');
  menu.querySelectorAll('input[name="fingers"]').forEach(r => { r.checked = r.value === settings.fingers; });
  $('#kept').hidden = store.isKept();
}
$('#menuBtn').addEventListener('click', () => { fillMenu(); openSheet(menu); });
$('#nameInput').addEventListener('change', e => {
  const name = e.target.value.trim().slice(0, 80) || board().name;
  if (name !== board().name) store.edit(current, b => { b.name = name; b.nameAt = Date.now(); });
  e.target.value = name;
  $('#boardName').textContent = name;
  document.title = `${name} · Clean Slate`;
});
$('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
menu.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.bg) { store.edit(current, x => { x.bg = b.dataset.bg; x.bgAt = Date.now(); }); document.body.dataset.bg = b.dataset.bg; fillMenu(); tools(); surface.redraw(); }
  if (b.dataset.pattern) { store.edit(current, x => { x.pattern = b.dataset.pattern; x.patternAt = Date.now(); }); fillMenu(); surface.redraw(); }
});
menu.addEventListener('change', e => {
  if (e.target.name === 'fingers') { settings.fingers = e.target.value; saveSettings(); hint(); }
});
twoStep($('#clear'), 'Tap again to clear', () => {
  const b = board();
  if (!b.strokes.length) return;
  const gone = [...b.strokes];
  store.edit(current, x => removeStrokes(x, gone.map(s => s.id)));
  remember({ remove: gone });
  closeSheets();
  toast('Cleared. Undo brings it back.');
});
$('#fit').addEventListener('click', () => { surface.fit(); closeSheets(); });

// Pictures and files.
function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const png = () => new Promise(resolve => picture(board()).toBlob(resolve, 'image/png'));
$('#savePng').addEventListener('click', async () => save(await png(), fileName(board().name) + '.png'));
$('#saveSvg').addEventListener('click', () => save(new Blob([toSVG(board())], { type: 'image/svg+xml' }), fileName(board().name) + '.svg'));
const share = $('#sharePng');
share.hidden = !(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] }));
share.addEventListener('click', async () => {
  const file = new File([await png()], fileName(board().name) + '.png', { type: 'image/png' });
  try { await navigator.share({ files: [file], title: board().name }); } catch { /* cancelled */ }
});
const copy = $('#copyPng');
copy.hidden = !(window.ClipboardItem && navigator.clipboard?.write);
copy.addEventListener('click', async () => {
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]); toast('Picture copied.'); } catch { toast('This browser wouldn’t copy the picture. Download it instead.'); }
});
$('#backup').addEventListener('click', () => {
  const data = JSON.stringify({ cleanSlate: 1, saved: new Date().toISOString(), boards: store.list().map(shareable) });
  save(new Blob([data], { type: 'application/json' }), `Clean Slate backup ${new Date().toISOString().slice(0, 10)}.json`);
});
$('#restore').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let boards = [];
  try {
    const text = await f.text();
    const o = /^\s*</.test(text) ? null : JSON.parse(text);
    if (o?.cleanSlate && Array.isArray(o.boards)) boards = o.boards.map(cleanBoard).filter(Boolean);
    else { const b = fromSVG(text); if (b) boards = [b]; }
  } catch { boards = []; }
  if (!boards.length) { toast('That isn’t a Clean Slate backup or board.'); return; }
  for (const b of boards) store.absorb(b, 'import');
  toast(boards.length === 1 ? `Opened ${boards[0].name}.` : `Opened ${boards.length} boards.`);
  if (boards.length === 1) openBoard(boards[0].id);
  closeSheets();
});
if (single) menu.querySelectorAll('.files').forEach(el => { el.hidden = true; });

// ---------- sheets ----------
const scrim = $('#scrim');
function openSheet(sheet) {
  closePop();
  closeSheets();
  if (sheet === boardsSheet) fillBoards();
  sheet.hidden = false;
  scrim.hidden = false;
  requestAnimationFrame(() => { sheet.classList.add('in'); scrim.classList.add('in'); });
}
function closeSheets() {
  for (const s of [boardsSheet, menu]) { s.classList.remove('in'); s.hidden = true; }
  scrim.classList.remove('in');
  scrim.hidden = true;
}
scrim.addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));

// ---------- keys ----------
const typing = e => e.target.closest?.('input, textarea, [contenteditable]');
document.addEventListener('keydown', e => {
  if (typing(e)) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && (k === '0')) { e.preventDefault(); surface.zoomTo(1); return; }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); surface.zoomBy(1.25); return; }
  if (mod && k === '-') { e.preventDefault(); surface.zoomBy(0.8); return; }
  if (mod || e.altKey) return;
  if (e.key === ' ' && !e.target.closest?.('button, a')) { e.preventDefault(); surface.setSpace(true); document.body.classList.add('panning'); return; }
  if (e.key === 'Escape') { closeSheets(); closePop(); return; }
  if (k === 'p') setTool('pen');
  else if (k === 'h') setTool('marker');
  else if (k === 'e') setTool('eraser');
  else if (k === 's') setTool('shape');
  else if (k === 'f') surface.fit();
  else if (/^[1-6]$/.test(k) && settings.tool !== 'eraser') {
    const keys = Object.keys(settings.tool === 'marker' ? MARKERS : INKS);
    if (keys[+k - 1]) { settings[penTool()].color = keys[+k - 1]; saveSettings(); tools(); }
  } else if (k === '[' || k === ']') {
    const t = sizeTool();
    settings[t].size = Math.max(0, Math.min(2, settings[t].size + (k === ']' ? 1 : -1)));
    saveSettings();
    tools();
  }
});
document.addEventListener('keyup', e => { if (e.key === ' ') { surface.setSpace(false); document.body.classList.remove('panning'); } });

// ---------- changes from elsewhere (Drive, another tab) ----------
store.on(({ id, why }) => {
  if (why === 'removed' || (why === 'sync' && !store.get(id))) {
    if (id === current) { if (!store.list().length) store.create(); openBoard(newest().id); }
    if (!boardsSheet.hidden) fillBoards();
    return;
  }
  if (id === current) {
    if (why === 'sync' || why === 'tab' || why === 'import') {
      const b = board();
      $('#boardName').textContent = b.name;
      document.body.dataset.bg = b.bg;
      tools();
    }
    surface.redraw();
    hint();
  }
  if (!boardsSheet.hidden && why !== 'edit') fillBoards();
});
// Don't let the page scroll or zoom under the board on phones (the toolbar stays put).
document.addEventListener('touchmove', e => { if (e.touches.length > 1 || e.target.closest('#board')) e.preventDefault(); }, { passive: false });

initSync();
chip($('#cloud'));
card($('#drive'));
openBoard(current);
if (!store.isKept()) toast('This browser isn’t keeping boards (a private window?). Download a copy before you close it.', 6000);
document.body.classList.add('ready');

if (!single && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
