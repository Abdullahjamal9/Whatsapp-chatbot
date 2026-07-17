require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const { connectDB, sequelize } = require('./config/database');
const { Op } = require('sequelize');

const Message = require('./models/Message');
const Task = require('./models/Task');
const Conversation = require('./models/Conversation');
const UserProfile = require('./models/UserProfile');
const Meeting = require('./models/Meeting');
const zoomService = require('./services/zoomService');
const {
  readWebsiteSyncSettings,
  saveWebsiteSyncSettings,
  runWebsiteSync,
  startWebsiteSyncScheduler
} = require('./services/websiteSyncService');
const { findDictionaryTerm, matchDictionaryTermsInText, normalizeText: normalizeKeywordText } = require('./utils/keywordDictionary');

const ALLOWED_TABLES = {
  messages: Message,
  tasks: Task,
  conversations: Conversation,
  user_profiles: UserProfile
};

const TABLE_LABELS = {
  messages: 'Messages',
  tasks: 'Tasks',
  conversations: 'Conversations',
  user_profiles: 'User Profiles'
};

function stripIds(rows = []) {
  return rows.map(r => {
    const copy = { ...r };
    delete copy.id;
    return copy;
  });
}

function toCsv(rows = []) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  };
  const lines = [headers.join(',')];
  rows.forEach(r => {
    lines.push(headers.map(h => escape(r[h])).join(','));
  });
  return lines.join('\n');
}

// Store WhatsApp client reference (will be set by bot process)
let whatsappClient = null;

const NOTIFICATION_SETTINGS_PATH = path.join(__dirname, '../.notification-settings.json');
const BUSINESS_HOURS_SETTINGS_PATH = path.join(__dirname, '../.business-hours.json');
const GENERAL_SETTINGS_PATH = path.join(__dirname, '../.general-settings.json');
const BOT_BEHAVIOR_SETTINGS_PATH = path.join(__dirname, '../.bot-behavior.json');
const SECURITY_SETTINGS_PATH = path.join(__dirname, '../.security-settings.json');
const ADVANCED_SETTINGS_PATH = path.join(__dirname, '../.advanced-settings.json');
const AUTH_SETTINGS_PATH = path.join(__dirname, '../.auth-settings.json');
const NOTIFICATION_DEFAULTS = {
  desktopNotifications: true,
  soundAlerts: true,
  alertSoundType: 'ding',
  emailNotifications: false,
  newMessageAlert: true,
  taskUpdates: true,
  negativeSentimentAlert: true,
  dailySummary: false,
  updatedAt: null,
  lastDailySummarySentAt: null
};

const BUSINESS_HOURS_DEFAULTS = {
  monday:    { enabled: true,  start: '09:00', end: '18:00' },
  tuesday:   { enabled: true,  start: '09:00', end: '18:00' },
  wednesday: { enabled: true,  start: '09:00', end: '18:00' },
  thursday:  { enabled: true,  start: '09:00', end: '18:00' },
  friday:    { enabled: true,  start: '09:00', end: '18:00' },
  saturday:  { enabled: false, start: '10:00', end: '14:00' },
  sunday:    { enabled: false, start: '10:00', end: '14:00' }
};

const GENERAL_SETTINGS_DEFAULTS = {
  businessName: 'PTIS Chatbot',
  displayName: 'PTIS Chatbot Support',
  phone: '+92 300 1234567',
  email: 'support@ptischatbot.com',
  hrEmail: '',
  headOfficeAddress: '',
  regionalOffices: [],
  timezone: 'GMT',
  language: 'en',
  theme: 'dark',
  accentColor: '#25D366',
  compactMode: false
};

const BOT_BEHAVIOR_DEFAULTS = {
  enableAutoReply: true,
  welcomeMessage: 'Welcome to PTIS Chatbot! 👋 How can we help you today?',
  awayMessage: 'We\'re currently offline. Our team will respond during business hours (9 AM - 6 PM).',
  responseDelaySeconds: 2
};

const SECURITY_SETTINGS_DEFAULTS = {
  sessionTimeoutMinutes: '30',
  ipWhitelistEnabled: false,
  ipWhitelistEntries: [],
  loginNotifications: true,
  dataRetentionDays: '90',
  twoFactorEnabled: false,
  updatedAt: null
};

const ADVANCED_SETTINGS_DEFAULTS = {
  debugMode: false,
  apiRateLimit: 60,
  webhookRetry: true,
  maxRetryAttempts: 3,
  updatedAt: null
};

const AUTH_SETTINGS_DEFAULTS = {
  username: process.env.DASHBOARD_USER || 'admin',
  passwordHash: null,
  passwordSalt: null,
  passwordUpdatedAt: null
};

const AUTH_RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
const AUTH_RECOVERY_MAX_ATTEMPTS = 5;
const authRecoveryStore = new Map();
const AUTH_LOGIN_2FA_CODE_TTL_MS = 10 * 60 * 1000;
const AUTH_LOGIN_2FA_MAX_ATTEMPTS = 5;
const authLogin2FAStore = new Map();
const APP_BRAND = process.env.BRAND_NAME || process.env.BOT_NAME || 'PTIS Chatbot';

function normalizeIp(value = '') {
  let ip = String(value || '').trim();
  if (!ip) return '';
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function parseIpWhitelist(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(v => normalizeIp(v)).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(/[\n, ]+/).map(v => normalizeIp(v)).filter(Boolean))];
  }
  return [];
}

function normalizeDialCodes(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;/]+/)
      : [];

  const codes = list
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .map(v => v.replace(/\D/g, ''))
    .filter(Boolean);

  return [...new Set(codes)];
}

function normalizeRegionalOffices(entries = []) {
  const list = Array.isArray(entries) ? entries : [];

  return list
    .map(entry => {
      const country = typeof entry?.country === 'string' ? entry.country.trim().slice(0, 80) : '';
      const label = typeof entry?.label === 'string' ? entry.label.trim().slice(0, 80) : '';
      const phone = typeof entry?.phone === 'string' ? entry.phone.trim().slice(0, 60) : '';
      const city = typeof entry?.city === 'string' ? entry.city.trim().slice(0, 80) : '';
      const email = typeof entry?.email === 'string' ? entry.email.trim().slice(0, 160) : '';
      const address = typeof entry?.address === 'string' ? entry.address.trim().slice(0, 300) : '';
      const dialCodes = normalizeDialCodes(entry?.dialCodes ?? entry?.dialCode ?? entry?.countryCodes ?? entry?.countryCode);

      if (!country && !label && !phone && !city && !email && !address && dialCodes.length === 0) {
        return null;
      }

      return {
        country,
        label,
        phone,
        city,
        email,
        address,
        dialCodes
      };
    })
    .filter(Boolean);
}

function getClientIp(req) {
  return normalizeIp(
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    req.ip ||
    ''
  );
}

function isIpAllowed(req) {
  const settings = readSecuritySettings();
  if (!settings.ipWhitelistEnabled) return true;

  const allowed = new Set(parseIpWhitelist(settings.ipWhitelistEntries));
  // Always keep local access available to avoid dashboard lockout on same machine.
  allowed.add('127.0.0.1');

  const clientIp = getClientIp(req);
  return !!clientIp && allowed.has(clientIp);
}

