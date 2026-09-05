// Live sync.
//
// Two channels of very different character, on purpose:
//
//   ops       - every stroke, over a Realtime broadcast channel named after
//               the board. Small, instant, and disposable. This is what makes
//               the other screen move while you are still drawing.
//   snapshot  - the whole board, upserted into gaz_boards on a debounce. Slow,
//               durable, and the only thing that matters if a device was
//               asleep, offline, or is opening the board for the first time.
//
// Losing an op is survivable because the snapshot behind it is authoritative.
// That is what keeps this simple: no acks, no sequence numbers, no replay.

import { CLIENT_ID } from '../core/store.js';
import { getClient } from './client.js';
import { SNAPSHOT_DEBOUNCE_MS } from './config.js';
import * as cloud from './cloud-storage.js';

let _store = null;
let _channel = null;
let _boardId = null;
let _enabled = false;
let _userId = null;

let _outbox = [];
let _outTimer = null;

let _snapTimer = null;
let _applyingRemote = false;

const _statusSubs = new Set();
const _pulledSubs = new Set();
let _status = 'off';   // off | connecting | live | offline | error

/** Fires when boards arrived from another device and local storage changed. */
export function onPulled(fn) {
  _pulledSubs.add(fn);
  return () => _pulledSubs.delete(fn);
}

export function onStatus(fn) {
  _statusSubs.add(fn);
  try { fn(_status); } catch {}
  return () => _statusSubs.delete(fn);
}

function setStatus(s) {
  if (s === _status) return;
  _status = s;
  for (const fn of _statusSubs) {
    try { fn(s); } catch {}
  }
}

export function status() { return _status; }

/* ---------------- wiring ---------------- */

/**
 * Attach to the live store once, at startup. Sync stays dormant until
 * enable() is called with a signed-in user.
 */
export function attach(store) {
  if (_store) return;
  _store = store;

  cloud.onCloudChange((reason) => {
    if (reason !== 'pulled') return;
    for (const fn of _pulledSubs) {
      try { fn(); } catch {}
    }
  });

  store.onOp((op) => {
    // Anything arriving from the network is applied through applyRemote,
    // which does not touch the op channel - but undo/redo does, so guard.
    if (!_enabled || _applyingRemote) return;
    _outbox.push(op);
    if (!_outTimer) _outTimer = setTimeout(flushOps, 60);
    scheduleSnapshot();
  });

  // A board saved while offline still needs to reach the cloud eventually.
  window.addEventListener('online', () => { if (_enabled) resume('online'); });
  window.addEventListener('offline', () => {
    if (_enabled) setStatus('offline');
  });

  // The one that actually matters on a phone. Switching apps - to read the
  // confirmation email, to answer a message - suspends the socket, and the
  // browser fires no network event when it comes back, so without this the
  // status sticks wherever it died and never recovers.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _enabled) resume('foreground');
  });
  window.addEventListener('pageshow', () => { if (_enabled) resume('pageshow'); });
}

/** Re-establish everything after a gap: catch up, then get the channel back. */
async function resume(reason) {
  if (!navigator.onLine) { setStatus('offline'); return; }
  if (_status === 'live' && _channel && reason === 'foreground') {
    // Already connected and nothing suggests otherwise - just catch up
    // quietly rather than tearing a working channel down.
    cloud.flushPush().then(() => cloud.pullAll()).catch(() => {});
    return;
  }
  setStatus('connecting');
  try {
    const c = getClient();
    if (c) await c.realtime.setAuth();
    await cloud.flushPush();
    await cloud.pullAll();
  } catch {}
  if (_boardId) await join(_boardId);
}

