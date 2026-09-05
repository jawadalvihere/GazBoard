// Cloud sync configuration.
//
// Both values below are safe to ship in the client. The publishable key only
// ever grants what row-level security allows, and every gaz_* policy on the
// server is scoped to `owner = auth.uid()` - so a signed-out visitor with this
// key can read exactly nothing.
//
// Sync stays completely off unless CLOUD_URL and CLOUD_KEY are both set, which
// keeps upstream GazBoard's "no account, no cloud" promise intact for anyone
// building this fork without a Supabase project.

export const CLOUD_URL = 'https://kokimavtszlcksriruih.supabase.co';
export const CLOUD_KEY = 'sb_publishable_wTHcn_9tCN-6z7l_BihFrw_C5bYRtkf';

export const ASSET_BUCKET = 'gazboard-assets';

// How long to wait after the last stroke before pushing a full snapshot.
// Live ops travel instantly over broadcast; the snapshot is the durable copy
// the other device loads cold, so it can afford to lag behind a little.
export const SNAPSHOT_DEBOUNCE_MS = 1500;

export function cloudConfigured() {
  return Boolean(CLOUD_URL && CLOUD_KEY);
}