function readBusinessHoursSettings() {
  try {
    if (!fs.existsSync(BUSINESS_HOURS_SETTINGS_PATH)) {
      return { ...BUSINESS_HOURS_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(BUSINESS_HOURS_SETTINGS_PATH, 'utf8'));
    return { ...BUSINESS_HOURS_DEFAULTS, ...(saved || {}) };
  } catch (e) {
    console.error('Failed to read business hours settings:', e.message);
    return { ...BUSINESS_HOURS_DEFAULTS };
  }
}

function writeBusinessHoursSettings(hours = {}) {
  const merged = { ...BUSINESS_HOURS_DEFAULTS, ...(hours || {}), updatedAt: new Date().toISOString() };
  fs.writeFileSync(BUSINESS_HOURS_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function readGeneralSettings() {
  try {
    if (!fs.existsSync(GENERAL_SETTINGS_PATH)) {
      return { ...GENERAL_SETTINGS_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(GENERAL_SETTINGS_PATH, 'utf8'));
    return { ...GENERAL_SETTINGS_DEFAULTS, ...(saved || {}) };
  } catch (e) {
    console.error('Failed to read general settings:', e.message);
    return { ...GENERAL_SETTINGS_DEFAULTS };
  }
}

function writeGeneralSettings(settings = {}) {
  const allowedThemes = ['dark', 'light', 'auto'];
  const allowedLanguages = ['en', 'ur', 'ar', 'es', 'fr'];
  const accent = typeof settings.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(settings.accentColor)
    ? settings.accentColor
    : GENERAL_SETTINGS_DEFAULTS.accentColor;

  const merged = {
    ...GENERAL_SETTINGS_DEFAULTS,
    businessName: typeof settings.businessName === 'string' && settings.businessName.trim()
      ? settings.businessName.trim().slice(0, 120)
      : GENERAL_SETTINGS_DEFAULTS.businessName,
    displayName: typeof settings.displayName === 'string' && settings.displayName.trim()
      ? settings.displayName.trim().slice(0, 120)
      : GENERAL_SETTINGS_DEFAULTS.displayName,
    phone: typeof settings.phone === 'string' && settings.phone.trim()
      ? settings.phone.trim().slice(0, 60)
      : GENERAL_SETTINGS_DEFAULTS.phone,
    email: typeof settings.email === 'string' && settings.email.trim()
      ? settings.email.trim().slice(0, 160)
      : GENERAL_SETTINGS_DEFAULTS.email,
    hrEmail: typeof settings.hrEmail === 'string' && settings.hrEmail.trim()
      ? settings.hrEmail.trim().slice(0, 160)
      : GENERAL_SETTINGS_DEFAULTS.hrEmail,
    headOfficeAddress: typeof settings.headOfficeAddress === 'string' && settings.headOfficeAddress.trim()
      ? settings.headOfficeAddress.trim().slice(0, 300)
      : GENERAL_SETTINGS_DEFAULTS.headOfficeAddress,
    regionalOffices: normalizeRegionalOffices(settings.regionalOffices || settings.regionalOfficeEntries || []),
    timezone: typeof settings.timezone === 'string' && settings.timezone.trim()
      ? settings.timezone.trim().slice(0, 60)
      : GENERAL_SETTINGS_DEFAULTS.timezone,
    language: allowedLanguages.includes(settings.language)
      ? settings.language
      : GENERAL_SETTINGS_DEFAULTS.language,
    theme: allowedThemes.includes(settings.theme)
      ? settings.theme
      : GENERAL_SETTINGS_DEFAULTS.theme,
    accentColor: accent,
    compactMode: !!settings.compactMode,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(GENERAL_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function readBotBehaviorSettings() {
  try {
    if (!fs.existsSync(BOT_BEHAVIOR_SETTINGS_PATH)) {
      return { ...BOT_BEHAVIOR_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(BOT_BEHAVIOR_SETTINGS_PATH, 'utf8'));
    return { ...BOT_BEHAVIOR_DEFAULTS, ...(saved || {}) };
  } catch (e) {
    console.error('Failed to read bot behavior settings:', e.message);
    return { ...BOT_BEHAVIOR_DEFAULTS };
  }
}

function writeBotBehaviorSettings(settings = {}) {
  const toInt = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const merged = {
    ...BOT_BEHAVIOR_DEFAULTS,
    enableAutoReply: settings.enableAutoReply !== undefined ? !!settings.enableAutoReply : BOT_BEHAVIOR_DEFAULTS.enableAutoReply,
    welcomeMessage: typeof settings.welcomeMessage === 'string' && settings.welcomeMessage.trim()
      ? settings.welcomeMessage.trim().slice(0, 2000)
      : BOT_BEHAVIOR_DEFAULTS.welcomeMessage,
    awayMessage: typeof settings.awayMessage === 'string' && settings.awayMessage.trim()
      ? settings.awayMessage.trim().slice(0, 2000)
      : BOT_BEHAVIOR_DEFAULTS.awayMessage,
    responseDelaySeconds: Math.min(60, Math.max(0, toInt(settings.responseDelaySeconds, BOT_BEHAVIOR_DEFAULTS.responseDelaySeconds))),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(BOT_BEHAVIOR_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function readSecuritySettings() {
  try {
    if (!fs.existsSync(SECURITY_SETTINGS_PATH)) {
      return { ...SECURITY_SETTINGS_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(SECURITY_SETTINGS_PATH, 'utf8'));
    return { ...SECURITY_SETTINGS_DEFAULTS, ...(saved || {}) };
  } catch (e) {
    console.error('Failed to read security settings:', e.message);
    return { ...SECURITY_SETTINGS_DEFAULTS };
  }
}

function writeSecuritySettings(settings = {}) {
  const allowedTimeouts = ['15', '30', '60', '120', 'never'];
  const allowedRetention = ['30', '90', '180', '365', 'forever'];
  const ipWhitelistEntries = parseIpWhitelist(settings.ipWhitelistEntries || settings.ipWhitelist || []);

  const merged = {
    ...SECURITY_SETTINGS_DEFAULTS,
    sessionTimeoutMinutes: allowedTimeouts.includes(String(settings.sessionTimeoutMinutes))
      ? String(settings.sessionTimeoutMinutes)
      : SECURITY_SETTINGS_DEFAULTS.sessionTimeoutMinutes,
    ipWhitelistEnabled: !!settings.ipWhitelistEnabled,
    ipWhitelistEntries,
    loginNotifications: settings.loginNotifications !== undefined
      ? !!settings.loginNotifications
      : SECURITY_SETTINGS_DEFAULTS.loginNotifications,
    dataRetentionDays: allowedRetention.includes(String(settings.dataRetentionDays))
      ? String(settings.dataRetentionDays)
      : SECURITY_SETTINGS_DEFAULTS.dataRetentionDays,
    twoFactorEnabled: !!settings.twoFactorEnabled,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(SECURITY_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function readAdvancedSettings() {
  try {
    if (!fs.existsSync(ADVANCED_SETTINGS_PATH)) {
      return { ...ADVANCED_SETTINGS_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(ADVANCED_SETTINGS_PATH, 'utf8'));
    return { ...ADVANCED_SETTINGS_DEFAULTS, ...(saved || {}) };
  } catch (e) {
    console.error('Failed to read advanced settings:', e.message);
    return { ...ADVANCED_SETTINGS_DEFAULTS };
  }
}

function writeAdvancedSettings(settings = {}) {
  const toInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const merged = {
    ...ADVANCED_SETTINGS_DEFAULTS,
    debugMode: !!settings.debugMode,
    apiRateLimit: Math.min(1000, Math.max(10, toInt(settings.apiRateLimit, ADVANCED_SETTINGS_DEFAULTS.apiRateLimit))),
    webhookRetry: settings.webhookRetry !== undefined
      ? !!settings.webhookRetry
      : ADVANCED_SETTINGS_DEFAULTS.webhookRetry,
    maxRetryAttempts: Math.min(10, Math.max(1, toInt(settings.maxRetryAttempts, ADVANCED_SETTINGS_DEFAULTS.maxRetryAttempts))),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(ADVANCED_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function readAuthSettings() {
  try {
    if (!fs.existsSync(AUTH_SETTINGS_PATH)) {
      return { ...AUTH_SETTINGS_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(AUTH_SETTINGS_PATH, 'utf8'));
    return { ...AUTH_SETTINGS_DEFAULTS, ...(saved || {}) };
  } catch (e) {
    console.error('Failed to read auth settings:', e.message);
    return { ...AUTH_SETTINGS_DEFAULTS };
  }
}

function writeAuthSettings(settings = {}) {
  const merged = {
    ...AUTH_SETTINGS_DEFAULTS,
    ...settings
  };
  fs.writeFileSync(AUTH_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyDashboardPassword(inputPassword, authSettings) {
  if (authSettings?.passwordHash && authSettings?.passwordSalt) {
    const computed = hashPassword(String(inputPassword || ''), authSettings.passwordSalt);
    return computed === authSettings.passwordHash;
  }

  const envPassword = process.env.DASHBOARD_PASSWORD || 'AdminPtis-3692';
  return String(inputPassword || '') === envPassword;
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizePhoneDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function getConfiguredRecoveryContacts() {
  const general = readGeneralSettings();
  const email = normalizeEmail(
    general?.email || process.env.ADMIN_EMAIL || process.env.SMTP_USER || ''
  );
  const phoneDigits = normalizePhoneDigits(
    general?.phone || process.env.ADMIN_PHONE || process.env.DASHBOARD_PHONE || ''
  );
  return { email, phoneDigits };
}

function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return '';
  if (name.length <= 2) return `${name[0] || '*'}***@${domain}`;
  return `${name[0]}***${name[name.length - 1]}@${domain}`;
}

function maskPhone(phoneDigits = '') {
  if (!phoneDigits) return '';
  const last4 = phoneDigits.slice(-4);
  return `***${last4}`;
}

function getRecoveryKey(method, destination) {
  return `${method}:${destination}`;
}

function getTwoFactorKey(username) {
  return `2fa:${String(username || '').trim().toLowerCase()}`;
}

function pruneRecoveryStore() {
  const now = Date.now();
  for (const [key, rec] of authRecoveryStore.entries()) {
    if (!rec?.expiresAt || rec.expiresAt <= now) {
      authRecoveryStore.delete(key);
    }
  }
}

function pruneTwoFactorStore() {
  const now = Date.now();
  for (const [key, rec] of authLogin2FAStore.entries()) {
    if (!rec?.expiresAt || rec.expiresAt <= now) {
      authLogin2FAStore.delete(key);
    }
  }
}

function generateRecoveryCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendRecoveryCodeEmail(email, code) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Email recovery is not configured on server');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"${APP_BRAND} Security" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `${APP_BRAND} Dashboard Password Reset Code`,
    text: `Your ${APP_BRAND} dashboard password reset code is: ${code}. This code expires in 10 minutes.`
  });
}

async function sendLoginTwoFactorCodeEmail(email, code) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('2FA email is not configured on server');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: `"${APP_BRAND} Security" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `${APP_BRAND} Dashboard Login Verification Code`,
    text: `Your ${APP_BRAND} dashboard login verification code is: ${code}. This code expires in 10 minutes.`
  });
}

function queueLoginNotification({ username, req, status }) {
  const security = readSecuritySettings();
  if (!security.loginNotifications) return;

  const ip = getClientIp(req) || 'Unknown';
  const when = new Date().toISOString();
  sendNotificationEmail({
    subject: `${APP_BRAND} dashboard login ${status}: ${username}`,
    text: `User: ${username}\nStatus: ${status}\nIP: ${ip}\nTime: ${when}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#0f1419;color:#e4e6eb">
      <h2 style="margin:0 0 12px;color:${status === 'successful' ? '#25D366' : '#F44336'}">${APP_BRAND} dashboard login ${status}</h2>
      <p><strong>User:</strong> ${String(username || '')}</p>
      <p><strong>IP:</strong> ${String(ip)}</p>
      <p><strong>Time:</strong> ${String(when)}</p>
    </div>`
  }).catch(() => {});
}

function getDataRetentionCutoffDate(securitySettings = {}) {
  const value = String(securitySettings.dataRetentionDays || '').trim().toLowerCase();
  if (value === 'forever') return null;

  const days = parseInt(value, 10);
  const safeDays = Number.isFinite(days) && days > 0 ? days : 90;
  return new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
}

async function applyDataRetentionPolicy() {
  const settings = readSecuritySettings();
  const cutoff = getDataRetentionCutoffDate(settings);
  if (!cutoff) return { skipped: true, deletedMessages: 0, deletedConversations: 0 };

  const [deletedMessages, deletedConversations] = await Promise.all([
    Message.destroy({ where: { timestamp: { [Op.lt]: cutoff } } }),
    Conversation.destroy({
      where: {
        [Op.or]: [
          { lastMessageAt: { [Op.lt]: cutoff } },
          { updatedAt: { [Op.lt]: cutoff } }
        ]
      }
    })
  ]);

  return { skipped: false, deletedMessages, deletedConversations, cutoff: cutoff.toISOString() };
}

async function sendRecoveryCodePhone(phoneDigits, code) {
  const phoneNumber = phoneDigits.includes('@c.us')
    ? phoneDigits
    : `${phoneDigits}@c.us`;

  const payload = JSON.stringify({
    phoneNumber,
    message: `PTIS Chatbot Dashboard reset code: ${code}. Valid for 10 minutes.`
  });

  const options = {
    hostname: '127.0.0.1',
    port: 3003,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const result = await new Promise((resolve, reject) => {
    const req = http.request(options, resp => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try {
          resolve({ status: resp.statusCode, body: JSON.parse(data || '{}') });
        } catch (e) {
          resolve({ status: resp.statusCode, body: { success: false, error: 'Invalid bot response' } });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  if (!result?.body?.success) {
    const errMsg = String(result?.body?.error || 'Failed to deliver code to phone');
    if (/not ready|scan qr|qr/i.test(errMsg)) {
      throw new Error('Phone recovery unavailable: WhatsApp is not linked yet. Please use Email recovery on login screen.');
    }
    throw new Error(errMsg);
  }
}

function isSmsRecoveryConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_VERIFY_SERVICE_SID
  );
}

function toE164FromDigits(phoneDigits = '') {
  const digits = normalizePhoneDigits(phoneDigits);
  return digits ? `+${digits}` : '';
}

async function sendRecoveryCodePhoneSms(phoneDigits) {
  if (!isSmsRecoveryConfigured()) {
    throw new Error('SMS recovery is not configured');
  }

  const to = toE164FromDigits(phoneDigits);
  if (!to) throw new Error('Invalid phone for SMS recovery');

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const body = new URLSearchParams({ To: to, Channel: 'sms' });
  const resp = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid}/Verifications`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.sid) {
    throw new Error(data?.message || 'Failed to send SMS verification code');
  }
}

async function verifyRecoveryCodePhoneSms(phoneDigits, code) {
  if (!isSmsRecoveryConfigured()) return false;

  const to = toE164FromDigits(phoneDigits);
  if (!to) return false;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const body = new URLSearchParams({ To: to, Code: String(code || '') });
  const resp = await fetch(`https://verify.twilio.com/v2/Services/${serviceSid}/VerificationCheck`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await resp.json().catch(() => ({}));
  return !!(resp.ok && data?.status === 'approved');
}

async function getWhatsAppRecoveryReadiness() {
  // phone recovery on login screen requires bot bridge alive + already connected
  const stateFile = path.join(__dirname, '../.bot-state.json');

  const pingOk = await new Promise((resolve) => {
    let done = false;
    const req = http.request(
      { hostname: 'localhost', port: 3003, path: '/ping', method: 'GET' },
      (resp) => {
        done = true;
        resp.resume();
        resolve(true);
      }
    );
    req.setTimeout(1200, () => {
      if (!done) {
        done = true;
        req.destroy();
        resolve(false);
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    });
    req.end();
  });

  if (!pingOk) return false;

  try {
    if (!fs.existsSync(stateFile)) return false;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state?.status === 'connected';
  } catch (_) {
    return false;
  }
}

function getNotificationRecipient() {
  return process.env.ADMIN_EMAIL || process.env.SMTP_USER || '';
}

function readNotificationSettings() {
  try {
    if (!fs.existsSync(NOTIFICATION_SETTINGS_PATH)) {
      return { ...NOTIFICATION_DEFAULTS };
    }
    const saved = JSON.parse(fs.readFileSync(NOTIFICATION_SETTINGS_PATH, 'utf8'));
    return { ...NOTIFICATION_DEFAULTS, ...saved };
  } catch (e) {
    console.error('Failed to read notification settings:', e.message);
    return { ...NOTIFICATION_DEFAULTS };
  }
}

function writeNotificationSettings(settings) {
  const merged = {
    ...NOTIFICATION_DEFAULTS,
    ...settings,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(NOTIFICATION_SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

async function sendNotificationEmail({ subject, html, text }) {
  const recipient = getNotificationRecipient();
  if (!recipient || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    await transporter.sendMail({
      from: `"${APP_BRAND} Alerts" <${process.env.SMTP_USER}>`,
      to: recipient,
      subject,
      text,
      html
    });
    return true;
  } catch (e) {
    console.error('Notification email failed:', e.message);
    return false;
  }
}

async function maybeSendEventNotificationEmail(type, data = {}) {
  const settings = readNotificationSettings();
  if (!settings.emailNotifications) return false;

  if (type === 'newMessage' && settings.newMessageAlert) {
    const detail = data.body || '';
    await sendNotificationEmail({
      subject: `New customer message from ${data.from || 'Unknown'}`,
      text: `${data.from || 'Unknown'} sent: ${detail}`,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#0f1419;color:#e4e6eb">
        <h2 style="margin:0 0 12px;color:#25D366">New customer message</h2>
        <p><strong>From:</strong> ${String(data.from || 'Unknown')}</p>
        <p><strong>Sentiment:</strong> ${String(data.sentiment || 'neutral')}</p>
        <div style="margin-top:12px;padding:14px;border-radius:10px;background:#252b33;border:1px solid #2d3339;">${String(detail || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>`
    });
  }

  if (type === 'newTask' && settings.taskUpdates) {
    await sendNotificationEmail({
      subject: `Task alert: ${data.description || 'New task created'}`,
      text: `Task status: ${data.status || 'pending'}\nPriority: ${data.priority || 'medium'}\n\n${data.description || ''}`,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#0f1419;color:#e4e6eb">
        <h2 style="margin:0 0 12px;color:#25D366">Task alert</h2>
        <p><strong>Status:</strong> ${String(data.status || 'pending')}</p>
        <p><strong>Priority:</strong> ${String(data.priority || 'medium')}</p>
        <div style="margin-top:12px;padding:14px;border-radius:10px;background:#252b33;border:1px solid #2d3339;">${String(data.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>`
    });
  }

  if (type === 'negativeSentiment' && settings.negativeSentimentAlert) {
    await sendNotificationEmail({
      subject: `Negative sentiment alert from ${data.from || 'Unknown'}`,
      text: `${data.from || 'Unknown'} sent a negative message: ${data.body || ''}`,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#0f1419;color:#e4e6eb">
        <h2 style="margin:0 0 12px;color:#F44336">Negative sentiment alert</h2>
        <p><strong>From:</strong> ${String(data.from || 'Unknown')}</p>
        <div style="margin-top:12px;padding:14px;border-radius:10px;background:#252b33;border:1px solid #2d3339;">${String(data.body || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>`
    });
  }

  return true;
}

async function maybeSendDailySummaryEmail() {
  const settings = readNotificationSettings();
  if (!settings.emailNotifications || !settings.dailySummary) return false;

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  if (settings.lastDailySummarySentAt && settings.lastDailySummarySentAt.slice(0, 10) === todayKey) {
    return false;
  }

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const customerWhere = { to: null };

  const [messagesToday, tasksToday, pendingTasks, positiveToday, negativeToday] = await Promise.all([
    Message.count({ where: { ...customerWhere, timestamp: { [Op.gte]: startOfDay } } }),
    Task.count({ where: { createdAt: { [Op.gte]: startOfDay } } }),
    Task.count({ where: { status: 'pending' } }),
    Message.count({ where: { ...customerWhere, sentimentLabel: 'positive', timestamp: { [Op.gte]: startOfDay } } }),
    Message.count({ where: { ...customerWhere, sentimentLabel: 'negative', timestamp: { [Op.gte]: startOfDay } } })
  ]);

  await sendNotificationEmail({
    subject: `Daily dashboard summary — ${todayKey}`,
    text: `Messages today: ${messagesToday}\nTasks today: ${tasksToday}\nPending tasks: ${pendingTasks}\nPositive messages: ${positiveToday}\nNegative messages: ${negativeToday}`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#0f1419;color:#e4e6eb">
      <h2 style="margin:0 0 16px;color:#25D366">Daily dashboard summary</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#8b949e">Messages today</td><td style="padding:8px 0;font-weight:700">${messagesToday}</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e">Tasks today</td><td style="padding:8px 0;font-weight:700">${tasksToday}</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e">Pending tasks</td><td style="padding:8px 0;font-weight:700">${pendingTasks}</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e">Positive messages</td><td style="padding:8px 0;font-weight:700">${positiveToday}</td></tr>
        <tr><td style="padding:8px 0;color:#8b949e">Negative messages</td><td style="padding:8px 0;font-weight:700">${negativeToday}</td></tr>
      </table>
    </div>`
  });

  writeNotificationSettings({ ...settings, lastDailySummarySentAt: new Date().toISOString() });
  return true;
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Function to set WhatsApp client
const setWhatsAppClient = (client) => {
  whatsappClient = client;
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));

// Session middleware (must be before static and routes)
app.use(session({
  secret: process.env.SESSION_SECRET || 'ptis_chatbot_s3cr3t_2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,          // set true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000  // 24 hours
  }
}));

// ── Auth helpers ──
function isAuthenticated(req) {
  return !!(req.session && req.session.authenticated);
}

function getSessionTimeoutMs() {
  const settings = readSecuritySettings();
  if (String(settings.sessionTimeoutMinutes) === 'never') return null;
  const minutes = parseInt(settings.sessionTimeoutMinutes, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30 * 60 * 1000;
  return minutes * 60 * 1000;
}

// Session inactivity guard
app.use((req, res, next) => {
  if (!isAuthenticated(req)) return next();

  const timeoutMs = getSessionTimeoutMs();
  if (!timeoutMs) {
    req.session.lastActivity = Date.now();
    return next();
  }

  const now = Date.now();
  const last = req.session.lastActivity || now;
  if (now - last > timeoutMs) {
    req.session.destroy(() => {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Session expired', redirect: '/login.html' });
      }
      return res.redirect('/login.html');
    });
    return;
  }

  req.session.lastActivity = now;
  next();
});

// IP whitelist guard
app.use((req, res, next) => {
  if (isIpAllowed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Access denied: your IP is not in whitelist' });
  }
  return res.status(403).send('Access denied: your IP is not in whitelist');
});

// Protect dashboard HTML (intercept before static middleware)
app.use((req, res, next) => {
  const path_ = req.path;
  // Allow login page, assets, and auth API freely
  if (
    path_ === '/login.html' ||
    path_ === '/api/auth/login' ||
    path_.startsWith('/css/') ||
    path_.startsWith('/js/') ||
    path_.startsWith('/images/')
  ) return next();

  // Protect dashboard root
  if ((path_ === '/' || path_ === '/index.html') && !isAuthenticated(req)) {
    return res.redirect('/login.html');
  }
  next();
});

app.use(express.static(path.join(__dirname, '../../frontend')));

// Protect all /api/* routes except /api/auth/* and /api/internal/*
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/internal/')) return next(); // internal bot → server calls
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Not authenticated', redirect: '/login.html' });
  }
  next();
});

// ── Auth endpoints ──
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const authSettings = readAuthSettings();
  const validUser = authSettings.username || process.env.DASHBOARD_USER || 'admin';

  if (username === validUser && verifyDashboardPassword(password, authSettings)) {
    const securitySettings = readSecuritySettings();

    if (securitySettings.twoFactorEnabled) {
      const { email } = getConfiguredRecoveryContacts();
      if (!email) {
        return res.status(400).json({ success: false, error: '2FA is enabled but no email is configured in General Settings' });
      }

      pruneTwoFactorStore();
      const code = generateRecoveryCode();
      const salt = crypto.randomBytes(16).toString('hex');
      const codeHash = hashPassword(code, salt);
      authLogin2FAStore.set(getTwoFactorKey(username), {
        codeHash,
        salt,
        expiresAt: Date.now() + AUTH_LOGIN_2FA_CODE_TTL_MS,
        attempts: 0
      });

      await sendLoginTwoFactorCodeEmail(email, code);
      req.session.pending2fa = { username, requestedAt: Date.now() };
      req.session.authenticated = false;

      return res.json({
        success: true,
        requires2fa: true,
        destinationMasked: maskEmail(email),
        message: 'Verification code sent'
      });
    }

    req.session.authenticated = true;
    req.session.username = username;
    req.session.lastActivity = Date.now();
    delete req.session.pending2fa;
    queueLoginNotification({ username, req, status: 'successful' });
    return res.json({ success: true });
  }
  queueLoginNotification({ username: username || 'unknown', req, status: 'failed' });
  return res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/auth/2fa/verify', (req, res) => {
  pruneTwoFactorStore();

  const pendingUser = req.session?.pending2fa?.username;
  const code = String(req.body?.code || '').trim();
  if (!pendingUser) {
    return res.status(400).json({ success: false, error: 'No pending 2FA verification. Please login again.' });
  }
  if (!code) {
    return res.status(400).json({ success: false, error: 'Verification code is required' });
  }

  const key = getTwoFactorKey(pendingUser);
  const record = authLogin2FAStore.get(key);
  if (!record || Date.now() > record.expiresAt) {
    authLogin2FAStore.delete(key);
    return res.status(400).json({ success: false, error: '2FA code expired. Please login again.' });
  }

  const valid = hashPassword(code, record.salt) === record.codeHash;
  if (!valid) {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= AUTH_LOGIN_2FA_MAX_ATTEMPTS) {
      authLogin2FAStore.delete(key);
      return res.status(400).json({ success: false, error: 'Too many invalid attempts. Please login again.' });
    }
    authLogin2FAStore.set(key, record);
    return res.status(400).json({ success: false, error: 'Invalid verification code' });
  }

  authLogin2FAStore.delete(key);
  req.session.authenticated = true;
  req.session.username = pendingUser;
  req.session.lastActivity = Date.now();
  delete req.session.pending2fa;
  queueLoginNotification({ username: pendingUser, req, status: 'successful' });
  return res.json({ success: true, message: '2FA verified' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req), username: req.session?.username });
});

app.get('/api/auth/forgot-password/options', (req, res) => {
  (async () => {
    const { email } = getConfiguredRecoveryContacts();
    res.json({
      success: true,
      methods: {
        email: {
          enabled: !!email,
          masked: maskEmail(email),
          reason: email ? '' : 'Email not configured in General Settings'
        },
        phone: {
          enabled: false,
          masked: '',
          reason: 'Phone recovery is temporarily disabled'
        }
      }
    });
  })().catch(() => {
    res.status(500).json({ success: false, error: 'Failed to load recovery options' });
  });
});

app.post('/api/auth/forgot-password/send-code', async (req, res) => {
  try {
    pruneRecoveryStore();

    const method = String(req.body?.method || '').trim().toLowerCase();
    if (method !== 'email') {
      return res.status(400).json({ success: false, error: 'Only email recovery is available right now' });
    }

    const { email: configuredEmail } = getConfiguredRecoveryContacts();
    const destination = configuredEmail;

    if (!configuredEmail) {
      return res.status(400).json({ success: false, error: 'Email recovery is not configured' });
    }

    const code = generateRecoveryCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = hashPassword(code, salt);
    const expiresAt = Date.now() + AUTH_RECOVERY_CODE_TTL_MS;
    authRecoveryStore.set(getRecoveryKey(method, destination), {
      codeHash,
      salt,
      expiresAt,
      attempts: 0
    });
    await sendRecoveryCodeEmail(destination, code);

    return res.json({
      success: true,
      message: `Verification code sent via ${method}`,
      destinationMasked: method === 'email' ? maskEmail(destination) : maskPhone(destination)
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'Failed to send recovery code' });
  }
});

app.post('/api/auth/forgot-password/reset', (req, res) => {
  (async () => {
    pruneRecoveryStore();

    const method = String(req.body?.method || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    const newPassword = String(req.body?.newPassword || '');

    if (method !== 'email') {
      return res.status(400).json({ success: false, error: 'Only email recovery is available right now' });
    }

    const { email: configuredEmail } = getConfiguredRecoveryContacts();
    const destination = configuredEmail;

    if (!destination || !code) {
      return res.status(400).json({ success: false, error: 'Recovery destination is not configured or code is missing' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters long' });
    }

    const key = getRecoveryKey(method, destination);
    const record = authRecoveryStore.get(key);
    if (!record || !record.codeHash || !record.salt || Date.now() > record.expiresAt) {
      authRecoveryStore.delete(key);
      return res.status(400).json({ success: false, error: 'Code expired or invalid. Request a new code.' });
    }

    const isCodeValid = hashPassword(code, record.salt) === record.codeHash;
    if (!isCodeValid) {
      record.attempts = (record.attempts || 0) + 1;
      if (record.attempts >= AUTH_RECOVERY_MAX_ATTEMPTS) {
        authRecoveryStore.delete(key);
      } else {
        authRecoveryStore.set(key, record);
      }
      return res.status(400).json({ success: false, error: 'Invalid verification code' });
    }

    authRecoveryStore.delete(key);

    const authSettings = readAuthSettings();
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(newPassword, salt);
    writeAuthSettings({
      ...authSettings,
      passwordSalt: salt,
      passwordHash,
      passwordUpdatedAt: new Date().toISOString()
    });

    return res.json({ success: true, message: 'Password reset successful' });
  })().catch((e) => {
    return res.status(500).json({ success: false, error: 'Failed to reset password' });
  });
});

// Connect to database
connectDB();

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('🔌 Client connected to dashboard');
  
  // Send initial stats on connection
  socket.on('requestStats', async () => {
    try {
      const stats = await getQuickStats();
      socket.emit('statsUpdate', stats);
    } catch (error) {
      console.error('Error sending stats:', error);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected');
  });
});

// Helper function to get quick stats for real-time updates
async function getQuickStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const customerMessageWhere = { to: null };
  
  const messagesToday = await Message.count({ 
    where: { ...customerMessageWhere, timestamp: { [Op.gte]: today } } 
  });
  
  const tasksToday = await Task.count({ 
    where: { createdAt: { [Op.gte]: today } } 
  });
  
  const pendingTasks = await Task.count({ 
    where: { status: 'pending' } 
  });
  
  return {
    messagesToday,
    tasksToday,
    pendingTasks,
    timestamp: new Date()
  };
}

// Broadcast stats update to all connected clients
function broadcastStatsUpdate() {
  getQuickStats().then(stats => {
    io.emit('statsUpdate', stats);
  }).catch(error => {
    console.error('Error broadcasting stats:', error);
  });
}

// Internal endpoint — called by bot.js to emit socket events to dashboard
app.post('/api/internal/broadcast', async (req, res) => {
  const { type, data } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  io.emit(type, data);
  if (type === 'newMessage' || type === 'newTask') broadcastStatsUpdate();

  try {
    if (type === 'newMessage') {
      await maybeSendEventNotificationEmail('newMessage', data);
      if (data?.sentiment === 'negative') {
        await maybeSendEventNotificationEmail('negativeSentiment', data);
      }
    } else if (type === 'newTask' || type === 'taskUpdated') {
      await maybeSendEventNotificationEmail('newTask', data);
    }
  } catch (e) {
    console.error('Notification event email error:', e.message);
  }

  res.json({ ok: true });
});

// ── Database utilities ─────────────────────────────────────────────────────
app.get('/api/database/overview', async (req, res) => {
  try {
    const dbName = process.env.DB_NAME || 'whatsapp_bot';

    // Counts via ORM
    const [messagesCount, tasksCount, conversationsCount, profilesCount] = await Promise.all([
      Message.count(),
      Task.count(),
      Conversation.count(),
      UserProfile.count()
    ]);

    // Latest timestamps per table
    const [msgLast, taskLast, convLast, profLast] = await Promise.all([
      Message.max('updatedAt'),
      Task.max('updatedAt'),
      Conversation.max('updatedAt'),
      UserProfile.max('updatedAt')
    ]);

    // Sizes from information_schema
    const [sizeRows] = await sequelize.query(
      `SELECT table_name AS tableName,
              ROUND((data_length + index_length) / 1024, 2) AS sizeKb,
              update_time AS updatedAt
         FROM information_schema.TABLES
        WHERE table_schema = :db
          AND table_name IN (:tables);`,
      { replacements: { db: dbName, tables: Object.keys(ALLOWED_TABLES) } }
    );

    const sizeMap = {};
    sizeRows.forEach(row => { sizeMap[row.tableName] = row; });

    const tables = {
      messages: {
        label: TABLE_LABELS.messages,
        count: messagesCount,
        sizeKb: sizeMap.messages?.sizeKb || 0,
        updatedAt: msgLast || sizeMap.messages?.updatedAt || null
      },
      tasks: {
        label: TABLE_LABELS.tasks,
        count: tasksCount,
        sizeKb: sizeMap.tasks?.sizeKb || 0,
        updatedAt: taskLast || sizeMap.tasks?.updatedAt || null
      },
      conversations: {
        label: TABLE_LABELS.conversations,
        count: conversationsCount,
        sizeKb: sizeMap.conversations?.sizeKb || 0,
        updatedAt: convLast || sizeMap.conversations?.updatedAt || null
      },
      user_profiles: {
        label: TABLE_LABELS.user_profiles,
        count: profilesCount,
        sizeKb: sizeMap.user_profiles?.sizeKb || 0,
        updatedAt: profLast || sizeMap.user_profiles?.updatedAt || null
      }
    };

    const totals = Object.values(tables).reduce((acc, t) => {
      acc.records += t.count;
      acc.sizeKb += Number(t.sizeKb || 0);
      return acc;
    }, { records: 0, sizeKb: 0 });
    totals.sizeMb = +(totals.sizeKb / 1024).toFixed(2);

    res.json({ tables, totals });
  } catch (e) {
    console.error('overview error', e.message);
    res.status(500).json({ error: 'Failed to load database overview' });
  }
});

app.get('/api/database/activity', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

    const [messages, tasks, conversations, profiles] = await Promise.all([
      Message.findAll({
        order: [['timestamp', 'DESC']],
        limit,
        attributes: ['id', 'fromName', 'from', 'timestamp', 'createdAt', 'updatedAt']
      }),
      Task.findAll({
        order: [['updatedAt', 'DESC']],
        limit,
        attributes: ['id', 'description', 'status', 'fromName', 'from', 'createdAt', 'updatedAt']
      }),
      Conversation.findAll({
        order: [['updatedAt', 'DESC']],
        limit,
        attributes: ['id', 'name', 'phoneNumber', 'messageCount', 'lastMessageAt', 'createdAt', 'updatedAt']
      }),
      UserProfile.findAll({
        order: [['updatedAt', 'DESC']],
        limit,
        attributes: ['id', 'name', 'phoneNumber', 'email', 'createdAt', 'updatedAt']
      })
    ]);

    const inferAction = (createdAt, updatedAt, forcedAction) => {
      if (forcedAction) return forcedAction;
      const c = createdAt ? new Date(createdAt).getTime() : 0;
      const u = updatedAt ? new Date(updatedAt).getTime() : 0;
      if (!c || !u) return 'update';
      return Math.abs(u - c) <= 60000 ? 'insert' : 'update';
    };

    const activity = [
      ...messages.map(m => ({
        source: 'messages',
        action: 'insert',
        title: 'New message received',
        details: `From: ${m.fromName || m.from || 'Unknown'} • ID: ${m.id}`,
        timestamp: m.timestamp || m.createdAt || m.updatedAt
      })),
      ...tasks.map(t => ({
        source: 'tasks',
        action: inferAction(t.createdAt, t.updatedAt),
        title: inferAction(t.createdAt, t.updatedAt) === 'insert' ? 'New task created' : `Task ${t.status || 'updated'}`,
        details: `${(t.description || 'Task').slice(0, 90)}${(t.description || '').length > 90 ? '…' : ''}`,
        timestamp: t.updatedAt || t.createdAt
      })),
      ...conversations.map(c => ({
        source: 'conversations',
        action: inferAction(c.createdAt, c.updatedAt),
        title: inferAction(c.createdAt, c.updatedAt) === 'insert' ? 'New conversation created' : 'Conversation updated',
        details: `${c.name || c.phoneNumber || 'Unknown contact'} • Messages: ${c.messageCount || 0}`,
        timestamp: c.lastMessageAt || c.updatedAt || c.createdAt
      })),
      ...profiles.map(p => ({
        source: 'user_profiles',
        action: inferAction(p.createdAt, p.updatedAt),
        title: inferAction(p.createdAt, p.updatedAt) === 'insert' ? 'Profile created' : 'Profile updated',
        details: `${p.name || p.phoneNumber || 'Unknown profile'}${p.email ? ` • ${p.email}` : ''}`,
        timestamp: p.updatedAt || p.createdAt
      }))
    ]
      .filter(a => a.timestamp)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    res.json({ activities: activity });
  } catch (e) {
    console.error('database activity error', e.message);
    res.status(500).json({ error: 'Failed to load recent activity' });
  }
});

// List onboarding/customer profiles (name, designation, phone, email)
app.get('/api/user-profiles', async (_req, res) => {
  try {
    const profiles = await UserProfile.findAll({
      order: [['updatedAt', 'DESC']],
      attributes: ['id', 'phoneNumber', 'name', 'designation', 'contactPhone', 'email', 'updatedAt']
    });
    res.json({ success: true, profiles });
  } catch (e) {
    console.error('user-profiles error', e.message);
    res.status(500).json({ success: false, error: 'Failed to load profiles' });
  }
});

// Update a profile
app.put('/api/user-profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, designation, contactPhone, email, phoneNumber } = req.body || {};
    const profile = await UserProfile.findByPk(id);
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    profile.name = name ?? profile.name;
    profile.designation = designation ?? profile.designation;
    profile.contactPhone = contactPhone ?? profile.contactPhone;
    profile.phoneNumber = phoneNumber ?? profile.phoneNumber;
    profile.email = email ?? profile.email;
    await profile.save();
    res.json({ success: true, profile });
  } catch (e) {
    console.error('user-profiles update error', e.message);
    res.status(500).json({ success: false, error: 'Failed to update profile: ' + e.message });
  }
});

// Delete a profile
app.delete('/api/user-profiles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await UserProfile.destroy({ where: { id } });
    if (!deleted) return res.status(404).json({ success: false, error: 'Profile not found' });
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('user-profiles delete error', e.message);
    res.status(500).json({ success: false, error: 'Failed to delete profile: ' + e.message });
  }
});

app.get('/api/database/table/:table/export', async (req, res) => {
  try {
    const table = req.params.table;
    const Model = ALLOWED_TABLES[table];
    if (!Model) return res.status(400).json({ error: 'Invalid table' });

    const rows = await Model.findAll({ raw: true });
    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error('export table error', e.message);
    res.status(500).json({ error: 'Failed to export table' });
  }
});

app.get('/api/database/export-all', async (req, res) => {
  try {
    const payload = {};
    for (const key of Object.keys(ALLOWED_TABLES)) {
      const Model = ALLOWED_TABLES[key];
      payload[key] = await Model.findAll({ raw: true });
    }
    const json = JSON.stringify(payload, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="database-export.json"');
    res.send(json);
  } catch (e) {
    console.error('export-all error', e.message);
    res.status(500).json({ error: 'Failed to export database' });
  }
});

app.post('/api/database/optimize', async (req, res) => {
  try {
    const dbName = process.env.DB_NAME || 'whatsapp_bot';
    const tableList = Object.keys(ALLOWED_TABLES);
    let optimized = 0;
    for (const t of tableList) {
      await sequelize.query(`OPTIMIZE TABLE \`${dbName}\`.\`${t}\`;`);
      optimized += 1;
    }
    res.json({ success: true, optimized });
  } catch (e) {
    console.error('optimize error', e.message);
    res.status(500).json({ error: 'Failed to optimize database' });
  }
});

app.post('/api/database/cleanup-old', async (req, res) => {
  try {
    const days = Number(req.body?.days || 0);
    if (!days || days <= 0) return res.status(400).json({ error: 'days must be > 0' });

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const messagesDeleted = await Message.destroy({ where: { timestamp: { [Op.lt]: cutoff } } });
    const conversationsDeleted = await Conversation.destroy({ where: { lastMessageAt: { [Op.lt]: cutoff } } });
    res.json({ success: true, messagesDeleted, conversationsDeleted });
  } catch (e) {
    console.error('cleanup-old error', e.message);
    res.status(500).json({ error: 'Failed to clean old data' });
  }
});

app.post('/api/database/table/:table/clear', async (req, res) => {
  try {
    const table = req.params.table;
    const Model = ALLOWED_TABLES[table];
    if (!Model) return res.status(400).json({ error: 'Invalid table' });
    const deleted = await Model.destroy({ where: {} });
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('clear-table error', e.message);
    res.status(500).json({ error: 'Failed to clear table' });
  }
});

app.post('/api/database/restore', async (req, res) => {
  const payload = req.body || {};
  const tx = await sequelize.transaction();

  // Clear child tables first (respect FK: tasks → messages)
  const clearOrder = ['tasks', 'messages', 'conversations', 'user_profiles'];
  const insertOrder = ['messages', 'conversations', 'user_profiles', 'tasks'];

  const normalizeTask = (row = {}) => {
    const allowedStatus = ['pending', 'in-progress', 'completed', 'cancelled'];
    const allowedPriority = ['low', 'medium', 'high'];
    const status = String(row.status || '').toLowerCase();
    const priority = String(row.priority || '').toLowerCase();
    const messageRef = Number.isInteger(row.messageRef)
      ? row.messageRef
      : Number.isInteger(row.message_ref)
        ? row.message_ref
        : null;
    return {
      ...row,
      status: allowedStatus.includes(status) ? status : 'pending',
      priority: allowedPriority.includes(priority) ? priority : 'high',
      messageRef
    };
  };

  try {
    // Disable FK checks for the session to allow truncation order
    await sequelize.query('SET FOREIGN_KEY_CHECKS=0;', { transaction: tx });

    // Clear existing data
    for (const t of clearOrder) {
      const Model = ALLOWED_TABLES[t];
      if (!Model) continue;
      await Model.destroy({ where: {}, transaction: tx });
      await sequelize.query(`ALTER TABLE \`${t}\` AUTO_INCREMENT = 1;`, { transaction: tx });
    }

    // Insert data in FK-safe order
    for (const t of insertOrder) {
      const Model = ALLOWED_TABLES[t];
      if (!Model) continue;
      const rows = Array.isArray(payload[t]) ? payload[t] : [];
      if (!rows.length) continue;

      const normalized = t === 'tasks' ? rows.map(normalizeTask) : rows;
      await Model.bulkCreate(normalized, { transaction: tx });
    }

    // Re-enable FK checks
    await sequelize.query('SET FOREIGN_KEY_CHECKS=1;', { transaction: tx });

    await tx.commit();
    res.json({ success: true, restored: true });
  } catch (e) {
    await tx.rollback();
    console.error('restore error', e.message);
    res.status(500).json({ error: 'Failed to restore database: ' + e.message });
  }
});

// Make io accessible to routes
app.set('io', io);

// API Routes

// Get dashboard statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Get current date ranges
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastMonth = new Date(today);
    lastMonth.setMonth(lastMonth.getMonth() - 1);

    const customerMessageWhere = { to: null };

    // Total counts (customer messages only)
    const totalMessages = await Message.count({ where: customerMessageWhere });
    const totalTasks = await Task.count();
    const totalConversations = await Conversation.count();
    
    // Today's counts (customer messages only)
    const messagesToday = await Message.count({ 
      where: { ...customerMessageWhere, timestamp: { [Op.gte]: today } } 
    });
    const tasksToday = await Task.count({ 
      where: { createdAt: { [Op.gte]: today } } 
    });
    const conversationsToday = await Conversation.count({ 
      where: { lastMessageAt: { [Op.gte]: today } } 
    });

    // Yesterday's counts for comparison
    const messagesYesterday = await Message.count({ 
      where: { 
        ...customerMessageWhere,
        timestamp: { 
          [Op.gte]: yesterday,
          [Op.lt]: today
        } 
      } 
    });
    const tasksYesterday = await Task.count({ 
      where: { 
        createdAt: { 
          [Op.gte]: yesterday,
          [Op.lt]: today
        } 
      } 
    });

    // This week counts
    const messagesThisWeek = await Message.count({ 
      where: { ...customerMessageWhere, timestamp: { [Op.gte]: lastWeek } } 
    });
    const tasksThisWeek = await Task.count({ 
      where: { createdAt: { [Op.gte]: lastWeek } } 
    });

    // Task status breakdown
    const pendingTasks = await Task.count({ where: { status: 'pending' } });
    const completedTasks = await Task.count({ where: { status: 'completed' } });
    const inProgressTasks = await Task.count({ where: { status: 'in-progress' } });
    
    // Task priority breakdown
    const urgentTasks = await Task.count({ where: { priority: 'urgent' } });
    const highPriorityTasks = await Task.count({ where: { priority: 'high' } });
    const mediumPriorityTasks = await Task.count({ where: { priority: 'medium' } });
    const lowPriorityTasks = await Task.count({ where: { priority: 'low' } });
    
    // Count messages by sentiment
    const positiveCount = await Message.count({ where: { ...customerMessageWhere, sentimentLabel: 'positive' } });
    const negativeCount = await Message.count({ where: { ...customerMessageWhere, sentimentLabel: 'negative' } });
    const neutralCount = await Message.count({ where: { ...customerMessageWhere, sentimentLabel: 'neutral' } });
    
    // Today's sentiment
    const positiveTodayCount = await Message.count({ 
      where: { 
        ...customerMessageWhere,
        sentimentLabel: 'positive',
        timestamp: { [Op.gte]: today } 
      } 
    });
    const negativeTodayCount = await Message.count({ 
      where: { 
        ...customerMessageWhere,
        sentimentLabel: 'negative',
        timestamp: { [Op.gte]: today } 
      } 
    });

    // Calculate sentiment percentage
    const totalSentimentMessages = positiveCount + negativeCount + neutralCount;
    const positivePercent = totalSentimentMessages > 0 
      ? Math.round((positiveCount / totalSentimentMessages) * 100) 
      : 0;

    // Get active conversations (had messages in last 24 hours)
    const activeConversations = await Conversation.count({
      where: {
        lastMessageAt: { [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    });

    // Calculate growth/changes
    const messageChange = messagesYesterday > 0 
      ? Math.round(((messagesToday - messagesYesterday) / messagesYesterday) * 100)
      : messagesToday > 0 ? 100 : 0;
    
    const taskChange = tasksYesterday > 0 
      ? Math.round(((tasksToday - tasksYesterday) / tasksYesterday) * 100)
      : tasksToday > 0 ? 100 : 0;

    // Get recent activity summary — exclude bot replies (to IS NOT NULL)
    const recentMessages = await Message.findAll({
      where: { to: null },
      order: [['timestamp', 'DESC']],
      limit: 5,
      attributes: ['id', 'fromName', 'body', 'timestamp', 'sentimentLabel']
    });

    const recentTasks = await Task.findAll({
      order: [['createdAt', 'DESC']],
      limit: 5,
      attributes: ['id', 'description', 'status', 'priority', 'createdAt']
    });

    // Response object
    const stats = {
      // Total counts
      totalMessages,
      totalTasks,
      totalConversations,
      
      // Today's activity
      today: {
        messages: messagesToday,
        tasks: tasksToday,
        conversations: conversationsToday,
        positiveMessages: positiveTodayCount,
        negativeMessages: negativeTodayCount
      },
      
      // This week
      thisWeek: {
        messages: messagesThisWeek,
        tasks: tasksThisWeek
      },
      
      // Changes/Growth
      changes: {
        messages: messageChange,
        tasks: taskChange,
        messagesCount: messagesToday - messagesYesterday,
        tasksCount: tasksToday - tasksYesterday
      },
      
      // Task breakdown
      tasks: {
        total: totalTasks,
        pending: pendingTasks,
        completed: completedTasks,
        inProgress: inProgressTasks,
        urgent: urgentTasks,
        high: highPriorityTasks,
        medium: mediumPriorityTasks,
        low: lowPriorityTasks
      },
      
      // Sentiment breakdown
      sentiment: {
        positive: positiveCount,
        negative: negativeCount,
        neutral: neutralCount,
        positivePercent: positivePercent,
        total: totalSentimentMessages
      },
      
      // Conversations
      conversations: {
        total: totalConversations,
        active: activeConversations,
        activePercent: totalConversations > 0 
          ? Math.round((activeConversations / totalConversations) * 100)
          : 0
      },
      
      // Recent activity
      recentActivity: {
        messages: recentMessages.map(msg => ({
          id: msg.id,
          from: msg.fromName,
          preview: msg.body.substring(0, 50) + (msg.body.length > 50 ? '...' : ''),
          sentiment: msg.sentimentLabel,
          timestamp: msg.timestamp
        })),
        tasks: recentTasks.map(task => ({
          id: task.id,
          description: task.description,
          status: task.status,
          priority: task.priority,
          timestamp: task.createdAt
        }))
      },
      
      // Metadata
      timestamp: new Date(),
      period: 'realtime'
    };
    
    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get messages with filtering, search, and pagination
app.get('/api/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search || '';
    const sentiment = req.query.sentiment || '';
    const from = req.query.from || '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    // Conversation-list mode: one row per contact (their latest message),
    // instead of a flat log with a separate row per message. Used by the
    // Messages page so a contact who sends several messages updates the same
    // card instead of appearing as multiple stacked cards.
    const grouped = req.query.grouped === 'true';

    // Build where clause — always exclude bot replies (to IS NOT NULL means bot sent it)
    const where = { to: null };
    
    if (search) {
      where.body = { [Op.like]: `%${search}%` };
    }
    
    if (sentiment && sentiment !== 'all') {
      where.sentimentLabel = sentiment;
    }
    
    if (from) {
      where.from = from;
    }
    
    if (startDate && endDate) {
      where.timestamp = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    } else if (startDate) {
      where.timestamp = { [Op.gte]: new Date(startDate) };
    } else if (endDate) {
      where.timestamp = { [Op.lte]: new Date(endDate) };
    }
    
    let totalCount, messages;

    if (grouped) {
      // One row per contact — group by `from`, keep only their latest message
      // (highest id, which also matches the highest timestamp), ordered by
      // recency. Pagination (limit/offset) applies per-contact, not per-message.
      const latestRows = await Message.findAll({
        attributes: ['from', [sequelize.fn('MAX', sequelize.col('id')), 'maxId']],
        where,
        group: ['from'],
        order: [[sequelize.fn('MAX', sequelize.col('timestamp')), 'DESC']],
        limit,
        offset,
        raw: true
      });
      const ids = latestRows.map(r => r.maxId).filter(Boolean);

      const distinctContacts = await Message.count({ where, distinct: true, col: 'from' });
      totalCount = distinctContacts;

      messages = ids.length
        ? await Message.findAll({ where: { id: { [Op.in]: ids } }, order: [['timestamp', 'DESC']] })
        : [];
    } else {
      // Get total count for pagination
      totalCount = await Message.count({ where });

      // Fetch messages
      messages = await Message.findAll({
        where,
        order: [['timestamp', 'DESC']],
        limit,
        offset
      });
    }
    
    // Format messages for frontend
    const formattedMessages = messages.map(msg => ({
      _id: msg.id,
      messageId: msg.messageId,
      from: msg.from,
      fromName: msg.fromName,
      body: msg.body,
      timestamp: msg.timestamp,
      sentiment: {
        score: msg.sentimentScore,
        comparative: msg.sentimentComparative,
        label: msg.sentimentLabel,
        tokens: msg.sentimentTokens
      },
      isCommand: msg.isCommand,
      replied: msg.replied
    }));
    
    res.json({
      messages: formattedMessages,
      total: totalCount,
      limit,
      offset,
      hasMore: offset + limit < totalCount
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Get tasks
// Task stats endpoint (must be before /api/tasks/:id)
app.get('/api/tasks/stats', async (req, res) => {
  try {
    const total      = await Task.count();
    const completed  = await Task.count({ where: { status: 'completed' } });
    const inProgress = await Task.count({ where: { status: 'in-progress' } });
    const pending    = await Task.count({ where: { status: 'pending' } });
    const cancelled  = await Task.count({ where: { status: 'cancelled' } });
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    res.json({ total, completed, inProgress, pending, cancelled, completionRate });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch task stats' });
  }
});

app.get('/api/tasks', async (req, res) => {
  try {
    const { status, type, priority, search, page, limit = 10 } = req.query;

    const formatTask = task => ({
      _id: task.id,
      description: task.description,
      from: task.from,
      fromName: task.fromName,
      status: task.status,
      priority: task.priority,
      type: task.type,
      messageRef: task.messageRef,
      completedAt: task.completedAt,
      notes: task.notes,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    });

    let where = {};
    if (status && status !== 'all')   where.status   = status;
    if (type && type !== 'all')       where.type     = type;
    if (priority && priority !== 'all') where.priority = priority;
    if (search) {
      where[Op.or] = [
        { description: { [Op.like]: `%${search}%` } },
        { fromName:    { [Op.like]: `%${search}%` } },
        { from:        { [Op.like]: `%${search}%` } }
      ];
    }

    // Paginated request (tasks page)
    if (page) {
      const pageNum = parseInt(page) || 1;
      const pageSize = parseInt(limit) || 10;
      const offset = (pageNum - 1) * pageSize;
      const { count, rows } = await Task.findAndCountAll({
        where, order: [['createdAt', 'DESC']], limit: pageSize, offset
      });
      return res.json({
        tasks: rows.map(formatTask),
        total: count,
        page: pageNum,
        totalPages: Math.ceil(count / pageSize)
      });
    }

    // Non-paginated (dashboard recent tasks — backward compat)
    const tasks = await Task.findAll({ where, order: [['createdAt', 'DESC']] });
    res.json(tasks.map(formatTask));
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Update task status
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const task = await Task.findByPk(req.params.id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    if (status) task.status = status;
    if (notes !== undefined) task.notes = notes;
    
    if (status === 'completed') {
      task.completedAt = new Date();
    }
    
    await task.save();
    
    // Emit update to connected clients
    const formattedTask = {
      _id: task.id,
      description: task.description,
      from: task.from,
      fromName: task.fromName,
      status: task.status,
      priority: task.priority,
      type: task.type,
      messageRef: task.messageRef,
      completedAt: task.completedAt,
      notes: task.notes,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    };
    
    io.emit('taskUpdated', formattedTask);
    
    res.json(formattedTask);
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Create manual task
app.post('/api/tasks', async (req, res) => {
  try {
    const { description, fromName, priority = 'medium', type = 'task', notes } = req.body;
    if (!description) return res.status(400).json({ error: 'Description is required' });
    const task = await Task.create({
      description,
      from: 'manual',
      fromName: fromName || 'Admin',
      priority,
      type,
      notes,
      status: 'pending'
    });
    const formattedTask = {
      _id: task.id, description: task.description, from: task.from,
      fromName: task.fromName, status: task.status, priority: task.priority,
      type: task.type, notes: task.notes, createdAt: task.createdAt
    };
    io.emit('newTask', formattedTask);
    broadcastStatsUpdate();
    res.json(formattedTask);
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Delete single task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const deleted = await Task.destroy({ where: { id: req.params.id } });
    if (!deleted) return res.status(404).json({ error: 'Task not found' });
    broadcastStatsUpdate();
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Bulk delete tasks
app.post('/api/tasks/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'No IDs provided' });
    const deleted = await Task.destroy({ where: { id: ids } });
    broadcastStatsUpdate();
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Error bulk deleting tasks:', error);
    res.status(500).json({ error: 'Failed to delete tasks' });
  }
});

// Get conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const conversations = await Conversation.findAll({
      order: [['lastMessageAt', 'DESC']]
    });
    
    // Format conversations for frontend
    const formattedConversations = conversations.map(conv => ({
      _id: conv.id,
      phoneNumber: conv.phoneNumber,
      name: conv.name,
      messageCount: conv.messageCount,
      lastMessageAt: conv.lastMessageAt,
      averageSentiment: conv.averageSentiment,
      sentimentStats: {
        positive: conv.sentimentPositive,
        negative: conv.sentimentNegative,
        neutral: conv.sentimentNeutral
      },
      taskCount: conv.taskCount,
      requestCount: conv.requestCount
    }));
    
    res.json(formattedConversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ── Sentiment: full stats for sentiment page ──
app.get('/api/sentiment/stats', async (req, res) => {
  try {
    const days   = parseInt(req.query.days) || 7;
    const now    = new Date();
    const start  = new Date(now - days * 86400000);
    const prevStart = new Date(now - days * 2 * 86400000);

    // All-time counts
    const [pos, neg, neu] = await Promise.all([
      Message.count({ where: { sentimentLabel: 'positive' } }),
      Message.count({ where: { sentimentLabel: 'negative' } }),
      Message.count({ where: { sentimentLabel: 'neutral'  } })
    ]);
    const total = pos + neg + neu;

    // Period counts
    const [pPos, pNeg, pNeu] = await Promise.all([
      Message.count({ where: { sentimentLabel: 'positive', timestamp: { [Op.gte]: start } } }),
      Message.count({ where: { sentimentLabel: 'negative', timestamp: { [Op.gte]: start } } }),
      Message.count({ where: { sentimentLabel: 'neutral',  timestamp: { [Op.gte]: start } } })
    ]);
    const pTotal = pPos + pNeg + pNeu;

    // Previous period counts (for change %)
    const [ppPos, ppNeg, ppNeu] = await Promise.all([
      Message.count({ where: { sentimentLabel: 'positive', timestamp: { [Op.gte]: prevStart, [Op.lt]: start } } }),
      Message.count({ where: { sentimentLabel: 'negative', timestamp: { [Op.gte]: prevStart, [Op.lt]: start } } }),
      Message.count({ where: { sentimentLabel: 'neutral',  timestamp: { [Op.gte]: prevStart, [Op.lt]: start } } })
    ]);
    const ppTotal = ppPos + ppNeg + ppNeu;

    // Average comparative score (selected period)
    const avgResult = await Message.findOne({
      attributes: [[Message.sequelize.fn('AVG', Message.sequelize.col('sentiment_comparative')), 'avg']],
      where: {
        sentimentComparative: { [Op.ne]: null },
        timestamp: { [Op.gte]: start }
      }
    });
    const avgScore = parseFloat(avgResult?.dataValues?.avg || 0);

    // Helpers
    const pct = (n, t) => t > 0 ? Math.round((n / t) * 100) : 0;
    const change = (curr, prev) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : (curr > 0 ? 100 : 0);

    res.json({
      allTime: { positive: pos, negative: neg, neutral: neu, total,
        positivePercent: pct(pos, total), negativePercent: pct(neg, total), neutralPercent: pct(neu, total) },
      period:  { positive: pPos, negative: pNeg, neutral: pNeu, total: pTotal,
        positivePercent: pct(pPos, pTotal), negativePercent: pct(pNeg, pTotal), neutralPercent: pct(pNeu, pTotal) },
      changes: { positive: change(pPos, ppPos), negative: change(pNeg, ppNeg), neutral: change(pNeu, ppNeu) },
      avgScore: parseFloat(avgScore.toFixed(3)),
      days
    });
  } catch (e) {
    console.error('Sentiment stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Sentiment: top keywords from real messages ──
app.get('/api/sentiment/keywords', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const start = new Date(Date.now() - days * 86400000);

    const messages = await Message.findAll({
      where: {
        to: null, // customer (incoming) messages only — don't count the bot's own replies
        timestamp: { [Op.gte]: start }
      },
      attributes: ['body', 'sentimentLabel'],
      limit: 2000
    });

    const aggregate = {};

    messages.forEach(msg => {
      const label = msg.sentimentLabel || 'neutral';
      const matches = matchDictionaryTermsInText(msg.body || '');

      matches.forEach(m => {
        if (!aggregate[m.keyword]) {
          aggregate[m.keyword] = {
            canonicalKeyword: m.keyword,
            count: 0,
            sentiment: m.sentiment,
            category: m.category,
            variants: {},
            positive: 0,
            negative: 0,
            neutral: 0
          };
        }

        aggregate[m.keyword].count += m.count;
        aggregate[m.keyword].variants[m.matchedVariant] = (aggregate[m.keyword].variants[m.matchedVariant] || 0) + m.count;
        aggregate[m.keyword][label] += m.count;
      });
    });

    const enrichedKeywords = Object.values(aggregate)
      .filter(k => k.count >= (k.sentiment === 'negative' ? 1 : 2))
      .map(k => {
        const topVariant = Object.entries(k.variants)
          .sort((a, b) => b[1] - a[1])[0]?.[0] || k.canonicalKeyword;

        const dominantObserved = k.positive >= k.negative && k.positive >= k.neutral
          ? 'positive'
          : k.negative >= k.positive && k.negative >= k.neutral
            ? 'negative'
            : 'neutral';

        let resolvedSentiment = dominantObserved;
        if (k.sentiment === 'negative' && k.negative >= k.positive) {
          resolvedSentiment = 'negative';
        } else if (k.sentiment === 'positive' && k.positive >= k.negative) {
          resolvedSentiment = 'positive';
        }

        return {
          word: k.canonicalKeyword,
          canonicalKeyword: k.canonicalKeyword,
          topVariant,
          count: k.count,
          sentiment: resolvedSentiment,
          category: k.category
        };
      })
      .sort((a, b) => b.count - a.count);

    // Keep list relevant while ensuring negative keywords are visible when available.
    const selected = [];
    const selectedSet = new Set();
    const pushUnique = (items = [], max = 30) => {
      for (const item of items) {
        if (selected.length >= max) break;
        if (selectedSet.has(item.canonicalKeyword)) continue;
        selected.push(item);
        selectedSet.add(item.canonicalKeyword);
      }
    };

    const negatives = enrichedKeywords.filter(k => k.sentiment === 'negative');
    const positives = enrichedKeywords.filter(k => k.sentiment === 'positive');
    const neutrals = enrichedKeywords.filter(k => k.sentiment === 'neutral');

    pushUnique(negatives, 8);
    pushUnique(positives, 16);
    pushUnique(neutrals, 24);
    pushUnique(enrichedKeywords, 30);

    const keywords = selected.slice(0, 30);

    res.json(keywords);
  } catch (e) {
    console.error('Keywords error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Sentiment: recent messages with sentiment for the feed ──
app.get('/api/sentiment/feed', async (req, res) => {
  try {
    const label = req.query.label || 'all';
    const days  = parseInt(req.query.days) || 7;
    const start = new Date(Date.now() - days * 86400000);

    const where = { timestamp: { [Op.gte]: start } };
    if (label !== 'all') where.sentimentLabel = label;

    const messages = await Message.findAll({
      where,
      attributes: ['id', 'fromName', 'from', 'body', 'timestamp', 'sentimentLabel', 'sentimentComparative'],
      order: [['timestamp', 'DESC']],
      limit: 50
    });

    res.json(messages.map(m => ({
      id: m.id,
      name: m.fromName || m.from,
      body: m.body,
      timestamp: m.timestamp,
      sentiment: m.sentimentLabel,
      score: m.sentimentComparative || 0
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get sentiment timeline
app.get('/api/sentiment/timeline', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const messages = await Message.findAll({
      where: {
        timestamp: { [Op.gte]: startDate }
      },
      attributes: ['timestamp', 'sentimentLabel'],
      order: [['timestamp', 'ASC']]
    });
    
    // Group by date and sentiment
    const timeline = {};
    messages.forEach(msg => {
      const date = msg.timestamp.toISOString().split('T')[0];
      const sentiment = msg.sentimentLabel;
      
      if (!timeline[date]) {
        timeline[date] = { date, positive: 0, negative: 0, neutral: 0 };
      }
      
      if (sentiment) {
        timeline[date][sentiment]++;
      }
    });
    
    const result = Object.values(timeline);
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching sentiment timeline:', error);
    res.status(500).json({ error: 'Failed to fetch sentiment timeline' });
  }
});

// Get messages containing a specific keyword
app.get('/api/sentiment/messages-by-keyword', async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword || keyword.trim().length === 0) {
      return res.status(400).json({ error: 'Keyword is required' });
    }

    const dictionaryTerm = findDictionaryTerm(keyword);
    const variants = dictionaryTerm
      ? [dictionaryTerm.keyword, ...(dictionaryTerm.aliases || [])]
      : [keyword];

    // Normalize variants the same way the aggregate does, so matching is consistent.
    const normVariants = [...new Set(variants.map(v => normalizeKeywordText(v)).filter(Boolean))];
    if (!normVariants.length) {
      return res.json({ count: 0, messages: [] });
    }

    // Coarse DB prefilter (customer messages only), then an exact whole-word
    // filter in JS so "na" doesn't match "banana" and "book" doesn't match
    // "facebook". Only messages where a variant appears as a standalone word survive.
    const orClauses = normVariants.map(v => ({ body: { [Op.like]: `%${v}%` } }));
    const candidates = await Message.findAll({
      where: { to: null, [Op.or]: orClauses },
      attributes: ['id', 'fromName', 'from', 'to', 'body', 'timestamp', 'sentimentLabel', 'sentimentComparative'],
      order: [['timestamp', 'DESC']],
      limit: 1000
    });

    const matchesWholeWord = (body) => {
      const haystack = ` ${normalizeKeywordText(body)} `;
      return normVariants.some(v => haystack.includes(` ${v} `));
    };

    const filtered = candidates.filter(m => matchesWholeWord(m.body));
    const count = filtered.length;
    const messages = filtered.slice(0, 500);

    // Build phone -> conversation name map so outgoing bot messages can still
    // show the correct client name in the chat modal header.
    const phones = [...new Set(messages.map(m => (m.to ? m.to : m.from)).filter(Boolean))];
    const conversations = phones.length
      ? await Conversation.findAll({
          where: { phoneNumber: { [Op.in]: phones } },
          attributes: ['phoneNumber', 'name']
        })
      : [];
    const nameByPhone = new Map(conversations.map(c => [c.phoneNumber, c.name]));

    res.json({
      count: count,
      messages: messages.map(m => ({
        ...(function () {
          const phone = m.to ? m.to : m.from;
          const resolvedName = nameByPhone.get(phone) || m.fromName || phone;
          return {
            id: m.id,
            name: resolvedName,
            // If message is outgoing (bot reply), open chat against recipient `to`.
            // If incoming, open chat against sender `from`.
            phone: phone,
            body: m.body,
            timestamp: m.timestamp,
            sentiment: m.sentimentLabel,
            score: m.sentimentComparative || 0,
            isBotMessage: !!m.to,
            canonicalKeyword: dictionaryTerm ? dictionaryTerm.keyword : keyword
          };
        })()
      }))
    });
  } catch (error) {
    console.error('Error fetching messages by keyword:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Send reply to a message
app.post('/api/messages/:id/reply', async (req, res) => {
  try {
    const { reply } = req.body;
    const message = await Message.findByPk(req.params.id);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!reply || !reply.trim()) return res.status(400).json({ error: 'Reply text is required' });

    // Forward to bot bridge
    const http = require('http');
    const phoneNumber = message.from;
    const payload = JSON.stringify({ phoneNumber, message: reply.trim() });
    const options = { hostname: '127.0.0.1', port: 3003, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };

    const result = await new Promise((resolve, reject) => {
      const r = http.request(options, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
      });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });

    if (result.body.success) {
      message.replied = true;
      await message.save();
      res.json({ success: true, message: 'Reply sent successfully' });
    } else {
      res.status(result.status).json({ error: result.body.error });
    }
  } catch (error) {
    res.status(503).json({ error: 'Bot is not running. Start it with: npm run bot' });
  }
});

// Mark message as read
app.patch('/api/messages/:id/read', async (req, res) => {
  try {
    const message = await Message.findByPk(req.params.id);
    
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    message.replied = true;
    await message.save();
    
    res.json({
      success: true,
      message: 'Message marked as read'
    });
  } catch (error) {
    console.error('Error marking message as read:', error);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// Get unique contacts/senders
app.get('/api/messages/contacts', async (req, res) => {
  try {
    const contacts = await Message.findAll({
      attributes: [
        [Message.sequelize.fn('DISTINCT', Message.sequelize.col('from')), 'from'],
        'fromName'
      ],
      group: ['from', 'fromName'],
      order: [['fromName', 'ASC']]
    });
    
    res.json(contacts.map(c => ({
      phone: c.from,
      name: c.fromName || c.from
    })));
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// Bulk delete messages
app.delete('/api/messages/bulk', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No message IDs provided' });
    }
    const deleted = await Message.destroy({ where: { id: ids } });
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('Error deleting messages:', error);
    res.status(500).json({ error: 'Failed to delete messages' });
  }
});

// Get conversation with a specific contact (all messages to/from that contact)
app.get('/api/messages/conversation/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;

    // Single query for the whole thread (incoming: from = phoneNumber,
    // outgoing/bot reply: to = phoneNumber). Sort by timestamp first, then by
    // id as a tie-breaker — WhatsApp timestamps only have second precision,
    // so a customer message and an immediate bot reply can land in the same
    // second; without the id tie-breaker their order was arbitrary (whichever
    // query happened to list it first), which showed replies out of sequence.
    const allMessages = await Message.findAll({
      where: {
        [Op.or]: [
          { from: phoneNumber },
          { to: phoneNumber }
        ]
      },
      order: [['timestamp', 'ASC'], ['id', 'ASC']]
    });

    // Format — isBot = true when WE sent it (to = phoneNumber)
    const formattedMessages = allMessages.map(msg => ({
      _id: msg.id,
      messageId: msg.messageId,
      from: msg.from,
      to: msg.to,
      fromName: msg.fromName,
      body: msg.body,
      timestamp: msg.timestamp,
      sentiment: {
        score: msg.sentimentScore,
        comparative: msg.sentimentComparative,
        label: msg.sentimentLabel,
        tokens: msg.sentimentTokens
      },
      isCommand: msg.isCommand,
      replied: msg.replied,
      isBot: msg.to === phoneNumber  // outgoing = bot reply
    }));

    res.json({
      messages: formattedMessages,
      total: formattedMessages.length,
      contact: phoneNumber
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// Meeting bookings history and slot availability check
function serializeMeeting(m, hostEmail = '') {
  const slotEndTime = new Date(m.slotEnd).getTime();
  const isExpired = m.status === 'booked' && Number.isFinite(slotEndTime) && slotEndTime < Date.now();

  return {
    id: m.id,
    phoneNumber: m.phoneNumber,
    fromName: m.fromName,
    topic: m.topic,
    sourceMessage: m.sourceMessage,
    confirmationMessageId: m.confirmationMessageId,
    slotStart: m.slotStart,
    slotEnd: m.slotEnd,
    timezone: m.timezone,
    durationMinutes: m.durationMinutes,
    status: m.status,
    zoomMeetingId: m.zoomMeetingId,
    zoomJoinUrl: m.zoomJoinUrl,
    zoomStartUrl: m.zoomStartUrl,
    zoomPassword: m.zoomPassword,
    hostEmail: hostEmail || getConfiguredRecoveryContacts().email || process.env.ADMIN_EMAIL || process.env.SMTP_USER || '',
    isExpired,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt
  };
}

app.get('/api/meetings', async (req, res) => {
  try {
    const phoneNumber = String(req.query.phoneNumber || '').trim();
    const status = String(req.query.status || 'all').trim();
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
    const toDate = req.query.toDate ? new Date(req.query.toDate) : null;
    const slotStart = req.query.slotStart ? new Date(req.query.slotStart) : null;
    const slotEnd = req.query.slotEnd ? new Date(req.query.slotEnd) : null;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const where = {};
    if (phoneNumber) where.phoneNumber = phoneNumber;
    if (status && status !== 'all') where.status = status;

    if (fromDate || toDate) {
      where.slotStart = {};
      if (fromDate && !Number.isNaN(fromDate.getTime())) where.slotStart[Op.gte] = fromDate;
      if (toDate && !Number.isNaN(toDate.getTime())) where.slotStart[Op.lte] = toDate;
    }

    if (slotStart && slotEnd && !Number.isNaN(slotStart.getTime()) && !Number.isNaN(slotEnd.getTime())) {
      where[Op.and] = [
        { slotStart: { [Op.lt]: slotEnd } },
        { slotEnd: { [Op.gt]: slotStart } }
      ];
      if (!where.status) where.status = 'booked';
    }

    const rows = await Meeting.findAll({
      where,
      order: [['slotStart', 'DESC']],
      limit
    });

    const { email: meetingHostEmail } = getConfiguredRecoveryContacts();
    const meetings = rows.map((row) => serializeMeeting(row, meetingHostEmail));

    if (slotStart && slotEnd && !Number.isNaN(slotStart.getTime()) && !Number.isNaN(slotEnd.getTime())) {
      return res.json({
        available: meetings.length === 0,
        conflicts: meetings
      });
    }

    res.json({ meetings, total: meetings.length });
  } catch (error) {
    console.error('Error fetching meetings:', error);
    res.status(500).json({ error: 'Failed to fetch meetings' });
  }
});

app.patch('/api/meetings/:id/cancel', async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: 'Invalid meeting id' });
    }

    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    if (meeting.status === 'cancelled') {
      const { email: meetingHostEmail } = getConfiguredRecoveryContacts();
      return res.json({ success: true, meeting: serializeMeeting(meeting, meetingHostEmail), message: 'Meeting is already cancelled.' });
    }

    meeting.status = 'cancelled';
    await meeting.save();

    const { email: meetingHostEmail } = getConfiguredRecoveryContacts();
    return res.json({ success: true, meeting: serializeMeeting(meeting, meetingHostEmail), message: 'Meeting cancelled successfully.' });
  } catch (error) {
    console.error('Error cancelling meeting:', error);
    return res.status(500).json({ error: 'Failed to cancel meeting' });
  }
});

app.delete('/api/meetings/:id', async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: 'Invalid meeting id' });
    }

    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    await meeting.destroy();
    return res.json({ success: true, message: 'Meeting deleted successfully.' });
  } catch (error) {
    console.error('Error deleting meeting:', error);
    return res.status(500).json({ error: 'Failed to delete meeting' });
  }
});

app.patch('/api/meetings/:id/reschedule', async (req, res) => {
  try {
    const meetingId = parseInt(req.params.id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: 'Invalid meeting id' });
    }

    const { slotStart, durationMinutes } = req.body || {};
    const parsedStart = new Date(slotStart);
    const parsedDuration = Math.max(15, Math.min(180, parseInt(durationMinutes || '30', 10) || 30));

    if (Number.isNaN(parsedStart.getTime())) {
      return res.status(400).json({ error: 'Invalid slot start date/time' });
    }

    if (parsedStart.getTime() <= Date.now() + 2 * 60 * 1000) {
      return res.status(400).json({ error: 'Please choose a future meeting slot' });
    }

    const parsedEnd = new Date(parsedStart.getTime() + parsedDuration * 60 * 1000);

    const meeting = await Meeting.findByPk(meetingId);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    const conflict = await Meeting.findOne({
      where: {
        id: { [Op.ne]: meeting.id },
        status: 'booked',
        [Op.and]: [
          { slotStart: { [Op.lt]: parsedEnd } },
          { slotEnd: { [Op.gt]: parsedStart } }
        ]
      },
      order: [['slotStart', 'ASC']]
    });

    const { email: meetingHostEmail } = getConfiguredRecoveryContacts();

    if (conflict) {
      return res.status(409).json({
        error: 'Requested slot is already booked',
        conflict: serializeMeeting(conflict, meetingHostEmail)
      });
    }

    const hasExistingMeetingLink = Boolean(meeting.zoomMeetingId || meeting.zoomJoinUrl);

    let nextLink = null;
    if (hasExistingMeetingLink) {
      const linkResult = await zoomService.createManagedMeeting({
        topic: meeting.topic || 'Client Meeting',
        startAt: parsedStart,
        durationMinutes: parsedDuration,
        agenda: `Rescheduled by dashboard for ${meeting.fromName || meeting.phoneNumber}`,
        phoneNumber: meeting.phoneNumber
      });

      if (!linkResult.success) {
        return res.status(502).json({
          error: 'Unable to regenerate meeting link right now. Please try again.',
          detail: linkResult.error || linkResult.reason
        });
      }

      nextLink = linkResult;
    }

    meeting.slotStart = parsedStart;
    meeting.slotEnd = parsedEnd;
    meeting.durationMinutes = parsedDuration;
    meeting.status = 'booked';

    if (nextLink) {
      meeting.zoomMeetingId = nextLink.meetingId || null;
      meeting.zoomJoinUrl = nextLink.joinUrl || null;
      meeting.zoomStartUrl = nextLink.startUrl || null;
      meeting.zoomPassword = nextLink.password || null;
    }

    await meeting.save();

    return res.json({ success: true, meeting: serializeMeeting(meeting, meetingHostEmail), message: 'Meeting rescheduled successfully.' });
  } catch (error) {
    console.error('Error rescheduling meeting:', error);
    return res.status(500).json({ error: 'Failed to reschedule meeting' });
  }
});

// Serve QR code image directly (much more reliable than base64)
app.get('/api/bot/qr.png', (req, res) => {
  const qrFile = path.join(__dirname, '../../frontend/qr-live.png');
  if (!fs.existsSync(qrFile)) {
    return res.status(404).send('QR not ready');
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(qrFile);
});

// Bot status endpoint
// First checks if the bot bridge (port 3003) is actually reachable.
// If the bridge is down the bot process isn't running, so we always return
// 'disconnected' — regardless of what the stale .bot-state.json says.
app.get('/api/bot/status', (req, res) => {
  const stateFile = path.join(__dirname, '../.bot-state.json');
  const qrFile    = path.join(__dirname, '../../frontend/qr-live.png');

  // Helper: read & return the state file value (falls back to disconnected)
  function sendStateFile() {
    try {
      if (!fs.existsSync(stateFile)) return res.json({ status: 'disconnected', qr: null });
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.status === 'qr') {
        if (!fs.existsSync(qrFile) || (Date.now() - state.timestamp) > 300000) {
          return res.json({ status: 'qr_expired', qr: null });
        }
        return res.json({ status: 'qr', qr: null, timestamp: state.timestamp });
      }
      return res.json(state);
    } catch (e) {
      return res.json({ status: 'disconnected', qr: null });
    }
  }

  // Ping the bot bridge with a short timeout.
  // If it responds → bot process is alive → trust the state file.
  // If it doesn't  → bot process is down  → always report disconnected.
  let responded = false;
  const ping = http.request(
    { hostname: 'localhost', port: 3003, path: '/ping', method: 'GET' },
    (pingRes) => {
      responded = true;
      pingRes.resume(); // drain so the socket closes cleanly
      sendStateFile();  // bot is alive, use real state
    }
  );
  ping.setTimeout(1200, () => {
    ping.destroy();
    if (!responded) {
      responded = true;
      // Bot bridge unreachable — clear the stale state file so the next
      // real start writes a fresh value, then report disconnected.
      try {
        fs.writeFileSync(stateFile, JSON.stringify({ status: 'disconnected', qr: null, timestamp: Date.now() }));
      } catch (_) {}
      res.json({ status: 'disconnected', qr: null });
    }
  });
  ping.on('error', () => {
    if (!responded) {
      responded = true;
      try {
        fs.writeFileSync(stateFile, JSON.stringify({ status: 'disconnected', qr: null, timestamp: Date.now() }));
      } catch (_) {}
      res.json({ status: 'disconnected', qr: null });
    }
  });
  ping.end();
});

// Disconnect WhatsApp — called by the dashboard Disconnect button
// Calls client.logout() on the bot which clears the session and triggers auto-QR flow
app.post('/api/bot/disconnect', async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      const r = http.request(
        { hostname: 'localhost', port: 3003, path: '/disconnect', method: 'GET' },
        (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ success: true }); }
          });
        }
      );
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
      r.on('error', reject);
      r.end();
    });
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: 'Bot bridge not reachable — is the bot running? (' + e.message + ')' });
  }
});

// Reinitialize WhatsApp bot — called by the dashboard Refresh button
// Forwards the request to the bot bridge (port 3003) which calls client.destroy() + client.initialize()
app.post('/api/bot/reinitialize', async (req, res) => {
  try {
    const result = await new Promise((resolve, reject) => {
      const r = http.request(
        { hostname: 'localhost', port: 3003, path: '/reinitialize', method: 'GET' },
        (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ success: true }); }
          });
        }
      );
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('timeout')); });
      r.on('error', reject);
      r.end();
    });
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: 'Bot bridge not reachable — is the bot running? (' + e.message + ')' });
  }
});

// Get current Groq API key (masked)
app.get('/api/settings/groq-key', (req, res) => {
  const key = process.env.GROQ_API_KEY || '';
  if (key && key.startsWith('gsk_')) {
    res.json({ configured: true, preview: key.substring(0, 8) + '••••••••••••••••••••' });
  } else {
    res.json({ configured: false, preview: '' });
  }
});

// Save Groq API key to .env file
app.post('/api/settings/groq-key', (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.startsWith('gsk_')) {
      return res.status(400).json({ error: 'Invalid Groq API key format. It should start with "gsk_".' });
    }
    const envFile = path.join(__dirname, '../.env');
    let envContent = fs.readFileSync(envFile, 'utf8');
    if (envContent.includes('GROQ_API_KEY=')) {
      envContent = envContent.replace(/GROQ_API_KEY=.*/g, `GROQ_API_KEY=${apiKey}`);
    } else {
      envContent += `\nGROQ_API_KEY=${apiKey}`;
    }
    fs.writeFileSync(envFile, envContent);
    process.env.GROQ_API_KEY = apiKey;
    // Re-init chatbot service with new key
    try {
      const Groq = require('groq-sdk');
      const chatbotService = require('./services/chatbotService');
      chatbotService.groq = new Groq({ apiKey });
      chatbotService.useAI = true;
      chatbotService.systemPrompt = chatbotService.loadSystemPrompt();
    } catch(e) {}
    res.json({ success: true, message: 'Groq API key saved and activated!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save key: ' + e.message });
  }
});

// Test Groq connection
app.post('/api/settings/test-groq', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey || !apiKey.startsWith('gsk_')) {
      return res.status(400).json({ error: 'Groq API key not configured. Please save your key first.' });
    }
    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey });
    const modelsToTry = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct'];
    for (const modelName of modelsToTry) {
      try {
        const completion = await groq.chat.completions.create({
          model: modelName,
          messages: [{ role: 'user', content: 'Reply with exactly: Groq connected!' }],
          max_tokens: 20
        });
        const text = completion.choices[0].message.content.trim();
        const chatbotService = require('./services/chatbotService');
        chatbotService.groq = groq;
        chatbotService.currentModel = modelName;
        chatbotService.useAI = true;
        chatbotService.rateLimitedUntil = 0;
        return res.json({ success: true, message: `✅ ${text} (model: ${modelName})` });
      } catch (err) {
        if (err.message?.includes('429')) continue;
        throw err;
      }
    }
    res.status(500).json({ error: 'All models rate-limited. Try again in a minute.' });
  } catch (e) {
    res.status(500).json({ error: 'Connection failed: ' + e.message.substring(0, 200) });
  }
});

// Save AI settings (system prompt, model)
// Get AI settings
app.get('/api/settings/ai', (req, res) => {
  try {
    const aiSettingsPath = path.join(__dirname, '../.ai-settings.json');
    if (fs.existsSync(aiSettingsPath)) {
      const settings = JSON.parse(fs.readFileSync(aiSettingsPath, 'utf8'));
      res.json({ success: true, settings });
    } else {
      res.json({ success: true, settings: {} });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to load AI settings: ' + e.message });
  }
});

app.post('/api/settings/ai', (req, res) => {
  try {
    const { systemPrompt, model, tone, enableAI } = req.body;
    const chatbotService = require('./services/chatbotService');

    // Apply in-memory
    if (systemPrompt) chatbotService.systemPrompt = systemPrompt;
    if (model) { chatbotService.currentModel = model; chatbotService.rateLimitedUntil = 0; }
    if (enableAI !== undefined) chatbotService.useAI = !!enableAI;
    // Reload system prompt so tone takes effect immediately
    if (tone !== undefined) chatbotService.systemPrompt = chatbotService.loadSystemPrompt();

    // Persist to file
    const aiSettingsPath = path.join(__dirname, '../.ai-settings.json');
    const existing = fs.existsSync(aiSettingsPath) ? JSON.parse(fs.readFileSync(aiSettingsPath, 'utf8')) : {};
    const updated = Object.assign(existing, {
      ...(systemPrompt !== undefined && { systemPrompt }),
      ...(model !== undefined && { model }),
      ...(tone !== undefined && { tone }),
      ...(enableAI !== undefined && { enableAI: !!enableAI }),
      updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(aiSettingsPath, JSON.stringify(updated, null, 2));

    res.json({ success: true, message: 'AI settings saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update settings: ' + e.message });
  }
});

// Get business profile
app.get('/api/settings/business-profile', (req, res) => {
  try {
    const profilePath = path.join(__dirname, '../.business-profile.json');
    if (fs.existsSync(profilePath)) {
      const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      res.json({ success: true, profile });
    } else {
      res.json({ success: true, profile: {} });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to load profile: ' + e.message });
  }
});

// Save business profile and rebuild system prompt
app.post('/api/settings/business-profile', (req, res) => {
  try {
    const { businessName, businessType, services, team, meetingSlots, contactInfo, language, extraInfo } = req.body;
    const profilePath = path.join(__dirname, '../.business-profile.json');
    const existing = fs.existsSync(profilePath)
      ? JSON.parse(fs.readFileSync(profilePath, 'utf8'))
      : {};

    const profile = {
      ...existing,
      businessName,
      businessType,
      services,
      team,
      meetingSlots,
      contactInfo,
      language,
      extraInfo,
      updatedAt: new Date().toISOString()
    };
    
    // Save to file
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
    
    // Build new system prompt from profile and update chatbotService
    const chatbotService = require('./services/chatbotService');
    chatbotService.systemPrompt = chatbotService.loadSystemPrompt();
    
    res.json({ success: true, message: '✅ Business profile saved! Bot is now trained with your info.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save profile: ' + e.message });
  }
});

// Website sync settings
app.get('/api/settings/website-sync', (req, res) => {
  try {
    const settings = readWebsiteSyncSettings();
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load website sync settings: ' + e.message });
  }
});

app.post('/api/settings/website-sync', (req, res) => {
  try {
    const settings = saveWebsiteSyncSettings(req.body || {});
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save website sync settings: ' + e.message });
  }
});

app.post('/api/settings/website-sync/run', async (req, res) => {
  try {
    const result = await runWebsiteSync({ force: true });
    if (result?.skipped && result.reason === 'missing_url') {
      return res.status(400).json({ error: 'Website URL is missing. Please save a URL first.' });
    }
    if (!result?.success) {
      return res.status(500).json({ error: result?.error || 'Website sync failed', result });
    }
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ error: 'Failed to run website sync: ' + e.message });
  }
});

app.get('/api/settings/business-hours', (req, res) => {
  try {
    res.json({ success: true, hours: readBusinessHoursSettings() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load business hours: ' + e.message });
  }
});

app.post('/api/settings/business-hours', (req, res) => {
  try {
    const incoming = req.body || {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const normalized = {};

    for (const day of days) {
      const current = incoming[day] || {};
      const fallback = BUSINESS_HOURS_DEFAULTS[day];
      normalized[day] = {
        enabled: !!current.enabled,
        start: typeof current.start === 'string' && current.start ? current.start : fallback.start,
        end: typeof current.end === 'string' && current.end ? current.end : fallback.end
      };
    }

    const saved = writeBusinessHoursSettings(normalized);
    res.json({ success: true, hours: saved, message: 'Business hours saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save business hours: ' + e.message });
  }
});

app.get('/api/settings/general', (req, res) => {
  try {
    res.json({ success: true, settings: readGeneralSettings() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load general settings: ' + e.message });
  }
});

app.post('/api/settings/general', (req, res) => {
  try {
    const saved = writeGeneralSettings(req.body || {});
    res.json({ success: true, settings: saved, message: 'General settings saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save general settings: ' + e.message });
  }
});

app.get('/api/settings/bot-behavior', (req, res) => {
  try {
    res.json({ success: true, settings: readBotBehaviorSettings() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load bot behavior settings: ' + e.message });
  }
});

app.post('/api/settings/bot-behavior', (req, res) => {
  try {
    const saved = writeBotBehaviorSettings(req.body || {});
    res.json({ success: true, settings: saved, message: 'Bot behavior settings saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save bot behavior settings: ' + e.message });
  }
});

app.get('/api/settings/security', (req, res) => {
  try {
    res.json({ success: true, settings: readSecuritySettings() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load security settings: ' + e.message });
  }
});

app.post('/api/settings/security', (req, res) => {
  try {
    const requested = req.body || {};
    if (requested.twoFactorEnabled) {
      const { email } = getConfiguredRecoveryContacts();
      if (!email) {
        return res.status(400).json({ success: false, error: 'Configure General Settings email before enabling 2FA' });
      }
    }

    const saved = writeSecuritySettings(requested);
    res.json({ success: true, settings: saved, message: 'Security settings saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save security settings: ' + e.message });
  }
});

app.get('/api/settings/advanced', (req, res) => {
  try {
    res.json({ success: true, settings: readAdvancedSettings() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load advanced settings: ' + e.message });
  }
});

app.post('/api/settings/advanced', (req, res) => {
  try {
    const saved = writeAdvancedSettings(req.body || {});
    res.json({ success: true, settings: saved, message: 'Advanced settings saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save advanced settings: ' + e.message });
  }
});

app.post('/api/settings/change-password', (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const authSettings = readAuthSettings();

    if (!verifyDashboardPassword(currentPassword, authSettings)) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect' });
    }

    const nextPassword = String(newPassword || '');
    if (nextPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters long' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(nextPassword, salt);
    writeAuthSettings({
      ...authSettings,
      passwordSalt: salt,
      passwordHash,
      passwordUpdatedAt: new Date().toISOString()
    });

    return res.json({ success: true, message: 'Password updated successfully' });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Failed to update password: ' + e.message });
  }
});

app.get('/api/settings/notifications', (req, res) => {
  try {
    res.json({ success: true, settings: readNotificationSettings(), recipient: getNotificationRecipient() });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load notification settings: ' + e.message });
  }
});

app.post('/api/settings/notifications', (req, res) => {
  try {
    const {
      desktopNotifications,
      soundAlerts,
      alertSoundType,
      emailNotifications,
      newMessageAlert,
      taskUpdates,
      negativeSentimentAlert,
      dailySummary
    } = req.body || {};

    const validSoundTypes = ['ding', 'double-beep', 'chime', 'alert', 'pop', 'triple-chime', 'sonar', 'bell-rise'];
    const updated = writeNotificationSettings({
      ...(desktopNotifications !== undefined && { desktopNotifications: !!desktopNotifications }),
      ...(soundAlerts !== undefined && { soundAlerts: !!soundAlerts }),
      ...(alertSoundType !== undefined && { alertSoundType: validSoundTypes.includes(alertSoundType) ? alertSoundType : 'ding' }),
      ...(emailNotifications !== undefined && { emailNotifications: !!emailNotifications }),
      ...(newMessageAlert !== undefined && { newMessageAlert: !!newMessageAlert }),
      ...(taskUpdates !== undefined && { taskUpdates: !!taskUpdates }),
      ...(negativeSentimentAlert !== undefined && { negativeSentimentAlert: !!negativeSentimentAlert }),
      ...(dailySummary !== undefined && { dailySummary: !!dailySummary })
    });

    // Run an immediate daily summary check after save so users can verify
    // the feature without waiting for the scheduler window.
    if (updated.emailNotifications && updated.dailySummary) {
      maybeSendDailySummaryEmail().catch(err => {
        console.error('Immediate daily summary check error:', err.message);
      });
    }

    res.json({ success: true, settings: updated, recipient: getNotificationRecipient(), message: 'Notification settings saved!' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save notification settings: ' + e.message });
  }
});

// Send message to a contact via WhatsApp
app.post('/api/messages/send', async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'Phone number and message are required' });
    }

    // Forward to bot process via internal bridge (port 3003)
    const http = require('http');
    const payload = JSON.stringify({ phoneNumber, message });
    const options = { hostname: '127.0.0.1', port: 3003, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } };

    const result = await new Promise((resolve, reject) => {
      const r = http.request(options, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
      });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });

    if (result.body.success) {
      res.json({ success: true, message: 'Message sent successfully', phoneNumber, body: message });
    } else {
      res.status(result.status).json({ error: result.body.error });
    }
  } catch (error) {
    res.status(503).json({ error: 'Bot is not running. Start it with: npm run bot' });
  }
});

// Send media/document attachment via bot bridge
app.post('/api/messages/send-media', async (req, res) => {
  try {
    const { phoneNumber, mediaData, mimeType, fileName } = req.body;
    if (!phoneNumber || !mediaData || !mimeType) {
      return res.status(400).json({ error: 'phoneNumber, mediaData, and mimeType are required' });
    }

    const http = require('http');
    const payload = JSON.stringify({ phoneNumber, mediaData, mimeType, fileName: fileName || 'file' });
    const options = {
      hostname: '127.0.0.1', port: 3003, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };

    const result = await new Promise((resolve, reject) => {
      const r = http.request(options, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
      });
      // 120s timeout — WhatsApp CDN upload can take several seconds for large media
      r.setTimeout(120000, () => { r.destroy(); reject(new Error('Media upload timed out after 120s')); });
      r.on('error', reject);
      r.write(payload);
      r.end();
    });

    if (result.body.success) {
      res.json({ success: true, message: 'Media sent successfully' });
    } else {
      res.status(result.status).json({ error: result.body.error });
    }
  } catch (error) {
    res.status(503).json({ error: 'Bot is not running. Start it with: npm run bot' });
  }
});

// Test endpoint to simulate new message (for testing real-time updates)
app.post('/api/test/message', async (req, res) => {
  try {
    const testMessage = await Message.create({
      messageId: `test_${Date.now()}`,
      from: '+923001234567',
      fromName: 'Test User',
      body: req.body.message || 'Test message for real-time updates!',
      timestamp: new Date(),
      sentimentScore: Math.random() > 0.5 ? 0.5 : -0.5,
      sentimentComparative: 0.1,
      sentimentLabel: Math.random() > 0.5 ? 'positive' : 'negative',
      sentimentTokens: JSON.stringify(['test']),
      isCommand: false,
      replied: false
    });
    
    // Broadcast stats update to all connected clients
    broadcastStatsUpdate();
    
    // Emit new message event
    const eventPayload = {
      id: testMessage.id,
      from: testMessage.fromName,
      body: testMessage.body,
      sentiment: testMessage.sentimentLabel,
      timestamp: testMessage.timestamp
    };
    io.emit('newMessage', eventPayload);
    await maybeSendEventNotificationEmail('newMessage', eventPayload);
    if (eventPayload.sentiment === 'negative') {
      await maybeSendEventNotificationEmail('negativeSentiment', eventPayload);
    }
    
    res.json({ 
      success: true, 
      message: 'Test message created',
      data: testMessage 
    });
  } catch (error) {
    console.error('Error creating test message:', error);
    res.status(500).json({ error: 'Failed to create test message' });
  }
});

// Test endpoint to simulate new task
app.post('/api/test/task', async (req, res) => {
  try {
    const testTask = await Task.create({
      description: req.body.description || 'Test task for real-time updates',
      from: '+923001234567',
      fromName: 'Test User',
      status: 'pending',
      priority: req.body.priority || 'medium',
      type: 'task',  // Changed from 'general' to 'task'
      messageRef: null,
      notes: ''
    });
    
    // Broadcast stats update to all connected clients
    broadcastStatsUpdate();
    
    // Emit new task event
    const taskPayload = {
      id: testTask.id,
      description: testTask.description,
      status: testTask.status,
      priority: testTask.priority,
      timestamp: testTask.createdAt
    };
    io.emit('newTask', taskPayload);
    await maybeSendEventNotificationEmail('newTask', taskPayload);
    
    res.json({ 
      success: true, 
      message: 'Test task created',
      data: testTask 
    });
  } catch (error) {
    console.error('Error creating test task:', error);
    res.status(500).json({ error: 'Failed to create test task' });
  }
});

// Return JSON 404 for unknown API routes (prevents HTML being returned to fetch calls)
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} /api${req.path}` });
});

// Serve dashboard SPA for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/index.html'));
});

const PORT = process.env.PORT || 3002;


server.listen(PORT, async () => {
  console.log(`\n===========================================`);
  console.log(`🚀 Dashboard Server Started`);
  console.log(`===========================================`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`===========================================\n`);
  console.log(`ℹ️  To enable message sending:`);
  console.log(`   Open another terminal and run: npm run bot`);
  console.log(`   Then scan the QR code to link WhatsApp\n`);

  startWebsiteSyncScheduler();

  setInterval(() => {
    maybeSendDailySummaryEmail().catch(err => {
      console.error('Daily summary scheduler error:', err.message);
    });
  }, 15 * 60 * 1000);

  setInterval(() => {
    applyDataRetentionPolicy()
      .then((result) => {
        if (result && !result.skipped && (result.deletedMessages > 0 || result.deletedConversations > 0)) {
          console.log(`🧹 Data retention cleanup: deleted ${result.deletedMessages} messages, ${result.deletedConversations} conversations`);
        }
      })
      .catch(err => {
        console.error('Data retention cleanup error:', err.message);
      });
  }, 6 * 60 * 60 * 1000);

  setTimeout(() => {
    applyDataRetentionPolicy().catch(err => {
      console.error('Initial data retention cleanup error:', err.message);
    });
  }, 10 * 1000);

  // Restore saved AI settings on startup
  try {
    const aiSettingsPath = path.join(__dirname, '../.ai-settings.json');
    if (fs.existsSync(aiSettingsPath)) {
      const s = JSON.parse(fs.readFileSync(aiSettingsPath, 'utf8'));
      const chatbotService = require('./services/chatbotService');
      if (s.systemPrompt) chatbotService.systemPrompt = s.systemPrompt;
      if (s.model) { chatbotService.currentModel = s.model; }
      if (s.enableAI !== undefined) chatbotService.useAI = s.enableAI;
      console.log('✅ Restored saved AI settings');
    }
  } catch (e) {}
});

module.exports = { app, setWhatsAppClient };
