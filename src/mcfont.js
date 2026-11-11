// Text in the game's own font, drawn from its glyph sheet (public/mc/font/ascii.png,
// copied from a local Minecraft install by tools/build-doors.mjs): 16x16 cells,
// one per character code, each glyph as wide as its pixels plus a one-pixel gap.

const BASE = import.meta.env.BASE_URL;
const SPACE = 3; // width of a space, in glyph pixels

let sheet; // promise of {img, cell, widths}, or of null when the sheet is not there
function loadSheet() {
  sheet ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const cell = img.width / 16;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = img.width;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.width);
      const widths = new Array(256).fill(0);
      for (let code = 0; code < 256; code++) {
        const x0 = (code % 16) * cell, y0 = Math.floor(code / 16) * cell;
        for (let x = cell - 1; x >= 0 && !widths[code]; x--) {
          for (let y = 0; y < cell; y++) {
            if (data[((y0 + y) * img.width + x0 + x) * 4 + 3]) { widths[code] = x + 1; break; }
          }
        }
      }
      widths[32] = SPACE;
      resolve({ img, cell, widths });
    };
    img.onerror = () => resolve(null);
    img.src = `${BASE}mc/font/ascii.png`;
  });
  return sheet;
}

// Resolves to a canvas showing `text`, `scale` screen pixels per glyph pixel, with
// the game's one-pixel drop shadow. Resolves to null when the font is not built
// or the text has a character the sheet lacks: the caller keeps its plain text.
export async function mcText(text, { color = '#ffffff', shadow = 'rgba(0, 0, 0, 0.5)', scale = 2 } = {}) {
  const font = await loadSheet();
  if (!font || !text) return null;
  const codes = [...text].map((c) => c.charCodeAt(0));
  if (codes.some((c) => c > 255 || !font.widths[c])) return null;
  const { img, cell, widths } = font;
  const width = codes.reduce((sum, c) => sum + widths[c] + 1, 0) - 1;

  const glyphs = document.createElement('canvas');
  glyphs.width = width;
  glyphs.height = cell;
  const g = glyphs.getContext('2d');
  let x = 0;
  for (const c of codes) {
    if (c !== 32) g.drawImage(img, (c % 16) * cell, Math.floor(c / 16) * cell, widths[c], cell, x, 0, widths[c], cell);
    x += widths[c] + 1;
  }
  // The sheet is white: colour it by keeping its shape and filling it.
  const inked = (fill) => {
    const layer = document.createElement('canvas');
    layer.width = width;
    layer.height = cell;
    const l = layer.getContext('2d');
    l.drawImage(glyphs, 0, 0);
    l.globalCompositeOperation = 'source-in';
    l.fillStyle = fill;
    l.fillRect(0, 0, width, cell);
    return layer;
  };

  // Capitals fill the top seven rows of a cell and the shadow adds one below.
  // One empty row on top makes the box as tall above the letters as below
  // them, so centring the canvas centres the letters.
  const canvas = document.createElement('canvas');
  canvas.width = width + 1;
  canvas.height = cell + 2;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(inked(shadow), 1, 2);
  ctx.drawImage(inked(color), 0, 1);
  canvas.className = 'mc-text';
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', text);
  return canvas;
}

// A sheet of the font in one colour, made once per colour.
const tinted = new Map();
function inkedSheet(font, color) {
  let sheet = tinted.get(color);
  if (sheet) return sheet;
  sheet = document.createElement('canvas');
  sheet.width = sheet.height = font.img.width;
  const ctx = sheet.getContext('2d');
  ctx.drawImage(font.img, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  tinted.set(color, sheet);
  return sheet;
}

// The game shades every letter with its own colour at a quarter strength.
function shadeOf(color) {
  const n = parseInt(color.slice(1), 16);
  return `rgb(${(n >> 16) >> 2}, ${((n >> 8) & 255) >> 2}, ${(n & 255) >> 2})`;
}

// A chat message: runs of text in different colours ([{text, color: '#rrggbb'}]),
// wrapped to maxWidth screen pixels the way the game wraps chat. Resolves to a
// canvas, or to null when the font is not there (see mcText).
export async function mcMessage(runs, { maxWidth = 600, scale = 2 } = {}) {
  const font = await loadSheet();
  if (!font) return null;
  const { cell, widths } = font;
  const LINE = cell + 1;
  // Words keep their colour; a space belongs to the word in front of it.
  const words = [];
  for (const { text, color } of runs) {
    for (const part of text.match(/\S+\s*|\s+/g) ?? []) {
      const codes = [...part].map((c) => c.charCodeAt(0));
      if (codes.some((c) => c > 255 || !widths[c])) return null;
      const solid = part.trimEnd().length;
      words.push({
        codes, color,
        width: codes.reduce((sum, c) => sum + widths[c] + 1, 0),
        inked: codes.slice(0, solid).reduce((sum, c) => sum + widths[c] + 1, 0),
      });
    }
  }
  const limit = Math.max(40, Math.floor(maxWidth / scale));
  const lines = [[]];
  let x = 0;
  for (const word of words) {
    if (x > 0 && x + word.inked > limit) { lines.push([]); x = 0; }
    lines[lines.length - 1].push({ word, x });
    x += word.width;
  }
  const width = Math.max(...lines.map((line) => { const last = line[line.length - 1]; return last ? last.x + last.word.inked : 0; }));

  const canvas = document.createElement('canvas');
  canvas.width = width + 1;
  canvas.height = lines.length * LINE + 1;
  const ctx = canvas.getContext('2d');
  const draw = (shade) => {
    lines.forEach((line, row) => {
      for (const { word, x: x0 } of line) {
        const sheet = inkedSheet(font, shade ? shadeOf(word.color) : word.color);
        let at = x0;
        for (const c of word.codes) {
          if (c !== 32) ctx.drawImage(sheet, (c % 16) * cell, Math.floor(c / 16) * cell, widths[c], cell, at + (shade ? 1 : 0), row * LINE + (shade ? 2 : 1), widths[c], cell);
          at += widths[c] + 1;
        }
      }
    });
  };
  draw(true);
  draw(false);
  canvas.className = 'mc-text';
  canvas.style.width = `${canvas.width * scale}px`;
  canvas.style.height = `${canvas.height * scale}px`;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', runs.map((r) => r.text).join(''));
  return canvas;
}

