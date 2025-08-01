/***********************************************************************
 Echat – FULL SERVER
 Features:
   • Express + Socket.IO
   • MongoDB persistence (messages + reactions)
   • AWS S3 (multer-s3) persistent file storage
   • Voice streaming passthrough
   • Clear-chat, delete message, reactions
***********************************************************************/
require('dotenv').config();
const path     = require('path');
const fs       = require('fs');
const express  = require('express');
const http     = require('http');
const { Server }=require('socket.io');
const mongoose = require('mongoose');
/* ---------- S3 ---------- */
const { S3Client }      = require('@aws-sdk/client-s3');
const multer            = require('multer');
const multerS3          = require('multer-s3');

/* ---------- 0. App ---------- */
const app = express();
const server = http.createServer(app);
const io  = new Server(server);

/* ---------- 1. MongoDB ---------- */
mongoose.connect(process.env.MONGODB_URI
  || 'mongodb+srv://swatantrakumar1582011:EcaewvoJs0wWpHRn@cluster0.x90rnfu.mongodb.net/Echat?retryWrites=true&w=majority')
  .then(()=>console.log('✅ MongoDB connected'))
  .catch(console.error);

const Msg = mongoose.model('Message', new mongoose.Schema({
  id:String,name:String,message:String,url:String,filename:String,
  type:String,reactions:Object,timestamp:Date
}));

/* ---------- 2. S3 upload ---------- */
const s3=new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials:{
    accessKeyId:process.env.AWS_ACCESS_KEY_ID||'demo',
    secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY||'demo'
  }
});
const upload=multer({
  storage:multerS3({
    s3,bucket:process.env.AWS_S3_BUCKET||'echat-demo-bucket',acl:'public-read',
    key:(req,file,cb)=>cb(null,Date.now()+'-'+file.originalname)
  }),
  limits:{fileSize:10*1024*1024}
});

app.use(express.static(path.join(__dirname,'public')));
app.post('/upload',upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'no file'});
  res.json({fileUrl:req.file.location});
});

/* ---------- 3. Socket.IO ---------- */
const online=new Map(), reactions=new Map();

io.on('connection',socket=>{
  /* ---- history ---- */
  Msg.find().sort({timestamp:1}).then(m=>socket.emit('previous messages',m));
  let user='';

  /* ---- join ---- */
  socket.on('user joined',name=>{
    user=name;online.set(socket.id,name);
    io.emit('user joined',name);
    io.emit('online users',{count:online.size,users:[...online.values()]});
  });

  /* helper store+emit */
  const store = async (evt,d)=>{
    d.reactions={};d.timestamp=d.timestamp||Date.now();
    await new Msg(d).save();io.emit(evt,d);
  };
  socket.on('chat message',d=>store('chat message',d));
  socket.on('chat image',  d=>store('chat image',  d));
  socket.on('chat file',   d=>store('chat file',   d));

  /* typing & voice passthrough */
  socket.on('typing',n=>socket.broadcast.emit('typing',n));
  socket.on('voice-stream',d=>socket.broadcast.emit('voice-stream',d));

  /* clear chat */
  socket.on('clear all chat',async()=>{
    await Msg.deleteMany({});reactions.clear();io.emit('clear all chat');
  });

  /* delete message */
  socket.on('delete message',async id=>{
    await Msg.deleteOne({id});reactions.delete(id);io.emit('delete message',id);
  });

  /* react / toggle */
  socket.on('react message',async({id,emoji,name})=>{
    if(!reactions.has(id)){
      const m=await Msg.findOne({id});reactions.set(id,m?.reactions||{});
    }
    const r=reactions.get(id);
    (r[name]===emoji)?delete r[name]:r[name]=emoji;
    reactions.set(id,r);
    await Msg.updateOne({id},{$set:{reactions:r}});
    io.emit('react message',{id,reactions:r});
  });

  /* disconnect */
  socket.on('disconnect',()=>{
    if(user){online.delete(socket.id);io.emit('user left',user);
      io.emit('online users',{count:online.size,users:[...online.values()]});
    }
  });
});

/* ---------- 4. Start ---------- */
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`✅  Server http://localhost:${PORT}`));
