const Message = require('../models/Message');
const Task = require('../models/Task');
const { Op } = require('sequelize');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const BOT_BEHAVIOR_DEFAULTS = {
  enableAutoReply: true,
  welcomeMessage: 'Greetings from PTIS Chatbot! 👋 How can we help you today?',
  awayMessage: 'We\'re currently offline. Our team will respond during business hours (9 AM - 6 PM).',
  responseDelaySeconds: 2
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
  headOfficeAddress: '',
  regionalOffices: []
};

class ChatbotService {
  constructor() {
    // Initialize Groq (falls back to keyword-based if no API key)
    this.currentModel = 'llama-3.3-70b-versatile'; // best free Groq model
    this.groq = process.env.GROQ_API_KEY
      ? new Groq({ apiKey: process.env.GROQ_API_KEY })
      : null;

    this.useAI = !!process.env.GROQ_API_KEY;

    // Rate limiting
    this.lastAICall = 0;
    this.minInterval = 2000; // 2 seconds between calls
    this.rateLimitedUntil = 0; // timestamp when rate limit lifts
    
    // Business hours (24-hour format)
    this.businessHours = {
      start: 9,  // 9 AM
      end: 18    // 6 PM
    };
    
    // System prompt for AI
    this.systemPrompt = this.loadSystemPrompt();
    
    // Response templates
    this.responses = {
      greeting: [
        "Hello! 👋 Greetings from our service. How can I assist you today?",
        "Hi there! 😊 Thank you for reaching out. How may I help you?",
        "Good day! I'm here to help. What can I do for you today?"
      ],
      
      casualGreeting: [
        "I'm doing great, thank you for asking! 😊 How can I help you today?",
        "Doing well, thanks! Hope you're doing great too. What can I assist you with?",
        "All good here! 👍 How about you? What brings you here today?"
      ],
      
      businessHours: "Thank you for contacting us! Our business hours are 9 AM to 6 PM. Your message has been received and our team will respond shortly.",
      
      afterHours: "Thank you for your message! We've received it outside our business hours (9 AM - 6 PM). We'll get back to you as soon as possible during our next business day.",
      
      thankYou: [
        "You're welcome! 😊 Is there anything else I can help you with?",
        "Happy to help! Feel free to reach out if you need anything else.",
        "Glad I could assist! Don't hesitate to contact us again."
      ],
      
      goodbye: [
        "Thank you for contacting us! Have a great day! 👋",
        "Goodbye! Feel free to reach out anytime you need assistance. 😊",
        "Take care! We're here whenever you need us. 🌟"
      ],

      acknowledgement: [
        "Noted. If you need anything later, just let us know.",
        "Got it. We're here if you need help later.",
        "Understood. Reach out anytime if you need assistance."
      ],

      noHelp: [
        "Alright. If you need anything later, message us anytime.",
        "Understood. We are here whenever you need assistance.",
        "No problem. Feel free to reach out anytime."
      ],
      
      pricing: "Thank you for your interest in our pricing! Our team will get back to you shortly with detailed information tailored to your needs. Could you please share more details about what you're looking for?",
      
      support: "I understand you need support. Let me connect you with our team. Could you please describe your issue in detail so we can assist you better?",
      
      inquiry: "Thank you for your inquiry! I've noted your request and our team will respond shortly. Is there any specific information you'd like me to pass along?",
      
      urgent: "I see this is urgent. I've marked your message as high priority and notified our team immediately. They will reach out to you as soon as possible.",
      
      complaint: "I sincerely apologize for any inconvenience you've experienced. Your feedback is important to us. I've escalated your concern to our management team who will address it promptly.",
      
      default: "Thank you for your message! I've received it and will make sure the right person gets back to you soon. In the meantime, is there anything specific I can help clarify?"
    };
    
    // Keywords for intent detection
    this.intents = {
      noHelp: ['nothing', 'no more', 'no need', 'no thanks', 'no thank you', 'that is all', 'that\'s all', 'all good', 'no issues', 'done', 'bas', 'kuch nahi', 'ab kuch nahi', 'just focus', 'nothing else', 'nothing more'],
      acknowledgement: ['ok', 'okay', 'alright', 'sure', 'fine', 'good', 'great', 'noted', 'understood', 'cool', 'got it', 'theek', 'thik', 'sahi', 'ji'],
      greeting: ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening', 'greetings'],
      casualGreeting: ['how are you', 'how r u', 'whatsup', 'what\'s up', 'sup', 'how do you do', 'how are things', 'wassup', 'how is it going'],
      thankYou: ['thank you', 'thanks', 'appreciate', 'grateful'],
      goodbye: ['bye', 'goodbye', 'see you', 'take care', 'later'],
      pricing: ['price', 'cost', 'pricing', 'quote', 'how much', 'rate', 'payment', 'fee'],
      support: ['help', 'support', 'issue', 'problem', 'not working', 'error', 'trouble'],
      urgent: ['urgent', 'asap', 'emergency', 'immediately', 'critical', 'important'],
      complaint: ['complaint', 'unhappy', 'disappointed', 'frustrated', 'angry', 'terrible', 'worst'],
      inquiry: ['information', 'details', 'tell me about', 'want to know', 'inquiry', 'question']
    };

    this.intentPriority = [
      'noHelp',
      'goodbye',
      'thankYou',
      'greeting',
      'casualGreeting',
      'acknowledgement',
      'pricing',
      'support',
      'urgent',
      'complaint',
      'inquiry'
    ];

    this.pendingOfficeLookup = new Map();
    this.officeLookupTtlMs = 15 * 60 * 1000;
    this.lastReplyByPhone = new Map();
    this.repeatReplyWindowMs = 90 * 1000;

    // Rolling per-phone transcript (user + assistant turns) so the AI can see
    // its own previous replies and stop repeating itself mid-conversation.
    this.conversationTurns = new Map();
    this.maxConversationTurns = 8;
  }

