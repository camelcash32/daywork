const http = require('http');
let notify;
try { notify = require('./notify'); } catch(e) { notify = null; console.log('[INFO] notify.js not loaded:', e.message); }
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const DATA_FILE = path.join(__dirname, 'data.json');
const MOD_FILE  = path.join(__dirname, 'moderation.json');

// ── Persistence ───────────────────────────────────────────────
function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){}
  return { jobs:[], ratings:{}, chats:{}, reports:[] };
}
function loadMod() {
  try { if (fs.existsSync(MOD_FILE)) return JSON.parse(fs.readFileSync(MOD_FILE,'utf8')); } catch(e){}
  return {
    bannedUsers: [],
    bannedIPs:   [],
    flaggedJobs: [],
    errors:      [],
    modLog:      [],
    warnings:    {},      // username -> [{msg,date}]
    wordFilter:  ['scam','fraud','fake','spam'],
    autoFlag:    true,
  };
}
function saveDB()  { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); } catch(e){} }
function saveMod() { try { fs.writeFileSync(MOD_FILE,  JSON.stringify(mod,null,2)); } catch(e){} }

let db  = loadDB();
let mod = loadMod();
let dirty = false;
setInterval(()=>{ if(dirty){ saveDB(); dirty=false; } }, 3000);

// ── Moderation helpers ────────────────────────────────────────
function isUserBanned(name) {
  return mod.bannedUsers.some(b => b.name === name);
}
function isIPBanned(ip) {
  return mod.bannedIPs.some(b => b.ip === ip);
}
function containsBadWords(text) {
  if(!text) return false;
  const lower = text.toLowerCase();
  return mod.wordFilter.some(w => lower.includes(w));
}
function shouldAutoFlag(job) {
  if(!mod.autoFlag) return false;
  const text = (job.title||'')+' '+(job.description||'');
  return containsBadWords(text);
}
function modLog(action, detail, by) {
  const entry = { action, detail, by: by||'system', date: new Date().toISOString() };
  mod.modLog.unshift(entry);
  if(mod.modLog.length > 500) mod.modLog = mod.modLog.slice(0,500);
  console.log(`[MOD] ${action}: ${detail}`);
  saveMod();
  return entry;
}
function broadcast(msg, except) {
  const str = JSON.stringify(msg);
  clients.forEach(c => { if(c !== except && c.readyState === 1) c.send(str); });
}
function broadcastMod() {
  broadcast({ type:'modUpdate', mod: safeModData() });
}
function safeModData() {
  return {
    bannedUsers: mod.bannedUsers,
    bannedIPs:   mod.bannedIPs,
    flaggedJobs: mod.flaggedJobs,
    warnings:    mod.warnings,
    wordFilter:  mod.wordFilter,
    autoFlag:    mod.autoFlag,
    modLogCount: mod.modLog.length,
    errorCount:  mod.errors.length,
  };
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const ip  = req.socket.remoteAddress;

  // IP ban check (except admin)
  if(url !== '/admin' && isIPBanned(ip)) {
    res.writeHead(403,'Forbidden');
    res.end('<h1>403 Forbidden</h1><p>Your access has been restricted.</p>');
    return;
  }

  if(url === '/landing' || url === '/landing.html') {
    try {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'public','landing.html')));
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  if(url === '/admin') {
    try {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'public','admin.html')));
    } catch(e) { res.writeHead(500); res.end('Admin error: '+e.message); }
    return;
  }

  if(url === '/' || url === '/index.html') {
    try {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'public','index.html')));
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  // ── FEEDBACK ─────────────────────────────────────────────────
  // POST /feedback  body: {name, email, type, message}
  if (url === '/feedback' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { name, email, type, message } = JSON.parse(body);
        let notify2;
        try { notify2 = require('./notify'); } catch(e) { notify2 = null; }
        if (notify2) {
          const subject = `⚡ DAYWORK Feedback [${type}] from ${name}`;
          const html = `
            <div style="font-family:Arial,sans-serif;max-width:500px;background:#0f0f0f;color:#f0ede8;padding:24px;border-radius:12px">
              <h2 style="color:#e8c547">⚡ DAYWORK — New Feedback</h2>
              <p><strong>From:</strong> ${name} (${email||'no email'})</p>
              <p><strong>Type:</strong> ${type}</p>
              <p><strong>Message:</strong></p>
              <div style="background:#1a1a1a;padding:14px;border-radius:8px;margin-top:8px">${message}</div>
            </div>`;
          await notify2.sendEmail('lcount321@gmail.com', subject, html);
        }
        // Save feedback to db
        if (!db.feedback) db.feedback = [];
        db.feedback.unshift({ name, email, type, message, date: new Date().toLocaleDateString(), read: false });
        if (db.feedback.length > 500) db.feedback = db.feedback.slice(0, 500);
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500); res.end('Error: '+e.message);
      }
    });
    return;
  }

  // ── EMAIL VERIFICATION ───────────────────────────────────────
  // POST /send-verification  body: {email, code}
  if (url === '/send-verification' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { email, code, username } = JSON.parse(body);
        let notify2;
        try { notify2 = require('./notify'); } catch(e) { notify2 = null; }
        if (!notify2) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true, dev: true }));
          console.log('[VERIFY] Dev mode — code for '+email+': '+code);
          return;
        }
        const subject = '⚡ DAYWORK — Your verification code: ' + code;
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0f0f0f;color:#f0ede8;padding:28px;border-radius:12px">
            <h2 style="color:#e8c547;margin-bottom:8px">⚡ DAYWORK</h2>
            <h3 style="margin-bottom:16px">Verify your email</h3>
            <p style="color:#aaa;margin-bottom:20px">Hi ${username}, enter this code to confirm your account:</p>
            <div style="background:#1a1a1a;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px">
              <span style="font-size:36px;font-weight:900;letter-spacing:.2em;color:#e8c547">${code}</span>
            </div>
            <p style="color:#555;font-size:13px">This code expires in 10 minutes. If you didn't sign up for DAYWORK, ignore this email.</p>
          </div>`;
        const ok = await notify2.sendEmail(email, subject, html);
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok }));
      } catch(e) {
        res.writeHead(500); res.end('Error: '+e.message);
      }
    });
    return;
  }

  // ── CHAT API ─────────────────────────────────────────────
  // GET /chat?key=chat_1_Demo_Worker  → returns message array
  if (url === '/chat' && req.method === 'GET') {
    const qs = require('url').parse(req.url, true).query;
    const key = qs.key;
    if (!key || !key.startsWith('chat_')) {
      res.writeHead(400); res.end('Bad key');
      return;
    }
    const msgs = db.chats[key] || [];
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(msgs));
    return;
  }

  // POST /chat  body: {key, msg:{from,text,time}}
  if (url === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { key, msg } = JSON.parse(body);
        if (!key || !key.startsWith('chat_') || !msg) {
          res.writeHead(400); res.end('Bad request');
          return;
        }
        if (!db.chats[key]) db.chats[key] = [];
        db.chats[key].push(msg);
        saveDB(); // save immediately
        // Broadcast to all WS clients
        const out = JSON.stringify({ type: 'update', key, val: db.chats[key] });
        clients.forEach(c => { if (c.readyState === 1) c.send(out); });
        res.writeHead(200, {
          'Content-Type':'application/json',
          'Access-Control-Allow-Origin':'*',
          'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers':'Content-Type'
        });
        res.end(JSON.stringify({ ok: true, msgs: db.chats[key] }));
      } catch(e) {
        res.writeHead(500); res.end('Error: '+e.message);
      }
    });
    return;
  }

  // OPTIONS preflight
  if (url === '/feedback' && req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Set();
const clientMeta = new WeakMap(); // ws -> { ip, user }

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  // IP ban check on WS connect
  if(isIPBanned(ip)) {
    ws.send(JSON.stringify({ type:'banned', reason:'Your IP has been banned.' }));
    ws.close();
    return;
  }

  clients.add(ws);
  clientMeta.set(ws, { ip, user: null });
  console.log(`[+] ${ip} connected (${clients.size} total)`);

  // Send full state
  ws.send(JSON.stringify({ type:'init', db, mod: safeModData() }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const meta = clientMeta.get(ws) || {};

      // Track logged-in user
      if(msg.type === 'identify' && msg.user) {
        meta.user = msg.user;
        clientMeta.set(ws, meta);
        // Check if user is banned
        if(isUserBanned(msg.user)) {
          ws.send(JSON.stringify({ type:'banned', reason:'Your account has been banned.' }));
          return;
        }
      }

      // ── MODERATION COMMANDS (from admin panel) ──────────────
      if(msg.type === 'mod') {
        handleModCommand(msg, ws, meta);
        return;
      }

      // ── REGULAR DATA UPDATES ─────────────────────────────────
      if(msg.type === 'set') {
        const user = meta.user;

        // Check user ban
        if(user && isUserBanned(user)) {
          ws.send(JSON.stringify({ type:'banned', reason:'Your account has been banned.' }));
          return;
        }

        if(msg.key === 'jobs' && Array.isArray(msg.val)) {
          // Auto-flag new jobs with bad words
          msg.val = msg.val.map(job => {
            if(shouldAutoFlag(job) && !mod.flaggedJobs.includes(job.id)) {
              mod.flaggedJobs.push(job.id);
              modLog('auto-flag', `Job "${job.title}" auto-flagged`, 'system');
              saveMod();
            }
            return job;
          });
          db.jobs = msg.val;
          dirty = true;
        }
        else if(msg.key === 'ratings') { db.ratings = msg.val; dirty = true; }
        else if(msg.key === 'reports') {
          if(!Array.isArray(db.reports)) db.reports = [];
          // Add new report
          if(msg.val && msg.val.length > (db.reports||[]).length) {
            const newReport = msg.val[msg.val.length-1];
            modLog('report', `${newReport.reporter} reported ${newReport.reportedUser}: ${newReport.reason}`, newReport.reporter);
          }
          db.reports = msg.val;
          dirty = true;
        }
        else if(msg.key && msg.key.startsWith('chat_')) {
          // Chat is now HTTP-only — WS should NOT overwrite chat
          // Ignore WS chat updates to prevent stale cache overwrites
          // (clients use POST /chat and GET /chat exclusively)
          return;
        }
        else if(msg.key === 'adminError') {
          mod.errors.unshift({ ...msg.val, ip });
          if(mod.errors.length > 200) mod.errors = mod.errors.slice(0,200);
          saveMod();
          return; // don't broadcast errors
        }

        // Broadcast to other clients
        const out = JSON.stringify({ type:'update', key:msg.key, val:msg.val });
        let sent = 0;
        clients.forEach(c => { if(c!==ws && c.readyState===1){ c.send(out); sent++; } });
        console.log(`[broadcast] key=${msg.key} → ${sent} clients`);
      }

    } catch(e) { console.error('[err]', e.message); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[-] ${ip} disconnected (${clients.size} remaining)`);
  });
  ws.on('error', e => console.error('[ws error]', e.message));
});

