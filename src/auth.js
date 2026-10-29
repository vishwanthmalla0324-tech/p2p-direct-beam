import { sendPasswordResetEmail } from "./email.js";

/**
 * Cloudflare Worker KV Authentication Module for Direct Beam
 * Stores user profiles, hashed credentials (PBKDF2), and sessions in USERS_KV.
 * Supports: Email/Password (PBKDF2), Real Google OAuth (GSI JWT verification)
 */

const GOOGLE_CLIENT_ID = "464572597917-bj2jf591tfhc4lvqcqr0pn5q9sgps4d5.apps.googleusercontent.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

// In-memory fallback if USERS_KV binding is missing (local dev / standalone node)
const memoryKV = new Map();
function getKV(env) {
  if (env && env.USERS_KV) return env.USERS_KV;
  return {
    async get(key, type = "text") {
      const val = memoryKV.get(key);
      if (!val) return null;
      if (type === "json") {
        try {
          return JSON.parse(val);
        } catch {
          return null;
        }
      }
      return val;
    },
    async put(key, val) {
      memoryKV.set(key, typeof val === "string" ? val : JSON.stringify(val));
    },
    async delete(key) {
      memoryKV.delete(key);
    }
  };
}

/**
 * Hash password using Web Crypto PBKDF2 (100,000 iterations, SHA-256)
 */
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute SHA-256 hash of a string (used to hash reset tokens before storing in KV)
 */
async function hashToken(rawToken) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(rawToken));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mask email for secure visual confirmation without leaking full address (e.g. v***a@gmail.com)
 */
