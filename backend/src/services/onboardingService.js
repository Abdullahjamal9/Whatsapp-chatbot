const { Op } = require('sequelize');
const UserProfile = require('../models/UserProfile');
const Groq = require('groq-sdk');
const emailService = require('./emailService');

// In-memory state per phone number (survives bot restart via DB fallback)
// States: 'asking_name' | 'asking_designation' | 'asking_phone' | 'asking_email'
const states = new Map();
const pendingProfiles = new Map();
const onboardingSnoozeUntil = new Map();
const pendingConversationEmail = new Set();
const ONBOARDING_SNOOZE_MS = 12 * 60 * 60 * 1000; // 12 hours
const NAME_UPDATE_WINDOW_MS = 5 * 60 * 1000;
const lastNameUpdateAt = new Map();

const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

const FIELD_BY_STATE = {
  asking_name: 'name',
  asking_designation: 'designation',
  asking_phone: 'phone',
  asking_email: 'email'
};

const QUESTIONS = {
  asking_name:
    '👋 *Welcome!* Before we get started, I\'d like to note down a few details.\n\nWhat is your *full name*?',
  asking_designation:
    'Nice to meet you, *{name}*! 😊\n\nWhat is your *designation* or job title?',
  asking_phone:
    'Got it! What is your *phone number*?\n_(Include country code, e.g. +92 300 1234567)_',
  asking_email:
    'Almost done! 🎉 What is your *email address*?\n_(We\'ll send you a summary of our conversation after each chat.)_'
};

function isGreeting(text = '') {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const greetings = [
    'hi', 'hello', 'hey', 'salam', 'assalamualaikum', 'aoa',
    'good morning', 'good afternoon', 'good evening'
  ];
  return greetings.some(g => t === g || t.startsWith(g + ' '));
}

function greetAndAsk(question) {
  return `👋 Hello!\n\n${question}`;
}

function getQuestionForState(state, profile = {}) {
  if (state === 'asking_designation') {
    return QUESTIONS.asking_designation.replace('{name}', profile.name || 'there');
  }
  return QUESTIONS[state] || QUESTIONS.asking_name;
}

function isDeferralMessage(text = '') {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('catch you later') ||
    t.includes('talk later') ||
    t.includes('later') ||
    t.includes('brb') ||
    t.includes('busy') ||
    t.includes('kal baat') ||
    t.includes('baad me') ||
    t.includes('abhi nahi') ||
    t.includes('not now') ||
    t.includes('later bro')
  );
}

function isGoodbyeMessage(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const patterns = [
    'bye',
    'goodbye',
    'allah hafiz',
    'khuda hafiz',
    'see you',
    'take care',
    'ok bye',
    'bye bye'
  ];
  return patterns.some(p => t === p || t.startsWith(`${p} `) || t.includes(` ${p}`));
}

function isSkipEmailMessage(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (
    t === 'skip' ||
    t === 'no' ||
    t.includes('no email') ||
    t.includes('dont send') ||
    t.includes("don't send") ||
    t.includes('skip email')
  );
}

function isContinueMessage(text = '') {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('continue') ||
    t.includes('start again') ||
    t.includes('let\'s continue') ||
    t.includes('lets continue') ||
    t.includes('ready now') ||
    t.includes('i\'m back') ||
    t.includes('im back')
  );
}

function detectRequestedField(text = '') {
  const t = String(text || '').toLowerCase();
  if (!t) return null;

  const has = (...words) => words.some(w => t.includes(w));

  if (has('name', 'full name', 'mera naam', 'my name')) return 'asking_name';
  if (has('designation', 'job title', 'position', 'role')) return 'asking_designation';
  if (has('phone', 'number', 'contact', 'mobile')) return 'asking_phone';
  if (has('email', 'mail', '@')) return 'asking_email';
  return null;
}

function isFeedbackOrCorrection(text = '') {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('not asked') ||
    t.includes("didn't ask") ||
    t.includes('did not ask') ||
    t.includes('you have not') ||
    t.includes('pehle') ||
    t.includes('first') ||
    t.includes('wrong')
  );
}

