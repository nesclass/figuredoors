import * as THREE from 'three';
import { DoorPlayer } from './player.js';
import '@fontsource/jersey-15';
import './style.css';
import { initUi } from './ui.js';
import { initProgress } from './progress.js';
import { initCaption } from './caption.js';

// ---- knobs worth playing with -------------------------------------------------
const TICK_MS = 100;        // one game tick on screen (the game runs at 50)
const MAX_CLIP_MS = 20000;  // a clip that would run longer is sped up to fit
const HOLD_OPEN_MS = 1400;  // pause while the door is open
const HOLD_CLOSED_MS = 2600; // pause while the figure is shown
const FOV = 22;             // long lens: close to a flat front view
const FILL = 0.8;           // share of the viewport the door may take
const PARALLAX = 0.45;      // how far the camera drifts with the pointer, in blocks
const DEPTH_FADE = 0.3;     // how much each layer further back sinks into the shade
const SUN_ELEVATION = 24;   // degrees above the line of sight
const SHADOW = 0.5;         // 0 = no cast shadows, 1 = black
const SLIDE_MS = 460;       // one door sliding out while the next slides in
const SWIPE_START = 8;      // pixels a pointer travels before a drag counts as a swipe
const SWIPE_COMMIT = 0.22;  // share of the way after which a released swipe goes through
const SWIPE_FLICK = 0.45;   // pixels per millisecond: a quick flick goes through as well
const LOOK = 'softer';      // how blocks are drawn unless ?style= says otherwise
const FIRST = '111-010-111'; // the door the site opens with

const canvas = document.querySelector('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x27324a, 1, 100);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
const HALF = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

// Blocks are drawn with the game's own models in the LOOK style. ?style= picks
// another one: "drawn" is the hand-made look, "mc" the plain game, anything
// else a look built into public/mc/<name>/. A look that is not there falls
// back to the drawn one.
const params = new URLSearchParams(location.search);
const style = params.get('style') ?? LOOK;
let kit; // undefined = the drawn look
if (style !== 'drawn' && /^[\w-]+$/.test(style)) {
  try {
    kit = await (await import('./mcblocks.js')).loadMcKit(style === 'mc' ? 'vanilla' : style);
  } catch (err) {
    console.warn(err.message);
  }
}

// ---- the doors ----------------------------------------------------------------

const base = import.meta.env.BASE_URL;
const manifest = await (await fetch(`${base}doors/index.json`)).json();
const wanted = params.get('door');
// Without ?door= the carousel runs over the figures, starting with FIRST.
// ?door=<id> shows that one door and nothing else: no carousel. That is also
// the only way to see a test recording or a door marked "carousel": false.
let ids = manifest.filter((d) => !d.solo && /^[01]{3}-[01]{3}-[01]{3}$/.test(d.id)).map((d) => d.id);
let index = Math.max(0, ids.indexOf(FIRST));
if (manifest.some((d) => d.id === wanted)) {
  ids = [wanted];
  index = 0;
}
const neighbour = (dir) => ids[(index + dir + ids.length) % ids.length];

const files = new Map();
function loadDoor(id) {
  if (!files.has(id)) files.set(id, fetch(`${base}${kit ? 'mc/' : ''}doors/${id}.json`).then((r) => r.json()));
  return files.get(id);
}

// close -> hold -> open -> hold -> ...
const phases = [
  { clip: 'close', hold: HOLD_OPEN_MS },
  { clip: 'open', hold: HOLD_CLOSED_MS },
];

// Turns a door so that the side the viewer stood at faces the camera (+z).
const TURN = { north: 0, south: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };

// A door on the stage: turned to the camera, centred on its pivot, playing its
// own loop. Two of them stand side by side while one slides in for the other.
class Slot {
  constructor(door) {
    this.door = door;
    this.player = new DoorPlayer(door, kit);
    const [sx, sy, sz] = door.size;
    const sideways = door.front === 'east' || door.front === 'west';
    this.width = sideways ? sz : sx;
    this.height = sy;
    this.depth = sideways ? sx : sz;
    this.reach = Math.max(this.width, sy) * 0.75 + 1; // what the shadow has to cover
    this.player.group.position.set(-sx / 2, -sy / 2, -sz / 2);
    this.pivot = new THREE.Group();
    this.pivot.rotation.y = TURN[door.front] ?? Math.PI;
    this.pivot.add(this.player.group);
    this.phase = 0;
    this.phaseStart = performance.now();
    this.player.setClip(phases[0].clip);
  }

  // How far the camera stands from the front of the door to fit it into the view.
  fit(aspect) {
    return Math.max(this.height / FILL / 2 / HALF, this.width / FILL / 2 / (HALF * aspect));
  }

  play(now, freeze) {
    const { player } = this;
    if (freeze) {
      if (player.clipName !== freeze.clip) player.setClip(freeze.clip);
      player.setTime(freeze.time);
      this.phaseStart = now;
      return;
    }
    const { clip, hold } = phases[this.phase];
    if (player.clipName !== clip) player.setClip(clip);
    const tickMs = Math.min(TICK_MS, MAX_CLIP_MS / player.length);
    const ticks = (now - this.phaseStart - hold) / tickMs;
    player.setTime(ticks);
    if (ticks >= player.length) {
      this.phase = (this.phase + 1) % phases.length;
      this.phaseStart = now;
      player.setClip(phases[this.phase].clip);
    }
  }
}

initUi();

let current = new Slot(await loadDoor(ids[index]));
scene.add(current.pivot);

const bitsOf = (id) => id.replace(/[^01]/g, '');
let progress = null;
initProgress({ current: bitsOf(ids[index]) }).then((api) => { progress = api; });
const caption = initCaption({ many: ids.length > 1, onGo: (dir) => go(dir) });
caption.show(ids[index]);

// ---- light ------------------------------------------------------------------

// Light comes from the viewer's side and from above, with no sideways lean:
// recessed blocks get an even band of shade along their top edge.
scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2d6, 1.7));
const sun = new THREE.DirectionalLight(0xfff6e6, 1.9);
const elevation = THREE.MathUtils.degToRad(SUN_ELEVATION);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { near: 1, far: 50 });
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 6;
sun.shadow.intensity = SHADOW;
scene.add(sun, sun.target);

