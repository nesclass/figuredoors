// Game looks: blocks drawn with the game's own models and textures, plain
// ("vanilla") or with a resource pack on top.
//
// public/mc/<look>/blocks.json (built by tools/build-doors.mjs from a local
// Minecraft install) maps every block state of the recorded doors to model parts. A part
// is a list of boxes with a texture and a UV rectangle per face, the format the
// game itself uses, so new blocks need no drawing by hand.

import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL;
const RAD = Math.PI / 180;

let bundle = null;
let root = '';
const textures = new Map();   // name -> {map, kind: 'solid' | 'cutout' | 'clear'}
const materials = new Map();
const built = new Map();
const warned = new Set();

// Must match stateKey in tools/mc-assets.mjs.
const stateKey = (name, props = {}) => `${name}|${Object.keys(props).sort().map((k) => `${k}=${props[k]}`).join(',')}`;

// ---- textures ----------------------------------------------------------------

// Reads a texture into a canvas. Animated textures are a strip of square
// frames: only the first is kept.
function readTexture(name) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = img.width;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, size, size);
      let holes = 0, soft = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] === 0) holes++;
        else if (data[i] < 250) soft++;
      }
      resolve({ canvas, ctx, size, kind: soft > size ? 'clear' : holes ? 'cutout' : 'solid' });
    };
    img.onerror = () => resolve(null);
    img.src = `${root}textures/${name}.png`;
  });
}

// Calms a texture down: colours that are close to each other are treated as
// one material and pulled towards its average, so stone stays stone-coloured
// but loses most of its pattern, while a face or a label keeps its contrast.
//
// With `chroma` set, a difference in colour counts that many times more than
// a difference in brightness: light and dark stone still merge, wood and
// stone never do.
function flatten({ ctx, size }, { merge, flatten: amount, chroma }) {
  const image = ctx.getImageData(0, 0, size, size);
  const d = image.data;
  // Packs with rich palettes are grouped a little coarser to keep this quick.
  const coarse = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const groups = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const key = coarse(d[i], d[i + 1], d[i + 2]);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { r: 0, g: 0, b: 0, n: 0, keys: [key] });
    g.r += d[i]; g.g += d[i + 1]; g.b += d[i + 2]; g.n++;
  }
  const list = [...groups.values()];
  const limit = merge * merge;
  for (;;) {
    let best = limit, a = -1, b = -1;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i], q = list[j];
        const dr = p.r / p.n - q.r / q.n, dg = p.g / p.n - q.g / q.n, db = p.b / p.n - q.b / q.n;
        let dist = dr * dr + dg * dg + db * db;
        if (chroma) {
          const dy = 0.299 * dr + 0.587 * dg + 0.114 * db;
          dist = dy * dy + (chroma * (dr - dy)) ** 2 + (chroma * (db - dy)) ** 2;
        }
        if (dist < best) { best = dist; a = i; b = j; }
      }
    }
    if (a < 0) break;
    const p = list[a], q = list.splice(b, 1)[0];
    p.r += q.r; p.g += q.g; p.b += q.b; p.n += q.n; p.keys.push(...q.keys);
  }
  const target = new Map();
  for (const g of list) for (const key of g.keys) target.set(key, g);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const g = target.get(coarse(d[i], d[i + 1], d[i + 2]));
    d[i] += (g.r / g.n - d[i]) * amount;
    d[i + 1] += (g.g / g.n - d[i + 1]) * amount;
    d[i + 2] += (g.b / g.n - d[i + 2]) * amount;
  }
  ctx.putImageData(image, 0, 0);
}

// A one-pixel darker edge, the outline every block has in the drawn look.
function addRim({ ctx, size }, brightness) {
  const image = ctx.getImageData(0, 0, size, size);
  const d = image.data;
  const w = Math.max(1, Math.round(size / 16));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x >= w && y >= w && x < size - w && y < size - w) continue;
      const i = (y * size + x) * 4;
      d[i] *= brightness; d[i + 1] *= brightness; d[i + 2] *= brightness;
    }
  }
  ctx.putImageData(image, 0, 0);
}

