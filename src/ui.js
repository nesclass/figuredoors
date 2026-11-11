// The three block buttons and the panel they open.

import { fillGlyph } from './progress.js';

export function initUi() {
  const app = document.querySelector('#app');
  const panel = document.querySelector('#panel');
  const buttons = [...document.querySelectorAll('[data-open]')];
  const sections = [...panel.querySelectorAll('[data-section]')];
  let open = null;

  for (const el of document.querySelectorAll('.glyph[data-figure]')) fillGlyph(el, el.dataset.figure);

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
  // Two pages inside Join, so neither needs scrolling.
  const tabs = [...panel.querySelectorAll('[data-page]')];
  const pages = [...panel.querySelectorAll('[data-page-body]')];
  for (const t of tabs) {
    t.addEventListener('click', () => {
      for (const o of tabs) o.setAttribute('aria-selected', String(o === t));
      for (const pg of pages) pg.hidden = pg.dataset.pageBody !== t.dataset.page;
    });
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) show(null); });
}
