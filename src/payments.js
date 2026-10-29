import {
  getLemonSqueezyConfig,
  verifyWebhookSignature,
  createLemonCheckout
} from "../lib/lemonsqueezy.js";

/**
 * Direct Beam Lemon Squeezy Payment Route Controllers
 * Endpoints:
 *   - POST /api/payments/create-checkout
 *   - POST /api/webhooks/lemonsqueezy
 *   - GET  /api/payments/config
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Signature",
  "Access-Control-Max-Age": "86400"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}

function extractToken(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookie = request.headers.get("Cookie");
  if (cookie) {
    const match = cookie.match(/direct_beam_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// In-memory fallback if USERS_KV binding is missing
const fallbackKV = new Map();
function getKV(env) {
  if (env && env.USERS_KV) return env.USERS_KV;
  return {
    async get(key, type = "text") {
      const val = fallbackKV.get(key);
      if (!val) return null;
      if (type === "json") {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },
    async put(key, val) {
      fallbackKV.set(key, typeof val === "string" ? val : JSON.stringify(val));
    },
    async delete(key) {
      fallbackKV.delete(key);
    }
  };
}

export async function handlePaymentRequest(request, env = {}) {
  const url = new URL(request.url);
  const kv = getKV(env);
  const config = getLemonSqueezyConfig(env);

  // 1. CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  // 2. Public config endpoint
  if (url.pathname === "/api/payments/config" && request.method === "GET") {
    return jsonResponse({
      storeId: config.storeId || null,
      variantId: config.variantId || null,
      currency: "USD",
      planName: "Direct Beam Pro Lifetime"
    });
  }

  // 3. Create Checkout API Endpoint (POST /api/payments/create-checkout or POST /api/create-checkout)
  if (
    (url.pathname === "/api/payments/create-checkout" ||
     url.pathname === "/api/create-checkout" ||
     url.pathname === "/api/payments/create-order") &&
    request.method === "POST"
  ) {
    try {
      const token = extractToken(request);
      if (!token) {
        return jsonResponse({ error: "Authentication required. Please sign in to upgrade." }, 401);
      }

      const session = await kv.get(`session:${token}`, "json");
      if (!session || !session.email) {
        return jsonResponse({ error: "Session invalid or expired. Please sign in again." }, 401);
      }

      const user = await kv.get(`user:${session.email.toLowerCase()}`, "json");
      if (!user) {
        return jsonResponse({ error: "User account not found." }, 404);
      }

      if (user.pro || user.isPro || user.plan === "LIFETIME_PRO") {
        return jsonResponse({
          error: "Your account is already upgraded to Direct Beam Pro Lifetime!",
          alreadyPro: true
        }, 400);
      }

      const redirectUrl = `${config.appUrl}/?payment=success`;

      let checkoutUrl;
      if (
        config.apiKey &&
        config.storeId &&
        config.variantId &&
        !config.apiKey.includes("placeholder") &&
        !config.apiKey.includes("test_")
      ) {
        const checkoutResult = await createLemonCheckout({
          apiKey: config.apiKey,
          storeId: config.storeId,
          variantId: config.variantId,
          userId: user.id,
          userEmail: user.email,
          userName: user.name,
          redirectUrl
        });
        checkoutUrl = checkoutResult.checkoutUrl;
      } else {
        // Fallback for local testing / mock test environment
        checkoutUrl = `https://directbeam.lemonsqueezy.com/checkout/buy/mock-checkout-${user.id}?checkout[custom][user_id]=${user.id}&checkout[email]=${encodeURIComponent(user.email)}`;
      }

      return jsonResponse({
        success: true,
        checkoutUrl
      }, 200);
    } catch (err) {
      console.error("[Lemon Squeezy create-checkout error]:", err);
      return jsonResponse({ error: "Failed to create checkout: " + (err.message || "") }, 500);
    }
  }

  // 4. Secure Webhook Handler (POST /api/webhooks/lemonsqueezy)
  if (
    (url.pathname === "/api/webhooks/lemonsqueezy" || url.pathname === "/api/webhooks/lemon-squeezy") &&
    request.method === "POST"
  ) {
    try {
      const signature = request.headers.get("x-signature");
      const rawBody = await request.text();

      // Crucial: Validate x-signature header against LEMONSQUEEZY_WEBHOOK_SECRET
      if (!signature) {
        console.warn("[Lemon Squeezy Webhook] Missing x-signature header.");
        return jsonResponse({ error: "Missing x-signature header" }, 401);
      }

      const webhookSecret = config.webhookSecret;
      if (!webhookSecret) {
        console.error("[Lemon Squeezy Webhook] LEMONSQUEEZY_WEBHOOK_SECRET is not configured.");
        return jsonResponse({ error: "Webhook secret not configured" }, 500);
      }

      const isValid = verifyWebhookSignature(rawBody, signature, webhookSecret);
      if (!isValid) {
        console.warn("[Lemon Squeezy Webhook] Signature verification failed.");
        return jsonResponse({ error: "Invalid webhook signature" }, 401);
      }

      let eventData;
      try {
        eventData = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: "Malformed webhook payload" }, 400);
      }

      const eventName = eventData?.meta?.event_name;
      console.log(`[Lemon Squeezy Webhook] Verified event received: ${eventName}`);

      // Handle order_created event
      if (eventName === "order_created") {
        const orderAttributes = eventData?.data?.attributes;
        const orderId = String(eventData?.data?.id);
        const status = orderAttributes?.status; // "paid", "pending", etc.

        if (status === "paid") {
          const userId = eventData?.meta?.custom_data?.user_id;
          const customerEmail = (orderAttributes?.user_email || "").toLowerCase().trim();
          const customerId = String(orderAttributes?.customer_id || "");
          const variantId = String(orderAttributes?.first_order_item?.variant_id || config.variantId || "");
          const totalAmount = orderAttributes?.total || 0; // in cents
          const currency = orderAttributes?.currency || "USD";

          // Locate user by userId or email
          let targetUser = null;
          let targetEmail = customerEmail;

          if (userId) {
            // Check in KV store if indexed by id or scan user email
            if (targetEmail) {
              targetUser = await kv.get(`user:${targetEmail}`, "json");
            }
            if (!targetUser) {
              const sessionUser = await kv.get(`user_by_id:${userId}`, "json");
              if (sessionUser?.email) {
                targetEmail = sessionUser.email.toLowerCase();
                targetUser = await kv.get(`user:${targetEmail}`, "json");
              }
            }
          } else if (targetEmail) {
            targetUser = await kv.get(`user:${targetEmail}`, "json");
          }

          if (targetUser && targetEmail) {
            // Update User Entity
            targetUser.isPro = true;
            targetUser.pro = true;
            targetUser.plan = "LIFETIME_PRO";
            targetUser.lemonSqueezyCustomerId = customerId;
            targetUser.lemonSqueezyOrderId = orderId;
            targetUser.proActivatedAt = new Date().toISOString();
            await kv.put(`user:${targetEmail}`, JSON.stringify(targetUser));
            console.log(`[Lemon Squeezy Webhook] User ${targetEmail} upgraded to LIFETIME_PRO`);
          }

          // Record Order/Payment Entity
          const paymentRecord = {
            orderId,
            customerId,
            variantId,
            userId: userId || targetUser?.id || null,
            email: targetEmail,
            amount: totalAmount,
            currency,
            status: "paid",
            createdAt: orderAttributes?.created_at || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          await kv.put(`payment:${orderId}`, JSON.stringify(paymentRecord));
        }
      }

      return jsonResponse({ received: true, status: "ok" }, 200);
    } catch (err) {
      console.error("[Lemon Squeezy Webhook Error]:", err);
      return jsonResponse({ error: "Webhook handling failed: " + (err.message || "") }, 500);
    }
  }

  return null;
}

export default {
  handlePaymentRequest
};
