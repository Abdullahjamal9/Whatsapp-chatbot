// Shared state manager for WhatsApp client between processes
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../.whatsapp-state.json');

class WhatsAppState {
  static setReady(isReady) {
    try {
      const state = { ready: isReady, timestamp: Date.now() };
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (error) {
      console.error('Error writing state:', error);
    }
  }
  
  static isReady() {
    try {
      if (!fs.existsSync(STATE_FILE)) return false;
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // State is valid for 5 minutes
      return state.ready && (Date.now() - state.timestamp) < 300000;
    } catch (error) {
      return false;
    }
  }
}

module.exports = WhatsAppState;
