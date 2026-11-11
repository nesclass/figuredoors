// Turns raw doorrec recordings (recordings/<id>/{close,open}.json) into compact
// door files for the site (public/doors/<id>.json + public/doors/index.json).
//
// What it does:
//   - trims the idle ticks before the lever is flipped and after the door settles
//   - unifies builder-specific blocks into a small shared vocabulary
//     (door / casing / input / glass + redstone components)
//   - separates static block states from blocks that are being moved by pistons
//
// Optional recordings/<id>/door.json:
//   {"lever": {"at": [x, y, z], "face": "wall", "facing": "north"}}
//   adds a lever the recording box missed (coordinates relative to the box
//   origin, may lie outside it). It flips on the first tick of each clip and is
//   on while the door is closed.
//   {"carousel": false}
//   keeps the door out of the carousel (a test, a joke door).
//   {"remove": ["magenta_stained_glass"]}
//   drops blocks that stood in the box but are not part of the door (a roof,
//   plot decoration). Layers left empty on the outside are cut off.
//
// Output door file:
//   size     [sx, sy, sz]; cell index = x + sx * (z + sz * y)
//   front    direction the viewer was facing while recording ("south" = looking at +z)
//   palette  [{name, props?}]
//   clips    {close, open}, each {start: [state per cell], ticks: [{set, mov}]}
//            set  flat [cell, state, cell, state, ...] - static changes of this tick
//            mov  [[cell, state, dir, extending, progress, source], ...] - blocks in motion
//                 dir: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east (piston facing)

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAssets, createResolver } from './mc-assets.mjs';
import { softLook, softerLook } from './soft-look.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REC_DIR = join(ROOT, 'recordings');
const OUT_DIR = join(ROOT, 'public', 'doors');
// Game looks: the same doors with the game's own blocks, models and textures,
// plain or with a resource pack on top. Built only where a Minecraft install is
// found; see tools/mc-assets.mjs.
const MC_DIR = join(ROOT, 'public', 'mc');

// ---- block unification -------------------------------------------------------

const AIR = new Set(['air', 'cave_air', 'void_air']);

// Blocks builders use for the figure itself.
const DOOR_BLOCKS = new Set([
  'quartz_block', 'smooth_quartz', 'white_concrete', 'white_wool', 'white_terracotta',
  'snow_block', 'iron_block', 'calcite', 'diorite', 'polished_diorite',
]);

// Plain full blocks that only hold redstone in place: all become "casing".
const CASING_RE = /(_concrete|_concrete_powder|_wool|_terracotta|_planks|bricks|_wood|_log)$/;
const CASING_BLOCKS = new Set([
  'stone', 'cobblestone', 'smooth_stone', 'deepslate', 'cobbled_deepslate', 'andesite',
  'polished_andesite', 'granite', 'polished_granite', 'dirt', 'sandstone', 'smooth_sandstone',
  'gold_block', 'diamond_block', 'emerald_block', 'lapis_block', 'copper_block', 'netherrack',
]);

// Properties the renderer cares about; everything else is dropped so that
// states that look the same share one palette entry.
const KEEP_PROPS = {
  piston: ['facing', 'extended'],
  sticky_piston: ['facing', 'extended'],
  piston_head: ['facing', 'type'],
  observer: ['facing', 'powered'],
  note_block: ['powered'],
  copper_bulb: ['lit'],
  repeater: ['facing', 'delay', 'powered', 'locked'],
  comparator: ['facing', 'mode', 'powered'],
  redstone_wire: ['east', 'west', 'north', 'south', 'power'],
  lever: ['face', 'facing', 'powered'],
  redstone_torch: ['lit'],
  redstone_wall_torch: ['facing', 'lit'],
  redstone_lamp: ['lit'],
  redstone_block: [],
  furnace: ['facing', 'lit'],
  composter: ['level'],
  hopper: ['facing'],
  bell: ['facing', 'attachment'],
  slab: ['type'],
  target: [],
  tnt: [],
  leaves: [],
  crying_obsidian: [],
  obsidian: [],
  dropper: ['facing'],
  rail: ['shape'],
  powered_rail: ['shape', 'powered'],
  detector_rail: ['shape', 'powered'],
  lightning_rod: ['facing', 'powered'],
  fence: ['east', 'west', 'north', 'south'],
  door: [], casing: [], input: [], glass: [],
};

function unifyName(rawName) {
  const name = rawName.replace(/^minecraft:/, '');
  if (AIR.has(name)) return 'air';
  if (DOOR_BLOCKS.has(name)) return 'door';
  if (name === 'glass' || name.endsWith('_glass')) return 'glass';
  if (name.endsWith('copper_bulb')) return 'copper_bulb';
  if (name.endsWith('_fence')) return 'fence';
  if (name.endsWith('_slab')) return 'slab';
  if (name.endsWith('_leaves')) return 'leaves';
  if (name.endsWith('lightning_rod')) return 'lightning_rod';
  if (CASING_RE.test(name) || CASING_BLOCKS.has(name)) return 'casing';
  return name;
}

