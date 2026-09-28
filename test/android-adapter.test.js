'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

async function setup(handler) {
  global.window = { addEventListener() {}, dispatchEvent() {} };
  global.document = { documentElement: { dataset: {} }, addEventListener() {} };
  const calls = [];
  const native = {
    postMessage(text) {
      const request = JSON.parse(text);
      calls.push(request);
      queueMicrotask(async () => {
        try {
          const result = await handler(request);
          native.onmessage({ data: JSON.stringify({ id: request.id, result }) });
        } catch (e) { native.onmessage({ data: JSON.stringify({ id: request.id, error: e.message }) }); }
      });
    }
  };
  const { createAndroidAdapter } = await import('../src/js/platform/android-adapter.js');
  return { adapter: createAndroidAdapter(native), calls, native };
}

test('The clipboard is read through the native side, not guessed at', async () => {
  const { adapter, calls } = await setup(async (request) => {
    if (request.method !== 'clipboard:read') throw new Error('unexpected ' + request.method);
    return { text: '+880 1700 000000', signature: 'text/plain\u0000+880 1700 000000\u0000' };
  });
  const got = await adapter.clipboardRead();
  assert.equal(calls.filter((c) => c.method === 'clipboard:read').length, 1,
    `asked the native side once; calls were ${JSON.stringify(calls.map((c) => c.method))}`);
  assert.deepEqual({ text: got.text, hasSignature: typeof got.signature === 'string' && got.signature.length > 0 },
    { text: '+880 1700 000000', hasSignature: true },
    `clipboard came back as ${JSON.stringify(got)} — the text is what Paste puts on the board, ` +
    `the signature only ever gets compared with an earlier one`);
});

test('A picture on the clipboard arrives as a picture, never as text', async () => {
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const { adapter } = await setup(async (request) => {
    if (request.method !== 'clipboard:read') throw new Error('unexpected ' + request.method);
    // what the native side sends for an image clip: no words, a picture, and a
    // signature built from the handle
    return { text: '', image: PIXEL, signature: 'image/png\u0000\u0000content://media/42' };
  });
  const got = await adapter.clipboardRead();
  assert.deepEqual({ text: got.text, isDataUrl: String(got.image || '').startsWith('data:image/') },
    { text: '', isDataUrl: true },
    `an image clip must carry no text at all - reading its bytes as characters is what put ` +
    `megabytes of rubbish in a text box on the board. Got ${JSON.stringify({ text: got.text, image: String(got.image).slice(0, 24) })}`);
});

test('A refused clipboard is an ordinary answer, not a crash', async () => {
  const { adapter } = await setup(async () => { throw new Error('Clipboard unavailable'); });
  const got = await adapter.clipboardRead();
  // Paste reads .signature and .text; neither being there is exactly how it
  // decides there is nothing on the clipboard worth preferring, so a refusal
  // must come back as a harmless object rather than as a thrown error.
  assert.deepEqual(
    { threw: false, signature: got?.signature ?? null, text: got?.text ?? null, ok: got?.ok },
    { threw: false, signature: null, text: null, ok: false },
    `a refusal should look like an empty clipboard to Paste, got ${JSON.stringify(got)}`);
});

test('Pairing and send preserve the preload API and surface native errors', async () => {
  const { adapter, calls } = await setup(({ method, args }) => {
    if (method === 'sync:pairWith') return { ok: true, device: args.peer };
    throw new Error('Device is offline');
  });
  const peer = { deviceId: 'desktop', address: '192.168.1.8' };
  assert.deepEqual(await adapter.sync.pairWith(peer, 'ABCD-2345'), { ok: true, device: peer });
  assert.deepEqual(calls[0].args, { peer, code: 'ABCD-2345' });
  assert.deepEqual(await adapter.sync.send(peer, {}), { ok: false, error: 'Device is offline' });
});

