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

const RESUME_SYSTEM_PROMPT = `You are an expert SAP EWM resume writer. Write a complete, ATS-friendly resume
in plain text (no markdown, no asterisks for bold — just clear section headings in capital
letters and simple line breaks). Sections, in order: header (name + title), professional
summary (3-4 lines), core skills (a comma-separated line grouping SAP module skills), work
experience (use the candidate's actual listed roles — company, title, dates, and a couple of
bullet-style lines per role drawn from what they gave you), and education (use their actual
listed degrees/institutions/years). Weave in SAP EWM ATS keywords naturally where they fit the
candidate's module and skills (e.g. Wave Management, Putaway Strategy, Batch Management, RF
Framework, Exception Handling, Cross Docking) — never force a keyword that has nothing to do
with the candidate's input. Keep it realistic and specific to what the candidate gave you; do
not invent employers, dates, or degrees beyond what's listed below.`;

function formatExperience(experience) {
  if (!Array.isArray(experience) || experience.length === 0) {
    return "not provided";
  }
  return experience
    .map((entry, i) => {
      const { title, company, duration, description } = entry || {};
      const header = [title, company].filter(Boolean).join(" at ") || `Role ${i + 1}`;
      return [
        `  ${i + 1}. ${header}${duration ? ` (${duration})` : ""}`,
        description ? `     ${description}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function formatEducation(education) {
  if (!Array.isArray(education) || education.length === 0) {
    return "not provided";
  }
  return education
    .map((entry, i) => {
      const { degree, institution, year } = entry || {};
      const header = [degree, institution].filter(Boolean).join(", ") || `Entry ${i + 1}`;
      return `  ${i + 1}. ${header}${year ? ` (${year})` : ""}`;
    })
    .join("\n");
}

function buildResumePrompt(fields) {
  const {
    fullName,
    level,
    sapModule,
    yearsExperience,
    currentTitle,
    skills,
    summary,
    experience,
    education,
  } = fields;

  return [
    `Candidate name: ${fullName}`,
    `Target level: ${level || "not specified"}`,
    `Primary SAP module: ${sapModule || "not specified"}`,
    `Years of experience: ${yearsExperience ?? "not specified"}`,
    `Current job title / profile: ${currentTitle || "not specified"}`,
    `Modules / skills completed: ${skills || "not specified"}`,
    summary ? `Candidate's own summary notes: ${summary}` : null,
    "Work experience (use this, do not invent other roles):",
    formatExperience(experience),
    "Education (use this, do not invent other degrees):",
    formatEducation(education),
    "",
    "Write the resume now.",
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Mock Test (MCQ + open-ended) -------------------------------------------

const MOCK_TEST_SYSTEM_PROMPT = `You are an SAP EWM certification exam writer. Generate a mock
test as STRICT JSON only — no markdown code fences, no prose before or after, just the JSON
object. It must match exactly this shape:
{
  "mcq": [
    { "question": string, "options": [string, string, string, string], "correctIndex": 0-3, "explanation": string }
    // exactly 5 items
  ],
  "open": [
    { "question": string, "gradingNotes": string }
    // exactly 2 items
  ]
}
Cover practical, conceptual SAP EWM topics appropriate to the given level — wave management,
putaway/putaway strategies, storage bin determination, RF framework, batch management, cross
docking, physical inventory, exception handling, and integration points with MM/SD where
relevant. "gradingNotes" on each open question should describe, for a human or AI grader, what a
strong answer covers — it is never shown to the candidate. Output ONLY the JSON object, nothing
else.`;

function buildMockTestPrompt({ sapModule, level }) {
  return [
    `Candidate's target SAP module: ${sapModule || "EWM"}`,
    `Candidate's level: ${level || "Advance"}`,
    "Generate exactly 5 multiple-choice questions and 2 open-ended questions per the schema, calibrated to this level.",
  ].join("\n");
}

const GRADING_SYSTEM_PROMPT = `You are grading a candidate's open-ended SAP EWM mock-interview
answers. You will be given, for each item, the question, grading notes describing what a strong
answer covers, and the candidate's actual answer. Output STRICT JSON only — no markdown fences,
no prose — matching exactly this shape:
{ "results": [ { "score": 0-10 integer, "feedback": "one or two sentence string" }, ... ] }
Return exactly one result per item, in the same order given. Score based on how well the answer
covers the grading notes: a blank, empty, or entirely irrelevant answer scores 0-1. Be fair but
rigorous — this is a mock certification exam, not a participation grade. Output ONLY the JSON
object.`;

function buildGradingPrompt(items) {
  return items
    .map(
      (item, i) =>
        `${i + 1}. Question: ${item.question}\n   Grading notes (what a strong answer covers): ${
          item.gradingNotes || "general accuracy and completeness"
        }\n   Candidate's answer: ${item.answer?.trim() || "(no answer given)"}`
    )
    .join("\n\n");
}

// Extracts a JSON object from a model response even when it wraps the JSON
// in markdown fences or adds a stray sentence around it — small, cheap
// free-tier models don't always follow "output ONLY the JSON" perfectly.
export function extractJson(text) {
  const trimmed = (text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the regex extraction below
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // fall through to the throw below
    }
  }
  throw new Error("Could not parse JSON from the model's response.");
}

// --- Shared OpenRouter plumbing ----------------------------------------------

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

async function callOpenRouter(model, { systemPrompt, userPrompt, temperature }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const referer = (process.env.FRONTEND_URL || "https://scm-cloudboo-cpa.vercel.app").split(",")[0].trim();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-Title": "SCM Cloudbook",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: temperature ?? 0.4,
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

// Tries each candidate model in order, falling through to the next one on a
// "this model, right now" failure (see shouldTryNextModel), and returns
// whichever model actually answered alongside its raw text content.
async function withModelFallback(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY isn't set on the backend.");
  }

  let lastError;
  for (const model of CANDIDATE_MODELS) {
    try {
      const content = await callOpenRouter(model, prompt);
      return { content, model };
    } catch (err) {
      lastError = err;
      if (shouldTryNextModel(err.status, err.bodyText)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `All configured free models are unavailable right now (last error: ${lastError?.message}). ` +
      `Check https://openrouter.ai/models?max_price=0 for currently-free models and update FALLBACK_MODELS in lib/openrouter.js.`
  );
}

export async function generateResume(fields) {
  const { content, model } = await withModelFallback({
    systemPrompt: RESUME_SYSTEM_PROMPT,
    userPrompt: buildResumePrompt(fields),
    temperature: 0.4,
  });
  return { content, model };
}

// Returns the raw model text — the caller (routes/mockTest.js) parses and
// validates it with extractJson(), since that's where the retry-on-bad-shape
// decision belongs, not this generic transport layer.
export async function generateMockTestQuestions({ sapModule, level }) {
  const { content, model } = await withModelFallback({
    systemPrompt: MOCK_TEST_SYSTEM_PROMPT,
    userPrompt: buildMockTestPrompt({ sapModule, level }),
    temperature: 0.6,
  });
  return { raw: content, model };
}

export async function gradeOpenAnswers(items) {
  const { content, model } = await withModelFallback({
    systemPrompt: GRADING_SYSTEM_PROMPT,
    userPrompt: buildGradingPrompt(items),
    temperature: 0.2,
  });
  return { raw: content, model };
}