import { supabase } from "./supabase.js";

const PROFILE_COLUMNS =
  "id, email, is_admin, is_master_admin, approval_status, credits_remaining, credits_used, credits_purchased, experience, education";

// Every protected route expects `Authorization: Bearer <supabase access
// token>` — the frontend gets that token from
// `supabase.auth.getSession()`. auth.getUser(token) asks Supabase Auth to
// validate it (checks signature + expiry), so this backend never has to
// hold or verify a JWT secret itself.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token." });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Invalid or expired session — sign in again." });
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) {
    return res.status(500).json({ error: profileError.message });
  }
  if (!profile) {
    return res.status(404).json({ error: "No profile found for this account yet." });
  }

  req.user = data.user;
  req.profile = profile;
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.profile?.is_admin) {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

export function requireMasterAdmin(req, res, next) {
  if (!req.profile?.is_master_admin) {
    return res.status(403).json({ error: "Only the master admin can do that." });
  }
  next();
}