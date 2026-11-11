// Resolves block states to the game's own models and textures, read from a
// local Minecraft install. Used by build-doors.mjs for the "mc" look.
//
// Nothing here is downloaded: the client jar is found in the launcher folder
// (or taken from MC_JAR) and its block assets are unpacked into .cache/mc.
// Without a jar the "mc" look is simply not built.
//
// A resource pack can be laid over the game's assets: whatever the pack has
// wins, the rest comes from the game.

import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const VERSION = process.env.MC_VERSION ?? '1.21.11';
const FONT = 'textures/font/ascii.png';

function findJar() {
  if (process.env.MC_JAR) return process.env.MC_JAR;
  const roots = [
    join(homedir(), 'Library', 'Application Support', 'PrismLauncher'),
    join(homedir(), '.local', 'share', 'PrismLauncher'),
  ];
  for (const root of roots) {
    const dir = join(root, 'libraries', 'com', 'mojang', 'minecraft');
    if (!existsSync(dir)) continue;
    const versions = readdirSync(dir);
    const pick = versions.includes(VERSION) ? VERSION : versions.sort().pop();
    const jar = pick && join(dir, pick, `minecraft-${pick}-client.jar`);
    if (jar && existsSync(jar)) return jar;
  }
  return null;
}

// Returns the folder with unpacked `blockstates`, `models` and `textures`, or null.
export function openAssets(cacheRoot) {
  const jar = findJar();
  if (!jar) return null;
  const version = basename(jar).replace(/^minecraft-|-client\.jar$/g, '');
  const out = join(cacheRoot, version);
  const assets = join(out, 'assets', 'minecraft');
  if (!existsSync(join(assets, 'blockstates'))) {
    mkdirSync(out, { recursive: true });
    execFileSync('unzip', ['-o', '-q', jar,
      'assets/minecraft/blockstates/*', 'assets/minecraft/models/block/*', 'assets/minecraft/textures/block/*',
      '-d', out]);
  }
  // The game's own font, for the name under the door.
  if (!existsSync(join(assets, FONT))) execFileSync('unzip', ['-o', '-q', jar, `assets/minecraft/${FONT}`, '-d', out]);
  return { dir: assets, version, font: join(assets, FONT) };
}

const bare = (s) => s.replace(/^minecraft:/, '');

// Does this face show the whole 16x16 texture?
function coversFace(dir, el, uv) {
  if (uv) return Math.abs(uv[2] - uv[0]) === 16 && Math.abs(uv[3] - uv[1]) === 16;
  const axes = dir === 'up' || dir === 'down' ? [0, 2] : dir === 'north' || dir === 'south' ? [0, 1] : [2, 1];
  return axes.every((k) => el.from[k] === 0 && el.to[k] === 16);
}

// The same key is computed in the browser (src/mcblocks.js).
export const stateKey = (name, props = {}) => `${name}|${Object.keys(props).sort().map((k) => `${k}=${props[k]}`).join(',')}`;

// Asset folders of an unpacked resource pack, strongest first. A pack may ship
// overlays for newer game versions; the later an overlay is listed, the stronger.
function packLayers(root) {
  const layers = [join(root, 'assets', 'minecraft')];
  const metaFile = join(root, 'pack.mcmeta');
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  for (const entry of meta.overlays?.entries ?? []) layers.unshift(join(root, entry.directory, 'assets', 'minecraft'));
  return layers;
}

