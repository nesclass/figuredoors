import * as THREE from 'three';
import { DoorPlayer } from './player.js';
import { FACING } from './blocks.js';
import '@fontsource/jersey-15';
import './style.css';
import { initUi } from './ui.js';
import { initProgress } from './progress.js';

// ---- knobs worth playing with -------------------------------------------------
const TICK_MS = 100;        // one game tick on screen (the game runs at 50)
const HOLD_OPEN_MS = 1400;  // pause while the door is open
const HOLD_CLOSED_MS = 2600; // pause while the figure is shown
const FOV = 22;             // long lens: close to a flat front view
const FILL = 0.8;           // share of the viewport the door may take
const PARALLAX = 0.45;      // how far the camera drifts with the pointer, in blocks
const DEPTH_FADE = 0.3;     // how much each layer further back sinks into the shade
const SUN_ELEVATION = 24;   // degrees above the line of sight
const SHADOW = 0.5;         // 0 = no cast shadows, 1 = black

const canvas = document.querySelector('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x27324a, 1, 100);
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);

async function loadDoor() {
  const base = import.meta.env.BASE_URL;
  const manifest = await (await fetch(`${base}doors/index.json`)).json();
  const wanted = new URLSearchParams(location.search).get('door');
  const entry = manifest.find((d) => d.id === wanted) ?? manifest[Math.floor(Math.random() * manifest.length)];
  return (await fetch(`${base}doors/${entry.id}.json`)).json();
}

initUi();

const door = await loadDoor();
initProgress({ current: door.id.replace(/[^01]/g, '') });

const player = new DoorPlayer(door);
const [sx, sy, sz] = door.size;
const center = new THREE.Vector3(sx / 2, sy / 2, sz / 2);
scene.add(player.group);

// The viewer stood in front of the door looking along `front`.
const front = new THREE.Vector3(...FACING[door.front]);
const up = new THREE.Vector3(0, 1, 0);
const right = new THREE.Vector3().crossVectors(front, up);
const width = Math.abs(right.x) * sx + Math.abs(right.z) * sz;
const depth = Math.abs(front.x) * sx + Math.abs(front.z) * sz;

// Light comes from the viewer's side and from above, with no sideways lean:
// recessed blocks get an even band of shade along their top edge.
scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c2d6, 1.7));
const sun = new THREE.DirectionalLight(0xfff6e6, 1.9);
const elevation = THREE.MathUtils.degToRad(SUN_ELEVATION);
sun.position.copy(center).addScaledVector(front, -20 * Math.cos(elevation)).addScaledVector(up, 20 * Math.sin(elevation));
sun.target.position.copy(center);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const reach = Math.max(width, sy) * 0.75 + 1;
Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: 50 });
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 6;
sun.shadow.intensity = SHADOW;
scene.add(sun, sun.target);

let distance = 20;
let viewW = 0, viewH = 0;
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  viewW = w;
  viewH = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const half = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const fitHeight = sy / FILL / 2 / half;
  const fitWidth = width / FILL / 2 / (half * camera.aspect);
  distance = Math.max(fitHeight, fitWidth) + depth / 2;
  camera.updateProjectionMatrix();
  // The front layer stays clean; every block further back fades by DEPTH_FADE.
  scene.fog.near = distance - depth / 2 + 1;
  scene.fog.far = scene.fog.near + 1 / DEPTH_FADE;
}
resize();

const pointer = new THREE.Vector2();
const drift = new THREE.Vector2();
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
window.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
});

// close -> hold -> open -> hold -> ...
const phases = [
  { clip: 'close', hold: HOLD_OPEN_MS },
  { clip: 'open', hold: HOLD_CLOSED_MS },
];
let phase = 0;
let phaseStart = performance.now();
player.setClip(phases[0].clip);

// Set window.__door.freeze = { clip: 'close', time: 3.5 } in the console to inspect one moment.
const debug = { freeze: null };

function frame(now) {
  if (debug.freeze) {
    if (player.clipName !== debug.freeze.clip) player.setClip(debug.freeze.clip);
    player.setTime(debug.freeze.time);
    phaseStart = now;
  } else {
    const { clip, hold } = phases[phase];
    if (player.clipName !== clip) player.setClip(clip);
    const ticks = (now - phaseStart - hold) / TICK_MS;
    player.setTime(ticks);
    if (ticks >= player.length) {
      phase = (phase + 1) % phases.length;
      phaseStart = now;
      player.setClip(phases[phase].clip);
    }
  }

  // The stage changes size while the panel slides, so follow it frame by frame.
  if (canvas.clientWidth !== viewW || canvas.clientHeight !== viewH) resize();

  if (!still) drift.lerp(pointer, 0.06);
  camera.position.copy(center)
    .addScaledVector(front, -distance)
    .addScaledVector(right, -drift.x * PARALLAX)
    .addScaledVector(up, -drift.y * PARALLAX);
  camera.lookAt(center);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy while tuning the scene from the console.
window.__door = Object.assign(debug, { player, door, camera, scene, renderer });
