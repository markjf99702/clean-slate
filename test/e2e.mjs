// Uses Clean Slate in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
// A pen, fingers and a mouse draw on it through Chrome's own input (so pressure, palms and two-finger taps are the
// real events), then two browser contexts share a stand-in Google Drive as two devices.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fakeGoogle } from './fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the end).
let net = 'up', release = false;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;
const wait = ms => new Promise(r => setTimeout(r, ms));
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await wait(100); }
};

// Real input through Chrome: a pen with pressure, fingers, and the mouse.
function hands(page, cdp) {
  const mouse = (type, x, y, o = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...o });
  return {
    async pen(pts, o = {}) {
      const p = { pointerType: 'pen', ...o };
      await mouse('mousePressed', pts[0][0], pts[0][1], { ...p, force: pts[0][2] ?? 0.5 });
      for (const [x, y, f] of pts.slice(1)) await mouse('mouseMoved', x, y, { ...p, force: f ?? 0.5 });
      const [x, y] = pts[pts.length - 1];
      await mouse('mouseReleased', x, y, { ...p, force: 0 });
    },
    penDown: (x, y) => mouse('mousePressed', x, y, { pointerType: 'pen', force: 0.5 }),
    penMove: (x, y) => mouse('mouseMoved', x, y, { pointerType: 'pen', force: 0.6 }),
    penUp: (x, y) => mouse('mouseReleased', x, y, { pointerType: 'pen', force: 0 }),
    touch: (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, radiusX: 8, radiusY: 8 })) }),
    async swipe(from, to, steps = 8) {
      await this.touch('touchStart', [from]);
      for (let i = 1; i <= steps; i++) await this.touch('touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps]]);
      await this.touch('touchEnd', []);
    },
    async tap(n) {
      const pts = [[300, 400], [360, 420], [420, 440]].slice(0, n);
      await this.touch('touchStart', pts);
      await wait(60);
      await this.touch('touchEnd', []);
    },
  };
}
const line = (x0, y0, x1, y1, n = 16, f = () => 0.5) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, f(i / n)]);
const count = page => page.evaluate(() => cleanSlate.store.get(cleanSlate.current()).strokes.length);
const view = page => page.evaluate(() => cleanSlate.surface.view);

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

await page.goto(base);
await page.waitForFunction(() => document.body.classList.contains('ready'));
await page.evaluate(() => document.fonts.ready);
const cdp = await ctx.newCDPSession(page);
const h = hands(page, cdp);

// A new board, with the hint, and fingers drawing (no pen seen yet).
assert.equal(await page.isVisible('#hint'), true, 'an empty board says how it works');
assert.equal(await page.textContent('#boardName'), 'Board 1');
assert.equal(await page.isHidden('#cloud'), true, 'no Drive button away from the real address');
await h.swipe([200, 300], [400, 320]);
assert.equal(await count(page), 1, 'a finger draws before any pen has been used');
assert.equal(await page.isHidden('#hint'), true, 'the hint goes once something is drawn');

// The pen: pressure makes the line wider where it pressed harder.
await h.pen(line(200, 450, 700, 450, 40, t => 0.1 + 0.9 * t));
assert.equal(await count(page), 2, 'the pen draws');
assert.equal(await page.evaluate(() => cleanSlate.settings.penSeen), true);
const pressures = await page.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); const p = b.strokes[1].pts; return [p[2], p[p.length - 1], b.strokes[1].sim]; });
assert.ok(pressures[0] < 0.3 && pressures[1] > 0.8 && pressures[2] === 0, `the pen's pressure is kept: ${pressures}`);
await until(() => page.evaluate(() => document.querySelector('#toast').classList.contains('on')), 2000, 'the page says the pen was found');

// Once a pen is in use, a finger moves the board instead of drawing; a touch while the pen is down is a palm.
await wait(700);
const v0 = await view(page);
await h.swipe([500, 500], [400, 450]);
let v1 = await view(page);
assert.equal(await count(page), 2, 'a finger no longer draws');
assert.ok(Math.abs(v1.x - v0.x - 100) < 2 && Math.abs(v1.y - v0.y - 50) < 2, `a finger moves the board: ${JSON.stringify([v0, v1])}`);
await h.penDown(200, 600);
await h.touch('touchStart', [[600, 650]]);
for (let i = 1; i <= 10; i++) { await h.penMove(200 + i * 30, 600 + (i % 2) * 10); await h.touch('touchMove', [[600 - i * 12, 650 - i * 6]]); }
await h.penUp(500, 600);
await h.touch('touchEnd', []);
assert.equal(await count(page), 3, 'the pen still drew with a palm on the screen');
assert.deepEqual(await view(page), v1, 'the palm did not move the board');

