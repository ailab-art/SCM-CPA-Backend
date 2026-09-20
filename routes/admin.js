import { Router } from "express";
import { requireAuth, requireAdmin, requireMasterAdmin } from "../lib/auth.js";
import { supabase } from "../lib/supabase.js";

const router = Router();

// Any admin can see usage — only a master admin can change it (enforced
// per-route below, matching the "only master admin can increase credit"
// requirement).
router.get("/credits", requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, is_admin, is_master_admin, credits_remaining, credits_used, credits_purchased")
    .order("credits_used", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profiles: data });
});

router.post("/credits/grant", requireAuth, requireMasterAdmin, async (req, res) => {
  const { userId, amount, note } = req.body || {};
  const parsedAmount = Number(amount);
  if (!userId || !Number.isFinite(parsedAmount) || parsedAmount === 0) {
    return res.status(400).json({ error: "userId and a non-zero amount are required." });
  }

  const { data: target, error: targetError } = await supabase
    .from("profiles")
    .select("credits_remaining, credits_purchased")
    .eq("id", userId)
    .maybeSingle();
  if (targetError) return res.status(500).json({ error: targetError.message });
  if (!target) return res.status(404).json({ error: "User not found." });

  const newRemaining = Math.max(0, target.credits_remaining + parsedAmount);
  const { error: updateError } = await supabase
    .from("profiles")
    .update({
      credits_remaining: newRemaining,
      credits_purchased:
        parsedAmount > 0 ? target.credits_purchased + parsedAmount : target.credits_purchased,
    })
    .eq("id", userId);
  if (updateError) return res.status(500).json({ error: updateError.message });

  await supabase.from("credit_ledger").insert({
    user_id: userId,
    delta: parsedAmount,
    reason: "admin_grant",
    note: note || `Adjusted by ${req.user.email}`,
  });

  res.json({ ok: true, creditsRemaining: newRemaining });
});

export default router;
