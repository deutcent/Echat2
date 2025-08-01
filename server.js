const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// === MongoDB Connection ===
mongoose.connect('mongodb+srv://swatantrakumar1582011:EcaewvoJs0wWpHRn@cluster0.x90rnfu.mongodb.net/Echat?retryWrites=true&w=majority&appName=Cluster0')
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error(err));

// Message schema with timestamp support
const messageSchema = new mongoose.Schema({
  id: String,
  name: String,
  message: String,
  url: String,
  filename: String,
  type: String,
  reactions: Object,
  timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// === Online Users & Reactions ===
let onlineUsers = new Map();
let messageReactions = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// === File Upload - Now supports GIFs explicitly ===
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

// Accept all file types including GIFs
const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    // Accept all file types
    cb(null, true);
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (req.file) {
    res.json({ fileUrl: `/uploads/${req.file.filename}` });
  } else {
    res.status(400).json({ error: 'No file uploaded' });
  }
});

// === Socket.IO Logic ===
io.on('connection', socket => {
  let userName = '';

  const broadcastUsers = () => {
    const users = Array.from(onlineUsers.values());
    io.emit('online users', { count: users.length, users });
  };

  // Send previous messages with timestamps
  Message.find().sort({ timestamp: 1 }).then(messages => {
    socket.emit('previous messages', messages);
  });

  socket.on('user joined', name => {
    userName = name;
    onlineUsers.set(socket.id, name);
    io.emit('user joined', name);
    broadcastUsers();
  });

  // Text messages
  socket.on('chat message', async (data) => {
    data.reactions = {};
    data.timestamp = data.timestamp || Date.now();
    const msg = new Message(data);
    await msg.save();
    io.emit('chat message', data);
  });

  // Image messages (including GIFs)
  socket.on('chat image', async (data) => {
    data.reactions = {};
    data.timestamp = data.timestamp || Date.now();
    const msg = new Message(data);
    await msg.save();
    io.emit('chat image', data);
  });

  // File messages
  socket.on('chat file', async (data) => {
    data.reactions = {};
    data.timestamp = data.timestamp || Date.now();
    const msg = new Message(data);
    await msg.save();
    io.emit('chat file', data);
  });

  // Typing indicator
  socket.on('typing', name => {
    socket.broadcast.emit('typing', name);
  });

  // Voice streaming - Original functionality preserved
  socket.on('voice-stream', data => {
    socket.broadcast.emit('voice-stream', data);
  });

  // Clear all chat
  socket.on('clear all chat', async () => {
    await Message.deleteMany({});
    messageReactions.clear();
    io.emit('clear all chat');
  });

  // Delete message
  socket.on('delete message', async (id) => {
    await Message.deleteOne({ id });
    messageReactions.delete(id);
    io.emit('delete message', id);
  });

  // React to message - Enhanced to handle multiple reactions better
  socket.on('react message', async ({ id, emoji, name }) => {
    // Load current reactions from database if not in memory
    if (!messageReactions.has(id)) {
      const message = await Message.findOne({ id });
      if (message && message.reactions) {
        messageReactions.set(id, message.reactions);
      } else {
        messageReactions.set(id, {});
      }
    }

    const reactions = messageReactions.get(id);
    
    // If user already reacted with this emoji, remove it (toggle)
    if (reactions[name] === emoji) {
      delete reactions[name];
    } else {
      // Otherwise, set/update their reaction
      reactions[name] = emoji;
    }
    
    messageReactions.set(id, reactions);

    // Update in database
    await Message.updateOne({ id }, { $set: { reactions } });
    io.emit('react message', { id, reactions });
  });

  // User disconnect
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