function maskEmail(email) {
  if (!email || typeof email !== "string") return "";
  const parts = email.split("@");
  if (parts.length !== 2) return email;
  const [local, domain] = parts;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(local.length - 2, 4))}${local[local.length - 1]}@${domain}`;
}

function extractToken(request) {
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/db_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function handleAuthRequest(request, env) {
  const url = new URL(request.url);
  const kv = getKV(env);

  // 1. CORS Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  // 2. User Registration (POST /api/auth/register)
  if (url.pathname === "/api/auth/register" && request.method === "POST") {
    try {
      const body = await request.json();
      const { email, password, name } = body;

      if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return jsonResponse({ error: "Please enter a valid email address." }, 400);
      }
      if (!password || typeof password !== "string" || password.length < 6) {
        return jsonResponse({ error: "Password must be at least 6 characters long." }, 400);
      }

      const normalizedEmail = email.trim().toLowerCase();
      const existingUser = await kv.get(`user:${normalizedEmail}`, "json");
      if (existingUser) {
        return jsonResponse({ error: "An account with this email already exists. Please sign in." }, 409);
      }

      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const displayName = (name && typeof name === "string" ? name.trim() : normalizedEmail.split("@")[0]) || "User";

      const newUser = {
        id: userId,
        email: normalizedEmail,
        name: displayName,
        salt,
        hash,
        createdAt: new Date().toISOString(),
        transfersCount: 0,
        tokenVersion: 1,
        pro: false
      };

      // Store user record in Cloudflare KV
      await kv.put(`user:${normalizedEmail}`, JSON.stringify(newUser));

      // Create session token with 30-day expiration bound to tokenVersion
      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId, email: normalizedEmail, tokenVersion: 1 }),
        { expirationTtl: 2592000 }
      );

      return jsonResponse(
        {
          success: true,
          message: "Account created successfully.",
          token,
          user: {
            id: newUser.id,
            email: newUser.email,
            name: newUser.name,
            transfersCount: newUser.transfersCount,
            pro: newUser.pro
          }
        },
        201
      );
    } catch (err) {
      console.error("Auth register error:", err);
      return jsonResponse({ error: "Registration failed. " + (err.message || "") }, 500);
    }
  }

  // 3. User Login (POST /api/auth/login)
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    try {
      const body = await request.json();
      const { email, password } = body;

      if (!email || !password) {
        return jsonResponse({ error: "Email and password are required." }, 400);
      }

      const normalizedEmail = email.trim().toLowerCase();
      const user = await kv.get(`user:${normalizedEmail}`, "json");
      if (!user || !user.hash || !user.salt) {
        return jsonResponse({ error: "Invalid email or password." }, 401);
      }

      const checkHash = await hashPassword(password, user.salt);
      if (checkHash !== user.hash) {
        return jsonResponse({ error: "Invalid email or password." }, 401);
      }

      // Generate new session token bound to active tokenVersion
      const userTokenVersion = user.tokenVersion || 1;
      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId: user.id, email: user.email, tokenVersion: userTokenVersion }),
        { expirationTtl: 2592000 }
      );

      return jsonResponse({
        success: true,
        message: "Logged in successfully.",
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount || 0,
          pro: Boolean(user.pro)
        }
      });
    } catch (err) {
      console.error("Auth login error:", err);
      return jsonResponse({ error: "Login failed. " + (err.message || "") }, 500);
    }
  }

  // 3b. Request Password Reset (POST /api/auth/forgot-password)
  // Step 1: User enters email. Generic 200 response to prevent enumeration attacks.
  if (url.pathname === "/api/auth/forgot-password" && request.method === "POST") {
    try {
      const body = await request.json().catch(() => ({}));
      const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

      // Always prepare generic response to prevent user enumeration
      const genericResponse = jsonResponse({
        success: true,
        message: "If an account exists for this email address, a password reset link has been sent to your inbox."
      });

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return genericResponse;
      }

      const user = await kv.get(`user:${email}`, "json");
      if (!user) {
        // Return generic 200 without exposing whether email exists
        return genericResponse;
      }

      // Allow any registered account (including Google OAuth users) to set/reset their password via email

      // Generate cryptographically secure single-use 32-byte token (hex string = 64 characters)
      const rawTokenBytes = new Uint8Array(32);
      crypto.getRandomValues(rawTokenBytes);
      const rawToken = Array.from(rawTokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

      // Compute SHA-256 hash of token to store in KV (OWASP compliance: never store plaintext tokens in DB)
      const tokenHash = await hashToken(rawToken);

      // Store in KV with strict 15-minute expiration (900 seconds)
      const tokenPayload = {
        userId: user.id,
        email: user.email,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15 * 60 * 1000
      };
      await kv.put(`reset_token:${tokenHash}`, JSON.stringify(tokenPayload), {
        expirationTtl: 900
      });

      // Assemble secure reset link
      const resetUrl = `${url.origin}/reset-password?token=${rawToken}`;

      // Dispatch email via MailChannels / Resend transporter
      await sendPasswordResetEmail({
        toEmail: user.email,
        resetUrl,
        env,
        expirationMinutes: 15
      });

      return genericResponse;
    } catch (err) {
      console.error("Auth forgot-password error:", err);
      return jsonResponse({
        success: true,
        message: "If an account exists for this email address, a password reset link has been sent to your inbox."
      });
    }
  }

  // 3c. Verify Password Reset Token (GET /api/auth/verify-reset-token)
  // Step 2a: Validate token before rendering the new password form
  if (url.pathname === "/api/auth/verify-reset-token" && request.method === "GET") {
    try {
      const rawToken = url.searchParams.get("token") || "";
      if (!rawToken || rawToken.length !== 64) {
        return jsonResponse({
          valid: false,
          error: "Invalid password reset token format."
        }, 400);
      }

      const tokenHash = await hashToken(rawToken);
      const tokenData = await kv.get(`reset_token:${tokenHash}`, "json");

      if (!tokenData) {
        return jsonResponse({
          valid: false,
          error: "This password reset link is invalid or has expired. Please request a new one."
        }, 400);
      }

      // Check explicit expiration timestamp
      if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
        await kv.delete(`reset_token:${tokenHash}`);
        return jsonResponse({
          valid: false,
          error: "This password reset link has expired (15-minute limit). Please request a new one."
        }, 400);
      }

      return jsonResponse({
        valid: true,
        email: maskEmail(tokenData.email)
      });
    } catch (err) {
      console.error("Auth verify-reset-token error:", err);
      return jsonResponse({ valid: false, error: "Token verification failed." }, 500);
    }
  }

  // 3d. Complete Password Reset & Session Invalidation (POST /api/auth/reset-password)
  // Step 2b: Update password, destroy token, invalidate all previous sessions
  if (url.pathname === "/api/auth/reset-password" && request.method === "POST") {
    try {
      const body = await request.json().catch(() => ({}));
      const rawToken = typeof body?.token === "string" ? body.token.trim() : "";
      const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

      if (!rawToken || rawToken.length !== 64) {
        return jsonResponse({ error: "Invalid password reset token format." }, 400);
      }

      if (!newPassword || newPassword.length < 8) {
        return jsonResponse({ error: "New password must be at least 8 characters long." }, 400);
      }

      const tokenHash = await hashToken(rawToken);
      const tokenData = await kv.get(`reset_token:${tokenHash}`, "json");

      if (!tokenData || !tokenData.email) {
        return jsonResponse({
          error: "This password reset token has expired or has already been used. Please request a new link."
        }, 400);
      }

      // Check explicit expiration timestamp
      if (tokenData.expiresAt && Date.now() > tokenData.expiresAt) {
        await kv.delete(`reset_token:${tokenHash}`);
        return jsonResponse({
          error: "This password reset link has expired (15-minute limit). Please request a new link."
        }, 400);
      }

      // CRITICAL: Immediately invalidate single-use token from KV
      await kv.delete(`reset_token:${tokenHash}`);

      const user = await kv.get(`user:${tokenData.email}`, "json");
      if (!user) {
        return jsonResponse({ error: "User account no longer exists." }, 404);
      }

      // Hash new password using Web Crypto PBKDF2 (100,000 iterations, SHA-256)
      const salt = generateSalt();
      const hash = await hashPassword(newPassword, salt);

      // Invalidate all existing sessions by incrementing tokenVersion
      const nextTokenVersion = (user.tokenVersion || 1) + 1;

      user.salt = salt;
      user.hash = hash;
      user.tokenVersion = nextTokenVersion;
      user.updatedAt = new Date().toISOString();

      await kv.put(`user:${tokenData.email}`, JSON.stringify(user));

      // Issue fresh session token bound to the new tokenVersion
      const sessionToken = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${sessionToken}`,
        JSON.stringify({ userId: user.id, email: user.email, tokenVersion: nextTokenVersion }),
        { expirationTtl: 2592000 }
      );

      return jsonResponse({
        success: true,
        message: "Password updated successfully! All other sessions have been logged out.",
        token: sessionToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount || 0,
          pro: Boolean(user.pro)
        }
      });
    } catch (err) {
      console.error("Auth reset-password error:", err);
      return jsonResponse({ error: "Password update failed: " + (err.message || "") }, 500);
    }
  }

  // 4. Current User Profile (GET /api/auth/me)
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    try {
      const token = extractToken(request);
      if (!token) {
        return jsonResponse({ error: "Authentication required." }, 401);
      }

      const session = await kv.get(`session:${token}`, "json");
      if (!session || !session.email) {
        return jsonResponse({ error: "Session invalid or expired." }, 401);
      }

      const user = await kv.get(`user:${session.email}`, "json");
      if (!user) {
        return jsonResponse({ error: "User account not found." }, 404);
      }

      // Check session tokenVersion against current user tokenVersion
      // If password was reset or credentials modified, tokenVersion will not match
      const currentTokenVersion = user.tokenVersion || 1;
      const sessionTokenVersion = session.tokenVersion || 1;
      if (sessionTokenVersion !== currentTokenVersion) {
        // Destroy invalidated session
        await kv.delete(`session:${token}`);
        return jsonResponse({ error: "Session has been invalidated. Please sign in with your new password." }, 401);
      }

      return jsonResponse({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount || 0,
          pro: Boolean(user.pro)
        }
      });
    } catch (err) {
      console.error("Auth me error:", err);
      return jsonResponse({ error: "Session verification failed." }, 500);
    }
  }

  // 5. User Logout (POST /api/auth/logout)
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    try {
      const token = extractToken(request);
      if (token) {
        await kv.delete(`session:${token}`);
      }
      return jsonResponse({ success: true, message: "Logged out successfully." });
    } catch (err) {
      console.error("Auth logout error:", err);
      return jsonResponse({ error: "Logout failed." }, 500);
    }
  }

  // 6. Sync Transfer Quota / Pro Status (POST /api/auth/sync)
  if (url.pathname === "/api/auth/sync" && request.method === "POST") {
    try {
      const token = extractToken(request);
      if (!token) {
        return jsonResponse({ error: "Authentication required." }, 401);
      }

      const session = await kv.get(`session:${token}`, "json");
      if (!session || !session.email) {
        return jsonResponse({ error: "Session invalid or expired." }, 401);
      }

      const user = await kv.get(`user:${session.email}`, "json");
      if (!user) {
        return jsonResponse({ error: "User not found." }, 404);
      }

      const body = await request.json();
      if (typeof body.transfersCount === "number") {
        if (body.resetTrials === true || body.transfersCount === 0) {
          user.transfersCount = body.transfersCount;
        } else {
          user.transfersCount = Math.max(user.transfersCount || 0, body.transfersCount);
        }
      }

      await kv.put(`user:${session.email}`, JSON.stringify(user));

      return jsonResponse({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount,
          pro: Boolean(user.pro)
        }
      });
    } catch (err) {
      console.error("Auth sync error:", err);
      return jsonResponse({ error: "Sync failed." }, 500);
    }
  }

  // 6b. Single-Use User-Bound License Key Activation (POST /api/auth/license/activate)
  if (url.pathname === "/api/auth/license/activate" && request.method === "POST") {
    try {
      const token = extractToken(request);
      if (!token) {
        return jsonResponse({ error: "Please log in first to activate your Pro license." }, 401);
      }

      const session = await kv.get(`session:${token}`, "json");
      if (!session || !session.email) {
        return jsonResponse({ error: "Session invalid or expired. Please sign in again." }, 401);
      }

      const user = await kv.get(`user:${session.email}`, "json");
      if (!user) {
        return jsonResponse({ error: "User account not found." }, 404);
      }

      const body = await request.json();
      const rawKey = body?.license_key;
      const key = typeof rawKey === "string" ? rawKey.trim() : "";

      if (!key) {
        return jsonResponse({ error: "Please enter a valid license key." }, 400);
      }

      const normalizedKey = key.toUpperCase();

      // Check if this key has already been activated in Cloudflare KV
      const existingLicense = await kv.get(`license:${normalizedKey}`, "json");
      if (existingLicense) {
        // Enforce SINGLE-USER: If activated by a different email or userId, reject!
        if (existingLicense.email !== user.email && existingLicense.userId !== user.id) {
          return jsonResponse({
            error: "This activation key has already been redeemed by another account. License keys can only be used once for a single user."
          }, 400);
        }

        // Already active for this specific user
        user.pro = true;
        await kv.put(`user:${user.email}`, JSON.stringify(user));
        return jsonResponse({
          success: true,
          message: "Pro subscription is active on your account.",
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            transfersCount: user.transfersCount || 0,
            pro: true
          }
        });
      }

      // Check if this key corresponds to a verified Lemon Squeezy payment or internal Pro license key
      const paymentRecord = await kv.get(`payment:${key}`, "json");
      const promoLicense = await kv.get(`promokey:${normalizedKey}`, "json");

      const isPaymentValid = Boolean(paymentRecord && (paymentRecord.status === "captured" || paymentRecord.status === "paid"));
      const isPromoValid = Boolean(promoLicense && !promoLicense.redeemed);
      const isKeyFormatValid = key.startsWith("ls_") || key.startsWith("order_") || key.startsWith("DB-PRO-") || normalizedKey.length >= 10;

      if (!isPaymentValid && !isPromoValid && !isKeyFormatValid) {
        return jsonResponse({
          error: "Invalid, expired, or unrecognized license key or order ID."
        }, 400);
      }

      // Single-use lock: permanently bind this license key to this user in Cloudflare KV
      await kv.put(`license:${normalizedKey}`, JSON.stringify({
        userId: user.id,
        email: user.email,
        activatedAt: new Date().toISOString(),
        orderId: paymentRecord?.orderId || key,
        type: isPaymentValid ? "lemonsqueezy_order" : "license_key"
      }));

      if (promoLicense) {
        promoLicense.redeemed = true;
        promoLicense.redeemedBy = user.email;
        promoLicense.redeemedAt = new Date().toISOString();
        await kv.put(`promokey:${normalizedKey}`, JSON.stringify(promoLicense));
      }

      // Update user status in Cloudflare KV
      user.pro = true;
      user.isPro = true;
      user.plan = "LIFETIME_PRO";
      user.proActivatedAt = new Date().toISOString();
      user.licenseKey = normalizedKey;
      await kv.put(`user:${user.email}`, JSON.stringify(user));

      return jsonResponse({
        success: true,
        message: "Pro lifetime subscription activated successfully!",
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount || 0,
          pro: true
        }
      });
    } catch (err) {
      console.error("License activate error:", err);
      return jsonResponse({ error: "Failed to activate license: " + (err.message || "") }, 500);
    }
  }

  // 7. Real Google OAuth — Verify Google Identity Services JWT Token (POST /api/auth/google/verify)
  if (url.pathname === "/api/auth/google/verify" && request.method === "POST") {
    try {
      const body = await request.json();
      const { credential } = body || {};

      if (!credential || typeof credential !== "string") {
        return jsonResponse({ error: "Missing Google credential token." }, 400);
      }

      // Decode JWT header to get key ID (kid)
      const parts = credential.split(".");
      if (parts.length !== 3) {
        return jsonResponse({ error: "Invalid Google token format." }, 400);
      }

      // Decode payload (base64url)
      const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const payloadJson = atob(payloadB64);
      const payload = JSON.parse(payloadJson);

      // Verify issuer
      if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
        return jsonResponse({ error: "Invalid token issuer." }, 401);
      }

      // Verify audience matches our Client ID
      if (payload.aud !== GOOGLE_CLIENT_ID) {
        return jsonResponse({ error: "Token audience mismatch." }, 401);
      }

      // Verify token is not expired
      const nowSec = Math.floor(Date.now() / 1000);
      if (payload.exp < nowSec) {
        return jsonResponse({ error: "Google token has expired." }, 401);
      }

      // Verify signature against Google's public JWKS keys
      const headerB64 = parts[0].replace(/-/g, "+").replace(/_/g, "/");
      const headerJson = atob(headerB64);
      const header = JSON.parse(headerJson);

      const jwksRes = await fetch("https://www.googleapis.com/oauth2/v3/certs");
      if (!jwksRes.ok) {
        return jsonResponse({ error: "Failed to fetch Google public keys." }, 502);
      }
      const jwks = await jwksRes.json();
      const jwk = jwks.keys.find(k => k.kid === header.kid);
      if (!jwk) {
        return jsonResponse({ error: "Google signing key not found." }, 401);
      }

      // Import the public key and verify signature
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );

      const enc = new TextEncoder();
      const signedData = enc.encode(parts[0] + "." + parts[1]);
      const signatureB64 = parts[2].replace(/-/g, "+").replace(/_/g, "/");
      const signatureBytes = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));

      const isValid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        signatureBytes,
        signedData
      );

      if (!isValid) {
        return jsonResponse({ error: "Google token signature verification failed." }, 401);
      }

      // ✅ Token is valid — find or create user in KV
      const email = payload.email?.toLowerCase()?.trim();
      const name = payload.name || payload.given_name || email?.split("@")[0] || "Google User";
      const avatar = payload.picture || null;

      if (!email) {
        return jsonResponse({ error: "No email in Google token." }, 400);
      }

      let user = await kv.get(`user:${email}`, "json");
      if (!user) {
        const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        user = {
          id: userId,
          email,
          name,
          provider: "google",
          avatar,
          googleSub: payload.sub,
          createdAt: new Date().toISOString(),
          transfersCount: 0,
          pro: false
        };
        await kv.put(`user:${email}`, JSON.stringify(user));
      } else {
        // Update Google-specific fields
        let changed = false;
        if (!user.provider) { user.provider = "google"; changed = true; }
        if (!user.avatar && avatar) { user.avatar = avatar; changed = true; }
        if (!user.googleSub && payload.sub) { user.googleSub = payload.sub; changed = true; }
        if (name && (!user.name || user.name === "User")) { user.name = name; changed = true; }
        if (changed) await kv.put(`user:${email}`, JSON.stringify(user));
      }

      // Generate 30-day session token
      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId: user.id, email: user.email, tokenVersion: user.tokenVersion || 1 }),
        { expirationTtl: 2592000 }
      );

      return jsonResponse({
        success: true,
        message: "Google authentication successful.",
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatar: user.avatar,
          transfersCount: user.transfersCount || 0,
          pro: Boolean(user.pro),
          provider: "google"
        }
      });
    } catch (err) {
      console.error("Google OAuth verify error:", err);
      return jsonResponse({ error: "Google authentication failed: " + (err.message || "") }, 500);
    }
  }

  // 8. Social OAuth Login - Fallback email-based (POST /api/auth/oauth/social)
  if (url.pathname === "/api/auth/oauth/social" && request.method === "POST") {
    try {
      const body = await request.json();
      const { provider, email, name, avatar } = body || {};

      if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return jsonResponse({ error: "Please provide a valid email address." }, 400);
      }
      if (!provider || !["google", "apple"].includes(provider.toLowerCase())) {
        return jsonResponse({ error: "Unsupported social provider." }, 400);
      }

      const normalizedEmail = email.trim().toLowerCase();
      let user = await kv.get(`user:${normalizedEmail}`, "json");

      if (!user) {
        const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        const displayName = (name && typeof name === "string" ? name.trim() : (provider === "apple" ? "Apple User" : normalizedEmail.split("@")[0])) || "User";

        user = {
          id: userId,
          email: normalizedEmail,
          name: displayName,
          provider: provider.toLowerCase(),
          avatar: avatar || null,
          createdAt: new Date().toISOString(),
          transfersCount: 0,
          pro: false
        };
        await kv.put(`user:${normalizedEmail}`, JSON.stringify(user));
      } else {
        // Update social provider and name if needed
        if (!user.provider) user.provider = provider.toLowerCase();
        if (name && (!user.name || user.name === "User")) user.name = name.trim();
        if (avatar && !user.avatar) user.avatar = avatar;
        await kv.put(`user:${normalizedEmail}`, JSON.stringify(user));
      }

      // Generate 30-day session token in Cloudflare KV
      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId: user.id, email: user.email, tokenVersion: user.tokenVersion || 1 }),
        { expirationTtl: 2592000 }
      );

      return jsonResponse({
        success: true,
        message: `${provider === "apple" ? "Apple" : "Google"} authentication successful.`,
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount || 0,
          pro: Boolean(user.pro),
          provider: user.provider
        }
      });
    } catch (err) {
      console.error("Social auth error:", err);
      return jsonResponse({ error: "Social login failed: " + (err.message || "") }, 500);
    }
  }

  // 9. Cloudflare Zero Trust / Access SSO Auto-Detection (GET /api/auth/cloudflare-access)
  if (url.pathname === "/api/auth/cloudflare-access" && request.method === "GET") {
    try {
      const cfEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
      if (!cfEmail) {
        return jsonResponse({ active: false, message: "No Cloudflare Access header detected." });
      }

      const normalizedEmail = cfEmail.trim().toLowerCase();
      let user = await kv.get(`user:${normalizedEmail}`, "json");

      if (!user) {
        const userId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        user = {
          id: userId,
          email: normalizedEmail,
          name: normalizedEmail.split("@")[0],
          provider: "cloudflare_access",
          createdAt: new Date().toISOString(),
          transfersCount: 0,
          pro: false
        };
        await kv.put(`user:${normalizedEmail}`, JSON.stringify(user));
      }

      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId: user.id, email: user.email }),
        { expirationTtl: 2592000 }
      );

      return jsonResponse({
        active: true,
        success: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          transfersCount: user.transfersCount || 0,
          pro: Boolean(user.pro),
          provider: "cloudflare_access"
        }
      });
    } catch (err) {
      return jsonResponse({ active: false, error: err.message }, 500);
    }
  }

  return null;
}
