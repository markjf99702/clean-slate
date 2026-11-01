// Saving boards to Google Drive, so they're in the person's own Drive and follow them from device to device.
// The boards in this browser stay the working copy, and the page never waits for Drive. When saving is on, each board
// is a picture, "Board name.svg", in a "Clean Slate" folder in the person's Drive: it opens in Drive like any picture,
// and has the board tucked inside, so Clean Slate on another device can open it and carry on. The two copies of a
// board are merged stroke by stroke (see board.js), so drawing on two devices keeps both drawings.
// Nothing about this shows away from https://clean-slate.junkdrawer.works, the address Google accepts it from.
import * as store from './store.js';
import { contentKey, untouched } from './board.js';
import { toSVG, fromSVG } from './svg.js';
import { esc, icon, ago, fileName } from './ui.js';

const ORIGINS = ['https://clean-slate.junkdrawer.works'];
// The junkdrawer.works OAuth client, shared by every junkdrawer.works project.
const CLIENT_ID = '897653851078-p5jrh2bto6h3bj0lc4jist3k1vsc1pj4.apps.googleusercontent.com';
// drive.file: Google lets the projects on this client see only the files they made themselves.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/';
const FOLDER = { name: 'Clean Slate', mimeType: 'application/vnd.google-apps.folder', appProperties: { cleanslate: 'folder' } };
const TAG = 'cleanslate';
// KT is shared by every junkdrawer.works project at this address: one sign-in, good for an hour.
const KT = 'junkdrawer.google', KS = 'clean-slate.drive';
const RETRY = { retry: true }, STOPPED = { stopped: true };

export const available = () => ORIGINS.includes(location.origin) && !('single' in document.documentElement.dataset);

const get = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
// files: board id -> { id, version, rev, key }: the Drive file, its version when this device last saw it, the
// board's rev here that it holds, and a key for what's in it. deleted: boards taken away here, to bin in Drive.
const fresh = () => ({ on: false, email: '', files: {}, deleted: {}, last: 0, skipped: 0 });

let st = { ...fresh(), ...(get(KS) || {}) };
let tok = get(KT);
let status = 'off', note = '', busy = null, again = false, client = null, gisLoading = false, soon = null;
let arrived = 0; // boards this sync brought to this device
let gen = 0; // goes up when this device stops saving, so a sync already under way writes nothing more
const watchers = new Set();
const saveSt = () => put(KS, st);

function live() {
  tok = get(KT);
  return !!(tok && tok.token && tok.exp - 60000 > Date.now() && String(tok.scope || '').includes(SCOPE));
}
function setStatus(s, n = '') { status = s; note = n; watchers.forEach(f => { try { if (f() === false) watchers.delete(f); } catch { watchers.delete(f); } }); }

// ---------- Drive calls ----------
async function call(method, path, body, type) {
  if (!tok?.token) throw { auth: true };
  const headers = { Authorization: 'Bearer ' + tok.token };
  if (type) headers['Content-Type'] = type;
  let r;
  try { r = await fetch(API + path, { method, headers, body }); } catch { throw { net: true }; }
  if (r.status === 401) {
    const g = get(KT);
    if (g && g.token === tok.token) put(KT, null);
    tok = null;
    throw { auth: true };
  }
  if (r.status === 404) throw { gone: true };
  if (!r.ok) throw { http: r.status };
  return r;
}
const api = async (...a) => { const r = await call(...a); return r.status === 204 ? null : r.json(); };
const json = o => JSON.stringify(o);
const props = (board, extra = {}) => ({ [TAG]: 'board', board, ...extra });

