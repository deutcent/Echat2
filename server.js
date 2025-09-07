// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MongoDB Connection with GridFS
let bucket;
mongoose.connect('mongodb+srv://swatantrakumar1582011:EcaewvoJs0wWpHRn@cluster0.x90rnfu.mongodb.net/Echat?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => {
    console.log('✅ MongoDB Connected');
    // Use mongoose's underlying mongo driver GridFSBucket
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
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
  images: [{
    url: String,
    filename: String
  }],
  reactions: { type: Object, default: {} },
  timestamp: { type: Date, default: Date.now },
  fileId: mongoose.Schema.Types.ObjectId,
  fileSize: Number,
  mimeType: String,
  replyTo: {
    id: String,
    name: String,
    preview: String
  },
  roomId: String // For private room messages
});
const Message = mongoose.model('Message', messageSchema);

// Private Room schema
const privateRoomSchema = new mongoose.Schema({
  id: String,
  name: String,
  password: String,
  creator: String,
  createdAt: { type: Date, default: Date.now },
  users: [String],
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) } // 24 hours from creation
});
const PrivateRoom = mongoose.model('PrivateRoom', privateRoomSchema);

// Online Users & Reactions
let onlineUsers = new Map();

// Store private rooms in memory for faster access (will also be stored in DB)
let privateRooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// File Upload with GridFS
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50MB
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
      if (!res.headersSent) res.status(500).json({ error: 'File upload failed' });
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
    const fileIdParam = req.params.fileId;
    if (!mongoose.Types.ObjectId.isValid(fileIdParam)) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    const fileId = new mongoose.Types.ObjectId(fileIdParam);
    const downloadStream = bucket.openDownloadStream(fileId);

    let sentHeader = false;
    downloadStream.on('file', (file) => {
      // set sensible headers for download with original filename when possible
      const mimeType = (file.metadata && file.metadata.mimeType) ? file.metadata.mimeType : 'application/octet-stream';
      const originalName = (file.metadata && file.metadata.originalName) ? file.metadata.originalName : file.filename;

      if (!sentHeader) {
        res.set({
          'Content-Type': mimeType,
          'Content-Length': file.length,
          'Cache-Control': 'public, max-age=31536000',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(originalName)}"`
        });
        sentHeader = true;
      }
    });

    downloadStream.on('error', (error) => {
      console.error('GridFS download error:', error);
      if (!res.headersSent) res.status(404).json({ error: 'File not found' });
    });

    downloadStream.pipe(res);

  } catch (error) {
    console.error('File serving error:', error);
    if (!res.headersSent) res.status(400).json({ error: 'Invalid file ID' });
  }
});

// Load private rooms from DB on startup
async function loadPrivateRooms() {
  try {
    const rooms = await PrivateRoom.find({ expiresAt: { $gt: new Date() } });
    rooms.forEach(room => {
      privateRooms.set(room.id, room);
      
      // Set timeout to destroy room after expiration
      const timeUntilExpiry = room.expiresAt - new Date();
      if (timeUntilExpiry > 0) {
        setTimeout(() => {
          expirePrivateRoom(room.id);
        }, timeUntilExpiry);
      }
    });
    console.log(`✅ Loaded ${rooms.length} private rooms from database`);
  } catch (error) {
    console.error('Error loading private rooms:', error);
  }
}

// Expire a private room
async function expirePrivateRoom(roomId) {
  try {
    // Delete all messages from this room
    await Message.deleteMany({ roomId });
    
    // Delete the room from database
    await PrivateRoom.deleteOne({ id: roomId });
    
    // Remove from memory
    privateRooms.delete(roomId);
    
    // Notify users
    io.emit('private room expired', roomId);
    console.log(`✅ Private room ${roomId} expired and was deleted`);
  } catch (error) {
    console.error('Error expiring private room:', error);
  }
}

// Generate a unique room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 10);
}

