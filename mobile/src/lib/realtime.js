// Live updates: when anyone in the family saves, Supabase tells this phone right away, and it syncs.
// If this can't connect, the app still syncs when opened and every 30 seconds while open.
import { createClient } from "@supabase/supabase-js";

let client = null;
let channel = null;

export function startRealtime(url, key, accessToken, familyId, onChange) {
  try {
    if (!client) {
      client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    }
    client.realtime.setAuth(accessToken);
    stopRealtime();
    channel = client
      .channel("family-" + familyId)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "family_data", filter: `family_id=eq.${familyId}` },
        () => onChange())
      .subscribe();
  } catch {
    channel = null;
  }
}

export function updateRealtimeToken(accessToken) {
  try {
    if (client) client.realtime.setAuth(accessToken);
  } catch {
    // polling covers it
  }
}

export function stopRealtime() {
  try {
    if (client && channel) client.removeChannel(channel);
  } catch {
    // ignore
  }
  channel = null;
}
