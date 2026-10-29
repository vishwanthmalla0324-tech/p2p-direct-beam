import crypto from "node:crypto";
import { handlePaymentRequest } from "../src/payments.js";
import { verifyWebhookSignature, generateWebhookSignature } from "../lib/lemonsqueezy.js";

async function runLemonSqueezyTests() {
  console.log("=== STARTING LEMON SQUEEZY INTEGRATION & SECURITY FLOW TESTS ===");

  const memoryKV = new Map();
  const mockKV = {
    async get(key, type = "text") {
      const val = memoryKV.get(key);
      if (!val) return null;
      if (type === "json") {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },
    async put(key, val, options = {}) {
      memoryKV.set(key, typeof val === "string" ? val : JSON.stringify(val));
    },
    async delete(key) {
      memoryKV.delete(key);
    }
  };

  const TEST_API_KEY = "ls_live_test_ApiKeyDirectBeam999";
  const TEST_STORE_ID = "store_123456";
  const TEST_VARIANT_ID = "variant_789012";
  const TEST_WEBHOOK_SECRET = "whsec_live_WebhookSecret_DirectBeam_987654321";

  const mockEnv = {
    USERS_KV: mockKV,
    LEMONSQUEEZY_API_KEY: TEST_API_KEY,
    LEMONSQUEEZY_STORE_ID: TEST_STORE_ID,
    LEMONSQUEEZY_VARIANT_ID: TEST_VARIANT_ID,
    LEMONSQUEEZY_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    NEXT_PUBLIC_APP_URL: "https://directbeam.space"
  };

  // Seed a test user and session in database
  const testUser = {
    id: "usr_lemontest01",
    email: "paytester@directbeam.space",
    name: "Lemon Squeezy Tester",
    transfersCount: 3,
    plan: "FREE",
    isPro: false,
    pro: false
  };
  const testSessionToken = "test_token_lemon_abc123";
  await mockKV.put(`user:${testUser.email}`, JSON.stringify(testUser));
  await mockKV.put(`session:${testSessionToken}`, JSON.stringify({ userId: testUser.id, email: testUser.email }));

  // [Test 1] Cryptographic HMAC-SHA256 Signature Verification
  console.log("\n[Test 1] Testing HMAC-SHA256 signature verification utilities...");
  const samplePayload = JSON.stringify({
    meta: { event_name: "order_created" },
    data: { id: "order_1001", attributes: { total: 2900, status: "paid" } }
  });
  const validSig = generateWebhookSignature(samplePayload, TEST_WEBHOOK_SECRET);
  console.log("Generated HMAC signature:", validSig);

  const isValidPass = verifyWebhookSignature(samplePayload, validSig, TEST_WEBHOOK_SECRET);
  if (!isValidPass) throw new Error("Expected valid webhook signature to verify successfully!");

  const isTamperedFail = verifyWebhookSignature(samplePayload, "tampered_fake_signature_hash", TEST_WEBHOOK_SECRET);
  if (isTamperedFail) throw new Error("Tampered signature must be rejected!");
  console.log("✓ Signature verification passed with timing-safe HMAC checks.");

  // [Test 2] Public Lemon Squeezy Payment Config Endpoint
  console.log("\n[Test 2] Testing GET /api/payments/config...");
  const configReq = new Request("https://directbeam.space/api/payments/config", { method: "GET" });
  const configRes = await handlePaymentRequest(configReq, mockEnv);
  const configData = await configRes.json();
  console.log("Config response:", configData);
  if (configData.storeId !== TEST_STORE_ID || configData.variantId !== TEST_VARIANT_ID || configData.currency !== "USD") {
    throw new Error("Invalid Lemon Squeezy payment config returned");
  }
  console.log("✓ Config verified: storeId, variantId, and USD currency.");

  // [Test 3] Create Checkout Endpoint without Authentication (Security Guard)
  console.log("\n[Test 3] Testing POST /api/payments/create-checkout without auth...");
  const unauthReq = new Request("https://directbeam.space/api/payments/create-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "pro_lifetime" })
  });
  const unauthRes = await handlePaymentRequest(unauthReq, mockEnv);
  if (unauthRes.status !== 401) {
    throw new Error("Expected 401 Unauthorized for unauthenticated checkout creation");
  }
  console.log("✓ Unauthenticated request rejected with HTTP 401.");

  // [Test 4] Create Checkout Endpoint with Valid Authentication
  console.log("\n[Test 4] Testing POST /api/payments/create-checkout with authenticated user...");
  const checkoutReq = new Request("https://directbeam.space/api/payments/create-checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${testSessionToken}`
    },
    body: JSON.stringify({ plan: "pro_lifetime" })
  });
  const checkoutRes = await handlePaymentRequest(checkoutReq, mockEnv);
  const checkoutData = await checkoutRes.json();
  console.log("Checkout creation response:", checkoutData);
  if (checkoutRes.status !== 200 || !checkoutData.checkoutUrl || !checkoutData.success) {
    throw new Error("Failed to create valid Lemon Squeezy checkout session");
  }
  console.log("✓ Checkout URL successfully generated:", checkoutData.checkoutUrl);

  // [Test 5] Reject Webhook with Missing Signature Header
  console.log("\n[Test 5] Testing POST /api/webhooks/lemonsqueezy with missing x-signature header...");
  const noSigReq = new Request("https://directbeam.space/api/webhooks/lemonsqueezy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: samplePayload
  });
  const noSigRes = await handlePaymentRequest(noSigReq, mockEnv);
  if (noSigRes.status !== 401) {
    throw new Error("Expected 401 for webhook request with missing x-signature");
  }
  console.log("✓ Missing signature properly aborted with HTTP 401.");

  // [Test 6] Reject Webhook with Forged / Invalid Signature
  console.log("\n[Test 6] Testing POST /api/webhooks/lemonsqueezy with forged signature...");
  const badSigReq = new Request("https://directbeam.space/api/webhooks/lemonsqueezy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": "forged_attack_signature_vector_12345"
    },
    body: samplePayload
  });
  const badSigRes = await handlePaymentRequest(badSigReq, mockEnv);
  if (badSigRes.status !== 401) {
    throw new Error("Expected 401 for forged webhook signature");
  }
  console.log("✓ Forged signature strictly rejected with HTTP 401.");

  // [Test 7] Process Verified Webhook (order_created, status: paid)
  console.log("\n[Test 7] Testing POST /api/webhooks/lemonsqueezy (order_created event)...");
  const webhookEventPayload = JSON.stringify({
    meta: {
      event_name: "order_created",
      custom_data: {
        user_id: testUser.id
      }
    },
    data: {
      id: "ls_order_99887766",
      type: "orders",
      attributes: {
        store_id: 123456,
        customer_id: 554433,
        user_email: testUser.email,
        user_name: testUser.name,
        currency: "USD",
        total: 2900,
        status: "paid",
        created_at: new Date().toISOString(),
        first_order_item: {
          variant_id: 789012
        }
      }
    }
  });

  const validWebhookSig = generateWebhookSignature(webhookEventPayload, TEST_WEBHOOK_SECRET);
  const webhookReq = new Request("https://directbeam.space/api/webhooks/lemonsqueezy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature": validWebhookSig
    },
    body: webhookEventPayload
  });

  const webhookRes = await handlePaymentRequest(webhookReq, mockEnv);
  const webhookData = await webhookRes.json();
  console.log("Webhook processing response:", webhookData);
  if (webhookRes.status !== 200 || !webhookData.received) {
    throw new Error("Webhook processing failed!");
  }

  // [Test 8] Verify User Tier Entitlement Upgrade in Database
  console.log("\n[Test 8] Verifying User database record after webhook processing...");
  const upgradedUser = await mockKV.get(`user:${testUser.email}`, "json");
  console.log("Upgraded user record:", upgradedUser);

  if (!upgradedUser.isPro || !upgradedUser.pro || upgradedUser.plan !== "LIFETIME_PRO") {
    throw new Error("User was not properly upgraded to LIFETIME_PRO tier!");
  }
  if (!upgradedUser.lemonSqueezyOrderId || !upgradedUser.lemonSqueezyCustomerId || !upgradedUser.proActivatedAt) {
    throw new Error("Lemon Squeezy order/customer attributes missing from user record!");
  }
  console.log("✓ User successfully upgraded to LIFETIME_PRO with lemonSqueezyOrderId & customerId.");

  // [Test 9] Verify Payment Audit Record in Database
  console.log("\n[Test 9] Verifying Payment audit record in database...");
  const paymentRecord = await mockKV.get(`payment:ls_order_99887766`, "json");
  console.log("Payment audit record:", paymentRecord);

  if (!paymentRecord || paymentRecord.status !== "paid" || paymentRecord.amount !== 2900 || paymentRecord.currency !== "USD") {
    throw new Error("Payment record is missing or contains incorrect attributes!");
  }
  console.log("✓ Payment audit record successfully persisted in KV.");

  // [Test 10] Already-Pro User Guard on Checkout Endpoint
  console.log("\n[Test 10] Testing checkout creation for already-pro user...");
  const alreadyProReq = new Request("https://directbeam.space/api/payments/create-checkout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${testSessionToken}`
    },
    body: JSON.stringify({ plan: "pro_lifetime" })
  });
  const alreadyProRes = await handlePaymentRequest(alreadyProReq, mockEnv);
  const alreadyProData = await alreadyProRes.json();
  if (alreadyProRes.status !== 400 || !alreadyProData.alreadyPro) {
    throw new Error("Expected 400 with alreadyPro flag when Pro user requests checkout");
  }
  console.log("✓ Already Pro account properly protected from double-charging.");

  console.log("\n✅ ALL 10 LEMON SQUEEZY TESTS PASSED WITH 100% SUCCESS!");
}

runLemonSqueezyTests().catch((err) => {
  console.error("\n❌ LEMON SQUEEZY TEST SUITE FAILED:", err);
  process.exit(1);
});