  /**
   * Get the remembered conversation turns (user + assistant) for a phone.
   */
  getConversationTurns(from) {
    if (!from) return [];
    return this.conversationTurns.get(from) || [];
  }

  /**
   * Append a turn to the rolling transcript, keeping only the most recent ones.
   */
  recordConversationTurn(from, role, content) {
    const text = String(content || '').trim();
    if (!from || !text) return;
    const turns = this.conversationTurns.get(from) || [];
    turns.push({ role, content: text });
    while (turns.length > this.maxConversationTurns) turns.shift();
    this.conversationTurns.set(from, turns);
  }

  /**
   * Detect message intent based on keywords
   */
  detectIntent(message) {
    const lowerMessage = String(message || '').toLowerCase().trim();
    if (!lowerMessage) return 'default';

    for (const intent of this.intentPriority) {
      const keywords = this.intents[intent] || [];
      if (!keywords.length) continue;

      if (intent === 'acknowledgement' && !this.isShortMessage(lowerMessage, 6)) {
        continue;
      }
      if (intent === 'noHelp' && !this.isShortMessage(lowerMessage, 12)) {
        continue;
      }

      if (this.matchesKeywords(lowerMessage, keywords)) {
        return intent;
      }
    }

    return 'default';
  }

  matchesKeywords(message, keywords = []) {
    // Word-boundary match, not plain substring — otherwise short keywords like
    // "hi" or "ok" false-positive inside unrelated words ("hire", "book"),
    // e.g. "Can you hire me?" was being misread as a greeting.
    return keywords.some(keyword => {
      const escaped = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(message);
    });
  }

  isShortMessage(message, maxWords = 8) {
    const text = String(message || '').replace(/[\r\n]+/g, ' ').trim();
    const words = text.split(/\s+/).filter(Boolean);
    return words.length <= maxWords;
  }

  /**
   * Get random response from array
   */
  getRandomResponse(responses) {
    if (Array.isArray(responses)) {
      return responses[Math.floor(Math.random() * responses.length)];
    }
    return responses;
  }

