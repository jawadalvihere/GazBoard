// Shared lesson rooms: one link, two boards.
//
// The teacher works on one board and the student on the other, and either can
// switch tabs to watch the other work live. Each board still has exactly one
// writer, which is the whole reason this stays simple - there is no merge to
// get wrong, and no way for two people to fight over the same stroke.
//
// The student never signs in. The unguessable token in the link is the
// credential, the way a meeting link is, and the server only ever exposes the
// room through gaz_room_read / gaz_room_write, which check it.
//
// Live ops travel on a public broadcast channel named after the token. Public
// rather than private because the student is anonymous and has no session for
// a private channel to authorise; the token is what keeps the channel yours.

import { CLIENT_ID } from '../core/store.js';
import { getClient, onAuthChange } from './client.js';
import { cloudConfigured } from './config.js';

const SAVE_DEBOUNCE_MS = 1200;

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

/** Teacher only: make a room and return its link. */
export async function createRoom(title) {
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

  app.roomMode = true;
  await showSide(_role, data);
  await joinChannel();

  app.store.onOp((op) => {
    if (!_token || _applyingRemote) return;
    if (!canWrite()) return;               // watching, not working
    if (!isMine() && !_otherPresent) warnUnsaved();
    _outbox.push(op);
    if (!_outTimer) _outTimer = setTimeout(flushOps, 60);
    scheduleSave();
  });

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
    if (_channel) { try { _channel.track({ role: _role }); } catch {} }
    await showSide('teacher', data);
    _app.toast('This is your lesson - you have the teacher board', 'check');
  } catch {}
});

export async function leaveRoom() {
  if (!_token) return;
  await saveNow();
  if (_channel) { try { await _channel.unsubscribe(); } catch {} _channel = null; }
  _token = null; _role = null; _viewing = null;
  if (_app) _app.roomMode = false;
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

  if (_viewing && _viewing !== side && isMine()) await saveNow();

  let room = prefetched;
  if (!room) {
    const c = getClient();
    const { data } = await c.rpc('gaz_room_read', { p_token: _token });
    room = data;
    if (!room) { _app.toast('Lost the lesson room', 'close'); return; }
    _title = room.title || _title;
  }

  _viewing = side;
  const doc = side === 'teacher' ? room.teacher_doc : room.student_doc;
  await _app.loadRoomBoard(doc, side, _title);
  // Marking someone's work is a different act from writing your own, and it
  // should look like one without anybody having to remember to change pens.
  _app.setCorrectionPen(_role === 'teacher' && side === 'student');
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

  // Presence is not decoration here. The board's owner is the only device that
  // writes it to the server, so a correction made while the student is gone
  // has nowhere to be saved - and the teacher needs to be told that BEFORE
  // spending a minute marking, not after.
  const readPresence = () => {
    const state = _channel.presenceState() || {};
    const roles = Object.values(state).flat().map((m) => m && m.role);
    const other = _role === 'teacher' ? 'student' : 'teacher';
    const was = _otherPresent;
    _otherPresent = roles.includes(other);
    if (was !== _otherPresent) announce();
  };
  _channel.on('presence', { event: 'sync' }, readPresence);
  _channel.on('presence', { event: 'join' }, readPresence);
  _channel.on('presence', { event: 'leave' }, readPresence);

  _channel.on('broadcast', { event: 'ops' }, (msg) => {
    const p = msg?.payload;
    if (!p || p.c === CLIENT_ID) return;
    // Only what is on screen matters. Ops for the side you are not looking at
    // are dropped; you will read that board fresh when you switch to it.
    if (p.side !== _viewing) return;
    if (typeof p.page === 'number' && !isMine() && p.page !== _app.currentPageIndex()) {
      _app.goToPage(p.page);
    }
    if (!Array.isArray(p.ops) || !p.ops.length) return;

    _applyingRemote = true;
    try { _app.store.applyRemote(p.ops); }
    catch (e) { console.warn('[room] could not apply:', e.message); }
    finally { _applyingRemote = false; }

    // This board is mine, so I am the one that writes it to the server - and
    // that includes what the other person just drew on it. applyRemote does
    // not fire the op channel, so nothing else would schedule this and a
    // teacher's corrections would live only on screen.
    if (isMine()) scheduleSave();
  });

  _channel.subscribe((state) => {
    if (state === 'SUBSCRIBED') _channel.track({ role: _role }).catch(() => {});
  });
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

let _warnedAt = 0;

/** Say it once, not on every stroke. */
function warnUnsaved() {
  const now = Date.now();
  if (now - _warnedAt < 20000) return;
  _warnedAt = now;
  _app.toast('The student is not connected - these marks will not be saved', 'close', 4200);
}

/* ---------------- durable copy ---------------- */

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; saveNow(); }, SAVE_DEBOUNCE_MS);
}

export async function saveNow() {
  if (!_token || !_role || !isMine() || !_app) return;
  const c = getClient();
  if (!c) return;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  try {
    const doc = await _app.roomDocForSave();
    await c.rpc('gaz_room_write', { p_token: _token, p_role: _role, p_doc: doc });
  } catch (e) {
    console.warn('[room] save failed:', e.message);
  }
}

/** Push anything buffered before the tab goes away. */
export function flushOnHide() {
  if (_outTimer) { clearTimeout(_outTimer); flushOps(); }
  saveNow();
}
