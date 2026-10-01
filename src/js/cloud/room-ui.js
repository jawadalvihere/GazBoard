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

  const counts = room.counts();
  const tab = (side, label) => {
    const n = counts[side];
    // "empty" is what stops a blank board reading as a tab that did not
    // respond. A count of objects said nothing useful - every pen stroke is
    // one, so a single word showed up as "7" and looked like a bug. "new"
    // flags a board that changed while you were looking at the other one.
    const word = n === 0 ? 'empty' : (viewing !== side && room.fresh(side) ? 'new' : null);
    const note = word ? h('span', { class: 'room-count' + (word === 'new' ? ' room-new' : '') }, word) : null;
    return h('button', {
      class: 'room-tab' + (viewing === side ? ' active' : '') + (mine === side ? ' own' : ''),
      onclick: () => room.showSide(side)
    }, label, mine === side ? h('span', { class: 'room-you' }, 'you') : null, note);
  };

  _bar.appendChild(h('div', { class: 'room-tabs' },
    tab('teacher', 'Teacher'),
    tab('student', 'Student')));

  _bar.appendChild(h('div', { class: 'room-state' }, stateLine()));

  const actions = h('div', { class: 'room-actions' });
  if (mine === 'teacher') {
    actions.appendChild(h('button', {
      class: 'btn',
      onclick: () => shareDialog(room.roomLink())
    }, 'Share link'));
  }
  // Everyone gets a way out. Without one the only exit is editing the address
  // bar, which on a phone is no exit at all.
  actions.appendChild(h('button', {
    class: 'btn',
    onclick: async () => {
      const ok = await _app.confirm('Leave this lesson?',
        mine === 'teacher'
          ? 'You will go back to your own boards. The lesson is kept — your link still opens it.'
          : 'You will go back to your own boards. Open the link again to rejoin.',
        'Leave');
      if (!ok) return;
      await room.leaveRoom();
      _app.newBoard(true);
      _app.toast('Left the lesson', 'check');
    }
  }, 'Leave'));
  _bar.appendChild(actions);
}

/**
 * The line that says what you are doing, and who can see it.
 *
 * It only claims "live" when the other person is actually looking at the
 * same board. Marks are saved either way now, so the old "will not be saved"
 * warning is gone - the line says when the student will see them instead.
 */
function stateLine() {
  const live = (text) => h('span', {}, h('span', { class: 'room-live' }), text);
  const viewing = room.viewing();
  const marking = room.role() === 'teacher' && viewing === 'student';

  if (marking) {
    if (room.watchedBy('student', 'student')) return live('Marking in red — the student sees this live');
    return room.otherPresent()
      ? 'Marking in red — saved to their board'
      : 'Marking in red — saved for when the student opens the link';
  }
  if (room.isMine()) {
    if (room.watchedBy(viewing)) return live('Your board — the other side is watching');
    return room.otherPresent() ? live('Your board — the other side is connected') : 'Your board';
  }
  // Watching the other person's board.
  const whose = viewing === 'teacher' ? 'Watching the teacher’s board' : 'Watching the student’s board';
  return room.otherPresent() ? live(whose) : whose;
}

/* ---------------- starting and sharing a room ---------------- */

export async function startRoom(app) {
  const user = await currentUser();
  if (!user) {
    app.toast('Sign in first - a lesson room belongs to your account', 'close');
    return;
  }

  // Starting a lesson while already in one means a NEW lesson: a new link and
  // two empty boards. Leaving first makes that literal, rather than leaving
  // the old room's channel open underneath the new one.
  //
  // Otherwise the board on screen comes with you as the teacher's board -
  // the worksheet you just prepared is what you meant to teach from.
  let startWith = null;
  if (room.inRoom()) {
    const ok = await app.confirm('Start a new lesson?',
      'You will get a fresh link and two empty boards. The lesson you are in now is kept — its old link still opens it.',
      'New lesson');
    if (!ok) return;
    await room.leaveRoom();
  } else if (app.store.count) {
    app.commitTextEdit();
    startWith = await app.roomDocForSave();
  }

  app.toast('Opening a lesson room…');
  const res = await room.createRoom(app.store.doc.name || 'Lesson', startWith);
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
