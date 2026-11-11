// The "soft" look: game models with calmer textures, halfway between a
// resource pack and the hand-drawn look. It is described here and applied in
// two places: model changes at build time (tools/mc-assets.mjs), texture
// changes in the browser (src/mcblocks.js).
//
//   style    how every texture is calmed down
//   derived  textures that do not exist as files: a base texture plus paint
//   tweaks   changes to the game's models, by model name
//
// The hints follow the idea of the Vanilla Tweaks utility packs: slime on the
// sides of sticky pistons, arrows on blocks that have a direction.

const RED = '#a8554b';   // brick red, quiet next to the grey of an observer
const STONE = '#3f444b';
const STEEL = '#8a8f96';

export const softLook = {
  style: {
    merge: 72,     // colours closer than this (RGB distance) count as one material
    flatten: 0.7,  // how far a material is pulled towards its average colour, 0..1
    rim: 0.8,      // brightness of the one-pixel edge on full block faces
    saturate: 0.8, // colour strength of every texture, 1 = as in the pack
  },

  derived: {
    'block/sticky_piston_side': { from: 'block/piston_side', paint: 'slime' },
    'block/observer_side_arrow': { from: 'block/observer_side', paint: 'arrow', dir: 'right', color: RED },
    'block/observer_top_arrow': { from: 'block/observer_top', paint: 'arrow', dir: 'up', color: RED, clear: true },
    'block/hopper_inside_arrow': { from: 'block/hopper_inside', paint: 'arrow', dir: 'up', color: STEEL },
    'block/hopper_inside_dot': { from: 'block/hopper_inside', paint: 'dot', color: STEEL },
    'block/furnace_side_arrow': { from: 'block/furnace_side', paint: 'arrow', dir: 'right', color: STONE },
    'block/furnace_top_arrow': { from: 'block/furnace_top', paint: 'arrow', dir: 'up', color: STONE },
  },

  tweaks: {
    // Slime shows on the sides of the plate, the rod stays plain.
    'block/sticky_piston': (m) => { m.textures.side = 'block/sticky_piston_side'; },
    'block/piston_head_sticky': stickyHead,
    'block/piston_head_short_sticky': stickyHead,

    // Arrows run from the face to the output. The same picture is used on both
    // sides, so it is mirrored on one of them.
    'block/observer': (m) => {
      m.textures.side = 'block/observer_side_arrow';
      m.textures.top = 'block/observer_top_arrow';
      m.elements[0].faces.east.uv = [16, 0, 0, 16];
    },

    // The bowl shows where the items go: an arrow towards the spout, or a dot
    // when they go straight down.
    'block/hopper_side': (m) => { m.elements[0].faces.up.texture = 'block/hopper_inside_arrow'; },
    'block/hopper': (m) => { m.elements[0].faces.up.texture = 'block/hopper_inside_dot'; },

    'block/dispenser': towardsFront,
    'block/dropper': towardsFront,
    'block/dispenser_vertical': towardsTop,
    'block/dropper_vertical': towardsTop,
  },
};

// "softer": the same look one step simpler - materials merge more readily and
// keep less of their pattern. "soft" stays as it was, to go back to.
// chroma: a difference in colour weighs this many times more than one in
// brightness when materials are told apart, so wood never merges into stone.
export const softerLook = {
  ...softLook,
  style: { ...softLook.style, merge: 90, flatten: 0.88, chroma: 2.5 },
};

function stickyHead(m) {
  const plate = 'block/sticky_piston_side';
  for (const face of Object.values(m.elements[0].faces)) if (face.texture === '#side') face.texture = plate;
}

// A block that faces north: arrows on the top and on both sides point north.
function towardsFront(m) {
  const { faces } = m.elements[0];
  faces.up = { ...faces.up, texture: 'block/furnace_top_arrow', uv: [0, 0, 16, 16] };
  faces.east = { ...faces.east, texture: 'block/furnace_side_arrow', uv: [0, 0, 16, 16] };
  faces.west = { ...faces.west, texture: 'block/furnace_side_arrow', uv: [16, 0, 0, 16] };
}

// A block that faces up: arrows on all four sides point up.
function towardsTop(m) {
  const { faces } = m.elements[0];
  for (const dir of ['north', 'south', 'east', 'west']) faces[dir] = { ...faces[dir], texture: 'block/furnace_top_arrow', uv: [0, 0, 16, 16] };
}