// ── Mod command handler ───────────────────────────────────────
function handleModCommand(msg, ws, meta) {
  const { action, target, reason } = msg;
  const by = meta.user || 'admin';

  switch(action) {

    case 'banUser':
      if(!mod.bannedUsers.find(b=>b.name===target)) {
        mod.bannedUsers.push({ name:target, reason:reason||'', date:new Date().toISOString(), by });
        // Disconnect the user if online
        clients.forEach(c => {
          const m = clientMeta.get(c);
          if(m && m.user === target) {
            c.send(JSON.stringify({ type:'banned', reason:'Your account has been banned: '+(reason||'') }));
          }
        });
        modLog('banUser', `Banned user "${target}"`, by);
        // Remove their jobs
        const before = db.jobs.length;
        db.jobs = db.jobs.filter(j => j.postedBy !== target);
        if(db.jobs.length < before) dirty = true;
      }
      break;

    case 'unbanUser':
      mod.bannedUsers = mod.bannedUsers.filter(b=>b.name!==target);
      modLog('unbanUser', `Unbanned "${target}"`, by);
      break;

    case 'banIP':
      if(!mod.bannedIPs.find(b=>b.ip===target)) {
        mod.bannedIPs.push({ ip:target, reason:reason||'', date:new Date().toISOString(), by });
        // Disconnect that IP
        clients.forEach(c => {
          const m = clientMeta.get(c);
          if(m && m.ip === target) {
            c.send(JSON.stringify({ type:'banned', reason:'Your IP has been banned.' }));
            c.close();
          }
        });
        modLog('banIP', `Banned IP "${target}"`, by);
      }
      break;

    case 'unbanIP':
      mod.bannedIPs = mod.bannedIPs.filter(b=>b.ip!==target);
      modLog('unbanIP', `Unbanned IP "${target}"`, by);
      break;

    case 'removeJob':
      db.jobs = db.jobs.filter(j=>j.id!=target);
      mod.flaggedJobs = mod.flaggedJobs.filter(id=>id!=target);
      dirty = true;
      modLog('removeJob', `Removed job ID ${target}`, by);
      broadcast({ type:'update', key:'jobs', val:db.jobs });
      break;

    case 'flagJob':
      if(!mod.flaggedJobs.includes(target)) mod.flaggedJobs.push(target);
      modLog('flagJob', `Flagged job ID ${target}`, by);
      break;

    case 'unflagJob':
      mod.flaggedJobs = mod.flaggedJobs.filter(id=>id!=target);
      modLog('unflagJob', `Unflagged job ID ${target}`, by);
      break;

    case 'warnUser':
      if(!mod.warnings[target]) mod.warnings[target] = [];
      mod.warnings[target].push({ msg:reason||'Warning from admin', date:new Date().toISOString() });
      // Send warning to user if online
      clients.forEach(c => {
        const m = clientMeta.get(c);
        if(m && m.user === target) {
          c.send(JSON.stringify({ type:'warning', message: reason||'You have received a warning from admin.' }));
        }
      });
      modLog('warnUser', `Warned "${target}": ${reason}`, by);
      break;

    case 'resolveReport':
      if(db.reports[target]) {
        db.reports[target].status = msg.status || 'resolved';
        dirty = true;
        modLog('resolveReport', `Report #${target} marked ${msg.status}`, by);
      }
      break;

    case 'addWordFilter':
      if(target && !mod.wordFilter.includes(target.toLowerCase())) {
        mod.wordFilter.push(target.toLowerCase());
        modLog('addWordFilter', `Added word filter: "${target}"`, by);
      }
      break;

    case 'removeWordFilter':
      mod.wordFilter = mod.wordFilter.filter(w=>w!==target);
      modLog('removeWordFilter', `Removed word filter: "${target}"`, by);
      break;

    case 'getModLog':
      ws.send(JSON.stringify({ type:'modLog', log: mod.modLog.slice(0,100), errors: mod.errors.slice(0,50) }));
      return;

    case 'getFullMod':
      ws.send(JSON.stringify({ type:'fullMod', mod }));
      return;

    case 'clearErrors':
      mod.errors = [];
      modLog('clearErrors', 'Error log cleared', by);
      break;

    case 'toggleAutoFlag':
      mod.autoFlag = !mod.autoFlag;
      modLog('toggleAutoFlag', `Auto-flag ${mod.autoFlag?'enabled':'disabled'}`, by);
      break;
  }

  saveMod();
  // Broadcast updated mod state to all clients
  broadcastMod();
  // Echo success to sender
  ws.send(JSON.stringify({ type:'modAck', action, target }));
}

// ── Word filter ───────────────────────────────────────────────
function filterWords(text) {
  if(!text) return text;
  let out = text;
  mod.wordFilter.forEach(w => {
    const re = new RegExp(w, 'gi');
    out = out.replace(re, '*'.repeat(w.length));
  });
  return out;
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ifaces = require('os').networkInterfaces();
  let ip = 'YOUR-IP';
  Object.values(ifaces).flat().forEach(i => { if(i.family==='IPv4'&&!i.internal) ip=i.address; });
  console.log('\n  ⚡ DAYWORK SERVER RUNNING');
  console.log('  ─────────────────────────────────────');
  console.log(`  App:     http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log(`  Admin:   http://localhost:${PORT}/admin`);
  console.log('\n  Press Ctrl+C to stop.\n');
});
