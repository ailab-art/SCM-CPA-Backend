# SCM Cloudbook — Resume Generator & Credits Backend

Standalone Node.js/Express service, deployed on Railway, separate from the
Next.js frontend on Vercel. It talks to the same Supabase database as the
frontend (via the service-role key) and does three jobs:

1. Generates a resume with a free OpenRouter model, spending one credit per
   generation.
2. Sells more credits through Razorpay.
3. Gives admins a credits-usage view, and lets the **master admin only**
   grant/adjust a student's credit balance.

Run `supabase/add-resume-credits.sql` (or the updated `supabase/schema.sql`)
in the Supabase SQL editor **before** deploying this — the tables and
columns below don't exist until you do. Also run
`supabase/add-experience-education.sql` — it adds the `experience`/
`education` columns that `POST /api/resume/generate` now requires to be
filled in before it will generate anything.

## Why a separate backend at all

`is_admin` / `is_master_admin` / `credits_remaining` / `credits_used` /
`credits_purchased` on `profiles` are protected by a Postgres trigger
(`protect_privileged_columns`) that reverts any change to those columns
unless the request is running as Supabase's service-role key. The frontend
never holds that key — only this backend does — so crediting, spending, and
granting credits can only ever happen through routes here, never by a
student patching their own row from the browser.

## Environment variables

Copy `.env.example` to `.env` for local dev; on Railway, set the same names
under **Variables**.

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Same Supabase project as the frontend's `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` (secret) key |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `OPENROUTER_MODEL` | Defaults to `meta-llama/llama-3.3-70b-instruct:free`. OpenRouter's free-model lineup changes over time — check https://openrouter.ai/models (filter: Free) and update this one variable if the default ever stops working. No code change needed either way. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay dashboard → Settings → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay dashboard → Settings → Webhooks, after you add this backend's webhook URL (see below) |
| `FRONTEND_URL` | Your deployed frontend origin(s), comma-separated. Used for CORS and as OpenRouter's required `HTTP-Referer` |
| `PORT` | Railway sets this automatically — the `.env.example` value is only for local dev |

**A note on payments**: the request that chose "wire up a real payment
gateway now" didn't name a specific provider, and SCM Cloudbook operates out
of India, so this backend is built against **Razorpay** as the most natural
fit. If that's not the right choice, only `lib/razorpay.js`, `routes/credits.js`,
and `routes/webhooks.js` would need to change — nothing else in this backend
or the frontend assumes Razorpay by name outside those three files.

Start with Razorpay's **test mode** keys (dashboard toggle, top-right) so you
can run through a full purchase without moving real money, then switch to
live keys once you're ready.

## Local development

```bash
npm install
cp .env.example .env   # fill in the values above
npm run dev             # listens on http://localhost:8080
```

## Deploying on Railway

1. Push this folder to its own GitHub repo (it's a separate service from the
   frontend — don't nest it inside `SCM_Cloudboo_CPA`):
   ```bash
   cd scm-cloudbook-backend
   git init
   git add .
   git commit -m "Resume generator + credits backend"
   git branch -M main
   git remote add origin https://github.com/ailab-art/SCM_Cloudbook_CPA_Backend.git
   git push -u origin main
   ```
   (Create that empty repo on GitHub first — same account, new repo name.)
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo you
   just pushed.
3. Railway auto-detects Node from `package.json` and runs `npm install` then
   `npm start`. No `Procfile` or build step needed.
4. Add every variable from the table above under the service's **Variables**
   tab. Leave `PORT` alone — Railway injects its own.
5. Once deployed, Railway gives you a public URL like
   `https://scm-cloudbook-backend-production.up.railway.app`. Copy it.
6. Razorpay dashboard → Settings → Webhooks → add
   `<that Railway URL>/api/webhooks/razorpay`, subscribe to `payment.captured`
   and `order.paid`, save, then copy the **Webhook Secret** it shows you into
   `RAZORPAY_WEBHOOK_SECRET` on Railway.
7. In the frontend's Vercel project, add an env var
   `NEXT_PUBLIC_RESUME_API_URL` set to that same Railway URL (no trailing
   slash), then redeploy the frontend — see the frontend README's "Resume
   generator backend" section.
8. Sanity check: `curl https://<your-railway-url>/health` should return
   `{"ok":true}`.

## API summary

All routes except `/health` and `/api/webhooks/razorpay` require
`Authorization: Bearer <supabase access token>` (the frontend already has
this from `supabase.auth.getSession()`).

- `POST /api/resume/generate` — body: `{ fullName, level, sapModule, yearsExperience, currentTitle, skills, summary }`. Requires the caller's profile to already have at least one real (non-blank) entry in both `experience` and `education` (see `supabase/add-experience-education.sql`) — otherwise returns `400 { code: "PROFILE_INCOMPLETE" }` before spending a credit. Otherwise spends 1 credit, returns `{ content, creditsRemaining }`, or `402 { code: "NO_CREDITS" }` when out of credits. The student's `experience`/`education` (from their profile, not the request body) are woven into the generated resume.
- `GET /api/credits/me` — `{ creditsRemaining, creditsUsed, creditsPurchased }`.
- `GET /api/credits/packages` — the credit packages on offer (edit `lib/razorpay.js` to change pricing).
- `POST /api/credits/checkout` — body: `{ packageId }`. Opens a Razorpay order, returns `{ orderId, amount, currency, keyId }` for Razorpay Checkout.
- `POST /api/credits/verify` — body: the three `razorpay_*` fields Checkout's success callback gives you. Verifies the signature and credits the account.
- `POST /api/webhooks/razorpay` — Razorpay calls this directly; not for the frontend to call.
- `GET /api/admin/credits` — any admin: every student's credit usage.
- `POST /api/admin/credits/grant` — **master admin only**. Body: `{ userId, amount, note? }`. `amount` can be negative to deduct.