// Socket.IO Logic
io.on('connection', socket => {
  let userName = '';

  const broadcastUsers = () => {
    const users = Array.from(onlineUsers.values());
    io.emit('online users', { count: users.length, users });
  };

  // Send previous messages (only public messages)
  Message.find({ roomId: { $exists: false } })
    .sort({ timestamp: 1 })
    .then(messages => {
      socket.emit('previous messages', messages);
    })
    .catch(err => console.error('Error fetching previous messages:', err));

  socket.on('user joined', name => {
    userName = name;
    onlineUsers.set(socket.id, name);
    io.emit('user joined', name);
    broadcastUsers();
    
    // Send private rooms list
    socket.emit('private rooms list', Array.from(privateRooms.values()));
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
      
      // Only emit to other users, not back to the sender
      socket.broadcast.emit('chat message', data);
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
      
      // Handle multiple images
      if (data.type === 'multiple' && data.images) {
        const isGif = data.images.some(img => 
          img.filename.toLowerCase().endsWith('.gif') || 
          img.url.includes('.gif')
        );
        
        if (isGif) {
          data.type = 'gif';
        }
      } else {
        // Single image
        const isGif = data.type === 'gif' || 
                     data.mimeType === 'image/gif' || 
                     (data.filename && data.filename.toLowerCase().endsWith('.gif'));
        
        if (isGif) {
          data.type = 'gif';
        }
      }
      
      const msg = new Message(data);
      await msg.save();
      
      // Only emit to other users, not back to the sender
      socket.broadcast.emit('chat image', data);
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
      
      // Only emit to other users, not back to the sender
      socket.broadcast.emit('chat file', data);
    } catch (error) {
      console.error('Error saving file message:', error);
      socket.emit('error', { message: 'Failed to save file message' });
    }
  });

  // Private room events
  socket.on('create private room', async (data) => {
    try {
      const roomId = generateRoomId();
      const room = new PrivateRoom({
        id: roomId,
        name: data.name,
        password: data.password,
        creator: userName,
        users: [socket.id],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
      });
      
      await room.save();
      privateRooms.set(roomId, room);
      
      // Join the room
      socket.join(roomId);
      
      // Set timeout to destroy room after 24 hours
      setTimeout(() => {
        expirePrivateRoom(roomId);
      }, 24 * 60 * 60 * 1000);
      
      socket.emit('private room created', room);
      io.emit('private rooms list', Array.from(privateRooms.values()));
    } catch (error) {
      console.error('Error creating private room:', error);
      socket.emit('private room error', 'Failed to create private room');
    }
  });

  socket.on('join private room', async (data) => {
    try {
      const room = privateRooms.get(data.roomId);
      
      if (!room) {
        socket.emit('private room error', 'Room not found');
        return;
      }
      
      if (room.password !== data.password) {
        socket.emit('private room error', 'Incorrect password');
        return;
      }
      
      // Add user to room
      if (!room.users.includes(socket.id)) {
        room.users.push(socket.id);
        await PrivateRoom.updateOne({ id: room.id }, { users: room.users });
      }
      
      // Join socket room
      socket.join(room.id);
      
      // Send room messages
      const roomMessages = await Message.find({ roomId: room.id }).sort({ timestamp: 1 });
      socket.emit('private messages', roomMessages);
      
      socket.emit('private room joined', room);
    } catch (error) {
      console.error('Error joining private room:', error);
      socket.emit('private room error', 'Failed to join private room');
    }
  });

  socket.on('leave private room', () => {
    // Leave all rooms
    const rooms = Array.from(privateRooms.values());
    rooms.forEach(room => {
      if (room.users.includes(socket.id)) {
        const userIndex = room.users.indexOf(socket.id);
        if (userIndex !== -1) {
          room.users.splice(userIndex, 1);
          // Update in database
          PrivateRoom.updateOne({ id: room.id }, { users: room.users })
            .catch(err => console.error('Error updating room users:', err));
        }
        socket.leave(room.id);
      }
    });
    
    socket.emit('private room left');
    
    // Send public messages
    Message.find({ roomId: { $exists: false } })
      .sort({ timestamp: 1 })
      .then(messages => {
        socket.emit('previous messages', messages);
      })
      .catch(err => console.error('Error fetching previous messages:', err));
  });

  socket.on('private message', async (data) => {
    try {
      const room = privateRooms.get(data.roomId);
      
      if (room && room.users.includes(socket.id)) {
        // Ensure replyTo structure is maintained
        if (data.replyTo && !data.replyTo.id) {
          delete data.replyTo;
        }
        
        data.reactions = data.reactions || {};
        data.timestamp = data.timestamp || Date.now();
        
        const msg = new Message(data);
        await msg.save();
        
        // Send to all users in the room except the sender
        socket.to(room.id).emit('private message', data);
      } else {
        socket.emit('private room error', 'You are not a member of this room');
      }
    } catch (error) {
      console.error('Error saving private message:', error);
      socket.emit('error', { message: 'Failed to send private message' });
    }
  });

  socket.on('get private rooms', () => {
    socket.emit('private rooms list', Array.from(privateRooms.values()));
  });

  socket.on('get private messages', async (roomId) => {
    try {
      const room = privateRooms.get(roomId);
      
      if (room && room.users.includes(socket.id)) {
        const messages = await Message.find({ roomId }).sort({ timestamp: 1 });
        socket.emit('private messages', messages);
      }
    } catch (error) {
      console.error('Error getting private messages:', error);
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
      // Only delete public messages (those without a roomId)
      const publicMessagesWithFiles = await Message.find({ 
        fileId: { $exists: true },
        roomId: { $exists: false }
      });
      
      for (const message of publicMessagesWithFiles) {
        if (message.fileId && bucket) {
          try {
            // ensure id is an ObjectId
            const fid = (message.fileId instanceof mongoose.Types.ObjectId) ? message.fileId : new mongoose.Types.ObjectId(message.fileId);
            await bucket.delete(fid);
          } catch (error) {
            console.error('Error deleting file from GridFS:', error);
          }
        }
      }
      
      // Only delete public messages
      await Message.deleteMany({ roomId: { $exists: false } });
      
      // Notify all clients to clear public chat
      io.emit('clear all chat');
      console.log('✅ All public chat cleared');
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
          const fid = (message.fileId instanceof mongoose.Types.ObjectId) ? message.fileId : new mongoose.Types.ObjectId(message.fileId);
          await bucket.delete(fid);
        } catch (error) {
          console.error('Error deleting file from GridFS:', error);
        }
      }
      
      await Message.deleteOne({ id });
      
      // Emit to the appropriate room
      if (message && message.roomId) {
        io.to(message.roomId).emit('delete message', id);
      } else {
        io.emit('delete message', id);
      }
      
      console.log(`✅ Message ${id} deleted`);
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
      
      // Emit to the appropriate room
      if (message.roomId) {
        io.to(message.roomId).emit('react message', { id, reactions: message.reactions });
      } else {
        io.emit('react message', { id, reactions: message.reactions });
      }
      
      console.log(`✅ Reaction added to message ${id}`);
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
    
    // Remove user from private rooms
    privateRooms.forEach((room, roomId) => {
      const userIndex = room.users.indexOf(socket.id);
      if (userIndex !== -1) {
        room.users.splice(userIndex, 1);
        
        // Update in database
        PrivateRoom.updateOne({ id: roomId }, { users: room.users })
          .catch(err => console.error('Error updating room users:', err));
        
        // If no users left, delete the room
        if (room.users.length === 0) {
          expirePrivateRoom(roomId);
        }
      }
    });
    
    if (typingTimeout) {
      clearTimeout(typingTimeout);
    }
    
    console.log(`❌ User ${userName} disconnected`);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Load private rooms on startup
loadPrivateRooms();

// Cleanup expired rooms periodically (every hour)
setInterval(async () => {
  try {
    const expiredRooms = await PrivateRoom.find({ expiresAt: { $lt: new Date() } });
    for (const room of expiredRooms) {
      await expirePrivateRoom(room.id);
    }
  } catch (error) {
    console.error('Error cleaning up expired rooms:', error);
  }
}, 60 * 60 * 1000); // Run every hour

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
server.listen(PORT, () => console.log(`✅ Enhanced Server with private rooms, share, and gallery features running at http://localhost:${PORT}`));