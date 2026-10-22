const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

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

app.use(express.json());

// In-memory user & session store for local dev
const localUsers = new Map();
const localSessions = new Map();

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
  const { transfersCount, pro } = req.body || {};
  if (typeof transfersCount === 'number') {
    user.transfersCount = Math.max(user.transfersCount || 0, transfersCount);
  }
  if (pro === true) {
    user.pro = true;
  }
  localUsers.set(email, user);
  const { password: _, ...safeUser } = user;
  res.json({ success: true, user: safeUser });
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