// Two fingers zoom; a two-finger tap undoes and a three-finger tap redoes.
await wait(700);
await h.touch('touchStart', [[400, 400], [500, 400]]);
for (let i = 1; i <= 6; i++) await h.touch('touchMove', [[400 - i * 10, 400], [500 + i * 10, 400]]);
await h.touch('touchEnd', []);
v1 = await view(page);
assert.ok(v1.z > 1.9 && v1.z < 2.3, `pinching zooms: ${v1.z}`);
assert.equal(await page.textContent('#zoom'), Math.round(v1.z * 100) + '%');
await page.click('#zoom');
assert.equal((await view(page)).z, 1, 'the zoom button goes back to 100%');
await h.tap(2);
assert.equal(await count(page), 2, 'a two-finger tap undoes');
await h.tap(3);
assert.equal(await count(page), 3, 'a three-finger tap redoes');
await page.keyboard.press('Control+z');
assert.equal(await count(page), 2, 'Ctrl+Z undoes');
await page.keyboard.press('Control+Shift+z');
assert.equal(await count(page), 3, 'Ctrl+Shift+Z redoes');

// The eraser takes whole lines; the pen's side button erases with the pen in hand; undo brings them back.
await page.evaluate(() => cleanSlate.surface.setView({ x: 0, y: 0, z: 1 }));
await page.click('[data-tool="eraser"]');
await h.pen(line(450, 440, 450, 470, 6));
assert.equal(await count(page), 2, 'the eraser took the pen line');
await page.click('#undo');
assert.equal(await count(page), 3, 'undo brought it back');
await page.click('[data-tool="pen"]');
await h.pen(line(450, 440, 450, 470, 6), { button: 'right', buttons: 2 });
assert.equal(await count(page), 2, 'the pen’s side button erases');
await page.keyboard.press('Control+z');

// Colours, sizes and the highlighter, kept for next time.
await page.click('[data-color="red"]');
await page.click('[data-size="2"]');
await page.click('[data-tool="marker"]');
assert.equal(await page.locator('.swatches [data-color]').count(), 5, 'the highlighter has its own colours');
await h.pen(line(180, 450, 720, 450, 20));
const last = await page.evaluate(() => { const b = cleanSlate.store.get(cleanSlate.current()); return b.strokes[b.strokes.length - 1]; });
assert.equal(last.tool, 'marker');
assert.equal(last.color, 'yellow');
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('clean-slate.settings')));
assert.equal(kept.pen.color, 'red');
assert.equal(kept.pen.size, 2);
assert.equal(kept.tool, 'marker');
await page.click('[data-tool="pen"]');

// The board is still there after a reload, where it was left.
const before = await count(page);
await page.evaluate(() => cleanSlate.surface.setView({ x: 30, y: 40, z: 1.5 }));
await wait(1000);
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'));
assert.equal(await count(page), before, 'the drawing survived a reload');
assert.deepEqual(await view(page), { x: 30, y: 40, z: 1.5 }, 'it opens where it was left');

// The menu: name, colour, lines.
await page.click('#menuBtn');
await page.fill('#nameInput', 'Kitchen plan');
await page.press('#nameInput', 'Enter');
await page.click('[data-bg="slate"]');
await page.click('[data-pattern="dots"]');
let b = await page.evaluate(() => cleanSlate.store.get(cleanSlate.current()));
assert.equal(b.name, 'Kitchen plan');
assert.equal(b.bg, 'slate');
assert.equal(b.pattern, 'dots');
assert.equal(await page.textContent('#boardName'), 'Kitchen plan');

// Pictures and backups.
const [png] = await Promise.all([page.waitForEvent('download'), page.click('#savePng')]);
assert.equal(png.suggestedFilename(), 'Kitchen plan.png');
const pngBytes = await readFile(await png.path());
assert.equal(pngBytes.subarray(1, 4).toString(), 'PNG');
const [svg] = await Promise.all([page.waitForEvent('download'), page.click('#saveSvg')]);
assert.match(await readFile(await svg.path(), 'utf8'), /clean-slate-board/);
const [backup] = await Promise.all([page.waitForEvent('download'), page.click('#backup')]);
const backupPath = await backup.path();
assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).boards.length, 1);
await page.click('#menu [data-close]');

