// Progress map: reads the project sheet straight from Google Sheets and draws
// all 512 figures as one grid, coloured by status.

const SHEET_ID = '15XN6HaKvy0qAyVm7o3qg_iq_7kd_Ejh84goYQPRnSJE';
const SHEET_CSV = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;

// Sheet statuses folded into the three the map shows. Anything else is free.
const GROUP_OF = {
  completed: 'built', 'partially setup': 'built', migrated: 'built',
  reserved: 'wip', unknown: 'wip',
};
// Head renders by player name.
const HEAD_URL = (name) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/32`;
const NOTE_COMMAND = /(?:^|\s)(\/[a-z]+\s[^\n]*)/i;

// Where the door can be seen right now. A completed door still stands on its
// builder's plot (the note holds that command); once migrated it is on the
// showcase plot.
function teleport(status, { showcase, reference, note }) {
  const s = status.toLowerCase();
  if (s === 'migrated' || s === 'partially setup') return showcase ? { where: 'Showcase plot', cmd: showcase } : null;
  if (s !== 'completed') return null;
  const own = note.match(NOTE_COMMAND)?.[1].trim();
  if (own) return { where: "Builder's plot", cmd: own };
  return reference ? { where: 'Reference plot', cmd: reference } : null;
}
const GROUPS = {
  built: { label: 'built', color: '#1fa5a1' },
  wip: { label: 'in progress', color: '#e8a52b' },
  free: { label: 'free', color: '#b9b3a6' },
};
const OFF = 'rgba(28, 37, 54, 0.07)';
const INK = '#1c2536';
const COLS = 32;
const ROWS = 16;

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function loadDoors() {
  const res = await fetch(SHEET_CSV);
  if (!res.ok) throw new Error(`Sheet responded with ${res.status}`);
  const [header, ...rows] = parseCsv(await res.text());
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const at = {
    door: col('door'), builder: col('builder'), status: col('status'),
    showcase: col('showcase plot'), reference: col('reference plot'), note: col('note'),
  };
  if (at.door < 0 || at.status < 0) throw new Error('Sheet has no Door or Status column');
  const doors = new Array(512).fill(null);
  for (const r of rows) {
    const bits = (r[at.door] ?? '').replace(/[^01]/g, '');
    if (bits.length !== 9) continue;
    const cell = (i) => (r[i] ?? '').trim();
    const status = cell(at.status);
    doors[parseInt(bits, 2)] = {
      bits,
      builders: cell(at.builder).split(',').map((b) => b.trim()).filter(Boolean),
      status,
      group: GROUP_OF[status.toLowerCase()] ?? 'free',
      tp: teleport(status, { showcase: cell(at.showcase), reference: cell(at.reference), note: cell(at.note) }),
    };
  }
  return doors.map((d, i) => d ?? { bits: i.toString(2).padStart(9, '0'), builders: [], status: 'Missing', group: 'free', tp: null });
}

// The sheet is read once and shared by the map and the caption under the door.
let sheet;
export const loadSheet = () => (sheet ??= loadDoors());

export function fillGlyph(el, bits) {
  el.replaceChildren(...[...bits].map((b) => Object.assign(document.createElement('i'), { className: b === '1' ? 'on' : '' })));
}

export const spaced = (bits) => bits.replace(/(...)(?=.)/g, '$1 ');

function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// A nickname with the player's head in front of it.
export function player(name) {
  const head = /^\w{1,16}$/.test(name)
    ? el('img', { className: 'head', src: HEAD_URL(name), alt: '', width: 16, height: 16 })
    : el('span', { className: 'head' });
  head.addEventListener?.('error', () => head.removeAttribute('src'));
  return el('span', { className: 'player' }, head, name);
}

function byline(d) {
  const status = d.status.toLowerCase();
  if (d.group === 'free') return [status.includes('abandoned') ? 'Free again, someone dropped it.' : "Free, nobody's on it."];
  const lead = d.group === 'built' ? 'Built' : status === 'reserved' ? 'Reserved' : 'Unconfirmed,';
  if (!d.builders.length) return [d.group === 'built' ? 'Built, builder unknown' : lead.replace(',', '')];
  return [`${lead} by `, ...d.builders.flatMap((b, i) => (i ? [', ', player(b)] : [player(b)]))];
}

// Sets up the progress section. `current` is the figure playing in the scene.
// Resolves to {select(bits)} for following the scene, or to nothing when the
// sheet did not load.
export async function initProgress({ current }) {
  const count = document.querySelector('#count');
  const title = document.querySelector('#progress-title');
  const legend = document.querySelector('#legend');
  const map = document.querySelector('#map');
  const detail = document.querySelector('#detail');

  let doors;
  try {
    doors = await loadSheet();
  } catch (err) {
    console.error(err);
    title.textContent = 'The sheet did not load';
    detail.classList.add('is-message');
    detail.textContent = 'Check your connection and reload the page. The numbers come straight from the project sheet.';
    return;
  }

  const totals = { built: 0, wip: 0, free: 0 };
  for (const d of doors) totals[d.group]++;
  count.textContent = `${totals.built} / 512`;
  title.textContent = `${totals.built} of 512 built`;
  legend.replaceChildren(...Object.entries(GROUPS).map(([key, g]) => {
    const li = document.createElement('li');
    li.style.setProperty('--swatch', g.color);
    li.textContent = `${totals[key]} ${g.label}`;
    return li;
  }));

  let selected = current ? parseInt(current, 2) : 0;
  let cell = 0;

  function draw() {
    const width = map.clientWidth;
    if (!width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cell = width / COLS;
    const height = cell * ROWS;
    map.style.height = `${height}px`;
    map.width = Math.round(width * dpr);
    map.height = Math.round(height * dpr);
    const ctx = map.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sub = Math.max(1, Math.floor(((cell * 0.8) / 3) * dpr) / dpr);
    const pad = (cell - sub * 3) / 2;
    doors.forEach((d, i) => {
      const x0 = (i % COLS) * cell + pad, y0 = Math.floor(i / COLS) * cell + pad;
      for (let k = 0; k < 9; k++) {
        ctx.fillStyle = d.bits[k] === '1' ? GROUPS[d.group].color : OFF;
        ctx.fillRect(x0 + (k % 3) * sub, y0 + Math.floor(k / 3) * sub, sub, sub);
      }
    });
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.strokeRect((selected % COLS) * cell + 0.75, Math.floor(selected / COLS) * cell + 0.75, cell - 1.5, cell - 1.5);
  }

  function showDetail() {
    const d = doors[selected];
    const glyph = el('span', { className: 'glyph' });
    glyph.style.setProperty('--tone', d.group === 'free' ? INK : GROUPS[d.group].color);
    fillGlyph(glyph, d.bits);
    const code = el('span', { className: 'code' }, spaced(d.bits));
    const who = el('span', { className: 'who' }, ...byline(d));
    // The last two rows are always there, so the block keeps its height.
    const where = el('span', { className: 'where' }, d.tp?.where ?? '');
    const tp = el('div', { className: 'tp' });
    if (d.tp) {
      const copy = el('button', { className: 'copy', type: 'button' }, 'Copy');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(d.tp.cmd); copy.textContent = 'Copied'; }
        catch { copy.textContent = 'Select it'; }
      });
      tp.append(el('code', {}, d.tp.cmd), copy);
    }
    detail.replaceChildren(glyph, code, who, where, tp);
  }

  function pick(e) {
    const box = map.getBoundingClientRect();
    const cx = Math.floor((e.clientX - box.left) / cell), cy = Math.floor((e.clientY - box.top) / cell);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return;
    const i = cy * COLS + cx;
    if (i === selected) return;
    selected = i;
    draw();
    showDetail();
  }
  map.addEventListener('pointerdown', (e) => {
    pick(e);
    // Capture keeps a finger drag on the map; it is a nicety, never required.
    try { map.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });
  map.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || e.buttons) pick(e); });

  new ResizeObserver(draw).observe(map);
  draw();
  showDetail();

  return {
    select(bits) {
      const i = parseInt(bits, 2);
      if (Number.isNaN(i) || i === selected) return;
      selected = i;
      draw();
      showDetail();
    },
  };
}
