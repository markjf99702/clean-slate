// Renders the README pictures (docs/*.png) and the link preview (og.png):  node tools/screenshots.mjs
// The boards in them are drawn here, stroke by stroke: handwriting from a single-line script font (Hershey Script, in
// tools/hershey-script.json) with a little wobble and pen pressure, and boxes, arrows and circles drawn the same way.
// Math.random is seeded, so the same pictures come out every time.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeGoogle } from '../test/fake-google.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

// ---------- drawing the sample boards ----------
let seed = 7;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const wob = k => (rnd() - 0.5) * 2 * k;
const font = JSON.parse(await readFile(join(root, 'tools/hershey-script.json'), 'utf8'));
let clock = Date.UTC(2026, 9, 31, 15);
const tick = () => (clock += 400);
let n = 0;
const sid = () => 's' + (++n).toString(36).padStart(6, '0') + 'x';

// A polyline, filled in to a point every few units, with pressure that swells in the middle of the line.
function stroke(points, { tool = 'pen', color = 'ink', size = 4, step = 2.5 } = {}) {
  const dense = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 0; j < k; j++) dense.push([x0 + (x1 - x0) * j / k, y0 + (y1 - y0) * j / k]);
  }
  dense.push(points[points.length - 1]);
  const pts = [];
  dense.forEach(([x, y], i) => {
    const t = dense.length > 1 ? i / (dense.length - 1) : 0.5;
    pts.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, tool === 'pen' ? Math.round((0.38 + 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + wob(0.05)) * 100) / 100 : 0.5);
  });
  return { id: sid(), t: tick(), tool, color, size, sim: 0, pts };
}
// Handwriting: each glyph's lines, scaled to `size` (about the height of a capital), slanted and wobbled a little.
function write(text, x, y, size, o = {}) {
  const k = size / 21, out = [];
  let cx = x;
  for (const ch of text) {
    const g = font.chars[ch.charCodeAt(0) - font.first];
    if (!g) { cx += size * 0.45; continue; }
    const dy = wob(size * 0.03), dx = wob(size * 0.02);
    for (const part of g.d.split('M').filter(Boolean)) {
      const pts = part.replace('L', ' ').trim().split(/\s+/).map(p => p.split(',').map(Number))
        .map(([gx, gy]) => [cx + dx + gx * k + (22 - gy) * k * 0.12 + wob(0.35), y + dy + (gy - 22) * k + wob(0.35)]);
      out.push(stroke(pts, { size: o.size || Math.max(2.5, size / 11), color: o.color || 'ink' }));
    }
    cx += g.o * 2 * k * 0.86;
  }
  return out;
}
const seg = (x0, y0, x1, y1, n = 6, w = 1.2) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n + (i && i < n ? wob(w) : 0), y0 + (y1 - y0) * i / n + (i && i < n ? wob(w) : 0)]);
const box = (x0, y0, x1, y1, o) => stroke([...seg(x0, y0, x1 + 3, y0 + wob(2)), ...seg(x1, y0, x1 + wob(2), y1).slice(1), ...seg(x1, y1, x0, y1 + wob(2)).slice(1), ...seg(x0, y1, x0 + 2, y0 - 4).slice(1)], o);
function arrow(x0, y0, x1, y1, o, both = false) {
  const a = Math.atan2(y1 - y0, x1 - x0), L = 16;
  const head = (x, y, a) => stroke([[x - L * Math.cos(a - 0.45), y - L * Math.sin(a - 0.45)], [x, y], [x - L * Math.cos(a + 0.45), y - L * Math.sin(a + 0.45)]], o);
  return [stroke(seg(x0, y0, x1, y1, 10, 1.5), o), head(x1, y1, a), ...(both ? [head(x0, y0, a + Math.PI)] : [])];
}
const loop = (cx, cy, rx, ry, o, turns = 1.12) => stroke(Array.from({ length: 64 }, (_, i) => { const t = -2.2 + i / 63 * Math.PI * 2 * turns; return [cx + Math.cos(t) * rx * (1 + wob(0.02)), cy + Math.sin(t) * ry * (1 + wob(0.02))]; }), o);
const tickMark = (x, y, o) => stroke([[x, y], [x + 7, y + 9], [x + 22, y - 12]], o);
const marker = (x0, x1, y, color = 'yellow', size = 24) => stroke(seg(x0, y + wob(1), x1, y + wob(2), 8, 0.8), { tool: 'marker', color, size });

function board(name, strokes, more = {}) {
  return { id: 'b' + name.toLowerCase().replace(/\W+/g, '').slice(0, 12) + 'sample', name, nameAt: 1, bg: 'white', bgAt: 0, pattern: 'grid', patternAt: 0, created: clock, changed: tick(), rev: 1, strokes, gone: {}, ...more };
}

