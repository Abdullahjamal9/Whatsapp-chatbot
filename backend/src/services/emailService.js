const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const Message = require('../models/Message');
const { Op } = require('sequelize');

const GENERAL_SETTINGS_PATH = path.join(__dirname, '../../.general-settings.json');

function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT  || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeEmail(value = '') {
  const v = String(value || '').trim().toLowerCase();
  if (!v || !v.includes('@')) return '';
  return v;
}

function getAdminMeetingRecipient() {
  try {
    if (fs.existsSync(GENERAL_SETTINGS_PATH)) {
      const settings = JSON.parse(fs.readFileSync(GENERAL_SETTINGS_PATH, 'utf8')) || {};
      const fromSettings = normalizeEmail(settings.email || '');
      if (fromSettings) return fromSettings;
    }
  } catch (e) {
    console.error('Could not read general settings for admin email:', e.message);
  }

  return normalizeEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER || '');
}

/**
 * Send the last 24-hour conversation history to the user's email.
 * Fetches messages (both directions) for the given phone number within last 24h.
 */
async function sendConversationHistory(userProfile) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('⚠️  Email not configured (SMTP_USER/SMTP_PASS missing) — skipping');
    return false;
  }
  if (!userProfile || !userProfile.email) {
    console.log('⚠️  No email address on profile — skipping conversation email');
    return false;
  }

  // Only fetch messages from the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Fetch messages: incoming (from user) OR outgoing (to user) within 24h
  const messages = await Message.findAll({
    where: {
      [Op.or]: [
        { from: userProfile.phoneNumber },
        { to:   userProfile.phoneNumber }
      ],
      timestamp: { [Op.gte]: since }
    },
    order: [['timestamp', 'ASC']]
  });

  if (!messages.length) {
    console.log('⚠️  No messages found — skipping conversation email');
    return false;
  }

  const botName = process.env.BRAND_NAME || process.env.BOT_NAME || 'PTIS Chatbot';

  // Build message rows
  const rows = messages.map(m => {
    const isBot    = m.from !== userProfile.phoneNumber;
    const sender   = isBot ? `🤖 ${escapeHtml(botName)}` : `👤 ${escapeHtml(userProfile.name || 'You')}`;
    const bgColor  = isBot ? '#1c2333' : '#1a2f1e';
    const border   = isBot ? '#3d4f6e' : '#2d5a35';
    const bodyHtml = escapeHtml(m.body).replace(/\n/g, '<br>');

    return `
      <tr>
        <td style="padding:5px 8px;">
          <div style="background:${bgColor};border:1px solid ${border};border-radius:10px;padding:10px 14px;">
            <div style="font-size:11px;color:#8b949e;margin-bottom:5px;display:flex;justify-content:space-between;">
              <span style="font-weight:600;">${sender}</span>
              <span>${formatDate(m.timestamp)}</span>
            </div>
            <div style="font-size:14px;color:#e6edf3;line-height:1.5;">${bodyHtml}</div>
          </div>
        </td>
      </tr>`;
  }).join('');

  const first = messages[0];
  const last  = messages[messages.length - 1];

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:20px;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:620px;margin:0 auto;background:#161b22;border-radius:16px;overflow:hidden;border:1px solid #30363d;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#25D366 0%,#128C7E 100%);padding:26px 28px;">
      <div style="font-size:24px;font-weight:700;color:#fff;margin-bottom:4px;">💬 Conversation Summary</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.85);">
        ${formatDate(first.timestamp)} &ndash; ${formatDate(last.timestamp)}
      </div>
    </div>

    <!-- Profile Info -->
    <div style="padding:22px 28px;border-bottom:1px solid #30363d;">
      <div style="font-size:11px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:14px;">
        Contact Details
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:5px 0;color:#8b949e;font-size:13px;width:130px;">Name</td>
          <td style="padding:5px 0;color:#e6edf3;font-size:13px;font-weight:500;">${escapeHtml(userProfile.name || '—')}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#8b949e;font-size:13px;">Designation</td>
          <td style="padding:5px 0;color:#e6edf3;font-size:13px;font-weight:500;">${escapeHtml(userProfile.designation || '—')}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#8b949e;font-size:13px;">Phone</td>
          <td style="padding:5px 0;color:#e6edf3;font-size:13px;font-weight:500;">${escapeHtml(userProfile.contactPhone || userProfile.phoneNumber)}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#8b949e;font-size:13px;">Email</td>
          <td style="padding:5px 0;color:#e6edf3;font-size:13px;font-weight:500;">${escapeHtml(userProfile.email)}</td>
        </tr>
        <tr>
          <td style="padding:5px 0;color:#8b949e;font-size:13px;">Total Messages</td>
          <td style="padding:5px 0;color:#e6edf3;font-size:13px;font-weight:500;">${messages.length}</td>
        </tr>
      </table>
    </div>

    <!-- Conversation -->
    <div style="padding:20px 16px;">
      <div style="font-size:11px;font-weight:700;color:#8b949e;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:14px;padding:0 8px;">
        Conversation History
      </div>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
    </div>

    <!-- Footer -->
    <div style="padding:16px 28px;border-top:1px solid #30363d;text-align:center;">
      <div style="font-size:12px;color:#8b949e;">
        Sent automatically by <strong style="color:#e6edf3;">${escapeHtml(botName)}</strong>
      </div>
    </div>

  </div>
