// Cloud-backed board + asset storage.
//
// Local IndexedDB stays the source of truth for whatever the user is doing
// right now: every write lands there first, so the app is exactly as fast and
// as offline-capable as it was before. The cloud is a second copy that trails
// it by a moment and feeds the other device.
//
// Conflicts resolve last-write-wins on the board's own `modified` stamp. That
// is the honest rule for one person on two devices - draw on the phone, then
// on the laptop, and the laptop wins, which is what you would expect. It is
// NOT sufficient for two people drawing at once; that needs an op-merge and is
// deliberately out of scope here.

import { getClient } from './client.js';
import { ASSET_BUCKET } from './config.js';

// The local store underneath differs by platform - IndexedDB in the browser,
// the filesystem under Electron - but the shape is identical, so the sync
// logic below never needs to know which one it is sitting on.
let local = null;

export function setLocalBackend(backend) {
  local = backend;
}

/** Wrap Electron's window.board bridge in the same shape as web-storage.js. */
export function backendFromBridge(bridge) {
  return {
    listBoards: () => bridge.boards.list(),
    loadBoard: (id) => bridge.boards.load(id),
    saveBoard: (b) => bridge.boards.save(b),
    deleteBoard: (id) => bridge.boards.remove(id),
    getLastBoard: () => bridge.boards.last(),
    setLastBoard: (id) => bridge.boards.setLast(id),
    resumeBoard: () => bridge.boards.resume(),
    migrateLegacyData: () => bridge.boards.migrate(),
    putAsset: (d) => bridge.assets.put(d),
    getAsset: (id) => bridge.assets.get(id),
    haveAssets: (ids) => bridge.assets.have(ids),
    requestPersistentStorage: async () => true,
    getStorageEstimate: async () => null
  };
}

const ASSET_NAME = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};

let _userId = null;
const _pushQueue = new Map();   // board id -> latest doc awaiting upload
let _pushTimer = null;
const _listeners = new Set();

export function setUser(id) {
  _userId = id || null;
}

export function onCloudChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function notify(reason) {
  for (const fn of _listeners) {
    try { fn(reason); } catch {}
  }
}

/**
 * The cloud copy of a board carries no camera.
 *
 * Where you are looking is a property of the device, not of the board. A phone
 * held in portrait and a laptop in landscape want completely different pan and
 * zoom for the same drawing, so handing one device's viewport to the other
 * drops it somewhere that makes no sense - and the ink you just drew appears
 * to have vanished, because it is off the edge of a view you never chose.
 */
function forCloud(doc) {
  if (!doc) return doc;
  const { camera, ...rest } = doc;
  return rest;
}

/** Write a board that came from another device, keeping this one's viewpoint. */
async function saveIncoming(remoteDoc) {
  if (!remoteDoc || !remoteDoc.id) return false;
  let doc = remoteDoc;
  try {
    const mine = await local.loadBoard(remoteDoc.id);
    if (mine && mine.camera) doc = { ...remoteDoc, camera: mine.camera };
  } catch {}
  return local.saveBoard(doc);
}

/* ---------------- boards ---------------- */

export async function saveBoard(payload) {
  // Local first, always. If the network is down this is the whole operation.
  const ok = await local.saveBoard(payload);
  if (_userId) queuePush(payload);
  return ok;
}

export async function loadBoard(id) {
  const doc = await local.loadBoard(id);
  if (doc) return doc;
  return pullOne(id);
}

export async function listBoards() {
  return local.listBoards();
}

export async function deleteBoard(id) {
  const ok = await local.deleteBoard(id);
  if (_userId && id) {
    const c = getClient();
    if (c) {
      // Tombstone rather than a hard delete: a plain delete would simply be
      // undone by the other device pushing back the board it still holds.
      try {
        await c.from('gaz_boards')
          .update({ deleted: true, modified: Date.now(), updated_at: new Date().toISOString() })
          .eq('id', id).eq('owner', _userId);
      } catch (e) {
        console.warn('[cloud] delete failed:', e.message);
      }
    }
  }
  return ok;
}

// These are purely local concerns - which board this device had open, and how
// much room the browser will give us - so they pass straight through. They are
// functions rather than re-exported bindings because the backend is chosen at
// runtime, after this module has been evaluated.
export const getLastBoard = (...a) => local.getLastBoard(...a);
export const setLastBoard = (...a) => local.setLastBoard(...a);
export const resumeBoard = (...a) => local.resumeBoard(...a);
export const migrateLegacyData = (...a) => local.migrateLegacyData(...a);
export const requestPersistentStorage = (...a) => local.requestPersistentStorage(...a);
export const getStorageEstimate = (...a) => local.getStorageEstimate(...a);

/* ---------------- push ---------------- */

function queuePush(payload) {
  let doc = payload;
  if (payload && typeof payload.json === 'string') {
    try { doc = JSON.parse(payload.json); } catch { return; }
  }
  if (!doc || !doc.id) return;

  _pushQueue.set(doc.id, doc);
  if (_pushTimer) return;
  _pushTimer = setTimeout(() => { _pushTimer = null; flushPush(); }, 400);
}

