import { Router } from "express";
import crypto from "node:crypto";
import { creditPaymentIfUnpaid } from "./credits.js";

const router = Router();

// Mounted with express.raw() in server.js (not express.json()) — Razorpay's
// signature is computed over the exact raw request body, so it has to be
// verified before any JSON parsing/re-serialization touches it.
router.post("/razorpay", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is not set — rejecting webhook.");
    return res.status(500).send("Webhook secret not configured.");
  }

  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!signature || signature !== expected) {
    return res.status(400).send("Invalid signature.");
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON.");
  }

  if (event.event === "payment.captured" || event.event === "order.paid") {
    const payment = event.payload?.payment?.entity;
    const orderId = payment?.order_id;
    const paymentId = payment?.id;
    if (orderId && paymentId) {
      const result = await creditPaymentIfUnpaid({ orderId, paymentId });
      if (result.error) {
        console.error("Webhook crediting failed:", result.error);
      }
    }
  }

  // Always 200 once the signature checks out — Razorpay retries on non-2xx,
  // and we don't want retries for events we intentionally ignore.
  res.status(200).send("ok");
});

export default router;