// Scales colour strength: 0 is grey, 1 leaves the texture as it is.
function saturate({ ctx, size }, amount) {
  const image = ctx.getImageData(0, 0, size, size);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = grey + (d[i] - grey) * amount;
    d[i + 1] = grey + (d[i + 1] - grey) * amount;
    d[i + 2] = grey + (d[i + 2] - grey) * amount;
  }
  ctx.putImageData(image, 0, 0);
}

// The colour most of the texture has, or most of one part of it
// ([x, y, w, h] on the 16x16 grid).
function mainColor({ ctx, size }, [x, y, w, h] = [0, 0, 16, 16]) {
  const u = size / 16;
  const { data } = ctx.getImageData(x * u, y * u, w * u, h * u);
  const count = new Map();
  let best = 0, color = '#808080';
  for (let i = 0; i < data.length; i += 4) {
    const css = `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`;
    const n = (count.get(css) ?? 0) + 1;
    count.set(css, n);
    if (n > best) { best = n; color = css; }
  }
  return color;
}

// Paint for derived textures, on a 16x16 grid whatever the real resolution.
const ARROW = {
  up: [[7, 4, 2, 1], [6, 5, 4, 1], [5, 6, 6, 1], [7, 7, 2, 5]],
  right: [[11, 7, 1, 2], [10, 6, 1, 4], [9, 5, 1, 6], [4, 7, 5, 2]],
};
const PAINT = {
  // The plate of a sticky piston seen from the side: the same plate as on a
  // plain piston, studs and all, with slime over the wood of its front half.
  // Only the wood is painted, so the two pistons differ in one thing.
  slime(px, recipe, tex) {
    const u = tex.size / 16;
    const { data } = tex.ctx.getImageData(0, 0, tex.size, 2 * u);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (Math.floor((y + 0.5) * u) * tex.size + Math.floor((x + 0.5) * u)) * 4;
        const wood = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) >= 24;
        if (wood) px('#7fae5c', x, y);
      }
    }
  },
  arrow(px, recipe, tex) {
    if (recipe.clear) px(mainColor(tex), 3, 3, 10, 10);
    for (const [x, y, w, h] of ARROW[recipe.dir]) px(recipe.color, x, y, w, h);
  },
  dot(px, recipe) {
    px(recipe.color, 6, 6, 4, 4);
  },
};

function derive(base, recipe) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = base.size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base.canvas, 0, 0);
  const tex = { canvas, ctx, size: base.size, kind: base.kind };
  const u = base.size / 16;
  PAINT[recipe.paint]((color, x, y, w = 1, h = 1) => { ctx.fillStyle = color; ctx.fillRect(x * u, y * u, w * u, h * u); }, recipe, tex);
  return tex;
}

async function loadTextures() {
  const { style, derived = {}, full = [] } = bundle;
  const all = new Map();
  await Promise.all(bundle.textures.map(async (name) => {
    const tex = await readTexture(name);
    if (tex) all.set(name, tex);
  }));
  if (style) {
    for (const tex of all.values()) {
      flatten(tex, style);
      if (style.saturate !== undefined && style.saturate !== 1) saturate(tex, style.saturate);
    }
  }
  for (const [name, recipe] of Object.entries(derived)) {
    const base = all.get(recipe.from);
    if (base) all.set(name, derive(base, recipe));
  }
  const rimmed = new Set(full);
  for (const [name, tex] of all) {
    if (style?.rim && tex.kind === 'solid' && rimmed.has(name)) addRim(tex, style.rim);
    const map = new THREE.CanvasTexture(tex.canvas);
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.colorSpace = THREE.SRGBColorSpace;
    textures.set(name, { map, kind: tex.kind });
  }
}

