const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize Gemini AI with NEW API KEY
let genAI;
try {
  genAI = new GoogleGenerativeAI("AIzaSyCiyOFUe-rjwWWxieSYgFevMOI2urRCFSY");
  console.log('✅ Gemini AI initialized successfully with new API key');
} catch (error) {
  console.error('❌ Failed to initialize Gemini AI:', error);
  // Create a dummy genAI object to prevent crashes
  genAI = {
    getGenerativeModel: () => ({
      generateContent: async () => ({
        response: await Promise.resolve({
          text: () => "I'm Echat AI, but there was an issue initializing the AI service. Please check the API key."
        })
      })
    })
  };
}

// MongoDB Connection with GridFS
let bucket;
mongoose.connect('mongodb+srv://swatantrakumar1582011:EcaewvoJs0wWpHRn@cluster0.x90rnfu.mongodb.net/Echat?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => {
    console.log('✅ MongoDB Connected');
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
  })
  .catch(err => console.error(err));

// Message schema
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
  },
  roomId: { type: String, default: null }
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
  lastActivity: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) }
});
const PrivateRoom = mongoose.model('PrivateRoom', privateRoomSchema);

// Online Users & Rooms
let onlineUsers = new Map();
let privateRooms = new Map();

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
    privateRooms.clear();
    
    rooms.forEach(room => {
      privateRooms.set(room.id, room);
      
      const timeUntilExpiry = room.expiresAt - new Date();
      if (timeUntilExpiry > 0) {
        setTimeout(() => {
          expirePrivateRoom(room.id);
        }, timeUntilExpiry);
      } else {
        expirePrivateRoom(room.id);
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
    console.log(`🕒 Expiring private room ${roomId}`);
    
    await Message.deleteMany({ roomId });
    await PrivateRoom.deleteOne({ id: roomId });
    privateRooms.delete(roomId);
    
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

// Generate AI response using Gemini - COMPLETELY FIXED
async function generateAIResponse(query, context = '') {
  try {
    console.log('🔍 Generating Echat AI response for query:', query);
    
    // Remove the trigger words from the query
    const cleanedQuery = query.replace(/^(echat|Echat|echat ai|Echat AI)\s*/i, '').trim();
    
    if (!cleanedQuery) {
      return "I'm Echat AI! How can I help you today? Feel free to ask me anything.";
    }

    const model = genAI.getGenerativeModel({ 
      model: "gemini-pro",
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.7,
      }
    });
    
    const prompt = `You are Echat AI, a helpful and friendly AI assistant integrated into a chat application. 
    Provide a clear, concise, and helpful response to the user's question.
    Be conversational and engaging in your response.
    If the question is about current events or real-time information, provide the most up-to-date knowledge you have.
    
    User question: "${cleanedQuery}"
    
    Please respond directly to the question in a helpful manner.`;
    
    console.log('📤 Sending prompt to Gemini AI...');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('✅ Received AI response:', text.substring(0, 100) + '...');
    return text;
    
  } catch (error) {
    console.error('❌ Error generating AI response:', error);
    
    // More specific error messages
    if (error.message.includes('API_KEY_INVALID')) {
      return "I'm Echat AI, but there's an issue with my configuration. Please check the API key.";
    } else if (error.message.includes('quota')) {
      return "I'm Echat AI, but I've reached my usage limit. Please try again later.";
    } else if (error.message.includes('network') || error.message.includes('fetch')) {
      return "I'm Echat AI, but I'm having trouble connecting to my knowledge base. Please check your internet connection and try again.";
    } else {
      return "I'm Echat AI! I'm here to help. It seems there was a temporary issue. Please try asking your question again. You can ask me about anything - science, history, technology, or just chat!";
    }
  }
}

// Test the AI connection on startup
async function testAIConnection() {
  try {
    console.log('🧪 Testing Gemini AI connection...');
    const testResponse = await generateAIResponse("Hello, who are you?");
    console.log('✅ AI Test Response:', testResponse.substring(0, 100) + '...');
  } catch (error) {
    console.error('❌ AI Connection Test Failed:', error.message);
  }
}

// Socket.IO Logic - COMPLETELY FIXED
io.on('connection', socket => {
  let userName = '';
  let isAuthenticated = false;
  let currentRoomId = null;

  const broadcastUsers = () => {
    const users = Array.from(onlineUsers.values());
    io.emit('online users', { count: users.length, users });
  };

  // Send previous public messages
  Message.find({ roomId: null })
    .sort({ timestamp: 1 })
    .then(messages => {
      socket.emit('previous messages', messages);
    })
    .catch(err => console.error('Error fetching previous messages:', err));

  // Authentication handler
  socket.on('authenticate', (data) => {
    if (data.password === 'oracle' && data.name && data.name.trim() !== '') {
      userName = data.name.trim();
      isAuthenticated = true;
      
      onlineUsers.set(socket.id, userName);
      io.emit('user joined', userName);
      broadcastUsers();
      
      // Send private rooms list
      socket.emit('private rooms list', Array.from(privateRooms.values()));
      socket.emit('authentication success', { name: userName });
    } else {
      socket.emit('authentication failed', 'Invalid password or name');
    }
  });

  // Only allow authenticated users to send messages
  const requireAuth = (handler) => {
    return (...args) => {
      if (!isAuthenticated) {
        socket.emit('error', { message: 'Please authenticate first' });
        return;
      }
      handler(...args);
    };
  };

  // Public chat message handling
  socket.on('chat message', requireAuth(async (data) => {
    try {
      // Only allow public messages if not in a private room
      if (currentRoomId) {
        socket.emit('error', { message: 'You are in a private room. Leave it to send public messages.' });
        return;
      }

      if (data.replyTo && !data.replyTo.id) {
        delete data.replyTo;
      }
      
      data.reactions = data.reactions || {};
      data.timestamp = data.timestamp || Date.now();
      data.roomId = null; // Public message
      
      const msg = new Message(data);
      await msg.save();
      
      // Broadcast to ALL users for public chat
      io.emit('chat message', data);
    } catch (error) {
      console.error('Error saving message:', error);
      socket.emit('error', { message: 'Failed to save message' });
    }
  }));
  
  // AI query handling - COMPLETELY FIXED
  socket.on('ai query', requireAuth(async (data) => {
    try {
      console.log('🤖 Echat AI Query received:', data.query);
      
      // Save user's query immediately
      const userMsg = new Message({
        id: data.id,
        name: data.name,
        message: data.query,
        timestamp: Date.now(),
        roomId: data.roomId || null
      });
      await userMsg.save();

      // Show user's message in the appropriate room immediately
      if (data.roomId) {
        io.to(data.roomId).emit('chat message', userMsg);
      } else {
        io.emit('chat message', userMsg);
      }

      // Generate AI response
      console.log('🔄 Generating AI response...');
      const aiResponse = await generateAIResponse(data.query);
      
      const responseData = {
        id: data.id + '-ai',
        name: '🤖 Echat AI',
        message: aiResponse,
        timestamp: Date.now(),
        roomId: data.roomId || null
      };
      
      // Save AI response
      const aiMsg = new Message(responseData);
      await aiMsg.save();
      
      // Send AI response to the appropriate room
      if (data.roomId) {
        io.to(data.roomId).emit('ai response', responseData);
      } else {
        io.emit('ai response', responseData);
      }
      
      console.log('✅ Echat AI Response sent successfully');
      
    } catch (error) {
      console.error('❌ Error processing AI query:', error);
      
      // Send a friendly error message
      const errorResponse = {
        id: data.id + '-ai-error',
        name: '🤖 Echat AI',
        message: "I'm Echat AI, but I'm having some technical difficulties right now. Please try again in a moment!",
        timestamp: Date.now(),
        roomId: data.roomId || null
      };
      
      if (data.roomId) {
        io.to(data.roomId).emit('ai response', errorResponse);
      } else {
        io.emit('ai response', errorResponse);
      }
    }
  }));

  socket.on('chat image', requireAuth(async (data) => {
    try {
      // Only allow public images if not in a private room
      if (currentRoomId) {
        socket.emit('error', { message: 'You are in a private room. Leave it to send public messages.' });
        return;
      }

      if (data.replyTo && !data.replyTo.id) {
        delete data.replyTo;
      }
      
      data.reactions = data.reactions || {};
      data.timestamp = data.timestamp || Date.now();
      data.roomId = null; // Public message
      
      const isGif = data.type === 'gif' || 
                   data.mimeType === 'image/gif' || 
                   (data.filename && data.filename.toLowerCase().endsWith('.gif'));
      
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
  }));

  socket.on('chat file', requireAuth(async (data) => {
    try {
      // Only allow public files if not in a private room
      if (currentRoomId) {
        socket.emit('error', { message: 'You are in a private room. Leave it to send public messages.' });
        return;
      }

      if (data.replyTo && !data.replyTo.id) {
        delete data.replyTo;
      }
      
      data.reactions = data.reactions || {};
      data.timestamp = data.timestamp || Date.now();
      data.roomId = null; // Public message
      
      const msg = new Message(data);
      await msg.save();
      
      io.emit('chat file', data);
    } catch (error) {
      console.error('Error saving file message:', error);
      socket.emit('error', { message: 'Failed to save file message' });
    }
  }));

  // Private room events
  socket.on('create private room', requireAuth(async (data) => {
    try {
      const roomId = generateRoomId();
      const room = new PrivateRoom({
        id: roomId,
        name: data.name,
        password: data.password,
        creator: userName,
        users: [socket.id],
        lastActivity: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
      
      await room.save();
      privateRooms.set(roomId, room);
      
      socket.join(roomId);
      currentRoomId = roomId;
      
      const timeUntilExpiry = 24 * 60 * 60 * 1000;
      setTimeout(() => {
        expirePrivateRoom(roomId);
      }, timeUntilExpiry);
      
      console.log(`✅ Created private room ${roomId} - will expire in 24 hours`);
      
      socket.emit('private room created', room);
      io.emit('private rooms list', Array.from(privateRooms.values()));
    } catch (error) {
      console.error('Error creating private room:', error);
      socket.emit('private room error', 'Failed to create private room');
    }
  }));

  socket.on('join private room', requireAuth(async (data) => {
    try {
      let room = privateRooms.get(data.roomId);
      
      if (!room) {
        room = await PrivateRoom.findOne({ 
          id: data.roomId, 
          expiresAt: { $gt: new Date() } 
        });
        
        if (room) {
          privateRooms.set(room.id, room);
        }
      }
      
      if (!room) {
        socket.emit('private room error', 'Room not found or expired');
        return;
      }
      
      if (room.password !== data.password) {
        socket.emit('private room error', 'Incorrect password');
        return;
      }
      
      room.lastActivity = new Date();
      await PrivateRoom.updateOne({ id: room.id }, { lastActivity: room.lastActivity });
      
      if (!room.users.includes(socket.id)) {
        room.users.push(socket.id);
        await PrivateRoom.updateOne({ id: room.id }, { 
          users: room.users,
          lastActivity: room.lastActivity 
        });
      }
      
      socket.join(room.id);
      currentRoomId = room.id;
      
      // Clear current messages and load private room messages
      socket.emit('clear current chat');
      const roomMessages = await Message.find({ roomId: room.id }).sort({ timestamp: 1 });
      socket.emit('private messages', roomMessages);
      
      socket.emit('private room joined', room);
      console.log(`✅ User ${userName} joined private room ${room.id}`);
    } catch (error) {
      console.error('Error joining private room:', error);
      socket.emit('private room error', 'Failed to join private room');
    }
  }));

  socket.on('leave private room', requireAuth(async () => {
    try {
      if (currentRoomId) {
        const room = privateRooms.get(currentRoomId);
        if (room) {
          const userIndex = room.users.indexOf(socket.id);
          if (userIndex !== -1) {
            room.users.splice(userIndex, 1);
            
            await PrivateRoom.updateOne({ id: room.id }, { 
              users: room.users,
              lastActivity: new Date()
            });
            
            socket.leave(room.id);
            console.log(`✅ User ${userName} left private room ${room.id}`);
          }
        }
        
        currentRoomId = null;
      }
      
      socket.emit('private room left');
      socket.emit('clear current chat');
      
      // Load fresh public messages after leaving room
      Message.find({ roomId: null })
        .sort({ timestamp: 1 })
        .then(messages => {
          socket.emit('previous messages', messages);
        })
        .catch(err => console.error('Error fetching previous messages:', err));
    } catch (error) {
      console.error('Error leaving private room:', error);
    }
  }));

  socket.on('private message', requireAuth(async (data) => {
    try {
      if (!currentRoomId) {
        socket.emit('private room error', 'You are not in a private room');
        return;
      }
      
      const room = privateRooms.get(currentRoomId);
      
      if (room && room.users.includes(socket.id)) {
        room.lastActivity = new Date();
        await PrivateRoom.updateOne({ id: room.id }, { lastActivity: room.lastActivity });
        
        if (data.replyTo && !data.replyTo.id) {
          delete data.replyTo;
        }
        
        data.reactions = data.reactions || {};
        data.timestamp = data.timestamp || Date.now();
        data.roomId = currentRoomId;
        
        const msg = new Message(data);
        await msg.save();
        
        // Send ONLY to the private room
        io.to(room.id).emit('private message', data);
      } else {
        socket.emit('private room error', 'You are not a member of this room');
      }
    } catch (error) {
      console.error('Error saving private message:', error);
      socket.emit('error', { message: 'Failed to send private message' });
    }
  }));

  socket.on('get private rooms', requireAuth(() => {
    socket.emit('private rooms list', Array.from(privateRooms.values()));
  }));

  socket.on('get private messages', requireAuth(async (roomId) => {
    try {
      const room = privateRooms.get(roomId);
      
      if (room && room.users.includes(socket.id)) {
        const messages = await Message.find({ roomId }).sort({ timestamp: 1 });
        socket.emit('private messages', messages);
      }
    } catch (error) {
      console.error('Error getting private messages:', error);
    }
  }));

  let typingTimeout;
  socket.on('typing', requireAuth((name) => {
    if (currentRoomId) {
      socket.to(currentRoomId).emit('typing', name);
    } else {
      socket.broadcast.emit('typing', name);
    }
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (currentRoomId) {
        socket.to(currentRoomId).emit('stop typing', name);
      } else {
        socket.broadcast.emit('stop typing', name);
      }
    }, 3000);
  }));

  socket.on('voice-stream', requireAuth((data) => {
    try {
      if (currentRoomId) {
        socket.to(currentRoomId).emit('voice-stream', data);
      } else {
        socket.broadcast.emit('voice-stream', data);
      }
    } catch (error) {
      console.error('Voice stream error:', error);
    }
  }));

  socket.on('clear all chat', requireAuth(async () => {
    try {
      const publicMessagesWithFiles = await Message.find({ 
        fileId: { $exists: true },
        roomId: null
      });
      
      for (const message of publicMessagesWithFiles) {
        if (message.fileId && bucket) {
          try {
            const fid = (message.fileId instanceof mongoose.Types.ObjectId) ? message.fileId : new mongoose.Types.ObjectId(message.fileId);
            await bucket.delete(fid);
          } catch (error) {
            console.error('Error deleting file from GridFS:', error);
          }
        }
      }
      
      await Message.deleteMany({ roomId: null });
      io.emit('clear all chat');
    } catch (error) {
      console.error('Error clearing chat:', error);
      socket.emit('error', { message: 'Failed to clear chat' });
    }
  }));

  socket.on('delete message', requireAuth(async (id) => {
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
      
      if (message && message.roomId) {
        io.to(message.roomId).emit('delete message', id);
      } else {
        io.emit('delete message', id);
      }
    } catch (error) {
      console.error('Error deleting message:', error);
      socket.emit('error', { message: 'Failed to delete message' });
    }
  }));

  socket.on('react message', requireAuth(async ({ id, emoji, name }) => {
    try {
      const message = await Message.findOne({ id });
      if (!message) return;
      
      if (!message.reactions) message.reactions = {};
      
      if (message.reactions[name] === emoji) {
        delete message.reactions[name];
      } else {
        message.reactions[name] = emoji;
      }
      
      await Message.updateOne({ id }, { $set: { reactions: message.reactions } });
      
      if (message.roomId) {
        io.to(message.roomId).emit('react message', { id, reactions: message.reactions });
      } else {
        io.emit('react message', { id, reactions: message.reactions });
      }
    } catch (error) {
      console.error('Error updating reaction:', error);
      socket.emit('error', { message: 'Failed to update reaction' });
    }
  }));

  socket.on('disconnect', () => {
    if (userName && isAuthenticated) {
      onlineUsers.delete(socket.id);
      io.emit('user left', userName);
      broadcastUsers();
    }
    
    if (currentRoomId) {
      const room = privateRooms.get(currentRoomId);
      if (room) {
        const userIndex = room.users.indexOf(socket.id);
        if (userIndex !== -1) {
          room.users.splice(userIndex, 1);
          
          PrivateRoom.updateOne({ id: room.id }, { 
            users: room.users,
            lastActivity: new Date()
          }).catch(err => console.error('Error updating room users:', err));
          
          console.log(`✅ User ${userName} removed from room ${room.id} on disconnect`);
        }
      }
    }
    
    if (typingTimeout) {
      clearTimeout(typingTimeout);
    }
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Load private rooms on startup
setTimeout(() => {
  loadPrivateRooms();
}, 1000);

// Test AI connection on startup
setTimeout(() => {
  testAIConnection();
}, 2000);

// Cleanup expired rooms periodically
setInterval(async () => {
  try {
    const expiredRooms = await PrivateRoom.find({ expiresAt: { $lt: new Date() } });
    for (const room of expiredRooms) {
      await expirePrivateRoom(room.id);
    }
    
    console.log(`🕒 Periodic cleanup: Checked ${expiredRooms.length} expired rooms`);
  } catch (error) {
    console.error('Error cleaning up expired rooms:', error);
  }
}, 60 * 60 * 1000);

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
server.listen(PORT, () => console.log(`🚀 Enhanced Server with REAL Echat AI running at http://localhost:${PORT}`));