// The plate under the door: the figure as a glyph and as digits, then who built
// it, with arrows to the neighbouring doors at both ends.

import { fillGlyph, loadSheet, player, spaced } from './progress.js';
import { mcText } from './mcfont.js';

// A builder: the head, then the name in the game's font where that is built.
function builder(name) {
  const tag = player(name);
  const label = tag.lastChild;
  mcText(name, { color: '#1c2536', shadow: 'rgba(28, 37, 54, 0.16)' }).then((canvas) => { if (canvas) label.replaceWith(canvas); });
  return tag;
}

// many: there is more than one door to flip through. onGo(-1 | 1) flips.
export function initCaption({ many, onGo }) {
  const pager = document.querySelector('#pager');
  const glyph = pager.querySelector('.glyph');
  const code = pager.querySelector('.code');
  const who = pager.querySelector('.who');
  let shown = null;

  for (const btn of pager.querySelectorAll('[data-go]')) {
    btn.hidden = !many;
    btn.addEventListener('click', () => onGo(Number(btn.dataset.go)));
  }

  return {
    show(id) {
      shown = id;
      const bits = id.replace(/[^01]/g, '');
      const figure = bits.length === 9 && /^[01-]+$/.test(id);
      glyph.replaceChildren();
      if (figure) fillGlyph(glyph, bits);
      code.textContent = figure ? spaced(bits) : id;
      who.replaceChildren();
      if (!figure) return;
      // The builder comes from the sheet; the line simply stays shorter without it.
      loadSheet().then((doors) => {
        if (shown !== id) return;
        const { builders } = doors[parseInt(bits, 2)];
        who.replaceChildren(...builders.map(builder));
      }).catch(() => {});
    },
  };
}