function material(name, tint) {
  const key = `${name}|${tint ?? ''}`;
  let mat = materials.get(key);
  if (mat) return mat;
  const { map, kind } = textures.get(name);
  mat = new THREE.MeshLambertMaterial({ map, color: tint ?? 0xffffff });
  if (kind === 'cutout') mat.alphaTest = 0.5;
  if (kind === 'clear') { mat.transparent = true; mat.depthWrite = false; }
  mat.userData.solid = kind !== 'clear';
  materials.set(key, mat);
  return mat;
}

// Corners of each face as seen from outside: top-left, bottom-left, bottom-right, top-right.
const CORNERS = {
  down: (a, b) => [[a[0], a[1], b[2]], [a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]]],
  up: (a, b) => [[a[0], b[1], a[2]], [a[0], b[1], b[2]], [b[0], b[1], b[2]], [b[0], b[1], a[2]]],
  north: (a, b) => [[b[0], b[1], a[2]], [b[0], a[1], a[2]], [a[0], a[1], a[2]], [a[0], b[1], a[2]]],
  south: (a, b) => [[a[0], b[1], b[2]], [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]]],
  west: (a, b) => [[a[0], b[1], a[2]], [a[0], a[1], a[2]], [a[0], a[1], b[2]], [a[0], b[1], b[2]]],
  east: (a, b) => [[b[0], b[1], b[2]], [b[0], a[1], b[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]]],
};
const NORMAL = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
// The part of the texture a face shows when the model does not say.
const DEFAULT_UV = {
  down: (a, b) => [a[0], 16 - b[2], b[0], 16 - a[2]],
  up: (a, b) => [a[0], a[2], b[0], b[2]],
  north: (a, b) => [16 - b[0], 16 - b[1], 16 - a[0], 16 - a[1]],
  south: (a, b) => [a[0], 16 - b[1], b[0], 16 - a[1]],
  west: (a, b) => [a[2], 16 - b[1], b[2], 16 - a[1]],
  east: (a, b) => [16 - b[2], 16 - b[1], 16 - a[2], 16 - a[1]],
};
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

