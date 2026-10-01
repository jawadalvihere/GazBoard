// Shared lesson rooms: one link, two boards.
//
// The teacher works on one board and the student on the other, and either can
// switch tabs to watch the other work live. The student only ever writes on
// the student board; the teacher writes on both, which is how marking works.
//
// Who saves a board: whoever owns it while they are looking at it, because
// their copy has both people's ink in it. When the owner is not looking -
// watching the other board, or not connected at all - whoever is changing it
// saves it instead. A board nobody saves is how marks used to vanish.
//
// The student never signs in. The unguessable token in the link is the
// credential, the way a meeting link is, and the server only ever exposes the
// room through gaz_room_read / gaz_room_write, which check it.
//
// Live ops travel on a public broadcast channel named after the token. Public
// rather than private because the student is anonymous and has no session for
// a private channel to authorise; the token is what keeps the channel yours.

import { CLIENT_ID } from '../core/store.js';
import { uid } from '../core/util.js';
import { t } from '../i18n.js';
import { getClient, onAuthChange } from './client.js';
import { cloudConfigured } from './config.js';

const SAVE_DEBOUNCE_MS = 1200;
// How long a stroke is kept for replaying to someone who has just turned to
// that board. Saves land within a couple of seconds, so anything older is
// already in the copy they loaded.
const RECENT_MS = 15000;
const REPLAY_CHUNK = 40;

let _app = null;
let _token = null;
let _role = null;          // 'teacher' | 'student' - which board is MINE
let _viewing = null;       // 'teacher' | 'student' - which board is on screen
let _channel = null;
let _title = 'Lesson';

let _outbox = [];
let _outTimer = null;
let _saveTimer = null;
let _applyingRemote = false;
let _otherPresent = false;
// Everyone else in the room, as they announced themselves: { role, viewing }.
let _peers = [];
// Ops this device made on each board lately, for replaying to someone who
// turns to that board while a save is still on its way. See replayRecent().
let _recent = { teacher: [], student: [] };
// How much is on each board, as far as this device knows. The tabs only say
// "empty", so a switch to a blank board does not read as a dead click.
let _counts = { teacher: null, student: null };
// Boards that changed while you were looking at the other one.
let _fresh = { teacher: false, student: false };
let _listening = false;
// Changes to the board on screen not yet written. Saving only when there are
// some matters: a device that merely switches tabs would otherwise write back
// the copy it loaded, over anything saved since.
let _changes = 0;

const _subs = new Set();

export function inRoom() { return !!_token; }
export function role() { return _role; }
export function viewing() { return _viewing; }
export function roomTitle() { return _title; }
export function isMine() { return _role === _viewing; }

/**
 * May I draw on the board currently on screen?
 *
 * The teacher may write on both sides - marking a student's work in red is
 * half of what teaching is. The student may only write on their own, so the
 * teacher's board stays the teacher's.
 */
export function canWrite() {
  if (!_token) return true;
  if (_role === 'teacher') return true;
  return _viewing === _role;
}

/** Is the other person connected right now? */
export function otherPresent() { return _otherPresent; }

/** Is anyone else looking at this board right now? */
export function watchedBy(side, role = null) {
  return _peers.some((m) => m.viewing === side && (!role || m.role === role));
}

/** Is the board's owner looking at it? Then their copy is the complete one. */
function ownerWatching(side) { return watchedBy(side, side); }

/** Items on each board as far as known; null where not yet known. */
export function counts() { return _counts; }

/** Has this board changed since you last looked at it? */
export function fresh(side) { return !!_fresh[side]; }

export function onRoomChange(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

function announce() {
  for (const fn of _subs) {
    try { fn(); } catch {}
  }
}

/** The token in the address bar, if this page was opened from a share link. */
export function tokenFromUrl() {
  try {
    return new URL(location.href).searchParams.get('room') || null;
  } catch {
    return null;
  }
}

export function roomLink(token = _token) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', token);
  return u.toString();
}

/* ---------------- opening a room ---------------- */

/**
 * Teacher only: make a room and return its link.
 *
 * `startWith` is the board the teacher was on. It becomes the teacher's side
 * of the lesson, so "teach with a student" teaches from the page already
 * prepared rather than throwing it away for a blank one. It goes in under a
 * new id: the lesson copy is the lesson's, and sharing an id with the board in
 * My boards would let one quietly overwrite the other.
 */