// Boards: a new one, back to the first, and deleting.
await page.click('#boardsBtn');
await page.click('#newBoard');
assert.equal(await page.textContent('#boardName'), 'Board 2');
assert.equal(await count(page), 0);
await h.pen(line(300, 300, 400, 350));
await page.click('#boardsBtn');
assert.equal(await page.locator('#boardList li').count(), 2);
await page.click('#boardList li:nth-child(2) button.open');
assert.equal(await page.textContent('#boardName'), 'Kitchen plan');
await page.click('#boardsBtn');
const del = page.locator('#boardList li:nth-child(2) [data-del]');
await del.click();
assert.equal(await page.evaluate(() => cleanSlate.store.list().length), 2, 'the first tap only asks');
await del.click();
assert.equal(await page.evaluate(() => cleanSlate.store.list().length), 1, 'the second tap deletes');
// Deleting the last board leaves a fresh one; a backup file opens back in. (The list stays open after a delete.)
await page.click('#boardList li:first-child [data-del]');
await page.click('#boardList li:first-child [data-del]');
assert.equal(await page.textContent('#boardName'), 'Board 1', 'deleting the last board leaves a fresh one');
await page.keyboard.press('Escape');
await page.click('#menuBtn');
await page.setInputFiles('#restoreFile', backupPath);
await until(async () => (await page.textContent('#boardName')) === 'Kitchen plan', 3000, 'a backup file opens');
assert.equal(await count(page), before);

// Clear, and undo it.
await page.click('#menuBtn');
await page.click('#clear');
await page.click('#clear');
assert.equal(await count(page), 0, 'Clear empties the board');
await page.keyboard.press('Control+z');
assert.equal(await count(page), before, 'and undo brings it all back');

// A phone: nothing scrolls sideways, and the colours are behind one button.
await page.setViewportSize({ width: 390, height: 844 });
await wait(200);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');
assert.equal(await page.isVisible('.tools .swatches'), false);
await page.click('#styleBtn');
assert.equal(await page.isVisible('#pop .swatch'), true, 'the colour button opens the colours');
await page.click('#pop [data-color="blue"]');
assert.equal(await page.evaluate(() => cleanSlate.settings.pen.color), 'blue');
await page.setViewportSize({ width: 1024, height: 768 });