export async function flushPush() {
  if (!_userId || !_pushQueue.size) return;
  const c = getClient();
  if (!c) return;

  const batch = [..._pushQueue.values()];
  _pushQueue.clear();

  for (const doc of batch) {
    try {
      await uploadBoardAssets(doc);
      const row = {
        id: doc.id,
        owner: _userId,
        name: doc.name || 'Untitled board',
        doc: forCloud(doc),
        thumb: doc.thumb || null,
        objects: Array.isArray(doc.order) ? doc.order.length : Object.keys(doc.objects || {}).length,
        modified: doc.modified || Date.now(),
        deleted: false,
        updated_at: new Date().toISOString()
      };
      const { error } = await c.from('gaz_boards').upsert(row, { onConflict: 'id' });
      if (error) throw error;
    } catch (e) {
      // Put it back so the next flush retries instead of losing the board.
      _pushQueue.set(doc.id, doc);
      console.warn('[cloud] push failed, will retry:', e.message);
      notify('error');
      return;
    }
  }
  notify('pushed');
}

/**
 * Upsert one board and wait for it to land.
 *
 * Joining a board's live channel is only permitted for a board the server can
 * see you own, so a board that exists solely on this device cannot have a
 * channel yet. Callers use this to make the row real before subscribing,
 * rather than racing the debounced snapshot and failing the join.
 */
export async function ensureBoardRow(doc) {
  if (!_userId || !doc || !doc.id) return false;
  const c = getClient();
  if (!c) return false;
  try {
    const { error } = await c.from('gaz_boards').upsert({
      id: doc.id,
      owner: _userId,
      name: doc.name || 'Untitled board',
      doc: forCloud(doc),
      thumb: doc.thumb || null,
      objects: Array.isArray(doc.order) ? doc.order.length : Object.keys(doc.objects || {}).length,
      modified: doc.modified || Date.now(),
      deleted: false,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn('[cloud] could not register board:', e.message);
    return false;
  }
}

/* ---------------- pull ---------------- */

export async function pullOne(id) {
  if (!_userId || !id) return null;
  const c = getClient();
  if (!c) return null;
  try {
    const { data, error } = await c.from('gaz_boards')
      .select('doc, deleted').eq('id', id).eq('owner', _userId).maybeSingle();
    if (error || !data || data.deleted) return null;
    await saveIncoming(data.doc);
    return data.doc;
  } catch {
    return null;
  }
}

/**
 * Reconcile the cloud into local storage. Returns how many boards actually
 * changed, so callers can skip a pointless re-render.
 */
export async function pullAll() {
  if (!_userId) return 0;
  const c = getClient();
  if (!c) return 0;

  let changed = 0;
  try {
    const { data, error } = await c.from('gaz_boards')
      .select('id, doc, modified, deleted').eq('owner', _userId);
    if (error) throw error;

    const mine = await local.listBoards();
    const localMod = new Map(mine.map((b) => [b.id, b.modified || 0]));

    for (const row of data || []) {
      const here = localMod.get(row.id);
      if (row.deleted) {
        if (here !== undefined) { await local.deleteBoard(row.id); changed++; }
        continue;
      }
      if (here === undefined || (row.modified || 0) > here) {
        await saveIncoming(row.doc);
        changed++;
      }
    }

    // Anything local that the cloud has never seen goes up.
    const remote = new Set((data || []).map((r) => r.id));
    for (const b of mine) {
      if (!remote.has(b.id)) {
        const doc = await local.loadBoard(b.id);
        if (doc) queuePush(doc);
      }
    }
  } catch (e) {
    console.warn('[cloud] pull failed:', e.message);
    notify('error');
    return 0;
  }

  if (changed) notify('pulled');
  return changed;
}

/* ---------------- assets ---------------- */

export async function putAsset(dataUrl) {
  const res = await local.putAsset(dataUrl);
  if (res && res.id && _userId) uploadAsset(res.id).catch(() => {});
  return res;
}

export async function getAsset(id) {
  const hit = await local.getAsset(id);
  if (hit) return hit;
  return downloadAsset(id);
}

export async function haveAssets(ids) {
  return local.haveAssets(ids);
}

/** Assets are content-addressed, so any given one uploads exactly once. */
async function uploadAsset(id) {
  if (!_userId || !ASSET_NAME.test(String(id || ''))) return false;
  const c = getClient();
  if (!c) return false;

  try {
    const dataUrl = await local.getAsset(id);
    if (!dataUrl) return false;
    const blob = await (await fetch(dataUrl)).blob();
    const { error } = await c.storage.from(ASSET_BUCKET).upload(`${_userId}/${id}`, blob, {
      contentType: blob.type || ASSET_MIME[String(id).split('.').pop()] || 'application/octet-stream',
      upsert: false
    });
    // A duplicate means another device already uploaded the identical bytes,
    // which counts as success.
    if (error && !/exists|duplicate/i.test(error.message || '')) throw error;
    return true;
  } catch (e) {
    console.warn('[cloud] asset upload failed:', e.message);
    return false;
  }
}

async function downloadAsset(id) {
  if (!_userId || !ASSET_NAME.test(String(id || ''))) return null;
  const c = getClient();
  if (!c) return null;

  try {
    const { data, error } = await c.storage.from(ASSET_BUCKET).download(`${_userId}/${id}`);
    if (error || !data) return null;
    const dataUrl = await blobToDataUrl(data);
    // Cache locally so the next read is instant and survives going offline.
    if (dataUrl) await local.putAsset(dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

/** Make sure every image a board references exists in the bucket. */
async function uploadBoardAssets(doc) {
  const ids = new Set();
  for (const o of Object.values(doc?.objects || {})) {
    const src = o && typeof o.src === 'string' ? o.src : null;
    if (src && ASSET_NAME.test(src)) ids.add(src);
  }
  for (const id of ids) await uploadAsset(id);
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}