test('Large Unicode boards cross bounded binary chunks without losing characters', async () => {
  const chunks = [];
  const token = 'a'.repeat(32);
  let saved;
  const { adapter, calls } = await setup(({ method, args, argsFile }) => {
    if (method === 'blob:begin') return { token };
    if (method === 'blob:append') {
      assert.equal(args.offset, chunks.reduce((sum, part) => sum + part.length, 0));
      chunks.push(Buffer.from(args.data, 'base64'));
    }
    if (method === 'boards:save') {
      assert.equal(argsFile, token);
      saved = JSON.parse(Buffer.concat(chunks).toString());
    }
    return true;
  });
  const board = { id: 'lesson', json: JSON.stringify({ id: 'lesson', name: 'বাংলা 🖊️'.repeat(30000), objects: [] }) };
  assert.equal(await adapter.boards.save(board), true);
  assert.deepEqual(saved, board);
  assert.ok(calls.every((request) => JSON.stringify(request).length < 140000));
  assert.equal(calls.at(-1).method, 'blob:release');
});

test('File writes preserve typed-array offsets and cancellation returns no path', async () => {
  const chunks = [];
  const token = 'b'.repeat(32);
  const { adapter } = await setup(({ method, args }) => {
    if (method === 'blob:begin') return { token };
    if (method === 'blob:append') chunks.push(Buffer.from(args.data, 'base64'));
    if (method === 'dialog:save') return null;
    return true;
  });
  await adapter.writeFile('file', new Uint8Array([9, 1, 2, 8]).subarray(1, 3));
  assert.deepEqual([...Buffer.concat(chunks)], [1, 2]);
  assert.equal(await adapter.saveDialog({}), null);
});

test('Flush acknowledgement follows the completed persistence callback', async () => {
  const order = [];
  const { adapter, native } = await setup(({ method }) => { order.push(method); return true; });
  adapter.onFlush(async () => { await Promise.resolve(); order.push('saved'); });
  await native.onmessage({ data: JSON.stringify({ event: 'flush', result: { ticket: 'flush1' } }) });
  assert.deepEqual(order, ['saved', 'app:flushed']);
});

/*
 * The page paints itself dark, but the status bar, the navigation bar and the
 * window behind the WebView belong to Android. Without this the phone shows a
 * dark board in a light frame - and on a phone the frame is a third of what
 * you can see.
 */
test('Choosing a theme tells Android, so the bars match the board', async () => {
  const seen = [];
  const { adapter, calls } = await setup(async (request) => {
    if (request.method !== 'theme:set') throw new Error('unexpected ' + request.method);
    seen.push(request.args);
    return true;
  });
  for (const want of ['dark', 'light', 'system']) await adapter.setTheme(want);
  assert.equal(calls.filter((c) => c.method === 'theme:set').length, 3,
    `told Android three times; calls were ${JSON.stringify(calls.map((c) => c.method))}`);
  assert.deepEqual(seen, ['dark', 'light', 'system'],
    `Android was told ${JSON.stringify(seen)} — it must hear the choice itself, including ` +
    `"system", which is the one case where the phone decides rather than GazBoard`);
});

