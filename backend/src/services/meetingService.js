const { Op } = require('sequelize');
const Meeting = require('../models/Meeting');
const Message = require('../models/Message');
const zoomService = require('./zoomService');
const onboardingService = require('./onboardingService');
const emailService = require('./emailService');

const DEFAULT_TIMEZONE = process.env.MEETING_TIMEZONE || 'Asia/Karachi';
const DEFAULT_DURATION_MINUTES = 30;
const PENDING_SLOT_TTL_MS = 6 * 60 * 60 * 1000;
const MEETING_CONTEXT_WINDOW_MS = 2 * 60 * 60 * 1000;

const pendingSlotOffers = new Map();
const pendingSlotRequests = new Map();

const MEETING_KEYWORDS = [
  'meeting', 'zoom', 'call', 'appointment', 'session', 'slot', 'meet'
];

const LINK_KEYWORDS = [
  'link', 'meeting link', 'zoom link', 'join link', 'invite', 'joining link'
];

const CONFIRM_KEYWORDS = [
  'confirm', 'confirmed', 'book', 'booked', 'schedule', 'scheduled',
  'arrange', 'arranged', 'set up', 'setup', 'set-up',
  'pakka', 'done', 'yes confirm', 'confirm kar do', 'confirm krdo',
  'confirm hai', 'confirm he'
];

// Natural agreement words. These only count as a confirmation when the bot has
// already proposed a specific slot, so the client doesn't have to type the
// literal word "confirm" to finalize a meeting.
const SOFT_AGREEMENT_KEYWORDS = [
  'ok', 'okay', 'okey', 'yes', 'yeah', 'yep', 'yup', 'sure', 'fine',
  'great', 'perfect', 'sounds good', 'go ahead', 'book it', 'lets do it',
  'let\'s do it', 'agreed', 'accept', 'accepted',
  'haan', 'han', 'ji', 'ji haan', 'theek', 'theek hai', 'thik', 'thik hai',
  'acha', 'accha', 'chalega', 'sahi', 'bilkul', 'kardo', 'kar do', 'krdo'
];

const AVAILABILITY_KEYWORDS = [
  'available', 'availability', 'free', 'open', 'booked',
  'khali', 'khaali', 'empty', 'slot available', 'time available'
];

const NEGATION_KEYWORDS = [
  'cancel', 'dont', "don't", 'do not', 'not now', 'stop'
];

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

function normalizeText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9:\/\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getZonedDateParts(dateValue, timeZone) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const tzParts = getZonedDateParts(new Date(utcGuess), timeZone);
  if (!tzParts) return new Date(utcGuess);

  const asUtc = Date.UTC(
    tzParts.year,
    tzParts.month - 1,
    tzParts.day,
    tzParts.hour,
    tzParts.minute,
    tzParts.second
  );

  const offsetMs = asUtc - utcGuess;
  return new Date(utcGuess - offsetMs);
}

function applyTimeZoneToDate(dateValue, timeZone) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return d;

  return zonedTimeToUtc({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds()
  }, timeZone);
}

function normalizePhoneForStorage(phone = '') {
  if (!phone) return '';
  const s = String(phone || '').trim();
  // remove whatsapp suffix like @c.us
  const atIdx = s.indexOf('@');
  const base = atIdx > 0 ? s.slice(0, atIdx) : s;
  // ensure plus for international numbers if missing and starts with country code digits
  if (/^\d{10,15}$/.test(base)) return `+${base}`;
  return base;
}

function getPhoneKey(phone = '') {
  return normalizePhoneForStorage(phone) || String(phone || '').trim();
}

function hasAny(text, phrases = []) {
  return phrases.some((phrase) => text.includes(phrase));
}

function buildPhoneLookupVariants(phoneNumber = '') {
  const raw = String(phoneNumber || '').trim();
  if (!raw) return [];
  const base = raw.split('@')[0];
  const digits = base.replace(/\D/g, '');
  const variants = new Set([raw, base, digits, normalizePhoneForStorage(raw)]);
  if (digits) {
    variants.add(`+${digits}`);
    variants.add(`${digits}@c.us`);
    variants.add(`${digits}@lid`);
  }
  return [...variants].filter(Boolean);
}

