const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MongoDB Connection with GridFS
let bucket;
mongoose.connect('mongodb+srv://swatantrakumar1582011:EcaewvoJs0wWpHRn@cluster0.x90rnfu.mongodb.net/Echat?retryWrites=true&w=majority&appName=Cluster0')
  .then(() => {
    console.log('✅ MongoDB Connected');
    bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  })
  .catch(err => console.error(err));

// Message schema with replyTo structure
const messageSchema = new mongoose.Schema({
  id: String,
  name: String,
  message: String,
  url: String,
  filename: String,
  type: String,
  reactions: { type: Object, default: {} },
  timestamp: { type: Date, default: Date.now },
  fileId: mongoose.Schema.Types.ObjectId,
  fileSize: Number,
  mimeType: String,
  replyTo: {
    id: String,
    name: String,
    preview: String
  }
});
const Message = mongoose.model('Message', messageSchema);

// Online Users & Reactions
let onlineUsers = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// File Upload with GridFS
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { 
    fileSize: 50 * 1024 * 1024,
    files: 1
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  if (!bucket) {
    return res.status(500).json({ error: 'Database not ready' });
  }

  try {
    const uploadStream = bucket.openUploadStream(req.file.originalname, {
      metadata: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        uploadDate: new Date()
      }
    });

    uploadStream.end(req.file.buffer);

    uploadStream.on('finish', () => {
      res.json({ 
        fileUrl: `/file/${uploadStream.id}`,
        fileId: uploadStream.id,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size
      });
    });

    uploadStream.on('error', (error) => {
      console.error('GridFS upload error:', error);
      res.status(500).json({ error: 'File upload failed' });
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'File upload failed' });
  }
});

app.get('/file/:fileId', (req, res) => {
  if (!bucket) {
    return res.status(500).json({ error: 'Database not ready' });
  }

  try {
    const fileId = new mongoose.Types.ObjectId(req.params.fileId);
    const downloadStream = bucket.openDownloadStream(fileId);

    downloadStream.on('file', (file) => {
      res.set({
        'Content-Type': file.metadata?.mimeType || 'application/octet-stream',
        'Content-Length': file.length,
        'Cache-Control': 'public, max-age=31536000'
      });
    });

    downloadStream.on('error', (error) => {
      console.error('GridFS download error:', error);
      res.status(404).json({ error: 'File not found' });
    });

    downloadStream.pipe(res);

  } catch (error) {
    console.error('File serving error:', error);
    res.status(400).json({ error: 'Invalid file ID' });
  }
});

// Socket.IO Logic
io.on('connection', socket => {
  let userName = '';

  const broadcastUsers = () => {
    const users = Array.from(onlineUsers.values());
    io.emit('online users', { count: users.length, users });
  };

  Message.find().sort({ timestamp: 1 }).then(messages => {
    socket.emit('previous messages', messages);
  });

  socket.on('user joined', name => {
    userName = name;
    onlineUsers.set(socket.id, name);
    io.emit('user joined', name);
    broadcastUsers();
  });

  socket.on('chat message', async (data) => {
    try {
      // Ensure replyTo structure is maintained
      if (data.replyTo && !data.replyTo.id) {
        delete data.replyTo;
      }
      
      data.reactions = data.reactions || {};
      data.timestamp = data.timestamp || Date.now();
      const msg = new Message(data);
      await msg.save();
      io.emit('chat message', data);
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('error', { message: 'Failed to save message' });
    }
  });

  socket.on('chat image', async (data) => {
    try {
      // Ensure replyTo structure is maintained
      if (data.replyTo && !data.replyTo.id) {
        delete data.replyTo;
      }
      
      data.reactions = data.reactions || {};
      data.timestamp = data.timestamp || Date.now();
      
      const isGif = data.type === 'gif' || 
                   data.mimeType === 'image/gif' || 
                   data.filename?.toLowerCase().endsWith('.gif');
      
      if (isGif) {
        data.type = 'gif';
      }
      
      const msg = new Message(data);
      await msg.save();
      io.emit('chat image', data);
    } catch (error) {
      console.error('Error saving image message:', error);
      socket.emit('error', { message: 'Failed to save image message' });
    }
  });

  socket.on('chat file', async (data) => {
    try {
      // Ensure replyTo structure is maintained
      if (data.replyTo && !data.replyTo.id) {
        delete data.replyTo;
      }
      
      data.reactions = data.reactions || {};
      data.timestamp = data.timestamp || Date.now();
      const msg = new Message(data);
      await msg.save();
      io.emit('chat file', data);
    } catch (error) {
      console.error('Error saving file message:', error);
      socket.emit('error', { message: 'Failed to save file message' });
    }
  });

  let typingTimeout;
  socket.on('typing', name => {
    clearTimeout(typingTimeout);
    socket.broadcast.emit('typing', name);
    
    typingTimeout = setTimeout(() => {
      socket.broadcast.emit('stop typing', name);
    }, 3000);
  });

  socket.on('voice-stream', data => {
    try {
      socket.broadcast.emit('voice-stream', data);
    } catch (error) {
      console.error('Voice stream error:', error);
    }
  });

  socket.on('clear all chat', async () => {
    try {
      const messagesWithFiles = await Message.find({ fileId: { $exists: true } });
      
      for (const message of messagesWithFiles) {
        if (message.fileId && bucket) {
          try {
            await bucket.delete(message.fileId);
          } catch (error) {
            console.error('Error deleting file from GridFS:', error);
          }
        }
      }
      
      await Message.deleteMany({});
      io.emit('clear all chat');
    } catch (error) {
      console.error('Error clearing chat:', error);
      socket.emit('error', { message: 'Failed to clear chat' });
    }
  });

  socket.on('delete message', async (id) => {
    try {
      const message = await Message.findOne({ id });
      
      if (message && message.fileId && bucket) {
        try {
          await bucket.delete(message.fileId);
        } catch (error) {
          console.error('Error deleting file from GridFS:', error);
        }
      }
      
      await Message.deleteOne({ id });
      io.emit('delete message', id);
    } catch (error) {
      console.error('Error deleting message:', error);
      socket.emit('error', { message: 'Failed to delete message' });
    }
  });

  socket.on('react message', async ({ id, emoji, name }) => {
    try {
      const message = await Message.findOne({ id });
      if (!message) return;
      
      if (!message.reactions) message.reactions = {};
      
      // Toggle reaction
      if (message.reactions[name] === emoji) {
        delete message.reactions[name];
      } else {
        message.reactions[name] = emoji;
      }
      
      await Message.updateOne({ id }, { $set: { reactions: message.reactions } });
      io.emit('react message', { id, reactions: message.reactions });
    } catch (error) {
      console.error('Error updating reaction:', error);
      socket.emit('error', { message: 'Failed to update reaction' });
    }
  });

  socket.on('disconnect', () => {
    if (userName) {
      onlineUsers.delete(socket.id);
      io.emit('user left', userName);
      broadcastUsers();
    }
    
    if (typingTimeout) {
      clearTimeout(typingTimeout);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

app.use((error, req, res, next) => {
  console.error('Express error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Enhanced Server with all fixes running at http://localhost:${PORT}`));