test('The Chinese font is fetched by Android, since the page may reach no website itself', async () => {
  const url = 'https://cdn.jsdelivr.net/gh/fahim9778/GazBoard@main/fonts/gazboard-noto-sans-sc-400-v1.woff2';
  const bytes = Buffer.from('not really a font');
  const token = 'a'.repeat(32);
  const seen = [];
  const { adapter, calls, native } = await setup(async (request) => {
    if (request.method === 'fonts:download') {
      native.onmessage({ data: JSON.stringify({ event: 'fontProgress', result: { got: 5, total: bytes.length } }) });
      return { ok: true, token };
    }
    if (request.method === 'blob:release') return true;
    throw new Error('unexpected ' + request.method);
  });
  global.fetch = async (u) => ({ ok: u.endsWith(token), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  const res = await adapter.fetchFont(url, { onProgress: (got, total) => seen.push([got, total]) });
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual({ ok: res.ok, text: buf.toString(), asked: calls.find((c) => c.method === 'fonts:download')?.args, progress: seen },
    { ok: true, text: 'not really a font', asked: url, progress: [[5, bytes.length]] },
    `fetchFont answered ok=${res.ok} with "${buf}", asked Android for ${JSON.stringify(calls.map((c) => [c.method, c.args]))}, progress ${JSON.stringify(seen)}`);
});

test('A font server that says no, and a phone that cannot reach it, read like fetch() would', async () => {
  let reply = { ok: false, status: 404 };
  const { adapter } = await setup(async () => reply);
  const said = await adapter.fetchFont('https://raw.githubusercontent.com/fahim9778/GazBoard/main/fonts/x.woff2');
  assert.deepEqual({ ok: said.ok, status: said.status }, { ok: false, status: 404 },
    `a 404 came back as ${JSON.stringify(said)} — it must say "Server replied 404", not "No connection"`);
  reply = { ok: false, offline: true };
  const err = await adapter.fetchFont('https://raw.githubusercontent.com/fahim9778/GazBoard/main/fonts/x.woff2').then(() => null, (e) => e);
  assert.ok(err instanceof TypeError, `an unreachable server gave ${err} — fontpack.js counts a TypeError as "No connection"`);
});

test('fontpack.js uses the Android fetcher when there is one, and reports what it said', async () => {
  global.window = { board: {} };
  const { download, PACKS, SOURCES } = await import('../src/js/fontpack.js');
  const asked = [];
  window.board.fetchFont = async (url) => { asked.push(url); return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; };
  const r = await download('sc');
  assert.deepEqual({ r, asked }, { r: { ok: false, error: 'Server replied 404' }, asked: SOURCES.map((s) => s(PACKS.sc.file)) },
    `download went ${JSON.stringify(r)} after asking ${JSON.stringify(asked)} — on Android the page's own fetch is always refused`);
});

test('Android allows exactly the font addresses fontpack.js asks for, and nothing else', async () => {
  const fs = require('node:fs');
  const kt = fs.readFileSync(require.resolve('../android/app/src/main/java/com/gazboard/app/MainActivity.kt'), 'utf8');
  const { PACKS, SOURCES } = await import('../src/js/fontpack.js');
  const bases = [...kt.matchAll(/"(https:\/\/[^"]+\/fonts\/)"/g)].map((m) => m[1]);
  const pattern = new RegExp('^' + kt.match(/FONT_FILE = Regex\("([^"]+)"\)/)[1].replace(/\\\\/g, '\\') + '$');
  const wanted = Object.values(PACKS).flatMap((p) => SOURCES.map((s) => s(p.file)));
  const refused = wanted.filter((u) => { const b = bases.find((x) => u.startsWith(x)); return !b || !pattern.test(u.slice(b.length)); });
  assert.deepEqual({ refused, strangerAllowed: pattern.test('../../etc/passwd') || pattern.test('evil.js') }, { refused: [], strangerAllowed: false },
    `Android would refuse ${JSON.stringify(refused)} (it allows ${JSON.stringify(bases)} with ${pattern})`);
  assert.match(kt, /"fonts:download"|downloadFont/, 'MainActivity has no font downloader');
  const bridge = fs.readFileSync(require.resolve('../android/app/src/main/java/com/gazboard/app/NativeBridge.kt'), 'utf8');
  assert.match(bridge, /"fonts:download" -> activity\.downloadFont/, 'the bridge does not route fonts:download to the downloader');
});

test('On Android, "Add a font file" opens the phone\'s own picker, since a WebView ignores a file input', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/js/ui/panels.js'), 'utf8');
  const row = src.slice(src.indexOf('function fontPackRow'), src.indexOf('function settings()'));
  assert.match(row, /platform === 'android' \? pickNative\(\) : picker\.click\(\)/,
    `the Add-a-font-file button does not branch for Android:\n${row.slice(row.indexOf("Add a font file"), row.indexOf("Add a font file") + 200)}`);
  assert.match(row, /window\.board\.openDialog\(/, 'the Android branch does not ask the native picker');
});