</body>
</html>`;

  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from:    `"${botName}" <${process.env.SMTP_USER}>`,
      to:      userProfile.email,
      subject: `Your last 24h conversation summary — ${formatDate(new Date())}`,
      html
    });
    console.log(`📧 Conversation history sent to ${userProfile.email}`);
    return true;
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    return false;
  }
}

async function sendMeetingConfirmation(userProfile, meeting) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  if (!userProfile || !userProfile.email) return false;

  const transporter = createTransporter();
  const hostEmail = getAdminMeetingRecipient();
  const subject = `Meeting confirmed: ${meeting.topic} — ${formatDate(meeting.slotStart)}`;
  const html = `<!doctype html><html><body>
    <p>Hi ${escapeHtml(userProfile.name || 'there')},</p>
    <p>Your meeting has been scheduled for <strong>${escapeHtml(formatDate(meeting.slotStart))}</strong>.</p>
    <p>Topic: ${escapeHtml(meeting.topic || '')}</p>
    <p>Host Email: ${escapeHtml(hostEmail || '—')}</p>
    <p>Join Link: <a href="${escapeHtml(meeting.zoomJoinUrl || '')}">${escapeHtml(meeting.zoomJoinUrl || '')}</a></p>
    <p>Meeting ID: ${escapeHtml(meeting.zoomMeetingId || '')}</p>
    <p>Thanks,<br/>${escapeHtml(process.env.BRAND_NAME || process.env.BOT_NAME || 'PTIS Chatbot')}</p>
  </body></html>`;

  try {
    await transporter.sendMail({
      from: `"${process.env.BRAND_NAME || process.env.BOT_NAME}" <${process.env.SMTP_USER}>`,
      to: userProfile.email,
      subject,
      html
    });
    return true;
  } catch (e) {
    console.error('Meeting confirmation email failed:', e.message);
    return false;
  }
}

async function sendAdminMeetingNotification(meeting, userProfile) {
  const admin = getAdminMeetingRecipient();
  if (!admin || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  const transporter = createTransporter();
  const hostEmail = getAdminMeetingRecipient();
  const subject = `New meeting booked: ${meeting.topic} — ${formatDate(meeting.slotStart)}`;
  const html = `<!doctype html><html><body>
    <p>A meeting was booked:</p>
    <ul>
      <li>Client: ${escapeHtml(userProfile?.name || meeting.phoneNumber)}</li>
      <li>Phone: ${escapeHtml(userProfile?.phoneNumber || meeting.phoneNumber)}</li>
      <li>Email: ${escapeHtml(userProfile?.email || '')}</li>
      <li>Host Email: ${escapeHtml(hostEmail || '—')}</li>
      <li>When: ${escapeHtml(formatDate(meeting.slotStart))}</li>
      <li>Link: <a href="${escapeHtml(meeting.zoomJoinUrl || '')}">${escapeHtml(meeting.zoomJoinUrl || '')}</a></li>
    </ul>
  </body></html>`;

  try {
    await transporter.sendMail({
      from: `"${process.env.BRAND_NAME || process.env.BOT_NAME}" <${process.env.SMTP_USER}>`,
      to: admin,
      subject,
      html
    });
    return true;
  } catch (e) {
    console.error('Admin meeting notification failed:', e.message);
    return false;
  }
}

async function sendMeetingNotifications(meeting, userProfile) {
  const [clientSent, adminSent] = await Promise.all([
    sendMeetingConfirmation(userProfile, meeting),
    sendAdminMeetingNotification(meeting, userProfile)
  ]);

  return { clientSent, adminSent };
}

module.exports = {
  sendConversationHistory,
  sendMeetingConfirmation,
  sendAdminMeetingNotification,
  sendMeetingNotifications
};
