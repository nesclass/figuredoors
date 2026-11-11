// Stylised block models. Every block is built from boxes measured in "pixels"
// (1/16 of a block) and painted with tiny procedural textures: flat fill, a
// darker one-pixel rim and a few pixels of detail. No game assets are used.

import * as THREE from 'three';

const PX = 1 / 16;

export const FACING = {
  down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0],
};
const YAW = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };
const UP = new THREE.Vector3(0, 1, 0);

// ---- textures and materials --------------------------------------------------

const materialCache = new Map();
const geometryCache = new Map();

function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function panel(ctx, w, h, fill, edge) {
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);
  ctx.clearRect(1, 1, w - 2, h - 2);
  ctx.fillStyle = fill;
  ctx.fillRect(1, 1, w - 2, h - 2);
}

const dot = (ctx, color, x, y, w = 1, h = 1) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };

// A style describes how the faces of a box look.
//   fill, edge   base colours
//   deco         {px, nx, py, ny, pz, nz, side, all}: extra pixels per face
//   glow         same keys: pixels that emit light (drawn on black)
//   opacity      < 1 makes the box translucent
const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const pick = (map, face) => map?.[face] ?? (face !== 'py' && face !== 'ny' ? map?.side : undefined) ?? map?.all;

function faceMaterial(style, face, w, h) {
  const deco = pick(style.deco, face);
  const glow = pick(style.glow, face);
  const key = `${style.key}|${deco ? face : ''}|${glow ? face : ''}|${w}x${h}`;
  let mat = materialCache.get(key);
  if (mat) return mat;
  const map = canvasTexture(w, h, (ctx) => {
    panel(ctx, w, h, style.fill, style.edge);
    deco?.(ctx, w, h);
  });
  mat = new THREE.MeshLambertMaterial({ map });
  if (glow) {
    mat.emissiveMap = canvasTexture(w, h, (ctx) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      glow(ctx, w, h);
    });
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveIntensity = 0.9;
  }
  if (style.opacity !== undefined && style.opacity < 1) {
    mat.transparent = true;
    mat.depthWrite = false;
  }
  materialCache.set(key, mat);
  return mat;
}

// Box of w x h x d pixels centred at (cx, cy, cz) pixels from the block centre.
function box(style, w, h, d, cx = 0, cy = 0, cz = 0) {
  const gkey = `${w}x${h}x${d}`;
  let geo = geometryCache.get(gkey);
  if (!geo) geometryCache.set(gkey, geo = new THREE.BoxGeometry(w * PX, h * PX, d * PX));
  const dims = { px: [d, h], nx: [d, h], py: [w, d], ny: [w, d], pz: [w, h], nz: [w, h] };
  const mesh = new THREE.Mesh(geo, FACES.map((f) => faceMaterial(style, f, ...dims[f])));
  mesh.position.set(cx * PX, cy * PX, cz * PX);
  const solid = style.opacity === undefined || style.opacity >= 1;
  mesh.castShadow = solid;
  mesh.receiveShadow = solid;
  if (!solid) mesh.renderOrder = 1;
  return mesh;
}

function group(...children) {
  const g = new THREE.Group();
  for (const c of children) if (c) g.add(c);
  return g;
}

// Models are built pointing up (+y) and turned towards their facing.
function turn(obj, facing) {
  obj.quaternion.setFromUnitVectors(UP, new THREE.Vector3(...FACING[facing]));
  return obj;
}

// ---- styles ------------------------------------------------------------------

const flecks = (color) => (ctx, w, h) => {
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) if ((x * 5 + y * 3) % 11 === 0) dot(ctx, color, x, y);
};

