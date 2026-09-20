// OpenRouter's free-tier lineup turns over fast — two different models that
// were confirmed free went dead within days of each other while building
// this. Rather than hardcode one model and have this break every time
// OpenRouter retires it, this tries a short ordered list of currently-free
// models and falls through to the next one whenever OpenRouter responds with
// its "not available for free anymore" 404. OPENROUTER_MODEL (if set) is
// tried first, so you can still pin a specific model without a code change —
// the built-in list below is just the safety net under it.
//
// Verified free on openrouter.ai/api/v1/models (pricing.prompt = pricing.completion = "0")
// as of 2026-09-20. Check https://openrouter.ai/models?max_price=0 if every
// model in this list ever fails at once — that means the whole list aged out
// and needs refreshing, not that something else broke.
const FALLBACK_MODELS = [
  "qwen/qwen3.8-27b:free",
  "nex-agi/nex-n2.5-pro:free",
  "nex-agi/nex-n2.5-mini:free",
];

const CANDIDATE_MODELS = process.env.OPENROUTER_MODEL
  ? [process.env.OPENROUTER_MODEL, ...FALLBACK_MODELS.filter((m) => m !== process.env.OPENROUTER_MODEL)]
  : FALLBACK_MODELS;

const SYSTEM_PROMPT = `You are an expert SAP EWM resume writer. Write a complete, ATS-friendly resume
in plain text (no markdown, no asterisks for bold — just clear section headings in capital
letters and simple line breaks). Sections, in order: header (name + title), professional
summary (3-4 lines), core skills (a comma-separated line grouping SAP module skills), work
experience framed generically around the candidate's stated title/years if no employer history
was given, and education/certifications left as a placeholder line the candidate can fill in.
Weave in SAP EWM ATS keywords naturally where they fit the candidate's module and skills (e.g.
Wave Management, Putaway Strategy, Batch Management, RF Framework, Exception Handling, Cross
Docking) — never force a keyword that has nothing to do with the candidate's input. Keep it
realistic and specific to what the candidate gave you; do not invent employers, dates, or
degrees.`;

function buildPrompt(fields) {
  const {
    fullName,
    level,
    sapModule,
    yearsExperience,
    currentTitle,
    skills,
    summary,
  } = fields;

  return [
    `Candidate name: ${fullName}`,
    `Target level: ${level || "not specified"}`,
    `Primary SAP module: ${sapModule || "not specified"}`,
    `Years of experience: ${yearsExperience ?? "not specified"}`,
    `Current job title / profile: ${currentTitle || "not specified"}`,
    `Modules / skills completed: ${skills || "not specified"}`,
    summary ? `Candidate's own summary notes: ${summary}` : null,
    "",
    "Write the resume now.",
  ]
    .filter(Boolean)
    .join("\n");
}

// True for the specific failures worth trying the next model over: OpenRouter
// retired this model from the free tier (404 + "unavailable for free"), or
// this particular free model is temporarily saturated with demand (429 —
// seen in practice on qwen/qwen3.8-27b:free within hours of it being
// verified free). Both are "this model, right now" problems, not "your
// request is broken" problems, so it's worth trying the next candidate
// rather than failing outright. A real error (bad request, auth failure,
// model genuinely doesn't exist) still surfaces immediately instead of
// silently burning three more round-trips first.
function shouldTryNextModel(status, bodyText) {
  if (status === 429) return true;
  if (status === 404) return /unavailable for free|not available for free/i.test(bodyText);
  return false;
}

async function callOpenRouter(model, fields) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const referer = (process.env.FRONTEND_URL || "https://scm-cloudboo-cpa.vercel.app").split(",")[0].trim();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-Title": "SCM Cloudbook Resume Builder",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(fields) },
      ],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const error = new Error(`OpenRouter returned ${res.status}: ${text || res.statusText}`);
    error.status = res.status;
    error.bodyText = text;
    throw error;
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter returned an empty response.");
  }
  return content;
}

export async function generateResume(fields) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY isn't set on the backend.");
  }

  let lastError;
  for (const model of CANDIDATE_MODELS) {
    try {
      const content = await callOpenRouter(model, fields);
      return { content, model };
    } catch (err) {
      lastError = err;
      if (shouldTryNextModel(err.status, err.bodyText)) {
        // Try the next model in the list.
        continue;
      }
      // Any other failure (bad request, auth, empty response) — don't waste
      // three more round-trips on models that won't fix it.
      throw err;
    }
  }

  throw new Error(
    `All configured free models are unavailable right now (last error: ${lastError?.message}). ` +
      `Check https://openrouter.ai/models?max_price=0 for currently-free models and update FALLBACK_MODELS in lib/openrouter.js.`
  );
}