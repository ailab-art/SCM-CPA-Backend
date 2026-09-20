import { Router } from "express";
import crypto from "node:crypto";
import { requireAuth } from "../lib/auth.js";
import { supabase } from "../lib/supabase.js";
import { razorpay, CREDIT_PACKAGES } from "../lib/razorpay.js";

const router = Router();

router.get("/me", requireAuth, (req, res) => {
  res.json({
    creditsRemaining: req.profile.credits_remaining,
    creditsUsed: req.profile.credits_used,
    creditsPurchased: req.profile.credits_purchased,
  });
});

router.get("/packages", requireAuth, (_req, res) => {
  res.json({ packages: CREDIT_PACKAGES });
});

// Step 1 of a purchase: open a Razorpay order and record it as 'created'.
// The frontend takes the returned order id + key id and opens Razorpay's
// Checkout widget with them.
router.post("/checkout", requireAuth, async (req, res) => {
  const { packageId } = req.body || {};
  const pack = CREDIT_PACKAGES[packageId];
  if (!pack) {
    return res.status(400).json({ error: "Unknown credit package." });
  }

  let order;
  try {
    order = await razorpay.orders.create({
      amount: pack.amountInr * 100, // paise
      currency: "INR",
      notes: { userId: req.user.id, credits: String(pack.credits) },
    });
  } catch (err) {
    return res.status(502).json({ error: `Razorpay order creation failed: ${err.message}` });
  }

  const { error: insertError } = await supabase.from("credit_payments").insert({
    user_id: req.user.id,
    order_id: order.id,
    amount_inr: pack.amountInr,
    credits: pack.credits,
    status: "created",
  });
  if (insertError) {
    return res.status(500).json({ error: insertError.message });
  }

  res.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
  });
});

// Step 2, called by the frontend right after Razorpay Checkout's success
// callback fires. This is a convenience path so the student sees their new
// balance immediately — /api/webhooks/razorpay is the source of truth that
// still credits the account even if the browser tab closes before this
// call goes out.
router.post("/verify", requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing Razorpay payment fields." });
  }

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: "Payment signature verification failed." });
  }

  const result = await creditPaymentIfUnpaid({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    expectedUserId: req.user.id,
  });
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json({ ok: true, alreadyProcessed: result.alreadyProcessed ?? false, creditsRemaining: result.creditsRemaining });
});

// Shared by /verify and the webhook so a payment is only ever credited once,
// however this backend first finds out about it.
export async function creditPaymentIfUnpaid({ orderId, paymentId, expectedUserId }) {
  const { data: payment, error: fetchError } = await supabase
    .from("credit_payments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (fetchError) return { error: fetchError.message, status: 500 };
  if (!payment) return { error: "Payment record not found.", status: 404 };
  if (expectedUserId && payment.user_id !== expectedUserId) {
    return { error: "This payment doesn't belong to the signed-in account.", status: 403 };
  }
  if (payment.status === "paid") {
    return { alreadyProcessed: true, creditsRemaining: null };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("credits_remaining, credits_purchased")
    .eq("id", payment.user_id)
    .maybeSingle();
  if (profileError || !profile) return { error: profileError?.message || "Profile not found.", status: 500 };

  const { error: updatePaymentError } = await supabase
    .from("credit_payments")
    .update({ status: "paid", payment_id: paymentId })
    .eq("order_id", orderId)
    .eq("status", "created"); // guards against a race with a second caller
  if (updatePaymentError) return { error: updatePaymentError.message, status: 500 };

  const newRemaining = profile.credits_remaining + payment.credits;
  const { error: updateProfileError } = await supabase
    .from("profiles")
    .update({
      credits_remaining: newRemaining,
      credits_purchased: profile.credits_purchased + payment.credits,
    })
    .eq("id", payment.user_id);
  if (updateProfileError) return { error: updateProfileError.message, status: 500 };

  await supabase.from("credit_ledger").insert({
    user_id: payment.user_id,
    delta: payment.credits,
    reason: "purchase",
    note: `Razorpay order ${orderId}`,
  });

  return { alreadyProcessed: false, creditsRemaining: newRemaining };
}

export default router;
