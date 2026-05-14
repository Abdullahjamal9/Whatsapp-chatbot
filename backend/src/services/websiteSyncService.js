const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SETTINGS_PATH = path.join(__dirname, '../../.website-sync.json');
const PROFILE_PATH = path.join(__dirname, '../../.business-profile.json');

const DEFAULT_SETTINGS = {
  enabled: false,
  url: '',
  intervalMinutes: 360,
  maxPages: 30,
  maxChars: 8000,
  lastSyncAt: null,
  lastPageCount: 0,
  lastError: null,
  lastErrorAt: null,
  lastContentHash: '',
  updatedAt: null
};

const SYNC_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const MAX_PAGE_CHARS = 3500;

let syncInProgress = false;
let schedulerId = null;

function normalizeHost(host = '') {
  return String(host || '').trim().toLowerCase().replace(/^www\./, '');
}

function normalizeUrlKey(input = '') {
  try {
    const url = new URL(String(input || '').trim());
    url.hash = '';
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch (_) {
    return '';
  }
}

function normalizeUrlInput(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return `https://${raw}`;
  return raw;
}

function isBlockedExtension(pathname = '') {
  const ext = path.extname(pathname).toLowerCase();
  if (!ext) return false;
  return [
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg',
    '.mp4', '.mp3', '.wav', '.avi', '.mov',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.rar', '.7z', '.tar', '.gz',
    '.css', '.js', '.json', '.xml', '.ico'
  ].includes(ext);
}

function decodeHtmlEntities(text = '') {
  let out = String(text || '');
  const replacements = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&lt;': '<',
    '&gt;': '>'
  };

  Object.entries(replacements).forEach(([key, val]) => {
    out = out.split(key).join(val);
  });

  out = out.replace(/&#(\d+);/g, (_, num) => {
    const code = parseInt(num, 10);
    return Number.isFinite(code) ? String.fromCharCode(code) : '';
  });

  return out;
}

function extractTextFromHtml(html = '') {
  if (!html) return '';
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|section|article|br|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(cleaned);
  const normalized = decoded
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!normalized) return '';
  return normalized.slice(0, MAX_PAGE_CHARS);
}

function extractLinks(html = '', baseUrl = '') {
  const links = [];
  const regex = /href\s*=\s*["']([^"']+)["']/gi;
  let match = null;

  while ((match = regex.exec(html)) !== null) {
    const raw = String(match[1] || '').trim();
    if (!raw) continue;
    if (raw.startsWith('#')) continue;
    if (/^(mailto:|tel:|javascript:)/i.test(raw)) continue;

    try {
      const url = new URL(raw, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (isBlockedExtension(url.pathname)) continue;
      links.push(url.toString());
    } catch (_) {
      continue;
    }
  }

  return links;
}

async function fetchHtml(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'WhatsAppBotDashboard/1.0'
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return { html: '', contentType, skipped: true };
    }

    const html = await res.text();
    return { html, contentType, skipped: false };
  } finally {
    clearTimeout(timer);
  }
}

function buildWebsiteContent(pages = [], maxChars = DEFAULT_SETTINGS.maxChars) {
  const lineSet = new Set();
  const output = [];
  let count = 0;

  for (const page of pages) {
    const header = `Page: ${page.url}`;
    if (count + header.length + 1 > maxChars) break;
    output.push(header);
    count += header.length + 1;

    const lines = String(page.text || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (line.length < 2) continue;
      const key = line.toLowerCase();
      if (lineSet.has(key)) continue;
      lineSet.add(key);

      if (count + line.length + 1 > maxChars) break;
      output.push(line);
      count += line.length + 1;
    }

    if (count >= maxChars) break;
    output.push('');
    count += 1;
  }

  return output.join('\n').trim();
}

async function crawlWebsite(baseUrl, options = {}) {
  const maxPages = Math.max(1, parseInt(options.maxPages || DEFAULT_SETTINGS.maxPages, 10));
  const maxChars = Math.max(500, parseInt(options.maxChars || DEFAULT_SETTINGS.maxChars, 10));

  const pages = [];
  const visited = new Set();
  const queue = [];

  let base;
  try {
    base = new URL(baseUrl);
  } catch (e) {
    throw new Error('Invalid website URL');
  }

  const baseHost = normalizeHost(base.hostname);
  queue.push(base.toString());

  // Simple breadth-first crawl within the same host.
  while (queue.length && pages.length < maxPages) {
    const current = queue.shift();
    const currentKey = normalizeUrlKey(current);
    if (!currentKey || visited.has(currentKey)) continue;
    visited.add(currentKey);

    let html = '';
    try {
      const result = await fetchHtml(current);
      if (!result || result.skipped) continue;
      html = result.html || '';
    } catch (_) {
      continue;
    }

    const text = extractTextFromHtml(html);
    if (text) {
      pages.push({ url: current, text });
    }

    const links = extractLinks(html, current);
    for (const link of links) {
      const key = normalizeUrlKey(link);
      if (!key || visited.has(key)) continue;

      try {
        const linkUrl = new URL(link);
        if (normalizeHost(linkUrl.hostname) !== baseHost) continue;
      } catch (_) {
        continue;
      }

      if (queue.length >= maxPages * 5) break;
      queue.push(link);
    }
  }

  return {
    pages,
    content: buildWebsiteContent(pages, maxChars)
  };
}

function readWebsiteSyncSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS };
    }
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...(saved || {}) };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveWebsiteSyncSettings(input = {}) {
  const existing = readWebsiteSyncSettings();

  const intervalMinutes = parseInt(input.intervalMinutes, 10);
  const maxPages = parseInt(input.maxPages, 10);
  const maxChars = parseInt(input.maxChars, 10);

  const updated = {
    ...existing,
    enabled: input.enabled !== undefined ? !!input.enabled : existing.enabled,
    url: input.url !== undefined ? normalizeUrlInput(input.url) : existing.url,
    intervalMinutes: Number.isFinite(intervalMinutes)
      ? Math.min(1440, Math.max(30, intervalMinutes))
      : existing.intervalMinutes,
    maxPages: Number.isFinite(maxPages)
      ? Math.min(120, Math.max(5, maxPages))
      : existing.maxPages,
    maxChars: Number.isFinite(maxChars)
      ? Math.min(20000, Math.max(2000, maxChars))
      : existing.maxChars,
    lastSyncAt: input.lastSyncAt !== undefined ? input.lastSyncAt : existing.lastSyncAt,
    lastPageCount: input.lastPageCount !== undefined ? input.lastPageCount : existing.lastPageCount,
    lastError: input.lastError !== undefined ? input.lastError : existing.lastError,
    lastErrorAt: input.lastErrorAt !== undefined ? input.lastErrorAt : existing.lastErrorAt,
    lastContentHash: input.lastContentHash !== undefined ? input.lastContentHash : existing.lastContentHash,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

function hashContent(content = '') {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function updateBusinessProfile(content, settings, pageCount) {
  let existing = {};
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      existing = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    }
  } catch (_) {
    existing = {};
  }

  const updated = {
    ...existing,
    websiteSourceUrl: settings.url,
    websiteContent: content,
    websitePageCount: pageCount,
    websiteLastSyncAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(PROFILE_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

async function runWebsiteSync({ force = false } = {}) {
  if (syncInProgress) {
    return { success: false, skipped: true, reason: 'in_progress' };
  }

  const settings = readWebsiteSyncSettings();
  if (!settings.url) {
    return { success: false, skipped: true, reason: 'missing_url' };
  }

  const lastSyncAt = settings.lastSyncAt ? Date.parse(settings.lastSyncAt) : 0;
  const dueAt = lastSyncAt + (settings.intervalMinutes * 60 * 1000);
  const isDue = !lastSyncAt || Date.now() >= dueAt;

  if (!force && !settings.enabled) {
    return { success: false, skipped: true, reason: 'disabled' };
  }

  if (!force && !isDue) {
    return { success: true, skipped: true, reason: 'not_due' };
  }

  syncInProgress = true;
  const startedAt = Date.now();

  try {
    const { pages, content } = await crawlWebsite(settings.url, settings);
    if (!content) throw new Error('No readable text found on the website');

    const contentHash = hashContent(content);
    const pageCount = pages.length;

    updateBusinessProfile(content, settings, pageCount);

    const updatedSettings = saveWebsiteSyncSettings({
      ...settings,
      lastSyncAt: new Date().toISOString(),
      lastPageCount: pageCount,
      lastError: null,
      lastErrorAt: null,
      lastContentHash: contentHash
    });

    try {
      const chatbotService = require('./chatbotService');
      chatbotService.systemPrompt = chatbotService.loadSystemPrompt();
    } catch (_) {}

    return {
      success: true,
      updated: true,
      pageCount,
      contentChars: content.length,
      durationMs: Date.now() - startedAt,
      settings: updatedSettings
    };
  } catch (e) {
    const updatedSettings = saveWebsiteSyncSettings({
      ...settings,
      lastError: e.message || 'Website sync failed',
      lastErrorAt: new Date().toISOString()
    });

    return {
      success: false,
      error: e.message || 'Website sync failed',
      settings: updatedSettings
    };
  } finally {
    syncInProgress = false;
  }
}

function startWebsiteSyncScheduler() {
  if (schedulerId) return schedulerId;

  const runTick = async () => {
    const result = await runWebsiteSync();
    if (!result || result.skipped) return;
    if (!result.success && result.error) {
      console.error('Website sync error:', result.error);
    }
  };

  schedulerId = setInterval(() => {
    runTick().catch(err => {
      console.error('Website sync scheduler error:', err.message);
    });
  }, SYNC_CHECK_INTERVAL_MS);

  setTimeout(() => {
    runTick().catch(err => {
      console.error('Website sync initial error:', err.message);
    });
  }, 15000);

  return schedulerId;
}

module.exports = {
  readWebsiteSyncSettings,
  saveWebsiteSyncSettings,
  runWebsiteSync,
  startWebsiteSyncScheduler
};
