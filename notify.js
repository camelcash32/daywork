// ── DAYWORK NOTIFICATION SERVICE (Resend) ────────────────────
const fs = require('fs');
const path = require('path');
const https = require('https');

function loadConfig() {
  let cfg = {};
  try {
    const configPath = path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch(e) {}
  return {
    resend_api_key: process.env.RESEND_API_KEY || cfg.resend_api_key || '',
    email_from:     process.env.EMAIL_FROM     || cfg.email_from     || 'DAYWORK <noreply@godaywork.com>',
  };
}

// ── Send email via Resend API ─────────────────────────────────
async function sendEmail(to, subject, html) {
  const config = loadConfig();
  if (!config.resend_api_key) {
    console.log('[NOTIFY] Resend not configured — skipping email to', to);
    return false;
  }

  const fromAddr = config.email_from || 'DAYWORK <onboarding@resend.dev>';

  const payload = JSON.stringify({
    from: fromAddr,
    to: [to],
    subject,
    html
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.resend_api_key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log(`[NOTIFY] ✅ Email sent to ${to}`);
          resolve(true);
        } else {
          console.error(`[NOTIFY] ❌ Resend error ${res.statusCode}:`, data);
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      console.error('[NOTIFY] ❌ Request error:', e.message);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

// ── Notification functions ────────────────────────────────────
async function notifyJobAccepted({ job, workerName, posterName }) {
  const results = { email: false };
  const jobTitle = job.title || 'your job';

  if (job.notifyEmail && job.notifyEmailAddr) {
    const subject = `⚡ DAYWORK: ${workerName} accepted your job!`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0f0f0f;color:#f0ede8;padding:24px;border-radius:12px">
        <h2 style="color:#e8c547;margin-bottom:8px">⚡ DAYWORK</h2>
        <h3 style="margin-bottom:16px">Someone accepted your job!</h3>
        <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="color:#aaa;margin-bottom:4px">Job</p>
          <p style="font-weight:700;font-size:16px">${jobTitle}</p>
        </div>
        <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="color:#aaa;margin-bottom:4px">Worker</p>
          <p style="font-weight:700;font-size:16px;color:#22c55e">✓ ${workerName}</p>
        </div>
        <p style="color:#555;font-size:13px">Log in to DAYWORK to chat and confirm details.</p>
        <a href="https://www.godaywork.com" style="display:inline-block;background:#e8c547;color:#0f0f0f;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">Open DAYWORK →</a>
      </div>`;
    results.email = await sendEmail(job.notifyEmailAddr, subject, html);
  }
  return results;
}

async function notifyJobApplied({ job, workerName }) {
  const results = { email: false };
  const jobTitle = job.title || 'your job';

  if (job.notifyEmail && job.notifyEmailAddr) {
    const subject = `⚡ DAYWORK: New applicant for "${jobTitle}"`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0f0f0f;color:#f0ede8;padding:24px;border-radius:12px">
        <h2 style="color:#e8c547;margin-bottom:8px">⚡ DAYWORK</h2>
        <h3 style="margin-bottom:16px">New applicant on your job!</h3>
        <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="color:#aaa;margin-bottom:4px">Job</p>
          <p style="font-weight:700;font-size:16px">${jobTitle}</p>
        </div>
        <div style="background:#1a1a1a;border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="color:#aaa;margin-bottom:4px">Applicant</p>
          <p style="font-weight:700;font-size:16px;color:#a78bfa">${workerName} applied</p>
        </div>
        <a href="https://www.godaywork.com" style="display:inline-block;background:#e8c547;color:#0f0f0f;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px">Review Applicant →</a>
      </div>`;
    results.email = await sendEmail(job.notifyEmailAddr, subject, html);
  }
  return results;
}

module.exports = { sendEmail, notifyJobAccepted, notifyJobApplied };
