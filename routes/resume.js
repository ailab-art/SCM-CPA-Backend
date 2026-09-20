import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { generateResume } from "../lib/openrouter.js";
import { supabase } from "../lib/supabase.js";

const router = Router();

// A row the student added but never filled in (e.g. clicked "Add" then
// changed their mind) doesn't count — same "has real content" rule the
// profile page itself uses to filter out blank rows before saving.
function hasContent(entry) {
  return Boolean(entry) && Object.values(entry).some((v) => typeof v === "string" && v.trim());
}

router.post("/generate", requireAuth, async (req, res) => {
  if (req.profile.approval_status !== "approved") {
    return res.status(403).json({ error: "Your profile isn't approved yet — an admin needs to approve you first." });
  }

  // Required before generating (not required at sign-up — see
  // supabase/add-experience-education.sql and the profile page). Checked
  // against the student's saved profile, not anything the client sends in
  // this request, so it can't be bypassed by posting fake data.
  const experience = Array.isArray(req.profile.experience) ? req.profile.experience : [];
  const education = Array.isArray(req.profile.education) ? req.profile.education : [];
  if (!experience.some(hasContent) || !education.some(hasContent)) {
    return res.status(400).json({
      error: "Add at least one work experience entry and one education entry to your profile before generating a resume.",
      code: "PROFILE_INCOMPLETE",
    });
  }

  const { fullName, level, sapModule, yearsExperience, currentTitle, skills, summary } = req.body || {};
  if (!fullName || !String(fullName).trim() || !skills || !String(skills).trim()) {
    return res.status(400).json({ error: "Name and at least one skill/module are required." });
  }

  // Atomic, race-safe spend: this UPDATE only matches (and only returns a
  // row) if credits_remaining is still > 0 at the moment Postgres applies
  // it, so two simultaneous requests can't both succeed off the same last
  // credit.
  const { data: spent, error: spendError } = await supabase
    .from("profiles")
    .update({
      credits_remaining: req.profile.credits_remaining - 1,
      credits_used: req.profile.credits_used + 1,
    })
    .eq("id", req.user.id)
    .gt("credits_remaining", 0)
    .select("credits_remaining")
    .maybeSingle();

  if (spendError) {
    return res.status(500).json({ error: spendError.message });
  }
  if (!spent) {
    return res.status(402).json({
      error: "No credits remaining. Purchase more to generate another resume.",
      code: "NO_CREDITS",
    });
  }

  try {
    const { content, model } = await generateResume({
      fullName,
      level,
      sapModule,
      yearsExperience,
      currentTitle,
      skills,
      summary,
      experience: experience.filter(hasContent),
      education: education.filter(hasContent),
    });

    await supabase.from("resumes").insert({
      user_id: req.user.id,
      input: req.body,
      content,
      model,
    });
    await supabase.from("credit_ledger").insert({
      user_id: req.user.id,
      delta: -1,
      reason: "resume_generation",
    });

    res.json({ content, creditsRemaining: spent.credits_remaining });
  } catch (err) {
    // Generation failed after the credit was already spent — refund it
    // rather than let the student lose a credit for nothing.
    await supabase
      .from("profiles")
      .update({
        credits_remaining: spent.credits_remaining + 1,
        credits_used: req.profile.credits_used,
      })
      .eq("id", req.user.id);

    res.status(502).json({ error: `Resume generation failed: ${err.message}` });
  }
});

export default router;