// One model as a geometry with a group per material. Coordinates are in blocks,
// centred on the block.
function buildModel(name, tint) {
  const key = `${name}|${tint ?? ''}`;
  if (built.has(key)) return built.get(key);
  const groups = new Map(); // material -> {position, normal, uv}
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const el of bundle.models[name]?.elements ?? []) {
    const rot = el.rotation;
    const quat = rot && new THREE.Quaternion().setFromAxisAngle(AXIS[rot.axis], rot.angle * RAD);
    const stretch = rot?.rescale ? 1 / Math.cos(rot.angle * RAD) : 1;
    for (const [dir, face] of Object.entries(el.faces)) {
      // The highlight layer of redstone dust lies exactly on the dust itself.
      if (!textures.has(face.texture) || face.texture.endsWith('redstone_dust_overlay')) continue;
      const mat = material(face.texture, face.tint ? tint : undefined);
      let g = groups.get(mat);
      if (!g) groups.set(mat, g = { position: [], normal: [], uv: [] });
      const [u1, v1, u2, v2] = face.uv ?? DEFAULT_UV[dir](el.from, el.to);
      const uvs = [[u1, v1], [u1, v2], [u2, v2], [u2, v1]];
      const shift = (face.rotation ?? 0) / 90;
      const corners = CORNERS[dir](el.from, el.to).map((c, i) => {
        v.set(...c);
        if (rot) {
          v.sub(n.set(...rot.origin)).applyQuaternion(quat);
          for (const axis of 'xyz') if (axis !== rot.axis) v[axis] *= stretch;
          v.add(n);
        }
        const [tu, tv] = uvs[(i + shift) % 4];
        return { p: [v.x / 16 - 0.5, v.y / 16 - 0.5, v.z / 16 - 0.5], t: [tu / 16, 1 - tv / 16] };
      });
      n.set(...NORMAL[dir]);
      if (rot) n.applyQuaternion(quat);
      for (const i of [0, 1, 2, 0, 2, 3]) {
        g.position.push(...corners[i].p);
        g.uv.push(...corners[i].t);
        g.normal.push(n.x, n.y, n.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  const all = { position: [], normal: [], uv: [] };
  const mats = [];
  for (const [mat, g] of groups) {
    geometry.addGroup(all.position.length / 3, g.position.length / 3, mats.length);
    mats.push(mat);
    for (const k of Object.keys(all)) all[k].push(...g[k]);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(all.position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(all.normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(all.uv, 2));
  const model = { geometry, mats, solid: mats.some((m) => m.userData.solid) };
  built.set(key, model);
  return model;
}

// Colours the game mixes in at run time.
function tintOf(name, props) {
  if (name === 'redstone_wire') {
    const f = parseInt(props.power ?? '0', 10) / 15;
    const clamp = (x) => Math.min(1, Math.max(0, x));
    return new THREE.Color().setRGB(f * 0.6 + (f > 0 ? 0.4 : 0.3), clamp(f * f * 0.7 - 0.5), clamp(f * f * 0.6 - 0.7), THREE.SRGBColorSpace).getHex();
  }
  if (name === 'spruce_leaves') return 0x619961;
  if (name === 'birch_leaves') return 0x80a755;
  if (name.endsWith('_leaves')) return 0x59ae30;
  if (name === 'grass_block') return 0x7cbd6b;
  return undefined;
}

function build(name, props = {}) {
  const parts = bundle.states[stateKey(name, props)];
  if (!parts) {
    if (!warned.has(name)) { warned.add(name); console.warn(`No game model for "${name}"`); }
    return null;
  }
  const tint = tintOf(name, props);
  const meshes = [];
  for (const part of parts) {
    const { geometry, mats, solid } = buildModel(part.model, tint);
    if (!mats.length) continue;
    const mesh = new THREE.Mesh(geometry, mats);
    // The game turns a model clockwise seen from above; three.js counts the other way.
    mesh.rotation.set(-(part.x ?? 0) * RAD, -(part.y ?? 0) * RAD, 0, 'YXZ');
    mesh.castShadow = solid;
    mesh.receiveShadow = solid;
    if (!solid) mesh.renderOrder = 1;
    meshes.push(mesh);
  }
  if (!meshes.length) return null;
  if (meshes.length === 1) return meshes[0];
  const g = new THREE.Group();
  g.add(...meshes);
  return g;
}

// A piston head comes with a long and a short rod; the short one is shown while
// the head is still close to the body, so the rod never pokes out of the back.
function head(props) {
  const type = props.type ?? 'normal';
  const long = build('piston_head', { facing: props.facing, short: 'false', type });
  const short = build('piston_head', { facing: props.facing, short: 'true', type });
  if (!long || !short) return long ?? short;
  const g = new THREE.Group();
  g.add(long, short);
  long.visible = props.short !== 'true';
  short.visible = !long.visible;
  g.userData.head = { long, short };
  return g;
}

function makeBlock(state) {
  if (state.name === 'air' || state.name === 'moving_piston') return null;
  if (state.name === 'piston_head') return head(state.props ?? {});
  return build(state.name, state.props);
}

function setHeadExtension(obj, extension) {
  const h = obj.userData.head;
  if (!h) return;
  h.short.visible = extension < 0.5;
  h.long.visible = !h.short.visible;
}

// Loads the model bundle and its textures; resolves to the block kit for DoorPlayer.
// One look per page load.
export async function loadMcKit(look) {
  if (!bundle) {
    root = `${BASE}mc/${look}/`;
    const res = await fetch(`${root}blocks.json`);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('json')) throw new Error(`The "${look}" look is not built: run "npm run doors" on a machine with Minecraft installed`);
    bundle = await res.json();
    await loadTextures();
  }
  return { makeBlock, setHeadExtension };
}
