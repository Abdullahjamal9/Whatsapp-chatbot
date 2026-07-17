const fs = require('fs');
const path = require('path');

// WhatsApp sometimes assigns a client's chat a privacy "@lid" id instead of
// their real number, and contact.number can fail to resolve on a later
// session even for a client we've already identified once. Without a durable
// mapping, that client looks brand-new on the next visit and gets
// re-onboarded from scratch. This file remembers every @lid -> phone
// resolution we've successfully made, so it survives bot restarts.
const MAP_FILE = path.join(__dirname, '../../.lid-phone-map.json');
let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = fs.existsSync(MAP_FILE) ? (JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) || {}) : {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(MAP_FILE, JSON.stringify(cache || {}, null, 2));
  } catch (_) {}
}

function getPhoneForLid(lid) {
  if (!lid) return null;
  return load()[lid] || null;
}

function rememberLid(lid, phone) {
  if (!lid || !phone) return;
  const map = load();
  if (map[lid] === phone) return;
  map[lid] = phone;
  save();
}

module.exports = { getPhoneForLid, rememberLid };