export async function createRoom(title, startWith = null) {
  const c = getClient();
  if (!c) return { ok: false, error: 'Cloud sync is not set up in this build.' };
  const { data, error } = await c.rpc('gaz_room_create', { p_title: title || 'Lesson' });
  if (error) {
    return {
      ok: false,
      error: /sign in/i.test(error.message || '')
        ? 'Sign in first - a room belongs to your account.'
        : error.message
    };
  }
  if (startWith) {
    try {
      await c.rpc('gaz_room_write', { p_token: data, p_role: 'teacher', p_doc: { ...startWith, id: uid('b') } });
    } catch (e) {
      console.warn('[room] could not bring the board into the lesson:', e.message);
    }
  }
  return { ok: true, token: data, link: roomLink(data) };
}

/**
 * Join a room and put a board on screen.
 *
 * Which board is yours is decided by the server, not by the client: it tells
 * us whether the signed-in user owns this room. Everyone else is the student,
 * which is what makes the link safe to hand out - possessing it never makes
 * you the teacher.
 */
export async function enterRoom(app, token) {
  if (!cloudConfigured() || !token) return false;
  const c = getClient();
  if (!c) return false;

  /*
   * Wait for the stored session before asking who we are.
   *
   * Joining happens during start-up, well before anything else touches auth,
   * and the client restores its saved session asynchronously. Ask a moment too
   * early and the request goes out signed-out: the server answers "not the
   * owner", perfectly correctly, and the teacher is handed their own lesson as
   * a student with a read-only board.
   */
  try { await c.auth.getSession(); } catch {}

  const { data, error } = await c.rpc('gaz_room_read', { p_token: token });
  if (error || !data) {
    app.toast('That lesson link is not valid, or it has expired', 'close');
    return false;
  }

  _app = app;
  _token = token;
  _title = data.title || 'Lesson';
  _role = data.is_owner ? 'teacher' : 'student';
  _viewing = _role;
  _peers = [];
  _recent = { teacher: [], student: [] };
  _fresh = { teacher: false, student: false };

  app.roomMode = true;
  await showSide(_role, data);
  await joinChannel();

  // Registered once per page: entering a second room reuses this listener,
  // which reads the current room from module state.
  if (!_listening) {
    _listening = true;
    app.store.onOp((op) => {
      if (!_token || _applyingRemote) return;
      if (!canWrite()) return;               // watching, not working
      const side = _viewing;
      const now = Date.now();
      _recent[side] = _recent[side].filter((r) => now - r.at < RECENT_MS);
      _recent[side].push({ at: now, op });
      _changes++;
      noteCount(side);
      _outbox.push(op);
      if (!_outTimer) _outTimer = setTimeout(flushOps, 60);
      scheduleSave();
    });
  }

  announce();
  app.toast(_role === 'teacher' ? 'Lesson room open - share the link' : `Joined ${_title}`, 'check');
  return true;
}

/*
 * Signing in while already in a room promotes you if the room turns out to be
 * yours. Someone who follows their own link before the app has finished
 * remembering them - or who signs in once they are already looking at it -
 * should not have to reload to get their own board back.
 */
onAuthChange(async () => {
  if (!_token || _role === 'teacher') return;
  const c = getClient();
  if (!c) return;
  try {
    const { data } = await c.rpc('gaz_room_read', { p_token: _token });
    if (!data || !data.is_owner) return;
    _role = 'teacher';
    await showSide('teacher', data);
    _app.toast('This is your lesson - you have the teacher board', 'check');
  } catch {}
});

/**
 * Step out of a room.
 *
 * The link has to come out of the address bar as well as the state, or a
 * reload drops straight back into the lesson that was just left - and on a
 * phone, where reloading is how people fix anything, that reads as being
 * unable to get out at all.
 */
export async function leaveRoom() {
  if (!_token) return;
  // The last few strokes still waiting in the outbox go out first - leaving
  // used to throw them away - and then whatever this device is responsible
  // for saving is saved.
  if (_outTimer) { clearTimeout(_outTimer); flushOps(); }
  await saveNow();
  _outbox = [];
  if (_channel) { try { await _channel.unsubscribe(); } catch {} _channel = null; }
  _token = null; _role = null; _viewing = null; _otherPresent = false; _peers = [];
  if (_app) {
    _app.roomMode = false;
    _app.setCorrectionPen(false);
  }
  try { history.replaceState(null, '', location.pathname); } catch {}
  announce();
}

/* ---------------- the two sides ---------------- */

