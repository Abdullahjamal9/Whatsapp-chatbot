require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectDB } = require('./config/database');
const messageService = require('./services/messageService');
const chatbotService = require('./services/chatbotService');
const { processCommand } = require('./utils/commands');
const WhatsAppState = require('./utils/whatsappState');
const onboardingService = require('./services/onboardingService');
const emailService      = require('./services/emailService');
const meetingService    = require('./services/meetingService');
const lidPhoneMap       = require('./utils/lidPhoneMap');

// Connect to database
connectDB();

// ── Conversation inactivity timers ───────────────────────────────────────────
// After 30 minutes of silence, send the conversation history email.
const inactivityTimers = new Map();
const INACTIVITY_MS    = 30 * 60 * 1000; // 30 minutes (production)

function resetInactivityTimer(phoneNumber) {
  if (inactivityTimers.has(phoneNumber)) clearTimeout(inactivityTimers.get(phoneNumber));
  const t = setTimeout(async () => {
    inactivityTimers.delete(phoneNumber);
    console.log(`⏰ Inactivity timeout for ${phoneNumber} — sending conversation email`);
    try {
      const profile = await onboardingService.getProfile(phoneNumber);
      if (profile?.email) await emailService.sendConversationHistory(profile);
    } catch (e) { console.error('❌ Inactivity email failed:', e.message); }
  }, INACTIVITY_MS);
  inactivityTimers.set(phoneNumber, t);
}

function cancelInactivityTimer(phoneNumber) {
  if (inactivityTimers.has(phoneNumber)) {
    clearTimeout(inactivityTimers.get(phoneNumber));
    inactivityTimers.delete(phoneNumber);
  }
}

function resolveOnboardingLookupPhone(msgFrom, contact) {
  const from = String(msgFrom || '').trim();
  if (!from.endsWith('@lid')) return from;

  const rawNumber = contact?.number || contact?.id?.user || '';
  const digits = String(rawNumber || '').replace(/\D/g, '');
  const resolved = digits ? `+${digits}` : '';

  if (resolved) {
    // Remember this @lid -> phone resolution so future sessions still match
    // the same client even if contact.number stops resolving later.
    lidPhoneMap.rememberLid(from, resolved);
    return resolved;
  }

  // contact.number didn't resolve this time — fall back to a previously
  // remembered mapping instead of treating the client as brand-new.
  return lidPhoneMap.getPhoneForLid(from) || from;
}

// Create WhatsApp client with QR authentication
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

console.log('🚀 Starting WhatsApp Bot...\n');

// ── Connection health tracking ───────────────────────────────────────────────
// Phone-side unlinks don't always emit the 'disconnected' event, so we also
// poll client.getState() below and regenerate the QR when the session drops.
let hasBeenReady        = false; // becomes true after the first successful pairing
let reinitInProgress    = false; // guard so overlapping reinitializations can't stack
let unpairedStrikes     = 0;     // consecutive non-CONNECTED readings before we act
let lastMessageActivityAt = 0;   // last time we started handling a message — the
                                  // health check backs off while a message is being
                                  // processed so it can't yank the browser out from
                                  // under an in-flight reply (this happened once and
                                  // silently swallowed a customer's message)

// Wipe the LocalAuth session folder so initialize() always starts clean.
// Without this, a stale/revoked session causes QR scans to fail silently.
function wipeSession() {
  const sessionDir = path.join(__dirname, '../../.wwebjs_auth/session');
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('🗑️  Wiped stale session folder — next scan will be fresh');
    }
  } catch (e) {
    console.warn('⚠️ Could not wipe session folder:', e.message);
  }
}