// The shadow follows the doors: one door at rest, both while they slide.
let shadowKey = '';
function aimSun(x, halfWidth, halfHeight) {
  sun.position.set(x, 20 * Math.sin(elevation), 20 * Math.cos(elevation));
  sun.target.position.set(x, 0, 0);
  const key = `${halfWidth.toFixed(3)}|${halfHeight.toFixed(3)}`;
  if (key === shadowKey) return;
  shadowKey = key;
  Object.assign(sun.shadow.camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight });
  sun.shadow.camera.updateProjectionMatrix();
}

// ---- flipping between doors -----------------------------------------------------

// A move in progress: `to` slides in from the side `dir` (1 = the next door, from
// the right) while `current` leaves the other way. p runs from 0 to 1; a swipe
// drives it by hand, a tween finishes it.
let move = null;
let layout = { spacing: 1, unitsPerPixel: 0 };
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function begin(dir) {
  const m = { dir, to: null, p: 0, tween: null };
  move = m;
  loadDoor(neighbour(dir)).then((door) => {
    if (move !== m) return;
    m.to = new Slot(door);
    scene.add(m.to.pivot);
  });
}

function drop() {
  if (move?.to) scene.remove(move.to.pivot);
  move = null;
}

function commit() {
  scene.remove(current.pivot);
  current = move.to;
  current.pivot.position.x = 0;
  index = (index + move.dir + ids.length) % ids.length;
  move = null;
  const id = ids[index];
  caption.show(id);
  progress?.select(bitsOf(id));
  // Have both neighbours ready before they are asked for.
  loadDoor(neighbour(1));
  loadDoor(neighbour(-1));
}

function settle(target) {
  const ms = still ? 0 : Math.max(140, SLIDE_MS * Math.abs(target - move.p));
  move.tween = { from: move.p, target, start: performance.now(), ms };
}

function go(dir) {
  if (ids.length < 2 || drag?.active) return;
  if (move) {
    // A second press while the doors still slide: finish that move first.
    if (!move.to) return;
    commit();
  }
  begin(dir);
  settle(1);
}