const S = {
  door: { key: 'door', fill: '#f5f2ea', edge: '#d9d3c5' },
  casing: { key: 'casing', fill: '#1fa5a1', edge: '#16827f', deco: { all: flecks('#3cbdb7') } },
  input: { key: 'input', fill: '#8bd044', edge: '#69a82d', deco: { all: flecks('#a6e062') } },
  glass: {
    key: 'glass', fill: 'rgba(214,236,255,0.16)', edge: 'rgba(255,255,255,0.7)', opacity: 0.3,
    deco: { all: (ctx) => { dot(ctx, 'rgba(255,255,255,0.75)', 3, 4); dot(ctx, 'rgba(255,255,255,0.75)', 4, 3); dot(ctx, 'rgba(255,255,255,0.6)', 11, 12); } },
  },
  stone: { key: 'stone', fill: '#9a9ea5', edge: '#787d85' },
  stoneDark: { key: 'stoneDark', fill: '#5f646c', edge: '#4b5057' },
  wood: { key: 'wood', fill: '#cfa568', edge: '#a37e48' },
  woodSticky: {
    key: 'woodSticky', fill: '#cfa568', edge: '#a37e48',
    deco: { py: (ctx, w, h) => { dot(ctx, '#62aa42', 3, 3, w - 6, h - 6); dot(ctx, '#8ad362', 4, 4, w - 8, h - 8); } },
  },
  rod: { key: 'rod', fill: '#b98f55', edge: '#94703e' },
  handle: { key: 'handle', fill: '#8b6a43', edge: '#6b5033' },
  slab: { key: 'slab', fill: '#c5c8cc', edge: '#9da1a7' },
};

const eyes = (ctx) => {
  dot(ctx, '#1e2125', 3, 4, 3, 3);
  dot(ctx, '#1e2125', 10, 4, 3, 3);
  dot(ctx, '#1e2125', 5, 10, 6, 2);
};
const arrow = (ctx, w, h) => { dot(ctx, '#7b8088', 7, 2, 2, h - 4); dot(ctx, '#7b8088', 5, 4, 6, 1); };
const observerStyle = (powered) => ({
  key: `observer${powered}`, fill: '#5d6269', edge: '#44494f',
  deco: {
    py: eyes,
    ny: (ctx) => dot(ctx, powered ? '#ff5540' : '#7a2c26', 6, 6, 4, 4),
    side: arrow,
  },
  glow: powered ? { ny: (ctx) => dot(ctx, '#ff5540', 6, 6, 4, 4) } : undefined,
});

const note = (color) => (ctx) => {
  dot(ctx, color, 8, 3, 2, 8);
  dot(ctx, color, 5, 9, 4, 3);
  dot(ctx, color, 10, 3, 2, 2);
};
const noteStyle = (powered) => ({
  key: `note${powered}`, fill: '#9c6b49', edge: '#754a30',
  deco: { side: note(powered ? '#ffd27a' : '#4b2d1d'), py: (ctx) => dot(ctx, '#754a30', 5, 5, 6, 6) },
  glow: powered ? { side: note('#ffb84a') } : undefined,
});

const bulbStyle = (lit) => ({
  key: `bulb${lit}`, fill: '#d08158', edge: '#a85f3e',
  deco: { all: (ctx) => { dot(ctx, '#a85f3e', 3, 3, 10, 10); dot(ctx, lit ? '#fff0b0' : '#5c3c2d', 4, 4, 8, 8); } },
  glow: lit ? { all: (ctx) => dot(ctx, '#ffe9a0', 4, 4, 8, 8) } : undefined,
});

const torchStyle = (lit) => ({
  key: `torch${lit}`, fill: lit ? '#ff5038' : '#6d211a', edge: lit ? '#d93a25' : '#541812',
  glow: lit ? { all: (ctx, w, h) => dot(ctx, '#ff5038', 0, 0, w, h) } : undefined,
});

const furnaceStyle = (lit) => ({
  key: `furnace${lit}`, fill: '#8f949b', edge: '#6f747b',
  deco: { nz: (ctx) => { dot(ctx, '#5a5f66', 4, 3, 8, 3); dot(ctx, lit ? '#ffb347' : '#2c2f34', 4, 8, 8, 5); } },
  glow: lit ? { nz: (ctx) => dot(ctx, '#ff9a2e', 4, 8, 8, 5) } : undefined,
});

const composterStyle = (level) => ({
  key: `composter${level}`, fill: '#a9743f', edge: '#7d522d',
  deco: {
    side: (ctx, w) => { dot(ctx, '#7d522d', 1, 5, w - 2, 1); dot(ctx, '#7d522d', 1, 10, w - 2, 1); },
    py: (ctx, w, h) => { dot(ctx, '#4b3220', 2, 2, w - 4, h - 4); if (level > 0) dot(ctx, '#7c9a3c', 3, 3, w - 6, h - 6); },
  },
});

