// Plays a door file produced by tools/build-doors.mjs.
//
// A clip is a start state plus one entry per game tick. Time is measured in
// ticks and may be fractional: static blocks switch on whole ticks, blocks
// carried by pistons slide smoothly in between.

import * as THREE from 'three';
import { makeBlock, setHeadExtension } from './blocks.js';

// Piston facing as stored in the recording.
const DIRS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

const smooth = (p) => p * p * (3 - 2 * p);

export class DoorPlayer {
  constructor(door) {
    this.door = door;
    const [sx, sy, sz] = door.size;
    this.cellCount = sx * sy * sz;
    this.group = new THREE.Group();
    this.statics = new THREE.Group();
    this.movers = new THREE.Group();
    this.group.add(this.statics, this.movers);
    this.objects = new Array(this.cellCount).fill(null);
    this.states = new Int32Array(this.cellCount).fill(-1);
    this.moving = [];
    this.clipName = null;
    this.tick = 0;
  }

  get length() {
    return this.door.clips[this.clipName].ticks.length;
  }

  cellPosition(i, out = new THREE.Vector3()) {
    const [sx, , sz] = this.door.size;
    return out.set((i % sx) + 0.5, Math.floor(i / (sx * sz)) + 0.5, (Math.floor(i / sx) % sz) + 0.5);
  }

  setCell(i, state) {
    if (this.states[i] === state) return;
    if (this.objects[i]) this.statics.remove(this.objects[i]);
    this.states[i] = state;
    const obj = makeBlock(this.door.palette[state]);
    if (obj) {
      this.cellPosition(i, obj.position);
      this.statics.add(obj);
    }
    this.objects[i] = obj;
  }

  // Shows the first frame of a clip.
  setClip(name) {
    this.clipName = name;
    const clip = this.door.clips[name];
    clip.start.forEach((s, i) => this.setCell(i, s));
    this.tick = 0;
    this.setMoving([]);
  }

  setMoving(list) {
    this.movers.clear();
    this.moving = [];
    for (const [cell, stateId, dir, extending, progress, source] of list) {
      const state = this.door.palette[stateId];
      const at = this.cellPosition(cell);
      const d = new THREE.Vector3(...DIRS[dir]);
      let obj;
      if (source && !extending) {
        // A retracting piston: its body stays put, only the head travels back.
        const body = makeBlock({ name: state.name, props: { ...state.props, extended: 'true' } });
        body.position.copy(at);
        this.movers.add(body);
        obj = makeBlock({ name: 'piston_head', props: { facing: state.props.facing, type: state.name === 'sticky_piston' ? 'sticky' : 'normal' } });
      } else {
        obj = makeBlock(state);
      }
      if (!obj) continue;
      this.movers.add(obj);
      // source: the head of the piston doing the pushing (not a block being carried).
      this.moving.push({ obj, at, d, extending, progress, ownHead: !!source });
    }
  }

  // time: ticks since the start of the clip, clamped to the clip length.
  setTime(time) {
    const clip = this.door.clips[this.clipName];
    const n = clip.ticks.length;
    const t = Math.min(Math.max(time, 0), n);
    const whole = Math.min(Math.floor(t), n);
    const frac = t - whole;
    if (whole < this.tick) this.setClip(this.clipName);
    let changed = false;
    while (this.tick < whole) {
      const { set } = clip.ticks[this.tick];
      for (let i = 0; i < set.length; i += 2) this.setCell(set[i], set[i + 1]);
      this.tick++;
      changed = true;
    }
    if (changed) this.setMoving(whole > 0 ? clip.ticks[whole - 1].mov : []);
    for (const m of this.moving) {
      // Progress advances half a block per tick; the recorded value is where the tick starts.
      const p = smooth(Math.min(1, m.progress + 0.5 * frac));
      const offset = m.extending ? p - 1 : 1 - p;
      m.obj.position.copy(m.at).addScaledVector(m.d, offset);
      // An extending head sits in its final cell and arrives; a retracting one
      // is anchored to the piston body and returns to it.
      if (m.ownHead) setHeadExtension(m.obj, m.extending ? p : 1 - p);
    }
  }
}