function getMeetingDurationMinutes() {
  const parsed = parseInt(process.env.MEETING_DURATION_MINUTES || `${DEFAULT_DURATION_MINUTES}`, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DURATION_MINUTES;
  return Math.max(15, Math.min(180, parsed));
}

function rememberPendingSlot(phoneNumber, slotStart) {
  const key = getPhoneKey(phoneNumber);
  if (!key || !slotStart) return;
  pendingSlotOffers.set(key, {
    slotStart: new Date(slotStart).toISOString(),
    expiresAt: Date.now() + PENDING_SLOT_TTL_MS
  });
}

function consumePendingSlot(phoneNumber) {
  const key = getPhoneKey(phoneNumber);
  if (!key) return null;
  const stored = pendingSlotOffers.get(key);
  if (!stored) return null;
  if (Date.now() > stored.expiresAt) {
    pendingSlotOffers.delete(key);
    return null;
  }
  return new Date(stored.slotStart);
}

function clearPendingSlot(phoneNumber) {
  const key = getPhoneKey(phoneNumber);
  if (!key) return;
  pendingSlotOffers.delete(key);
}

function hasValidPendingSlot(phoneNumber) {
  const key = getPhoneKey(phoneNumber);
  if (!key) return false;
  const stored = pendingSlotOffers.get(key);
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) {
    pendingSlotOffers.delete(key);
    return false;
  }
  return true;
}

function rememberPendingSlotRequest(phoneNumber) {
  const key = getPhoneKey(phoneNumber);
  if (!key) return;
  pendingSlotRequests.set(key, { expiresAt: Date.now() + PENDING_SLOT_TTL_MS });
}

function clearPendingSlotRequest(phoneNumber) {
  const key = getPhoneKey(phoneNumber);
  if (!key) return;
  pendingSlotRequests.delete(key);
}

function hasPendingSlotRequest(phoneNumber) {
  const key = getPhoneKey(phoneNumber);
  if (!key) return false;
  const stored = pendingSlotRequests.get(key);
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) {
    pendingSlotRequests.delete(key);
    return false;
  }
  return true;
}

function parseHourMinute(hourRaw, minuteRaw, meridiemRaw) {
  let hour = parseInt(hourRaw, 10);
  const minute = parseInt(minuteRaw || '0', 10);
  const meridiem = (meridiemRaw || '').toLowerCase();

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === 'pm') hour += 12;
  } else {
    if (hour < 0 || hour > 23) return null;
  }

  return { hour, minute };
}

function extractTime(text = '') {
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (ampm) {
    return parseHourMinute(ampm[1], ampm[2], ampm[3]);
  }

  const hhmm = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (hhmm) {
    return parseHourMinute(hhmm[1], hhmm[2], '');
  }

  return null;
}

function extractExplicitDate(text = '') {
  const ymd = text.match(/\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  if (ymd) {
    const year = parseInt(ymd[1], 10);
    const month = parseInt(ymd[2], 10) - 1;
    const day = parseInt(ymd[3], 10);
    return { year, month, day };
  }

  const dmy = text.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const month = parseInt(dmy[2], 10) - 1;
    const year = parseInt(dmy[3], 10);
    return { year, month, day };
  }

  return null;
}

function extractRelativeDate(text = '', reference = new Date()) {
  const normalized = normalizeText(text);

  if (normalized.includes('today') || normalized.includes('aj')) {
    return new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  }

  if (normalized.includes('tomorrow') || normalized.includes('kal')) {
    const d = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    d.setDate(d.getDate() + 1);
    return d;
  }

  for (const [name, dayIndex] of Object.entries(WEEKDAYS)) {
    if (!normalized.includes(name)) continue;

    const base = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    const currentDay = base.getDay();
    let delta = (dayIndex - currentDay + 7) % 7;
    if (delta === 0) delta = 7;
    base.setDate(base.getDate() + delta);
    return base;
  }

  return null;
}

function parseSlotDateTime(text = '', { referenceDate = new Date(), requireDateSignal = false } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const time = extractTime(normalized);
  if (!time) return null;

  const explicitDate = extractExplicitDate(normalized);
  const relativeDate = extractRelativeDate(normalized, referenceDate);

  if (requireDateSignal && !explicitDate && !relativeDate) {
    return null;
  }

  let baseDate;
  if (explicitDate) {
    baseDate = new Date(explicitDate.year, explicitDate.month, explicitDate.day);
  } else if (relativeDate) {
    baseDate = new Date(relativeDate.getFullYear(), relativeDate.getMonth(), relativeDate.getDate());
  } else {
    baseDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  }

  baseDate.setHours(time.hour, time.minute, 0, 0);

  let tzDate = applyTimeZoneToDate(baseDate, DEFAULT_TIMEZONE);

  if (!explicitDate && !relativeDate) {
    if (tzDate.getTime() <= referenceDate.getTime() + (5 * 60 * 1000)) {
      tzDate.setUTCDate(tzDate.getUTCDate() + 1);
    }
  }

  if (Number.isNaN(tzDate.getTime())) return null;
  return tzDate;
}