const garden = board('Garden plan', [
  ...write('Garden plan', 120, 175, 50, { size: 5 }),
  stroke(seg(118, 196, 430, 192, 12, 1.5), { color: 'blue', size: 3 }),
  ...arrow(122, 240, 518, 240, { color: 'red', size: 3 }, true),
  ...write('8 ft', 292, 228, 22, { color: 'red', size: 3 }),
  box(120, 262, 520, 420, { color: 'blue', size: 4 }),
  ...write('Tomatoes', 175, 355, 34),
  ...[0, 1, 2, 3, 4].map(i => loop(165 + i * 80, 395, 8, 8, { color: 'green', size: 3 }, 1.05)),
  ...arrow(552, 264, 552, 418, { color: 'red', size: 3 }, true),
  ...write('3 ft', 566, 350, 22, { color: 'red', size: 3 }),
  box(120, 470, 520, 610, { color: 'blue', size: 4 }),
  ...write('Beans & peas', 160, 555, 32),
  ...write('To get:', 690, 285, 34),
  ...['compost', 'stakes', 'seeds', 'twine'].flatMap((w, i) => [box(692, 318 + i * 54, 712, 338 + i * 54, { size: 2.5 }), ...write(w, 730, 340 + i * 54, 28)]),
  tickMark(694, 326, { color: 'green', size: 4 }),
  tickMark(694, 434, { color: 'green', size: 4 }),
  marker(726, 832, 382),
  ...write('start in May!', 712, 652, 30, { color: 'green' }),
  loop(810, 640, 132, 44, { color: 'green', size: 3 }),
  ...arrow(676, 628, 540, 560, { color: 'green', size: 3 }),
]);

const homework = board('Homework', [
  ...write('x', 140, 210, 46, { size: 4.5 }),
  ...write('2', 176, 180, 22, { size: 3 }),
  ...write('+ 5x + 6 = 0', 210, 210, 46, { size: 4.5 }),
  ...write('(x + 2)(x + 3) = 0', 150, 300, 46, { size: 4.5, color: 'blue' }),
  marker(140, 610, 372, 'pink', 40),
  ...write('x = -2  or  x = -3', 150, 390, 46, { size: 4.5, color: 'orange' }),
  stroke(seg(640, 420, 960, 420, 10, 1), { size: 3 }),
  stroke(seg(900, 160, 900, 520, 10, 1), { size: 3 }),
  stroke(Array.from({ length: 40 }, (_, i) => { const x = -4.4 + i * 0.0974; return [900 + x * 60 + wob(0.6), 420 - ((x + 2) * (x + 3)) * 52 + wob(0.6)]; }), { color: 'green', size: 4 }),
], { bg: 'slate', bgAt: 1 });

const notes = board('Thursday', [
  ...write('Thursday', 110, 140, 40, { color: 'blue', size: 4.5 }),
  ...write('- book the hall', 120, 220, 30),
  ...write('- call Sam about chairs', 120, 284, 30),
  marker(140, 330, 334, 'green'),
  ...write('- 40 people?', 120, 348, 30),
  box(150, 410, 470, 456, { size: 3 }),
  ...write('stage', 268, 444, 24),
  ...[0, 1, 2].flatMap(i => [loop(190 + i * 120, 530, 34, 34, { color: 'orange', size: 3 }), loop(190 + i * 120, 630, 34, 34, { color: 'orange', size: 3 })]),
  ...write('Budget $300', 130, 760, 32, { color: 'red' }),
  loop(240, 748, 140, 42, { color: 'red', size: 3 }),
], { bg: 'paper', bgAt: 1, pattern: 'lines', patternAt: 1 });

// Shapes, the way the shapes tool and holding still make them.
const shape = (pts, o) => ({ id: sid(), t: tick(), tool: 'pen', color: o.color || 'ink', size: o.size || 4, sim: 0, pts: pts.flatMap(([x, y]) => [x, y, 0.5]), shape: o.shape || 'closed', ...(o.fill ? { fill: 1 } : {}) });
const sketch = board('Shed', [
  shape([[200, 268], [460, 268], [460, 440], [200, 440]], {}),
  shape([[186, 268], [330, 160], [474, 268]], { color: 'red' }),
  shape([[300, 340], [360, 340], [360, 440], [300, 440]], { color: 'orange', size: 3.5 }),
  shape(Array.from({ length: 72 }, (_, i) => [560 + Math.cos(i / 72 * Math.PI * 2) * 34, 150 + Math.sin(i / 72 * Math.PI * 2) * 34]), { color: 'orange', fill: true }),
  shape([[200, 470], [460, 470]], { color: 'blue', size: 3, shape: 'arrow' }),
  shape([[460, 470], [200, 470]], { color: 'blue', size: 3, shape: 'arrow' }),
  ...write('10 ft', 296, 506, 28, { color: 'blue' }),
], { pattern: 'dots', patternAt: 1 });

