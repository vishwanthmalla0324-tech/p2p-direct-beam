const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory active room tracker: roomId -> Set of socket IDs
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

    // Notify other peers in this room
    socket.to(roomId).emit('peer-joined', socket.id);

    if (clients.size > 1) {
      socket.emit('ready');
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

// Dynamic port binding for local or cloud environments
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});