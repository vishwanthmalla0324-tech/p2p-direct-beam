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

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Map: roomId -> { hostId: string, receivers: Set<string> }
const activeRooms = new Map();

io.on('connection', (socket) => {
  let joinedRoomId = null;

  // 1. Host creates a persistent file room
  socket.on('create-room', (roomId) => {
    joinedRoomId = roomId;
    socket.join(roomId);
    activeRooms.set(roomId, { hostId: socket.id, receivers: new Set() });
    socket.emit('room-created', roomId);
  });

  // 2. Receiver joins an existing room
  socket.on('join-room', (roomId) => {
    joinedRoomId = roomId;
    const room = activeRooms.get(roomId);

    if (!room || !room.hostId) {
      socket.emit('room-error', 'Share session not found or host went offline.');
      return;
    }

    socket.join(roomId);
    room.receivers.add(socket.id);

    // Notify the host that a new receiver wants to pull files
    io.to(room.hostId).emit('receiver-joined', { receiverId: socket.id });
    socket.emit('joined-successfully', { hostId: room.hostId });
  });

  // 3. Direct signaling routing between host and individual receivers
  socket.on('signal-offer', ({ target, sdp }) => {
    io.to(target).emit('signal-offer', { sender: socket.id, sdp });
  });

  socket.on('signal-answer', ({ target, sdp }) => {
    io.to(target).emit('signal-answer', { sender: socket.id, sdp });
  });

  socket.on('signal-ice', ({ target, candidate }) => {
    io.to(target).emit('signal-ice', { sender: socket.id, candidate });
  });

  // 4. Host leaves or closes tab -> tear down the room
  socket.on('destroy-room', (roomId) => {
    if (activeRooms.has(roomId)) {
      const room = activeRooms.get(roomId);
      if (room.hostId === socket.id) {
        socket.to(roomId).emit('host-offline');
        activeRooms.delete(roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    if (joinedRoomId && activeRooms.has(joinedRoomId)) {
      const room = activeRooms.get(joinedRoomId);

      // If the host drops, close the session for all receivers
      if (room.hostId === socket.id) {
        socket.to(joinedRoomId).emit('host-offline');
        activeRooms.delete(joinedRoomId);
      } else {
        // If a receiver drops, inform the host to clean up only that peer
        room.receivers.delete(socket.id);
        io.to(room.hostId).emit('receiver-disconnected', { receiverId: socket.id });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Direct Beam P2P Host Server running on port ${PORT}`);
});