/**
 * Put one side of the room on screen.
 *
 * The other side is fetched fresh rather than kept in step in the background:
 * while you are not looking at it there is nothing to update, and one read on
 * switching is far less machinery than a second live document to maintain.
 */
export async function showSide(side, prefetched = null) {
  if (!_token || (side !== 'teacher' && side !== 'student')) return;

  // Whatever this device owes the board it is leaving is saved before the
  // switch - the owner's own work, or a teacher's marks on a board its owner
  // was not looking at. saveNow() decides which.
  if (_viewing && _viewing !== side) {
    if (_outTimer) { clearTimeout(_outTimer); flushOps(); }
    await saveNow();
  }

  let room = prefetched;
  if (!room) {
    const c = getClient();
    const { data } = await c.rpc('gaz_room_read', { p_token: _token });
    room = data;
    if (!room) { _app.toast('Lost the lesson room', 'close'); return; }
    _title = room.title || _title;
  }

  const size = (d) => (d && Array.isArray(d.order) ? d.order.length : Object.keys((d && d.objects) || {}).length);
  _counts = { teacher: size(room.teacher_doc), student: size(room.student_doc) };

  _viewing = side;
  _fresh[side] = false;
  const doc = side === 'teacher' ? room.teacher_doc : room.student_doc;
  await _app.loadRoomBoard(doc, side, _title);
  _changes = 0;                            // what is on screen is what is saved
  // Marking someone's work is a different act from writing your own, and it
  // should look like one without anybody having to remember to change pens.
  _app.setCorrectionPen(_role === 'teacher' && side === 'student');
  // Say which board is on screen only once it IS on screen: anyone who drew
  // on it in the last few seconds replays that to us when they hear this,
  // and the replay has to land on the loaded board, not before it.
  track();
  announce();
}

function track() {
  if (!_channel || !_role) return;
  try { _channel.track({ role: _role, viewing: _viewing }).catch(() => {}); } catch {}
}

/** Keep the tab's "empty" honest for the board on screen. */
function noteCount(side) {
  if (side !== _viewing || !_app) return;
  const n = _app.store.count;
  if (n === _counts[side]) return;
  _counts[side] = n;
  announce();
}

/* ---------------- live ---------------- */

async function joinChannel() {
  const c = getClient();
  if (!c || !_token) return;
  if (_channel) { try { await _channel.unsubscribe(); } catch {} _channel = null; }

  _channel = c.channel(`gazroom-${_token}`, {
    config: { broadcast: { self: false, ack: false }, presence: { key: CLIENT_ID } }
  });

  // Presence says who is here and which board each of them is looking at.
  // That decides who saves a board (see saveNow) and when to replay strokes
  // to someone who has just turned to one (see replayRecent).
  const readPresence = () => {
    if (!_channel) return;
    const state = _channel.presenceState() || {};
    const before = new Set(_peers.map((m) => `${m.key}:${m.viewing}`));
    _peers = Object.entries(state)
      .filter(([key]) => key !== CLIENT_ID)
      .flatMap(([key, metas]) => (metas || []).filter(Boolean).map((m) => ({ key, role: m.role, viewing: m.viewing })));
    const other = _role === 'teacher' ? 'student' : 'teacher';
    _otherPresent = _peers.some((m) => m.role === other);

    for (const side of ['teacher', 'student']) {
      if (_peers.some((m) => m.viewing === side && !before.has(`${m.key}:${side}`))) replayRecent(side);
    }
    // The owner just looked away from a board this device has been marking:
    // the save is ours again.
    if (_viewing && !isMine() && canWrite() && _recent[_viewing].length) scheduleSave();
    announce();
  };
  _channel.on('presence', { event: 'sync' }, readPresence);
  _channel.on('presence', { event: 'join' }, readPresence);
  _channel.on('presence', { event: 'leave' }, readPresence);

  _channel.on('broadcast', { event: 'ops' }, (msg) => {
    const p = msg?.payload;
    if (!p || p.c === CLIENT_ID) return;
    // Only what is on screen is applied. Ops for the side you are not looking
    // at are dropped - you read that board fresh when you switch to it - but
    // the tab says it has something new on it.
    if (p.side !== _viewing) {
      if (Array.isArray(p.ops) && p.ops.length && (p.side === 'teacher' || p.side === 'student')) {
        _fresh[p.side] = true;
        if (p.ops.some((op) => op && op.t === 'add')) _counts[p.side] = Math.max(1, _counts[p.side] || 0);
        announce();
      }
      return;
    }
    if (typeof p.page === 'number' && !isMine() && p.page !== _app.currentPageIndex()) {
      _app.goToPage(p.page);
    }
    if (!Array.isArray(p.ops) || !p.ops.length) return;

    _applyingRemote = true;
    try { _app.store.applyRemote(p.ops); }
    catch (e) { console.warn('[room] could not apply:', e.message); }
    finally { _applyingRemote = false; }
    _changes++;
    noteCount(_viewing);

    // What the other person just drew is part of the board now, and
    // applyRemote does not fire the op channel - so schedule the save here,
    // or a teacher's corrections would live only on screen. saveNow() decides
    // whether this device is the one that writes it.
    scheduleSave();
  });

  _channel.subscribe((state) => {
    if (state === 'SUBSCRIBED') track();
  });
}