const redstoneBlockStyle = {
  key: 'redstoneBlock', fill: '#c92b1d', edge: '#9a1d12',
  deco: { all: flecks('#e85a48') },
  glow: { all: (ctx, w, h) => dot(ctx, '#4a0f0a', 0, 0, w, h) },
};

const fenceStyle = { key: 'fence', fill: '#a9743f', edge: '#7d522d' };

const FALLBACK = {
  slime_block: ['#84d862', '#60b043'], honey_block: ['#f3a92d', '#c98314'],
  target: ['#f1e6dc', '#d15b4f'], redstone_lamp: ['#8c5a2e', '#6a4220'], hopper: ['#4d5157', '#3a3d42'],
  dropper: ['#8f9399', '#6f747b'], dispenser: ['#8f9399', '#6f747b'], barrel: ['#9c6b49', '#754a30'],
  comparator: ['#c5c8cc', '#9da1a7'], obsidian: ['#2a2238', '#1b1626'],
};
const warned = new Set();
function fallbackStyle(name) {
  const [fill, edge] = FALLBACK[name] ?? ['#b765c9', '#8d47a0'];
  if (!FALLBACK[name] && !warned.has(name)) { warned.add(name); console.warn(`No model for block "${name}", drawing a placeholder`); }
  return { key: `fallback-${name}`, fill, edge };
}

// ---- block models ------------------------------------------------------------

function pistonBase(sticky, extended, facing) {
  const base = box({ ...S.stone, key: 'pistonBase', deco: { py: (ctx, w, h) => dot(ctx, '#4b5057', 5, 5, w - 10, h - 10) } }, 16, 12, 16, 0, -2, 0);
  const plate = extended ? null : box(sticky ? S.woodSticky : S.wood, 16, 4, 16, 0, 6, 0);
  return turn(group(base, plate), facing);
}

function pistonHead(sticky, facing) {
  const rod = box(S.rod, 4, 16, 4, 0, -4, 0);
  const head = turn(group(box(sticky ? S.woodSticky : S.wood, 16, 4, 16, 0, 6, 0), rod), facing);
  head.userData.rod = rod;
  return head;
}

// A head that is travelling has only part of its rod out of the piston body:
// extension 0 = fully retracted, 1 = fully extended. The rod always ends at
// the body's top face, so it never pokes out of the back.
export function setHeadExtension(head, extension) {
  const rod = head.userData.rod;
  if (!rod) return;
  const e = Math.min(1, Math.max(0, extension));
  rod.visible = e > 0.01;
  rod.scale.y = Math.max(e, 0.01);
  rod.position.y = (4 - 8 * e) * PX;
}

function repeater(props) {
  const lit = props.powered === 'true';
  const delay = Math.max(1, Math.min(4, parseInt(props.delay ?? '1', 10)));
  const g = group(
    box({ ...S.slab, key: `repeater${lit}`, deco: { py: (ctx) => dot(ctx, lit ? '#ff5038' : '#7a2c26', 7, 2, 2, 12) } }, 16, 2, 16, 0, -7, 0),
    box(torchStyle(lit), 2, 5, 2, 0, -3.5, -5),
    box(torchStyle(lit), 2, 5, 2, 0, -3.5, -1 + (delay - 1) * 2),
  );
  g.rotation.y = YAW[props.facing] ?? 0;
  return g;
}

function comparator(props) {
  const lit = props.powered === 'true';
  const g = group(
    box({ ...S.slab, key: `comparator${lit}`, deco: { py: (ctx) => { dot(ctx, lit ? '#ff5038' : '#7a2c26', 7, 3, 2, 8); dot(ctx, lit ? '#ff5038' : '#7a2c26', 4, 10, 8, 2); } } }, 16, 2, 16, 0, -7, 0),
    box(torchStyle(props.mode === 'subtract'), 2, 3, 2, 0, -4.5, -5),
    box(torchStyle(lit), 2, 5, 2, -3, -3.5, 4),
    box(torchStyle(lit), 2, 5, 2, 3, -3.5, 4),
  );
  g.rotation.y = YAW[props.facing] ?? 0;
  return g;
}

