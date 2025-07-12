const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let onlineUsers = new Map();
let messageReactions = new Map(); // key: message ID, value: { user: emoji }

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// === File Upload Configuration ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

app.post('/upload', upload.single('file'), (req, res) => {
  if (req.file) {
    res.json({ fileUrl: `/uploads/${req.file.filename}` });
  } else {
    res.status(400).json({ error: 'No file uploaded' });
  }
});

io.on('connection', socket => {
  let userName = '';

  const broadcastUsers = () => {
    const users = Array.from(onlineUsers.values());
    io.emit('online users', { count: users.length, users });
  };

  socket.on('user joined', name => {
    userName = name;
    onlineUsers.set(socket.id, name);
    io.emit('user joined', name);
    broadcastUsers();
  });

  socket.on('chat message', data => {
    data.reactions = messageReactions.get(data.id) || {};
    io.emit('chat message', data);
  });

  socket.on('chat image', data => {
    data.type = 'image';
    data.reactions = messageReactions.get(data.id) || {};
    io.emit('chat image', data);
  });

  socket.on('chat file', data => {
    data.type = 'file';
    data.reactions = messageReactions.get(data.id) || {};
    io.emit('chat file', data);
  });

  socket.on('typing', name => {
    socket.broadcast.emit('typing', name);
  });

  socket.on('voice-stream', data => {
    socket.broadcast.emit('voice-stream', data);
  });

  // === Clear All Chat ===
  socket.on('clear all chat', () => {
    io.emit('clear all chat');
  });

  // === Delete Message ===
  socket.on('delete message', messageId => {
    io.emit('delete message', messageId);
  });

  // === React to Message ===
  socket.on('react message', ({ id, emoji, name }) => {
    if (!messageReactions.has(id)) {
      messageReactions.set(id, {});
    }
    const reactions = messageReactions.get(id);
    reactions[name] = emoji;
    messageReactions.set(id, reactions);
    io.emit('react message', { id, reactions });
  });

  socket.on('disconnect', () => {
    if (userName) {
      onlineUsers.delete(socket.id);
      io.emit('user left', userName);
      broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
