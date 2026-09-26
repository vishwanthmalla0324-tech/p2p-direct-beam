const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Keep-alive heartbeat: pingInterval 20s prevents Render's 55s idle proxy disconnect
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 20000,
  pingTimeout: 25000,
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));

// Lightweight health check endpoint for uptime pingers
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Map: roomId -> Set of socket IDs
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    const clients = rooms.get(roomId);
    clients.add(socket.id);

    // Notify any peer already in the room
    socket.to(roomId).emit('peer-joined', socket.id);

    if (clients.size > 1) {
      socket.emit('ready');
    }
  });

  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    if (rooms.has(roomId)) {
      const clients = rooms.get(roomId);
      clients.delete(socket.id);
      socket.to(roomId).emit('peer-disconnected', socket.id);
      if (clients.size === 0) {
        rooms.delete(roomId);
      }
    }
    if (currentRoom === roomId) {
      currentRoom = null;
    }
  });

  socket.on('offer', ({ target, sdp }) => {
    io.to(target).emit('offer', { sender: socket.id, sdp });
  });

  socket.on('answer', ({ target, sdp }) => {
    io.to(target).emit('answer', { sender: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const clients = rooms.get(currentRoom);
      clients.delete(socket.id);
      socket.to(currentRoom).emit('peer-disconnected', socket.id);

      if (clients.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Direct Beam signaling server running on port ${PORT}`);
});