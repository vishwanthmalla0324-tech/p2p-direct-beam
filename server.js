const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

// Lightweight .env loader for local development
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  } else if (fs.existsSync('.env')) {
    const lines = fs.readFileSync('.env', 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...v] = trimmed.split('=');
        const key = k.trim();
        const val = v.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch (e) {
  // Silent fallback
}

const app = express();

// Trust reverse proxy (Cloudflare) for accurate client IP detection
app.set('trust proxy', 1);

const server = http.createServer(app);

// Keep-alive heartbeat endpoint for UptimeRobot / Cron-Job pingers
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Dynamic ICE & TURN configuration endpoint
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];

  // Configurable TURN relay credentials via environment variables (e.g. Metered, Coturn, Twilio)
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map((u) => u.trim());
    const turnEntry = { urls };
    if (process.env.TURN_USERNAME) turnEntry.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turnEntry.credential = process.env.TURN_CREDENTIAL;
    iceServers.push(turnEntry);
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers });
});

app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const crypto = require('crypto');

// In-memory user, session, order & payment store for local dev
const localUsers = new Map();
const localSessions = new Map();
const localOrders = new Map();
const localPayments = new Map();

app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Valid email and password (min 6 chars) required.' });
  }
  const normEmail = email.trim().toLowerCase();
  if (localUsers.has(normEmail)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  const token = 'local_sess_' + Math.random().toString(36).substring(2);
  const user = {
    id: 'usr_' + Math.random().toString(36).substring(2, 10),
    email: normEmail,
    name: name || normEmail.split('@')[0],
    transfersCount: 0,
    pro: false
  };
  localUsers.set(normEmail, { ...user, password });
  localSessions.set(token, normEmail);
  res.status(201).json({ success: true, token, user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const normEmail = (email || '').trim().toLowerCase();
  const user = localUsers.get(normEmail);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const token = 'local_sess_' + Math.random().toString(36).substring(2);
  localSessions.set(token, normEmail);
  const { password: _, ...safeUser } = user;
  res.json({ success: true, token, user: safeUser });
});

app.get('/api/auth/me', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  const email = localSessions.get(token);
  if (!email || !localUsers.has(email)) {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }
  const { password: _, ...safeUser } = localUsers.get(email);
  res.json({ success: true, user: safeUser });
});

app.post('/api/auth/logout', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  localSessions.delete(token);
  res.json({ success: true, message: 'Logged out' });
});

app.post('/api/auth/sync', (req, res) => {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  const email = localSessions.get(token);
  if (!email || !localUsers.has(email)) {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }
  const user = localUsers.get(email);
  const { transfersCount, pro, resetTrials } = req.body || {};
  if (typeof transfersCount === 'number') {
    if (resetTrials === true || transfersCount === 0) {
      user.transfersCount = transfersCount;
    } else {
      user.transfersCount = Math.max(user.transfersCount || 0, transfersCount);
    }
  }
  if (pro === true) {
    user.pro = true;
  }
  localUsers.set(email, user);
  const { password: _, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
});

// ============================================================================
// LEMON SQUEEZY PAYMENT GATEWAY ENDPOINTS (Live Mode, HMAC-SHA256, Webhooks)
// ============================================================================

const getLemonApiKey = () => process.env.LEMONSQUEEZY_API_KEY || '';
const getLemonStoreId = () => process.env.LEMONSQUEEZY_STORE_ID || '';
const getLemonWebhookSecret = () => process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const getLemonVariantId = () => process.env.LEMONSQUEEZY_VARIANT_ID || '';
const getAppUrl = () => process.env.NEXT_PUBLIC_APP_URL || 'https://directbeam.space';

app.get('/api/payments/config', (req, res) => {
  res.json({
    storeId: getLemonStoreId(),
    variantId: getLemonVariantId(),
    currency: 'USD',
    planName: 'Direct Beam Pro Lifetime'
  });
});

const handleCreateCheckout = async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '').trim();
    const email = localSessions.get(token);
    if (!email || !localUsers.has(email)) {
      return res.status(401).json({ error: 'Authentication required. Please sign in to upgrade.' });
    }

    const user = localUsers.get(email);
    if (user.pro || user.isPro || user.plan === 'LIFETIME_PRO') {
      return res.status(400).json({ error: 'Your account is already upgraded to Direct Beam Pro Lifetime!', alreadyPro: true });
    }

    const apiKey = getLemonApiKey();
    const storeId = getLemonStoreId();
    const variantId = getLemonVariantId();
    const redirectUrl = `${getAppUrl()}/?payment=success`;

    let checkoutUrl;
    if (apiKey && storeId && variantId && !apiKey.includes('placeholder') && !apiKey.includes('test_')) {
      const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json'
        },
        body: JSON.stringify({
          data: {
            type: 'checkouts',
            relationships: {
              store: { data: { type: 'stores', id: String(storeId) } },
              variant: { data: { type: 'variants', id: String(variantId) } }
            },
            attributes: {
              checkout_data: {
                email: user.email,
                name: user.name,
                custom: { user_id: String(user.id) }
              },
              product_options: {
                redirect_url: redirectUrl
              }
            }
          }
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.errors?.[0]?.detail || 'Lemon Squeezy API failed');
      }
      checkoutUrl = data?.data?.attributes?.url;
    } else {
      checkoutUrl = `https://directbeam.lemonsqueezy.com/checkout/buy/mock-checkout-${user.id}?checkout[custom][user_id]=${user.id}&checkout[email]=${encodeURIComponent(user.email)}`;
    }

    res.status(200).json({
      success: true,
      checkoutUrl
    });
  } catch (err) {
    console.error('[server.js create-checkout error]:', err);
    res.status(500).json({ error: 'Failed to create Lemon Squeezy checkout: ' + (err.message || '') });
  }
};

