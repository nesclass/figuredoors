// The three block buttons and the panel they open.

import { fillGlyph } from './progress.js';

// A closed door as a 3x3 picture, from the front or from the back.
// Front: the figure's cells are flush, the empty ones sit one block back.
// Back (mirrored, as you would see it): the empty cells are the only blocks;
// behind the figure's cells nothing is needed.
function fillWall(el) {
  const rows = el.dataset.figure.match(/.../g);
  const back = el.dataset.side === 'back';
  const cells = rows.flatMap((row) => [...(back ? [...row].reverse().join('') : row)]);
  el.replaceChildren(...cells.map((bit) => {
    const cell = document.createElement('i');
    cell.className = back ? (bit === '1' ? 'none' : 'block') : (bit === '1' ? 'block' : 'deep');
    return cell;
  }));
}

export function initUi() {
  const app = document.querySelector('#app');
  const panel = document.querySelector('#panel');
  const buttons = [...document.querySelectorAll('[data-open]')];
  const sections = [...panel.querySelectorAll('[data-section]')];
  let open = null;

  for (const el of document.querySelectorAll('.glyph[data-figure]')) fillGlyph(el, el.dataset.figure);
  for (const el of document.querySelectorAll('.wall[data-figure]')) fillWall(el);

  function show(name) {
    open = name;
    app.classList.toggle('is-open', !!name);
    panel.inert = !name;
    for (const b of buttons) b.setAttribute('aria-expanded', String(b.dataset.open === name));
    // Keep the last section in place while the panel slides shut.
    if (name) for (const s of sections) s.hidden = s.dataset.section !== name;
  }

  for (const b of buttons) b.addEventListener('click', () => show(open === b.dataset.open ? null : b.dataset.open));
  panel.querySelector('.close').addEventListener('click', () => {
    const from = buttons.find((b) => b.dataset.open === open);
    show(null);
    from?.focus();
  });
  // Pages inside Join, so none needs scrolling. Anything with data-page opens
  // one; a link inside a page names the tab it belongs to with data-tab.
  const links = [...panel.querySelectorAll('[data-page]')];
  const pages = [...panel.querySelectorAll('[data-page-body]')];
  for (const link of links) {
    link.addEventListener('click', () => {
      const tab = link.dataset.tab ?? link.dataset.page;
      for (const o of links) if (o.getAttribute('role') === 'tab') o.setAttribute('aria-selected', String(o.dataset.page === tab));
      for (const pg of pages) pg.hidden = pg.dataset.pageBody !== link.dataset.page;
    });
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) show(null); });
}
