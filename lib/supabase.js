import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in (or set them in Railway's Variables tab)."
  );
}

// Service-role client: bypasses RLS entirely. This is the only client this
// backend ever creates — every route is trusted server-side code, and
// profiles.sql's protect_privileged_columns trigger is what actually keeps
// students from writing their own credits/admin flags from the browser, so
// this key being privileged here is expected, not a shortcut around that.
export const supabase = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