function unifyState(rawName, rawProps, isInput) {
  let name = unifyName(rawName);
  if (isInput && name === 'casing') name = 'input';
  const keep = KEEP_PROPS[name];
  const props = {};
  for (const [k, v] of Object.entries(rawProps ?? {})) {
    if (!keep || keep.includes(k)) props[k] = String(v);
  }
  return Object.keys(props).length ? { name, props } : { name };
}

// The "mc" look keeps every block as it was recorded.
function exactState(rawName, rawProps) {
  const name = rawName.replace(/^minecraft:/, '');
  if (AIR.has(name)) return { name: 'air' };
  const props = {};
  for (const [k, v] of Object.entries(rawProps ?? {})) props[k] = String(v);
  return Object.keys(props).length ? { name, props } : { name };
}

// ---- recording -> clip -------------------------------------------------------

const FACING_VEC = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};

const num = (v) => (typeof v === 'number' ? v : parseFloat(v));

function readRecording(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  if (rec.format !== 1) throw new Error(`${file}: unknown recording format ${rec.format}`);
  const [sx, sy, sz] = rec.size;
  const cells = sx * sy * sz;
  const byTick = new Map(rec.frames.map((f) => [f.t, f.changes]));
  const snapshots = [];
  const cur = new Int32Array(cells).fill(-1);
  for (let t = 0; t <= rec.ticks; t++) {
    const ch = byTick.get(t) ?? [];
    for (let i = 0; i < ch.length; i += 2) cur[ch[i]] = ch[i + 1];
    snapshots.push(cur.slice());
  }
  if (snapshots[0].includes(-1)) throw new Error(`${file}: first frame does not cover the whole box`);
  const changeTicks = rec.frames.map((f) => f.t).filter((t) => t > 0);
  if (!changeTicks.length) throw new Error(`${file}: nothing changed during the recording`);
  return {
    size: rec.size, palette: rec.palette, viewer: rec.viewer, snapshots,
    first: changeTicks[0], last: changeTicks[changeTicks.length - 1],
  };
}

// Grows the box so it contains `lever.at` and puts a lever there that flips on
// the first tick of the clip.
function addLever(data, lever, startsPowered) {
  const [sx, sy, sz] = data.size;
  const at = lever.at;
  const lo = at.map((v) => Math.min(0, v));
  const hi = at.map((v, k) => Math.max(data.size[k] - 1, v));
  const size = hi.map((v, k) => v - lo[k] + 1);
  const palette = data.palette.slice();
  const add = (state) => palette.push(state) - 1;
  const air = add({ name: 'air' });
  const props = (powered) => ({ face: lever.face ?? 'wall', facing: lever.facing ?? 'north', powered: String(powered) });
  const before = add({ name: 'lever', props: props(startsPowered) });
  const after = add({ name: 'lever', props: props(!startsPowered) });
  const index = (x, y, z) => (x - lo[0]) + size[0] * ((z - lo[2]) + size[2] * (y - lo[1]));
  const leverCell = index(...at);
  const snapshots = data.snapshots.map((old, t) => {
    const grown = new Int32Array(size[0] * size[1] * size[2]).fill(air);
    old.forEach((s, i) => { grown[index(i % sx, Math.floor(i / (sx * sz)), Math.floor(i / sx) % sz)] = s; });
    grown[leverCell] = t >= data.first ? after : before;
    return grown;
  });
  return { ...data, size, palette, snapshots };
}

// The block a lever is attached to is the door's input; it keeps its own look.
function findInputCells(data, snapshot) {
  const [sx, sy, sz] = data.size;
  const out = new Set();
  snapshot.forEach((s, i) => {
    const st = data.palette[s];
    if (st.name !== 'lever') return;
    const x = i % sx, z = Math.floor(i / sx) % sz, y = Math.floor(i / (sx * sz));
    const face = st.props?.face ?? 'wall';
    const f = FACING_VEC[st.props?.facing ?? 'north'];
    const [ax, ay, az] = face === 'floor' ? [x, y - 1, z] : face === 'ceiling' ? [x, y + 1, z] : [x - f[0], y - f[1], z - f[2]];
    if (ax < 0 || ay < 0 || az < 0 || ax >= sx || ay >= sy || az >= sz) return;
    out.add(ax + sx * (az + sz * ay));
  });
  return out;
}