  /**
   * Read bot behavior settings from file
   */
  loadBotBehaviorSettings() {
    try {
      const p = path.join(__dirname, '../../.bot-behavior.json');
      if (!fs.existsSync(p)) return { ...BOT_BEHAVIOR_DEFAULTS };
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...BOT_BEHAVIOR_DEFAULTS, ...(saved || {}) };
    } catch (_) {
      return { ...BOT_BEHAVIOR_DEFAULTS };
    }
  }

  /**
   * Read business hours settings from file
   */
  loadBusinessHoursSettings() {
    try {
      const p = path.join(__dirname, '../../.business-hours.json');
      if (!fs.existsSync(p)) return { ...BUSINESS_HOURS_DEFAULTS };
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...BUSINESS_HOURS_DEFAULTS, ...(saved || {}) };
    } catch (_) {
      return { ...BUSINESS_HOURS_DEFAULTS };
    }
  }

  loadGeneralSettings() {
    try {
      const p = path.join(__dirname, '../../.general-settings.json');
      if (!fs.existsSync(p)) return { ...GENERAL_SETTINGS_DEFAULTS };
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...GENERAL_SETTINGS_DEFAULTS, ...(saved || {}) };
    } catch (_) {
      return { ...GENERAL_SETTINGS_DEFAULTS };
    }
  }

  loadWebsiteSyncSettings() {
    try {
      const p = path.join(__dirname, '../../.website-sync.json');
      if (!fs.existsSync(p)) return { enabled: false };
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { enabled: !!saved?.enabled, url: saved?.url || '' };
    } catch (_) {
      return { enabled: false };
    }
  }

  normalizePhoneDigits(value = '') {
    return String(value || '').replace(/\D/g, '');
  }

  normalizeDialCodes(value) {
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

  normalizeRegionalOffices(entries = []) {
    const list = Array.isArray(entries) ? entries : [];
    return list
      .map(entry => {
        const country = typeof entry?.country === 'string' ? entry.country.trim() : '';
        const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
        const phone = typeof entry?.phone === 'string' ? entry.phone.trim() : '';
        const city = typeof entry?.city === 'string' ? entry.city.trim() : '';
        const email = typeof entry?.email === 'string' ? entry.email.trim() : '';
        const address = typeof entry?.address === 'string' ? entry.address.trim() : '';
        const dialCodes = this.normalizeDialCodes(entry?.dialCodes ?? entry?.dialCode ?? entry?.countryCodes ?? entry?.countryCode);

        if (!country && !label && !phone && !city && !email && !address && dialCodes.length === 0) {
          return null;
        }

        return { country, label, phone, city, email, address, dialCodes };
      })
      .filter(Boolean);
  }

  getPendingOfficeLookup(from) {
    if (!from) return false;
    const record = this.pendingOfficeLookup.get(from);
    if (!record) return false;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      this.pendingOfficeLookup.delete(from);
      return false;
    }
    return true;
  }

  setPendingOfficeLookup(from) {
    if (!from) return;
    this.pendingOfficeLookup.set(from, { expiresAt: Date.now() + this.officeLookupTtlMs });
  }

  clearPendingOfficeLookup(from) {
    if (!from) return;
    this.pendingOfficeLookup.delete(from);
  }

  shouldSuppressRepeatReply(from, response, { allowRepeat = false } = {}) {
    if (allowRepeat) return false;
    const trimmed = String(response || '').trim();
    if (!from || !trimmed) return false;

    const last = this.lastReplyByPhone.get(from);
    const now = Date.now();
    if (last && last.response === trimmed && now - last.at < this.repeatReplyWindowMs) {
      return true;
    }

    this.lastReplyByPhone.set(from, { response: trimmed, at: now });
    return false;
  }

  isContactInfoRequest(messageBody = '') {
    const text = String(messageBody || '').toLowerCase();
    if (!text) return false;
    const selfMentions = ['my phone', 'my number', 'my contact', 'my email', 'mera number', 'mera phone', 'meri email'];
    if (selfMentions.some(k => text.includes(k))) return false;
    const keywords = [
      'address', 'location', 'office', 'branch', 'contact', 'phone', 'number', 'email',
      'head office', 'office address', 'office number', 'contact number', 'contact no',
      'kahan', 'kidhar', 'kaha', 'pata'
    ];
    return keywords.some(k => text.includes(k));
  }

  matchesCountryText(text, country) {
    const t = String(text || '').toLowerCase();
    const c = String(country || '').toLowerCase().trim();
    if (!t || !c) return false;
    if (c.length <= 3) {
      const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      return re.test(t);
    }
    return t.includes(c);
  }

  findRegionalOfficeForMessage(messageBody, from, offices) {
    const text = String(messageBody || '').toLowerCase();
    const list = Array.isArray(offices) ? offices : [];

    for (const office of list) {
      if (office.country && this.matchesCountryText(text, office.country)) {
        return office;
      }
      if (office.city && this.matchesCountryText(text, office.city)) {
        return office;
      }
    }

    const digits = this.normalizePhoneDigits(from);
    if (!digits) return null;

    let best = null;
    let bestLen = 0;
    for (const office of list) {
      const codes = Array.isArray(office.dialCodes) ? office.dialCodes : [];
      for (const code of codes) {
        if (!code) continue;
        if (digits.startsWith(code) && code.length > bestLen) {
          best = office;
          bestLen = code.length;
        }
      }
    }

    return best;
  }

  buildContactInfoReply(messageBody, lookupPhone) {
    const isKeywordRequest = this.isContactInfoRequest(messageBody);
    const hasPending = this.getPendingOfficeLookup(lookupPhone);

    if (!isKeywordRequest && !hasPending) return null;
    if (hasPending && !isKeywordRequest && !this.isShortMessage(messageBody, 4)) {
      // User changed topic; stop waiting for location.
      this.clearPendingOfficeLookup(lookupPhone);
      return null;
    }

    const general = this.loadGeneralSettings();
    const offices = this.normalizeRegionalOffices(general.regionalOffices);
    const match = this.findRegionalOfficeForMessage(messageBody, lookupPhone, offices);

    const fallbackPhone = String(general.phone || '').trim();
    const fallbackEmail = String(general.email || '').trim();
    const fallbackAddress = String(general.headOfficeAddress || '').trim();

    const lines = [];
    const pushIf = (label, value) => {
      if (value) lines.push(`${label}: ${value}`);
    };

    if (match) {
      this.clearPendingOfficeLookup(lookupPhone);
      const label = match.label || match.country || 'Local Office';
      lines.push(`Here are the ${label} contact details:`);
      pushIf('Phone', match.phone);
      pushIf('City', match.city);
      pushIf('Email', match.email);
      pushIf('Address', match.address);

      if (!match.phone) pushIf('Phone', fallbackPhone);
      if (!match.email) pushIf('Email', fallbackEmail);
      if (!match.address) pushIf('Address', fallbackAddress);

      return { response: lines.join('\n'), allowRepeat: isKeywordRequest };
    }

    if (hasPending && !isKeywordRequest) {
      // Waiting for country/city but user sent something else; do not repeat.
      return null;
    }

    if (offices.length > 0) {
      this.setPendingOfficeLookup(lookupPhone);
      lines.push('Please share your country or city so I can send the nearest office address and number.');
      if (fallbackPhone || fallbackEmail || fallbackAddress) {
        lines.push('Main office details (if needed):');
        pushIf('Phone', fallbackPhone);
        pushIf('Email', fallbackEmail);
        pushIf('Address', fallbackAddress);
      }
      return { response: lines.join('\n'), allowRepeat: isKeywordRequest };
    }

    this.clearPendingOfficeLookup(lookupPhone);
    if (fallbackPhone || fallbackEmail || fallbackAddress) {
      lines.push('Here are our main contact details:');
      pushIf('Phone', fallbackPhone);
      pushIf('Email', fallbackEmail);
      pushIf('Address', fallbackAddress);
      return { response: lines.join('\n'), allowRepeat: isKeywordRequest };
    }

    return null;
  }

  toMinutes(timeStr, fallbackMinutes) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return fallbackMinutes;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
      return fallbackMinutes;
    }
    return h * 60 + min;
  }

  /**
   * Check if now is within configured business hours
   */
  isBusinessHoursNow() {
    const hours = this.loadBusinessHoursSettings();
    const now = new Date();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayKey = dayNames[now.getDay()];
    const cfg = hours[dayKey] || BUSINESS_HOURS_DEFAULTS[dayKey];
    if (!cfg || !cfg.enabled) return false;

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = this.toMinutes(cfg.start, 9 * 60);
    const endMinutes = this.toMinutes(cfg.end, 18 * 60);

    if (endMinutes <= startMinutes) {
      // overnight range (e.g. 22:00 to 05:00)
      return nowMinutes >= startMinutes || nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  /**
   * Generate AI-powered response using Groq (Llama)
   * Includes rate limiting and 429 retry handling
   */
  async generateAIResponse(messageBody, from, fromName, conversationHistory = []) {
    // Lazy reinit if key wasn't available at startup
    if (!this.useAI || !this.groq) {
      this.tryReinit();
    }

    if (!this.useAI || !this.groq) return null;

    const now = Date.now();

    // If we're rate-limited, skip AI
    if (now < this.rateLimitedUntil) {
      const waitSec = Math.ceil((this.rateLimitedUntil - now) / 1000);
      console.log(`⏳ Groq rate-limited, fallback (${waitSec}s remaining)`);
      return null;
    }

    // Enforce minimum interval
    const timeSinceLast = now - this.lastAICall;
    if (timeSinceLast < this.minInterval) {
      await new Promise(r => setTimeout(r, this.minInterval - timeSinceLast));
    }

    try {
      this.lastAICall = Date.now();

      // Always reload business profile from file so dashboard updates take effect immediately
      this.systemPrompt = this.loadSystemPrompt();

      // Build messages array with conversation history.
      // Use the in-memory transcript so the AI can see its OWN previous replies
      // (role: 'assistant') and stop repeating itself. On a cold start the
      // transcript is empty, so seed it from the DB history (user turns only).
      let priorTurns = this.getConversationTurns(from);
      if (priorTurns.length === 0 && conversationHistory.length > 0) {
        conversationHistory.slice().reverse().forEach(m => {
          this.recordConversationTurn(from, 'user', m.body);
        });
        priorTurns = this.getConversationTurns(from);
      }

      const messages = [{ role: 'system', content: this.systemPrompt }];
      priorTurns.forEach(t => messages.push({ role: t.role, content: t.content }));

      // Only introduce the name on the very first message — don't repeat it in ongoing chats
      const isFirstMessage = priorTurns.length === 0;
      messages.push({
        role: 'user',
        content: isFirstMessage ? `Customer name: ${fromName}\n\n${messageBody}` : messageBody
      });

      // Record the incoming customer message before generating the reply.
      this.recordConversationTurn(from, 'user', messageBody);

      const completion = await this.groq.chat.completions.create({
        model: this.currentModel,
        messages,
        max_tokens: 300,
        temperature: 0.7
      });

      const aiResponse = completion.choices[0].message.content.trim();

      // Remember our own reply so the next turn has full context.
      this.recordConversationTurn(from, 'assistant', aiResponse);
      console.log(`🤖 Groq (${this.currentModel}) replied: ${aiResponse.substring(0, 80)}...`);

      const intent = this.detectIntent(messageBody);
      const needsFollowUp = this.needsFollowUp(messageBody, aiResponse);

      return {
        response: aiResponse,
        intent,
        shouldCreateTask: needsFollowUp,
        priority: this.determinePriority(messageBody)
      };
    } catch (error) {
      const msg = error.message || '';
      if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate_limit')) {
        const retryMatch = msg.match(/retry.*?(\d+)s/i);
        const waitSeconds = retryMatch ? parseInt(retryMatch[1]) + 5 : 30;
        this.rateLimitedUntil = Date.now() + (waitSeconds * 1000);
        console.log(`⚠️  Groq rate limit hit — pausing AI for ${waitSeconds}s`);
      } else {
        console.error('Groq API error:', msg.substring(0, 120));
      }
      return null;
    }
  }

  /**
   * Lazy reinit — picks up GROQ_API_KEY from .env if it wasn't set at startup
   */
  tryReinit() {
    try {
      const fs = require('fs');
      const path = require('path');
      const envPath = path.join(__dirname, '../../.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const match = envContent.match(/GROQ_API_KEY=(.+)/);
        if (match && match[1].trim() && !match[1].trim().startsWith('#')) {
          const apiKey = match[1].trim();
          process.env.GROQ_API_KEY = apiKey;
          this.groq = new Groq({ apiKey });
          this.useAI = true;
          this.systemPrompt = this.loadSystemPrompt();
          console.log(`✅ Groq API key loaded from .env — AI enabled! (${this.currentModel})`);
        }
      }
    } catch (e) {
      console.error('tryReinit error:', e.message);
    }
  }

  /**
   * Load system prompt from business profile file (if exists), else use default
   */
  loadSystemPrompt() {
    try {
      const fs = require('fs');
      const path = require('path');
      const profilePath = path.join(__dirname, '../../.business-profile.json');
      const aiSettingsPath = path.join(__dirname, '../../.ai-settings.json');

      let tone = 'professional';
      if (fs.existsSync(aiSettingsPath)) {
        const aiSettings = JSON.parse(fs.readFileSync(aiSettingsPath, 'utf8'));
        if (aiSettings.tone) tone = aiSettings.tone;
      }

      if (fs.existsSync(profilePath)) {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        return this.buildSystemPrompt(profile, tone);
      }
      return this.defaultPrompt(tone);
    } catch (e) {}
    return this.defaultPrompt();
  }

  /**
   * Build a detailed system prompt from business profile
   */
  buildSystemPrompt(profile = {}, tone = 'professional') {
    const name = profile.businessName || 'our business';
    const type = profile.businessType || 'service provider';
    const lang = profile.language || 'English';
    const websiteSettings = this.loadWebsiteSyncSettings();
    const websiteContentRaw = String(profile.websiteContent || '').trim();
    const hasWebsiteContent = !!websiteContentRaw;
    const useWebsiteOnly = !!websiteSettings.enabled;

    const toneInstructions = {
      professional: 'Maintain a professional, polished, and business-appropriate tone at all times.',
      friendly:     'Be warm, approachable, and friendly — like talking to a helpful friend.',
      casual:       'Keep it casual and relaxed. Use simple everyday language, feel free to use light emojis.',
      formal:       'Use formal, structured language. Avoid contractions and slang. Be precise and respectful.'
    };
    const toneGuide = toneInstructions[tone] || toneInstructions.professional;

    let prompt = `You are an AI customer service representative for "${name}" (${type}).\n`;
    prompt += `Tone: ${toneGuide}\n`;
    prompt += `Always reply in ${lang}.\n`;
    prompt += `If the customer writes in another language, still respond only in ${lang}.\n\n`;

    if (!useWebsiteOnly && profile.services && profile.services.trim()) {
      prompt += `=== SERVICES WE OFFER ===\n${profile.services.trim()}\n\n`;
      prompt += `When a customer asks about services, list them clearly and invite them to ask more.\n\n`;
    }

    if (!useWebsiteOnly && profile.team && profile.team.trim()) {
      prompt += `=== OUR TEAM ===\n${profile.team.trim()}\n\n`;
    }

    if (!useWebsiteOnly && profile.meetingSlots && profile.meetingSlots.trim()) {
      prompt += `=== MEETING SCHEDULING ===\n`;
      prompt += `Available slots:\n${profile.meetingSlots.trim()}\n`;
      prompt += `When a customer wants to schedule a meeting:\n`;
      prompt += `1. Suggest a specific time slot from the available slots above\n`;
      prompt += `2. Say "This is a tentative slot — we will confirm it with you shortly via WhatsApp"\n`;
      prompt += `3. Ask for their preferred date if they don't mention one\n\n`;
    }

    if (!useWebsiteOnly && profile.contactInfo && profile.contactInfo.trim()) {
      prompt += `=== CONTACT INFORMATION ===\n${profile.contactInfo.trim()}\n\n`;
    }

    if (!useWebsiteOnly && profile.extraInfo && profile.extraInfo.trim()) {
      prompt += `=== ADDITIONAL INFORMATION ===\n${profile.extraInfo.trim()}\n\n`;
    }

    if (hasWebsiteContent) {
      const sourceUrl = profile.websiteSourceUrl ? `Source: ${profile.websiteSourceUrl}\n` : '';
      const clipped = websiteContentRaw.length > 8000 ? websiteContentRaw.slice(0, 8000) : websiteContentRaw;
      prompt += `=== WEBSITE KNOWLEDGE (AUTO-SYNCED) ===\n`;
      prompt += `${sourceUrl}${clipped}\n\n`;
      prompt += `Use the website knowledge when a customer asks about site content, services, policies, or contact details.\n`;
      prompt += `If a detail is unclear, say our team will confirm it shortly.\n\n`;
    }

    prompt += `=== CONVERSATION RULES ===\n`;
    prompt += `- MOST IMPORTANT: Follow the conversation naturally. If someone says "hi", "hello", "hey", or any greeting — just greet them back warmly using their name and ask how you can help. Do NOT dump all services or business info unprompted.\n`;
    prompt += `- The customer's name is provided at the start of the FIRST message only — use it once in your opening greeting (e.g. "Hi [name]!"). Do NOT repeat the name in every reply after that — just talk naturally.\n`;
    prompt += `- Never change the customer's name based on chat content. If they mention another name, treat it as a third person.\n`;
    prompt += `- Only share services, pricing, team info, or meeting slots when the customer ASKS for them.\n`;
    prompt += `- Keep replies concise (2-4 sentences max unless a detailed answer is needed)\n`;
    prompt += `- Never say you don't know — always refer to the information above\n`;
    prompt += `- If customer asks something not in your info, say "Our team will get back to you shortly with more details"\n`;
    prompt += `- For complaints: be empathetic, apologize, and assure resolution\n`;
    prompt += `- If the customer says they need nothing else or are done, acknowledge politely and do NOT ask "How can I help you today?"\n`;
    prompt += `- Always end with a short, natural invitation to ask more (e.g. "How can I help you today?")`;

    return prompt;
  }

  /**
   * Default prompt when no business profile is configured
   */
  defaultPrompt(tone = 'professional') {
    const toneInstructions = {
      professional: 'Maintain a professional, polished, and business-appropriate tone at all times.',
      friendly:     'Be warm, approachable, and friendly — like talking to a helpful friend.',
      casual:       'Keep it casual and relaxed. Use simple everyday language, feel free to use light emojis.',
      formal:       'Use formal, structured language. Avoid contractions and slang. Be precise and respectful.'
    };
    const toneGuide = toneInstructions[tone] || toneInstructions.professional;

    return `You are a professional customer service AI assistant.
Tone: ${toneGuide}

CRITICAL RULE: Be conversational and natural. If someone sends a greeting like "hi", "hello", "hey", "salam", "assalam o alaikum" — greet them back by name and ask how you can help. Never dump information unprompted.

The customer's name is provided at the start of the FIRST message only — use it once in your opening greeting (e.g. "Hi [name]! How can I help you today?"). After that, talk naturally without repeating the name in every message.

Never change the customer's name based on chat content. If they mention another name, treat it as a third person.

Only share specific details (services, pricing, hours, etc.) when the customer actually ASKS for them.

Guidelines:
- Keep responses short and natural (2-3 sentences unless a detailed answer is needed)
- Be warm, polite, and professional
- For meeting requests: suggest a time and say it will be confirmed shortly
- For complaints: be empathetic and assure resolution
- If the customer says they need nothing else or are done, acknowledge politely and do NOT ask "How can I help you today?"
- If you don't have specific info, say "Our team will get back to you with more details"`;
  }

  /**
   * Determine if message needs follow-up task
   */
  needsFollowUp(message, aiResponse) {
    const followUpKeywords = ['pricing', 'quote', 'help', 'support', 'issue', 'problem', 'urgent', 'complaint'];
    const messageLower = message.toLowerCase();
    if (this.matchesKeywords(messageLower, this.intents.noHelp || [])) return false;
    return followUpKeywords.some(keyword => messageLower.includes(keyword));
  }

  isMeaningfulTaskDescription(message = '') {
    const text = String(message || '').trim().toLowerCase();
    if (!text) return false;

    const genericOnly = new Set([
      'hi', 'hello', 'hey', 'ok', 'okay', 'thanks', 'thank you', 'aoa', 'assalamualaikum',
      'good morning', 'good afternoon', 'good evening', 'bye'
    ]);
    if (genericOnly.has(text)) return false;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length < 3) return false;
    if (text.length < 12) return false;

    return true;
  }

  shouldAutoCreateTask(intent, messageBody) {
    if (!this.isMeaningfulTaskDescription(messageBody)) return false;
    if (intent === 'noHelp') return false;
    return ['pricing', 'support', 'urgent', 'complaint', 'inquiry'].includes(intent);
  }

  /**
   * Determine task priority based on message content
   */
  determinePriority(message) {
    const messageLower = message.toLowerCase();
    if (messageLower.includes('urgent') || messageLower.includes('asap') || messageLower.includes('emergency')) {
      return 'high';
    }
    if (messageLower.includes('important') || messageLower.includes('complaint')) {
      return 'high';
    }
    return 'medium';
  }

  /**
   * Generate professional response based on message content
   */
  async generateResponse(messageBody, from, fromName, context = {}) {
    try {
      const behavior = this.loadBotBehaviorSettings();
      const responseDelaySeconds = Math.min(60, Math.max(0, parseInt(behavior.responseDelaySeconds, 10) || 0));
      const lookupPhone = context.lookupPhone || from;

      if (!behavior.enableAutoReply) {
        return {
          response: '',
          intent: 'auto-reply-disabled',
          shouldReply: false,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      const contactReply = this.buildContactInfoReply(messageBody, lookupPhone);
      if (contactReply) {
        if (this.shouldSuppressRepeatReply(from, contactReply.response, { allowRepeat: contactReply.allowRepeat })) {
          return {
            response: '',
            intent: 'contact-info-repeat-suppressed',
            shouldReply: false,
            taskCreated: false,
            responseDelaySeconds
          };
        }
        return {
          response: contactReply.response,
          intent: 'contact-info',
          shouldReply: true,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      const quickIntent = this.detectIntent(messageBody);
      if (quickIntent === 'noHelp' || quickIntent === 'acknowledgement') {
        const quickResponse = this.getRandomResponse(this.responses[quickIntent]);
        if (this.shouldSuppressRepeatReply(from, quickResponse)) {
          return {
            response: '',
            intent: 'repeat-suppressed',
            shouldReply: false,
            taskCreated: false,
            responseDelaySeconds
          };
        }
        return {
          response: quickResponse,
          intent: quickIntent,
          shouldReply: true,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      const history = await this.getConversationHistory(from, 3);
      const isFirstMessage = history.length === 0;
      const inBusinessHours = this.isBusinessHoursNow();

      if (!inBusinessHours) {
        return {
          response: behavior.awayMessage || this.responses.afterHours,
          intent: 'after-hours',
          shouldReply: true,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      if (isFirstMessage && behavior.welcomeMessage) {
        return {
          response: behavior.welcomeMessage,
          intent: 'welcome',
          shouldReply: true,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      const isGreetingIntent =
        (quickIntent === 'greeting' || quickIntent === 'casualGreeting') &&
        this.isShortMessage(messageBody, 6);

      if (isGreetingIntent) {
        const quickResponse = this.getRandomResponse(this.responses[quickIntent]);
        if (this.shouldSuppressRepeatReply(from, quickResponse)) {
          return {
            response: '',
            intent: 'repeat-suppressed',
            shouldReply: false,
            taskCreated: false,
            responseDelaySeconds
          };
        }
        return {
          response: quickResponse,
          intent: quickIntent,
          shouldReply: true,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      // Always check if AI key became available after startup
      if (!this.useAI || !this.groq) {
        this.tryReinit();
      }

      // Try AI-powered response first
      if (this.useAI) {
        const aiResult = await this.generateAIResponse(messageBody, from, fromName, history);
        
        if (aiResult) {
          if (this.shouldSuppressRepeatReply(from, aiResult.response)) {
            return {
              response: '',
              intent: 'repeat-suppressed',
              shouldReply: false,
              taskCreated: false,
              responseDelaySeconds
            };
          }
          // Create task if needed
          let taskCreated = false;
          if (aiResult.shouldCreateTask && this.isMeaningfulTaskDescription(messageBody)) {
            const task = await this.createAutoTask(
              `Customer inquiry from ${fromName}`,
              from,
              fromName,
              aiResult.priority,
              messageBody
            );
            taskCreated = !!task;
          }
          
          return {
            response: aiResult.response,
            intent: aiResult.intent,
            shouldReply: true,
            taskCreated,
            aiPowered: true,
            responseDelaySeconds
          };
        }
        // AI returned null — logging and falling back to keyword-based
        console.log('⚠️  Gemini returned null — using keyword fallback for:', messageBody.substring(0, 60));
      }
      
      // Fallback to keyword-based responses
      const intent = this.detectIntent(messageBody);
      let response = '';
      let taskCreated = false;

      // Handle different intents
      switch (intent) {
        case 'greeting':
          response = this.getRandomResponse(this.responses.greeting);
          break;
          
        case 'casualGreeting':
          response = this.getRandomResponse(this.responses.casualGreeting);
          break;
          
        case 'thankYou':
          response = this.getRandomResponse(this.responses.thankYou);
          break;
          
        case 'goodbye':
          response = this.getRandomResponse(this.responses.goodbye);
          break;

        case 'acknowledgement':
          response = this.getRandomResponse(this.responses.acknowledgement);
          break;

        case 'noHelp':
          response = this.getRandomResponse(this.responses.noHelp);
          break;
          
        case 'pricing':
          response = this.responses.pricing;
          if (this.shouldAutoCreateTask(intent, messageBody)) {
            taskCreated = !!(await this.createAutoTask('Pricing Inquiry', from, fromName, 'high', messageBody));
          }
          break;
          
        case 'support':
          response = this.responses.support;
          if (this.shouldAutoCreateTask(intent, messageBody)) {
            taskCreated = !!(await this.createAutoTask('Support Request', from, fromName, 'medium', messageBody));
          }
          break;
          
        case 'urgent':
          response = this.responses.urgent;
          if (this.shouldAutoCreateTask(intent, messageBody)) {
            taskCreated = !!(await this.createAutoTask('Urgent Request', from, fromName, 'high', messageBody));
          }
          break;
          
        case 'complaint':
          response = this.responses.complaint;
          if (this.shouldAutoCreateTask(intent, messageBody)) {
            taskCreated = !!(await this.createAutoTask('Customer Complaint', from, fromName, 'high', messageBody));
          }
          break;
          
        case 'inquiry':
          response = this.responses.inquiry;
          if (this.shouldAutoCreateTask(intent, messageBody)) {
            taskCreated = !!(await this.createAutoTask('General Inquiry', from, fromName, 'medium', messageBody));
          }
          break;
          
        default:
          response = this.responses.default;
          break;
      }

      if (this.shouldSuppressRepeatReply(from, response)) {
        return {
          response: '',
          intent: 'repeat-suppressed',
          shouldReply: false,
          taskCreated: false,
          responseDelaySeconds
        };
      }

      return {
        response,
        intent,
        shouldReply: true,
        taskCreated,
        responseDelaySeconds
      };
      
    } catch (error) {
      console.error('Error generating response:', error);
      return {
        response: this.responses.default,
        intent: 'error',
        shouldReply: true,
        taskCreated: false,
        responseDelaySeconds: 0
      };
    }
  }

  /**
   * Create automated task based on message
   */
  async createAutoTask(label, from, fromName, priority = 'medium', messageBody = '') {
    try {
      const description = messageBody ? messageBody.substring(0, 200).trim() : '';
      if (!this.isMeaningfulTaskDescription(description)) {
        return null;
      }

      const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';
      const task = await Task.create({
        description,
        from,
        fromName,
        status: 'pending',
        priority: validPriority,
        type: 'request',
        notes: `[${label}] Auto-generated from chatbot`
      });
      
      console.log(`✅ Auto-task created: ${description.substring(0, 60)} (Priority: ${validPriority})`);
      return task;
    } catch (error) {
      console.error('Error creating auto-task:', error);
      return null;
    }
  }

  /**
   * Get conversation history for context
   */
  async getConversationHistory(from, limit = 5) {
    try {
      const messages = await Message.findAll({
        where: { from },
        order: [['timestamp', 'DESC']],
        limit,
        offset: 1  // skip the most recently saved message (current one)
      });
      
      return messages.map(msg => ({
        body: msg.body,
        timestamp: msg.timestamp,
        sentiment: msg.sentimentLabel
      }));
    } catch (error) {
      console.error('Error fetching conversation history:', error);
      return [];
    }
  }

  /**
   * Check if user has pending tasks
   */
  async hasPendingTasks(from) {
    try {
      const count = await Task.count({
        where: {
          from,
          status: { [Op.in]: ['pending', 'in-progress'] }
        }
      });
      
      return count > 0;
    } catch (error) {
      console.error('Error checking pending tasks:', error);
      return false;
    }
  }
}

module.exports = new ChatbotService();
