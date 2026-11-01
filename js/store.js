// Where boards are kept on this device: in memory while the page is open, and in IndexedDB (in this browser, on this
// device) a moment after every change. Settings, like the pen colour, are in localStorage.
// Every board change goes through here, so the page, the other tabs and Google Drive saving all hear about it.
import { makeBoard, mergeBoards, nextName, cleanBoard } from './board.js';

const DB = 'clean-slate', STORE = 'boards';
const KSET = 'clean-slate.settings';

const boards = new Map();
const listeners = new Set();
let db = null, kept = true;
const writing = new Map(); // id -> { busy, again }

export const settingsDefaults = () => ({
  board: '', tool: 'pen', fingers: 'auto', penSeen: false,
  pen: { color: 'ink', size: 1 }, marker: { color: 'yellow', size: 1 }, eraser: { size: 1, mode: 'rub' },
  shape: { kind: 'rect', fill: false },
});
function readSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(KSET) || '{}');
    const d = settingsDefaults();
    return { ...d, ...s, pen: { ...d.pen, ...s.pen }, marker: { ...d.marker, ...s.marker }, eraser: { ...d.eraser, ...s.eraser }, shape: { ...d.shape, ...s.shape } };
  } catch { return settingsDefaults(); }
}
export const settings = readSettings();
export function saveSettings() { try { localStorage.setItem(KSET, JSON.stringify(settings)); } catch { /* storage blocked */ } }

function open() {
  return new Promise(resolve => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
function all() {
  return new Promise(resolve => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}
function one(id) {
  return new Promise(resolve => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).get(id);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// Writes go in a moment after a change, so a burst of changes is one write (a big board takes a while to copy).
// Leaving the page writes whatever is waiting straight away.
const soon = new Map();
function persist(id) {
  if (!db || soon.has(id)) return;
  soon.set(id, setTimeout(() => { soon.delete(id); write(id); }, 250));
}
function writeWaiting() { for (const [id, t] of soon) { clearTimeout(t); soon.delete(id); write(id); } }
addEventListener('pagehide', writeWaiting);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeWaiting(); });

// Writes one board, never two of the same board at once; changes made meanwhile go in with the next write.
function write(id) {
  const w = writing.get(id) || { busy: false, again: false };
  writing.set(id, w);
  if (w.busy) { w.again = true; return; }
  w.busy = true;
  const done = ok => {
    w.busy = false;
    if (!ok) kept = false;
    if (w.again) { w.again = false; write(id); } else writing.delete(id);
    if (ok) channel?.postMessage({ id });
  };
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const b = boards.get(id);
    if (b) tx.objectStore(STORE).put(b); else tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => done(true);
    tx.onerror = tx.onabort = () => done(false);
  } catch { done(false); }
}

// Changes from this page's other tabs: take their copy in (stroke by stroke, so nothing drawn here is lost).
let channel = null;
async function heard(id) {
  const saved = await one(id);
  const here = boards.get(id);
  if (!saved) { if (here) { boards.delete(id); emit({ id, why: 'removed' }); } return; }
  const b = here ? { ...mergeBoards(here, saved), rev: Math.max(here.rev, saved.rev || 0), view: here.view } : saved;
  boards.set(id, b);
  emit({ id, why: 'tab' });
}

export async function init() {
  db = await open();
  if (!db) kept = false;
  if (db) for (const b of await all()) { const c = cleanBoard(b); if (c) boards.set(c.id, { ...c, rev: b.rev || 0, view: b.view }); }
  try { channel = new BroadcastChannel(DB); channel.onmessage = e => e.data?.id && heard(e.data.id); } catch { channel = null; }
  if (!boards.size) create();
}

export const isKept = () => kept;
export const list = () => [...boards.values()];
export const get = id => boards.get(id) || null;

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { for (const f of listeners) { try { f(e); } catch (err) { console.error(err); } } }

export function create(name) {
  const b = makeBoard(name || nextName(list()));
  boards.set(b.id, b);
  persist(b.id);
  emit({ id: b.id, why: 'created' });
  return b;
}

// A change made on this device: fn changes the board in place.
export function edit(id, fn, why = 'edit') {
  const b = boards.get(id);
  if (!b) return null;
  fn(b);
  b.rev = (b.rev || 0) + 1;
  b.changed = Date.now();
  persist(id);
  emit({ id, why });
  return b;
}

// Where the board is on screen, kept so it opens where it was left. Not a change to the drawing.
export function setView(id, view) {
  const b = boards.get(id);
  if (!b) return;
  b.view = view;
  persist(id);
}

// Another copy of a board (from Drive, or a backup file) merged into this one. Not counted as a change made here.
export function absorb(other, why = 'sync') {
  const here = boards.get(other.id);
  const b = here ? { ...mergeBoards(here, other), rev: here.rev, view: here.view } : { ...other, rev: 0 };
  boards.set(b.id, b);
  persist(b.id);
  emit({ id: b.id, why });
  return b;
}

export function remove(id, why = 'removed') {
  if (!boards.has(id)) return;
  boards.delete(id);
  persist(id);
  emit({ id, why });
}

// Wait for every write that's under way (for tests, and before the page is closed).
export async function flush() {
  writeWaiting();
  for (let i = 0; i < 50 && writing.size; i++) await new Promise(r => setTimeout(r, 20));
}