function isRefusalOrComplaint(text = '') {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('not telling') ||
    t.includes("won't tell") ||
    t.includes('dont tell') ||
    t.includes("don't tell") ||
    t.includes('disturb') ||
    t.includes('leave me') ||
    t.includes('stop messaging') ||
    t.includes('nahi bata') ||
    t.includes('pareshan')
  );
}

function isLikelyName(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return false;

  // Reject long conversational sentences.
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  if (raw.length > 40) return false;

  // Name should mostly be alphabetic with spaces/dots/hyphen.
  const nameRegex = /^[a-zA-Z][a-zA-Z .'-]{1,38}$/;
  if (!nameRegex.test(raw)) return false;

  // Avoid obvious sentence-like content in name field.
  const lower = raw.toLowerCase();
  const sentenceSignals = [' i ', ' you ', 'my ', 'your ', 'not ', 'because', 'disturb'];
  if (sentenceSignals.some(s => (` ${lower} `).includes(s))) return false;

  return true;
}

function isLikelyDesignation(text = '') {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.length < 2 || t.length > 60) return false;
  // Reject obvious sentence-like complaints in designation field
  const lower = t.toLowerCase();
  if (isRefusalOrComplaint(lower) || isDeferralMessage(lower)) return false;
  return true;
}

function normalizePhone(text = '') {
  const raw = String(text || '').trim();
  const cleaned = raw.replace(/[^\d+]/g, '');
  return cleaned;
}

function buildPhoneLookupVariants(phoneNumber = '') {
  const raw = String(phoneNumber || '').trim();
  if (!raw) return [];
  const base = raw.split('@')[0];
  const digits = base.replace(/\D/g, '');
  const variants = new Set([raw, base, digits]);
  if (digits) {
    variants.add(`+${digits}`);
    variants.add(`${digits}@c.us`);
    variants.add(`${digits}@lid`);
  }
  return [...variants].filter(Boolean);
}

async function findProfileByPhone(phoneNumber) {
  const variants = buildPhoneLookupVariants(phoneNumber);
  if (!variants.length) return null;
  return UserProfile.findOne({
    where: {
      [Op.or]: [
        { phoneNumber: { [Op.in]: variants } },
        { contactPhone: { [Op.in]: variants } }
      ]
    }
  });
}

function isLikelyPhone(text = '') {
  const p = normalizePhone(text);
  const digits = p.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

function isLikelyEmail(text = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text || '').trim());
}

function validateByState(state, value) {
  const v = String(value || '').trim();
  if (!v) return false;
  switch (state) {
    case 'asking_name': return isLikelyName(v);
    case 'asking_designation': return isLikelyDesignation(v);
    case 'asking_phone': return isLikelyPhone(v);
    case 'asking_email': return isLikelyEmail(v);
    default: return false;
  }
}

function createEmptyDraft(phoneNumber) {
  return {
    phoneNumber,
    name: '',
    designation: '',
    contactPhone: '',
    email: '',
    onboardingComplete: false
  };
}

function getWorkingProfile(phoneNumber, dbProfile) {
  if (pendingProfiles.has(phoneNumber)) {
    return pendingProfiles.get(phoneNumber);
  }

  if (dbProfile && !dbProfile.onboardingComplete) {
    const draft = {
      phoneNumber,
      name: dbProfile.name || '',
      designation: dbProfile.designation || '',
      contactPhone: dbProfile.contactPhone || '',
      email: dbProfile.email || '',
      onboardingComplete: false
    };
    pendingProfiles.set(phoneNumber, draft);
    return draft;
  }

  const draft = createEmptyDraft(phoneNumber);
  pendingProfiles.set(phoneNumber, draft);
  return draft;
}