// ---------- Google Drive, with two devices ----------
{
  const g = fakeGoogle();
  const origin = base.slice(0, -1);
  const device = async () => {
    const c = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, serviceWorkers: 'block' });
    await g.install(c, { rewrite: { '**/js/sync.js': s => s.replace("['https://clean-slate.junkdrawer.works']", `['https://clean-slate.junkdrawer.works', '${origin}']`) } });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push('drive: ' + e.message));
    await p.goto(base);
    await p.waitForFunction(() => document.body.classList.contains('ready'));
    return { c, p, h: hands(p, await c.newCDPSession(p)) };
  };
  const state = p => p.evaluate(() => cleanSlate.syncState());
  const settle = async (p, what) => {
    await p.evaluate(() => cleanSlate.sync());
    await until(async () => (await state(p)).status === 'ok', 5000, what);
  };
  const boardFiles = () => g.files().filter(f => f.appProperties?.cleanslate === 'board');
  const A = await device(), B = await device();

  // Device A draws, then turns Drive on.
  await A.h.pen(line(200, 300, 500, 300));
  await A.h.pen(line(200, 340, 500, 340));
  await A.p.click('#menuBtn');
  assert.equal(await A.p.isVisible('#drive .btn.primary'), true, 'the menu offers Google Drive');
  await A.p.click('#drive .btn.primary');
  await until(async () => (await state(A.p)).status === 'ok', 5000, 'device A saved to Drive');
  assert.equal(await A.p.isVisible('#cloud'), true, 'the cloud button shows once Drive is on');
  assert.equal(g.files().filter(f => f.mimeType === 'application/vnd.google-apps.folder').length, 1, 'one Clean Slate folder');
  assert.equal(boardFiles().length, 1, 'one file for the one board');
  assert.equal(boardFiles()[0].name, 'Board 1.svg');
  assert.match(boardFiles()[0].body, /^<svg/, 'the file is a picture');
  const boardId = await A.p.evaluate(() => cleanSlate.current());

  // Device B, with its own empty board, turns Drive on: A's board arrives, B's empty one stays home.
  await B.p.click('#menuBtn');
  await B.p.click('#drive .btn.primary');
  await until(async () => (await state(B.p)).status === 'ok', 5000, 'device B synced');
  assert.equal(boardFiles().length, 1, 'an empty board isn’t saved to Drive');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id)?.strokes.length, boardId), 2, 'A’s board is on B');
  assert.equal(await B.p.evaluate(() => cleanSlate.store.list().length), 1, 'B’s empty starter board made way for it');
  assert.equal(await B.p.textContent('#boardName'), 'Board 1');
  assert.equal(await B.p.evaluate(() => cleanSlate.current()), boardId, 'B is showing A’s board');

  // Both draw on the same board at once: both drawings are kept on both.
  await B.p.click('#menu [data-close]');
  await B.p.evaluate(id => cleanSlate.open(id), boardId);
  await B.h.pen(line(200, 400, 500, 400));
  await A.p.click('#menu [data-close]');
  await A.h.pen(line(200, 450, 500, 450));
  await settle(A.p, 'A saved its line');
  await settle(B.p, 'B merged and saved');
  await settle(A.p, 'A picked up B’s line');
  assert.equal(await A.p.evaluate(id => cleanSlate.store.get(id).strokes.length, boardId), 4, 'A has both new lines');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id).strokes.length, boardId), 4, 'B has both new lines');
  assert.equal(await A.p.evaluate(() => document.querySelector('#board canvas') !== null), true);

  // A renames it and erases a line; B gets both.
  await A.p.click('#menuBtn');
  await A.p.fill('#nameInput', 'Plans');
  await A.p.press('#nameInput', 'Enter');
  await A.p.click('#menu [data-close]');
  await A.p.click('[data-tool="eraser"]');
  await A.h.pen(line(300, 290, 300, 310, 4));
  await settle(A.p, 'A saved the rename');
  await settle(B.p, 'B read the rename');
  assert.equal(boardFiles()[0].name, 'Plans.svg', 'the Drive file is renamed too');
  assert.equal(await B.p.textContent('#boardName'), 'Plans', 'B shows the new name');
  assert.equal(await B.p.evaluate(id => cleanSlate.store.get(id).strokes.length, boardId), 3, 'the erased line is gone on B');

  // An expired sign-in waits for a tap; local drawing carries on meanwhile.
  await A.p.evaluate(() => { const t = JSON.parse(localStorage.getItem('junkdrawer.google')); t.token = 'tok-expired'; localStorage.setItem('junkdrawer.google', JSON.stringify(t)); });
  await A.p.click('[data-tool="pen"]');
  await A.h.pen(line(200, 500, 500, 500));
  await A.p.evaluate(() => cleanSlate.sync());
  await until(async () => (await state(A.p)).status === 'tap', 5000, 'an expired sign-in asks for a tap');
  assert.equal(await A.p.getAttribute('#cloud', 'data-s'), 'tap');
  await A.p.click('#cloud');
  await until(async () => (await state(A.p)).status === 'ok', 5000, 'one tap signs back in and saves');

  // B deletes the board: it goes to the Drive trash, and A deletes it too.
  await B.p.click('#boardsBtn');
  const row = B.p.locator(`#boardList [data-del="${boardId}"]`);
  await row.click();
  await row.click();
  await settle(B.p, 'B saved the deletion');
  assert.equal(boardFiles()[0].trashed, true, 'the file went to the Drive trash');
  await settle(A.p, 'A saw the deletion');
  assert.equal(await A.p.evaluate(id => !!cleanSlate.store.get(id), boardId), false, 'the board is gone on A too');

  // Stopping leaves the boards and Drive as they are, and never revokes the sign-in.
  await A.h.pen(line(200, 300, 500, 300));
  await A.p.click('#menuBtn');
  await A.p.click('#drive .btn.quiet');
  await A.p.click('#drive .btn.quiet');
  assert.equal((await state(A.p)).on, false, 'stopped');
  assert.equal(await A.p.evaluate(() => !!window.__revoked), false, 'nothing was revoked');
  assert.equal(await A.p.isHidden('#cloud'), true);
  await A.c.close();
  await B.c.close();
}

// Works offline once it has been opened. The server goes down as well as the browser: in some Chromium builds the
// browser's offline switch alone doesn't stop the service worker's own requests, and this passed with no copy at all.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
const title = await page.title();
net = 'down';
await ctx.setOffline(true);
await page.reload();
await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 5000 });
assert.equal(await page.title(), title, 'the page did not open offline');
assert.equal(await count(page), before, 'the board is there offline');
await ctx.setOffline(false);

// On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
// the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
net = 'up';
for (const [req, res] of held.splice(0)) serve(req, res);

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
release = true;
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  10000, "the new release's offline copy kept the old index.html");
release = false;

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log('all good');
