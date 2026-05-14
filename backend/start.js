// Startup script for WhatsApp Bot Dashboard
// This script starts both the server and the bot

console.log('🚀 Starting WhatsApp Bot Dashboard...\n');

// Start the server first
require('./src/server');

// Wait a bit for server to initialize, then start the bot
setTimeout(() => {
  console.log('🤖 Initializing WhatsApp Bot...\n');
  require('./src/bot');
}, 2000);