async function persistCompletedProfile(phoneNumber, draft) {
  const values = {
    phoneNumber,
    name: draft.name,
    designation: draft.designation,
    contactPhone: draft.contactPhone,
    email: draft.email,
    onboardingComplete: true
  };

  const existing = await findProfileByPhone(phoneNumber);
  if (existing) {
    Object.assign(existing, values);
    await existing.save();
    return existing;
  }

  return UserProfile.create(values);
}

async function classifyOnboardingReply(state, profile, userText) {
  if (!groq) return null;
  const text = String(userText || '').trim();
  if (!text) return null;

  const prompt = `You are an onboarding reply classifier.
Current onboarding step: ${state}.
Expected field: ${FIELD_BY_STATE[state] || 'unknown'}.
Known profile:
- name: ${profile?.name || ''}
- designation: ${profile?.designation || ''}
- contactPhone: ${profile?.contactPhone || ''}
- email: ${profile?.email || ''}

Classify the user message into one intent:
- valid_answer
- correction
- refusal
- deferral
- greeting
- unclear

Also identify field (name/designation/phone/email/none) and extracted value if present.

Return strict JSON only:
{"intent":"...","field":"...","value":"...","confidence":0.0}`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      max_tokens: 120,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: text }
      ]
    });

    const content = completion?.choices?.[0]?.message?.content?.trim() || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    if (!parsed || typeof parsed !== 'object') return null;
    return {
      intent: String(parsed.intent || 'unclear').toLowerCase(),
      field: String(parsed.field || 'none').toLowerCase(),
      value: String(parsed.value || '').trim(),
      confidence: Number(parsed.confidence || 0)
    };
  } catch (_) {
    return null;
  }
}

/**
 * Main entry point called on every incoming message.
 *
 * Returns:
 *   { response: string, done: boolean }  — still onboarding; send response & stop
 *   null                                  — onboarding complete; proceed normally
 */
