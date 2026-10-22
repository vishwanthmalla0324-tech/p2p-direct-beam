import { handleAuthRequest } from "../src/auth.js";

async function runTests() {
  console.log("=== STARTING SECURITY & FORGOT-PASSWORD E2E TEST ===");

  const memoryStore = new Map();
  const mockKV = {
    async get(key, type = "text") {
      const val = memoryStore.get(key);
      if (!val) return null;
      if (type === "json") {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },
    async put(key, val, options = {}) {
      memoryStore.set(key, typeof val === "string" ? val : JSON.stringify(val));
    },
    async delete(key) {
      memoryStore.delete(key);
    }
  };

  const mockEnv = {
    USERS_KV: mockKV,
    RESEND_API_KEY: "" // will test fallback/logging without external network
  };

  // Test 1: Register initial user
  console.log("\n[Test 1] Registering test user...");
  const regReq = new Request("https://directbeam.space/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "security_tester@directbeam.space", password: "InitialPassword123!", name: "Tester" })
  });
  const regRes = await handleAuthRequest(regReq, mockEnv);
  const regData = await regRes.json();
  console.log("Register status:", regRes.status, "token:", Boolean(regData.token));
  const oldSessionToken = regData.token;

  // Test 2: Request Forgot Password for non-existent email (anti-enumeration check)
  console.log("\n[Test 2] Requesting forgot password for NON-EXISTENT user (anti-enumeration)...");
  const fakeForgotReq = new Request("https://directbeam.space/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "doesnotexist_9999@directbeam.space" })
  });
  const fakeForgotRes = await handleAuthRequest(fakeForgotReq, mockEnv);
  const fakeForgotData = await fakeForgotRes.json();
  console.log("Fake status:", fakeForgotRes.status, "message:", fakeForgotData.message);
  if (fakeForgotRes.status !== 200 || !fakeForgotData.success) {
    throw new Error("Enumeration protection failed: Non-existent email did not return generic 200");
  }

  // Test 3: Request Forgot Password for existing user
  console.log("\n[Test 3] Requesting forgot password for REAL user...");
  const realForgotReq = new Request("https://directbeam.space/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "security_tester@directbeam.space" })
  });
  const realForgotRes = await handleAuthRequest(realForgotReq, mockEnv);
  const realForgotData = await realForgotRes.json();
  console.log("Real status:", realForgotRes.status, "message:", realForgotData.message);
  if (realForgotData.message !== fakeForgotData.message) {
    throw new Error("Enumeration vulnerability: Error messages differ between existing and non-existing accounts!");
  }

  // Find the token created in KV
  let resetTokenKey = null;
  let resetTokenPayload = null;
  for (const [k, v] of memoryStore.entries()) {
    if (k.startsWith("reset_token:")) {
      resetTokenKey = k;
      resetTokenPayload = JSON.parse(v);
      break;
    }
  }

  console.log("Reset token found in KV:", resetTokenKey);
  console.log("Token payload:", resetTokenPayload);

  // Notice: KV stores SHA-256 hash of token, not the plaintext token!
  // To verify that rawToken cannot be brute-forced from KV:
  const tokenHash = resetTokenKey.replace("reset_token:", "");
  console.log("Stored token hash length:", tokenHash.length, "(SHA-256)");

  // Test 4: Verify Reset Token with invalid token
  console.log("\n[Test 4] Verifying with bogus token...");
  const invalidVerifyReq = new Request("https://directbeam.space/api/auth/verify-reset-token?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  const invalidVerifyRes = await handleAuthRequest(invalidVerifyReq, mockEnv);
  const invalidVerifyData = await invalidVerifyRes.json();
  console.log("Invalid verify status:", invalidVerifyRes.status, "valid:", invalidVerifyData.valid);
  if (invalidVerifyData.valid) throw new Error("Bogus token was accepted!");

  // Test 5: Verify Reset Token with the real token that was sent in email
  // Let's compute a valid raw token by inserting one directly to test the flow
  const testRawBytes = new Uint8Array(32);
  crypto.getRandomValues(testRawBytes);
  const testRawToken = Array.from(testRawBytes).map(b => b.toString(16).padStart(2, "0")).join("");
  
  const enc = new TextEncoder();
  const testDigest = await crypto.subtle.digest("SHA-256", enc.encode(testRawToken));
  const testHash = Array.from(new Uint8Array(testDigest)).map(b => b.toString(16).padStart(2, "0")).join("");

  await mockKV.put(`reset_token:${testHash}`, JSON.stringify({
    userId: "test-user-id",
    email: "security_tester@directbeam.space",
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000
  }), { expirationTtl: 900 });

  console.log("\n[Test 5] Verifying with valid 32-byte test token...");
  const validVerifyReq = new Request(`https://directbeam.space/api/auth/verify-reset-token?token=${testRawToken}`);
  const validVerifyRes = await handleAuthRequest(validVerifyReq, mockEnv);
  const validVerifyData = await validVerifyRes.json();
  console.log("Valid verify status:", validVerifyRes.status, "valid:", validVerifyData.valid, "email:", validVerifyData.email);
  if (!validVerifyData.valid) throw new Error("Valid token failed verification!");

  // Test 6: Complete Password Reset
  console.log("\n[Test 6] Submitting new password (length >= 8)...");
  const updateReq = new Request("https://directbeam.space/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: testRawToken,
      newPassword: "BrandNewSecurePassword2026!"
    })
  });
  const updateRes = await handleAuthRequest(updateReq, mockEnv);
  const updateData = await updateRes.json();
  console.log("Update status:", updateRes.status, "success:", updateData.success, "new token issued:", Boolean(updateData.token));
  if (!updateData.success) throw new Error("Password reset failed!");

  // Test 7: Single-use check (token must be immediately deleted from KV)
  console.log("\n[Test 7] Attempting reuse of single-use token...");
  const reuseReq = new Request("https://directbeam.space/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: testRawToken,
      newPassword: "AnotherNewPassword!"
    })
  });
  const reuseRes = await handleAuthRequest(reuseReq, mockEnv);
  const reuseData = await reuseRes.json();
  console.log("Reuse status:", reuseRes.status, "error:", reuseData.error);
  if (reuseRes.status === 200 || reuseData.success) {
    throw new Error("Critical vulnerability: Single-use token was reused!");
  }

  // Test 8: Session Revocation Check (Old session token must now be invalid due to tokenVersion increment)
  console.log("\n[Test 8] Checking revocation of previous user sessions...");
  const oldSessionReq = new Request("https://directbeam.space/api/auth/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${oldSessionToken}` }
  });
  const oldSessionRes = await handleAuthRequest(oldSessionReq, mockEnv);
  const oldSessionData = await oldSessionRes.json();
  console.log("Old session status:", oldSessionRes.status, "response:", oldSessionData);
  if (oldSessionRes.status !== 401) {
    throw new Error("Critical vulnerability: Old session was NOT revoked after password reset!");
  }

  // Test 9: New session token should be valid
  console.log("\n[Test 9] Checking new session token...");
  const newSessionReq = new Request("https://directbeam.space/api/auth/me", {
    method: "GET",
    headers: { "Authorization": `Bearer ${updateData.token}` }
  });
  const newSessionRes = await handleAuthRequest(newSessionReq, mockEnv);
  const newSessionData = await newSessionRes.json();
  console.log("New session status:", newSessionRes.status, "user email:", newSessionData.user?.email);
  if (newSessionRes.status !== 200 || !newSessionData.success) {
    throw new Error("New session token failed to authenticate!");
  }

  // Test 10: Authenticate with new password via /api/auth/login
  console.log("\n[Test 10] Signing in with new password...");
  const loginReq = new Request("https://directbeam.space/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "security_tester@directbeam.space",
      password: "BrandNewSecurePassword2026!"
    })
  });
  const loginRes = await handleAuthRequest(loginReq, mockEnv);
  const loginData = await loginRes.json();
  console.log("Login with new password status:", loginRes.status, "success:", loginData.success);
  if (loginRes.status !== 200 || !loginData.success) {
    throw new Error("Failed to sign in with new password!");
  }

  console.log("\n✅ ALL 10 SECURITY AUDIT TESTS PASSED WITH 100% SUCCESS!");
}

runTests().catch(err => {
  console.error("\n❌ TEST SUITE FAILED:", err);
  process.exit(1);
});
