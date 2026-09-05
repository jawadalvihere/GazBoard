// The lesson-room strip: which board you are looking at, and whose it is.
//
// Only ever on screen inside a room. Out of a room this file adds nothing to
// the app but the Share entry, so an ordinary board looks exactly as it did.

import { h } from '../ui/popover.js';
import { icon } from '../ui/icons.js';
import * as room from './room.js';
import { currentUser } from './client.js';

let _app = null;
let _bar = null;

export function mountRoomUI(app) {
  _app = app;

  _bar = h('div', { id: 'roomBar', hidden: true });
  const stage = document.getElementById('stage');
  stage.parentNode.insertBefore(_bar, stage);

  room.onRoomChange(render);
  render();

  const flush = () => room.flushOnHide();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

function render() {
  if (!_bar) return;
  if (!room.inRoom()) { _bar.hidden = true; return; }

  const mine = room.role();
  const viewing = room.viewing();
  _bar.hidden = false;
  _bar.innerHTML = '';

  const tab = (side, label) => h('button', {
    class: 'room-tab' + (viewing === side ? ' active' : '') + (mine === side ? ' own' : ''),
    onclick: () => room.showSide(side)
  }, label, mine === side ? h('span', { class: 'room-you' }, 'you') : null);

  _bar.appendChild(h('div', { class: 'room-tabs' },
    tab('teacher', 'Teacher'),
    tab('student', 'Student')));

  _bar.appendChild(h('div', { class: 'room-state' },
    room.isMine()
      ? 'Your board'
      : h('span', {}, h('span', { class: 'room-live' }), `Watching — ${viewing === 'teacher' ? 'teacher' : 'student'} is drawing`)));

  if (mine === 'teacher') {
    _bar.appendChild(h('button', {
      class: 'btn room-share',
      onclick: () => shareDialog(room.roomLink())
    }, 'Share link'));
  }
}

/* ---------------- starting and sharing a room ---------------- */

export async function startRoom(app) {
  const user = await currentUser();
  if (!user) {
    app.toast('Sign in first - a lesson room belongs to your account', 'close');
    return;
  }
  app.toast('Opening a lesson room…');
  const res = await room.createRoom(app.store.doc.name || 'Lesson');
  if (!res.ok) { app.toast(res.error, 'close'); return; }

  // Go through the join path rather than assuming the role, so the teacher
  // sees exactly what the link produces.
  history.replaceState(null, '', res.link);
  const joined = await room.enterRoom(app, res.token);
  if (joined) shareDialog(res.link);
}

export function shareDialog(link) {
  const app = _app;
  const overlay = document.getElementById('overlay');
  const card = document.getElementById('overlayCard');
  card.innerHTML = '';
  const close = () => { app._overlayDismiss = null; overlay.classList.remove('show'); };

  card.appendChild(h('h3', {}, 'Share this lesson'));
  card.appendChild(h('p', {},
    'Send this to your student. They do not need an account or the app - it opens in their browser. '
    + 'Anyone with the link can join and draw on the student board, so share it the way you would a meeting link.'));

  const field = h('input', { class: 'sync-input', readonly: true, value: link });
  card.appendChild(h('div', { class: 'sync-form' }, field));

  const copy = h('button', { class: 'btn primary' }, 'Copy link');
  copy.addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      // Clipboard access is refused in plenty of ordinary situations - an
      // insecure origin, an iOS gesture the browser did not like. Selecting
      // the text means there is always a way to get the link out by hand.
      field.focus();
      field.select();
    }
    copy.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
    if (ok) setTimeout(close, 700);
  });

  card.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: close }, 'Done'),
    copy));

  app.showOverlay(close);
  setTimeout(() => { field.focus(); field.select(); }, 60);
}