async function processOnboarding(phoneNumber, messageText) {
  const dbProfile = await findProfileByPhone(phoneNumber);

  // ── Already complete ─────────────────────────────────────────────────────
  if (dbProfile?.onboardingComplete) {
    pendingProfiles.delete(phoneNumber);

    const answer = String(messageText || '').trim();
    const recentUpdate = lastNameUpdateAt.get(phoneNumber) || 0;
    const withinWindow = Date.now() - recentUpdate < NAME_UPDATE_WINDOW_MS;

    // If user tries to provide another name later, ignore to avoid flip-flop.
    if (!withinWindow && isLikelyName(answer) && answer.length <= 40) {
      return null;
    }

    return null;
  }

  const profile = getWorkingProfile(phoneNumber, dbProfile);

  const hasAllCoreFields = Boolean(profile.name && profile.designation && profile.contactPhone);
  if (hasAllCoreFields) {
    profile.onboardingComplete = true;
    await persistCompletedProfile(phoneNumber, profile);
    pendingProfiles.delete(phoneNumber);
    states.delete(phoneNumber);
    return null;
  }

  // ── Brand new or not-started user: ask first question (no DB write yet) ─
  if (!profile.name && !profile.designation && !profile.contactPhone && !profile.email && !states.get(phoneNumber)) {
    states.set(phoneNumber, 'asking_name');
    return { response: QUESTIONS.asking_name, done: false };
  }

  // ── Restore state after bot restart (in-memory lost) ──────────────────────
  let state = states.get(phoneNumber);
  if (!state) {
    if (!profile.name)              state = 'asking_name';
    else if (!profile.designation)  state = 'asking_designation';
    else if (!profile.contactPhone) state = 'asking_phone';
    else if (!profile.email)        state = 'asking_email';
    else {
      // All fields filled but flag wasn't set — fix silently
      profile.onboardingComplete = true;
      await persistCompletedProfile(phoneNumber, profile);
      pendingProfiles.delete(phoneNumber);
      return null;
    }
    states.set(phoneNumber, state);
  }

  // If user asked to continue later, do not interrupt normal conversation.
  const snoozedUntil = onboardingSnoozeUntil.get(phoneNumber) || 0;
  if (Date.now() < snoozedUntil) {
    const txt = String(messageText || '').trim();
    if (isContinueMessage(txt)) {
      onboardingSnoozeUntil.delete(phoneNumber);
      return {
        response: `Great 👍 Let's continue.\n\n${getQuestionForState(state, profile)}`,
        done: false
      };
    }
    return null;
  }

  const answer = (messageText || '').trim();

  // Hybrid: use LLM to understand messy language, but keep code in control.
  const ai = await classifyOnboardingReply(state, profile, answer);

  // User exits before onboarding completion:
  // capture email immediately (if missing) so conversation history can still be sent.
  if (isGoodbyeMessage(answer)) {
    if (profile?.email) {
      try {
        await emailService.sendConversationHistory(profile);
      } catch (_) {}

      onboardingSnoozeUntil.set(phoneNumber, Date.now() + ONBOARDING_SNOOZE_MS);
      return {
        response: '👋 Sure! I have sent your conversation summary to your email.\nWhen you are ready, type *continue* to complete your profile.',
        done: false
      };
    }

    pendingConversationEmail.add(phoneNumber);
    states.set(phoneNumber, 'asking_email');
    return {
      response:
        '👋 Before you go, please share your *email address* so I can send your chat summary now.\n\nYou can also type *skip* if you do not want the summary email.',
      done: false
    };
  }

  if (ai?.intent === 'greeting' && ai.confidence >= 0.6) {
    return { response: greetAndAsk(getQuestionForState(state, profile)), done: false };
  }

  if (isDeferralMessage(answer)) {
    onboardingSnoozeUntil.set(phoneNumber, Date.now() + ONBOARDING_SNOOZE_MS);
    return {
      response: 'No problem 👍 We can continue later. Just message *continue* whenever you\'re ready.',
      done: false
    };
  }

  if (ai?.intent === 'deferral' && ai.confidence >= 0.65) {
    onboardingSnoozeUntil.set(phoneNumber, Date.now() + ONBOARDING_SNOOZE_MS);
    return {
      response: 'No problem 👍 We can continue later. Just message *continue* whenever you\'re ready.',
      done: false
    };
  }

  // If user corrects the bot flow (e.g. "you didn't ask my name"),
  // jump to the requested field instead of forcing current step validation.
  const requestedState = detectRequestedField(answer);
  const aiRequestedState = ai?.field && ['name', 'designation', 'phone', 'email'].includes(ai.field)
    ? Object.keys(FIELD_BY_STATE).find(k => FIELD_BY_STATE[k] === ai.field)
    : null;

  if ((requestedState && isFeedbackOrCorrection(answer)) || (ai?.intent === 'correction' && aiRequestedState && ai.confidence >= 0.65)) {
    const targetState = aiRequestedState || requestedState;
    if (!targetState) {
      return { response: greetAndAsk(getQuestionForState(state, profile)), done: false };
    }
    states.set(phoneNumber, targetState);
    if (targetState === 'asking_name') {
      return {
        response: '🙏 Sorry for the confusion. Let\'s start correctly.\n\n' + QUESTIONS.asking_name,
        done: false
      };
    }
    if (targetState === 'asking_designation') {
      return {
        response: '🙏 Sorry for the confusion.\n\n' + QUESTIONS.asking_designation.replace('{name}', profile.name || 'there'),
        done: false
      };
    }
    if (targetState === 'asking_phone') {
      return {
        response: '🙏 Sorry for the confusion.\n\n' + QUESTIONS.asking_phone,
        done: false
      };
    }
    return {
      response: '🙏 Sorry for the confusion.\n\n' + QUESTIONS.asking_email,
      done: false
    };
  }

  switch (state) {

    case 'asking_name': {
      if (isGreeting(answer)) return { response: greetAndAsk(QUESTIONS.asking_name), done: false };
      if (ai?.intent === 'refusal' && ai.confidence >= 0.65) {
        return {
          response: '🙏 I understand. You can share just your *first name* (or nickname) and we\'ll continue.',
          done: false
        };
      }
      if (isRefusalOrComplaint(answer)) {
        return {
          response: '🙏 Sorry if this felt disturbing. You can share just your *first name* (or nickname), and we\'ll continue.',
          done: false
        };
      }
      if (!answer) return { response: 'Please enter your full name 🙏', done: false };
      const aiCandidate = ai?.intent === 'valid_answer' && ai?.field === 'name' && ai.confidence >= 0.7 ? (ai.value || answer) : answer;
      if (!validateByState('asking_name', aiCandidate)) {
        return {
          response: '⚠️ I couldn\'t recognize that as a name.\nPlease share your *name* only (e.g. *Muslim Raza*).',
          done: false
        };
      }
      profile.name = aiCandidate.trim();
      pendingProfiles.set(phoneNumber, profile);
      states.set(phoneNumber, 'asking_designation');
      return {
        response: QUESTIONS.asking_designation.replace('{name}', profile.name),
        done: false
      };
    }

    case 'asking_designation': {
      if (isGreeting(answer)) return { response: greetAndAsk(QUESTIONS.asking_designation.replace('{name}', profile.name || 'there')), done: false };
      if (!answer) return { response: 'Please enter your designation 🙏', done: false };
      const aiCandidate = ai?.intent === 'valid_answer' && ai?.field === 'designation' && ai.confidence >= 0.7 ? (ai.value || answer) : answer;
      if (!validateByState('asking_designation', aiCandidate)) {
        return {
          response: 'Please share only your *designation/job title* (e.g. Sales Manager).',
          done: false
        };
      }
      profile.designation = aiCandidate.trim();
      pendingProfiles.set(phoneNumber, profile);
      states.set(phoneNumber, 'asking_phone');
      return { response: QUESTIONS.asking_phone, done: false };
    }

    case 'asking_phone': {
      if (isGreeting(answer)) return { response: greetAndAsk(QUESTIONS.asking_phone), done: false };
      if (!answer) return { response: 'Please enter your phone number 🙏', done: false };
      const aiCandidate = ai?.intent === 'valid_answer' && ai?.field === 'phone' && ai.confidence >= 0.7 ? (ai.value || answer) : answer;
      if (!validateByState('asking_phone', aiCandidate)) {
        return {
          response: '⚠️ Please enter a valid phone number with country code (e.g. +92 300 1234567).',
          done: false
        };
      }
      profile.contactPhone = normalizePhone(aiCandidate);
      pendingProfiles.set(phoneNumber, profile);
      states.set(phoneNumber, 'asking_email');
      return { response: QUESTIONS.asking_email, done: false };
    }

    case 'asking_email': {
      if (isGreeting(answer)) return { response: greetAndAsk(QUESTIONS.asking_email), done: false };

      if (pendingConversationEmail.has(phoneNumber) && isSkipEmailMessage(answer)) {
        pendingConversationEmail.delete(phoneNumber);
        onboardingSnoozeUntil.set(phoneNumber, Date.now() + ONBOARDING_SNOOZE_MS);
        return {
          response: 'No problem 👍 I will not send the summary email.\nWhenever you are ready, type *continue* to complete your profile.',
          done: false
        };
      }

      // Handle conversational feedback at email step gracefully
      // instead of bluntly saying invalid email.
      if (!answer.includes('@') && (isFeedbackOrCorrection(answer) || detectRequestedField(answer))) {
        const fallbackState = detectRequestedField(answer) || 'asking_email';
        states.set(phoneNumber, fallbackState);
        if (fallbackState === 'asking_name') {
          return {
            response: '🙏 You\'re right. Let\'s confirm your details from the start.\n\n' + QUESTIONS.asking_name,
            done: false
          };
        }
        if (fallbackState === 'asking_designation') {
          return {
            response: 'No problem 👍\n\n' + QUESTIONS.asking_designation.replace('{name}', profile.name || 'there'),
            done: false
          };
        }
        if (fallbackState === 'asking_phone') {
          return {
            response: 'No problem 👍\n\n' + QUESTIONS.asking_phone,
            done: false
          };
        }
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const aiCandidate = ai?.intent === 'valid_answer' && ai?.field === 'email' && ai.confidence >= 0.7 ? (ai.value || answer) : answer;
      if (!emailRegex.test(aiCandidate)) {
        return {
          response:
            '⚠️ That doesn\'t look like a valid email address.\nPlease enter a valid email (e.g. john@example.com)',
          done: false
        };
      }
      profile.email = aiCandidate.trim();
      const cameFromGoodbyeFlow = pendingConversationEmail.has(phoneNumber);

      if (cameFromGoodbyeFlow) {
        pendingConversationEmail.delete(phoneNumber);
      }

      const hasAllCoreFields = Boolean(profile.name && profile.designation && profile.contactPhone);
      profile.onboardingComplete = hasAllCoreFields;
      pendingProfiles.set(phoneNumber, profile);

      if (cameFromGoodbyeFlow) {
        try {
          await emailService.sendConversationHistory(profile);
        } catch (_) {}
      }

      if (profile.onboardingComplete) {
        await persistCompletedProfile(phoneNumber, profile);
        lastNameUpdateAt.set(phoneNumber, Date.now());
        pendingProfiles.delete(phoneNumber);
        states.delete(phoneNumber);
        return {
          response:
            `✅ Thank you, *${profile.name}*! You're all set.\n\nHow can I help you today? 😊`,
          done: true
        };
      }

      if (!profile.name) states.set(phoneNumber, 'asking_name');
      else if (!profile.designation) states.set(phoneNumber, 'asking_designation');
      else if (!profile.contactPhone) states.set(phoneNumber, 'asking_phone');

      onboardingSnoozeUntil.set(phoneNumber, Date.now() + ONBOARDING_SNOOZE_MS);
      return {
        response:
          '✅ Thanks! I have sent your chat summary to your email.\nWhenever you are ready, type *continue* and I will complete the remaining profile details.',
        done: false
      };
    }

    default:
      states.delete(phoneNumber);
      return null;
  }
}

/** Fetch a user's profile (for email sending etc.) */
async function getProfile(phoneNumber) {
  const dbProfile = await findProfileByPhone(phoneNumber);
  if (dbProfile) return dbProfile;
  return pendingProfiles.get(phoneNumber) || null;
}

/**
 * Extract and persist email quickly from free-form message text.
 * This is used by meeting flow so client can receive meeting emails
 * even if full onboarding is not completed yet.
 */
async function captureEmailFromMessage(phoneNumber, messageText, fallbackName = '') {
  const text = String(messageText || '').trim();
  if (!text) return { updated: false, email: '' };

  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!match) return { updated: false, email: '' };

  const email = match[0].trim().toLowerCase();
  if (!isLikelyEmail(email)) return { updated: false, email: '' };

  const existing = await findProfileByPhone(phoneNumber);
  if (existing) {
    const alreadySame = String(existing.email || '').trim().toLowerCase() === email;
    if (!alreadySame || !existing.email) {
      existing.email = email;
      if (!existing.name && fallbackName) existing.name = String(fallbackName).trim();
      await existing.save();
      return { updated: true, email };
    }
    return { updated: false, email };
  }

  const draft = pendingProfiles.get(phoneNumber) || createEmptyDraft(phoneNumber);
  draft.email = email;
  if (!draft.name && fallbackName) draft.name = String(fallbackName).trim();
  pendingProfiles.set(phoneNumber, draft);

  await UserProfile.create({
    phoneNumber,
    name: draft.name || null,
    designation: draft.designation || null,
    contactPhone: draft.contactPhone || null,
    email,
    onboardingComplete: false
  });

  return { updated: true, email };
}

module.exports = { processOnboarding, getProfile, captureEmailFromMessage };