// Force-kill any leftover Chromium/Chrome processes spawned by Puppeteer.
function forceKillChrome() {
  try {
    // Try to get the browser PID from the Puppeteer browser object first
    const browser = client.pupBrowser;
    if (browser) {
      const proc = browser.process();
      if (proc && proc.pid) {
        try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {}
        console.log(`🔪 Force-killed Chrome PID ${proc.pid}`);
        return;
      }
    }
  } catch (_) {}
  // Optional fallback: kill ALL chrome.exe processes (Windows).
  // Disabled by default to avoid closing user's normal browser windows.
  const allowSystemKill = String(process.env.FORCE_KILL_BROWSER_PROCESSES || '').toLowerCase() === 'true';
  if (allowSystemKill) {
    try {
      require('child_process').execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
      console.log('🔪 Force-killed all chrome.exe processes');
    } catch (_) {}
  }
}

// Safely destroy the current Puppeteer instance with a hard 5-second timeout.
// If destroy() hangs (common when the browser is already in a bad state),
// we force-kill Chrome and move on so initialize() can start fresh.
async function safeReinitialize() {
  if (reinitInProgress) {
    console.log('⏳ safeReinitialize already in progress — skipping duplicate call');
    return;
  }
  reinitInProgress = true;
  // A reinit means the old session is gone; require a fresh 'ready' before the
  // health watcher starts guarding again.
  hasBeenReady = false;
  unpairedStrikes = 0;

  console.log('🔄 safeReinitialize: destroying old browser...');

  try {
    // Race destroy() against a 5 s timeout
    await Promise.race([
      client.destroy().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);

    // Extra safety: force-kill any leftover Chrome process
    forceKillChrome();

    // Give the OS a moment to release ports/files
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Wipe stale session so the QR scan is always clean
    wipeSession();

    // Start fresh
    console.log('🔄 safeReinitialize: starting fresh initialize...');
    await client.initialize();
  } catch (err) {
    console.error('❌ safeReinitialize: initialize failed:', err.message);
  } finally {
    reinitInProgress = false;
  }
}

// Handle client errors
client.on('auth_failure', (msg) => {
  console.error('⚠️  Authentication failure:', msg);
});

// QR Code generation
client.on('qr', async (qr) => {
  console.log('\n===========================================');
  console.log('🔐 WhatsApp QR Code Ready');
  console.log('===========================================');
  console.log('📱 Open the dashboard: Settings → WhatsApp Connection\n');

  const path = require('path');
  try {
    // Save as a real PNG file — served directly by the server (no base64 issues)
    const qrFilePath = path.join(__dirname, '../../frontend/qr-live.png');
    await QRCode.toFile(qrFilePath, qr, { width: 300, margin: 2 });
    // Update state: just status + timestamp, no bulky base64
    fs.writeFileSync(
      path.join(__dirname, '../.bot-state.json'),
      JSON.stringify({ status: 'qr', qr: null, timestamp: Date.now() })
    );
    console.log('✅ QR saved to frontend/qr-live.png — scan it in the dashboard!\n');
  } catch (err) {
    console.error('❌ Error saving QR code:', err);
  }
});

// Client ready
client.on('ready', () => {
  console.log('\n===========================================');
  console.log('✅ WhatsApp Bot is Ready!');
  console.log('===========================================');
  console.log('📱 Phone connected successfully');
  console.log('🤖 Bot is now listening for messages\n');
  console.log('Commands available:');
  console.log('  !task [description]   - Create a task');
  console.log('  !request [description] - Create a request');
  console.log('  !list                 - List all tasks/requests');
  console.log('  !status               - Show statistics');
  console.log('  !help                 - Show help\n');
  
  // Mark as ready in shared state file
  const fs2 = require('fs');
  const path2 = require('path');
  try {
    fs2.writeFileSync(
      path2.join(__dirname, '../.bot-state.json'),
      JSON.stringify({ status: 'connected', qr: null, timestamp: Date.now() })
    );
  } catch(e) {}
  WhatsAppState.setReady(true);
  hasBeenReady = true;   // arm the connection health watcher
  unpairedStrikes = 0;
  console.log('✅ WhatsApp client ready - Message sending enabled!\n');
});

// Handle authentication
client.on('authenticated', () => {
  console.log('✅ Authentication successful!');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
  console.log('⚠️ Client was disconnected:', reason);
  try {
    fs.writeFileSync(
      path.join(__dirname, '../.bot-state.json'),
      JSON.stringify({ status: 'disconnected', qr: null, timestamp: Date.now() })
    );
  } catch(e) {}

  // Auto-reinitialize using safeReinitialize which races destroy() against a
  // timeout and force-kills Chrome if it hangs.
  console.log('🔄 Reinitializing WhatsApp client to generate new QR...');
  setTimeout(() => safeReinitialize(), 3000);
});

// ── Connection health watcher ────────────────────────────────────────────────
// The 'disconnected' event does NOT reliably fire when the user unlinks the
// device from their phone. So once the bot has been paired, we poll the session
// state; if it stops being CONNECTED, we mark it disconnected and regenerate the
// QR automatically — no need to press "Disconnect" on the dashboard first.
const HEALTH_CHECK_INTERVAL_MS = 20000;
const HEALTH_CHECK_STRIKES_REQUIRED = 3;   // ~60s of confirmed bad state before acting
const HEALTH_CHECK_ACTIVITY_COOLDOWN_MS = 20000; // skip the check while a message is in flight

setInterval(async () => {
  if (reinitInProgress || !hasBeenReady) return; // idle before first pairing / during reinit

  // Don't contend with an in-flight message: getState() shares the same
  // Puppeteer page, and a reinit triggered mid-reply silently drops that reply.
  if (Date.now() - lastMessageActivityAt < HEALTH_CHECK_ACTIVITY_COOLDOWN_MS) return;

  let state = null;
  let threw = false;
  try {
    state = await client.getState();
  } catch (_) {
    threw = true; // getState() failing could just mean it's busy, not disconnected
  }

  if (state === 'CONNECTED') {
    unpairedStrikes = 0;
    return;
  }

  // A thrown error is inconclusive on its own — only count it if it keeps
  // happening across multiple checks (handled by the normal strike counter),
  // but don't log a scary "disconnect detected" state for a transient throw.
  unpairedStrikes += 1;
  console.log(`⚠️ Health check: WhatsApp state is "${threw ? 'unknown (getState failed)' : state}" (strike ${unpairedStrikes}/${HEALTH_CHECK_STRIKES_REQUIRED})`);

  if (unpairedStrikes >= HEALTH_CHECK_STRIKES_REQUIRED) {
    console.log('🔌 Phone-side disconnect detected — regenerating QR automatically...');
    try {
      fs.writeFileSync(
        path.join(__dirname, '../.bot-state.json'),
        JSON.stringify({ status: 'disconnected', qr: null, timestamp: Date.now() })
      );
    } catch (_) {}
    safeReinitialize(); // resets hasBeenReady + strikes internally
  }
}, HEALTH_CHECK_INTERVAL_MS);

// Handle incoming messages. Extracted into a named function (rather than an
// inline listener) so the polling fallback below can reuse the exact same
// logic for messages whose 'message' event never fired live.
async function handleIncomingMessage(msg) {
  lastMessageActivityAt = Date.now();
  try {
    // Ignore groups, status updates, newsletters and broadcasts
    if (
      msg.from.includes('@g.us') ||
      msg.from.includes('@newsletter') ||
      msg.from.includes('@broadcast') ||
      msg.from === 'status@broadcast' ||
      msg.isStatus
    ) {
      return;
    }
    
    console.log(`📨 Message from ${msg.from}: ${msg.body}`);
    
    // Save message with sentiment analysis (no getContact() call here — see
    // messageService.saveMessage for why that matters)
    const { message: savedMsg, created: isNewIncoming } = await messageService.saveMessage(msg);

    if (!savedMsg) {
      return;
    }

    if (!isNewIncoming) {
      console.log(`🔁 Duplicate incoming event ignored: ${savedMsg.messageId}`);
      return;
    }
    
    // Notify dashboard server so it can push to browser via socket
    if (savedMsg) {
      notifyServer('newMessage', {
        id: savedMsg.id,
        from: savedMsg.fromName || savedMsg.from,
        fromName: savedMsg.fromName || savedMsg.from,
        fromPhone: savedMsg.from,
        phone: savedMsg.from,
        body: savedMsg.body,
        sentiment: savedMsg.sentimentLabel,
        timestamp: savedMsg.timestamp
      });
    }

    // ── Get real contact name / lookup phone ───────────────────────────────
    // Avoid msg.getContact() whenever possible — for @lid (privacy-id) chats it
    // can take up to ~2 minutes to resolve, which was delaying the ENTIRE reply
    // pipeline by that much and causing multiple customer messages to pile up
    // before the bot replied to the first one. notifyName covers the common
    // case with no round-trip; getContact() only runs the first time we see a
    // given @lid (after that, lidPhoneMap has it cached).
    const isLidChat = msg.from.endsWith('@lid');
    const cachedLidPhone = isLidChat ? lidPhoneMap.getPhoneForLid(msg.from) : null;
    let msgContact = null;
    if (isLidChat && !cachedLidPhone) {
      msgContact = await msg.getContact();
    }
    const fromName = msgContact?.pushname || msgContact?.name || msg._data?.notifyName || 'there';
    const lookupPhone = resolveOnboardingLookupPhone(msg.from, msgContact);

    // ── Onboarding: collect name / designation / phone / email ───────────────
    // processOnboarding returns { response, done } while collecting info,
    // or null once the user is fully onboarded.
    const onboarding = await onboardingService.processOnboarding(lookupPhone, msg.body);
    if (onboarding !== null) {
      try { await msg.reply(onboarding.response); }
      catch (e) { await sendWithRecovery(() => client.sendMessage(msg.from, onboarding.response), 'onboarding reply'); }
      return; // don't run AI / commands until onboarding is complete
    }
    
    // ── Commands ─────────────────────────────────────────────────────────────
    if (msg.body.startsWith('!')) {
      await processCommand(msg, client, messageService);
      return;
    }

    // ── Reset 30-min inactivity timer (send email after silence) ─────────────
    resetInactivityTimer(msg.from);

    // Use the name the client actually gave us during onboarding (not their
    // WhatsApp display name, which is often different) so the bot addresses
    // them consistently instead of flip-flopping between two names.
    const savedProfile = await onboardingService.getProfile(lookupPhone);
    const displayName = (savedProfile?.name || '').trim() || fromName;

    // ── Meeting confirmation workflow (availability + booking + Zoom link) ──
    const meetingFlow = await meetingService.maybeHandleMeetingMessage({
      phoneNumber: lookupPhone,
      fromName: displayName,
      messageBody: msg.body,
      messageId: savedMsg.messageId
    });

    if (meetingFlow?.handled) {
      try {
        await msg.reply(meetingFlow.response);
      } catch (replyErr) {
        console.log(`⚠️  Meeting reply fallback sendMessage: ${replyErr.message?.substring(0, 80)}`);
        await sendWithRecovery(() => client.sendMessage(msg.from, meetingFlow.response), 'meeting reply');
      }
      return;
    }

    // ── Generate AI response ──────────────────────────────────────────────────
    const chatResponse = await chatbotService.generateResponse(
      msg.body,
      msg.from,
      displayName,
      { lookupPhone }
    );
    
    // Send automated response if appropriate
    if (chatResponse.shouldReply) {
      console.log(`🤖 Sending auto-reply (Intent: ${chatResponse.intent})`);

      const delayMs = Math.max(0, parseInt(chatResponse.responseDelaySeconds, 10) || 0) * 1000;
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      
      try {
        await msg.reply(chatResponse.response);
      } catch (replyErr) {
        console.log(`⚠️  msg.reply() failed, using sendMessage fallback: ${replyErr.message?.substring(0, 60)}`);
        await sendWithRecovery(() => client.sendMessage(msg.from, chatResponse.response), 'auto reply');
      }
      
      console.log(`✅ Replied: ${chatResponse.response.substring(0, 50)}...`);
      
      if (chatResponse.taskCreated) {
        console.log(`📋 Task created for follow-up`);
      }

      // ── Goodbye → send conversation history email immediately ─────────────
      if (chatResponse.intent === 'goodbye') {
        console.log(`👋 Goodbye detected — sending conversation history to ${msg.from}`);
        cancelInactivityTimer(msg.from); // no need for the inactivity timer now
        setTimeout(async () => {
          try {
            const profile = await onboardingService.getProfile(msg.from);
            if (profile?.email) await emailService.sendConversationHistory(profile);
          } catch (e) { console.error('❌ Goodbye email failed:', e.message); }
        }, 2000);
      }
    }
    
  } catch (error) {
    console.error('Error handling message:', error.message?.substring(0, 150));
  }
}

client.on('message', handleIncomingMessage);

// Handle message creation (outgoing messages)
client.on('message_create', async (msg) => {
  try {
    // Only process messages sent by the bot user
    if (msg.fromMe && !msg.from.includes('@g.us')) {
      // For outgoing messages, 'to' is in msg.to property
      await messageService.saveMessage(msg, msg.to);
    }
  } catch (error) {
    console.error('Error handling message_create:', error);
  }
});

// Initialize client
client.initialize().catch(error => {
  console.error('❌ Failed to initialize WhatsApp client:', error);
  console.log('   Retrying in 5 seconds...');
  setTimeout(() => client.initialize(), 5000);
});

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Rejection at:', promise, 'reason:', reason);
  console.log('   Bot will continue running...');
  // Don't exit the process, keep trying
});

