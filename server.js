const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Keep-alive heartbeat endpoint for UptimeRobot / Cron-Job pingers
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
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

  // 2. Join room
  socket.on('join-room', (payload) => {
    let roomCode = '';
    if (typeof payload === 'string') {
      roomCode = payload.trim();
    } else if (payload && typeof payload === 'object') {
      roomCode = (payload.roomCode || payload.code || '').toString().trim();
    }

    if (!roomCode || !rooms.has(roomCode)) {
      socket.emit('error-msg', 'Room code not found or has expired.');
      return;
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