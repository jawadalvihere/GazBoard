// Sync status pill + account dialog.
//
// Deliberately small: one pill in the top bar that tells the truth about
// whether this device is currently in step with the other one, and one dialog
// behind it for signing in and out. Everything else about sync is meant to be
// invisible.

import { h } from '../ui/popover.js';
import { cloudConfigured } from './config.js';
import { currentUser, signIn, signUp, signOut, onAuthChange } from './client.js';
import * as sync from './sync.js';

const LABEL = {
  off: 'Sync off',
  connecting: 'Syncing…',
  live: 'Synced',
  offline: 'Offline',
  error: 'Sync problem'
};

let _app = null;
let _pill = null;

export function mountSyncUI(app) {
  if (!cloudConfigured()) return;
  _app = app;

  const bar = document.getElementById('topbar');
  const badge = document.getElementById('savedBadge');
  if (!bar) return;

  _pill = h('button', {
    class: 'badge sync-pill',
    id: 'syncPill',
    title: 'Cloud sync',
    onclick: () => openAccountDialog()
  }, LABEL.off);

  // Sit next to the existing Saved badge so the two read as one status area.
  if (badge && badge.parentNode === bar) bar.insertBefore(_pill, badge.nextSibling);
  else bar.appendChild(_pill);

  sync.onStatus(render);
  onAuthChange((user) => {
    if (user) sync.enable(user.id).catch(() => {});
    else sync.disable().catch(() => {});
    render(sync.status());
  });

  // A session restored from a previous visit should start syncing without
  // waiting for the user to open the dialog.
  currentUser().then((u) => { if (u) sync.enable(u.id).catch(() => {}); }).catch(() => {});

  // Anything still buffered when the tab is hidden or closed goes now - on a
  // phone, switching apps is the normal way a session ends.
  const flush = () => { sync.flushNow().catch(() => {}); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

function render(state) {
  if (!_pill) return;
  _pill.textContent = LABEL[state] || LABEL.off;
  _pill.dataset.sync = state;
}

/* ---------------- account dialog ---------------- */

export async function openAccountDialog() {
  const overlay = document.getElementById('overlay');
  const card = document.getElementById('overlayCard');
  if (!overlay || !card) return;

  const user = await currentUser();
  card.innerHTML = '';
  const close = () => { _app._overlayDismiss = null; overlay.classList.remove('show'); };

  if (user) {
    renderSignedIn(card, user, close);
  } else {
    renderSignedOut(card, close);
  }
  _app.showOverlay(close);
}

function renderSignedIn(card, user, close) {
  card.appendChild(h('h3', {}, 'Cloud sync'));
  card.appendChild(h('p', {},
    `Signed in as ${user.email}. Your boards follow you to any device you sign in on.`));

  const state = sync.status();
  card.appendChild(h('p', { class: 'sync-state' },
    state === 'live' ? 'This device is up to date.'
      : state === 'offline' ? 'No connection right now. Your work is saved here and will go up when you are back online.'
      : state === 'error' ? 'Could not reach the sync server. Your work is safe on this device.'
      : 'Catching up…'));

  card.appendChild(h('div', { class: 'actions' },
    h('button', {
      class: 'btn',
      onclick: async () => {
        close();
        await sync.flushNow().catch(() => {});
        await signOut();
        _app.toast('Signed out. Boards stay on this device.', 'check');
      }
    }, 'Sign out'),
    h('button', { class: 'btn primary', onclick: close }, 'Done')));
}

function renderSignedOut(card, close) {
  card.appendChild(h('h3', {}, 'Sync across your devices'));
  card.appendChild(h('p', {},
    'Sign in to keep the same boards on your laptop and your phone. Without this, GazBoard works exactly as before and everything stays on this device.'));

  const email = h('input', {
    type: 'email', placeholder: 'you@example.com', autocomplete: 'username',
    class: 'sync-input', spellcheck: 'false'
  });
  const pass = h('input', {
    type: 'password', placeholder: 'Password', autocomplete: 'current-password',
    class: 'sync-input'
  });
  const err = h('p', { class: 'sync-error', hidden: true });

  card.appendChild(h('div', { class: 'sync-form' }, email, pass, err));

  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  const busy = (on) => {
    for (const b of card.querySelectorAll('button')) b.disabled = on;
  };

  const attempt = async (fn, successMsg) => {
    err.hidden = true;
    const e = email.value.trim();
    const p = pass.value;
    if (!e || !p) { fail('Enter an email and a password.'); return; }
    busy(true);
    const res = await fn(e, p);
    busy(false);
    if (!res.ok) { fail(res.error); return; }
    if (res.needsConfirm) {
      fail('Almost there - open the confirmation email, then sign in.');
      return;
    }
    close();
    _app.toast(successMsg, 'check');
  };

  card.appendChild(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: close }, 'Not now'),
    h('button', {
      class: 'btn',
      onclick: () => attempt(signUp, 'Account created. Your boards now sync.')
    }, 'Create account'),
    h('button', {
      class: 'btn primary',
      onclick: () => attempt(signIn, 'Signed in. Pulling your boards…')
    }, 'Sign in')));

  pass.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') attempt(signIn, 'Signed in. Pulling your boards…');
  });
  setTimeout(() => email.focus(), 50);
}
