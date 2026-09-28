// Chinese fonts, fetched once and only when asked for.
//
// Bangla and Arabic come with the app because their fonts are small. A
// Chinese font is not: even cut down to the characters in everyday use
// (GB2312 for Simplified, Big5 for Traditional) it is two to five megabytes,
// and nobody who never writes Chinese should carry that. So it is offered,
// never taken: nothing is downloaded until the person presses the button,
// the download happens once, and after that it lives on this device and the
// app is fully offline again. Chinese already shows without it - every
// Chinese computer and phone has a Chinese font - so this is only about a
// board looking exactly the same on every device it is opened on.
//
// Two places to fetch from, tried in order: jsDelivr, which is usually
// reachable from mainland China, and GitHub itself. Where neither can be
// reached there is "Add a font file…": get the file any way that works and
// hand it over. Whichever way it arrives, the file must be byte for byte the
// one this app expects - its fingerprint is written below - or it is
// refused.

import { t } from './i18n.js';

export const CJK_RANGE = 'U+3000-303F,U+3100-312F,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF';

export const PACKS = {
  sc: {
    id: 'sc', lang: 'zh-Hans', family: 'GazBoard Noto Sans SC',
    file: 'gazboard-noto-sans-sc-400-v1.woff2', bytes: 2058884,
    sha256: '054b57013a09f8c1bbd7939efe28c8840ff2f5886a78dabfd04934c530add2d2'
  },
  tc: {
    id: 'tc', lang: 'zh-Hant', family: 'GazBoard Noto Sans TC',
    file: 'gazboard-noto-sans-tc-400-v1.woff2', bytes: 4599448,
    sha256: '2e53c3ac21626db4d561378efcefcf44107fb31c010747b04c5cd1657f0c22af'
  }
};

/** Where a font file can be fetched from, in the order tried. */
export const SOURCES = [
  (file) => `https://cdn.jsdelivr.net/gh/fahim9778/GazBoard@main/fonts/${file}`,
  (file) => `https://raw.githubusercontent.com/fahim9778/GazBoard/main/fonts/${file}`
];

/** The pack that goes with a language, if it has one. */
export function packFor(lang) {
  return Object.values(PACKS).find((p) => p.lang === lang) || null;
}

export function sizeLabel(pack) {
  return (pack.bytes / 1048576).toFixed(1) + ' MB';
}

/* ---------------- storage: one IndexedDB store, the same on every platform ---------------- */

const DB = 'gazboard-fonts', STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

const readBytes = (id) => withStore('readonly', (s) => s.get(id));
const writeBytes = (id, buf) => withStore('readwrite', (s) => s.put(buf, id));
const dropBytes = (id) => withStore('readwrite', (s) => s.delete(id));

/* ---------------- checking and using a file ---------------- */

export async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verify(pack, buf) {
  if (!buf || buf.byteLength !== pack.bytes) return false;
  return (await sha256(buf)) === pack.sha256;
}

const faces = new Map();       // pack id -> FontFace in use

/** Put a pack's font to work: the page and every board can now draw with it. */
async function activate(pack, buf) {
  if (faces.has(pack.id)) return true;
  const face = new FontFace(pack.family, buf, { unicodeRange: CJK_RANGE, weight: '100 900', style: 'normal' });
  await face.load();
  document.fonts.add(face);
  faces.set(pack.id, face);
  onChange();
  return true;
}

let listeners = [];
/** Told whenever a pack is installed or removed - the board repaints on it. */
export function onFontsChanged(fn) { listeners.push(fn); }
function onChange() { for (const fn of listeners) { try { fn(); } catch { /* one bad listener is not a broken font */ } } }

export function isActive(id) { return faces.has(id); }

export async function isInstalled(id) {
  try { return !!(await readBytes(id)); } catch { return false; }
}

/**
 * At start-up: switch on whatever was installed before. Nothing is fetched
 * here - an install that is on this device is used, one that is not stays
 * absent until someone asks for it.
 */
export async function loadInstalled() {
  for (const pack of Object.values(PACKS)) {
    try {
      const buf = await readBytes(pack.id);
      if (buf && await verify(pack, buf)) await activate(pack, buf);
    } catch { /* a broken store is the same as no font: the system one is used */ }
  }
}

/**
 * Fetch a pack, check it, keep it, use it.
 *
 * @param {(done:number,total:number) => void} [onProgress]
 * @returns {Promise<{ok:true,source:string}|{ok:false,error:string}>}
 */
export async function download(id, { onProgress, sources = SOURCES, fetchImpl = nativeFetch() || fetch } = {}) {
  const pack = PACKS[id];
  if (!pack) return { ok: false, error: t('Unknown font') };
  let lastError = t('No connection');
  for (const src of sources) {
    const url = src(pack.file);
    try {
      const res = await fetchImpl(url, { cache: 'no-store', onProgress });
      if (!res.ok) { lastError = t('Server replied {status}', { status: res.status }); continue; }
      const buf = await readWithProgress(res, pack.bytes, onProgress);
      if (!(await verify(pack, buf))) { lastError = t('The file that arrived was not the right one'); continue; }
      await writeBytes(pack.id, buf);
      await activate(pack, buf);
      return { ok: true, source: url };
    } catch (e) {
      console.warn('[fonts]', url, e);
      lastError = t('No connection');
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Android's page is not allowed onto the internet at all, so there the app
 * itself fetches (window.board.fetchFont). Everywhere else it is plain fetch.
 */
function nativeFetch() {
  return (typeof window !== 'undefined' && typeof window.board?.fetchFont === 'function') ? window.board.fetchFont : null;
}

async function readWithProgress(res, expected, onProgress) {
  if (!res.body || !res.body.getReader) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    onProgress?.(got, expected);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out.buffer;
}

/** A copy of the file got some other way - a mirror, a friend, a USB stick. */
export async function installFromFile(id, file) {
  const pack = PACKS[id];
  if (!pack || !file) return { ok: false, error: t('Unknown font') };
  const buf = await file.arrayBuffer();
  if (!(await verify(pack, buf))) {
    return { ok: false, error: t('That is not the GazBoard font file ({file}).', { file: pack.file }) };
  }
  await writeBytes(pack.id, buf);
  await activate(pack, buf);
  return { ok: true };
}

/** Take a pack off this device. Text falls back to the system's own font. */
export async function remove(id) {
  const face = faces.get(id);
  if (face) { document.fonts.delete(face); faces.delete(id); }
  try { await dropBytes(id); } catch { /* already gone */ }
  onChange();
}
