import "dotenv/config";
import express from "express";
import cors from "cors";

import resumeRoutes from "./routes/resume.js";
import creditsRoutes from "./routes/credits.js";
import webhookRoutes from "./routes/webhooks.js";
import adminRoutes from "./routes/admin.js";

const app = express();

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  })
);

// Razorpay's webhook signature is computed over the raw request body, so
// this route needs express.raw() instead of the json() parser everything
// else uses — it has to be registered before app.use(express.json()) below.
app.use("/api/webhooks", express.raw({ type: "application/json" }), webhookRoutes);

app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/api/resume", resumeRoutes);
app.use("/api/credits", creditsRoutes);
app.use("/api/admin", adminRoutes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`SCM Cloudbook backend listening on port ${port}`);
});