// pack: folder of an unpacked resource pack, or nothing for the plain game look.
// look: optional {style, derived, tweaks}, see tools/soft-look.mjs.
export function createResolver(assets, pack, look = {}) {
  const layers = [...(pack ? packLayers(pack) : []), assets.dir];
  const find = (rel) => layers.map((dir) => join(dir, rel)).find((file) => existsSync(file));
  const json = (path) => {
    const file = find(`${path}.json`);
    return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const rawModels = new Map();
  const models = {};      // name -> {elements}
  const states = {};      // key -> [{model, x, y}]
  const textures = new Set();
  const derived = {};          // derived textures that are really used
  const full = new Set();      // textures that cover a whole block face somewhere
  const missing = new Set();

  // A model with its parents folded in.
  function loadModel(name) {
    if (rawModels.has(name)) return rawModels.get(name);
    const own = json(`models/${name}`);
    let merged = { textures: {}, elements: null };
    if (own) {
      const parent = own.parent && !bare(own.parent).startsWith('builtin/') ? loadModel(bare(own.parent)) : merged;
      merged = { textures: { ...parent.textures, ...own.textures }, elements: own.elements ?? parent.elements };
    }
    if (look.tweaks?.[name] && merged.elements) {
      merged = structuredClone(merged);
      look.tweaks[name](merged);
    }
    rawModels.set(name, merged);
    return merged;
  }

  function bake(name) {
    if (models[name]) return;
    const model = loadModel(name);
    const texture = (ref) => {
      let t = ref;
      for (let i = 0; i < 10 && t?.startsWith('#'); i++) t = model.textures[t.slice(1)];
      return t && !t.startsWith('#') ? bare(t) : null;
    };
    const elements = [];
    for (const el of model.elements ?? []) {
      const faces = {};
      for (const [dir, f] of Object.entries(el.faces ?? {})) {
        const tex = texture(f.texture);
        const recipe = tex && look.derived?.[tex];
        const file = recipe ? recipe.from : tex;
        if (!file || !find(join('textures', `${file}.png`))) { missing.add(`${name}: ${f.texture}`); continue; }
        textures.add(file);
        if (recipe) derived[tex] = recipe;
        if (coversFace(dir, el, f.uv)) full.add(tex);
        const face = { texture: tex };
        if (f.uv) face.uv = f.uv;
        if (f.rotation) face.rotation = f.rotation;
        if (f.tintindex !== undefined) face.tint = 1;
        faces[dir] = face;
      }
      const out = { from: el.from, to: el.to, faces };
      if (el.rotation) out.rotation = el.rotation;
      elements.push(out);
    }
    models[name] = { elements };
  }

  const test = (when, props) => {
    if (when.OR) return when.OR.some((w) => test(w, props));
    if (when.AND) return when.AND.every((w) => test(w, props));
    return Object.entries(when).every(([k, v]) => String(v).split('|').includes(String(props[k])));
  };

  // Registers a block state; returns false when the game has no model for it.
  function add(name, props = {}) {
    const key = stateKey(name, props);
    if (key in states) return states[key] !== null;
    const bs = json(`blockstates/${name}`);
    let applied = null;
    if (bs?.variants) {
      for (const [cond, value] of Object.entries(bs.variants)) {
        const ok = !cond || cond.split(',').every((kv) => { const [k, v] = kv.split('='); return String(props[k]) === v; });
        if (ok) { applied = [Array.isArray(value) ? value[0] : value]; break; }
      }
    } else if (bs?.multipart) {
      applied = bs.multipart.filter((c) => !c.when || test(c.when, props)).map((c) => (Array.isArray(c.apply) ? c.apply[0] : c.apply));
    }
    if (!applied) { states[key] = null; missing.add(`no model for ${key}`); return false; }
    states[key] = applied.map((a) => {
      const model = bare(a.model);
      bake(model);
      const part = { model };
      if (a.x) part.x = a.x;
      if (a.y) part.y = a.y;
      return part;
    });
    return true;
  }

  // Animated textures are strips of frames; the first one is used.
  function writeTextures(outDir) {
    for (const tex of textures) {
      const to = join(outDir, `${tex}.png`);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(find(join('textures', `${tex}.png`)), to);
    }
  }

  const bundle = () => ({
    version: assets.version,
    ...(look.style ? { style: look.style, derived, full: [...full].sort() } : {}),
    states: Object.fromEntries(Object.entries(states).filter(([, v]) => v)),
    models,
    textures: [...textures].sort(),
  });

  return { add, bundle, writeTextures, missing };
}
