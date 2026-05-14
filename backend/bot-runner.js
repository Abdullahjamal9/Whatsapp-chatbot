// Bot runner - auto-restarts the bot when it crashes so QR is always fresh
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

console.log('🤖 Bot Runner started - will auto-restart on crash\n');

// Keep process alive
setInterval(() => {}, 1000);

let restartCount = 0;
let currentBot = null;
let isRestarting = false;

function killOrphanChrome() {
  const allowSystemKill = String(process.env.FORCE_KILL_BROWSER_PROCESSES || '').toLowerCase() === 'true';
  if (allowSystemKill) {
    try {
      // Optional hard cleanup (disabled by default): can close user browser windows.
      execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
    } catch(e) {}
    try {
      execSync('taskkill /F /IM chromium.exe /T 2>nul', { stdio: 'ignore' });
    } catch(e) {}
  }
  // Also remove chrome lock files
  const lockFile = path.join(__dirname, '.wwebjs_auth/session/SingletonLock');
  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch(e) {}
  const lockFile2 = path.join(__dirname, '.wwebjs_auth/session/Default/SingletonLock');
  try { if (fs.existsSync(lockFile2)) fs.unlinkSync(lockFile2); } catch(e) {}
}

function isBotBridgeAlive(timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const req = http.request(
      { hostname: '127.0.0.1', port: 3003, path: '/ping', method: 'GET' },
      (res) => {
        res.resume();
        if (!done) {
          done = true;
          resolve(res.statusCode === 200);
        }
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      if (!done) {
        done = true;
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
}

async function startBot() {
  if (isRestarting) return;

  const alreadyRunning = await isBotBridgeAlive();
  if (alreadyRunning) {
    console.log('ℹ️ Existing bot instance detected on port 3003. Exiting duplicate runner.');
    process.exit(0);
    return;
  }

  restartCount++;
  console.log(`🚀 Starting bot (attempt #${restartCount})...\n`);

  // Clean up before starting
  killOrphanChrome();

  currentBot = spawn(process.execPath, [path.join(__dirname, 'src/bot.js')], {
    stdio: 'inherit',
    cwd: __dirname,
    detached: false,
    windowsHide: true
  });

  currentBot.on('exit', (code, signal) => {
    currentBot = null;
    if (!isRestarting) {
      console.log(`\n⚠️  Bot exited (code: ${code}). Restarting in 4 seconds...\n`);
      setTimeout(() => {
        startBot().catch((err) => {
          console.error('startBot restart error:', err.message);
        });
      }, 4000);
    }
  });

  currentBot.on('error', (err) => {
    console.error('Bot process error:', err.message);
    currentBot = null;
    setTimeout(() => {
      startBot().catch((startErr) => {
        console.error('startBot error after process error:', startErr.message);
      });
    }, 4000);
  });
}

process.on('SIGINT', () => {
  if (isRestarting) { process.exit(0); return; }
  isRestarting = true;
  console.log('\n🛑 Stopping bot runner... Press Ctrl+C again to force quit.');
  if (currentBot) { currentBot.kill('SIGTERM'); }
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGTERM', () => {
  if (currentBot) currentBot.kill();
  process.exit(0);
});

startBot().catch((err) => {
  console.error('Failed to start bot runner:', err.message);
  process.exit(1);
});