export async function enable(userId) {
  // Both the restored-session check and the INITIAL_SESSION auth event call
  // this on startup; without the guard the first visit pulls twice.
  if (_enabled && _userId === userId) return;
  _enabled = true;
  _userId = userId;
  cloud.setUser(userId);

  const c = getClient();
  if (c) {
    // Private channels authorise against realtime.messages RLS, which needs
    // the current access token handed to the socket.
    try { await c.realtime.setAuth(); } catch {}
  }

  setStatus(navigator.onLine ? 'connecting' : 'offline');
  await cloud.pullAll();
  await cloud.flushPush();
  if (_boardId) await join(_boardId);
  if (navigator.onLine && _channel) setStatus('live');
}

export async function disable() {
  _enabled = false;
  _userId = null;
  cloud.setUser(null);
  await leave();
  setStatus('off');
}

/* ---------------- per-board channel ---------------- */

/** Called whenever the app opens a different board. */
export async function setBoard(id) {
  if (id === _boardId) return;
  await leave();
  _boardId = id || null;
  if (_enabled && _boardId) await join(_boardId);
}

async function join(id, attempt = 0) {
  const c = getClient();
  if (!c || !id) return;

  await leave();
  setStatus(navigator.onLine ? 'connecting' : 'offline');

  // The server only lets you into a board's channel if it can see you own
  // that board, so a board that has only ever existed on this device has to
  // be registered first. Otherwise the very first board a device makes can
  // never go live - which is exactly what a freshly signed-in phone has.
  if (_store?.doc?.id === id) await cloud.ensureBoardRow(_store.doc);

  _channel = c.channel(id, {
    config: {
      broadcast: { self: false, ack: false },
      private: true
    }
  });

  _channel.on('broadcast', { event: 'ops' }, (msg) => {
    const payload = msg?.payload;
    if (!payload || payload.c === CLIENT_ID) return;
    if (!Array.isArray(payload.ops) || !payload.ops.length) return;
    if (payload.board && payload.board !== _boardId) return;

    _applyingRemote = true;
    try {
      _store.applyRemote(payload.ops);
    } catch (e) {
      console.warn('[sync] could not apply remote ops:', e.message);
    } finally {
      _applyingRemote = false;
    }
    // The remote device owns the durable copy of what it just drew, so we
    // deliberately do not push a snapshot back for ops we merely received.
  });

  _channel.subscribe((state) => {
    if (state === 'SUBSCRIBED') {
      setStatus('live');
      return;
    }
    if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
      // One quiet retry before admitting defeat. A phone coming back from the
      // lock screen routinely fails the first attempt because the socket died
      // while it was away, and showing a red light for that is just wrong.
      if (attempt < 2 && _enabled && navigator.onLine) {
        setStatus('connecting');
        setTimeout(() => {
          if (_enabled && _boardId === id) join(id, attempt + 1);
        }, 800 * (attempt + 1));
      } else {
        setStatus('error');
      }
      return;
    }
    if (state === 'CLOSED') setStatus(_enabled ? 'connecting' : 'off');
  });
}

async function leave() {
  if (!_channel) return;
  const ch = _channel;
  _channel = null;
  try { await ch.unsubscribe(); } catch {}
}

/* ---------------- outbound ---------------- */

function flushOps() {
  _outTimer = null;
  if (!_channel || !_outbox.length) { _outbox = []; return; }

  const ops = _outbox;
  _outbox = [];
  try {
    _channel.send({
      type: 'broadcast',
      event: 'ops',
      payload: { c: CLIENT_ID, board: _boardId, ops }
    });
  } catch (e) {
    console.warn('[sync] op broadcast failed:', e.message);
  }
}

function scheduleSnapshot() {
  if (_snapTimer) clearTimeout(_snapTimer);
  _snapTimer = setTimeout(() => {
    _snapTimer = null;
    cloud.flushPush().catch(() => {});
  }, SNAPSHOT_DEBOUNCE_MS);
}

/** Force everything pending out - used when the page is being hidden. */
export async function flushNow() {
  if (_outTimer) { clearTimeout(_outTimer); flushOps(); }
  if (_snapTimer) { clearTimeout(_snapTimer); _snapTimer = null; }
  await cloud.flushPush();
}
