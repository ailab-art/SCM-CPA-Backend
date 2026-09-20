const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

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

export async function generateResume(fields) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY isn't set on the backend.");
  }

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
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(fields) },
      ],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter returned ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter returned an empty response.");
  }
  return { content, model: OPENROUTER_MODEL };
}
