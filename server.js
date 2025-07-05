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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Allow all file types
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
    res.json({
      fileUrl: `/uploads/${req.file.filename}`,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype
    });
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
    io.emit('chat message', data);
  });

  socket.on('chat file', data => {
    io.emit('chat file', data);
  });

  socket.on('typing', name => {
    socket.broadcast.emit('typing', name);
  });

  socket.on('voice-stream', data => {
    socket.broadcast.emit('voice-stream', data);
  });

  socket.on('message reaction', data => {
    io.emit('message reaction', data);
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
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