async function folderId() {
  const q = `appProperties has { key='${TAG}' and value='folder' } and trashed=false`;
  const x = await api('GET', `drive/v3/files?spaces=drive&orderBy=createdTime&pageSize=10&fields=${encodeURIComponent('files(id)')}&q=${encodeURIComponent(q)}`);
  if (x?.files?.length) return x.files[0].id;
  return (await api('POST', 'drive/v3/files?fields=id', json(FOLDER), 'application/json')).id;
}
// Every board file, the binned ones too: a board binned with `gone` set was deleted on another device.
async function boardFiles() {
  const q = `appProperties has { key='${TAG}' and value='board' }`;
  const fields = encodeURIComponent('nextPageToken,files(id,name,version,trashed,createdTime,appProperties)');
  const out = [];
  let page = '';
  do {
    const x = await api('GET', `drive/v3/files?spaces=drive&orderBy=createdTime&pageSize=1000&fields=${fields}&q=${encodeURIComponent(q)}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
    out.push(...(x?.files || []));
    page = x?.nextPageToken || '';
  } while (page);
  return out;
}
async function download(id) {
  const r = await call('GET', `drive/v3/files/${id}?alt=media`);
  return fromSVG(await r.text());
}
async function create(dir, board, text) {
  const bd = 'cleanslate' + Date.now().toString(36);
  const meta = { name: fileName(board.name) + '.svg', mimeType: 'image/svg+xml', parents: [dir], appProperties: props(board.id) };
  const payload = `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json(meta)}\r\n--${bd}\r\nContent-Type: image/svg+xml\r\n\r\n${text}\r\n--${bd}--`;
  const x = await api('POST', 'upload/drive/v3/files?uploadType=multipart&fields=id,version', payload, `multipart/related; boundary=${bd}`);
  return { id: x.id, version: String(x.version) };
}
const bin = (f, board, gone) => api('PATCH', `drive/v3/files/${f}?fields=id`, json({ trashed: true, appProperties: props(board, gone ? { gone: '1' } : {}) }), 'application/json');

// ---------- one sync ----------
async function run(g = gen) {
  // Stopped while this was waiting on Drive: leave both sides as they are.
  const going = () => { if (g !== gen || !st.on) throw STOPPED; };
  let dir = null;
  const folder = async () => (dir ||= await folderId());
  const files = await boardFiles();
  going();
  const by = new Map();
  for (const f of files) {
    const id = f.appProperties?.board;
    if (id) (by.get(id) || by.set(id, []).get(id)).push(f);
  }
  // Boards deleted here: their files go to the Drive trash, marked so the other devices delete them too.
  for (const id of Object.keys(st.deleted)) {
    for (const f of by.get(id) || []) if (!f.trashed) { await bin(f.id, id, true); going(); }
    delete st.deleted[id];
    saveSt();
    by.delete(id);
  }
  st.skipped = 0;
  const first = !st.last;
  arrived = 0;
  const ids = new Set([...store.list().map(b => b.id), ...by.keys()]);
  for (const id of ids) {
    for (let tries = 0; ; tries++) {
      try { await one(id, by.get(id) || [], folder, going); break; } catch (e) {
        if (e !== RETRY || tries >= 3) throw e;
        by.set(id, (await boardFiles()).filter(f => f.appProperties?.board === id));
        going();
      }
    }
  }
  // A device's first sync that brought boards in: the empty board it started with has done its job.
  if (first && arrived) for (const b of store.list()) if (untouched(b) && !st.files[b.id]) store.remove(b.id, 'sync');
  st.last = Date.now();
  saveSt();
}

async function one(id, files, folder, going) {
  const open = files.filter(f => !f.trashed);
  const deleted = files.some(f => f.trashed && f.appProperties?.gone);
  const meta = st.files[id];
  // Deleted here while this sync was under way: the next one bins it.
  const dropped = () => !!st.deleted[id];
  if (dropped()) return;
  let b = store.get(id);
  if (!open.length) {
    if (!b) return; // only in the Drive trash
    if (deleted && meta && b.rev <= meta.rev) { // deleted on another device, and not drawn on here since
      delete st.files[id];
      saveSt();
      store.remove(id, 'sync');
      return;
    }
    if (untouched(b)) return;
    // New here, or drawn on again here after another device deleted it: a new file.
    const rev = b.rev, key = contentKey(b), text = toSVG(b);
    const dir = await folder();
    going();
    const made = await create(dir, b, text);
    st.files[id] = { id: made.id, version: made.version, rev, key };
    saveSt();
    return;
  }
  // Two devices each made a file for this board before either saw the other's: fold the later ones into the first
  // (which the devices that already synced with it know) and bin them.
  const [file, ...extra] = open;
  for (const x of extra) {
    const other = await download(x.id);
    going();
    if (dropped()) return;
    if (other?.id === id) store.absorb(other);
    await bin(x.id, id, false);
    going();
  }
  let remoteKey = meta?.key;
  if (!meta || meta.id !== file.id || meta.version !== String(file.version) || extra.length) {
    const other = await download(file.id);
    going();
    if (!other || other.id !== id) { st.skipped++; return; } // not readable: left alone
    if (dropped()) return;
    remoteKey = contentKey(other);
    if (!store.get(id)) arrived++;
    store.absorb(other);
  }
  b = store.get(id);
  if (!b) return;
  const name = fileName(b.name) + '.svg';
  if (contentKey(b) === remoteKey && !extra.length && file.name === name) {
    st.files[id] = { id: file.id, version: String(file.version), rev: b.rev, key: remoteKey };
    saveSt();
    return;
  }
  // Another device may have saved since the list was read; then read it again and merge that.
  const now = await api('GET', `drive/v3/files/${file.id}?fields=version`);
  if (String(now.version) !== String(file.version)) throw RETRY;
  going();
  const rev = b.rev, key = contentKey(b), text = toSVG(b);
  let x = await api('PATCH', `upload/drive/v3/files/${file.id}?uploadType=media&fields=id,version`, text, 'image/svg+xml');
  if (file.name !== name) x = await api('PATCH', `drive/v3/files/${file.id}?fields=id,version`, json({ name }), 'application/json');
  st.files[id] = { id: file.id, version: String(x.version), rev, key };
  saveSt();
}

export function sync() {
  if (!available() || !st.on) return Promise.resolve();
  if (!live()) { setStatus('tap'); return Promise.resolve(); }
  if (busy) { again = true; return busy; }
  clearTimeout(soon);
  setStatus('busy');
  busy = run().then(() => setStatus(st.on ? 'ok' : 'off', st.skipped ? `${st.skipped === 1 ? 'One board file' : st.skipped + ' board files'} in your Drive couldn’t be read, so Clean Slate left ${st.skipped === 1 ? 'it' : 'them'} alone.` : ''), e => {
    if (!st.on || e === STOPPED) setStatus(st.on ? status : 'off');
    else if (e?.auth) setStatus('tap');
    else if (e === RETRY) setStatus('error', 'Another device kept saving. Try again in a moment.');
    else setStatus('error', 'Couldn’t reach Google Drive. Check the connection and try again.');
  }).then(() => {
    busy = null;
    if (again) { again = false; return sync(); }
  });
  return busy;
}

// A change on this page: sync a few seconds after the drawing stops.
function changed() {
  if (!available() || !st.on) return;
  clearTimeout(soon);
  if (live()) soon = setTimeout(sync, 4000); else setStatus('tap');
}

// ---------- signing in (Google Identity Services, in a pop-up) ----------
function loadGis() {
  if (!available() || client) return;
  if (window.google?.accounts?.oauth2) { initClient(); return; }
  if (gisLoading) return;
  gisLoading = true;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = initClient;
  s.onerror = () => { gisLoading = false; setStatus(st.on ? 'tap' : 'off', 'Google sign-in didn’t load. Check the connection.'); };
  document.head.appendChild(s);
}
function initClient() {
  if (client) return;
  client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: gotToken,
    error_callback: e => setStatus(st.on ? 'tap' : 'off', e?.type === 'popup_closed' ? '' : 'Google sign-in didn’t finish. If your browser blocks pop-ups, allow them for this page.'),
  });
  setStatus(status, note);
}
async function gotToken(r) {
  if (!r || r.error || !r.access_token || !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
    setStatus(st.on ? 'tap' : 'off', 'Google Drive wasn’t allowed, so nothing was saved there. Try again and leave the Drive box ticked.');
    return;
  }
  tok = { token: r.access_token, exp: Date.now() + (+r.expires_in || 3600) * 1000, scope: r.scope || SCOPE, email: st.email || get(KT)?.email || '' };
  put(KT, tok);
  st.on = true;
  saveSt();
  if (!st.email) await whoami();
  sync();
}
// The account's address, to show where boards are saved and to skip Google's account chooser next time.
async function whoami() {
  try {
    const x = await api('GET', 'drive/v3/about?fields=' + encodeURIComponent('user(emailAddress)'));
    st.email = x?.user?.emailAddress || '';
    saveSt();
    if (tok && st.email) { tok.email = st.email; put(KT, tok); }
  } catch { /* shown without it */ }
}
// Google only opens its window from a tap, so this has to run inside a click handler.
function signIn() {
  if (!client) { loadGis(); setStatus(status, 'Google sign-in is still loading. Tap again in a second.'); return; }
  const hint = st.email || get(KT)?.email || '';
  client.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: 'select_account' });
}
// Turn it on. With a sign-in still good from earlier, no Google window at all.
async function start() {
  if (!available()) return;
  if (!live()) { signIn(); return; }
  st.on = true;
  if (!st.email && tok.email) st.email = tok.email;
  saveSt();
  if (!st.email) await whoami();
  sync();
}
function now() { if (!st.on) start(); else if (!live()) signIn(); else sync(); }
// Stop on this device. The sign-in stays, and nothing is revoked: revoking would cancel Google's permission for
// every junkdrawer.works project. The boards stay here, and in Drive.
export function stop() {
  gen++;
  st = fresh();
  saveSt();
  clearTimeout(soon);
  again = false;
  setStatus('off');
}

// ---------- the bits of page ----------
function title() {
  return status === 'busy' ? 'Saving to Google Drive' : status === 'tap' ? 'Tap to sign in to Google again and save' : status === 'error' ? note + ' Tap to try again.' : 'Saved to Google Drive' + (st.last ? ' ' + ago(st.last) : '') + '. Tap to save now.';
}

// The header button: a cloud with a dot (green saved, amber saving, red needs a tap).
export function chip(btn) {
  if (!available()) { btn.hidden = true; return; }
  btn.innerHTML = icon.cloud + '<i class="dot"></i>';
  btn.addEventListener('click', now);
  watch(() => { btn.hidden = !st.on; btn.dataset.s = status; btn.title = title(); btn.setAttribute('aria-label', title()); });
}

// The card in the menu: turn it on, see where boards go, save now, or stop.
export function card(host) {
  if (!host) return;
  if (!available()) { host.hidden = true; return; }
  host.hidden = false;
  loadGis();
  let armed = false;
  function draw() {
    if (!host.isConnected) return false;
    const line = status === 'busy' ? 'Saving now.' : status === 'tap' ? 'Google signs this page out after an hour. Tap <b>Save now</b> to sign back in; your boards wait safely here meanwhile.' : status === 'error' || note ? esc(note) : st.last ? `Last saved ${ago(st.last)}.` : '';
    host.innerHTML = st.on
      ? `<h2>Google Drive</h2><p>Your boards are saved to <b>${esc(st.email || 'your Google Drive')}</b>, in <span class="path">My Drive › Clean Slate</span>, one picture per board. Turn this on on another device and the same boards show up there. ${line}</p>
        <div class="row"><button class="btn" type="button" data-a="now"${status === 'busy' ? ' disabled' : ''}>${icon.cloud}Save now</button><button class="btn quiet" type="button" data-a="off">${armed ? 'Tap again to stop' : 'Stop saving on this device'}</button></div>`
      : `<h2>Save to Google Drive</h2><p>Keep your boards in your own Google Drive, in a “Clean Slate” folder, as pictures you can open there. Turn it on on your other devices too and the same boards show up on each, ready to draw on. <a href="https://junkdrawer.works/privacy.html">Privacy</a></p>${note ? `<p class="err">${esc(note)}</p>` : ''}
        <div class="row"><button class="btn primary" type="button" data-a="on">${icon.cloud}Save to Google Drive</button></div>`;
    host.querySelectorAll('button[data-a]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'on') start();
      else if (a === 'now') now();
      else if (!armed) { armed = true; draw(); }
      else { armed = false; stop(); }
    }));
  }
  watch(draw);
}
function watch(f) { watchers.add(f); f(); }

export const syncState = () => ({ ...st, status, note });

export function initSync() {
  store.on(({ id, why }) => {
    if (why === 'sync' || why === 'tab') return;
    if (why === 'removed' && st.on && st.files[id]) {
      st.deleted[id] = st.files[id].id;
      delete st.files[id];
      saveSt();
    }
    changed();
  });
  if (!available()) return;
  if (st.on) {
    loadGis(); // ready before the first tap
    status = live() ? 'ok' : 'tap';
    if (live()) setTimeout(sync, 0);
  }
  document.addEventListener('visibilitychange', () => {
    if (!st.on || !live()) return;
    // Leaving the page: save what's waiting now rather than in a few seconds.
    if (document.visibilityState === 'hidden' && soon) { clearTimeout(soon); soon = null; sync(); }
    else if (document.visibilityState === 'visible' && Date.now() - st.last > 30000) sync();
  });
  setInterval(() => { if (document.visibilityState === 'visible' && st.on && live() && !busy) sync(); else if (st.on && !live() && status !== 'tap') setStatus('tap'); }, 90000);
  window.addEventListener('storage', e => {
    if (e.key === KS || e.key === KT) {
      st = { ...fresh(), ...(get(KS) || {}) };
      tok = get(KT);
      setStatus(st.on ? (live() ? 'ok' : 'tap') : 'off');
    }
  });
}
