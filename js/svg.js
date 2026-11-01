// A board as an SVG file: a picture that opens anywhere (Google Drive shows it), with the board itself tucked inside
// so Clean Slate can open it again and carry on drawing. The same file is the Drive copy and the "Download SVG".
import { BACKGROUNDS, SPACING, shade, shareable, cleanBoard } from './board.js';
import { outline, pathData, contentBounds, markerMode } from './ink.js';

const MARK = 'clean-slate-board';
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON with nothing XML would read as markup, so it can sit in the file as plain text.
const safeJSON = o => JSON.stringify(o).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export function toSVG(board, { margin = 40 } = {}) {
  const c = contentBounds(board.strokes) || { x0: 0, y0: 0, x1: 800, y1: 600 };
  const x = Math.floor(c.x0 - margin), y = Math.floor(c.y0 - margin);
  const w = Math.ceil(c.x1 + margin) - x, h = Math.ceil(c.y1 + margin) - y;
  const look = BACKGROUNDS[board.bg] || BACKGROUNDS.white;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`,
    `<title>${xml(board.name)}</title>`,
    `<metadata id="${MARK}">${safeJSON({ cleanSlate: 1, board: shareable(board) })}</metadata>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${look.bg}"/>`,
  ];
  if (board.pattern !== 'blank') {
    const S = SPACING;
    const lines = board.pattern === 'grid' ? `M0 0H${S}M0 0V${S}` : `M0 0H${S}`;
    const mark = board.pattern === 'dots'
      ? `<circle cx="0" cy="0" r="1.3" fill="${look.dot}"/><circle cx="${S}" cy="0" r="1.3" fill="${look.dot}"/><circle cx="0" cy="${S}" r="1.3" fill="${look.dot}"/><circle cx="${S}" cy="${S}" r="1.3" fill="${look.dot}"/>`
      : `<path d="${lines}" stroke="${look.line}" stroke-width="1" fill="none"/>`;
    out.push(`<defs><pattern id="p" width="${S}" height="${S}" patternUnits="userSpaceOnUse">${mark}</pattern></defs>`,
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#p)"/>`);
  }
  const m = markerMode(board.bg);
  for (const s of board.strokes) {
    const d = pathData(outline(s));
    if (!d) continue;
    const extra = s.tool === 'marker' ? (m.op === 'multiply' ? ' style="mix-blend-mode:multiply"' : ` fill-opacity="${m.alpha}"`) : '';
    out.push(`<path d="${d}" fill="${shade(s, board.bg)}"${extra}/>`);
  }
  out.push('</svg>');
  return out.join('\n');
}

// The board inside a Clean Slate SVG (or a plain board file), or null if the text isn't one.
export function fromSVG(text) {
  const m = new RegExp(`<metadata id="${MARK}">([\\s\\S]*?)</metadata>`).exec(String(text));
  let o = null;
  try { o = JSON.parse(m ? m[1] : text); } catch { return null; }
  return o && o.cleanSlate ? cleanBoard(o.board) : null;
}
