const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Serve static assets from public/
app.use(express.static(path.join(__dirname, 'public')));

// Configure Socket.IO with multi-transport fallback & CORS
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

// Generate 6-character Base32 room codes (excluding ambiguous letters like O, I, 0, 1)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// In-memory room state: roomCode -> Set of socket IDs
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Signaling] Socket connected: ${socket.id}`);

  // 1. Create room
  socket.on('create-room', () => {
    let roomCode = generateRoomCode();
    while (rooms.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    rooms.set(roomCode, new Set([socket.id]));
    socket.join(roomCode);
    socket.roomCode = roomCode;

    console.log(`[Room Created] ${roomCode} by ${socket.id}`);

    // Standardized payload format
    socket.emit('room-created', { roomCode: roomCode, code: roomCode });
  });

  // 2. Join room
  socket.on('join-room', (payload) => {
    let roomCode = '';
    if (typeof payload === 'string') {
      roomCode = payload.trim().toUpperCase();
    } else if (payload && typeof payload === 'object') {
      roomCode = (payload.roomCode || payload.code || '').trim().toUpperCase();
    }

    if (!roomCode || !rooms.has(roomCode)) {
      socket.emit('error-msg', 'Room code not found or expired.');
      return;
    }

    const roomMembers = rooms.get(roomCode);
    roomMembers.add(socket.id);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    console.log(`[Room Joined] ${socket.id} entered ${roomCode}`);

    // Acknowledge back to receiver
    socket.emit('room-joined', { roomCode: roomCode, code: roomCode });

    // Notify peers (sender)
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
    console.log(`[Signaling] Socket disconnected: ${socket.id}`);
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const members = rooms.get(roomCode);
      members.delete(socket.id);

      socket.to(roomCode).emit('peer-disconnected', { peerId: socket.id });

      if (members.size === 0) {
        rooms.delete(roomCode);
        console.log(`[Room Deleted] ${roomCode}`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Direct Beam signaling server running on port ${PORT}`);
});