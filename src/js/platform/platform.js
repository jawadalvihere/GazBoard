// Platform initialization module for GazBoard.
// Seamlessly activates the appropriate platform runtime (Electron or Web/PWA).

import { createWebAdapter, emitOpenFile } from './web-adapter.js';
import { registerSessionFile } from './web-files.js';
import * as cloudStorage from '../cloud/cloud-storage.js';

export function initPlatform() {
  if (typeof window === 'undefined') return;

  // 1. Electron Runtime Detection
  if (window.board && typeof window.board.info === 'function') {
    // Electron's preload script has already mounted window.board. Boards and
    // assets keep going to disk exactly as before; the cloud layer wraps that
    // so the desktop app takes part in sync on the same terms as the PWA.
    attachCloudToBridge();
    return;
  }

  // 2. Browser / PWA Runtime Initialization
  window.board = createWebAdapter();

  // 3. Register Service Worker in Secure Contexts
  if ('serviceWorker' in navigator) {
    const isLocalhost = Boolean(
      window.location.hostname === 'localhost' ||
      window.location.hostname === '[::1]' ||
      window.location.hostname.match(/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/)
    );

    if (window.location.protocol === 'https:' || isLocalhost) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js', { scope: './' })
          .then((reg) => {
            // Check for update on launch
            reg.update().catch(() => {});
          })
          .catch((err) => {
            console.warn('[pwa] Service Worker registration failed:', err);
          });
      });
    }
  }

  // 4. Global Drag & Drop handling for web browser
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;

    const files = Array.from(e.dataTransfer.files);
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (['gazboard', 'openboard', 'json'].includes(ext)) {
        try {
          const text = await f.text();
          const doc = JSON.parse(text);
          if (doc && (doc.objects || doc.id)) {
            emitOpenFile(doc);
            return;
          }
        } catch {}
      }
    }
  });
}

/**
 * Route the desktop bridge's board and asset calls through the cloud layer.
 *
 * contextBridge defines window.board as a read-only property, so the wrapper
 * has to be installed with defineProperty rather than plain assignment. If
 * that is refused the app carries on with the untouched bridge - local-only,
 * exactly as upstream behaves - rather than failing to start.
 */
function attachCloudToBridge() {
  const bridge = window.board;
  try {
    cloudStorage.setLocalBackend(cloudStorage.backendFromBridge(bridge));

    const wrapped = {
      ...bridge,
      boards: {
        list: () => cloudStorage.listBoards(),
        load: (id) => cloudStorage.loadBoard(id),
        save: (b) => cloudStorage.saveBoard(b),
        remove: (id) => cloudStorage.deleteBoard(id),
        last: () => cloudStorage.getLastBoard(),
        setLast: (id) => cloudStorage.setLastBoard(id),
        resume: () => cloudStorage.resumeBoard(),
        migrate: () => cloudStorage.migrateLegacyData()
      },
      assets: {
        put: (dataUrl) => cloudStorage.putAsset(dataUrl),
        get: (id) => cloudStorage.getAsset(id),
        have: (ids) => cloudStorage.haveAssets(ids)
      }
    };

    Object.defineProperty(window, 'board', {
      value: wrapped, writable: true, configurable: true
    });
  } catch (e) {
    console.warn('[cloud] desktop bridge left unwrapped; sync disabled here:', e.message);
    cloudStorage.setLocalBackend(cloudStorage.backendFromBridge(bridge));
  }
}

// Auto-run on import
initPlatform();