app.post('/api/payments/create-checkout', handleCreateCheckout);
app.post('/api/create-checkout', handleCreateCheckout);
app.post('/api/payments/create-order', handleCreateCheckout);
app.post('/api/create-order', handleCreateCheckout);

app.post(['/api/webhooks/lemonsqueezy', '/api/webhooks/lemon-squeezy'], (req, res) => {
  try {
    const signature = req.headers['x-signature'];
    const webhookSecret = getLemonWebhookSecret();

    if (!signature) {
      return res.status(401).json({ error: 'Missing x-signature header' });
    }

    if (!webhookSecret) {
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    const raw = req.rawBody ? req.rawBody.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = hmac.update(raw).digest('hex');

    let isValid = false;
    try {
      const digestBuf = Buffer.from(digest, 'utf8');
      const sigBuf = Buffer.from(signature, 'utf8');
      isValid = digestBuf.length === sigBuf.length && crypto.timingSafeEqual(digestBuf, sigBuf);
    } catch {
      isValid = digest === signature;
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const eventData = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(raw);
    const eventName = eventData?.meta?.event_name;

    if (eventName === 'order_created') {
      const orderAttributes = eventData?.data?.attributes;
      const orderId = String(eventData?.data?.id);
      const status = orderAttributes?.status;

      if (status === 'paid') {
        const userId = eventData?.meta?.custom_data?.user_id;
        const customerEmail = (orderAttributes?.user_email || '').toLowerCase().trim();
        const customerId = String(orderAttributes?.customer_id || '');
        const variantId = String(orderAttributes?.first_order_item?.variant_id || getLemonVariantId());
        const totalAmount = orderAttributes?.total || 0;
        const currency = orderAttributes?.currency || 'USD';

        let user = null;
        if (customerEmail && localUsers.has(customerEmail)) {
          user = localUsers.get(customerEmail);
        } else if (userId) {
          for (const u of localUsers.values()) {
            if (u.id === userId) {
              user = u;
              break;
            }
          }
        }

        if (user) {
          user.isPro = true;
          user.pro = true;
          user.plan = 'LIFETIME_PRO';
          user.proActivatedAt = new Date().toISOString();
          user.lemonSqueezyCustomerId = customerId;
          user.lemonSqueezyOrderId = orderId;
          localUsers.set(user.email, user);
        }

        const paymentRecord = {
          orderId,
          customerId,
          variantId,
          userId: userId || user?.id || null,
          email: user?.email || customerEmail,
          amount: totalAmount,
          currency,
          status: 'paid',
          createdAt: orderAttributes?.created_at || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        localPayments.set(orderId, paymentRecord);
      }
    }

    res.json({ received: true, status: 'ok' });
  } catch (err) {
    console.error('[server.js webhook error]:', err);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
});



// Social Login (Google & Apple)
app.post('/api/auth/oauth/social', (req, res) => {
  const { provider, email, name, avatar } = req.body || {};
  if (!email || !provider) {
    return res.status(400).json({ error: 'Valid email and provider required.' });
  }
  const normEmail = email.trim().toLowerCase();
  let user = localUsers.get(normEmail);
  if (!user) {
    user = {
      id: 'usr_' + Math.random().toString(36).substring(2, 10),
      email: normEmail,
      name: name || (provider === 'apple' ? 'Apple User' : normEmail.split('@')[0]),
      provider: provider.toLowerCase(),
      avatar: avatar || null,
      transfersCount: 0,
      pro: false
    };
    localUsers.set(normEmail, user);
  }
  const token = 'local_sess_' + Math.random().toString(36).substring(2);
  localSessions.set(token, normEmail);
  const { password: _, ...safeUser } = user;
  res.json({
    success: true,
    message: `${provider === 'apple' ? 'Apple' : 'Google'} authentication successful.`,
    token,
    user: safeUser
  });
});

// Cloudflare Access Zero Trust header auto-detection
app.get('/api/auth/cloudflare-access', (req, res) => {
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (!cfEmail) {
    return res.json({ active: false, message: 'No Cloudflare Access header detected.' });
  }
  const normEmail = cfEmail.trim().toLowerCase();
  let user = localUsers.get(normEmail);
  if (!user) {
    user = {
      id: 'usr_' + Math.random().toString(36).substring(2, 10),
      email: normEmail,
      name: normEmail.split('@')[0],
      provider: 'cloudflare_access',
      transfersCount: 0,
      pro: false
    };
    localUsers.set(normEmail, user);
  }
  const token = 'local_sess_' + Math.random().toString(36).substring(2);
  localSessions.set(token, normEmail);
  const { password: _, ...safeUser } = user;
  res.json({ active: true, success: true, token, user: safeUser });
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Staging Preview Routes for UI Variants
app.get('/preview/theme-1', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview', 'theme-1.html'));
});
app.get('/preview/theme-2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview', 'theme-2.html'));
});
app.get('/preview/theme-3', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview', 'theme-3.html'));
});

// Serve static assets from public/
app.use(express.static(path.join(__dirname, 'public')));

// Configure Socket.IO with CORS and transport fallbacks
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Helper: Extract real client IP through Cloudflare & reverse proxies
function getClientIp(socket) {
  const headers = socket.handshake.headers;
  if (headers['cf-connecting-ip']) {
    return headers['cf-connecting-ip'].trim();
  }
  if (headers['x-forwarded-for']) {
    return headers['x-forwarded-for'].split(',')[0].trim();
  }
  return socket.handshake.address || socket.conn.remoteAddress || 'unknown';
}

// Rate limiting state for brute-force protection on 6-digit room codes
const ipRateLimits = new Map(); // ip -> { failedAttempts: number, resetAt: number, blockedUntil: number }
const socketJoinAttempts = new Map(); // socket.id -> count

const MAX_SOCKET_ATTEMPTS = 15;
const MAX_IP_FAILED_ATTEMPTS = 12;
const WINDOW_MS = 60 * 1000; // 1-minute sliding window
const BAN_DURATION_MS = 5 * 60 * 1000; // 5-minute temporary lockout

// Periodic cleanup of rate limit maps to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipRateLimits.entries()) {
    if (now > data.resetAt && now > data.blockedUntil) {
      ipRateLimits.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

// Generate pure 6-digit numeric room codes (100000 - 999999)
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// In-memory room state: roomCode -> Set of socket IDs
const rooms = new Map();

io.on('connection', (socket) => {
  // 1. Create room
  socket.on('create-room', () => {
    let roomCode = generateRoomCode();
    while (rooms.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    rooms.set(roomCode, new Set([socket.id]));
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('room-created', { roomCode: roomCode, code: roomCode });
  });

  // 2. Join room (with rate-limiting & brute-force mitigation)
  socket.on('join-room', (payload) => {
    const clientIp = getClientIp(socket);
    const now = Date.now();

    // Check IP lockout
    const ipRecord = ipRateLimits.get(clientIp);
    if (ipRecord && ipRecord.blockedUntil && now < ipRecord.blockedUntil) {
      const waitSec = Math.ceil((ipRecord.blockedUntil - now) / 1000);
      socket.emit('error-msg', `Too many failed join attempts. Please wait ${waitSec}s.`);
      socket.disconnect(true);
      return;
    }

    // Socket-level throttling
    const currentAttempts = (socketJoinAttempts.get(socket.id) || 0) + 1;
    socketJoinAttempts.set(socket.id, currentAttempts);

    if (currentAttempts > MAX_SOCKET_ATTEMPTS) {
      socket.emit('error-msg', 'Too many join attempts on this session. Disconnecting.');
      socket.disconnect(true);
      return;
    }

    let roomCode = '';
    if (typeof payload === 'string') {
      roomCode = payload.trim();
    } else if (payload && typeof payload === 'object') {
      roomCode = (payload.roomCode || payload.code || '').toString().trim();
    }

    if (!roomCode || !rooms.has(roomCode)) {
      // Record failed attempt for IP
      let record = ipRateLimits.get(clientIp);
      if (!record || now > record.resetAt) {
        record = { failedAttempts: 1, resetAt: now + WINDOW_MS, blockedUntil: 0 };
      } else {
        record.failedAttempts++;
        if (record.failedAttempts >= MAX_IP_FAILED_ATTEMPTS) {
          record.blockedUntil = now + BAN_DURATION_MS;
        }
      }
      ipRateLimits.set(clientIp, record);

      socket.emit('error-msg', 'Room code not found or has expired.');
      return;
    }

    // Successful join: reset IP failed attempts if not banned
    if (ipRecord && !ipRecord.blockedUntil) {
      ipRateLimits.delete(clientIp);
    }

    const roomMembers = rooms.get(roomCode);
    roomMembers.add(socket.id);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('room-joined', { roomCode: roomCode, code: roomCode });
    socket.to(roomCode).emit('peer-joined', { peerId: socket.id });
  });

  // 3. WebRTC signaling relay (SDP / ICE Candidates)
  socket.on('signal', ({ targetId, data }) => {
    if (targetId) {
      io.to(targetId).emit('signal', { senderId: socket.id, data });
    }
  });

  // 4. Disconnect handling
  socket.on('disconnect', () => {
    socketJoinAttempts.delete(socket.id);
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const members = rooms.get(roomCode);
      members.delete(socket.id);

      socket.to(roomCode).emit('peer-disconnected', { peerId: socket.id });

      if (members.size === 0) {
        rooms.delete(roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Direct Beam signaling server running on port ${PORT}`);
});