/**
 * Someone has just turned to `side`: send them what this device drew on it
 * in the last few seconds.
 *
 * They loaded the board from the server, and the save carrying those strokes
 * may still have been on its way - without this they would be missing until
 * the next reload, and if they are the owner, their next save would write the
 * board back without them. Replaying is safe: an op applied twice leaves the
 * board as it was after the first time.
 */
function replayRecent(side) {
  if (!_channel) return;
  const now = Date.now();
  _recent[side] = _recent[side].filter((r) => now - r.at < RECENT_MS);
  const ops = _recent[side].map((r) => r.op);
  for (let i = 0; i < ops.length; i += REPLAY_CHUNK) {
    try {
      _channel.send({ type: 'broadcast', event: 'ops', payload: { c: CLIENT_ID, side, ops: ops.slice(i, i + REPLAY_CHUNK) } });
    } catch (e) {
      console.warn('[room] replay failed:', e.message);
    }
  }
}

function flushOps() {
  _outTimer = null;
  if (!_channel || !_outbox.length) { _outbox = []; return; }
  const ops = _outbox;
  _outbox = [];
  try {
    _channel.send({
      type: 'broadcast',
      event: 'ops',
      // The page rides along so a watcher on page 1 is not left staring at a
      // blank sheet while the work happens on page 3.
      // The side being DRAWN ON, which is not always mine: a teacher
      // correcting in red is writing on the student's board.
      payload: { c: CLIENT_ID, side: _viewing, page: _app.currentPageIndex(), ops }
    });
  } catch (e) {
    console.warn('[room] broadcast failed:', e.message);
  }
}

/**
 * Turning a page is not a document change, so it produces no op - but a
 * watcher still needs to come along, or the teacher turns to a fresh sheet and
 * the student is left looking at the last one.
 */
export function notePage(index) {
  if (!_token || !_channel || !isMine()) return;
  try {
    _channel.send({ type: 'broadcast', event: 'ops', payload: { c: CLIENT_ID, side: _role, page: index, ops: [] } });
  } catch {}
}

/* ---------------- durable copy ---------------- */

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
}

/**
 * Write the board on screen to the server, if this device is the one that
 * should.
 *
 * The owner saves their own board while looking at it: their copy has their
 * own ink and everything the other person drew on it live. When the owner is
 * NOT looking - watching the other board, or not connected - nobody else is
 * drawing on it but the one marking it, so that device saves. It used to be
 * owner-only, and a teacher's marks on a board the student was not looking at
 * were thrown away.
 */
export async function saveNow() {
  if (!_token || !_role || !_viewing || !_app) return;
  if (!_changes) return;                           // nothing new to write
  if (!canWrite()) return;                         // watching only
  const side = _viewing;
  if (side !== _role && ownerWatching(side)) return;
  const c = getClient();
  if (!c) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  const badge = document.getElementById('savedBadge');
  if (badge) badge.textContent = t('Saving…');
  const upTo = _changes;
  try {
    const doc = await _app.roomDocForSave();
    const { error } = await c.rpc('gaz_room_write', { p_token: _token, p_role: side, p_doc: doc });
    if (error) throw error;
    // Anything drawn while the write was on its way is still owed.
    if (_viewing === side) _changes = Math.max(0, _changes - upTo);
    if (badge) badge.textContent = t('Saved');
  } catch (e) {
    console.warn('[room] save failed:', e.message);
    if (badge) badge.textContent = t('Not saved');
  }
}

/** Push anything buffered before the tab goes away. */
export function flushOnHide() {
  if (_outTimer) { clearTimeout(_outTimer); flushOps(); }
  saveNow();
}
