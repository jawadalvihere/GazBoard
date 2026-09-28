// Right-click menu and the floating selection toolbar.

import { h, openPopover, closePopover } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { PEN_COLORS, NOTE_COLORS, TEXT_COLORS, SHAPE_STROKES, SHAPE_FILLS } from './palettes.js';

function item(label, iconName, onClick, opts = {}) {
  const b = h('button', { class: 'menu-item' + (opts.danger ? ' danger' : '') },
    h('span', { html: icon(iconName, 17), style: 'display:flex' }),
    h('span', {}, label),
    opts.key ? h('span', { class: 'k' }, opts.key) : null);
  if (opts.disabled) b.setAttribute('disabled', '');
  b.addEventListener('click', () => { closePopover(); onClick(); });
  return b;
}

export function showContextMenu(app, e, fromSelectionBar = false) {
  const sel = app.surface.selection;
  const wp = app.surface.toWorld(e);

  // right-clicking an unselected object selects it first
  const hit = fromSelectionBar ? null : app.pickAt(wp);
  if (hit && !sel.has(hit.id)) app.setSelection([hit.id]);

  const has = app.surface.selection.size > 0;
  const one = app.surface.selection.size === 1 ? app.store.get([...app.surface.selection][0]) : null;
  const editable = one && ['note', 'text', 'shape', 'table'].includes(one.type);

  const menu = h('div', { class: 'menu' });
  const allLocked = has && app.selected.every((o) => o.locked);
  // Lifting a cover is the one thing a cover is for, so it leads - locked or not.
  if (has && app.selected.some((o) => o.type === 'curtain' && !o.revealed)) {
    menu.appendChild(item(t('Reveal'), 'eye', () => app.command('curtain.reveal')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
  }

  if (allLocked) {
    menu.appendChild(item(t('Unlock'), 'unlock', () => app.command('edit.lock')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Copy'), 'copy', () => app.command('edit.copy'), { key: 'Ctrl+C' }));
    menu.appendChild(item(t('Export selection as PNG…'), 'image', () => app.command('export.pngSelection')));
    openPopover({ x: e.clientX, y: e.clientY }, menu, { key: 'ctx' });
    return;
  }

  if (has) {
    if (editable) menu.appendChild(item(t('Edit text'), 'text', () => app.beginTextEdit(one), { key: 'F2' }));
    menu.appendChild(item(t('Cut'), 'copy', () => app.command('edit.cut'), { key: 'Ctrl+X' }));
    menu.appendChild(item(t('Copy'), 'copy', () => app.command('edit.copy'), { key: 'Ctrl+C' }));
    menu.appendChild(item(t('Duplicate'), 'duplicate', () => app.command('edit.duplicate'), { key: 'Ctrl+D' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    const grouped = app.selectedGroups().size > 0;
    if (app.surface.selection.size > 1 && !grouped) {
      menu.appendChild(item(t('Group'), 'group', () => app.command('edit.group'), { key: 'Ctrl+G' }));
    }
    if (grouped) {
      if (app.selectedGroups().size === 1) {
        const named = app.selected.find((o) => o.groupName)?.groupName;
        menu.appendChild(item(named ? t('Rename group ({name})', { name: named }) : t('Name this group…'), 'text',
          () => app.command('edit.nameGroup')));
      }
      menu.appendChild(item(t('Ungroup'), 'ungroup', () => app.command('edit.ungroup'), { key: 'Ctrl+Shift+G' }));
      if (app.surface.selection.size > 1) {
        menu.appendChild(item(t('Group again'), 'group', () => app.command('edit.group'), { key: 'Ctrl+G' }));
      }
    }
    if (grouped || app.surface.selection.size > 1) menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Bring to front'), 'front', () => app.command('order.front'), { key: 'Ctrl+Shift+]' }));
    menu.appendChild(item(t('Send to back'), 'front', () => app.command('order.back'), { key: 'Ctrl+Shift+[' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    const locked = [...app.surface.selection].every((id) => app.store.get(id)?.locked);
    menu.appendChild(item(locked ? t('Unlock') : t('Lock'), locked ? 'unlock' : 'lock', () => app.command('edit.lock')));
    menu.appendChild(item(t('Export selection as PNG…'), 'image', () => app.command('export.pngSelection')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Delete'), 'trash', () => app.command('edit.delete'), { key: 'Del', danger: true }));
  } else {
    // Pasted where you pressed, not back where the originals were - which is
    // the whole point of asking for it at a particular spot.
    menu.appendChild(item(t('Paste'), 'copy', () => app.pasteAt(wp), { key: 'Ctrl+V' }));
    menu.appendChild(item(t('Select all'), 'select', () => app.command('edit.selectAll'), { key: 'Ctrl+A' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Sticky note here'), 'note', () => app.addNoteAt(wp)));
    menu.appendChild(item(t('Text here'), 'text', () => app.addTextAt(wp)));
    menu.appendChild(item(t('Insert image…'), 'image', () => app.command('insert.image')));
    menu.appendChild(item(t('Insert document…'), 'doc', () => app.command('insert.document')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Templates…'), 'template', () => app.panels.templates()));
    menu.appendChild(item(t('Canvas…'), 'palette', () => app.panels.background()));
    menu.appendChild(item(t('Clear canvas'), 'trash', () => app.command('edit.clear'), { danger: true }));
  }
  openPopover({ x: e.clientX, y: e.clientY }, menu, { key: 'ctx' });
}

/* ------------------------------------------------------------------ *
 *  Floating toolbar above the current selection
 * ------------------------------------------------------------------ */
export function updateSelectionBar(app) {
  const bar = document.getElementById('ctxbar');
  const sel = [...app.surface.selection].map((id) => app.store.get(id)).filter(Boolean);
  if (!sel.length || app.textEditor.active) { bar.classList.remove('show'); return; }

  const box = app.surface.selectionScreenBox(10);
  if (!box) { bar.classList.remove('show'); return; }

  bar.innerHTML = '';
  const types = new Set(sel.map((o) => o.type));
  const allLocked = sel.every((o) => o.locked);
  /*
   * An answer cover gets a Reveal button with its name on it rather than an
   * icon alone: it is pressed in front of a class, and a teacher hunting for
   * the right little eye is the pause this whole feature exists to remove.
   */
  const covers = sel.filter((o) => o.type === 'curtain' && !o.revealed);
  const revealBtn = () => {
    const b = h('button', { title: t('Reveal what is underneath'), class: 'reveal-btn', html: icon('eye', 17) });
    b.insertAdjacentHTML('beforeend', t('<span>Reveal</span>'));
    b.addEventListener('click', () => app.command('curtain.reveal'));
    return b;
  };

  if (allLocked) {
    const label = h('span', { style: 'display:flex;align-items:center;gap:6px;padding:0 8px;font-size:12.5px;color:var(--text-2)' },
      h('span', { html: icon('lock', 15), style: 'display:flex' }),
      h('span', {}, sel.length > 1 ? t('{n} locked', { n: sel.length }) : t('Locked')));
    bar.appendChild(label);
    const unlock = h('button', { title: t('Unlock'), html: icon('unlock', 17) });
    unlock.addEventListener('click', () => app.command('edit.lock'));
    unlock.style.cssText += 'width:auto;padding:0 10px;gap:6px;color:var(--accent-2)';
    unlock.insertAdjacentHTML('beforeend', t('<span style="font-size:12.5px">Unlock</span>'));
    unlock.style.display = 'flex';
    unlock.style.alignItems = 'center';
    bar.appendChild(unlock);
    if (covers.length) bar.appendChild(revealBtn());
    appendMoreActions(app, bar);
    placeBar(bar, box);
    return;
  }

  const mk = (title, iconName, fn) => {
    const b = h('button', { title, html: icon(iconName, 17) });
    b.addEventListener('click', fn);
    return b;
  };

  // colour control, only for the things that actually have a colour
  const COLOURABLE = new Set(['stroke', 'shape', 'note', 'text', 'table']);
  if (types.size === 1 && COLOURABLE.has([...types][0])) {
    const type = [...types][0];
    const swatch = h('button', { class: 'colour-btn', title: t('Colour') });
    const dot = h('span', {});
    const currentColor = type === 'shape' ? sel[0].stroke : sel[0].color;
    dot.style.cssText = `width:17px;height:17px;border-radius:50%;background:${currentColor || '#201f1e'};box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)`;
    swatch.appendChild(dot);
    swatch.addEventListener('click', () => openColorPopover(app, swatch, type, sel));
    bar.appendChild(swatch);
  }

  if (covers.length) bar.appendChild(revealBtn());

  if ([...types].every((t) => ['note', 'text', 'shape', 'table'].includes(t)) && sel.length === 1)
    bar.appendChild(mk(t('Edit text (F2)'), 'text', () => app.beginTextEdit(sel[0])));

  // a table gets its own row and column controls
  if (sel.length === 1 && sel[0].type === 'table') {
    const tbl = sel[0];
    bar.appendChild(h('span', { class: 'bar-sep' }));
    bar.appendChild(mk(t('Add row'), 'rowAdd', () => app.command('table.addRow')));
    const lessRow = mk(t('Remove row'), 'rowDel', () => app.command('table.removeRow'));
    if ((tbl.rows | 0) <= 1) lessRow.disabled = true;
    bar.appendChild(lessRow);
    bar.appendChild(mk(t('Add column'), 'colAdd', () => app.command('table.addCol')));
    const lessCol = mk(t('Remove column'), 'colDel', () => app.command('table.removeCol'));
    if ((tbl.cols | 0) <= 1) lessCol.disabled = true;
    bar.appendChild(lessCol);
    bar.appendChild(h('span', { class: 'bar-sep' }));
  }

  // Touchscreens have no Ctrl to hold, so gathering several up is a mode here.
  if (matchMedia('(pointer: coarse)').matches) {
    const more = mk(app.multiSelect ? t('Done adding') : t('Add more to the selection'),
      app.multiSelect ? 'check' : 'select', () => app.setMultiSelect(!app.multiSelect));
    if (app.multiSelect) more.classList.add('on');
    bar.appendChild(more);
  }

  const grouped = app.selectedGroups().size > 0;
  if (grouped && app.selectedGroups().size === 1) {
    bar.appendChild(mk(t('Name this group'), 'text', () => app.command('edit.nameGroup')));
  }
  if (grouped) bar.appendChild(mk(t('Ungroup (Ctrl+Shift+G)'), 'ungroup', () => app.command('edit.ungroup')));
  else if (sel.length > 1) bar.appendChild(mk(t('Group (Ctrl+G)'), 'group', () => app.command('edit.group')));
  bar.appendChild(mk(t('Duplicate (Ctrl+D)'), 'duplicate', () => app.command('edit.duplicate')));
  bar.appendChild(mk(t('Bring to front'), 'front', () => app.command('order.front')));
  bar.appendChild(mk(sel.every((o) => o.locked) ? t('Unlock') : t('Lock'), sel.every((o) => o.locked) ? 'unlock' : 'lock', () => app.command('edit.lock')));
  bar.appendChild(mk(t('Delete (Del)'), 'trash', () => app.command('edit.delete')));

  appendMoreActions(app, bar);

  placeBar(bar, box);
}

function appendMoreActions(app, bar) {
  // Android still needs this route when a mouse changes the primary pointer.
  if (document.documentElement?.dataset.platform !== 'android'
      && !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) return;
  const button = h('button', { title: t('More actions'), html: icon('more', 17) });
  button.addEventListener('click', () => {
    const r = bar.getBoundingClientRect();
    // This button acts on the selection, not an object behind the toolbar.
    showContextMenu(app, { clientX: r.left + r.width - 12, clientY: r.bottom + 4 }, true);
  });
  bar.appendChild(button);
}

function placeBar(bar, box) {
  bar.classList.add('show');
  const stage = document.getElementById('stage').getBoundingClientRect();
  const w = bar.offsetWidth || 200;
  let left = box.x + box.w / 2 - w / 2;
  left = Math.max(8, Math.min(left, stage.width - w - 8));
  let top = box.y - bar.offsetHeight - 44;
  if (top < 8) top = Math.min(box.y + box.h + 12, stage.height - bar.offsetHeight - 80);
  top = Math.max(8, Math.min(top, stage.height - bar.offsetHeight - 8));
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function openColorPopover(app, anchor, type, sel) {
  const colors = type === 'note' ? NOTE_COLORS : type === 'text' ? TEXT_COLORS : type === 'shape' ? SHAPE_STROKES : PEN_COLORS;
  const grid = h('div', { class: 'swatches' });
  for (const c of colors) {
    const b = h('button', { class: 'sw', title: c });
    b.style.background = c;
    b.addEventListener('click', () => {
      const key = type === 'shape' ? 'stroke' : 'color';
      /*
       * Only the selection changes. Recolouring one sticky note, one line of
       * text or one stroke used to quietly become the colour of the NEXT one
       * too - and a recoloured stroke even changed the pen in your hand - so
       * fixing one word's colour left every later word that colour until you
       * noticed. What comes next is set where you choose what comes next: the
       * tool's own picker on the toolbar.
       */
      app.store.updateMany(sel.map((o) => o.id), { [key]: c }, 'recolour');
      closePopover();
      app.surface.invalidate();
      updateSelectionBar(app);
    });
    grid.appendChild(b);
  }
  const body = h('div', {}, h('h4', {}, type === 'shape' ? t('Outline') : t('Colour')), grid);

  if (type === 'shape') {
    const fills = h('div', { class: 'swatches' });
    for (const c of SHAPE_FILLS) {
      const b = h('button', { class: 'sw', title: c === 'none' ? t('No fill') : c });
      b.style.background = c === 'none' ? 'repeating-linear-gradient(45deg,#fff,#fff 4px,#ddd 4px,#ddd 8px)' : c;
      b.addEventListener('click', () => {
        app.store.updateMany(sel.map((o) => o.id), { fill: c }, 'fill');
        closePopover(); app.surface.invalidate();
      });
      fills.appendChild(b);
    }
    body.appendChild(h('h4', { style: 'margin-top:12px' }, t('Fill')));
    body.appendChild(fills);
  }
  openPopover(anchor, body, { key: 'selcolor' });
}
