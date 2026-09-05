// Supabase client + session handling.
//
// The SDK is vendored as a UMD bundle at js/vendor/supabase.js and loaded by a
// plain <script> tag, because the web build is a straight file copy with no
// bundler and the page runs under a strict `script-src 'self'` CSP. So we read
// it off the global rather than importing it.

import { CLOUD_URL, CLOUD_KEY, cloudConfigured } from './config.js';

let _client = null;
const _authSubs = new Set();

export function getClient() {
  if (_client) return _client;
  if (!cloudConfigured()) return null;

  const sdk = typeof window !== 'undefined' ? window.supabase : null;
  if (!sdk || typeof sdk.createClient !== 'function') {
    console.warn('[cloud] Supabase SDK not loaded; sync disabled');
    return null;
  }

  _client = sdk.createClient(CLOUD_URL, CLOUD_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // The app is a single page with no OAuth redirects, and parsing the URL
      // fragment would fight the board-open deep links.
      detectSessionInUrl: false,
      storageKey: 'gazboard.auth'
    },
    realtime: {
      // Drawing produces a lot of small ops. The default of 10/sec drops
      // strokes mid-gesture; this keeps a fast scribble intact.
      params: { eventsPerSecond: 40 }
    }
  });

  _client.auth.onAuthStateChange((event, session) => {
    for (const fn of _authSubs) {
      try { fn(session?.user || null, event); } catch {}
    }
  });

  return _client;
}

export function onAuthChange(fn) {
  _authSubs.add(fn);
  return () => _authSubs.delete(fn);
}

export async function currentUser() {
  const c = getClient();
  if (!c) return null;
  try {
    const { data } = await c.auth.getSession();
    return data?.session?.user || null;
  } catch {
    return null;
  }
}

export async function signIn(email, password) {
  const c = getClient();
  if (!c) return { ok: false, error: 'Cloud sync is not configured in this build.' };
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: friendlyAuthError(error) };
  return { ok: true, user: data.user };
}

export async function signUp(email, password) {
  const c = getClient();
  if (!c) return { ok: false, error: 'Cloud sync is not configured in this build.' };
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) return { ok: false, error: friendlyAuthError(error) };
  // With email confirmation switched on there is a user but no session yet.
  const needsConfirm = Boolean(data.user && !data.session);
  return { ok: true, user: data.user, needsConfirm };
}

export async function signOut() {
  const c = getClient();
  if (!c) return true;
  try { await c.auth.signOut(); } catch {}
  return true;
}

function friendlyAuthError(error) {
  const msg = String(error?.message || 'Something went wrong');
  if (/invalid login credentials/i.test(msg)) return 'That email and password do not match an account.';
  if (/email not confirmed/i.test(msg)) return 'Check your inbox and confirm the email address first.';
  if (/already registered|already been registered/i.test(msg)) return 'That email already has an account - sign in instead.';
  if (/password should be at least/i.test(msg)) return 'Password needs to be at least 6 characters.';
  if (/rate limit|too many/i.test(msg)) return 'Too many tries. Wait a minute and try again.';
  if (/fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection.';
  return msg;
}
