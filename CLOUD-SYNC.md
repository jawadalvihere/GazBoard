# Cloud sync (fork addition)

Upstream GazBoard is deliberately offline: no account, no cloud, boards live on
the one device that made them. This fork adds an **opt-in** second copy in the
cloud so the same boards appear on a laptop and a phone, and so a stroke drawn
on one shows up on the other while you are still drawing it.

Signed out, nothing changes. No network calls, no account, same app.

## How it works

Two channels, deliberately different in character:

| | carries | speed | durable? |
|---|---|---|---|
| **ops** | one stroke / move / delete at a time, over a Realtime broadcast channel named after the board | instant | no |
| **snapshot** | the whole board document, upserted into `gaz_boards` on a 1.5s debounce | lags a moment | yes |

Losing an op does not matter, because the snapshot behind it is authoritative.
That is what keeps the implementation small — no acks, no sequence numbers, no
replay log.

The op channel was not invented here. `src/js/core/store.js` already routed
every mutation through an op and exposed `applyRemote()`, with a comment
calling it "the seam a future sync/collaboration layer plugs into". This is
that layer.

### Local storage is still the source of truth

Every write lands in IndexedDB (browser) or on disk (desktop) *first*, so the
app is exactly as fast and as offline-capable as before. The cloud trails it.
Go offline, keep drawing, come back — the queued boards go up on reconnect.

### Conflicts

Last-write-wins on the board's own `modified` stamp. For one person on two
devices that is the honest rule: draw on the phone, then on the laptop, and the
laptop wins, which is what you would expect.

It is **not** sufficient for two people drawing at the same time. That needs a
real op merge and is out of scope.

### Assets

Images and imported PDF pages were already content-addressed by SHA-256, which
means an asset is immutable and uploads exactly once. They go to a private
Storage bucket under `{user-id}/{sha256}.{ext}`, and are cached back into local
storage on first read so they work offline afterwards.

## Files

```
src/js/cloud/config.js          project URL, key, tunables
src/js/cloud/client.js          Supabase client + sign in / out
src/js/cloud/cloud-storage.js   board + asset store, wraps the local one
src/js/cloud/sync.js            op broadcast, snapshot debounce, status
src/js/cloud/ui.js              status pill + account dialog
src/js/vendor/supabase.js       vendored SDK (see below)
```

Touched: `store.js` (undo/redo now reach the op channel), `platform.js` and
`web-adapter.js` (route storage through the cloud layer), `index.html` (CSP +
SDK tag), `sw.js` (precache the new files, never cache sync traffic),
`app.css` (the pill).

### Why the SDK is vendored

The web build is a straight file copy with no bundler, and the page runs under
`script-src 'self'`. A CDN tag would be blocked and a bare ESM import would not
resolve, so the UMD bundle is committed to `src/js/vendor/` and loaded with a
plain `<script>` tag.

## Server side

Three migrations, all prefixed `gaz_` so they sit safely beside unrelated
tables in the same project:

- `gaz_boards` — one row per board, `doc` holds the board JSON, RLS scoped to
  `owner = auth.uid()`. Deletes are tombstones (`deleted = true`), because a
  hard delete would just be undone by the other device pushing back the copy it
  still holds.
- `gazboard-assets` — private Storage bucket, RLS on the `{user-id}/` path
  prefix.
- `realtime.messages` policies — a client may only join the broadcast channel
  for a board it owns.

## Turning it off

Blank out `CLOUD_URL` / `CLOUD_KEY` in `src/js/cloud/config.js`. Every code
path checks `cloudConfigured()` first, so the app falls back to upstream
behaviour: local only, no pill, no network.
