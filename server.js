const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store messages and users
let messages = [];
let users = [];

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  let currentUser = null;
  
  // User connection
  socket.on('user connected', (user) => {
    currentUser = {
      id: socket.id,
      name: user.name,
      online: true
    };
    
    // Add to users list
    users.push(currentUser);
    
    // Send online count
    io.emit('online count', users.length);
    
    // Notify other users
    socket.broadcast.emit('user connected', { 
      user: currentUser, 
      users: users 
    });
    
    // Send stored messages to the new user
    socket.emit('load messages', messages);
  });
  
  // Chat message
  socket.on('chat message', (msg) => {
    messages.push(msg);
    
    // Keep only last 100 messages
    if (messages.length > 100) {
      messages.shift();
    }
    
    io.emit('chat message', msg);
  });
  
  // Typing indicator
  socket.on('typing', (username) => {
    socket.broadcast.emit('typing', username);
  });
  
  // Stop typing
  socket.on('stop typing', () => {
    socket.broadcast.emit('stop typing');
  });
  
  // Add reaction
  socket.on('add reaction', ({ messageId, reaction }) => {
    const msg = messages.find(m => m.id === messageId);
    if (msg) {
      if (!msg.reactions) msg.reactions = {};
      msg.reactions[reaction] = (msg.reactions[reaction] || 0) + 1;
      io.emit('add reaction', { messageId, reaction });
    }
  });
  
  // Edit message
  socket.on('edit message', ({ messageId, newText }) => {
    const msg = messages.find(m => m.id === messageId);
    if (msg && msg.name === currentUser.name) {
      msg.text = newText;
      msg.edited = true;
      io.emit('message edited', { messageId, newText });
    }
  });
  
  // Handle username change
  socket.on('user name change', (newName) => {
    if (currentUser) {
      const oldName = currentUser.name;
      currentUser.name = newName;
      
      // Update all messages with the old name
      messages.forEach(msg => {
        if (msg.name === oldName) {
          msg.name = newName;
        }
      });
      
      // Notify clients
      io.emit('user name changed', { oldName, newName });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (currentUser) {
      // Update user status
      const userIndex = users.findIndex(u => u.id === socket.id);
      if (userIndex !== -1) {
        users.splice(userIndex, 1);
      }
      
      // Update online count
      io.emit('online count', users.length);
      
      // Notify other users
      io.emit('user disconnected', { 
        user: currentUser, 
        users: users 
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});