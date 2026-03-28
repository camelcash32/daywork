// ── DAYWORK NOTIFICATION SERVICE ─────────────────────────────
// Configure your credentials in config.json (never commit that file)

const fs = require('fs');
const path = require('path');

// Load config
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch(e) {}
  return {};
}

// ── EMAIL via Nodemailer (Gmail) ──────────────────────────────
async function sendEmail(to, subject, body) {
  const config = loadConfig();
  if (!config.gmail_user || !config.gmail_pass) {
    console.log('[NOTIFY] Email not configured — skipping email to', to);
    return false;
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.gmail_user,
        pass: config.gmail_pass  // Use Gmail App Password, not your real password
      }
    });
    await transporter.sendMail({
      from: `"⚡ DAYWORK" <${config.gmail_user}>`,
      to,
      subject,
      html: body
    });
    console.log(`[NOTIFY] ✅ Email sent to ${to}`);
    return true;
  } catch(e) {
    console.error('[NOTIFY] ❌ Email failed:', e.message);
    return false;
  }
}

// ── SMS via Twilio ────────────────────────────────────────────
async function sendSMS(to, message) {
  const config = loadConfig();
  if (!config.twilio_sid || !config.twilio_token || !config.twilio_from) {
    console.log('[NOTIFY] SMS not configured — skipping text to', to);
    return false;
  }
  try {
    const twilio = require('twilio');
    const client = twilio(config.twilio_sid, config.twilio_token);
    // Clean phone number — add +1 if no country code
    let phone = to.replace(/\D/g,'');
    if (phone.length === 10) phone = '+1' + phone;
    else if (!phone.startsWith('+')) phone = '+' + phone;
    await client.messages.create({
      body: message,
      from: config.twilio_from,
      to: phone
    });
    console.log(`[NOTIFY] ✅ SMS sent to ${to}`);
    return true;
  } catch(e) {
    console.error('[NOTIFY] ❌ SMS failed:', e.message);
    return false;
  }
}

// ── Main notification dispatcher ─────────────────────────────
async function notifyJobAccepted({ job, workerName, posterName }) {
  const results = { email: false, sms: false };
  const jobTitle = job.title || 'your job';

  // Email notification
  if (job.notifyEmail && job.notifyEmailAddr) {
    const subject = `⚡ DAYWORK: ${workerName} accepted your job!`;
    const body = `
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
        <p style="color:#555;font-size:13px">Log in to DAYWORK to chat with your worker and confirm details. Payment is handled directly between you.</p>
        <p style="color:#333;font-size:11px;margin-top:16px">⚡ DAYWORK — Same-day gigs, local workers</p>
      </div>
    `;
    results.email = await sendEmail(job.notifyEmailAddr, subject, body);
  }

  // SMS notification
  if (job.notifyText && job.notifyPhone) {
    const message = `⚡ DAYWORK: ${workerName} accepted your job "${jobTitle}"! Log in to chat and confirm. Payment handled directly.`;
    results.sms = await sendSMS(job.notifyPhone, message);
  }

  return results;
}

async function notifyJobApplied({ job, workerName }) {
  const results = { email: false, sms: false };
  const jobTitle = job.title || 'your job';

  if (job.notifyEmail && job.notifyEmailAddr) {
    const subject = `⚡ DAYWORK: New applicant for "${jobTitle}"`;
    const body = `
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
        <p style="color:#555;font-size:13px">Log in to DAYWORK to review their profile and hire or pass.</p>
        <p style="color:#333;font-size:11px;margin-top:16px">⚡ DAYWORK — Same-day gigs, local workers</p>
      </div>
    `;
    results.email = await sendEmail(job.notifyEmailAddr, subject, body);
  }

  if (job.notifyText && job.notifyPhone) {
    const message = `⚡ DAYWORK: ${workerName} applied to your job "${jobTitle}"! Log in to review and hire.`;
    results.sms = await sendSMS(job.notifyPhone, message);
  }

  return results;
}

module.exports = { notifyJobAccepted, notifyJobApplied, sendEmail, sendSMS };
