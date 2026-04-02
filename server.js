const http = require('http');
let notify;
try { notify = require('./notify'); } catch(e) { notify = null; console.log('[INFO] notify.js not loaded:', e.message); }
const fs = require('fs');
const path = require('path');

// ── Config: env vars take priority over config.json ───────────
function getCfg() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8')); } catch(e){}
  return {
    stripe_secret_key:      process.env.STRIPE_SECRET_KEY      || cfg.stripe_secret_key      || '',
    stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || cfg.stripe_publishable_key || '',
    bulletin_token:         process.env.BULLETIN_TOKEN         || cfg.bulletin_token         || 'dw-bulletin-admin-2024',
    app_url:              process.env.APP_URL               || cfg.app_url               || 'http://localhost:3000',
    resend_api_key:       process.env.RESEND_API_KEY       || cfg.resend_api_key       || '',
    email_from:           process.env.EMAIL_FROM           || cfg.email_from           || 'DAYWORK <noreply@godaywork.com>',
  };
}
const WebSocket = require('ws');

const DATA_DIR  = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const MOD_FILE  = path.join(DATA_DIR, 'moderation.json');

// ── Persistence ───────────────────────────────────────────────
function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){}
  return { jobs:[], ratings:{}, chats:{}, reports:[], users:[], bulletin:[], payments:[], refundRequests:[] };
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

// Ensure totalSignups is at least the number of known users (fixes zero counter after retroactive deploy)
if ((db.totalSignups||0) < (db.users||[]).length) {
  db.totalSignups = (db.users||[]).length;
  dirty = true;
}

// ── Seed demo jobs if empty ───────────────────────────────────
if (!db.jobs || !db.jobs.length) {
  db.jobs = [
    {id:Date.now()+1,title:"Help Moving Furniture",category:"Moving",pay:"$80.00 flat",payAmount:"80",duration:"3-4 hrs",zip:"90001",location:"Los Angeles, CA",date:"Today, 10AM",slots:2,filled:0,postedBy:"DemoHirer",applicants:[],completedPairs:[],priority:false,urgent:false,description:"Need 2 people to help move boxes and furniture from a 2BR apartment to a moving truck.",postedAt:Date.now()},
    {id:Date.now()+2,title:"Lawn Mowing & Yard Cleanup",category:"Landscaping",pay:"$50.00 flat",payAmount:"50",duration:"2 hrs",zip:"77001",location:"Houston, TX",date:"Today, 9AM",slots:1,filled:0,postedBy:"DemoHirer",applicants:[],completedPairs:[],priority:false,urgent:false,description:"Standard lawn mowing, edging, and leaf blowout for a residential property. Equipment provided.",postedAt:Date.now()},
    {id:Date.now()+3,title:"Office Deep Clean",category:"Cleaning",pay:"$100.00 flat",payAmount:"100",duration:"4 hrs",zip:"10001",location:"New York, NY",date:"Tomorrow, 8AM",slots:3,filled:0,postedBy:"DemoHirer",applicants:[],completedPairs:[],priority:true,urgent:true,description:"Deep clean of a small office space. All supplies provided. Must be available before 8AM.",postedAt:Date.now()},
    {id:Date.now()+4,title:"Package Delivery Route",category:"Delivery",pay:"$120.00 flat",payAmount:"120",duration:"6-8 hrs",zip:"60601",location:"Chicago, IL",date:"Today, 7AM",slots:1,filled:0,postedBy:"DemoHirer",applicants:[],completedPairs:[],priority:false,urgent:true,description:"Drive our van on a preset delivery route. Valid license required. No heavy lifting over 30 lbs.",postedAt:Date.now()},
    {id:Date.now()+5,title:"Drywall Patching & Paint Touch-Up",category:"Construction",pay:"$150.00 flat",payAmount:"150",duration:"5-6 hrs",zip:"85001",location:"Phoenix, AZ",date:"Tomorrow, 9AM",slots:2,filled:0,postedBy:"DemoHirer",applicants:[],completedPairs:[],priority:false,urgent:false,description:"Patch and paint several walls in a rental unit after tenant move-out. Paint and supplies included.",postedAt:Date.now()}
  ];
  saveDB();
  console.log('[DEMO] Seeded 5 demo jobs');
}
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

