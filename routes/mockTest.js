import { Router } from "express";
import { requireAuth } from "../lib/auth.js";
import { generateMockTestQuestions, gradeOpenAnswers, extractJson } from "../lib/openrouter.js";
import { supabase } from "../lib/supabase.js";

const router = Router();

// Same "has real content" sanity bar the resume route applies to itself,
// applied here to the model's own JSON output: a free-tier model that
// half-follows the schema (wrong array length, missing fields) should be
// treated as a generation failure — credit refunded — not silently served
// to the student as a broken quiz.
function isValidMockTest(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (!Array.isArray(parsed.mcq) || parsed.mcq.length !== 5) return false;
  if (!Array.isArray(parsed.open) || parsed.open.length !== 2) return false;
  const mcqOk = parsed.mcq.every(
    (q) =>
      q &&
      typeof q.question === "string" &&
      Array.isArray(q.options) &&
      q.options.length === 4 &&
      q.options.every((o) => typeof o === "string") &&
      Number.isInteger(q.correctIndex) &&
      q.correctIndex >= 0 &&
      q.correctIndex <= 3
  );
  const openOk = parsed.open.every((q) => q && typeof q.question === "string");
  return mcqOk && openOk;
}

// Never send correctIndex / explanation / gradingNotes to the client before
// the test is submitted — that's the answer key.
function sanitizeForStudent(questions) {
  return {
    mcq: questions.mcq.map((q) => ({ question: q.question, options: q.options })),
    open: questions.open.map((q) => ({ question: q.question })),
  };
}

router.post("/generate", requireAuth, async (req, res) => {
  if (req.profile.approval_status !== "approved") {
    return res.status(403).json({ error: "Your profile isn't approved yet — an admin needs to approve you first." });
  }

  // sapModule/level aren't in PROFILE_COLUMNS (see lib/auth.js) — trusted
  // from the client the same way routes/resume.js trusts them, since they
  // only steer question content, not anything security-sensitive.
  const { sapModule, level } = req.body || {};

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
      error: "No credits remaining. Purchase more to take a mock test.",
      code: "NO_CREDITS",
    });
  }

  try {
    const { raw, model } = await generateMockTestQuestions({ sapModule, level });
    const parsed = extractJson(raw);
    if (!isValidMockTest(parsed)) {
      throw new Error("The generated test didn't come back in the expected shape.");
    }

    const { data: row, error: insertError } = await supabase
      .from("mock_tests")
      .insert({
        user_id: req.user.id,
        sap_module: sapModule || null,
        level: level || null,
        questions: parsed,
        model,
        status: "generated",
      })
      .select("id")
      .single();

    if (insertError) throw new Error(insertError.message);

    await supabase.from("credit_ledger").insert({
      user_id: req.user.id,
      delta: -1,
      reason: "mock_test_generation",
    });

    res.json({
      mockTestId: row.id,
      questions: sanitizeForStudent(parsed),
      creditsRemaining: spent.credits_remaining,
    });
  } catch (err) {
    // Generation (or the insert right after it) failed after the credit was
    // already spent — refund it, same pattern as the resume route.
    await supabase
      .from("profiles")
      .update({
        credits_remaining: spent.credits_remaining + 1,
        credits_used: req.profile.credits_used,
      })
      .eq("id", req.user.id);

    res.status(502).json({ error: `Mock test generation failed: ${err.message}` });
  }
});

router.post("/:id/submit", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { mcqAnswers, openAnswers } = req.body || {};

  const { data: row, error: fetchError } = await supabase
    .from("mock_tests")
    .select("id, user_id, questions, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    return res.status(500).json({ error: fetchError.message });
  }
  if (!row || row.user_id !== req.user.id) {
    return res.status(404).json({ error: "Mock test attempt not found." });
  }
  if (row.status === "submitted") {
    return res.status(409).json({ error: "This attempt has already been submitted." });
  }

  const questions = row.questions;
  const mcq = Array.isArray(questions?.mcq) ? questions.mcq : [];
  const open = Array.isArray(questions?.open) ? questions.open : [];

  const safeMcqAnswers = Array.isArray(mcqAnswers) ? mcqAnswers : [];
  const safeOpenAnswers = Array.isArray(openAnswers) ? openAnswers : [];

  const mcqResults = mcq.map((q, i) => ({
    correct: safeMcqAnswers[i] === q.correctIndex,
    correctIndex: q.correctIndex,
    explanation: q.explanation || null,
  }));
  const mcqScore = mcqResults.filter((r) => r.correct).length;

  let openScores;
  let model = null;
  try {
    const items = open.map((q, i) => ({
      question: q.question,
      gradingNotes: q.gradingNotes,
      answer: safeOpenAnswers[i] || "",
    }));
    const graded = await gradeOpenAnswers(items);
    model = graded.model;
    const parsed = extractJson(graded.raw);
    if (!Array.isArray(parsed.results) || parsed.results.length !== open.length) {
      throw new Error("bad shape");
    }
    openScores = parsed.results.map((r) => ({
      score: Number.isFinite(r.score) ? Math.max(0, Math.min(10, r.score)) : 0,
      feedback: typeof r.feedback === "string" ? r.feedback : "",
    }));
  } catch {
    // Grading failed (model hiccup, bad JSON) — don't fail the whole
    // submission over it. The student still gets their MCQ score and a
    // neutral note instead of a lost attempt.
    openScores = open.map(() => ({ score: 0, feedback: "Automatic grading was unavailable for this answer." }));
  }

  const openTotal = openScores.reduce((sum, r) => sum + r.score, 0);
  const maxOpenTotal = open.length * 10;
  const totalScore = mcqScore + openTotal;
  const maxScore = mcq.length + maxOpenTotal;

  const { error: updateError } = await supabase
    .from("mock_tests")
    .update({
      mcq_answers: safeMcqAnswers,
      open_answers: safeOpenAnswers,
      mcq_score: mcqScore,
      open_scores: openScores,
      total_score: totalScore,
      max_score: maxScore,
      status: "submitted",
      submitted_at: new Date().toISOString(),
      model: model || undefined,
    })
    .eq("id", id);

  if (updateError) {
    return res.status(500).json({ error: updateError.message });
  }

  res.json({
    mcqScore,
    mcqTotal: mcq.length,
    mcqResults,
    openScores,
    openTotal,
    maxOpenTotal,
    totalScore,
    maxScore,
  });
});

export default router;