function stepMove(now) {
  const t = move?.tween;
  if (!t) return;
  const k = t.ms ? Math.min(1, (now - t.start) / t.ms) : 1;
  move.p = t.from + (t.target - t.from) * (1 - (1 - k) ** 3);
  if (k < 1) return;
  if (t.target === 0) drop();
  else if (move.to) commit(); // otherwise the door is still loading: wait for it
}

// A sideways drag anywhere on the stage moves the doors with the pointer.
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (ids.length < 2 || e.button || move) return;
  drag = { id: e.pointerId, x0: e.clientX, x: e.clientX, t: e.timeStamp, speed: 0, active: false };
});
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  if (!drag.active) {
    if (Math.abs(dx) < SWIPE_START) return;
    drag.active = true;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    canvas.classList.add('is-dragging');
  }
  const dt = e.timeStamp - drag.t;
  if (dt > 0) drag.speed = (e.clientX - drag.x) / dt;
  drag.x = e.clientX;
  drag.t = e.timeStamp;
  const dir = dx < 0 ? 1 : -1;
  if (!move || move.dir !== dir) {
    drop();
    begin(dir);
  }
  move.p = Math.min(1, (Math.abs(dx) * layout.unitsPerPixel) / layout.spacing);
});
function release(e) {
  if (!drag || e.pointerId !== drag.id) return;
  canvas.classList.remove('is-dragging');
  if (drag.active && move) {
    const flick = Math.abs(drag.speed) > SWIPE_FLICK && Math.sign(drag.speed) === -move.dir;
    settle(move.p > SWIPE_COMMIT || flick ? 1 : 0);
  }
  drag = null;
}
window.addEventListener('pointerup', release);
window.addEventListener('pointercancel', release);

window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, textarea, select, [role="tablist"]')) return;
  go(e.key === 'ArrowRight' ? 1 : -1);
});

// ---- frame --------------------------------------------------------------------

let viewW = 0, viewH = 0;
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return false;
  viewW = w;
  viewH = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  return true;
}
resize();

const pointer = new THREE.Vector2();
const drift = new THREE.Vector2();
window.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
});

// Set window.__door.freeze = { clip: 'close', time: 3.5 } in the console to inspect one moment.
const debug = { freeze: null };
const mix = (a, b, t) => a + (b - a) * t;

function frame(now) {
  // The stage changes size while the panel slides, so follow it frame by frame.
  if (canvas.clientWidth !== viewW || canvas.clientHeight !== viewH) resize();
  stepMove(now);

  const other = move?.to ?? null;
  const p = move ? move.p : 0;
  const aspect = camera.aspect;
  const fitA = current.fit(aspect), fitB = other ? other.fit(aspect) : fitA;
  const fit = mix(fitA, fitB, p);
  const depth = mix(current.depth, other ? other.depth : current.depth, p);

  // Doors stand far enough apart for one to be out of view when the other is centred.
  const visible = 2 * Math.max(fitA, fitB) * HALF * aspect;
  const spacing = visible / 2 + Math.max(current.width, other ? other.width : current.width) / 2 + 1.5;
  layout = { spacing, unitsPerPixel: viewW ? visible / viewW : 0 };
  current.pivot.position.x = move ? -move.dir * p * spacing : 0;
  if (other) other.pivot.position.x = move.dir * (1 - p) * spacing;

  if (other) aimSun((current.pivot.position.x + other.pivot.position.x) / 2, spacing / 2 + Math.max(current.reach, other.reach), Math.max(current.reach, other.reach));
  else aimSun(current.pivot.position.x, current.reach, current.reach);

  // The front layer stays clean; every block further back fades by DEPTH_FADE.
  scene.fog.near = fit + 1;
  scene.fog.far = scene.fog.near + 1 / DEPTH_FADE;

  current.play(now, debug.freeze);
  other?.play(now, null);

  if (!still) drift.lerp(pointer, 0.06);
  camera.position.set(-drift.x * PARALLAX, -drift.y * PARALLAX, fit + depth / 2);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
loadDoor(neighbour(1));
loadDoor(neighbour(-1));

// Handy while tuning the scene from the console.
window.__door = Object.assign(debug, { camera, scene, renderer, go });
Object.defineProperties(window.__door, {
  player: { get: () => current.player },
  door: { get: () => current.door },
});