garden.changed = tick(); // the newest, at the top of the list
const boards = [sketch, notes, homework, garden];

// ---------- the pictures ----------
const browser = await pw.chromium.launch();
await mkdir(join(root, 'docs'), { recursive: true });

async function open(viewport, deviceScaleFactor, { drive = false, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, hasTouch: true, serviceWorkers: 'block', colorScheme: dark ? 'dark' : 'light' });
  // The Drive card shows only at the real address; here it's let through so the menu looks the way it does there.
  if (drive) await fakeGoogle().install(ctx, { rewrite: { '**/js/sync.js': s => s.replace("['https://clean-slate.junkdrawer.works']", `['https://clean-slate.junkdrawer.works', '${base.slice(0, -1)}']`) } });
  await ctx.addInitScript(() => localStorage.setItem('clean-slate.settings', JSON.stringify({ penSeen: true, tool: 'pen', pen: { color: 'ink', size: 1 } })));
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForFunction(() => document.body.classList.contains('ready'));
  await page.evaluate(async list => {
    const first = cleanSlate.store.list()[0];
    for (const b of list) cleanSlate.store.absorb(b, 'import');
    cleanSlate.store.remove(first.id);
    await cleanSlate.store.flush();
  }, boards);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const show = async (page, id, view) => {
  await page.evaluate(([id, view]) => { cleanSlate.open(id); if (view) cleanSlate.surface.setView(view, true); else cleanSlate.surface.fit(); }, [id, view]);
  await page.waitForTimeout(250);
};

// The README's tablet picture.
{
  const page = await open({ width: 1180, height: 820 }, 1);
  await show(page, garden.id, { x: 20, y: 0, z: 1 });
  await page.evaluate(() => document.querySelector('#zoom').hidden = true);
  await page.screenshot({ path: join(root, 'docs/tablet-board.png') });
  await page.context().close();
}

// Phone pictures.
{
  const page = await open({ width: 390, height: 844 }, 2, { drive: true });
  await show(page, notes.id, { x: 60, y: -40, z: 0.68 });
  await page.evaluate(() => { document.querySelector('#zoom').hidden = true; });
  await page.screenshot({ path: join(root, 'docs/phone-board.png') });
  await page.click('#boardsBtn');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(root, 'docs/phone-boards.png') });
  await page.keyboard.press('Escape');
  await show(page, homework.id, { x: 120, y: 120, z: 0.62 });
  await page.click('#menuBtn');
  await page.waitForTimeout(400);
  await page.evaluate(() => { const m = document.querySelector('#menu'); m.scrollTop = m.querySelector('.files').offsetTop - 12; });
  await page.screenshot({ path: join(root, 'docs/phone-menu.png') });
  await page.context().close();
}

// Link preview, 1200 x 630: a card with the name and one line on the left, and the board itself on the right.
{
  const page = await open({ width: 1200, height: 630 }, 1);
  await show(page, garden.id);
  const art = await page.evaluate(async () => {
    const { picture } = await import('./js/ink.js');
    return picture(cleanSlate.store.get(cleanSlate.current()), { max: 1400, margin: 30 }).toDataURL('image/png');
  });
  const fontData = (await readFile(join(root, 'fonts/figtree.woff2'))).toString('base64');
  const icon = (await readFile(join(root, 'icon.svg'))).toString('base64');
  await page.setContent(`<style>
    @font-face { font-family: F; src: url(data:font/woff2;base64,${fontData}); font-weight: 300 900; }
    html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
    body { font-family: F; background: #c98c4f; display: flex; align-items: center; }
    .text { width: 470px; padding: 0 0 0 70px; color: #2a1a0c; }
    .text img { width: 84px; height: 84px; display: block; margin-bottom: 26px; filter: drop-shadow(0 4px 10px rgba(60, 30, 0, .25)); }
    h1 { font-size: 76px; line-height: 1; margin: 0 0 22px; letter-spacing: -1.5px; font-weight: 750; }
    p { font-size: 31px; line-height: 1.3; margin: 0; font-weight: 500; color: #3d2610; }
    .board { width: 620px; height: 470px; border-radius: 22px; background: #fff; box-shadow: 0 0 0 14px #2a3236, 0 24px 50px rgba(50, 25, 0, .4); display: grid; place-items: center; overflow: hidden; margin-left: 10px; }
    .board img { width: 100%; height: 100%; object-fit: contain; }
  </style>
  <div class="text"><img src="data:image/svg+xml;base64,${icon}" alt=""><h1>Clean Slate</h1><p>A whiteboard for your tablet and pen, in the browser.</p></div>
  <div class="board"><img src="${art}" alt=""></div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(root, 'og.png') });
  await page.context().close();
}

await browser.close();
server.close();
console.log('screenshots written');