function formatSlotForUser(dateValue) {
  const d = new Date(dateValue);
  return d.toLocaleString('en-PK', {
    timeZone: DEFAULT_TIMEZONE,
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

async function getRecentConversation(phoneNumber, limit = 12) {
  const variants = buildPhoneLookupVariants(phoneNumber);
  if (!variants.length) return [];
  return Message.findAll({
    where: {
      [Op.or]: [
        { from: { [Op.in]: variants } },
        { to: { [Op.in]: variants } }
      ]
    },
    order: [['timestamp', 'DESC']],
    limit
  });
}

async function resolveSlotStart(phoneNumber, messageBody, { allowFallback = true } = {}) {
  const now = new Date();

  const fromCurrentMessage = parseSlotDateTime(messageBody, {
    referenceDate: now,
    requireDateSignal: false
  });
  if (fromCurrentMessage) return fromCurrentMessage;

  // Only fall back to an earlier offered slot or scan old messages when the
  // client is actually trying to confirm/continue a specific booking. A brand
  // new, generic message (e.g. "is a meeting possible?") has no time of its
  // own and should NOT silently inherit a stale slot from days/weeks ago.
  if (!allowFallback) return null;

  const fromPendingSlot = consumePendingSlot(phoneNumber);
  if (fromPendingSlot) return fromPendingSlot;

  const recentMessages = await getRecentConversation(phoneNumber, 12);
  for (const message of recentMessages) {
    const parsed = parseSlotDateTime(message.body || '', {
      referenceDate: now,
      requireDateSignal: true
    });
    if (parsed) return parsed;
  }

  return null;
}

async function findExactBooking(phoneNumber, slotStart) {
  const normalizedPhone = normalizePhoneForStorage(phoneNumber);
  const variants = buildPhoneLookupVariants(phoneNumber);
  const phoneVariants = [...new Set([...variants, normalizedPhone])].filter(Boolean);
  return Meeting.findOne({
    where: {
      phoneNumber: {
        [Op.in]: phoneVariants
      },
      status: 'booked',
      slotStart
    },
    order: [['createdAt', 'DESC']]
  });
}

async function findLatestBooking(phoneNumber) {
  const normalizedPhone = normalizePhoneForStorage(phoneNumber);
  const variants = buildPhoneLookupVariants(phoneNumber);
  const phoneVariants = [...new Set([...variants, normalizedPhone])].filter(Boolean);
  return Meeting.findOne({
    where: {
      phoneNumber: {
        [Op.in]: phoneVariants
      },
      status: 'booked'
    },
    order: [['slotStart', 'DESC']]
  });
}

async function findConflict(slotStart, slotEnd) {
  return Meeting.findOne({
    where: {
      status: 'booked',
      [Op.and]: [
        { slotStart: { [Op.lt]: slotEnd } },
        { slotEnd: { [Op.gt]: slotStart } }
      ]
    },
    order: [['slotStart', 'ASC']]
  });
}

async function isMeetingConfirmationIntent(normalizedText, phoneNumber) {
  if (!hasAny(normalizedText, CONFIRM_KEYWORDS)) return false;
  if (hasAny(normalizedText, NEGATION_KEYWORDS)) return false;

  if (hasAny(normalizedText, MEETING_KEYWORDS) || normalizedText.includes('slot') || normalizedText.includes('time')) {
    return true;
  }

  const recent = await getRecentConversation(phoneNumber, 6);
  return recent.some((msg) => hasAny(normalizeText(msg.body || ''), MEETING_KEYWORDS));
}

function isSoftAgreement(normalizedText) {
  if (!normalizedText) return false;
  if (hasAny(normalizedText, NEGATION_KEYWORDS)) return false;
  return hasAny(normalizedText, SOFT_AGREEMENT_KEYWORDS);
}

function isMeetingAvailabilityIntent(normalizedText) {
  if (!hasAny(normalizedText, AVAILABILITY_KEYWORDS)) return false;
  return hasAny(normalizedText, MEETING_KEYWORDS) || normalizedText.includes('slot') || normalizedText.includes('time');
}

function isMeetingLinkRequest(normalizedText) {
  return hasAny(normalizedText, LINK_KEYWORDS);
}

async function hasRecentMeetingContext(phoneNumber) {
  const recent = await getRecentConversation(phoneNumber, 8);
  if (!recent.length) return false;
  const now = Date.now();
  return recent.some((msg) => {
    const ts = new Date(msg.timestamp || msg.createdAt || 0).getTime();
    if (!ts || now - ts > MEETING_CONTEXT_WINDOW_MS) return false;
    const text = normalizeText(msg.body || '');
    return hasAny(text, MEETING_KEYWORDS) || text.includes('slot');
  });
}

function buildMeetingTopic(fromName, phoneNumber) {
  const attendee = String(fromName || '').trim() || phoneNumber;
  return `Client Meeting - ${attendee}`;
}

function slotInputGuidance() {
  return 'Please share exact meeting slot with date and time, for example: "tomorrow 3:00 PM" or "2026-04-25 14:30".';
}

function buildExistingBookingReply(existing) {
  const when = formatSlotForUser(existing.slotStart);
  return `Meeting already booked for ${when}.\nMeeting Link: ${existing.zoomJoinUrl}`;
}

async function maybeHandleMeetingMessage({ phoneNumber, fromName, messageBody, messageId }) {
  const normalized = normalizeText(messageBody);
  if (!normalized) return { handled: false };

  if (isMeetingLinkRequest(normalized)) {
    const latest = await findLatestBooking(phoneNumber);
    if (latest?.zoomJoinUrl) {
      return { handled: true, response: buildExistingBookingReply(latest) };
    }
    return {
      handled: true,
      response: 'I do not see a confirmed meeting yet. Please share your preferred date and time so I can schedule it.'
    };
  }

  const emailCapture = await onboardingService.captureEmailFromMessage(phoneNumber, messageBody, fromName);
  const profile = await onboardingService.getProfile(phoneNumber);
  const clientEmail = (emailCapture.email || String(profile?.email || '').trim()).toLowerCase();
  const pendingSlotExists = hasValidPendingSlot(phoneNumber);
  const pendingSlotRequest = hasPendingSlotRequest(phoneNumber);

  let availabilityIntent = isMeetingAvailabilityIntent(normalized);
  let confirmationIntent = await isMeetingConfirmationIntent(normalized, phoneNumber);
  const explicitTimeMention = Boolean(
    extractTime(normalized) || extractExplicitDate(normalized) || extractRelativeDate(normalized)
  );
  const hasMeetingKeyword = hasAny(normalized, MEETING_KEYWORDS);

  if (!availabilityIntent && !confirmationIntent && hasMeetingKeyword) {
    availabilityIntent = true;
  }

  if (!confirmationIntent && hasMeetingKeyword && explicitTimeMention) {
    confirmationIntent = true;
  }

  if (!availabilityIntent && !confirmationIntent && explicitTimeMention && pendingSlotRequest) {
    confirmationIntent = true;
  }

  if (!availabilityIntent && !confirmationIntent && explicitTimeMention) {
    const recentMeetingContext = await hasRecentMeetingContext(phoneNumber);
    if (recentMeetingContext) {
      confirmationIntent = true;
    }
  }

  // If we already proposed a specific slot, a plain "ok / yes / haan / theek hai"
  // is enough to finalize — no need for the client to type the word "confirm".
  if (!confirmationIntent && pendingSlotExists && isSoftAgreement(normalized)) {
    confirmationIntent = true;
  }

  if (!availabilityIntent && !confirmationIntent) {
    if (emailCapture.updated && pendingSlotExists) {
      return {
        handled: true,
        response: 'Thanks, your email is saved. Please send "confirm" to finalize your meeting and receive details by email.'
      };
    }
    return { handled: false };
  }

  const slotStart = await resolveSlotStart(phoneNumber, messageBody, {
    allowFallback: confirmationIntent || pendingSlotRequest
  });
  if (!slotStart) {
    rememberPendingSlotRequest(phoneNumber);
    return {
      handled: true,
      response: `Sure. ${slotInputGuidance()}`
    };
  }

  if (slotStart.getTime() <= Date.now() + (5 * 60 * 1000)) {
    rememberPendingSlotRequest(phoneNumber);
    return {
      handled: true,
      response: 'This slot is too close or in the past. Please share a future slot with date and time.'
    };
  }

  const durationMinutes = getMeetingDurationMinutes();
  const slotEnd = new Date(slotStart.getTime() + (durationMinutes * 60 * 1000));
  const conflict = await findConflict(slotStart, slotEnd);

  if (availabilityIntent && !confirmationIntent && !explicitTimeMention) {
    if (conflict) {
      clearPendingSlot(phoneNumber);
      return {
        handled: true,
        response: `This slot is already booked at ${formatSlotForUser(conflict.slotStart)}. Please pick another time.`
      };
    }

    rememberPendingSlot(phoneNumber, slotStart);
    return {
      handled: true,
      response: `This slot is available: ${formatSlotForUser(slotStart)}. If you want, send "confirm" and I will create meeting link instantly.`
    };
  }

  const existingForSameClient = await findExactBooking(phoneNumber, slotStart);
  if (existingForSameClient) {
    clearPendingSlot(phoneNumber);
    clearPendingSlotRequest(phoneNumber);
    return {
      handled: true,
      response: buildExistingBookingReply(existingForSameClient)
    };
  }

  if (conflict) {
    clearPendingSlot(phoneNumber);
    rememberPendingSlotRequest(phoneNumber);
    return {
      handled: true,
      response: `This slot is already booked at ${formatSlotForUser(conflict.slotStart)}. Please share another slot.`
    };
  }

  if (messageId) {
    const existingByMessage = await Meeting.findOne({ where: { confirmationMessageId: messageId } });
    if (existingByMessage) {
      clearPendingSlot(phoneNumber);
      clearPendingSlotRequest(phoneNumber);
      return {
        handled: true,
        response: buildExistingBookingReply(existingByMessage)
      };
    }
  }

  if (!clientEmail) {
    rememberPendingSlot(phoneNumber, slotStart);
    return {
      handled: true,
      response: 'Before I confirm this meeting, please share your email address so I can send meeting details instantly.'
    };
  }

  const topic = buildMeetingTopic(fromName, phoneNumber);
  const meetingLink = await zoomService.createManagedMeeting({
    topic,
    startAt: slotStart,
    durationMinutes,
    agenda: `Auto-booked via WhatsApp bot for ${fromName || phoneNumber}`,
    phoneNumber
  });

  if (!meetingLink.success) {
    console.error('Meeting link creation failed:', meetingLink.error || meetingLink.reason);
    return {
      handled: true,
      response: 'Slot is available, but I could not generate a meeting link right now. Please try again in a moment.'
    };
  }

  const booking = await Meeting.create({
    phoneNumber: normalizePhoneForStorage(phoneNumber),
    fromName,
    topic,
    sourceMessage: messageBody,
    confirmationMessageId: messageId || null,
    slotStart,
    slotEnd,
    timezone: DEFAULT_TIMEZONE,
    durationMinutes,
    status: 'booked',
    zoomMeetingId: meetingLink.meetingId,
    zoomJoinUrl: meetingLink.joinUrl,
    zoomStartUrl: meetingLink.startUrl,
    zoomPassword: meetingLink.password || null
  });

  let clientEmailSent = false;
  let adminEmailSent = false;
  let clientEmailKnown = false;

  try {
    const emailProfile = {
      name: (profile?.name || fromName || '').trim(),
      phoneNumber: profile?.phoneNumber || normalizePhoneForStorage(phoneNumber),
      email: clientEmail || ''
    };

    clientEmailKnown = Boolean(emailProfile.email);
    const emailResult = await emailService.sendMeetingNotifications(booking, emailProfile);
    clientEmailSent = !!emailResult.clientSent;
    adminEmailSent = !!emailResult.adminSent;
  } catch (emailErr) {
    console.error('Meeting email notification error:', emailErr.message);
  }

  clearPendingSlot(phoneNumber);
  clearPendingSlotRequest(phoneNumber);

  const linkLabel = meetingLink.provider === 'zoom' ? 'Zoom' : 'Meeting';

  return {
    handled: true,
    response:
      `Meeting confirmed for ${formatSlotForUser(booking.slotStart)}.\n` +
      `${linkLabel} Link: ${booking.zoomJoinUrl}\n` +
      `Meeting ID: ${booking.zoomMeetingId}` +
      `${clientEmailSent ? '\nClient email sent.' : (clientEmailKnown ? '\nClient email could not be sent right now.' : '\nPlease share your email to receive meeting details.')}` +
      `${adminEmailSent ? '\nAdmin notification sent.' : '\nAdmin notification could not be sent.'}`
  };
}

module.exports = {
  maybeHandleMeetingMessage,
  formatSlotForUser
};