// ── JOB NOTIFICATION TO SEEKERS ──────────────────────────────
async function notifySeekersNewJob(job) {
  if (!notify) return;
  // Get all registered users with email
  const users = db.users || [];
  const seekers = users.filter(u => u.email && u.emailVerified !== false);
  if (!seekers.length) {
    console.log('[NOTIFY] No seekers to notify');
    return;
  }
  const subject = `⚡ DAYWORK: New job near you — "${job.title}"`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0f0f0f;color:#f0ede8;padding:24px;border-radius:12px">
      <h2 style="color:#e8c547;margin-bottom:8px">⚡ DAYWORK</h2>
      <h3 style="margin-bottom:16px">A new job was just posted!</h3>
      <div style="background:#1a1a1a;border-radius:10px;padding:16px;margin-bottom:16px">
        <p style="font-weight:700;font-size:18px;margin-bottom:8px">${job.title}</p>
        <p style="color:#aaa;margin-bottom:4px">📍 ${job.location || job.zip}</p>
        <p style="color:#aaa;margin-bottom:4px">💰 ${job.pay}</p>
        <p style="color:#aaa;margin-bottom:4px">📅 ${job.date}</p>
        ${job.description ? `<p style="color:#888;font-size:13px;margin-top:8px">${job.description.slice(0,150)}${job.description.length>150?'...':''}</p>` : ''}
      </div>
      <p style="color:#555;font-size:13px;margin-bottom:16px">Log in to DAYWORK to apply before it fills up. Jobs expire in 24 hours!</p>
      <a href="https://www.godaywork.com" style="display:inline-block;background:#e8c547;color:#0f0f0f;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View Job →</a>
      <p style="color:#333;font-size:11px;margin-top:20px">You're receiving this because you have a DAYWORK account. Log in to manage your notification settings.</p>
    </div>`;

  let sent = 0;
  for (const user of seekers) {
    try {
      await notify.sendEmail(user.email, subject, html);
      sent++;
    } catch(e) {
      console.error(`[NOTIFY] Failed to email ${user.email}:`, e.message);
    }
  }
  console.log(`[NOTIFY] Job notification sent to ${sent}/${seekers.length} seekers`);
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

if(url === '/manifest.json') {
    try { res.writeHead(200,{'Content-Type':'application/manifest+json'}); res.end(fs.readFileSync(path.join(__dirname,'public','manifest.json'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }
  if(url === '/sw.js') {
    try { res.writeHead(200,{'Content-Type':'application/javascript'}); res.end(fs.readFileSync(path.join(__dirname,'public','sw.js'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }
  if(url === '/offline.html') {
    try { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(fs.readFileSync(path.join(__dirname,'public','offline.html'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }
  if(url === '/screenshot-wide.png') {
    try { res.writeHead(200,{'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname,'public','screenshot-wide.png'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }
  if(url==='/icon-192.png') {
    try { res.writeHead(200,{'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname,'public','icon-192.png'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }
  if(url==='/icon-512.png') {
    try { res.writeHead(200,{'Content-Type':'image/png'}); res.end(fs.readFileSync(path.join(__dirname,'public','icon-512.png'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }

  if(url === '/ads.txt') {
    try {
      res.writeHead(200, {'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});
      res.end(require('fs').readFileSync(require('path').join(__dirname,'ads.txt')));
    } catch(e) { res.writeHead(404); res.end('Not found'); }
    return;
  }
if(url === '/.well-known/assetlinks.json') {
    try { res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(fs.readFileSync(path.join(__dirname,'public','.well-known','assetlinks.json'))); } catch(e){res.writeHead(404);res.end();}
    return;
  }
  
  if(url === '/privacy' || url === '/privacy.html') {
    try {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'privacy.html')));
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  if(url === '/terms' || url === '/terms.html') {
    try {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'terms.html')));
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  if(url === '/landing' || url === '/landing.html') {
    if(!db.visits) db.visits = 0;
    db.visits++;
    dirty = true;
    try {
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'landing.html')));
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  if(url === '/admin') {
    try {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'admin.html')));
    } catch(e) { res.writeHead(500); res.end('Admin error: '+e.message); }
    return;
  }

  if(url === '/') {
    // Track site visit
    if(!db.visits) db.visits = 0;
    db.visits++;
    dirty = true;
    res.writeHead(302, {'Location':'/landing'});
    res.end();
    return;
  }

  if(url === '/index.html' || url === '/app') {
    try {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(fs.readFileSync(path.join(__dirname,'index.html')));
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
        if (!ok) console.log('[VERIFY] Email failed — code for '+email+': '+code);
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok: true, emailSent: ok, dev: !ok }));
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

  // ── CONFIRM PAYMENT (called by client on success redirect) ───
  if (url.startsWith('/confirm-payment') && req.method === 'GET') {
    const qs = require('url').parse(req.url, true).query;
    const sessionId = qs.session_id;
    if (!sessionId) { res.writeHead(400); res.end('Missing session_id'); return; }
    (async () => { try {
      const cfg = getCfg();
      const stripe = require('stripe')(cfg.stripe_secret_key);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const payment = (db.payments||[]).find(p=>p.sessionId===sessionId);
      if (payment) {
        payment.paymentIntentId = session.payment_intent || null;
        if (payment.type === 'escrow') {
          // For escrow, funds are authorized but not captured yet
          payment.status = session.payment_intent ? 'authorized' : payment.status;
        } else {
          payment.status = session.payment_status === 'paid' ? 'paid' : payment.status;
        }
        saveDB();
      }
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ ok:true, status: payment?.status||'unknown', type: payment?.type||'payment' }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ error: e.message }));
    }})();
    return;
  }

  // ── REFUND REQUEST (submitted by user) ───────────────────────
  if (url === '/refund-request' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sessionId, requesterName, reason } = JSON.parse(body);
        if (!sessionId || !reason) { res.writeHead(400); res.end('Missing fields'); return; }
        const payment = (db.payments||[]).find(p=>p.sessionId===sessionId);
        if (!payment) { res.writeHead(404); res.end('Payment not found'); return; }
        if (!db.refundRequests) db.refundRequests = [];
        const existing = db.refundRequests.find(r=>r.sessionId===sessionId&&r.status==='pending');
        if (existing) { res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({ok:true,alreadySubmitted:true})); return; }
        db.refundRequests.unshift({ id:Date.now(), sessionId, requesterName, reason, payment, status:'pending', date:new Date().toISOString() });
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:true }));
      } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    });
    return;
  }

  // ── GET REFUND REQUESTS (admin) ───────────────────────────────
  if (url === '/refund-requests' && req.method === 'GET') {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8')); } catch(e){}
    const token = req.headers['x-admin-token'];
    if (cfg.bulletin_token && token !== cfg.bulletin_token) { res.writeHead(401); res.end('Unauthorized'); return; }
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(db.refundRequests||[]));
    return;
  }

  // ── PROCESS REFUND (admin approves) ──────────────────────────
  if (url === '/process-refund' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8')); } catch(e){}
        const token = req.headers['x-admin-token'];
        if (cfg.bulletin_token && token !== cfg.bulletin_token) { res.writeHead(401); res.end('Unauthorized'); return; }
        const { refundId, action } = JSON.parse(body); // action: 'approve' | 'deny'
        const refReq = (db.refundRequests||[]).find(r=>r.id===refundId);
        if (!refReq) { res.writeHead(404); res.end('Refund request not found'); return; }
        if (action === 'deny') {
          refReq.status = 'denied';
          saveDB();
          res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ ok:true, status:'denied' }));
          return;
        }
        // Approve: get payment intent and issue Stripe refund
        const stripe = require('stripe')(cfg.stripe_secret_key);
        let paymentIntentId = refReq.payment?.paymentIntentId;
        if (!paymentIntentId) {
          // Retrieve from Stripe session
          const session = await stripe.checkout.sessions.retrieve(refReq.sessionId);
          paymentIntentId = session.payment_intent;
        }
        if (!paymentIntentId) { res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({error:'No payment intent found — payment may not have completed.'})); return; }
        const refund = await stripe.refunds.create({ payment_intent: paymentIntentId });
        refReq.status = 'refunded';
        refReq.stripeRefundId = refund.id;
        refReq.refundedAt = new Date().toISOString();
        // Update payment record
        const payment = (db.payments||[]).find(p=>p.sessionId===refReq.sessionId);
        if (payment) { payment.status = 'refunded'; payment.stripeRefundId = refund.id; }
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:true, status:'refunded', refundId: refund.id }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── BULLETIN BOARD ──────────────────────────────────────────
  // GET /bulletin → return all posts
  if (url === '/bulletin' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(db.bulletin || []));
    return;
  }

  // POST /bulletin → add a post (requires admin token)
  if (url === '/bulletin' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8')); } catch(e){}
        const token = req.headers['x-admin-token'];
        if (cfg.bulletin_token && token !== cfg.bulletin_token) {
          res.writeHead(401); res.end('Unauthorized'); return;
        }
        const { content, fontSize, color, image, pinned } = JSON.parse(body);
        if (!content) { res.writeHead(400); res.end('Content required'); return; }
        if (!db.bulletin) db.bulletin = [];
        const post = { id: Date.now(), content, fontSize: fontSize||'14', color: color||'#e8e6f0', image: image||null, pinned: !!pinned, date: new Date().toISOString() };
        if (pinned) db.bulletin.unshift(post); else db.bulletin.push(post);
        saveDB();
        broadcast({ type:'update', key:'bulletin', val:db.bulletin });
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok:true, post }));
      } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    });
    return;
  }

  // DELETE /bulletin/:id → remove a post
  if (url.startsWith('/bulletin/') && req.method === 'DELETE') {
    try {
      const cfg = getCfg();
      const token = req.headers['x-admin-token'];
      if (cfg.bulletin_token && token !== cfg.bulletin_token) {
        res.writeHead(401); res.end('Unauthorized'); return;
      }
      const postId = parseInt(url.split('/')[2]);
      db.bulletin = (db.bulletin||[]).filter(p => p.id !== postId);
      saveDB();
      broadcast({ type:'update', key:'bulletin', val:db.bulletin });
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ ok:true }));
    } catch(e) { res.writeHead(500); res.end('Error: '+e.message); }
    return;
  }

  // ── STRIPE CONFIG: expose publishable key to frontend ────────
  if (url === '/stripe-config' && req.method === 'GET') {
    const cfg = getCfg();
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({ publishableKey: cfg.stripe_publishable_key || '' }));
    return;
  }

  // ── STRIPE CONNECT: create embedded account session ──────────
  // POST /create-account-session { username } → returns { clientSecret }
  if (url === '/create-account-session' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = getCfg();
        if (!cfg.stripe_secret_key || cfg.stripe_secret_key.includes('YOUR_STRIPE')) {
          res.writeHead(503, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Stripe not configured.' })); return;
        }
        const stripe = require('stripe')(cfg.stripe_secret_key);
        const { username } = JSON.parse(body);
        if (!username) { res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({error:'Missing username'})); return; }

        if (!db.users) db.users = [];
        let user = db.users.find(u => u.name === username);
        if (!user) {
          user = { name: username, id: 'u_' + Date.now() };
          db.users.push(user);
          saveDB();
        }

        let accountId = user.stripeConnectId;
        if (!accountId) {
          const account = await stripe.accounts.create({ type: 'express', country: 'US', capabilities: { transfers: { requested: true } } });
          accountId = account.id;
          user.stripeConnectId = accountId;
          user.stripeConnectStatus = 'pending';
          saveDB();
          broadcast({ type:'update', key:'users', val:db.users });
        }

        const accountSession = await stripe.accountSessions.create({
          account: accountId,
          components: { account_onboarding: { enabled: true } },
        });
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ clientSecret: accountSession.client_secret }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── STRIPE CONNECT: worker onboarding ───────────────────────
  // POST /connect-onboard  { username } → returns { url } for Stripe Express onboarding
  if (url === '/connect-onboard' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = getCfg();
        if (!cfg.stripe_secret_key || cfg.stripe_secret_key.includes('YOUR_STRIPE')) {
          res.writeHead(503, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Stripe not configured.' })); return;
        }
        const stripe = require('stripe')(cfg.stripe_secret_key);
        const { username } = JSON.parse(body);
        if (!username) { res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({error:'Missing username'})); return; }

        // Find or create user record for this worker
        if (!db.users) db.users = [];
        let user = db.users.find(u => u.name === username);
        if (!user) {
          // User exists in client localStorage but not yet synced to server — create minimal record
          user = { name: username, id: 'u_' + Date.now() };
          db.users.push(user);
          saveDB();
        }

        let accountId = user.stripeConnectId;
        if (!accountId) {
          const account = await stripe.accounts.create({ type: 'express', country: 'US', capabilities: { transfers: { requested: true } } });
          accountId = account.id;
          user.stripeConnectId = accountId;
          user.stripeConnectStatus = 'pending';
          saveDB();
          broadcast({ type:'update', key:'users', val:db.users });
        }

        const appUrl = cfg.app_url || 'http://localhost:3000';
        const accountLink = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: appUrl + '/index.html?connect=refresh',
          return_url:  appUrl + '/index.html?connect=success',
          type: 'account_onboarding',
        });
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ url: accountLink.url }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /connect-status?username=X → { connected: bool, status }
  if (url === '/connect-status' && req.method === 'GET') {
    (async () => { try {
      const qs = require('url').parse(req.url, true).query;
      const username = qs.username;
      if (!username) { res.writeHead(400); res.end('Missing username'); return; }
      const user = (db.users||[]).find(u => u.name === username);
      if (!user || !user.stripeConnectId) {
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ connected: false })); return;
      }
      const cfg = getCfg();
      const stripe = require('stripe')(cfg.stripe_secret_key);
      const account = await stripe.accounts.retrieve(user.stripeConnectId);
      const connected = account.charges_enabled && account.payouts_enabled;
      user.stripeConnectStatus = connected ? 'active' : 'pending';
      saveDB();
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ connected, status: user.stripeConnectStatus, accountId: user.stripeConnectId }));
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ error: e.message }));
    }})();
    return;
  }

  // ── ESCROW: authorize funds when hirer accepts a worker ─────
  // POST /create-escrow { jobId, jobTitle, workerName, hirerId, amount }
  if (url === '/create-escrow' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = getCfg();
        if (!cfg.stripe_secret_key || cfg.stripe_secret_key.includes('YOUR_STRIPE')) {
          res.writeHead(503, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Stripe not configured.' })); return;
        }
        let stripe;
        try { stripe = require('stripe')(cfg.stripe_secret_key); } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Stripe package not installed. Run: npm install' })); return;
        }
        const { jobId, jobTitle, workerName, hirerId, amount } = JSON.parse(body);
        const amountCents = Math.round(parseFloat(amount) * 100);
        if (!amountCents || amountCents < 50) {
          res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Amount must be at least $0.50' })); return;
        }
        if (amountCents > 20000) {
          res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Amount cannot exceed $200' })); return;
        }
        const PLATFORM_FEE = 0.07;
        const feeCents = Math.round(amountCents * PLATFORM_FEE);
        const appUrl = cfg.app_url || 'http://localhost:3000';

        // Look up worker's Stripe Connect account
        const workerUser = (db.users||[]).find(u => u.name === workerName);
        const workerConnectId = workerUser?.stripeConnectId && workerUser?.stripeConnectStatus === 'active'
          ? workerUser.stripeConnectId : null;

        const sessionParams = {
          payment_method_types: ['card'],
          line_items: [
            { price_data: { currency:'usd', product_data:{ name: jobTitle||'DAYWORK Job', description:'Worker: '+workerName+' — funds held until job is complete' }, unit_amount: amountCents }, quantity:1 },
            { price_data: { currency:'usd', product_data:{ name: 'DAYWORK Platform Fee (7%)' }, unit_amount: feeCents }, quantity:1 }
          ],
          mode: 'payment',
          payment_intent_data: {
            capture_method: 'manual',  // hold funds, don't capture yet
            metadata: { jobId: String(jobId), workerName, hirerId, type:'escrow' }
          },
          success_url: appUrl+'/index.html?escrow=success&session_id={CHECKOUT_SESSION_ID}&job_id='+encodeURIComponent(jobId)+'&worker='+encodeURIComponent(workerName),
          cancel_url:  appUrl+'/index.html?escrow=cancelled',
          metadata: { jobId: String(jobId), workerName, hirerId, type:'escrow' }
        };
        if (workerConnectId) {
          sessionParams.payment_intent_data.application_fee_amount = feeCents;
          sessionParams.payment_intent_data.transfer_data = { destination: workerConnectId };
        }
        const session = await stripe.checkout.sessions.create(sessionParams);

        if (!db.payments) db.payments = [];
        db.payments.unshift({
          sessionId: session.id,
          type: 'escrow',
          jobId, jobTitle, workerName, hirerId,
          amount: amountCents/100,
          fee: feeCents/100,
          total: (amountCents+feeCents)/100,
          status: 'pending_auth',
          workerPaidDirect: !!workerConnectId,
          date: new Date().toISOString()
        });
        if (db.payments.length > 1000) db.payments = db.payments.slice(0,1000);
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ url: session.url }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // POST /release-payment { jobId, workerName } → capture held funds → pay worker
  if (url === '/release-payment' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = getCfg();
        const stripe = require('stripe')(cfg.stripe_secret_key);
        const { jobId, workerName } = JSON.parse(body);
        const payment = (db.payments||[]).find(p => p.type==='escrow' && String(p.jobId)===String(jobId) && p.workerName===workerName && p.status==='authorized');
        if (!payment) {
          res.writeHead(404, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'No authorized escrow payment found for this job.' })); return;
        }
        let paymentIntentId = payment.paymentIntentId;
        if (!paymentIntentId) {
          const session = await stripe.checkout.sessions.retrieve(payment.sessionId);
          paymentIntentId = session.payment_intent;
        }
        if (!paymentIntentId) {
          res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Payment intent not found — escrow may not have been authorized.' })); return;
        }
        await stripe.paymentIntents.capture(paymentIntentId);
        payment.status = 'captured';
        payment.capturedAt = new Date().toISOString();
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── STRIPE PAYMENT ──────────────────────────────────────────
  // POST /create-payment → create Stripe Checkout Session
  if (url === '/create-payment' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config.json'),'utf8')); } catch(e){}
        if (!cfg.stripe_secret_key || cfg.stripe_secret_key.includes('YOUR_STRIPE')) {
          res.writeHead(503, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Stripe not configured. Add your stripe_secret_key to config.json.' }));
          return;
        }
        let stripe;
        try { stripe = require('stripe')(cfg.stripe_secret_key); } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ error:'Stripe package not installed. Run: npm install' }));
          return;
        }
        const { amount, tip, jobTitle, workerName, hirerId } = JSON.parse(body);
        const workerAmountCents = Math.round(parseFloat(amount) * 100);
        if (!workerAmountCents || workerAmountCents < 50) {
          res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({error:'Amount must be at least $0.50'})); return;
        }
        const PLATFORM_FEE = 0.07; // 7% platform fee
        const feeCents = Math.round(workerAmountCents * PLATFORM_FEE);
        const tipCents = tip ? Math.round(parseFloat(tip) * 100) : 0;
        const appUrl = cfg.app_url || 'http://localhost:3000';
        const lineItems = [
          { price_data: { currency:'usd', product_data:{ name: jobTitle||'DAYWORK Job', description:'Worker: '+workerName }, unit_amount: workerAmountCents }, quantity:1 },
          { price_data: { currency:'usd', product_data:{ name: 'DAYWORK Platform Fee (7%)', description:'Service fee' }, unit_amount: feeCents }, quantity:1 }
        ];
        if (tipCents >= 50) {
          lineItems.push({ price_data: { currency:'usd', product_data:{ name: 'Tip for '+workerName, description:'100% goes to the worker' }, unit_amount: tipCents }, quantity:1 });
        }

        // Look up worker's Stripe Connect account
        const workerUser = (db.users||[]).find(u => u.name === workerName);
        const workerConnectId = workerUser?.stripeConnectId && workerUser?.stripeConnectStatus === 'active'
          ? workerUser.stripeConnectId : null;

        // Build session — if worker has Connect, add transfer_data so funds go to them (minus platform fee)
        const sessionParams = {
          payment_method_types: ['card'],
          line_items: lineItems,
          mode: 'payment',
          success_url: appUrl+'/index.html?payment=success&session_id={CHECKOUT_SESSION_ID}',
          cancel_url: appUrl+'/index.html?payment=cancelled',
          metadata: { jobTitle, workerName, hirerId, workerConnectId: workerConnectId||'' }
        };
        if (workerConnectId) {
          sessionParams.payment_intent_data = {
            application_fee_amount: feeCents,
            transfer_data: { destination: workerConnectId }
          };
        }
        const session = await stripe.checkout.sessions.create(sessionParams);
        // Store payment record
        if (!db.payments) db.payments = [];
        db.payments.unshift({
          sessionId: session.id,
          jobTitle, workerName, hirerId,
          amount: workerAmountCents/100,
          tip: tipCents/100,
          fee: feeCents/100,
          total: (workerAmountCents+feeCents+tipCents)/100,
          status: 'pending',
          workerPaidDirect: !!workerConnectId,
          date: new Date().toISOString()
        });
        if (db.payments.length > 1000) db.payments = db.payments.slice(0,1000);
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ url: session.url }));
      } catch(e) {
        res.writeHead(500, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // OPTIONS for bulletin and payment
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE','Access-Control-Allow-Headers':'Content-Type,x-admin-token'});
    res.end(); return;
  }

  // ── REGISTER USER (called on signup to ensure server has the account) ───
  // POST /register-user  body: {id, email, name, password, ...}
  if (url === '/register-user' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const user = JSON.parse(body);
        if (!user.email || !user.name) { res.writeHead(400); res.end('Bad request'); return; }
        if (!db.users) db.users = [];
        const exists = db.users.find(u => u.email && u.email.toLowerCase() === user.email.toLowerCase());
        if (!exists) {
          db.users.push(user);
          dirty = true;
        }
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500); res.end('Error: '+e.message);
      }
    });
    return;
  }

  // ── FORGOT PASSWORD ──────────────────────────────────────────
  // POST /forgot-password  body: {email}
  if (url === '/forgot-password' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { email, user: clientUser } = JSON.parse(body);
        console.log('[RESET] Request for:', email, '| clientUser provided:', !!clientUser);
        // Always respond OK — never reveal whether email is registered
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        if (email) {
          if (!db.users) db.users = [];
          let user = db.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
          console.log('[RESET] Found in db.users:', !!user, '| db.users count:', db.users.length);
          // If not in server db but client sent local user data, register and use it
          if (!user && clientUser && clientUser.email && clientUser.email.toLowerCase() === email.toLowerCase()) {
            db.users.push(clientUser);
            dirty = true;
            user = clientUser;
            console.log('[RESET] Registered from client data');
          }
          if (user) {
            const crypto = require('crypto');
            const token = crypto.randomBytes(32).toString('hex');
            if (!db.resetTokens) db.resetTokens = [];
            db.resetTokens = db.resetTokens.filter(t => t.email !== email.toLowerCase());
            db.resetTokens.push({ token, email: email.toLowerCase(), expires: Date.now() + 15*60*1000 });
            saveDB();
            const cfg = getCfg();
            const resetUrl = `${cfg.app_url}?reset=${token}`;
            console.log('[RESET] Token generated, sending email to:', email, '| notify available:', !!notify);
            let notify2;
            try { notify2 = require('./notify'); } catch(e) { console.log('[RESET] notify load error:', e.message); notify2 = null; }
            if (notify2) {
              const subject = '⚡ DAYWORK — Reset your password';
              const html = `
                <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0f0f0f;color:#f0ede8;padding:28px;border-radius:12px">
                  <h2 style="color:#e8c547;margin-bottom:8px">⚡ DAYWORK</h2>
                  <h3 style="margin-bottom:16px">Reset your password</h3>
                  <p style="color:#aaa;margin-bottom:20px">Hi ${user.name}, click the button below to reset your password. This link expires in 15 minutes.</p>
                  <a href="${resetUrl}" style="display:inline-block;background:#e8c547;color:#0f0f0f;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Reset Password →</a>
                  <p style="color:#555;font-size:12px;margin-top:20px">If you didn't request this, you can safely ignore this email.</p>
                </div>`;
              const sent = await notify2.sendEmail(email, subject, html);
              console.log('[RESET] Email send result:', sent);
            } else {
              console.log('[RESET] No notify — reset URL:', resetUrl);
            }
          } else {
            console.log('[RESET] No user found, skipping email');
          }
        }
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500); res.end('Error: '+e.message);
      }
    });
    return;
  }

  // ── RESET PASSWORD ───────────────────────────────────────────
  // POST /reset-password  body: {token, password}
  if (url === '/reset-password' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { token, password } = JSON.parse(body);
        if (!token || !password || password.length < 6) {
          res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ ok:false, error:'Invalid request.' })); return;
        }
        if (!db.resetTokens) db.resetTokens = [];
        const entry = db.resetTokens.find(t => t.token === token);
        if (!entry || Date.now() > entry.expires) {
          res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ ok:false, error:'Reset link is invalid or expired. Please request a new one.' })); return;
        }
        const users = db.users || [];
        const idx = users.findIndex(u => u.email && u.email.toLowerCase() === entry.email);
        if (idx === -1) {
          res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
          res.end(JSON.stringify({ ok:false, error:'Account not found.' })); return;
        }
        db.users[idx].password = password;
        db.resetTokens = db.resetTokens.filter(t => t.token !== token);
        saveDB();
        res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500); res.end('Error: '+e.message);
      }
    });
    return;
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
  // Ensure users are included in init
    if(!db.users) db.users = [];
    if(!db.bulletin) db.bulletin = [];
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
          // Detect newly posted jobs and notify all seekers
          if (notify && db.jobs && Array.isArray(db.jobs)) {
            const oldIds = new Set(db.jobs.map(j => j.id));
            msg.val.forEach(newJob => {
              if (!oldIds.has(newJob.id)) {
                console.log(`[NOTIFY] New job posted: "${newJob.title}" by ${newJob.postedBy}`);
                notifySeekersNewJob(newJob);
              }
            });
          }
          db.jobs = msg.val;
          dirty = true;
        }
        else if(msg.key === 'ratings') { db.ratings = msg.val; dirty = true; }
        else if(msg.key === 'users' && Array.isArray(msg.val)) {
          const existingNames = new Set((db.users||[]).map(u=>u.name));
          const newCount = msg.val.filter(u=>u.name && !existingNames.has(u.name)).length;
          if(newCount > 0) db.totalSignups = (db.totalSignups||0) + newCount;
          db.users = msg.val;
          dirty = true;
        }
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
