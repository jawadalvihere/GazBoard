// "Which pages?" dialog shown when a document is imported.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

/** Turn "1-3, 7, 9-" into [1,2,3,7,9,10,...] clamped to `count`. */
export function parseRange(text, count) {
  const out = new Set();
  for (const chunk of String(text).split(/[,\s]+/)) {
    if (!chunk) continue;
    const m = chunk.match(/^(\d+)?\s*-\s*(\d+)?$/);
    if (m) {
      const a = Math.max(1, parseInt(m[1] || '1', 10));
      const b = Math.min(count, parseInt(m[2] || String(count), 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(chunk)) {
      const n = parseInt(chunk, 10);
      if (n >= 1 && n <= count) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function formatRange(pages) {
  if (!pages.length) return '';
  const parts = [];
  let start = pages[0], prev = pages[0];
  for (const p of pages.slice(1)) {
    if (p === prev + 1) { prev = p; continue; }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = p;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(', ');
}

const THUMB_LIMIT = 400;   // beyond this, skip previews and use the range box alone

export const QUALITY = [
  { id: 2,   label: t('Standard'), dpi: 144, note: t('crisp on screen, small boards') },
  { id: 3,   label: t('High'),     dpi: 216, note: t('holds up when you zoom in') },
  { id: 4.2, label: t('Maximum'),  dpi: 300, note: t('print resolution, large boards') }
];

/**
 * @param {object} app
 * @param {{name:string, count:number, thumb:(n:number)=>Promise<string>}} doc
 * @returns {Promise<null | {pages:number[], layout, quality:number}>}
 */
export function choosePages(app, doc) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('overlay');
    const card = document.getElementById('overlayCard');
    card.innerHTML = '';
    card.classList.add('picker');

    const chosen = new Set(Array.from({ length: doc.count }, (_, i) => i + 1));
    let layout = doc.count > 6 ? 'grid' : 'row';
    let quality = app.settings.importQuality || 2;
    let cancelled = false;

    const done = (value) => {
      cancelled = true;
      overlay.classList.remove('show');
      card.classList.remove('picker');
      card.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && !e.target.matches('input[type=text]')) { e.preventDefault(); confirm(); }
    };
    document.addEventListener('keydown', onKey, true);

    /* ---------------- header ---------------- */
    card.appendChild(h('h3', {}, t('Import pages')));
    card.appendChild(h('p', { style: 'margin-bottom:10px' },
      doc.count === 1
        ? t('{name} — {count} page. Each page comes in as its own object you can move, resize and annotate separately.', { name: doc.name, count: doc.count })
        : t('{name} — {count} pages. Each page comes in as its own object you can move, resize and annotate separately.', { name: doc.name, count: doc.count })));

    /* ---------------- selection controls ---------------- */
    const rangeInput = h('input', { type: 'text', class: 'range-input', value: `1-${doc.count}`, spellcheck: 'false',
      placeholder: t('e.g. 1-3, 7, 10-12') });
    const countLabel = h('span', { class: 'pick-count' });

    const setAll = (on) => {
      chosen.clear();
      if (on) for (let i = 1; i <= doc.count; i++) chosen.add(i);
      syncFromModel();
    };

    const controls = h('div', { class: 'pick-controls' },
      h('button', { class: 'btn', onclick: () => setAll(true) }, t('All')),
      h('button', { class: 'btn', onclick: () => setAll(false) }, t('None')),
      h('span', { style: 'font-size:13px;color:var(--text-2);margin-left:4px' }, t('Pages')),
      rangeInput,
      countLabel
    );
    card.appendChild(controls);

    /* ---------------- thumbnails ---------------- */
    const grid = h('div', { class: 'pick-grid' });
    const tiles = new Map();
    if (doc.count <= THUMB_LIMIT) {
      for (let n = 1; n <= doc.count; n++) {
        const img = h('div', { class: 'pick-thumb-img' });
        const tile = h('button', { class: 'pick-tile', title: t('Page {n}', { n }) },
          img, h('span', { class: 'pick-num' }, String(n)), h('span', { class: 'pick-check', html: icon('check', 13) }));
        tile.addEventListener('click', () => {
          chosen.has(n) ? chosen.delete(n) : chosen.add(n);
          syncFromModel();
        });
        tiles.set(n, { tile, img });
        grid.appendChild(tile);
      }
      card.appendChild(grid);
    } else {
      card.appendChild(h('p', { style: 'font-size:12.5px' },
        t('Too many pages to preview — type the ones you want above.')));
    }

    /* ---------------- layout ---------------- */
    const layoutRow = h('div', { class: 'pick-controls', style: 'margin-top:12px' },
      h('span', { style: 'font-size:13px;color:var(--text-2)' }, t('Arrange')),
      ...[['row', t('In a row')], ['grid', t('In a grid')], ['stack', t('Stacked')]].map(([id, label]) => {
        const b = h('button', { class: 'btn' + (layout === id ? ' primary' : '') }, label);
        b.dataset.layout = id;
        b.addEventListener('click', () => {
          layout = id;
          for (const el of layoutRow.querySelectorAll('[data-layout]'))
            el.classList.toggle('primary', el.dataset.layout === id);
        });
        return b;
      })
    );
    card.appendChild(layoutRow);

    /* ---------------- quality ---------------- */
    const sizeHint = h('span', { class: 'pick-count' });
    const qualityRow = h('div', { class: 'pick-controls', style: 'margin-top:10px' },
      h('span', { style: 'font-size:13px;color:var(--text-2)' }, t('Quality')),
      ...QUALITY.map((q) => {
        const b = h('button', { class: 'btn' + (quality === q.id ? ' primary' : ''), title: t('{dpi} dpi — {note}', { dpi: q.dpi, note: q.note }) },
          q.label);
        b.dataset.q = String(q.id);
        b.addEventListener('click', () => {
          quality = q.id;
          app.settings.importQuality = q.id;
          app.saveSettings();
          for (const el of qualityRow.querySelectorAll('[data-q]'))
            el.classList.toggle('primary', el.dataset.q === String(q.id));
          syncFromModel();
        });
        return b;
      }),
      sizeHint
    );
    card.appendChild(qualityRow);

    /* ---------------- actions ---------------- */
    const importBtn = h('button', { class: 'btn primary', onclick: () => confirm() }, t('Import'));
    card.appendChild(h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => done(null) }, t('Cancel')),
      importBtn));

    function confirm() {
      const pages = [...chosen].sort((a, b) => a - b);
      if (!pages.length) return;
      done({ pages, layout, quality });
    }

    /* ---------------- keeping the two inputs in step ---------------- */
    let typing = false;
    function syncFromModel() {
      const pages = [...chosen].sort((a, b) => a - b);
      if (!typing) rangeInput.value = formatRange(pages);
      countLabel.textContent = pages.length
        ? t('{n} of {count} selected', { n: pages.length, count: doc.count })
        : t('none selected');
      importBtn.toggleAttribute('disabled', pages.length === 0);
      importBtn.textContent = pages.length ? (pages.length === 1 ? t('Import {n} page', { n: pages.length }) : t('Import {n} pages', { n: pages.length })) : t('Import');
      const q = QUALITY.find((x) => x.id === quality) || QUALITY[0];
      // rough: an A4 page as PNG at this scale, times the page count
      const mb = pages.length * (q.dpi / 144) ** 2 * 0.9;
      sizeHint.textContent = pages.length ? t('{dpi} dpi · about {mb} MB on the board', { dpi: q.dpi, mb: mb < 1 ? '<1' : Math.round(mb) }) : '';
      for (const [n, { tile }] of tiles) tile.classList.toggle('on', chosen.has(n));
    }
    rangeInput.addEventListener('input', () => {
      typing = true;
      chosen.clear();
      for (const n of parseRange(rangeInput.value, doc.count)) chosen.add(n);
      syncFromModel();
      typing = false;
    });
    syncFromModel();

    overlay.classList.add('show');

    /* ---------------- previews, rendered in the background ---------------- */
    (async () => {
      for (let n = 1; n <= doc.count && tiles.size; n++) {
        if (cancelled) return;
        try {
          const url = await doc.thumb(n);
          const t = tiles.get(n);
          if (t) t.img.style.backgroundImage = `url("${url}")`;
        } catch { /* a page that will not preview can still be imported */ }
      }
    })();
  });
}
