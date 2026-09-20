import Razorpay from "razorpay";

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  throw new Error(
    "Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET. Copy .env.example to .env and fill them in (or set them in Railway's Variables tab)."
  );
}

export const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

// Credit packages on offer. Amounts are placeholders — adjust the pricing to
// whatever SCM Cloudbook wants to charge; nothing else needs to change since
// the frontend just reads whatever packages this object exposes.
export const CREDIT_PACKAGES = {
  pack_5: { credits: 5, amountInr: 99 },
  pack_15: { credits: 15, amountInr: 249 },
  pack_50: { credits: 50, amountInr: 699 },
};
