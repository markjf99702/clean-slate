// The board on screen: two canvases (the drawing, and on top the line being drawn right now) and everything the pen,
// fingers, mouse and trackpad do to them.
//
// Pens and fingers: until a pen has been used here, a finger draws. Once one has, the pen draws and fingers move
// the board, and while the pen is down or close by, every touch is taken for a resting palm and ignored. Two fingers
// always move and zoom; a quick tap with two fingers is Undo, with three, Redo. A pen's eraser end, or its side
// button held down, erases whatever the tool is.
import { makeStroke, SIZES, shade } from './board.js';
import { outline, toPath2D, touches, drawBackground, drawStrokes, markerMode, fitView } from './ink.js';

const MIN_Z = 0.1, MAX_Z = 10;
const clampZ = z => Math.min(MAX_Z, Math.max(MIN_Z, z));
const PALM_AFTER_PEN = 600; // ms a touch is taken for a palm after the pen was last seen
const PALM_SIZE = 48; // CSS px across
const TAP_MS = 320, TAP_MOVE = 14;

export function createSurface(host, opts) {
  const { board, settings, onStroke, onErase, onView, onUndo, onRedo, onPenSeen, onBegin } = opts;
  const main = document.createElement('canvas');
  const live = document.createElement('canvas');
  main.className = 'main';
  live.className = 'live';
  host.append(main, live);
  const mctx = main.getContext('2d', { alpha: false });
  const lctx = live.getContext('2d');

  let w = 0, h = 0, dpr = 1;
  let view = { x: 0, y: 0, z: 1 };
  let act = null;       // what's happening now: { kind: 'draw' | 'erase' | 'pan' | 'pinch', … }
  let hover = null;     // where the eraser circle shows when nothing is pressed
  let lastPen = -Infinity;
  let space = false;
  let tap = null;       // a possible two- or three-finger tap
  const fingers = new Map(); // touch pointers that are down: id -> { x, y, x0, y0 }
  let frame = 0, needMain = true, needLive = true;

  const now = () => performance.now();
  const fingersDraw = () => settings.fingers === 'draw' || (settings.fingers === 'auto' && !settings.penSeen);
  const toBoard = (x, y) => ({ x: view.x + x / view.z, y: view.y + y / view.z });
  function local(e) { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  // ---------- drawing ----------
  function request(mainToo = true) {
    if (mainToo) needMain = true;
    needLive = true;
    if (!frame) frame = requestAnimationFrame(paint);
  }
  function paint() {
    frame = 0;
    const b = board();
    if (!b) return;
    if (needMain) {
      needMain = false;
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBackground(mctx, b, view, w, h);
      const hidden = act?.kind === 'erase' ? act.gone : null;
      drawStrokes(mctx, hidden?.size ? b.strokes.filter(s => !hidden.has(s.id)) : b.strokes, b.bg, view, w, h, dpr);
    }
    if (needLive) { needLive = false; paintLive(b); }
  }
  function paintLive(b) {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, live.width, live.height);
    if (act?.kind === 'draw' && act.pts.length) {
      const pts = act.predicted?.length ? act.pts.concat(act.predicted) : act.pts;
      const s = { tool: act.tool, color: act.color, size: act.size, sim: act.sim, pts };
      lctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, -view.x * view.z * dpr, -view.y * view.z * dpr);
      lctx.globalAlpha = act.tool === 'marker' ? markerMode(b.bg).alpha : 1;
      lctx.fillStyle = shade(s, b.bg);
      lctx.fill(toPath2D(outline(s, false)));
      lctx.globalAlpha = 1;
    }
    const ring = act?.kind === 'erase' ? act.at : hover;
    if (ring) {
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.beginPath();
      lctx.arc(ring.x, ring.y, eraserRadius(ring.size), 0, Math.PI * 2);
      lctx.fillStyle = 'rgba(128, 128, 128, 0.12)';
      lctx.fill();
      lctx.lineWidth = 1.5;
      lctx.strokeStyle = 'rgba(110, 110, 110, 0.75)';
      lctx.stroke();
    }
  }
  const eraserRadius = size => SIZES.eraser[size ?? settings.eraser.size] / 2;

  function resize() {
    const r = host.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    const nd = Math.min(3, window.devicePixelRatio || 1);
    if (nw === w && nh === h && nd === dpr) return;
    // Keep the middle of the board in the middle when the screen turns.
    if (w && h) view = { x: view.x + (w - nw) / 2 / view.z, y: view.y + (h - nh) / 2 / view.z, z: view.z };
    w = nw; h = nh; dpr = nd;
    for (const c of [main, live]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    request();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  // ---------- the pen, a finger or the mouse, drawing or erasing ----------
  function startInk(e, erasing) {
    const p = local(e);
    try { host.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    onBegin?.();
    if (erasing) {
      act = { kind: 'erase', id: e.pointerId, type: e.pointerType, t0: now(), gone: new Set(), last: toBoard(p.x, p.y), at: { ...p, size: settings.eraser.size } };
      eraseTo(p);
    } else {
      const tool = settings.tool === 'marker' ? 'marker' : 'pen';
      const sim = e.pointerType !== 'pen';
      act = {
        kind: 'draw', id: e.pointerId, type: e.pointerType, t0: now(), tool, sim,
        color: settings[tool].color, size: SIZES[tool][settings[tool].size] / view.z, pts: [], predicted: null,
      };
      addPoint(e);
    }
    hover = null;
    request(false);
  }
  function addPoint(e) {
    const p = local(e), q = toBoard(p.x, p.y);
    const pr = act.sim ? 0.5 : Math.max(0.05, Math.min(1, e.pressure || 0.5));
    const n = act.pts.length;
    if (n >= 3 && Math.abs(act.pts[n - 3] - q.x) < 0.05 / view.z && Math.abs(act.pts[n - 2] - q.y) < 0.05 / view.z) return;
    act.pts.push(q.x, q.y, pr);
  }
  function eraseTo(p) {
    const b = board();
    const q = toBoard(p.x, p.y), r = eraserRadius() / view.z;
    let hit = false;
    for (const s of b.strokes) {
      if (act.gone.has(s.id)) continue;
      if (touches(s, act.last.x, act.last.y, q.x, q.y, r)) { act.gone.add(s.id); hit = true; }
    }
    act.last = q;
    act.at = { ...p, size: settings.eraser.size };
    request(hit);
  }
  function finishInk() {
    const a = act;
    act = null;
    if (a.kind === 'draw' && a.pts.length) onStroke(makeStroke(a));
    else if (a.kind === 'erase' && a.gone.size) onErase([...a.gone]);
    request(true);
  }
  function dropInk() { act = null; request(true); }

  // ---------- moving and zooming ----------
  function setView(v, quiet) {
    view = { x: v.x, y: v.y, z: clampZ(v.z) };
    request();
    if (!quiet) onView?.(view);
  }
  function zoomAt(px, py, z) {
    const q = toBoard(px, py), nz = clampZ(z);
    setView({ x: q.x - px / nz, y: q.y - py / nz, z: nz });
  }
  function startPan(e, p = local(e)) {
    try { host.setPointerCapture(e.pointerId); } catch { /* fine */ }
    act = { kind: 'pan', id: e.pointerId, type: e.pointerType, sx: p.x, sy: p.y, v0: { ...view } };
  }
  function startPinch() {
    const [a, b] = [...fingers.values()];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    act = { kind: 'pinch', m0: m, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), v0: { ...view } };
  }
  function pinchMove() {
    const [a, b] = [...fingers.values()];
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    const { v0, m0, d0 } = act;
    const z = clampZ(v0.z * d / d0);
    const qx = v0.x + m0.x / v0.z, qy = v0.y + m0.y / v0.z;
    setView({ x: qx - m.x / z, y: qy - m.y / z, z });
  }

  // ---------- pointer events ----------
  function down(e) {
    const p = local(e);
    if (e.pointerType === 'pen') {
      lastPen = now();
      if (!settings.penSeen) { settings.penSeen = true; onPenSeen?.(); }
      if (act && act.type === 'pen') return;
      if (act?.kind === 'draw' || act?.kind === 'erase') dropInk(); // a palm got there first
      act = null;
      fingers.clear();
      tap = null;
      const erasing = settings.tool === 'eraser' || (e.buttons & 32) || e.button === 5 || (e.buttons & 2);
      startInk(e, !!erasing);
      return;
    }
    if (e.pointerType === 'touch') {
      if (act?.type === 'pen' || now() - lastPen < PALM_AFTER_PEN) return;
      // Once there's a pen, a touch far bigger than a fingertip is the side of a hand.
      if (settings.penSeen && settings.fingers !== 'draw' && Math.max(e.width || 0, e.height || 0) > PALM_SIZE) return;
      fingers.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y });
      if (fingers.size === 1) {
        tap = { n: 1, t0: now(), moved: false };
        if (fingersDraw()) startInk(e, settings.tool === 'eraser'); else startPan(e, p);
      } else {
        if (tap) tap.n = now() - tap.t0 < 250 ? Math.max(tap.n, fingers.size) : 0;
        if (act?.kind === 'draw' || act?.kind === 'erase') {
          // A second finger soon after the first: it was the start of a pinch, not a line.
          if (now() - act.t0 < 300) dropInk(); else finishInk();
        }
        if (fingers.size === 2 || act?.kind !== 'pinch') startPinch();
      }
      return;
    }
    // A mouse: the left button draws, the middle or right button (or Space held down) moves the board.
    if (act) return;
    if (e.button === 1 || e.button === 2 || space) { e.preventDefault(); startPan(e, p); }
    else if (e.button === 0) startInk(e, settings.tool === 'eraser');
  }

  function move(e) {
    const p = local(e);
    if (e.pointerType === 'pen') lastPen = now();
    if (act && act.id === e.pointerId && (act.kind === 'draw' || act.kind === 'erase')) {
      const events = e.getCoalescedEvents?.() || [];
      const list = events.length ? events : [e];
      if (act.kind === 'draw') {
        for (const ce of list) addPoint(ce);
        const pred = e.getPredictedEvents?.() || [];
        act.predicted = pred.length ? pred.slice(0, 2).flatMap(pe => { const q = local(pe), b = toBoard(q.x, q.y); return [b.x, b.y, act.pts[act.pts.length - 1]]; }) : null;
        request(false);
      } else {
        for (const ce of list) eraseTo(local(ce));
      }
      return;
    }
    if (e.pointerType === 'touch' && fingers.has(e.pointerId)) {
      const f = fingers.get(e.pointerId);
      f.x = p.x; f.y = p.y;
      if (tap && Math.hypot(f.x - f.x0, f.y - f.y0) > TAP_MOVE) tap.moved = true;
      if (act?.kind === 'pinch' && fingers.size >= 2) pinchMove();
      else if (act?.kind === 'pan' && act.id === e.pointerId) setView({ x: act.v0.x - (p.x - act.sx) / view.z, y: act.v0.y - (p.y - act.sy) / view.z, z: view.z });
      return;
    }
    if (act?.kind === 'pan' && act.id === e.pointerId) {
      setView({ x: act.v0.x - (p.x - act.sx) / view.z, y: act.v0.y - (p.y - act.sy) / view.z, z: view.z });
      return;
    }
    // Hovering: the eraser shows where it would rub.
    const erasingHover = settings.tool === 'eraser' || (e.pointerType === 'pen' && (e.buttons & 32));
    if (!act && e.pointerType !== 'touch' && erasingHover) { hover = { ...p, size: settings.eraser.size }; request(false); }
    else if (hover) { hover = null; request(false); }
  }

  function up(e, cancelled) {
    if (act && act.id === e.pointerId && (act.kind === 'draw' || act.kind === 'erase')) {
      if (e.pointerType === 'pen') lastPen = now();
      if (cancelled && e.pointerType === 'touch') dropInk(); else finishInk();
    } else if (act?.kind === 'pan' && act.id === e.pointerId && e.pointerType !== 'touch') {
      act = null;
    }
    if (e.pointerType !== 'touch' || !fingers.has(e.pointerId)) return;
    fingers.delete(e.pointerId);
    if (act?.kind === 'pinch' && fingers.size === 1) {
      // Back to one finger: carry on moving the board with it, from where it is now.
      const [[id, f]] = [...fingers.entries()];
      act = { kind: 'pan', id, type: 'touch', sx: f.x, sy: f.y, v0: { ...view } };
    } else if (act?.kind === 'pinch' && fingers.size >= 2) {
      startPinch();
    }
    if (!fingers.size) {
      if (act?.kind === 'pan' || act?.kind === 'pinch') act = null;
      if (tap && !tap.moved && !cancelled && now() - tap.t0 < TAP_MS) {
        if (tap.n === 2) onUndo?.(); else if (tap.n === 3) onRedo?.();
      }
      tap = null;
    }
  }

  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', e => up(e, false));
  host.addEventListener('pointercancel', e => up(e, true));
  host.addEventListener('pointerleave', e => { if (hover && e.pointerType !== 'touch') { hover = null; request(false); } });
  host.addEventListener('contextmenu', e => e.preventDefault());
  // Safari's own pinch-zoom of the page, which would zoom the toolbar along with the board.
  for (const g of ['gesturestart', 'gesturechange']) document.addEventListener(g, e => e.preventDefault(), { passive: false });

  // A trackpad or a mouse wheel: scroll moves the board; pinching the trackpad (or Ctrl + wheel) zooms.
  host.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? h : 1;
    const p = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(p.x, p.y, view.z * Math.exp(-e.deltaY * k * 0.01));
    else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      setView({ x: view.x + dx * k / view.z, y: view.y + dy * k / view.z, z: view.z });
    }
  }, { passive: false });

  return {
    canvas: main,
    get view() { return { ...view }; },
    get busy() { return !!act; },
    get size() { return { w, h }; },
    setSpace(on) { space = on; },
    setView,
    redraw: () => request(true),
    // Back to 100%, keeping the middle of the screen where it is.
    zoomTo(z) { zoomAt(w / 2, h / 2, z); },
    zoomBy(k) { zoomAt(w / 2, h / 2, view.z * k); },
    fit() { const b = board(); setView(b.strokes.length ? fitView(b, w, h, Math.min(w, h) * 0.08, 2) : { x: 0, y: 0, z: 1 }); },
    // Stop whatever's in progress, without keeping it (opening another board, say).
    cancel() { act = null; fingers.clear(); tap = null; request(true); },
  };
}