function buildClip(file, intern, meta, startsPowered, toState) {
  let data = readRecording(file);
  if (meta.remove) {
    const gone = new Set(meta.remove);
    data.palette = data.palette.map((p) => (gone.has(p.name.replace(/^minecraft:/, '')) ? { name: 'air' } : p));
  }
  if (meta.lever) data = addLever(data, meta.lever, startsPowered);
  const { snapshots, first, last } = data;
  const inputCells = findInputCells(data, snapshots[0]);
  const airId = intern({ name: 'air' });

  const convert = (snapshot) => {
    const statics = new Array(snapshot.length);
    const mov = [];
    snapshot.forEach((s, i) => {
      const st = data.palette[s];
      if (st.name !== 'moving_piston') {
        statics[i] = intern(toState(st.name, st.props, inputCells.has(i)));
        return;
      }
      statics[i] = airId;
      const nbt = st.nbt;
      if (!nbt?.blockState) return;
      const carried = intern(toState(nbt.blockState.Name, nbt.blockState.Properties, false));
      mov.push([i, carried, num(nbt.facing), num(nbt.extending) ? 1 : 0, num(nbt.progress), num(nbt.source) ? 1 : 0]);
    });
    return { statics, mov };
  };

  const t0 = Math.max(0, first - 1);
  let prev = convert(snapshots[t0]);
  if (prev.mov.length) throw new Error(`${file}: blocks are already moving at the start of the clip`);
  const start = prev.statics;
  const ticks = [];
  for (let t = t0 + 1; t <= last; t++) {
    const now = convert(snapshots[t]);
    const set = [];
    now.statics.forEach((s, i) => { if (s !== prev.statics[i]) set.push(i, s); });
    ticks.push({ set, mov: now.mov });
    prev = now;
  }
  if (prev.mov.length) throw new Error(`${file}: blocks are still moving at the end of the clip`);
  return { clip: { start, ticks }, end: prev.statics, data };
}

// Shrinks the box to the cells that ever hold a block, so the camera frames the
// door and not the air around it.
function cropToContent(size, clips, airId) {
  const [sx, , sz] = size;
  const xyz = (i) => [i % sx, Math.floor(i / (sx * sz)), Math.floor(i / sx) % sz];
  const lo = [Infinity, Infinity, Infinity], hi = [-1, -1, -1];
  const mark = (i) => xyz(i).forEach((v, k) => { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); });
  for (const clip of clips) {
    clip.start.forEach((s, i) => { if (s !== airId) mark(i); });
    for (const { set, mov } of clip.ticks) {
      for (let i = 0; i < set.length; i += 2) if (set[i + 1] !== airId) mark(set[i]);
      for (const m of mov) mark(m[0]);
    }
  }
  const out = hi.map((v, k) => v - lo[k] + 1);
  if (out.every((v, k) => v === size[k])) return size;
  const inside = (p) => p.every((v, k) => v >= lo[k] && v <= hi[k]);
  const move = (i) => { const [x, y, z] = xyz(i); return (x - lo[0]) + out[0] * ((z - lo[2]) + out[2] * (y - lo[1])); };
  for (const clip of clips) {
    const start = new Array(out[0] * out[1] * out[2]);
    clip.start.forEach((s, i) => { if (inside(xyz(i))) start[move(i)] = s; });
    clip.start = start;
    for (const tick of clip.ticks) {
      const set = [];
      for (let i = 0; i < tick.set.length; i += 2) if (inside(xyz(tick.set[i]))) set.push(move(tick.set[i]), tick.set[i + 1]);
      tick.set = set;
      for (const m of tick.mov) m[0] = move(m[0]);
    }
  }
  return out;
}

// ---- main --------------------------------------------------------------------

function buildDoor(id, exact = false) {
  const toState = exact ? exactState : unifyState;
  const dir = join(REC_DIR, id);
  const palette = [];
  const index = new Map();
  const intern = (state) => {
    const key = JSON.stringify([state.name, Object.entries(state.props ?? {}).sort()]);
    if (!index.has(key)) { index.set(key, palette.length); palette.push(state); }
    return index.get(key);
  };

  const metaFile = join(dir, 'door.json');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const close = buildClip(join(dir, 'close.json'), intern, meta, false, toState);
  const open = buildClip(join(dir, 'open.json'), intern, meta, true, toState);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (String(close.data.size) !== String(open.data.size)) throw new Error(`${id}: close and open were recorded with different boxes`);
  if (!exact && !same(close.end, open.clip.start)) console.warn(`  ! ${id}: end of "close" differs from start of "open"`);
  if (!exact && !same(open.end, close.clip.start)) console.warn(`  ! ${id}: end of "open" differs from start of "close"`);

  const known = new Set(Object.keys(KEEP_PROPS).concat('air'));
  const unknown = [...new Set(palette.map((p) => p.name).filter((n) => !known.has(n)))];
  if (!exact && unknown.length) console.warn(`  ! ${id}: blocks without unification rules: ${unknown.join(', ')}`);

  const size = cropToContent(close.data.size, [close.clip, open.clip], intern({ name: 'air' }));

  return {
    id,
    size,
    front: close.data.viewer?.facing ?? 'south',
    palette,
    clips: { close: close.clip, open: open.clip },
  };
}

mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) if (f.endsWith('.json')) rmSync(join(OUT_DIR, f));
// One look per set of assets: the plain game ("vanilla") and every unpacked
// resource pack found in packs/<name>/.
const PACK_DIR = join(ROOT, 'packs');
const assets = openAssets(join(ROOT, '.cache', 'mc'));
const looks = [];
if (assets) {
  looks.push({ name: 'vanilla', resolver: createResolver(assets) });
  for (const name of existsSync(PACK_DIR) ? readdirSync(PACK_DIR).sort() : []) {
    const pack = join(PACK_DIR, name);
    if (existsSync(join(pack, 'assets', 'minecraft'))) looks.push({ name, resolver: createResolver(assets, pack) });
  }
  // "soft" calms the textures down and adds direction hints; it starts from
  // the Bare Bones pack when that is there, from the plain game otherwise.
  const softBase = join(PACK_DIR, 'bare');
  for (const [name, look] of [['soft', softLook], ['softer', softerLook]]) {
    looks.push({ name, resolver: createResolver(assets, existsSync(softBase) ? softBase : undefined, look) });
  }
  // Rebuilt from scratch here; on a machine without the game (the site's
  // build server) whatever is checked in under public/mc stays as it is.
  rmSync(MC_DIR, { recursive: true, force: true });
  mkdirSync(join(MC_DIR, 'doors'), { recursive: true });
  mkdirSync(join(MC_DIR, 'font'), { recursive: true });
  copyFileSync(assets.font, join(MC_DIR, 'font', 'ascii.png'));
}

const ids = readdirSync(REC_DIR).filter((d) => statSync(join(REC_DIR, d)).isDirectory()
  && existsSync(join(REC_DIR, d, 'close.json')) && existsSync(join(REC_DIR, d, 'open.json')));
const manifest = [];
for (const id of ids.sort()) {
  const door = buildDoor(id);
  const json = JSON.stringify(door);
  writeFileSync(join(OUT_DIR, `${id}.json`), json);
  // "carousel": false in door.json keeps a door out of the carousel: it plays
  // only when asked for by name.
  const metaFile = join(REC_DIR, id, 'door.json');
  const solo = existsSync(metaFile) && JSON.parse(readFileSync(metaFile, 'utf8')).carousel === false;
  manifest.push(solo ? { id, solo: true } : { id });
  console.log(`${id}: ${door.size.join('x')}, ${door.palette.length} states, close ${door.clips.close.ticks.length} ticks, open ${door.clips.open.ticks.length} ticks, ${(json.length / 1024).toFixed(1)} KB`);
  if (!looks.length) continue;
  const exact = buildDoor(id, true);
  for (const { resolver } of looks) {
    for (const { name, props = {} } of exact.palette) {
      if (name === 'air') continue;
      resolver.add(name, props);
      // States the player makes up while a piston is travelling.
      if (name === 'piston' || name === 'sticky_piston' || name === 'piston_head') {
        const type = name === 'piston_head' ? props.type : name === 'sticky_piston' ? 'sticky' : 'normal';
        for (const short of ['false', 'true']) resolver.add('piston_head', { facing: props.facing, short, type });
        if (name !== 'piston_head') resolver.add(name, { ...props, extended: 'true' });
      }
    }
  }
  writeFileSync(join(MC_DIR, 'doors', `${id}.json`), JSON.stringify(exact));
}
writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(manifest));
console.log(`${manifest.length} door(s) -> public/doors`);
for (const { name, resolver } of looks) {
  const bundle = resolver.bundle();
  mkdirSync(join(MC_DIR, name), { recursive: true });
  writeFileSync(join(MC_DIR, name, 'blocks.json'), JSON.stringify(bundle));
  resolver.writeTextures(join(MC_DIR, name, 'textures'));
  for (const m of resolver.missing) console.warn(`  ! ${name}: ${m}`);
  console.log(`look "${name}" (${bundle.version}): ${Object.keys(bundle.states).length} states, ${Object.keys(bundle.models).length} models, ${bundle.textures.length} textures -> public/mc/${name}`);
}
if (!looks.length) console.log('game looks skipped: no Minecraft install found (set MC_JAR to build them)');
