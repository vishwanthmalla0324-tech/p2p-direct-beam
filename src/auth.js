/**
 * Cloudflare Worker KV Authentication Module for Direct Beam
 * Stores user profiles, hashed credentials (PBKDF2), and sessions in USERS_KV.
 */

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
        pro: false
      };

      // Store user record in Cloudflare KV
      await kv.put(`user:${normalizedEmail}`, JSON.stringify(newUser));

      // Create session token with 30-day expiration
      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId, email: normalizedEmail }),
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

      // Generate new session token
      const token = "db_sess_" + crypto.randomUUID().replace(/-/g, "");
      await kv.put(
        `session:${token}`,
        JSON.stringify({ userId: user.id, email: user.email }),
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
        user.transfersCount = Math.max(user.transfersCount || 0, body.transfersCount);
      }
      if (body.pro === true) {
        user.pro = true;
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

  // 7. Social OAuth Login - Google & Apple (POST /api/auth/oauth/social)
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
        JSON.stringify({ userId: user.id, email: user.email }),
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

  // 8. Cloudflare Zero Trust / Access SSO Auto-Detection (GET /api/auth/cloudflare-access)
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
