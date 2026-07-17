const https = require('https');
const crypto = require('crypto');

// whatsapp-web.js's built-in msg.downloadMedia() decrypts inside the browser
// via WhatsApp Web's own (currently broken) internal module. We instead do the
// download + decrypt ourselves in Node using the documented WhatsApp media
// scheme, which sidesteps that library bug entirely. All we need is data that
// already arrives on the message: the encrypted file's directPath and the
// per-file mediaKey.
const MEDIA_HOST = 'mmg.whatsapp.net';

// Per-media-type HKDF info string used to expand the mediaKey.
const MEDIA_KEY_INFO = {
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  ptt: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker: 'WhatsApp Image Keys'
};

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WhatsApp' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} while downloading media`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('media download timed out')); });
    req.on('error', reject);
  });
}

// HKDF-SHA256 with a zero salt (WhatsApp's scheme), returning `length` bytes.
function expandMediaKey(mediaKey, length, info) {
  const out = crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(info, 'utf8'), length);
  return Buffer.from(out);
}

/**
 * Download an encrypted WhatsApp media file and decrypt it locally.
 * @param {Object} opts
 * @param {string} opts.directPath  msg._data.directPath (path under mmg.whatsapp.net)
 * @param {string|Buffer} opts.mediaKey  base64 string or Buffer
 * @param {string} opts.type  'document' | 'image' | 'video' | 'audio' | ...
 * @returns {Promise<Buffer>} the decrypted file bytes
 */
async function downloadAndDecrypt({ directPath, mediaKey, type }) {
  if (!directPath || !mediaKey) throw new Error('missing directPath or mediaKey');

  const info = MEDIA_KEY_INFO[type] || MEDIA_KEY_INFO.document;
  const keyBuf = Buffer.isBuffer(mediaKey) ? mediaKey : Buffer.from(String(mediaKey), 'base64');

  const expanded = expandMediaKey(keyBuf, 112, info);
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const url = String(directPath).startsWith('http')
    ? String(directPath)
    : `https://${MEDIA_HOST}${directPath}`;

  const enc = await httpsGetBuffer(url);
  if (enc.length <= 10) throw new Error('encrypted media too small');

  // Last 10 bytes are the truncated HMAC; the rest is the ciphertext.
  const ciphertext = enc.subarray(0, enc.length - 10);
  const mac = enc.subarray(enc.length - 10);

  const expectedMac = crypto.createHmac('sha256', macKey)
    .update(iv)
    .update(ciphertext)
    .digest()
    .subarray(0, 10);

  if (!crypto.timingSafeEqual(expectedMac, mac)) {
    throw new Error('media MAC verification failed');
  }

  const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Best-effort extraction of the fields we need off a whatsapp-web.js message,
 * then download + decrypt. Returns { data(base64), mimetype, filename } or throws.
 */
async function fetchMediaFromMessage(msg) {
  const d = msg?._data || {};
  const directPath = d.directPath || msg.directPath;
  const mediaKey = d.mediaKey || msg.mediaKey;
  const type = msg.type || d.type || 'document';

  const decrypted = await downloadAndDecrypt({ directPath, mediaKey, type });

  return {
    data: decrypted.toString('base64'),
    mimetype: d.mimetype || msg.mimetype || 'application/octet-stream',
    filename: d.filename || msg.filename || 'document'
  };
}

module.exports = { downloadAndDecrypt, fetchMediaFromMessage };