process.on('uncaughtException', (error) => {
  console.error('⚠️  Uncaught Exception:', error);
  console.log('   Bot will continue running...');
  // Don't exit the process, keep trying
});

// Keep the process alive
setInterval(() => {
  // This keeps the Node.js process running
}, 1000);

// ── Notify dashboard server via HTTP ────────────────────────────────────
function notifyServer(type, data) {
  try {
    const body = JSON.stringify({ type, data });
    const req = http.request({
      hostname: 'localhost',
      port: 3002,
      path: '/api/internal/broadcast',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.on('error', () => {}); // silent — dashboard may not be running
    req.write(body);
    req.end();
  } catch (e) {}
}

function isDetachedFrameError(error) {
  const message = String(error?.message || error || '');
  return /detached frame|attempted to use detached frame|execution context was destroyed|cannot find context with specified id|session closed|target closed|protocol error/i.test(message);
}

async function sendWithRecovery(sendAction, contextLabel = 'message') {
  try {
    return await sendAction();
  } catch (error) {
    if (!isDetachedFrameError(error)) {
      throw error;
    }

    console.warn(`⚠️ Detached frame while sending ${contextLabel}; reinitializing WhatsApp client and retrying once...`);
    await safeReinitialize();
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      return await sendAction();
    } catch (retryError) {
      console.error(`❌ Retry failed for ${contextLabel}:`, retryError.message);
      throw retryError;
    }
  }
}

async function resolveRecipientChatId(phoneNumber) {
  const raw = String(phoneNumber || '').trim();
  if (!raw) return '';

  if (raw.includes('@')) return raw;

  const digitsOnly = raw.replace(/\D/g, '');
  const normalized = normalizeChatId(raw);

  try {
    const numberId = await client.getNumberId(digitsOnly || normalized.replace(/@.*/, ''));
    if (numberId?._serialized) return numberId._serialized;
  } catch (_) {}

  return digitsOnly ? `${digitsOnly}@c.us` : normalized;
}

function normalizeChatId(phoneNumber = '') {
  const raw = String(phoneNumber || '').trim();
  if (!raw) return '';

  // WhatsApp IDs can already be in WID form (@c.us, @lid, @g.us).
  // Preserve them as-is; only append @c.us for bare numbers.
  if (raw.includes('@')) return raw;

  const digitsOnly = raw.replace(/[^ --+\d]/g, '').replace(/[\s()-]/g, '');
  return digitsOnly ? `${digitsOnly}@c.us` : raw;
}

// ── Internal HTTP bridge (port 3003) ──────────────────────────────────────
// The dashboard server (port 3002) forwards send requests here
const http = require('http');
const botBridge = http.createServer(async (req, res) => {

  // ── GET /ping — liveness check used by the status endpoint ────────────
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /disconnect — dashboard Disconnect button triggers this ──────────
  if (req.method === 'GET' && req.url === '/disconnect') {
    console.log('🔌 Disconnect requested via dashboard...');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Disconnecting...' }));

    setTimeout(async () => {
      // Try a clean logout first (removes saved session so no auto-reconnect).
      // If the Puppeteer frame is already detached / session already dead,
      // logout() throws "detached Frame" — in that case skip straight to
      // destroy() + initialize() so we still get a fresh QR.
      try {
        await client.logout();
        console.log('✅ logout() succeeded — waiting for WA servers to unpair phone...');
        // Give WhatsApp servers 2 s to process the unpair and notify the phone
        // BEFORE we kill the Puppeteer browser. Without this delay, destroy()
        // closes the browser before the server ACK reaches the phone, so the
        // phone still shows the device as linked.
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.warn('⚠️ logout() failed (session already gone):', err.message);
      }

      // Destroy + wipe + reinitialize via the shared safe helper
      await safeReinitialize();
    }, 300);
    return;
  }

  // ── GET /reinitialize — dashboard Refresh button triggers this ──────────
  if (req.method === 'GET' && req.url === '/reinitialize') {
    console.log('🔄 Reinitialize requested via dashboard...');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Reinitializing...' }));

    setTimeout(async () => {
      await safeReinitialize();
    }, 500);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    lastMessageActivityAt = Date.now(); // dashboard-triggered sends also use Puppeteer
    try {
      const { phoneNumber, message, mediaData, mimeType, fileName } = JSON.parse(body);
      if (!phoneNumber || (!message && !mediaData)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'phoneNumber and message or mediaData required' }));
        return;
      }

      if (!client.info) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WhatsApp not ready yet, scan QR first' }));
        return;
      }

      // Verify session is truly CONNECTED (not just partially initialized)
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `WhatsApp not connected (state: ${state}). Please wait or re-scan QR.` }));
        return;
      }

      const chatId = await resolveRecipientChatId(phoneNumber);
      if (!chatId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid phone number or chat id' }));
        return;
      }

      let chat = null;
      try {
        chat = await client.getChatById(chatId);
      } catch (_) {
        chat = null;
      }

      if (mediaData) {
        const { MessageMedia } = require('whatsapp-web.js');
        // Write base64 to a temp file — more reliable than passing large
        // base64 strings through Puppeteer's page.evaluate() which can fail silently
        const ext = (mimeType.split('/')[1] || 'bin').split(';')[0];
        const tempPath = path.join(os.tmpdir(), `wbot_${Date.now()}.${ext}`);
        try {
          fs.writeFileSync(tempPath, Buffer.from(mediaData, 'base64'));
          await sendWithRecovery(async () => {
            const media = MessageMedia.fromFilePath(tempPath);
            if (chat?.sendMessage) {
              await chat.sendMessage(media);
              return;
            }
            await client.sendMessage(chatId, media);
          }, 'media');
          const sizeKB = (Buffer.byteLength(mediaData, 'base64') / 1024).toFixed(1);
          console.log(`✅ Media sent to ${chatId} [${mimeType}, ${sizeKB} KB]`);
        } finally {
          try { fs.unlinkSync(tempPath); } catch (_) {}
        }
      } else {
        await sendWithRecovery(async () => {
          if (chat?.sendMessage) {
            await chat.sendMessage(message);
            return;
          }
          await client.sendMessage(chatId, message);
        }, 'text message');
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      console.error('Bot bridge send failed:', e?.stack || e?.message || e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || String(e) || 'Failed to send message' }));
    }
  });
});

botBridge.listen(3003, () => {
  console.log('🔗 Bot bridge listening on port 3003 (internal)');
});

// Export client for use in server
module.exports = client;
