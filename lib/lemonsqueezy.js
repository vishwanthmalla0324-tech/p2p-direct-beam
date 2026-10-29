import crypto from "node:crypto";
import { lemonSqueezySetup, createCheckout } from "@lemonsqueezy/lemonsqueezy.js";

/**
 * Direct Beam Lemon Squeezy Client & Cryptographic Signature Utilities
 * (Live Production Mode)
 * Supports hosted checkouts, signed HMAC-SHA256 webhook verification, and user entitlements.
 */

let initializedApiKey = null;

/**
 * Reads configuration from Cloudflare env bindings or process.env
 */
export function getLemonSqueezyConfig(env = {}) {
  const apiKey =
    env.LEMONSQUEEZY_API_KEY ||
    process.env.LEMONSQUEEZY_API_KEY ||
    "";

  const storeId =
    env.LEMONSQUEEZY_STORE_ID ||
    process.env.LEMONSQUEEZY_STORE_ID ||
    "";

  const webhookSecret =
    env.LEMONSQUEEZY_WEBHOOK_SECRET ||
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET ||
    "";

  const variantId =
    env.LEMONSQUEEZY_VARIANT_ID ||
    process.env.LEMONSQUEEZY_VARIANT_ID ||
    "";

  const appUrl =
    env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://directbeam.space";

  return { apiKey, storeId, webhookSecret, variantId, appUrl };
}

/**
 * Initialize Lemon Squeezy SDK instance
 */
export function initLemonSqueezy(apiKey) {
  if (apiKey && apiKey !== initializedApiKey) {
    lemonSqueezySetup({ apiKey });
    initializedApiKey = apiKey;
  }
}

/**
 * Verifies Lemon Squeezy Webhook signature using raw body HMAC-SHA256.
 * Lemon Squeezy signs webhooks with HMAC-SHA256 and provides the hex digest in 'x-signature'.
 */
export function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!rawBody || !signature || !webhookSecret) {
    return false;
  }

  const rawString = typeof rawBody === "string" ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(rawBody);

  const hmac = crypto.createHmac("sha256", webhookSecret);
  const digest = hmac.update(rawString).digest("hex");

  try {
    const expectedBuf = Buffer.from(digest, "utf8");
    const receivedBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== receivedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return digest === signature;
  }
}

/**
 * Generates an HMAC-SHA256 signature for test suite verification.
 */
export function generateWebhookSignature(rawBody, webhookSecret) {
  if (!rawBody || !webhookSecret) return "";
  const rawString = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
  return crypto.createHmac("sha256", webhookSecret).update(rawString).digest("hex");
}

/**
 * Creates a Lemon Squeezy checkout session using the official SDK or REST API.
 */
export async function createLemonCheckout({
  apiKey,
  storeId,
  variantId,
  userId,
  userEmail,
  userName,
  redirectUrl
}) {
  if (!apiKey || !storeId || !variantId) {
    throw new Error("Missing Lemon Squeezy configuration (API Key, Store ID, or Variant ID)");
  }

  initLemonSqueezy(apiKey);

  const checkoutPayload = {
    checkoutOptions: {
      embed: false,
      media: true,
      logo: true
    },
    checkoutData: {
      email: userEmail || undefined,
      name: userName || undefined,
      custom: {
        user_id: String(userId)
      }
    },
    productOptions: {
      redirectUrl: redirectUrl || "https://directbeam.space/?payment=success",
      receiptButtonText: "Return to Direct Beam",
      receiptThankYouNote: "Thank you for upgrading to Direct Beam Pro Lifetime!"
    }
  };

  try {
    // Attempt with official SDK
    const response = await createCheckout(storeId, variantId, checkoutPayload);
    if (response?.error) {
      throw new Error(response.error.message || "Failed to create checkout via Lemon Squeezy SDK");
    }
    const checkoutUrl = response?.data?.data?.attributes?.url;
    if (checkoutUrl) {
      return { checkoutUrl, data: response.data.data };
    }
  } catch (sdkErr) {
    // Fallback direct REST API call for non-standard environments (e.g. edge runtimes)
    console.warn("[Lemon Squeezy SDK notice, using REST API]:", sdkErr.message);
  }

  // Direct REST API fallback
  const res = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json"
    },
    body: JSON.stringify({
      data: {
        type: "checkouts",
        relationships: {
          store: {
            data: {
              type: "stores",
              id: String(storeId)
            }
          },
          variant: {
            data: {
              type: "variants",
              id: String(variantId)
            }
          }
        },
        attributes: {
          checkout_options: checkoutPayload.checkoutOptions,
          checkout_data: checkoutPayload.checkoutData,
          product_options: checkoutPayload.productOptions
        }
      }
    })
  });

  const body = await res.json();
  if (!res.ok) {
    const errMsg = body?.errors?.[0]?.detail || body?.message || "Failed to create Lemon Squeezy checkout";
    throw new Error(errMsg);
  }

  const checkoutUrl = body?.data?.attributes?.url;
  return { checkoutUrl, data: body.data };
}

export default {
  getLemonSqueezyConfig,
  initLemonSqueezy,
  verifyWebhookSignature,
  generateWebhookSignature,
  createLemonCheckout
};