function fence(props) {
  const g = group(box(fenceStyle, 4, 16, 4));
  const sides = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
  for (const [side, [dx, dz]] of Object.entries(sides)) {
    if (props[side] !== 'true') continue;
    for (const y of [5.5, -0.5]) g.add(box(fenceStyle, dx ? 6 : 2, 3, dz ? 6 : 2, dx * 5, y, dz * 5));
  }
  return g;
}

function furnace(props) {
  const g = group(box(furnaceStyle(props.lit === 'true'), 16, 16, 16));
  g.rotation.y = YAW[props.facing] ?? 0;
  return g;
}

function wire(props) {
  const power = parseInt(props.power ?? '0', 10);
  const k = power / 15;
  const color = new THREE.Color('#4a0d0a').lerp(new THREE.Color('#ff3020'), k);
  const hex = `#${color.getHexString()}`;
  const style = {
    key: `wire${power}`, fill: hex, edge: hex,
    glow: power > 0 ? { all: (ctx, w, h) => dot(ctx, `#${color.clone().multiplyScalar(0.8).getHexString()}`, 0, 0, w, h) } : undefined,
  };
  const sides = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
  const connected = Object.keys(sides).filter((s) => props[s] && props[s] !== 'none');
  const g = group(box(style, connected.length ? 2 : 4, 1, connected.length ? 2 : 4, 0, -7.5, 0));
  for (const side of connected) {
    const [dx, dz] = sides[side];
    const arm = box(style, dx ? 7 : 2, 1, dz ? 7 : 2, dx * 4.5, -7.5, dz * 4.5);
    arm.castShadow = false;
    g.add(arm);
    if (props[side] === 'up') g.add(box(style, dx ? 1 : 2, 16, dz ? 1 : 2, dx * 7.5, 0, dz * 7.5));
  }
  return g;
}

function lever(props) {
  const on = props.powered === 'true';
  // Built for a wall lever facing north: mounted on the block to the south (+z).
  const stick = group(box(S.handle, 2, 2, 10, 0, 0, -5));
  stick.position.set(0, 0, 6 * PX);
  stick.rotation.x = on ? -Math.PI / 4 : Math.PI / 4;
  const pitch = group(box(S.stoneDark, 6, 8, 3, 0, 0, 6.5), stick);
  if (props.face === 'floor') pitch.rotation.x = Math.PI / 2;
  if (props.face === 'ceiling') pitch.rotation.x = -Math.PI / 2;
  const g = group(pitch);
  g.rotation.y = YAW[props.facing] ?? 0;
  return g;
}

// Returns a new Object3D for a palette state, or null for air.
export function makeBlock(state) {
  const props = state.props ?? {};
  switch (state.name) {
    case 'air': return null;
    case 'door': return box(S.door, 16, 16, 16);
    case 'casing': return box(S.casing, 16, 16, 16);
    case 'input': return box(S.input, 16, 16, 16);
    case 'glass': return box(S.glass, 16, 16, 16);
    case 'piston':
    case 'sticky_piston': return pistonBase(state.name === 'sticky_piston', props.extended === 'true', props.facing ?? 'up');
    case 'piston_head': return pistonHead(props.type === 'sticky', props.facing ?? 'up');
    case 'observer': return turn(box(observerStyle(props.powered === 'true'), 16, 16, 16), props.facing ?? 'up');
    case 'note_block': return box(noteStyle(props.powered === 'true'), 16, 16, 16);
    case 'copper_bulb': return box(bulbStyle(props.lit === 'true'), 16, 16, 16);
    case 'repeater': return repeater(props);
    case 'redstone_wire': return wire(props);
    case 'lever': return lever(props);
    case 'comparator': return comparator(props);
    case 'fence': return fence(props);
    case 'furnace': return furnace(props);
    case 'composter': return box(composterStyle(parseInt(props.level ?? '0', 10)), 16, 16, 16);
    case 'redstone_block': return box(redstoneBlockStyle, 16, 16, 16);
    default: return box(fallbackStyle(state.name), 16, 16, 16);
  }
}
