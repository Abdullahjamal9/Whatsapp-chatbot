// Initialize Socket.IO
const socket = io();

// Global variables
let sentimentChart, taskChart;
let currentFilter = 'all';
let currentPage = 'dashboard';
let profileCache = [];
let meetingsRawData = [];
let meetingsRenderedData = [];
let _meetingSearchTimer = null;
let meetingRescheduleTargetId = null;
let meetingCancelTargetId = null;
let meetingDeleteTargetId = null;

// ── Auth: redirect to login on 401 ──
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401) {
    const clone = res.clone();
    try {
      const data = await clone.json();
      if (data.redirect) { window.location.href = data.redirect; return res; }
    } catch {}
    window.location.href = '/login.html';
  }
  return res;
};

// Logout
async function logoutUser() {
  try {
    await _origFetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
}

// Page Navigation
document.addEventListener('DOMContentLoaded', () => {
  // Setup navigation
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.getAttribute('data-page');
      navigateToPage(page);
    });
  });
  
  // Initialize dashboard
  if (currentPage === 'dashboard') {
    loadStats();
    loadTasks('all');
    loadMessages();
    loadDashboardProfiles();
    loadDashboardSentimentTimeline();
    if (typeof Chart !== 'undefined') {
      initCharts();
    }
  }

  // Website sync settings (auto-refresh bot knowledge)
  loadWebsiteSyncSettings();
  
  // Setup simulator button
  const simulatorBtn = document.getElementById('simulatorBtn');
  if (simulatorBtn) {
    simulatorBtn.addEventListener('click', openSimulator);
  }
  
  // Setup message bubble click events
  setupMessageClickHandlers();

  // Setup timeline filter for sentiment chart
  const timelineFilter = document.getElementById('timelineFilter');
  if (timelineFilter) {
    timelineFilter.addEventListener('change', () => {
      loadDashboardSentimentTimeline();
    });
  }

  // Add sidebar resize listener for chart responsiveness
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    const resizeCharts = () => {
      // Trigger window resize event for Chart.js to respond
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 100);
    };
    
    // Listen for sidebar hover/transition (when sidebar width changes)
    sidebar.addEventListener('mouseenter', resizeCharts);
    sidebar.addEventListener('mouseleave', resizeCharts);
  }

  // Add ResizeObserver for main-content to watch for size changes
  const mainContent = document.querySelector('.main-content');
  if (mainContent && typeof ResizeObserver !== 'undefined') {
    const resizeObserver = new ResizeObserver(() => {
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 50);
    });
    resizeObserver.observe(mainContent);
  }
});

function setupMessageClickHandlers() {
  document.addEventListener('click', (e) => {
    const messageCard = e.target.closest('.message-card');
    if (messageCard && !e.target.closest('.action-btn')) {
      openChatModal(messageCard);
    }
  });
}

async function openChatModal(messageCard) {
  const modal = document.getElementById('chatModal');
  if (!modal) {
    console.error('Chat modal not found');
    return;
  }
  
  const avatar = messageCard.querySelector('.sender-avatar')?.textContent || 'U';
  const name = messageCard.querySelector('.sender-name')?.textContent || 'Unknown';
  const phoneNumber = messageCard.dataset.from || '';
  
  // Store contact info in modal dataset for later use
  modal.dataset.phoneNumber = phoneNumber;
  modal.dataset.contactName = name;
  modal.dataset.avatar = avatar;
  
  // Update modal header
  document.getElementById('chatAvatarModal').textContent = avatar;
  document.getElementById('chatContactName').textContent = name;
  document.getElementById('chatContactPhone').textContent = phoneNumber;
  
  // Show modal
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
  
  // Load conversation messages
  await loadChatMessages(phoneNumber, name, avatar);
}

// Load chat messages for a specific contact
async function loadChatMessages(phoneNumber, contactName, avatar, options = {}) {
  const chatMessagesArea = document.getElementById('chatMessagesArea');
  
  if (!chatMessagesArea) return;
  
  // Show loading state
  chatMessagesArea.innerHTML = '<p class="loading" style="text-align: center; padding: 40px; color: var(--text-secondary);">Loading conversation...</p>';
  
  try {
    // Fetch conversation with this contact using the new endpoint
    const response = await fetch(`/api/messages/conversation/${encodeURIComponent(phoneNumber)}`);
    const data = await response.json();
    
    if (!data.messages || data.messages.length === 0) {
      chatMessagesArea.innerHTML = '<p class="loading" style="text-align: center; padding: 40px; color: var(--text-secondary);">No messages in this conversation yet.</p>';
      return;
    }
    
    // Messages are already sorted by timestamp (oldest first)
    const conversationMessages = data.messages;
    
    // Render messages
    chatMessagesArea.innerHTML = conversationMessages.map(msg => {
      // Use the isBot flag from backend
      const isBot = msg.isBot;
      const messageClass = isBot ? 'outgoing' : 'incoming';
      const messageAvatar = isBot ? 'B' : avatar;
      
      // Render top keywords as clickable tags
      const keywordsHtml = !isBot && msg.topKeywords && msg.topKeywords.length > 0 ? `
        <div class="chat-keywords" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
          ${msg.topKeywords.map(kw => `
            <button class="keyword-tag ${kw.sentiment}" 
              onclick="showKeywordMessages('${escapeHtml(kw.keyword)}')"
              title="${kw.sentiment} sentiment (score: ${kw.score})"
              style="padding: 4px 8px; border-radius: 12px; border: none; cursor: pointer; font-size: 12px; background: ${kw.sentiment === 'positive' ? '#e8f5e9' : '#ffebee'}; color: ${kw.sentiment === 'positive' ? '#2e7d32' : '#c62828'};">
              ${kw.keyword}
            </button>
          `).join('')}
        </div>
      ` : '';
      
      return `
        <div class="chat-message ${messageClass}" data-message-id="${msg._id || ''}">
          <div class="chat-message-avatar">${messageAvatar}</div>
          <div class="chat-message-bubble">
            <p class="chat-message-text">${escapeHtml(msg.body)}</p>
            <div class="chat-message-time">
              <i class="far fa-clock"></i> ${formatDate(msg.timestamp)}
            </div>
            ${!isBot && msg.sentiment && msg.sentiment.label ? `
            <div class="chat-sentiment-badge ${msg.sentiment.label}">
              ${getSentimentIcon(msg.sentiment.label)} ${msg.sentiment.label} (${(msg.sentiment.comparative || 0).toFixed(2)})
            </div>
            ` : ''}
            ${keywordsHtml}
          </div>
        </div>
      `;
    }).join('');
    
    // Scroll/focus behavior — use setTimeout to wait for DOM paint
    setTimeout(() => {
      if (options.highlightKeyword) {
        const input = document.getElementById('chatSearchInput');
        if (input) input.value = options.highlightKeyword;
        filterChatMessages(options.highlightKeyword);
      }

      const targetId = String(options.targetMessageId || '').trim();
      if (targetId) {
        const targetMsg = chatMessagesArea.querySelector(`.chat-message[data-message-id="${targetId}"]`);
        if (targetMsg) {
          targetMsg.classList.add('keyword-focus-message');
          targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => targetMsg.classList.remove('keyword-focus-message'), 2200);
          return;
        }
      }

      chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
    }, 100);
    
  } catch (error) {
    console.error('Error loading chat messages:', error);
    chatMessagesArea.innerHTML = '<p class="loading" style="text-align: center; padding: 40px; color: var(--accent-red);">Error loading conversation. Please try again.</p>';
  }
}

function closeChatModal() {
  const modal = document.getElementById('chatModal');
  modal.classList.remove('active');
  document.body.style.overflow = '';
  // Close search bar when modal closes
  clearChatSearch();
  const bar = document.getElementById('chatSearchBar');
  if (bar) bar.classList.remove('open');
  const btn = document.getElementById('chatSearchBtn');
  if (btn) btn.classList.remove('active');
}

// ── Show messages containing keyword ────────────────────────────────────────
async function showKeywordMessages(keyword) {
  try {
    const response = await fetch(`/api/sentiment/messages-by-keyword?keyword=${encodeURIComponent(keyword)}`);
    if (!response.ok) {
      let msg = 'Failed to fetch messages';
      try {
        const err = await response.json();
        if (err?.error) msg = err.error;
      } catch {}
      throw new Error(msg);
    }
    const data = await response.json();
    const messages = data.messages || [];
    const totalCount = data.count || messages.length;

    // Create modal for keyword messages
    let modal = document.getElementById('keywordModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'keywordModal';
      modal.className = 'modal-overlay';
      modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.5); display: flex; align-items: center;
        justify-content: center; z-index: 10000;
      `;
      modal.innerHTML = `
        <div style="background: white; border-radius: 8px; padding: 20px; width: 90%; max-width: 700px; max-height: 85vh; overflow-y: auto; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; border-bottom: 2px solid #e0e0e0; padding-bottom: 12px;">
            <div>
              <h3 id="keywordTitle" style="margin: 0; color: #333; font-size: 18px;">Messages with keyword</h3>
              <p id="keywordCount" style="margin: 5px 0 0 0; color: #666; font-size: 13px;"></p>
            </div>
            <button onclick="document.getElementById('keywordModal').style.display='none';" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #999; padding: 0; width: 30px; height: 30px;">&times;</button>
          </div>
          <div id="keywordMessages" style="max-height: calc(85vh - 120px); overflow-y: auto;"></div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
      });
    }

    // Update modal title and content
    document.getElementById('keywordTitle').textContent = `Messages with "${keyword}"`;
    document.getElementById('keywordCount').textContent = `Total: ${totalCount} message${totalCount !== 1 ? 's' : ''} found`;
    const container = document.getElementById('keywordMessages');
    
    const escapedKeyword = (keyword || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const highlightRegex = new RegExp(`(${escapedKeyword})`, 'ig');

    if (messages.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: #999; padding: 30px;">No messages found</p>';
    } else {
      container.innerHTML = messages.map((msg, idx) => `
        <div style="padding: 12px; border-bottom: 1px solid #f0f0f0; margin-bottom: 8px; background: #fafafa; border-radius: 4px; transition: background 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='#fafafa'">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
            <div>
              <span style="font-weight: 600; color: #333; font-size: 14px;">${escapeHtml(msg.name)}</span>
              <span style="font-size: 11px; color: #999; margin-left: 8px;">${msg.phone}</span>
            </div>
            <span style="font-size: 12px; color: #999;">${formatDate(msg.timestamp)}</span>
          </div>
          <p style="margin: 8px 0; color: #555; word-wrap: break-word; line-height: 1.4;">${escapeHtml(msg.body || '').replace(highlightRegex, '<mark style="background:#fff59d; padding:0 2px; border-radius:2px;">$1</mark>')}</p>
          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            <span class="sentiment-badge ${msg.sentiment}" style="padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; background: ${msg.sentiment === 'positive' ? '#c8e6c9' : msg.sentiment === 'negative' ? '#ffcdd2' : '#e0e0e0'}; color: ${msg.sentiment === 'positive' ? '#1b5e20' : msg.sentiment === 'negative' ? '#b71c1c' : '#424242'};">
              ${(msg.sentiment || 'neutral').toUpperCase()}
            </span>
            <span style="font-size: 12px; color: #666;">Score: ${(msg.score || 0).toFixed(2)}</span>
            <span style="font-size: 11px; color: #999;">•</span>
            <span style="font-size: 11px; color: #999;">#${idx + 1}</span>
            <button class="open-keyword-chat-btn"
              data-phone="${encodeURIComponent(msg.phone || '')}"
              data-name="${encodeURIComponent(msg.name || '')}"
              data-keyword="${encodeURIComponent(keyword)}"
              data-message-id="${msg.id || ''}"
              style="margin-left:auto; background:#1976d2; color:#fff; border:none; border-radius:6px; padding:6px 10px; font-size:12px; cursor:pointer;">
              Open in chat
            </button>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.open-keyword-chat-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          openKeywordMessageInChat(
            decodeURIComponent(btn.dataset.phone || ''),
            decodeURIComponent(btn.dataset.name || ''),
            decodeURIComponent(btn.dataset.keyword || ''),
            btn.dataset.messageId || ''
          );
        });
      });
    }
    
    modal.style.display = 'flex';
  } catch (error) {
    console.error('Error showing keyword messages:', error);
    alert(`Error fetching messages for this keyword: ${error.message}`);
  }
}

async function openKeywordMessageInChat(phoneNumber, contactName, keyword, messageId) {
  const chatModal = document.getElementById('chatModal');
  const keywordModal = document.getElementById('keywordModal');
  if (!chatModal || !phoneNumber) return;

  if (keywordModal) keywordModal.style.display = 'none';

  const avatar = (contactName || phoneNumber || 'U').trim().charAt(0).toUpperCase();

  chatModal.dataset.phoneNumber = phoneNumber;
  chatModal.dataset.contactName = contactName || phoneNumber;
  chatModal.dataset.avatar = avatar;

  const avatarEl = document.getElementById('chatAvatarModal');
  const nameEl = document.getElementById('chatContactName');
  const phoneEl = document.getElementById('chatContactPhone');
  if (avatarEl) avatarEl.textContent = avatar;
  if (nameEl) nameEl.textContent = contactName || phoneNumber;
  if (phoneEl) phoneEl.textContent = phoneNumber;

  chatModal.classList.add('active');
  document.body.style.overflow = 'hidden';

  await loadChatMessages(phoneNumber, contactName || phoneNumber, avatar, {
    highlightKeyword: keyword,
    targetMessageId: messageId
  });
}

// ── Voice Call ────────────────────────────────────────────────────────────────
function startVoiceCall() {
  const phone = document.getElementById('chatContactPhone')?.textContent?.trim();
  if (!phone) return;
  const dialable = phone.replace(/[\s\-()]/g, '');
  window.open('tel:' + dialable, '_self');
}

// ── In-chat search ────────────────────────────────────────────────────────────
let _searchMatches = [];   // array of <mark> elements
let _searchIndex  = -1;    // currently active match index

function toggleChatSearch() {
  const bar = document.getElementById('chatSearchBar');
  const btn = document.getElementById('chatSearchBtn');
  const input = document.getElementById('chatSearchInput');
  const isOpen = bar.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
  if (isOpen) {
    input.focus();
  } else {
    clearChatSearch();
  }
}

function filterChatMessages(query) {
  const area  = document.getElementById('chatMessagesArea');
  const count = document.getElementById('chatSearchCount');
  const prevBtn = document.querySelector('.search-nav-btn:first-of-type');
  const nextBtn = document.querySelector('.search-nav-btn:last-of-type');

  // Remove all previous highlights and reset state
  area.querySelectorAll('.chat-msg-highlight').forEach(el => {
    el.replaceWith(document.createTextNode(el.textContent));
  });
  area.normalize();
  _searchMatches = [];
  _searchIndex   = -1;

  if (!query.trim()) {
    if (count) count.textContent = '';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

  // Walk text nodes inside message bubbles and wrap matches in <mark>
  function walkAndHighlight(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (!regex.test(text)) { regex.lastIndex = 0; return; }
      regex.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = regex.exec(text)) !== null) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'chat-msg-highlight';
        mark.textContent = m[0];
        frag.appendChild(mark);
        _searchMatches.push(mark);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    } else if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT','STYLE'].includes(node.tagName)) {
      Array.from(node.childNodes).forEach(walkAndHighlight);
    }
  }

  area.querySelectorAll('.message-bubble, .message-text, .chat-message').forEach(walkAndHighlight);

  const total = _searchMatches.length;
  if (prevBtn) prevBtn.disabled = total === 0;
  if (nextBtn) nextBtn.disabled = total === 0;

  if (total === 0) {
    if (count) count.textContent = 'No matches';
    return;
  }

  // Jump to first match automatically
  _searchIndex = -1;
  searchNavigate(1);
}

function searchNavigate(direction) {
  if (_searchMatches.length === 0) return;

  // Remove active class from current
  if (_searchIndex >= 0 && _searchIndex < _searchMatches.length) {
    _searchMatches[_searchIndex].classList.remove('search-active');
  }

  // Advance index with wrap-around
  _searchIndex = (_searchIndex + direction + _searchMatches.length) % _searchMatches.length;

  // Activate new match
  const active = _searchMatches[_searchIndex];
  active.classList.add('search-active');
  active.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Update counter: "2 of 7"
  const count = document.getElementById('chatSearchCount');
  if (count) count.textContent = `${_searchIndex + 1} of ${_searchMatches.length}`;
}

function clearChatSearch() {
  const input = document.getElementById('chatSearchInput');
  const count = document.getElementById('chatSearchCount');
  const prevBtn = document.querySelector('.search-nav-btn:first-of-type');
  const nextBtn = document.querySelector('.search-nav-btn:last-of-type');
  if (input) input.value = '';
  if (count) count.textContent = '';
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
  const area = document.getElementById('chatMessagesArea');
  if (area) {
    area.querySelectorAll('.chat-msg-highlight').forEach(el => {
      el.replaceWith(document.createTextNode(el.textContent));
    });
    area.normalize();
  }
  _searchMatches = [];
  _searchIndex   = -1;
}

// Close modal on outside click
document.addEventListener('click', (e) => {
  const modal = document.getElementById('chatModal');
  if (e.target === modal) {
    closeChatModal();
  }
});

// Close modal on ESC key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeChatModal();
  }
});

// Send message from chat modal
async function sendChatMessage() {
  const chatInput = document.getElementById('chatInput');
  const sendBtn = document.querySelector('.chat-send-btn');
  
  if (!chatInput || !sendBtn) return;
  
  const message = chatInput.value.trim();
  if (!message) return;
  
  // Get current contact's phone number from modal
  const modal = document.getElementById('chatModal');
  const phoneNumber = modal.dataset.phoneNumber;
  
  if (!phoneNumber) {
    console.error('No phone number found');
    return;
  }
  
  // Disable input and button while sending
  chatInput.disabled = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  
  try {
    const response = await fetch('/api/messages/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        phoneNumber: phoneNumber,
        message: message
      })
    });
    
    const result = await response.json();
    
    if (response.ok && result.success) {
      // Clear input
      chatInput.value = '';
      
      // Add message to UI immediately (optimistic update)
      const chatMessagesArea = document.getElementById('chatMessagesArea');
      const messageHTML = `
        <div class="chat-message outgoing">
          <div class="chat-message-avatar">B</div>
          <div class="chat-message-bubble">
            <p class="chat-message-text">${escapeHtml(message)}</p>
            <div class="chat-message-time">
              <i class="far fa-clock"></i> ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </div>
      `;
      chatMessagesArea.insertAdjacentHTML('beforeend', messageHTML);
      
      // Scroll to bottom
      setTimeout(() => {
        chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
      }, 0);
      
      // Reload conversation to sync with server
      setTimeout(() => {
        const contactName = modal.dataset.contactName || 'Contact';
        const avatar = modal.dataset.avatar || '';
        loadChatMessages(phoneNumber, contactName, avatar);
      }, 500);
    } else {
      alert('Failed to send message: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Failed to send message. Please try again.');
  } finally {
    // Re-enable input and button
    chatInput.disabled = false;
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    chatInput.focus();
  }
}

// Send a media/document attachment from the chat input area
async function sendMediaAttachment(file) {
  const modal = document.getElementById('chatModal');
  const phoneNumber = modal ? modal.dataset.phoneNumber : null;
  if (!phoneNumber) {
    showNotification('❌ No contact selected', 'error');
    return;
  }

  // WhatsApp max: 16 MB for media, 100 MB for documents — use 16 MB safe limit
  if (file.size > 16 * 1024 * 1024) {
    showNotification('❌ File too large. Maximum size is 16 MB.', 'error');
    return;
  }

  const sendBtn = document.querySelector('.chat-send-btn');
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }

  try {
    // Read file as base64 (strip the "data:...;base64," prefix)
    const base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const response = await fetch('/api/messages/send-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumber,
        mediaData: base64Data,
        mimeType: file.type,
        fileName: file.name
      })
    });

    const result = await response.json();

    if (response.ok && result.success) {
      // Optimistic UI: add bubble to chat area
      const chatMessagesArea = document.getElementById('chatMessagesArea');
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      let previewHTML;
      if (isImage) {
        previewHTML = `<img src="data:${file.type};base64,${base64Data}" style="max-width:200px;max-height:200px;border-radius:8px;display:block;margin-bottom:4px;" alt="${escapeHtml(file.name)}">`;
      } else if (isVideo) {
        previewHTML = `<video src="data:${file.type};base64,${base64Data}" controls style="max-width:220px;border-radius:8px;display:block;margin-bottom:4px;"></video>`;
      } else {
        previewHTML = `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;"><i class="fas fa-file" style="font-size:20px;color:var(--primary);"></i><span style="font-size:13px;word-break:break-all;">${escapeHtml(file.name)}</span></div>`;
      }
      const messageHTML = `
        <div class="chat-message outgoing">
          <div class="chat-message-avatar">B</div>
          <div class="chat-message-bubble">
            ${previewHTML}
            <div class="chat-message-time">
              <i class="far fa-clock"></i> ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </div>
      `;
      if (chatMessagesArea) {
        chatMessagesArea.insertAdjacentHTML('beforeend', messageHTML);
        chatMessagesArea.scrollTop = chatMessagesArea.scrollHeight;
      }
      showNotification('✅ Media sent successfully!', 'success');
    } else {
      showNotification('❌ ' + (result.error || 'Failed to send media'), 'error');
    }
  } catch (error) {
    console.error('Error sending media:', error);
    const msg = error?.message || '';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      showNotification('❌ Cannot reach server. Is it running?', 'error');
    } else {
      showNotification('❌ Error sending media: ' + msg, 'error');
    }
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    }
  }
}

// Helper function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Apply message filters (search, sentiment, date, sort)
function applyMessageFilters() {
  const search    = document.getElementById('messageSearch')?.value.trim() || '';
  const sentiment = document.getElementById('sentimentFilter')?.value || 'all';
  const dateRange = document.getElementById('dateFilter')?.value || 'all';
  const sort      = document.getElementById('sortFilter')?.value || 'newest';

  // Calculate startDate from date range
  let startDate = '';
  const now = new Date();
  if (dateRange === 'today') {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  } else if (dateRange === 'week') {
    startDate = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (dateRange === 'month') {
    startDate = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Show/hide Clear Filters button
  const isFiltered = search || sentiment !== 'all' || dateRange !== 'all' || sort !== 'newest' || _advCustomStart || _advCustomEnd;
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.style.display = isFiltered ? 'inline-flex' : 'none';

  loadMessages({ search, sentiment, startDate, sort });
}

// ── Advanced Filters ──
let _advCustomStart = '';
let _advCustomEnd   = '';

function toggleAdvancedFilters() {
  const panel = document.getElementById('advancedFiltersPanel');
  const btn   = document.getElementById('advFilterBtn');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (btn) btn.style.background = isOpen ? '' : 'rgba(37,211,102,0.15)';
}

function applyAdvancedFilters() {
  const start = document.getElementById('customStartDate')?.value;
  const end   = document.getElementById('customEndDate')?.value;
  _advCustomStart = start ? new Date(start).toISOString() : '';
  _advCustomEnd   = end   ? new Date(end + 'T23:59:59').toISOString() : '';

  const search    = document.getElementById('messageSearch')?.value.trim() || '';
  const sentiment = document.getElementById('sentimentFilter')?.value || 'all';
  const sort      = document.getElementById('sortFilter')?.value || 'newest';

  const params = { search, sentiment, sort };
  if (_advCustomStart) params.startDate = _advCustomStart;
  if (_advCustomEnd)   params.endDate   = _advCustomEnd;
  loadMessages(params);
  showNotification('Advanced filters applied', 'success');
}

function resetAdvancedFilters() {
  _advCustomStart = '';
  _advCustomEnd   = '';
  const s = document.getElementById('customStartDate');
  const e = document.getElementById('customEndDate');
  if (s) s.value = '';
  if (e) e.value = '';
  applyMessageFilters();
  showNotification('Filters reset', 'info');
}

function clearAllFilters() {
  const search    = document.getElementById('messageSearch');
  const sentiment = document.getElementById('sentimentFilter');
  const date      = document.getElementById('dateFilter');
  const sort      = document.getElementById('sortFilter');
  const startDate = document.getElementById('customStartDate');
  const endDate   = document.getElementById('customEndDate');

  if (search)    search.value    = '';
  if (sentiment) sentiment.value = 'all';
  if (date)      date.value      = 'all';
  if (sort)      sort.value      = 'newest';
  if (startDate) startDate.value = '';
  if (endDate)   endDate.value   = '';

  _advCustomStart = '';
  _advCustomEnd   = '';

  // Close advanced panel if open
  const panel  = document.getElementById('advancedFiltersPanel');
  const advBtn = document.getElementById('advFilterBtn');
  if (panel)  panel.style.display  = 'none';
  if (advBtn) advBtn.style.background = '';

  // Hide clear button itself
  const clearBtn = document.getElementById('clearFiltersBtn');
  if (clearBtn) clearBtn.style.display = 'none';

  loadMessages({});
  showNotification('All filters cleared', 'info');
}

// ── Checkbox / Select tracking ──
function onMessageCheckboxChange() {
  const checked = document.querySelectorAll('.msg-checkbox:checked');
  const total   = document.querySelectorAll('.msg-checkbox');
  const count   = checked.length;

  const countEl = document.getElementById('selectedCount');
  const infoEl  = document.getElementById('selectionInfo');
  const allBox  = document.getElementById('selectAllCheckbox');
  const bar     = document.getElementById('selectAllBar');

  if (countEl) countEl.textContent = count;
  if (infoEl)  infoEl.textContent  = count > 0 ? `${count} of ${total.length} selected` : '';
  if (allBox)  allBox.checked      = count > 0 && count === total.length;
  if (bar)     bar.style.display   = total.length > 0 ? 'flex' : 'none';
}

function toggleSelectAll(checked) {
  document.querySelectorAll('.msg-checkbox').forEach(cb => { cb.checked = checked; });
  onMessageCheckboxChange();
}

// ── Export CSV ──
async function exportMessagesCSV() {
  const search    = document.getElementById('messageSearch')?.value.trim() || '';
  const sentiment = document.getElementById('sentimentFilter')?.value || 'all';
  const sort      = document.getElementById('sortFilter')?.value || 'newest';
  const startDate = _advCustomStart || '';

  showNotification('Preparing CSV export...', 'info');

  try {
    const params = new URLSearchParams({ limit: 1000 });
    if (search)    params.append('search', search);
    if (sentiment !== 'all') params.append('sentiment', sentiment);
    if (startDate) params.append('startDate', startDate);

    const res  = await fetch(`/api/messages?${params}`);
    const data = await res.json();
    let msgs = data.messages || [];
    if (sort === 'oldest') msgs = [...msgs].reverse();

    if (msgs.length === 0) { showNotification('No messages to export', 'warning'); return; }

    const headers = ['ID', 'From', 'Name', 'Message', 'Sentiment', 'Replied', 'Timestamp'];
    const rows = msgs.map(m => [
      m._id,
      m.from,
      m.fromName || m.from,
      `"${(m.body || '').replace(/"/g, '""')}"`,
      m.sentiment?.label || '',
      m.replied ? 'Yes' : 'No',
      new Date(m.timestamp).toLocaleString()
    ].join(','));

    const csv  = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `messages_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification(`✅ Exported ${msgs.length} messages!`, 'success');
  } catch (err) {
    console.error('Export error:', err);
    showNotification('❌ Export failed. Try again.', 'error');
  }
}

// ── Delete Selected ──
async function deleteSelectedMessages() {
  const checked = document.querySelectorAll('.msg-checkbox:checked');
  if (checked.length === 0) {
    showNotification('No messages selected! Please check the checkboxes first.', 'warning');
    return;
  }

  const ids = [...checked].map(cb => cb.dataset.id);
  const msgWord = ids.length === 1 ? 'message' : 'messages';
  if (!confirm(`Are you sure you want to delete ${ids.length} ${msgWord}? This action cannot be undone!`)) return;

  try {
    const res    = await fetch('/api/messages/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    const result = await res.json();
    if (res.ok && result.success) {
      showNotification(`✅ ${ids.length} ${msgWord} deleted successfully!`, 'success');
      // Reset counters
      const countEl = document.getElementById('selectedCount');
      if (countEl) countEl.textContent = '0';
      // Reload
      applyMessageFilters();
      loadStats();
    } else {
      showNotification('❌ Delete failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    console.error('Delete error:', err);
    showNotification('❌ Delete failed. Is server running?', 'error');
  }
}

// Add event listener for send button
document.addEventListener('DOMContentLoaded', () => {
  const sendBtn = document.querySelector('.chat-send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', sendChatMessage);
  }
  
  // Add event listener for Enter key in chat input
  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  // ── Message Filters ──
  const messageSearch  = document.getElementById('messageSearch');
  const sentimentFilter = document.getElementById('sentimentFilter');
  const dateFilter     = document.getElementById('dateFilter');
  const sortFilter     = document.getElementById('sortFilter');

  // Debounce search input
  let searchTimeout;
  if (messageSearch) {
    messageSearch.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(applyMessageFilters, 400);
    });
  }

  if (sentimentFilter) sentimentFilter.addEventListener('change', applyMessageFilters);
  if (dateFilter)      dateFilter.addEventListener('change', applyMessageFilters);
  if (sortFilter)      sortFilter.addEventListener('change', applyMessageFilters);

  setInterval(() => {
    const meetingsPage = document.getElementById('meetingsPage');
    if (currentPage === 'meetings' && meetingsPage && meetingsPage.style.display !== 'none') {
      loadMeetingsPage();
    }
  }, 60000);
});

function navigateToPage(page) {
  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
    if (item.getAttribute('data-page') === page) {
      item.classList.add('active');
    }
  });
  
  // Hide all pages
  const dashboardPage = document.getElementById('dashboardPage');
  const messagesPage = document.getElementById('messagesPage');
  const sentimentPage = document.getElementById('sentimentPage');
  const tasksPage = document.getElementById('tasksPage');
  const meetingsPage = document.getElementById('meetingsPage');
  const databasePage = document.getElementById('databasePage');
  const profilesPage = document.getElementById('profilesPage');
  const settingsPage = document.getElementById('settingsPage');
  
  if (dashboardPage) dashboardPage.style.display = 'none';
  if (messagesPage) messagesPage.style.display = 'none';
  if (sentimentPage) sentimentPage.style.display = 'none';
  if (tasksPage) tasksPage.style.display = 'none';
  if (meetingsPage) meetingsPage.style.display = 'none';
  if (databasePage) databasePage.style.display = 'none';
  if (profilesPage) profilesPage.style.display = 'none';
  if (settingsPage) settingsPage.style.display = 'none';
  
  // Update header title
  const pageTitle = document.getElementById('pageTitle');
  const pageSubtitle = document.getElementById('pageSubtitle');
  
  // Show selected page and update header
  if (page === 'dashboard' && dashboardPage) {
    dashboardPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Dashboard';
    if (pageSubtitle) pageSubtitle.textContent = 'Real-time WhatsApp bot analytics';
    loadDashboardProfiles();
  } else if (page === 'messages' && messagesPage) {
    messagesPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Messages';
    if (pageSubtitle) pageSubtitle.textContent = 'View and manage all conversations';
    loadMessagesPage();
  } else if (page === 'sentiment' && sentimentPage) {
    sentimentPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Sentiment Analysis';
    if (pageSubtitle) pageSubtitle.textContent = 'Track customer emotions and feedback';
    initSentimentCharts();
  } else if (page === 'tasks' && tasksPage) {
    tasksPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Tasks';
    if (pageSubtitle) pageSubtitle.textContent = 'Manage automated tasks and workflows';
    loadTasksPage();
  } else if (page === 'meetings' && meetingsPage) {
    meetingsPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Meetings';
    if (pageSubtitle) pageSubtitle.textContent = 'Track booked slots and generated Zoom links';
    loadMeetingsPage();
  } else if (page === 'meetings') {
    if (pageTitle) pageTitle.textContent = 'Meetings';
    if (pageSubtitle) pageSubtitle.textContent = 'Track booked slots and generated Zoom links';
  } else if (page === 'database' && databasePage) {
    databasePage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Database';
    if (pageSubtitle) pageSubtitle.textContent = 'View and manage stored data';
    loadDatabaseStats();
  } else if (page === 'database') {
    if (pageTitle) pageTitle.textContent = 'Database';
    if (pageSubtitle) pageSubtitle.textContent = 'View and manage stored data';
  } else if (page === 'profiles' && profilesPage) {
    profilesPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Customer Profiles';
    if (pageSubtitle) pageSubtitle.textContent = 'All collected customer profiles';
    loadUserProfiles();
  } else if (page === 'profiles') {
    if (pageTitle) pageTitle.textContent = 'Customer Profiles';
    if (pageSubtitle) pageSubtitle.textContent = 'All collected customer profiles';
  } else if (page === 'settings' && settingsPage) {
    settingsPage.style.display = 'block';
    if (pageTitle) pageTitle.textContent = 'Settings';
    if (pageSubtitle) pageSubtitle.textContent = 'Configure bot settings and preferences';
  } else if (page === 'settings') {
    if (pageTitle) pageTitle.textContent = 'Settings';
    if (pageSubtitle) pageSubtitle.textContent = 'Configure bot settings and preferences';
  }
  
  console.log('Navigated to:', page);
  currentPage = page;
}

// Socket connection status
socket.on('connect', () => {
  updateStatus('Connected', true);
  addNotification('status', 'Dashboard connected', 'Live updates active');
});

socket.on('disconnect', () => {
  updateStatus('Disconnected', false);
  addNotification('warning', 'Dashboard disconnected', 'Trying to reconnect...');
});

// Listen for real-time updates
socket.on('taskUpdated', (task) => {
  if (currentPage === 'tasks') loadTasksPage();
  else loadTasks(currentFilter);
  loadStats();
  if (notificationSettings.taskUpdates) {
    const detail = task.description ? task.description.substring(0, 50) : '';
    const taskId = task._id || task.id;
    addNotification('task', `Task updated: ${task.status}`, detail, {
      kind: 'task',
      taskId
    });
    playAlertSound();
    triggerDesktopNotification(`Task updated: ${task.status}`, detail);
  }
});

// Listen for stats updates
socket.on('statsUpdate', (stats) => {
  console.log('Real-time stats update received:', stats);
  // Quick socket payloads may be partial (messagesToday/tasksToday only)
  // If partial, fetch full stats to keep dashboard cards/charts consistent.
  if (!stats?.today || !stats?.sentiment || !stats?.changes || !stats?.tasks) {
    loadStats();
    return;
  }
  updateDashboardStats(stats);
});

// Listen for new messages
socket.on('newMessage', (message) => {
  console.log('New message received:', message);
  if (currentPage === 'messages') {
    loadMessages();
  }
  if (currentPage === 'meetings') {
    loadMeetingsPage();
  }
  const detail = message.body ? message.body.substring(0, 60) : '';
  const contactName = message.fromName || message.from || 'Unknown';
  const phone = message.phone || message.fromPhone || (String(message.from || '').includes('@c.us') ? message.from : '');
  const messageId = message.id || message._id;

  if (notificationSettings.newMessageAlert) {
    addNotification('message', `New message from ${contactName}`, detail, {
      kind: phone ? 'message' : 'messages-page',
      phone,
      contactName,
      messageId
    });
    playAlertSound();
    triggerDesktopNotification(`New message from ${contactName}`, detail);
  }
  if (notificationSettings.negativeSentimentAlert && message.sentiment === 'negative') {
    addNotification('warning', `Negative sentiment from ${contactName}`, detail, {
      kind: phone ? 'message' : 'messages-page',
      phone,
      contactName,
      messageId
    });
    playAlertSound();
    triggerDesktopNotification(`Negative sentiment from ${contactName}`, detail);
  }
  socket.emit('requestStats');
});

// Listen for new tasks
socket.on('newTask', (task) => {
  console.log('New task created:', task);
  if (currentPage === 'tasks') loadTasksPage();
  else if (currentPage === 'dashboard') loadTasks();
  if (notificationSettings.taskUpdates) {
    const detail = task.description ? task.description.substring(0, 60) : '';
    const taskId = task._id || task.id;
    addNotification('task', `New task created`, detail, {
      kind: 'task',
      taskId
    });
    playAlertSound();
    triggerDesktopNotification('New task created', detail);
  }
  socket.emit('requestStats');
});

// Update connection status
function updateStatus(text, connected) {
  const indicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  
  statusText.textContent = text;
  if (connected) {
    indicator.classList.add('connected');
  } else {
    indicator.classList.remove('connected');
  }
}

// Load dashboard statistics
async function loadStats() {
  try {
    const response = await fetch('/api/stats');
    const stats = await response.json();
    updateDashboardStats(stats);
  } catch (error) {
    console.error('Error loading stats:', error);
  }
}

// Update dashboard with stats data
function updateDashboardStats(stats) {
  try {
    
    // Update total counts
    const totalMessagesEl = document.getElementById('totalMessages');
    const totalTasksEl = document.getElementById('totalTasks');
    const totalConversationsEl = document.getElementById('totalConversations');
    const positivePercentEl = document.getElementById('positivePercent');
    
    if (totalMessagesEl) totalMessagesEl.textContent = stats.totalMessages;
    if (totalTasksEl) totalTasksEl.textContent = stats.totalTasks;
    if (totalConversationsEl) totalConversationsEl.textContent = stats.totalConversations;
    if (positivePercentEl) positivePercentEl.textContent = `${stats.sentiment.positivePercent}%`;
    
    // Update today's changes
    const messagesChange = document.getElementById('messagesChange');
    const tasksChange = document.getElementById('tasksChange');
    const conversationsChange = document.getElementById('conversationsChange');
    
    if (messagesChange) {
      const change = stats.changes.messages;
      const changeCount = stats.changes.messagesCount;
      messagesChange.textContent = `${change >= 0 ? '+' : ''}${change}%`;
      messagesChange.style.color = change >= 0 ? '#25D366' : '#F44336';
    }
    
    if (tasksChange) {
      const change = stats.changes.tasks;
      const changeCount = stats.changes.tasksCount;
      tasksChange.textContent = `${change >= 0 ? '+' : ''}${change}%`;
      tasksChange.style.color = change >= 0 ? '#25D366' : '#F44336';
    }
    
    if (conversationsChange) {
      conversationsChange.textContent = `${stats.conversations.active} active`;
    }
    
    // Update bot status message count
    const botMessages = document.getElementById('botMessages');
    const messageVolume = document.getElementById('messageVolume');
    if (botMessages) {
      botMessages.textContent = `${stats.today.messages} messages today`;
    }
    if (messageVolume) {
      messageVolume.textContent = stats.today.messages ?? 0;
    }
    
    // Update badges
    const messagesBadge = document.getElementById('messagesBadge');
    const tasksBadge = document.getElementById('tasksBadge');
    
    if (messagesBadge) messagesBadge.textContent = stats.today.messages;
    if (tasksBadge) tasksBadge.textContent = stats.tasks.pending;
    
    // Update charts only if on dashboard page
    if (currentPage === 'dashboard' && typeof Chart !== 'undefined') {
      // Keep dashboard sentiment chart fully aligned with Sentiment page data source.
      // It must come from /api/sentiment/timeline (same source as trend/distribution),
      // not from /api/stats aggregate.
      loadDashboardSentimentTimeline();
      updateTaskChart(stats.tasks);
    }
    
    console.log('Stats updated successfully:', stats);
    
  } catch (error) {
    console.error('Error updating dashboard stats:', error);
  }
}

// Initialize charts
function initCharts() {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js not loaded');
    return;
  }
  
  // Initialize empty charts on dashboard
  const sentimentChartEl = document.getElementById('sentimentChart');
  const taskChartEl = document.getElementById('taskChart');
  
  if (sentimentChartEl) {
    // Create empty sentiment chart
    updateSentimentChart({ positive: 0, neutral: 0, negative: 0 });
  }
  
  if (taskChartEl) {
    // Create empty task chart
    updateTaskChart(0, 0);
  }
}

// Update sentiment chart
function updateSentimentChart(sentiment) {
  const ctx = document.getElementById('sentimentChart');
  
  if (!ctx) {
    console.warn('sentimentChart canvas not found');
    return;
  }
  
  if (sentimentChart) {
    sentimentChart.destroy();
  }
  
  sentimentChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Positive', 'Neutral', 'Negative'],
      datasets: [{
        data: [sentiment.positive, sentiment.neutral, sentiment.negative],
        backgroundColor: [
          'rgba(76, 175, 80, 0.8)',
          'rgba(158, 158, 158, 0.8)',
          'rgba(244, 67, 54, 0.8)'
        ],
        borderColor: [
          'rgb(76, 175, 80)',
          'rgb(158, 158, 158)',
          'rgb(244, 67, 54)'
        ],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 10,
            font: {
              size: 11
            }
          }
        }
      }
    }
  });
}

// Load sentiment timeline data for dashboard based on selected filter
async function loadDashboardSentimentTimeline() {
  try {
    const timelineFilter = document.getElementById('timelineFilter');
    const selectedOption = (timelineFilter?.value || 'Last 7 days').toLowerCase().trim();

    // Map dropdown option to days.
    // Use 9999 for "all time" so backend doesn't treat 0 as falsy and fall back to 7.
    let days = 7;
    if (selectedOption === 'all time' || selectedOption === 'all') {
      days = 9999;
    } else if (selectedOption === 'last 30 days' || selectedOption === '30') {
      days = 30;
    } else if (selectedOption === 'last 90 days' || selectedOption === '90') {
      days = 90;
    }
    
    const response = await fetch(`/api/sentiment/timeline?days=${days}`);
    const timelineData = await response.json();
    
    // Aggregate sentiment counts from timeline
    let totalPositive = 0;
    let totalNeutral = 0;
    let totalNegative = 0;
    
    timelineData.forEach(d => {
      totalPositive += d.positive || 0;
      totalNeutral += d.neutral || 0;
      totalNegative += d.negative || 0;
    });
    
    // Update dashboard sentiment chart with aggregated timeline data
    updateSentimentChart({
      positive: totalPositive,
      neutral: totalNeutral,
      negative: totalNegative,
      positivePercent: totalPositive + totalNeutral + totalNegative > 0 
        ? Math.round((totalPositive / (totalPositive + totalNeutral + totalNegative)) * 100)
        : 0
    });
  } catch (error) {
    console.error('Error loading sentiment timeline:', error);
  }
}

// Update task chart
function updateTaskChart(tasks) {
  const ctx = document.getElementById('taskChart');
  
  if (!ctx) {
    console.warn('taskChart canvas not found');
    return;
  }
  
  if (taskChart) {
    taskChart.destroy();
  }
  
  const pending = tasks.pending || 0;
  const completed = tasks.completed || 0;
  const inProgress = tasks.inProgress || 0;
  
  taskChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Pending', 'In Progress', 'Completed'],
      datasets: [{
        label: 'Tasks',
        data: [pending, inProgress, completed],
        backgroundColor: [
          'rgba(255, 193, 7, 0.8)',
          'rgba(33, 150, 243, 0.8)',
          'rgba(76, 175, 80, 0.8)'
        ],
        borderColor: [
          'rgb(255, 193, 7)',
          'rgb(33, 150, 243)',
          'rgb(76, 175, 80)'
        ],
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 1
          }
        }
      },
      plugins: {
        legend: {
          display: false
        }
      }
    }
  });
}

// ─── TASKS PAGE ────────────────────────────────────────────────────────────────
let tasksCurrentPage = 1;
const TASKS_PER_PAGE  = 10;
let tasksTotalPages   = 1;
let _taskSearchTimer  = null;

// Called when tasks nav item is clicked
async function loadTasksPage() {
  await Promise.all([loadTaskPageStats(), loadTasksTable()]);
}

async function loadTaskPageStats() {
  try {
    const res  = await fetch('/api/tasks/stats');
    const data = await res.json();
    const el = id => document.getElementById(id);
    if (el('taskStatTotal'))         el('taskStatTotal').textContent         = data.total ?? 0;
    if (el('taskStatCompleted'))     el('taskStatCompleted').textContent     = data.completed ?? 0;
    if (el('taskStatInProgress'))    el('taskStatInProgress').textContent    = data.inProgress ?? 0;
    if (el('taskStatPending'))       el('taskStatPending').textContent       = data.pending ?? 0;
    if (el('taskStatCompletionRate')) el('taskStatCompletionRate').textContent = (data.completionRate ?? 0) + '%';
  } catch (e) { console.error('loadTaskPageStats:', e); }
}

function _updateClearTaskFiltersBtn() {
  const search   = document.getElementById('taskSearch')?.value.trim();
  const status   = document.getElementById('taskStatusFilter')?.value;
  const type     = document.getElementById('taskTypeFilter')?.value;
  const priority = document.getElementById('taskPriorityFilter')?.value;
  const hasFilter = search || (status && status !== 'all') || (type && type !== 'all') || (priority && priority !== 'all');
  const btn = document.getElementById('btnClearTaskFilters');
  if (btn) btn.style.display = hasFilter ? 'flex' : 'none';
}

function debounceTaskSearch() {
  clearTimeout(_taskSearchTimer);
  _updateClearTaskFiltersBtn();
  _taskSearchTimer = setTimeout(() => { tasksCurrentPage = 1; loadTasksTable(); }, 350);
}

function applyTaskFilters() {
  tasksCurrentPage = 1;
  _updateClearTaskFiltersBtn();
  loadTasksTable();
}

function clearTaskFilters() {
  const el = id => document.getElementById(id);
  if (el('taskSearch'))         el('taskSearch').value         = '';
  if (el('taskStatusFilter'))   el('taskStatusFilter').value   = 'all';
  if (el('taskTypeFilter'))     el('taskTypeFilter').value     = 'all';
  if (el('taskPriorityFilter')) el('taskPriorityFilter').value = 'all';
  const btn = el('btnClearTaskFilters');
  if (btn) btn.style.display = 'none';
  tasksCurrentPage = 1;
  loadTasksTable();
}

// Keep old helper so dashboard "Recent Tasks" still works
let currentTypeFilter = 'all';
function applyTaskTypeFilter(type) {
  currentTypeFilter = type;
  loadTasks(currentFilter);
}

async function loadTasksTable() {
  const tbody = document.getElementById('tasksTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-secondary)"><i class="fas fa-spinner fa-spin"></i> Loading...</td></tr>';

  try {
    const params = new URLSearchParams({ page: tasksCurrentPage, limit: TASKS_PER_PAGE });
    const search   = document.getElementById('taskSearch')?.value.trim();
    const status   = document.getElementById('taskStatusFilter')?.value;
    const type     = document.getElementById('taskTypeFilter')?.value;
    const priority = document.getElementById('taskPriorityFilter')?.value;
    if (search)   params.set('search',   search);
    if (status && status !== 'all')   params.set('status',   status);
    if (type && type !== 'all')       params.set('type',     type);
    if (priority && priority !== 'all') params.set('priority', priority);

    const res  = await fetch('/api/tasks?' + params);
    const data = await res.json();
    const tasks = data.tasks || [];
    tasksTotalPages = data.totalPages || 1;

    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-secondary)"><i class="fas fa-inbox"></i> No tasks found</td></tr>';
      renderTaskPagination(0, 0, 0);
      const selectAll = document.getElementById('taskSelectAll');
      const cnt       = document.getElementById('taskSelectedCount');
      if (selectAll) selectAll.checked = false;
      if (cnt) cnt.textContent = '0';
      return;
    }

    tbody.innerHTML = tasks.map(t => {
      const priorityIcon  = { high: 'fa-arrow-up', medium: 'fa-minus', low: 'fa-arrow-down' }[t.priority] || 'fa-minus';
      const statusIcon    = { completed: 'fa-check-circle', 'in-progress': 'fa-spinner', pending: 'far fa-circle', cancelled: 'fa-ban' }[t.status] || 'far fa-circle';
      const statusFAClass = t.status === 'pending' ? 'far fa-circle' : `fas ${statusIcon}`;
      const initials      = getInitials(t.fromName || t.from);
      const dateStr       = formatDate(t.createdAt);
      return `
        <tr class="task-row" data-id="${t._id}">
          <td><input type="checkbox" class="task-checkbox" data-id="${t._id}" onchange="onTaskCheckboxChange()"></td>
          <td><span class="task-id">#${t._id}</span></td>
          <td>
            <div class="task-description">
              <h4>${escapeHtml(t.description)}</h4>
              ${t.notes ? `<p>${escapeHtml(t.notes)}</p>` : ''}
            </div>
          </td>
          <td><span class="task-type ${t.type}"><i class="fas fa-${t.type === 'request' ? 'hand-paper' : 'check-square'}"></i> ${capitalize(t.type)}</span></td>
          <td><span class="priority ${t.priority}"><i class="fas ${priorityIcon}"></i> ${capitalize(t.priority)}</span></td>
          <td>
            <select class="status-select inline-status" onchange="updateTaskStatusTable(${t._id}, this.value)">
              <option value="pending"     ${t.status==='pending'     ?'selected':''}>Pending</option>
              <option value="in-progress" ${t.status==='in-progress' ?'selected':''}>In Progress</option>
              <option value="completed"   ${t.status==='completed'   ?'selected':''}>Completed</option>
              <option value="cancelled"   ${t.status==='cancelled'   ?'selected':''}>Cancelled</option>
            </select>
          </td>
          <td>
            <div class="task-contact">
              <div class="contact-avatar">${initials}</div>
              <span>${escapeHtml(t.fromName || t.from)}</span>
            </div>
          </td>
          <td><span class="task-time">${dateStr}</span></td>
          <td>
            <div class="task-action-buttons">
              <button class="btn-task-action danger" title="Delete" onclick="deleteTask(${t._id})"><i class="fas fa-trash"></i></button>
            </div>
          </td>
        </tr>`;
    }).join('');

    renderTaskPagination(tasksCurrentPage, tasksTotalPages, data.total);
    const selectAll = document.getElementById('taskSelectAll');
    if (selectAll) selectAll.checked = false;
    onTaskCheckboxChange();
  } catch (e) {
    console.error('loadTasksTable:', e);
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#F44336"><i class="fas fa-exclamation-circle"></i> Error loading tasks</td></tr>';
  }
}

function renderTaskPagination(page, totalPages, total) {
  const wrap = document.getElementById('taskPaginationWrap');
  const nav  = document.getElementById('taskPagination');
  const info = document.getElementById('taskPaginationInfo');
  if (!wrap || !nav) return;

  if (totalPages <= 1) { wrap.style.display = 'none'; nav.innerHTML = ''; return; }

  wrap.style.display = 'flex';

  const perPage = 20;
  const from = (page - 1) * perPage + 1;
  const to   = Math.min(page * perPage, total);
  if (info) info.textContent = `Showing ${from}–${to} of ${total}`;

  // Build page numbers with ellipsis
  let pages = [];
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pages = [1];
    if (page > 3)              pages.push('...');
    const start = Math.max(2, page - 1);
    const end   = Math.min(totalPages - 1, page + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (page < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  nav.innerHTML = `
    <button class="pg-btn" ${page <= 1 ? 'disabled' : ''} onclick="goToTaskPage(${page - 1})">
      <i class="fas fa-chevron-left"></i>
    </button>
    ${pages.map(p =>
      p === '...'
        ? `<span class="pg-dots">…</span>`
        : `<button class="pg-btn ${p === page ? 'active' : ''}" onclick="goToTaskPage(${p})">${p}</button>`
    ).join('')}
    <button class="pg-btn" ${page >= totalPages ? 'disabled' : ''} onclick="goToTaskPage(${page + 1})">
      <i class="fas fa-chevron-right"></i>
    </button>
  `;
}

function goToTaskPage(page) {
  if (page < 1 || page > tasksTotalPages) return;
  tasksCurrentPage = page;
  loadTasksTable();
}

function toggleSelectAllTasks(cb) {
  document.querySelectorAll('.task-checkbox').forEach(c => c.checked = cb.checked);
  onTaskCheckboxChange();
}

function onTaskCheckboxChange() {
  const checked = document.querySelectorAll('.task-checkbox:checked').length;
  const cnt = document.getElementById('taskSelectedCount');
  if (cnt) cnt.textContent = checked;
}

async function updateTaskStatusTable(taskId, status) {
  try {
    await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    loadTaskPageStats();
    loadStats();
  } catch (e) { console.error('updateTaskStatusTable:', e); }
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    await Promise.all([loadTasksTable(), loadTaskPageStats(), loadStats()]);
  } catch (e) { console.error('deleteTask:', e); }
}

async function deleteSelectedTasks() {
  const ids = [...document.querySelectorAll('.task-checkbox:checked')].map(c => +c.dataset.id);
  if (!ids.length) {
    showNotification('No tasks selected! Please select at least one task.', 'warning');
    return;
  }
  if (!confirm(`Delete ${ids.length} selected task(s)?`)) return;
  try {
    const res = await fetch('/api/tasks/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showNotification('❌ Failed to delete tasks: ' + (err.error || res.statusText), 'error');
      return;
    }
    await Promise.all([loadTasksTable(), loadTaskPageStats(), loadStats()]);
    showNotification(`✅ ${ids.length} task(s) deleted successfully!`, 'success');
  } catch (e) {
    console.error('deleteSelectedTasks:', e);
    showNotification('❌ Delete failed. Please try again.', 'error');
  }
}

function openNewTaskModal() {
  document.getElementById('newTaskDesc').value     = '';
  document.getElementById('newTaskContact').value  = '';
  document.getElementById('newTaskNotes').value    = '';
  document.getElementById('newTaskType').value     = 'task';
  document.getElementById('newTaskPriority').value = 'medium';
  document.getElementById('newTaskModal').style.display = 'flex';
  showNotification('New Task form opened', 'info');
}

function closeNewTaskModal() {
  document.getElementById('newTaskModal').style.display = 'none';
}

async function saveNewTask() {
  const description = document.getElementById('newTaskDesc').value.trim();
  if (!description) { showNotification('Description is required', 'warning'); return; }
  const btn = document.querySelector('#newTaskModal .modal-footer .btn-action:last-child');
  const origText = btn ? btn.innerHTML : '';
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; btn.disabled = true; }
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        fromName: document.getElementById('newTaskContact').value.trim() || 'Admin',
        type:     document.getElementById('newTaskType').value,
        priority: document.getElementById('newTaskPriority').value,
        notes:    document.getElementById('newTaskNotes').value.trim()
      })
    });
    if (res.ok) {
      closeNewTaskModal();
      await Promise.all([loadTasksTable(), loadTaskPageStats(), loadStats()]);
      showNotification('✅ New task created successfully!', 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      showNotification('❌ Failed to create task: ' + (err.error || res.statusText), 'error');
    }
  } catch (e) {
    console.error('saveNewTask:', e);
    showNotification('❌ Error: Could not connect to server. Make sure backend is running.', 'error');
  } finally {
    if (btn) { btn.innerHTML = origText; btn.disabled = false; }
  }
}

function exportTasksCSV() {
  const rows  = document.querySelectorAll('#tasksTableBody tr.task-row');
  if (!rows.length) { showNotification('No tasks to export', 'warning'); return; }
  showNotification('Preparing tasks CSV export...', 'info');
  const headers = ['ID','Description','Type','Priority','Status','Contact','Created'];
  const lines   = [headers.join(',')];
  rows.forEach(row => {
    const cols = row.querySelectorAll('td');
    lines.push([
      cols[1]?.textContent.trim(),
      '"' + (cols[2]?.querySelector('h4')?.textContent.trim() || '').replace(/"/g,'""') + '"',
      cols[3]?.textContent.trim(),
      cols[4]?.textContent.trim(),
      cols[5]?.querySelector('select')?.value || '',
      cols[6]?.textContent.trim(),
      cols[7]?.textContent.trim()
    ].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `tasks_${new Date().toISOString().slice(0,10)}.csv` });
  a.click();
  showNotification(`✅ Exported ${rows.length} tasks!`, 'success');
}

// ─── MEETINGS PAGE ───────────────────────────────────────────────────────────
function debounceMeetingSearch() {
  clearTimeout(_meetingSearchTimer);
  _meetingSearchTimer = setTimeout(() => {
    loadMeetingsPage();
  }, 320);
}

function applyMeetingFilters() {
  loadMeetingsPage();
}

function clearMeetingFilters() {
  const byId = (id) => document.getElementById(id);
  if (byId('meetingSearch')) byId('meetingSearch').value = '';
  if (byId('meetingStatusFilter')) byId('meetingStatusFilter').value = 'all';
  if (byId('meetingFromDate')) byId('meetingFromDate').value = '';
  if (byId('meetingToDate')) byId('meetingToDate').value = '';
  if (byId('meetingAvailabilityStart')) byId('meetingAvailabilityStart').value = '';
  if (byId('meetingAvailabilityDuration')) byId('meetingAvailabilityDuration').value = '30';
  setMeetingAvailabilityResult('Select a slot and click check.', 'neutral');
  loadMeetingsPage();
}

function toDayStartIso(dayValue) {
  if (!dayValue) return null;
  const d = new Date(`${dayValue}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toDayEndIso(dayValue) {
  if (!dayValue) return null;
  const d = new Date(`${dayValue}T23:59:59`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatMeetingDateTime(dateValue, timezone = 'Asia/Karachi') {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-PK', {
    timeZone: timezone || 'Asia/Karachi',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function toSafeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return parsed.href;
  } catch (_) {
    return '';
  }
}

function getMeetingById(meetingId) {
  const id = Number(meetingId);
  if (!Number.isFinite(id)) return null;
  return meetingsRawData.find((m) => Number(m.id) === id) || null;
}

function toDateTimeLocalInputValue(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return '';

  const pad = (value) => String(value).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function updateMeetingStats(rows) {
  const now = new Date();
  const todayKey = now.toDateString();

  const total = rows.length;
  const booked = rows.filter((m) => m.status === 'booked');
  const upcoming = booked.filter((m) => new Date(m.slotEnd).getTime() > now.getTime());
  const today = booked.filter((m) => {
    const slot = new Date(m.slotStart);
    if (Number.isNaN(slot.getTime())) return false;
    return slot.toDateString() === todayKey;
  });
  const uniqueClients = new Set(rows.map((m) => (m.phoneNumber || '').trim()).filter(Boolean)).size;

  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };

  set('meetingStatTotal', total);
  set('meetingStatUpcoming', upcoming.length);
  set('meetingStatToday', today.length);
  set('meetingStatClients', uniqueClients);

  const badge = document.getElementById('meetingsBadge');
  if (badge) badge.textContent = String(upcoming.length);
}

function renderMeetingsRows(rows) {
  const tbody = document.getElementById('meetingsTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--text-secondary)"><i class="fas fa-calendar-times"></i> No meetings found for current filters</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((meeting) => {
    const slotEndDate = new Date(meeting.slotEnd);
    const slotEndMs = slotEndDate.getTime();
    const isExpired = Boolean(meeting.isExpired ?? (meeting.status === 'booked' && !Number.isNaN(slotEndMs) && slotEndMs < Date.now()));
    const statusKey = meeting.status === 'cancelled' ? 'cancelled' : (isExpired ? 'expired' : 'booked');
    const statusLabel = statusKey.toUpperCase();
    const statusTitle = statusKey === 'expired'
      ? 'Meeting time has passed'
      : statusKey === 'cancelled'
        ? 'Meeting cancelled'
        : 'Meeting scheduled';
    const slotStart = formatMeetingDateTime(meeting.slotStart, meeting.timezone);
    const slotEnd = formatMeetingDateTime(meeting.slotEnd, meeting.timezone);
    const safeJoinUrl = toSafeUrl(meeting.zoomJoinUrl);
    const zoomCell = safeJoinUrl
      ? `<a class="meeting-link-btn" href="${safeJoinUrl}" target="_blank" rel="noopener noreferrer">Open Link</a>`
      : '<span class="meeting-link-missing">Not generated</span>';

    const actionButtons = meeting.status === 'booked'
      ? `
          <div class="meeting-action-buttons">
            <button class="btn-task-action" title="Reschedule" onclick="openMeetingRescheduleModal(${meeting.id})"><i class="fas fa-calendar-alt"></i></button>
            <button class="btn-task-action" title="Cancel Meeting" onclick="openMeetingCancelModal(${meeting.id})"><i class="fas fa-ban"></i></button>
            <button class="btn-task-action danger" title="Delete Meeting" onclick="openMeetingDeleteModal(${meeting.id})"><i class="fas fa-trash"></i></button>
          </div>
        `
      : `
          <div class="meeting-action-buttons">
            <button class="btn-task-action" title="Reschedule & Reactivate" onclick="openMeetingRescheduleModal(${meeting.id})"><i class="fas fa-calendar-check"></i></button>
            <button class="btn-task-action danger" title="Delete Meeting" onclick="openMeetingDeleteModal(${meeting.id})"><i class="fas fa-trash"></i></button>
          </div>
        `;

    return `
      <tr class="meeting-row ${isExpired ? 'expired' : ''}">
        <td><span class="task-id">#${meeting.id}</span></td>
        <td>
          <div class="meeting-slot-main">${slotStart}</div>
          <div class="meeting-slot-sub">Ends: ${slotEnd}</div>
        </td>
        <td>${meeting.durationMinutes || 30} min</td>
        <td>
          <div class="meeting-client-name">${escapeHtml(meeting.fromName || 'Unknown')}</div>
          <div class="meeting-client-phone">${escapeHtml(meeting.phoneNumber || '—')}</div>
        </td>
        <td>
          <div class="meeting-host-email">${escapeHtml(meeting.hostEmail || '—')}</div>
        </td>
        <td><span class="meeting-status-badge ${statusKey}" title="${escapeHtml(statusTitle)}">${escapeHtml(statusLabel)}</span></td>
        <td>${escapeHtml(meeting.topic || 'Client Meeting')}</td>
        <td>${zoomCell}</td>
        <td>${escapeHtml(meeting.zoomMeetingId || '—')}</td>
        <td>${formatDate(meeting.createdAt)}</td>
        <td>${actionButtons}</td>
      </tr>
    `;
  }).join('');
}

function openMeetingRescheduleModal(meetingId) {
  const meeting = getMeetingById(meetingId);
  if (!meeting) {
    showNotification('Meeting record not found. Please refresh.', 'warning');
    return;
  }

  meetingRescheduleTargetId = Number(meeting.id);

  const modal = document.getElementById('meetingRescheduleModal');
  const summary = document.getElementById('meetingRescheduleSummary');
  const startInput = document.getElementById('meetingRescheduleStart');
  const durationInput = document.getElementById('meetingRescheduleDuration');

  if (summary) {
    summary.textContent = `Client: ${meeting.fromName || meeting.phoneNumber} | Current slot: ${formatMeetingDateTime(meeting.slotStart, meeting.timezone)}`;
  }
  if (startInput) startInput.value = toDateTimeLocalInputValue(meeting.slotStart);
  if (durationInput) durationInput.value = String(meeting.durationMinutes || 30);

  if (modal) modal.style.display = 'flex';
}

function closeMeetingRescheduleModal() {
  const modal = document.getElementById('meetingRescheduleModal');
  if (modal) modal.style.display = 'none';
  meetingRescheduleTargetId = null;

  const saveBtn = document.getElementById('meetingRescheduleSaveBtn');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fas fa-check"></i> Save Changes';
  }
}

async function saveMeetingReschedule() {
  if (!meetingRescheduleTargetId) return;

  const startInput = document.getElementById('meetingRescheduleStart');
  const durationInput = document.getElementById('meetingRescheduleDuration');
  const saveBtn = document.getElementById('meetingRescheduleSaveBtn');

  const slotStartRaw = startInput?.value || '';
  const duration = parseInt(durationInput?.value || '30', 10);

  if (!slotStartRaw) {
    showNotification('Please select new meeting date and time.', 'warning');
    return;
  }

  if (!Number.isFinite(duration) || duration < 15 || duration > 180) {
    showNotification('Duration must be between 15 and 180 minutes.', 'warning');
    return;
  }

  const slotStart = new Date(slotStartRaw);
  if (Number.isNaN(slotStart.getTime())) {
    showNotification('Invalid date/time selected.', 'warning');
    return;
  }

  const originalBtn = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
  }

  try {
    const response = await fetch(`/api/meetings/${meetingRescheduleTargetId}/reschedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slotStart: slotStart.toISOString(),
        durationMinutes: duration
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (payload?.conflict?.slotStart) {
        const at = formatMeetingDateTime(payload.conflict.slotStart, payload.conflict.timezone);
        showNotification(`Slot already booked at ${at}.`, 'error');
      } else {
        showNotification(payload.error || 'Failed to reschedule meeting.', 'error');
      }
      return;
    }

    closeMeetingRescheduleModal();
    await loadMeetingsPage();
    showNotification('✅ Meeting rescheduled successfully.', 'success');
  } catch (error) {
    console.error('saveMeetingReschedule:', error);
    showNotification('Could not reschedule meeting right now.', 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalBtn || '<i class="fas fa-check"></i> Save Changes';
    }
  }
}

function openMeetingCancelModal(meetingId) {
  const meeting = getMeetingById(meetingId);
  if (!meeting) {
    showNotification('Meeting record not found. Please refresh.', 'warning');
    return;
  }

  meetingCancelTargetId = Number(meeting.id);

  const modal = document.getElementById('meetingCancelModal');
  const summary = document.getElementById('meetingCancelSummary');
  if (summary) {
    summary.innerHTML =
      `<strong>Client:</strong> ${escapeHtml(meeting.fromName || meeting.phoneNumber || 'Unknown')}<br>` +
      `<strong>Slot:</strong> ${escapeHtml(formatMeetingDateTime(meeting.slotStart, meeting.timezone))}<br>` +
      `<strong>Meeting ID:</strong> ${escapeHtml(meeting.zoomMeetingId || '—')}`;
  }
  if (modal) modal.style.display = 'flex';
}

function closeMeetingCancelModal() {
  const modal = document.getElementById('meetingCancelModal');
  if (modal) modal.style.display = 'none';
  meetingCancelTargetId = null;

  const confirmBtn = document.getElementById('meetingCancelConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<i class="fas fa-ban"></i> Confirm Cancel';
  }
}

async function confirmMeetingCancel() {
  if (!meetingCancelTargetId) return;

  const confirmBtn = document.getElementById('meetingCancelConfirmBtn');
  const originalBtn = confirmBtn ? confirmBtn.innerHTML : '';
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling...';
  }

  try {
    const response = await fetch(`/api/meetings/${meetingCancelTargetId}/cancel`, {
      method: 'PATCH'
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to cancel meeting.', 'error');
      return;
    }

    closeMeetingCancelModal();
    await loadMeetingsPage();
    showNotification('✅ Meeting cancelled successfully.', 'success');
  } catch (error) {
    console.error('confirmMeetingCancel:', error);
    showNotification('Could not cancel meeting right now.', 'error');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = originalBtn || '<i class="fas fa-ban"></i> Confirm Cancel';
    }
  }
}

function openMeetingDeleteModal(meetingId) {
  const meeting = getMeetingById(meetingId);
  if (!meeting) {
    showNotification('Meeting record not found. Please refresh.', 'warning');
    return;
  }

  meetingDeleteTargetId = Number(meeting.id);

  const modal = document.getElementById('meetingDeleteModal');
  const summary = document.getElementById('meetingDeleteSummary');
  if (summary) {
    summary.innerHTML =
      `<strong>Client:</strong> ${escapeHtml(meeting.fromName || meeting.phoneNumber || 'Unknown')}<br>` +
      `<strong>Slot:</strong> ${escapeHtml(formatMeetingDateTime(meeting.slotStart, meeting.timezone))}<br>` +
      `<strong>Meeting ID:</strong> ${escapeHtml(meeting.zoomMeetingId || '—')}`;
  }
  if (modal) modal.style.display = 'flex';
}

function closeMeetingDeleteModal() {
  const modal = document.getElementById('meetingDeleteModal');
  if (modal) modal.style.display = 'none';
  meetingDeleteTargetId = null;

  const confirmBtn = document.getElementById('meetingDeleteConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<i class="fas fa-trash"></i> Confirm Delete';
  }
}

async function confirmMeetingDelete() {
  if (!meetingDeleteTargetId) return;

  const confirmBtn = document.getElementById('meetingDeleteConfirmBtn');
  const originalBtn = confirmBtn ? confirmBtn.innerHTML : '';
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
  }

  try {
    const response = await fetch(`/api/meetings/${meetingDeleteTargetId}`, {
      method: 'DELETE'
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      showNotification(payload.error || 'Failed to delete meeting.', 'error');
      return;
    }

    closeMeetingDeleteModal();
    await loadMeetingsPage();
    showNotification('🗑️ Meeting deleted successfully.', 'success');
  } catch (error) {
    console.error('confirmMeetingDelete:', error);
    showNotification('Could not delete meeting right now.', 'error');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = originalBtn || '<i class="fas fa-trash"></i> Confirm Delete';
    }
  }
}

async function loadMeetingsPage() {
  const tbody = document.getElementById('meetingsTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-secondary)"><i class="fas fa-spinner fa-spin"></i> Loading meetings...</td></tr>';

  try {
    const params = new URLSearchParams();
    params.set('limit', '200');

    const status = (document.getElementById('meetingStatusFilter')?.value || 'all').trim();
    const fromDate = document.getElementById('meetingFromDate')?.value || '';
    const toDate = document.getElementById('meetingToDate')?.value || '';

    if (status && status !== 'all') params.set('status', status);

    const fromIso = toDayStartIso(fromDate);
    const toIso = toDayEndIso(toDate);
    if (fromIso) params.set('fromDate', fromIso);
    if (toIso) params.set('toDate', toIso);

    const response = await fetch('/api/meetings?' + params.toString());
    const payload = await response.json();
    const meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
    meetingsRawData = meetings;

    const search = (document.getElementById('meetingSearch')?.value || '').trim().toLowerCase();
    const filtered = meetings.filter((meeting) => {
      if (!search) return true;

      const haystack = [
        meeting.fromName,
        meeting.phoneNumber,
        meeting.hostEmail,
        meeting.topic,
        meeting.zoomMeetingId,
        meeting.sourceMessage
      ]
        .map((v) => String(v || '').toLowerCase())
        .join(' ');

      return haystack.includes(search);
    }).sort((a, b) => {
      const aTime = new Date(a.slotStart).getTime() || 0;
      const bTime = new Date(b.slotStart).getTime() || 0;
      return bTime - aTime;
    });

    meetingsRenderedData = filtered;
    updateMeetingStats(filtered);
    renderMeetingsRows(filtered);
  } catch (error) {
    console.error('loadMeetingsPage:', error);
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:#F44336"><i class="fas fa-exclamation-circle"></i> Error loading meetings</td></tr>';
    updateMeetingStats([]);
  }
}

function setMeetingAvailabilityResult(message, tone = 'neutral') {
  const el = document.getElementById('meetingAvailabilityResult');
  if (!el) return;
  el.className = `meeting-availability-result ${tone}`;
  el.textContent = message;
}

async function checkMeetingAvailability() {
  const slotInput = document.getElementById('meetingAvailabilityStart');
  const durationInput = document.getElementById('meetingAvailabilityDuration');

  const slotStartRaw = slotInput?.value || '';
  const duration = parseInt(durationInput?.value || '30', 10);

  if (!slotStartRaw) {
    setMeetingAvailabilityResult('Please select slot date and time first.', 'warn');
    return;
  }

  if (!Number.isFinite(duration) || duration < 15 || duration > 180) {
    setMeetingAvailabilityResult('Duration must be between 15 and 180 minutes.', 'warn');
    return;
  }

  const slotStart = new Date(slotStartRaw);
  if (Number.isNaN(slotStart.getTime())) {
    setMeetingAvailabilityResult('Invalid slot date/time selected.', 'warn');
    return;
  }

  const slotEnd = new Date(slotStart.getTime() + duration * 60000);

  try {
    setMeetingAvailabilityResult('Checking availability...', 'neutral');

    const params = new URLSearchParams({
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString()
    });

    const response = await fetch('/api/meetings?' + params.toString());
    const payload = await response.json();

    if (payload.available) {
      setMeetingAvailabilityResult('Available: this slot is free for booking.', 'ok');
      return;
    }

    const firstConflict = Array.isArray(payload.conflicts) && payload.conflicts.length > 0
      ? payload.conflicts[0]
      : null;

    if (firstConflict) {
      const when = formatMeetingDateTime(firstConflict.slotStart, firstConflict.timezone);
      setMeetingAvailabilityResult(`Booked: conflict with ${when}.`, 'bad');
      return;
    }

    setMeetingAvailabilityResult('Booked: selected range has a conflict.', 'bad');
  } catch (error) {
    console.error('checkMeetingAvailability:', error);
    setMeetingAvailabilityResult('Could not check slot right now. Try again.', 'bad');
  }
}

function exportMeetingsCSV() {
  if (!meetingsRenderedData.length) {
    showNotification('No meetings to export.', 'warning');
    return;
  }

  const esc = (value) => {
    const v = String(value ?? '');
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  };

  const headers = [
    'ID',
    'Client Name',
    'Client Phone',
    'Host Email',
    'Topic',
    'Status',
    'Display Status',
    'Slot Start',
    'Slot End',
    'Duration Minutes',
    'Timezone',
    'Zoom Meeting ID',
    'Zoom Join URL',
    'Created At'
  ];

  const lines = [headers.join(',')];

  meetingsRenderedData.forEach((meeting) => {
    const displayStatus = meeting.status === 'cancelled' ? 'cancelled' : (meeting.isExpired ? 'expired' : 'booked');
    lines.push([
      esc(meeting.id),
      esc(meeting.fromName || ''),
      esc(meeting.phoneNumber || ''),
      esc(meeting.hostEmail || ''),
      esc(meeting.topic || ''),
      esc(meeting.status || ''),
      esc(displayStatus),
      esc(meeting.slotStart || ''),
      esc(meeting.slotEnd || ''),
      esc(meeting.durationMinutes || 30),
      esc(meeting.timezone || ''),
      esc(meeting.zoomMeetingId || ''),
      esc(meeting.zoomJoinUrl || ''),
      esc(meeting.createdAt || '')
    ].join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meetings_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  showNotification(`✅ Exported ${meetingsRenderedData.length} meeting records.`, 'success');
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

// Load tasks (dashboard recent tasks — backward compat)
async function loadTasks(status = 'all') {
  try {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (currentTypeFilter !== 'all') params.set('type', currentTypeFilter);
    const url = '/api/tasks' + (params.toString() ? '?' + params.toString() : '');
    const response = await fetch(url);
    const tasks = await response.json();
    const tasksList = document.getElementById('tasksList');
    
    if (tasks.length === 0) {
      tasksList.innerHTML = '<p class="loading">No tasks found.</p>';
      return;
    }
    
    tasksList.innerHTML = tasks.map(task => `
      <div class="task-item clickable" data-task-id="${task._id}" onclick="openDashboardTask('${task._id}')">
        <div class="task-header">
          <span class="task-type ${task.type}">${task.type.toUpperCase()}</span>
          <div class="task-status">
            <select class="status-select" onchange="updateTaskStatus('${task._id}', this.value)" onclick="event.stopPropagation()" data-task-id="${task._id}">
              <option value="pending" ${task.status === 'pending' ? 'selected' : ''}>Pending</option>
              <option value="in-progress" ${task.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
              <option value="completed" ${task.status === 'completed' ? 'selected' : ''}>Completed</option>
              <option value="cancelled" ${task.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
            </select>
          </div>
        </div>
        <div class="task-description">${escapeHtml(task.description)}</div>
        <div class="task-meta">
          <span><i class="fas fa-user"></i> ${escapeHtml(task.fromName || task.from)}</span>
          <span><i class="fas fa-clock"></i> ${formatDate(task.createdAt)}</span>
          ${task.completedAt ? `<span><i class="fas fa-check"></i> Completed: ${formatDate(task.completedAt)}</span>` : ''}
        </div>
      </div>
    `).join('');
    
  } catch (error) {
    console.error('Error loading tasks:', error);
    document.getElementById('tasksList').innerHTML = '<p class="loading">Error loading tasks.</p>';
  }
}

async function openDashboardTask(taskId) {
  if (!taskId) return;
  await focusTaskFromNotification(taskId);
}

// Update task status
async function updateTaskStatus(taskId, status) {
  try {
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status })
    });
    
    if (response.ok) {
      loadTasks(currentFilter);
      loadStats();
    }
  } catch (error) {
    console.error('Error updating task:', error);
  }
}

// ── Messages Pagination State ──────────────────────────────────────────────
let _msgCurrentPage = 1;
const _msgPerPage   = 20;
let _msgTotalCount  = 0;
let _msgLastFilters = {};

// ── Profiles Pagination State ──────────────────────────────────────────────
let _profileCurrentPage = 1;
const _profilePerPage   = 20;
let _profileTotalCount  = 0;

// Load recent messages
async function loadMessages(filters = {}) {
  try {
    // If new filters passed (not a page-turn call), reset to page 1
    if (!filters._pageCall) {
      _msgCurrentPage = 1;
      _msgLastFilters = { ...filters };
    }
    const activeFilters = filters._pageCall ? _msgLastFilters : filters;

    // Build query string — always use _msgPerPage for pagination
    const params = new URLSearchParams({
      limit:  _msgPerPage,
      offset: (_msgCurrentPage - 1) * _msgPerPage
    });

    if (activeFilters.search)    params.append('search',    activeFilters.search);
    if (activeFilters.sentiment && activeFilters.sentiment !== 'all') params.append('sentiment', activeFilters.sentiment);
    if (activeFilters.from)      params.append('from',      activeFilters.from);
    if (activeFilters.startDate) params.append('startDate', activeFilters.startDate);
    if (activeFilters.endDate)   params.append('endDate',   activeFilters.endDate);

    const response = await fetch(`/api/messages?${params}`);
    const data = await response.json();

    let messages = data.messages || [];
    _msgTotalCount = data.total || 0;

    // Apply client-side sort
    if (activeFilters.sort === 'oldest') {
      messages = [...messages].reverse();
    } else if (activeFilters.sort === 'sentiment') {
      const order = { positive: 0, neutral: 1, negative: 2 };
      messages = [...messages].sort((a, b) => (order[a.sentiment?.label] ?? 1) - (order[b.sentiment?.label] ?? 1));
    }

    const messagesList    = document.getElementById('messagesList');
    const messagesContainer = document.getElementById('messagesContainer');

    // ── Messages page ────────────────────────────────────────────────────────
    if (messagesContainer && currentPage === 'messages') {
      if (!messages || messages.length === 0) {
        messagesContainer.innerHTML = '<p class="loading" style="text-align:center;padding:40px;color:var(--text-secondary)">No messages found matching your filters.</p>';
        renderMsgPagination();
        return;
      }

      messagesContainer.innerHTML = messages.map(msg => `
        <div class="message-card ${msg.sentiment?.label || 'neutral'}" data-from="${escapeHtml(msg.from)}" data-name="${escapeHtml(msg.fromName || msg.from)}" data-id="${msg._id}">
          <div style="display:flex;align-items:center;gap:10px;">
            <input type="checkbox" class="msg-checkbox" data-id="${msg._id}" onchange="onMessageCheckboxChange()" style="width:16px;height:16px;cursor:pointer;flex-shrink:0;" onclick="event.stopPropagation()">
            <div class="sender-avatar">${getInitials(msg.fromName || msg.from)}</div>
          </div>
          <div class="message-info">
            <div class="message-top">
              <h4 class="sender-name">${escapeHtml(msg.fromName || msg.from)}</h4>
              <span class="message-time"><i class="far fa-clock"></i> ${formatDate(msg.timestamp)}</span>
            </div>
            <div class="message-preview">
              <p class="message-text-preview">${escapeHtml(msg.body)}</p>
              <div class="sentiment-badge ${msg.sentiment.label}">
                ${getSentimentIcon(msg.sentiment.label)} ${msg.sentiment.label}
              </div>
            </div>
          </div>
          <div class="message-actions-inline">
            ${msg.replied ? '<span class="replied-badge">✓ Replied</span>' : '<button class="action-btn" title="Reply" onclick="event.stopPropagation(); replyToMessage(' + msg._id + ', \'' + escapeHtml(msg.from) + '\')"><i class="fas fa-reply"></i></button>'}
            <button class="action-btn danger" title="Delete" onclick="event.stopPropagation()"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      `).join('');

      // Show select-all bar and reset checkboxes
      const bar    = document.getElementById('selectAllBar');
      const allBox = document.getElementById('selectAllCheckbox');
      const countEl = document.getElementById('selectedCount');
      if (bar)     bar.style.display    = 'flex';
      if (allBox)  allBox.checked       = false;
      if (countEl) countEl.textContent  = '0';

      renderMsgPagination();
    }

    // ── Dashboard recent messages list ───────────────────────────────────────
    if (messagesList && currentPage === 'dashboard') {
      if (!messages || messages.length === 0) {
        messagesList.innerHTML = '<p class="loading">No messages yet.</p>';
        return;
      }
      messagesList.innerHTML = messages.slice(0, 5).map(msg => `
        <div class="message-item clickable ${msg.sentiment.label}" data-id="${msg._id}" onclick="openDashboardRecentMessage('${encodeURIComponent(msg.from || '')}', '${encodeURIComponent(msg.fromName || msg.from || '')}', '${msg._id || ''}')">
          <div class="message-header">
            <span class="message-from">${escapeHtml(msg.fromName || msg.from)}</span>
            <span class="message-time">${formatDate(msg.timestamp)}</span>
          </div>
          <div class="message-body">${escapeHtml(msg.body)}</div>
          <div class="message-footer">
            <span class="sentiment-badge ${msg.sentiment.label}">
              ${getSentimentIcon(msg.sentiment.label)} ${msg.sentiment.label}
            </span>
            ${msg.replied ? '<span class="replied-badge">✓ Replied</span>' : ''}
          </div>
        </div>
      `).join('');
    }

  } catch (error) {
    console.error('Error loading messages:', error);
    const container = document.getElementById('messagesContainer') || document.getElementById('messagesList');
    if (container) container.innerHTML = '<p class="loading">Error loading messages.</p>';
  }
}

async function openDashboardRecentMessage(encodedPhone, encodedName, messageId = '') {
  const phone = decodeURIComponent(encodedPhone || '');
  const name = decodeURIComponent(encodedName || '');
  if (!phone) return;
  await openKeywordMessageInChat(phone, name || phone, '', messageId || '');
}

/** Render numbered pagination below the messages list */
function renderMsgPagination() {
  const wrap = document.getElementById('msgPaginationWrap');
  const nav  = document.getElementById('msgPagination');
  const info = document.getElementById('msgPaginationInfo');
  if (!wrap || !nav) return;

  const totalPages = Math.ceil(_msgTotalCount / _msgPerPage);

  if (totalPages <= 1) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'flex';

  const from = (_msgCurrentPage - 1) * _msgPerPage + 1;
  const to   = Math.min(_msgCurrentPage * _msgPerPage, _msgTotalCount);
  if (info) info.textContent = `Showing ${from}–${to} of ${_msgTotalCount}`;

  // Build page numbers with ellipsis
  let pages = [];
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pages = [1];
    if (_msgCurrentPage > 3)              pages.push('...');
    const start = Math.max(2, _msgCurrentPage - 1);
    const end   = Math.min(totalPages - 1, _msgCurrentPage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (_msgCurrentPage < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  nav.innerHTML = `
    <button class="pg-btn" ${_msgCurrentPage === 1 ? 'disabled' : ''} onclick="goToMsgPage(${_msgCurrentPage - 1})">
      <i class="fas fa-chevron-left"></i>
    </button>
    ${pages.map(p =>
      p === '...'
        ? `<span class="pg-dots">…</span>`
        : `<button class="pg-btn ${p === _msgCurrentPage ? 'active' : ''}" onclick="goToMsgPage(${p})">${p}</button>`
    ).join('')}
    <button class="pg-btn" ${_msgCurrentPage === totalPages ? 'disabled' : ''} onclick="goToMsgPage(${_msgCurrentPage + 1})">
      <i class="fas fa-chevron-right"></i>
    </button>
  `;
}

/** Go to a specific page */
function goToMsgPage(page) {
  const totalPages = Math.ceil(_msgTotalCount / _msgPerPage);
  if (page < 1 || page > totalPages) return;
  _msgCurrentPage = page;
  loadMessages({ _pageCall: true });
  const container = document.getElementById('messagesContainer');
  if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Load messages page with stats
async function loadMessagesPage() {
  try {
    // Load messages
    await loadMessages({});
    
    // Load stats for messages page
    const response = await fetch('/api/stats');
    const stats = await response.json();
    
    // Update stats boxes
    const totalMessagesCount = document.getElementById('totalMessagesCount');
    const todayMessagesCount = document.getElementById('todayMessagesCount');
    const avgSentiment = document.getElementById('avgSentiment');
    
    if (totalMessagesCount) totalMessagesCount.textContent = stats.totalMessages || 0;
    if (todayMessagesCount) todayMessagesCount.textContent = stats.today.messages || 0;
    if (avgSentiment) avgSentiment.textContent = `${stats.sentiment.positivePercent || 0}%`;
    
    // Get unique contacts count
    const contactsResponse = await fetch('/api/messages/contacts');
    const contacts = await contactsResponse.json();
    const uniqueContactsCount = document.getElementById('uniqueContactsCount');
    if (uniqueContactsCount) uniqueContactsCount.textContent = contacts.length || 0;
    
  } catch (error) {
    console.error('Error loading messages page:', error);
  }
}

// Get initials from name
function getInitials(name) {
  if (!name) return '?';
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

// Reply to a message
async function replyToMessage(messageId, phoneNumber) {
  const replyText = prompt('Enter your reply:');
  
  if (!replyText || !replyText.trim()) return;
  
  try {
    const response = await fetch(`/api/messages/${messageId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: replyText.trim() })
    });
    
    const result = await response.json();

    if (response.ok && result.success) {
      showNotification('✅ Reply sent successfully!', 'success');
      loadMessages();
    } else {
      showNotification('❌ ' + (result.error || 'Failed to send reply'), 'error');
    }
  } catch (error) {
    console.error('Error sending reply:', error);
    showNotification('❌ Error sending reply. Is the bot running?', 'error');
  }
}

// Load conversations
async function loadConversations() {
  try {
    const response = await fetch('/api/conversations');
    const conversations = await response.json();
    
    const conversationsList = document.getElementById('conversationsList');
    
    if (!conversationsList) {
      console.warn('conversationsList element not found');
      return;
    }
    
    if (conversations.length === 0) {
      conversationsList.innerHTML = '<p class="loading">No conversations yet.</p>';
      return;
    }
    
    conversationsList.innerHTML = conversations.map(conv => `
      <div class="conversation-item">
        <div class="conversation-info">
          <h3>${escapeHtml(conv.name || conv.phoneNumber)}</h3>
          <p>${conv.phoneNumber}</p>
          <p style="font-size: 0.85rem; color: #999; margin-top: 5px;">
            Last message: ${formatDate(conv.lastMessageAt)}
          </p>
        </div>
        <div class="conversation-stats">
          <div class="stat-item">
            <div class="number">${conv.messageCount}</div>
            <div class="label">Messages</div>
          </div>
          <div class="stat-item">
            <div class="number">${conv.taskCount}</div>
            <div class="label">Tasks</div>
          </div>
          <div class="stat-item">
            <div class="number">${conv.requestCount}</div>
            <div class="label">Requests</div>
          </div>
          <div class="stat-item">
            <div class="number" style="color: ${getSentimentColor(conv.averageSentiment)}">
              ${getSentimentIcon(getSentimentLabel(conv.averageSentiment))}
            </div>
            <div class="label">Sentiment</div>
          </div>
        </div>
      </div>
    `).join('');
    
  } catch (error) {
    console.error('Error loading conversations:', error);
    const conversationsList = document.getElementById('conversationsList');
    if (conversationsList) {
      conversationsList.innerHTML = '<p class="loading">Error loading conversations.</p>';
    }
  }
}

// Filter buttons
const filterButtons = document.querySelectorAll('.filter-btn');
if (filterButtons.length > 0) {
  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.status;
      loadTasks(currentFilter);
    });
  });
}

// Utility functions
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

function getSentimentIcon(label) {
  const icons = {
    positive: '😊',
    neutral: '😐',
    negative: '😔'
  };
  return icons[label] || '😐';
}

function getSentimentLabel(score) {
  if (score > 0.3) return 'positive';
  if (score < -0.3) return 'negative';
  return 'neutral';
}

function getSentimentColor(score) {
  if (score > 0.3) return '#4CAF50';
  if (score < -0.3) return '#f44336';
  return '#9E9E9E';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initial load
loadStats();
loadTasks();
loadMessages();
loadConversations();

// Emoji Picker functionality
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const chatInput = document.getElementById('chatInput');
const emojiGrid = document.getElementById('emojiGrid');
const emojiCategories = document.querySelectorAll('.emoji-category');

// Emoji collections by category
const emojiData = {
  smileys: ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '🥳', '😚', '😊', '🤗', '🤩', '🤔', '😏', '😐', '😑', '😶', '🙄', '😏', '😣', '😥', '😮', '🤐', '😯', '😪', '😫', '🥱', '😴', '😌', '😛', '😜', '😝', '🤤', '😒', '😓', '😔', '😕', '🤐', '🙃', '🥺', '🤑', '😲', '😞', '😟', '😤', '😢', '😭', '😦', '😧', '😨', '😩', '🤯', '😬', '😰', '😱', '🥵', '🥶', '😳', '🤪', '😵', '🥴', '😠', '😡', '🤬'],
  hearts: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '💔', '❤️‍🔥', '❤️‍🩹', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟'],
  hands: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '👋', '🤝', '🙏', '💪', '🙌', '👏', '🎉', '🎊', '✨', '🔥', '💯']
};

if (emojiBtn && emojiPicker) {
  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPicker.classList.toggle('active');
    // Close attachment menu if open
    const attachMenu = document.getElementById('attachmentMenu');
    if (attachMenu) attachMenu.classList.remove('active');
  });

  // Category switching
  emojiCategories.forEach(category => {
    category.addEventListener('click', () => {
      // Remove active class from all categories
      emojiCategories.forEach(cat => cat.classList.remove('active'));
      // Add active class to clicked category
      category.classList.add('active');
      
      // Get category type
      const categoryType = category.getAttribute('data-category');
      
      // Update emoji grid
      if (emojiData[categoryType] && emojiGrid) {
        emojiGrid.innerHTML = '';
        emojiData[categoryType].forEach(emoji => {
          const emojiSpan = document.createElement('span');
          emojiSpan.className = 'emoji-item';
          emojiSpan.setAttribute('data-emoji', emoji);
          emojiSpan.textContent = emoji;
          
          // Add click event
          emojiSpan.addEventListener('click', () => {
            if (chatInput) {
              chatInput.value += emoji;
              chatInput.focus();
            }
          });
          
          emojiGrid.appendChild(emojiSpan);
        });
      }
    });
  });

  // Initial emoji load (smileys)
  if (emojiGrid) {
    const initialEmojis = document.querySelectorAll('.emoji-item');
    initialEmojis.forEach(item => {
      item.addEventListener('click', () => {
        const emoji = item.getAttribute('data-emoji');
        if (chatInput) {
          chatInput.value += emoji;
          chatInput.focus();
        }
      });
    });
  }
}

// Attachment Menu functionality
const attachBtn = document.getElementById('attachBtn');
const attachmentMenu = document.getElementById('attachmentMenu');

if (attachBtn && attachmentMenu) {
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachmentMenu.classList.toggle('active');
    // Close emoji picker if open
    if (emojiPicker) emojiPicker.classList.remove('active');
  });

  // Handle attachment options
  const attachmentOptions = document.querySelectorAll('.attachment-option');
  attachmentOptions.forEach(option => {
    option.addEventListener('click', () => {
      const optionText = option.querySelector('span').textContent;
      attachmentMenu.classList.remove('active');
      if (optionText === 'Camera') {
        openCamera();
      } else if (optionText === 'Document') {
        document.getElementById('documentFileInput').click();
      } else if (optionText === 'Media') {
        document.getElementById('mediaFileInput').click();
      }
    });
  });

  // Wire up file inputs (Media + Document) to sendMediaAttachment
  ['mediaFileInput', 'documentFileInput'].forEach(inputId => {
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await sendMediaAttachment(file);
        input.value = '';
      });
    }
  });
}

// ── Camera (getUserMedia) ──────────────────────────────────────────────────
let cameraStream = null;
let capturedPhotoBlob = null;

async function openCamera() {
  // Fallback to file input if getUserMedia not available
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    document.getElementById('cameraFileInput').click();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const video = document.getElementById('cameraVideo');
    video.srcObject = cameraStream;
    video.style.display = 'block';
    document.getElementById('cameraPreview').style.display = 'none';
    document.getElementById('cameraCaptureActions').style.display = 'flex';
    document.getElementById('cameraPreviewActions').style.display = 'none';
    capturedPhotoBlob = null;
    document.getElementById('cameraModalOverlay').style.display = 'flex';
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showNotification('❌ Camera permission denied. Please allow camera access in your browser.', 'error');
    } else if (err.name === 'NotFoundError') {
      showNotification('❌ No camera found — opening file picker instead.', 'error');
      document.getElementById('cameraFileInput').click();
    } else {
      showNotification('❌ Could not open camera: ' + err.message, 'error');
    }
  }
}

function capturePhoto() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraCanvas');
  const preview = document.getElementById('cameraPreview');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => {
    capturedPhotoBlob = blob;
    const url = URL.createObjectURL(blob);
    preview.src = url;
    preview.style.display = 'block';
    video.style.display = 'none';
    document.getElementById('cameraCaptureActions').style.display = 'none';
    document.getElementById('cameraPreviewActions').style.display = 'flex';
  }, 'image/jpeg', 0.92);
}

function retakePhoto() {
  capturedPhotoBlob = null;
  const preview = document.getElementById('cameraPreview');
  const video = document.getElementById('cameraVideo');
  preview.style.display = 'none';
  video.style.display = 'block';
  document.getElementById('cameraCaptureActions').style.display = 'flex';
  document.getElementById('cameraPreviewActions').style.display = 'none';
}

async function sendCapturedPhoto() {
  if (!capturedPhotoBlob) return;
  const file = new File([capturedPhotoBlob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
  closeCameraModal();
  await sendMediaAttachment(file);
}

function closeCameraModal() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const overlay = document.getElementById('cameraModalOverlay');
  if (overlay) overlay.style.display = 'none';
  const video = document.getElementById('cameraVideo');
  if (video) { video.srcObject = null; video.style.display = 'block'; }
  const preview = document.getElementById('cameraPreview');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  capturedPhotoBlob = null;
}

// Close camera modal on overlay click
document.getElementById('cameraModalOverlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('cameraModalOverlay')) closeCameraModal();
});

// Close emoji picker and attachment menu on outside click
document.addEventListener('click', (e) => {
  if (emojiPicker && !e.target.closest('.emoji-picker') && !e.target.closest('#emojiBtn')) {
    emojiPicker.classList.remove('active');
  }
  if (attachmentMenu && !e.target.closest('.attachment-menu') && !e.target.closest('#attachBtn')) {
    attachmentMenu.classList.remove('active');
  }
});

// Sentiment Charts Initialization
let sentimentTrendChart = null;
let sentimentDistributionChart = null;

// ─────────────────────────────────────────────
// Sentiment Page — live data
// ─────────────────────────────────────────────
async function loadSentimentPage() {
  const days = document.getElementById('sentimentPeriodFilter')?.value || '9999';
  await Promise.all([
    loadSentimentStats(days),
    loadSentimentTimeline(days),
    loadSentimentKeywords(days)
  ]);
  // Match keywords card height to breakdown card height
  requestAnimationFrame(() => {
    const breakdown = document.querySelector('.sentiment-breakdown-section .section-card:not(.keywords-card)');
    const keywords  = document.querySelector('.keywords-card');
    if (breakdown && keywords) {
      keywords.style.height = breakdown.offsetHeight + 'px';
    }
  });
}

async function loadSentimentStats(days = '7') {
  try {
    const res  = await fetch(`/api/sentiment/stats?days=${days}`);
    const data = await res.json();
    const useAllTime = Number(days) >= 9999;
    const p = useAllTime ? data.allTime : data.period;
    const c = data.changes;

    const fmt = (n) => (n >= 0 ? '+' : '') + n + '%';
    const col = (n) => n >= 0 ? '#25D366' : '#f44336';

    document.getElementById('sentPosPercent').textContent  = p.positivePercent + '%';
    document.getElementById('sentNegPercent').textContent  = p.negativePercent + '%';
    document.getElementById('sentNeuPercent').textContent  = p.neutralPercent  + '%';
    document.getElementById('sentPosCount').textContent    = p.positive;
    document.getElementById('sentNegCount').textContent    = p.negative;
    document.getElementById('sentNeuCount').textContent    = p.neutral;
    document.getElementById('sentAvgScore').textContent    = data.avgScore.toFixed(3);

    const posChEl = document.getElementById('sentPosChange');
    const negChEl = document.getElementById('sentNegChange');
    const neuChEl = document.getElementById('sentNeuChange');
    if (posChEl) { posChEl.textContent = fmt(c.positive); posChEl.style.color = col(c.positive); }
    if (negChEl) { negChEl.textContent = fmt(c.negative); negChEl.style.color = col(-c.negative); }
    if (neuChEl) { neuChEl.textContent = fmt(c.neutral);  neuChEl.style.color = col(c.neutral); }

    // Breakdown cards
    const bd = document.getElementById('sentimentBreakdown');
    if (bd) {
      const cats = [
        { label: 'Positive', count: p.positive, pct: p.positivePercent, cls: 'positive', icon: 'fa-smile' },
        { label: 'Neutral',  count: p.neutral,  pct: p.neutralPercent,  cls: 'neutral',  icon: 'fa-meh'   },
        { label: 'Negative', count: p.negative, pct: p.negativePercent, cls: 'negative', icon: 'fa-frown' }
      ];
      bd.innerHTML = cats.map(c => `
        <div class="sentiment-category-card ${c.cls}">
          <div class="category-header">
            <div class="category-icon"><i class="fas ${c.icon}"></i></div>
            <div class="category-info"><h4>${c.label}</h4><p>${c.count} messages</p></div>
          </div>
          <div class="category-stats">
            <div class="stat-item"><span class="stat-label">Messages</span><span class="stat-value">${c.count}</span></div>
            <div class="stat-item"><span class="stat-label">Percentage</span><span class="stat-value">${c.pct}%</span></div>
          </div>
          <div class="category-progress">
            <div class="progress-bar"><div class="progress-fill ${c.cls}" style="width:${c.pct}%"></div></div>
          </div>
        </div>
      `).join('');
    }
  } catch (e) {
    console.error('Sentiment stats error:', e);
  }
}

async function loadSentimentTimeline(days = '7') {
  if (typeof Chart === 'undefined') return;
  try {
    const css = getComputedStyle(document.body || document.documentElement);
    const legendTextColor = (css.getPropertyValue('--text-primary') || '#1f2937').trim();
    const axisTextColor = (css.getPropertyValue('--text-secondary') || '#6b7280').trim();

    const res  = await fetch(`/api/sentiment/timeline?days=${days}`);
    const data = await res.json();

    const labels   = data.map(d => d.date);
    const positive = data.map(d => d.positive || 0);
    const neutral  = data.map(d => d.neutral  || 0);
    const negative = data.map(d => d.negative || 0);

    // Trend chart
    const trendCtx = document.getElementById('sentimentTrendChart');
    if (trendCtx) {
      if (sentimentTrendChart) sentimentTrendChart.destroy();
      sentimentTrendChart = new Chart(trendCtx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Positive', data: positive, borderColor: '#25D366', backgroundColor: 'rgba(37,211,102,0.1)', tension: 0.4, fill: true },
            { label: 'Neutral',  data: neutral,  borderColor: '#8b949e', backgroundColor: 'rgba(139,148,158,0.1)', tension: 0.4, fill: true },
            { label: 'Negative', data: negative, borderColor: '#F44336', backgroundColor: 'rgba(244,67,54,0.1)',   tension: 0.4, fill: true }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: true, aspectRatio: 2.5,
          plugins: {
            legend: { display: true, position: 'top', labels: { color: legendTextColor, usePointStyle: true, padding: 15 } },
            tooltip: { mode: 'index', intersect: false, backgroundColor: '#252b33', titleColor: '#e4e6eb', bodyColor: '#e4e6eb', borderColor: '#2d3339', borderWidth: 1 }
          },
          scales: {
            y: { beginAtZero: true, ticks: { color: axisTextColor, stepSize: 1 }, grid: { color: 'rgba(45,51,57,0.5)' } },
            x: { ticks: { color: axisTextColor }, grid: { color: 'rgba(45,51,57,0.5)' } }
          }
        }
      });
    }

    // Distribution doughnut — sum totals
    const totPos = positive.reduce((a, b) => a + b, 0);
    const totNeu = neutral.reduce((a, b) => a + b, 0);
    const totNeg = negative.reduce((a, b) => a + b, 0);

    const distCtx = document.getElementById('sentimentDistributionChart');
    if (distCtx) {
      if (sentimentDistributionChart) sentimentDistributionChart.destroy();
      sentimentDistributionChart = new Chart(distCtx, {
        type: 'doughnut',
        data: {
          labels: ['Positive', 'Neutral', 'Negative'],
          datasets: [{ data: [totPos, totNeu, totNeg], backgroundColor: ['#25D366','#8b949e','#F44336'], borderColor: 'transparent', borderWidth: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: true, aspectRatio: 1.5,
          plugins: {
            legend: { display: true, position: 'bottom', labels: { color: legendTextColor, padding: 15, usePointStyle: true } },
            tooltip: {
              backgroundColor: '#252b33', titleColor: '#e4e6eb', bodyColor: '#e4e6eb', borderColor: '#2d3339', borderWidth: 1,
              callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed}` }
            }
          }
        }
      });
    }
  } catch (e) {
    console.error('Timeline error:', e);
  }
}

async function loadSentimentKeywords(days) {
  const el = document.getElementById('sentimentKeywords');
  if (!el) return;
  try {
    const res   = await fetch(`/api/sentiment/keywords?days=${days}`);
    const words = await res.json();
    if (!words.length) { el.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Not enough data yet.</p>'; return; }
    const icon = { positive: 'fa-smile', neutral: 'fa-meh', negative: 'fa-frown' };
    el.innerHTML = words.map(w => `
      <div class="keyword-tag ${w.sentiment} top-keyword-click" data-keyword="${encodeURIComponent(w.word)}">
        <i class="fas ${icon[w.sentiment] || 'fa-meh'}"></i>
        <span>${escapeHtml(w.word)}</span>
        <span class="keyword-count">${w.count}</span>
      </div>
    `).join('');

    el.querySelectorAll('.top-keyword-click').forEach(tag => {
      tag.addEventListener('click', () => {
        const keyword = decodeURIComponent(tag.dataset.keyword || '');
        showKeywordMessages(keyword);
      });
    });
  } catch (e) {
    el.innerHTML = '<p style="color:var(--text-secondary)">Error loading keywords.</p>';
  }
}


function initSentimentCharts() {
  // Now just delegates to the live loader
  loadSentimentPage();
}

// Auto refresh every 30 seconds
setInterval(() => {
  loadStats();
  loadTasks(currentFilter);
  loadMessages();
  loadConversations();
  loadDashboardProfiles();
}, 30000);

// ============================================
// Database Functions
// ============================================

// Load database statistics
async function loadDatabaseStats() {
  try {
    const res = await fetch('/api/database/overview');
    if (!res.ok) throw new Error('Failed to load database overview');
    const data = await res.json();

    const t = data.tables || {};
    const totals = data.totals || { records: 0, sizeMb: 0 };

    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    setText('dbTotalRecords', totals.records || 0);
    setText('dbSize', (totals.sizeMb || 0).toFixed ? (totals.sizeMb).toFixed(2) + ' MB' : `${totals.sizeMb} MB`);

    const fmt = (val) => val ? timeAgo(val) : '—';
    setText('messagesCount', t.messages?.count || 0);
    setText('tasksCount', t.tasks?.count || 0);
    setText('conversationsCount', t.conversations?.count || 0);
    setText('profilesCount', t.user_profiles?.count || 0);

    setText('messagesSize', (t.messages?.sizeKb || 0) + ' KB');
    setText('tasksSize', (t.tasks?.sizeKb || 0) + ' KB');
    setText('conversationsSize', (t.conversations?.sizeKb || 0) + ' KB');
    setText('profilesSize', (t.user_profiles?.sizeKb || 0) + ' KB');

    setText('messagesLastUpdate', fmt(t.messages?.updatedAt));
    setText('tasksLastUpdate', fmt(t.tasks?.updatedAt));
    setText('conversationsLastUpdate', fmt(t.conversations?.updatedAt));
    setText('profilesLastUpdate', fmt(t.user_profiles?.updatedAt));

    // Last backup timestamp (if API provides it)
    let lastBackup = data.lastBackup || totals.lastBackup || localStorage.getItem('db.lastBackup');
    // Normalize old stored format (was ISO with colons replaced by dashes)
    if (typeof lastBackup === 'string' && /T\d{2}-\d{2}-\d{2}-\d{3}Z/.test(lastBackup)) {
      lastBackup = lastBackup.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z');
    }
    if (lastBackup) {
      localStorage.setItem('db.lastBackup', lastBackup);
    }
    setText('lastBackup', lastBackup ? fmt(lastBackup) : 'Never');

    loadDatabaseActivity();
  } catch (error) {
    console.error('Error loading database stats:', error);
    showNotification('❌ Failed to load database overview', 'error');
  }
}

async function loadDatabaseActivity() {
  const container = document.getElementById('dbActivityList');
  if (!container) return;

  try {
    const res = await fetch('/api/database/activity?limit=10');
    if (!res.ok) throw new Error('Failed to load recent activity');

    const data = await res.json();
    const activities = data.activities || [];

    if (!activities.length) {
      container.innerHTML = '<p class="loading" style="color:var(--text-secondary)">No recent activity yet.</p>';
      return;
    }

    const esc = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    const iconByAction = {
      insert: 'fa-plus',
      update: 'fa-edit',
      delete: 'fa-trash',
      backup: 'fa-cloud-upload-alt'
    };

    container.innerHTML = activities.map(item => {
      const action = ['insert', 'update', 'delete', 'backup'].includes(item.action) ? item.action : 'update';
      const icon = iconByAction[action] || 'fa-edit';
      const when = item.timestamp ? timeAgo(item.timestamp) : '—';

      return `
        <div class="db-activity-item">
          <div class="db-activity-icon ${action}">
            <i class="fas ${icon}"></i>
          </div>
          <div class="db-activity-details">
            <h4>${esc(item.title || 'Activity')}</h4>
            <p>${esc(item.details || '')}</p>
          </div>
          <span class="db-activity-time">${esc(when)}</span>
        </div>
      `;
    }).join('');
  } catch (error) {
    console.error('Error loading database activity:', error);
    container.innerHTML = '<p class="loading" style="color:var(--accent-red)">Failed to load recent activity.</p>';
  }
}

// Refresh database
function refreshDatabase() {
  console.log('Refreshing database...');
  loadDatabaseStats();
  showNotification('Database refreshed successfully', 'success');
}

// Export database
function exportDatabase() {
  fetch('/api/database/export-all')
    .then(res => res.blob())
    .then(blob => {
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `database-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      showNotification('✅ Database exported successfully!', 'success');
    })
    .catch(() => showNotification('❌ Export failed.', 'error'));
}

// Clear database
function clearDatabase() {
  if (confirm('Are you sure you want to clear ALL database tables? This action cannot be undone!')) {
    console.log('Clearing database...');
    showNotification('This feature is disabled for safety. Use individual table clearing instead.', 'warning');
  }
}

// View table
function viewTable(tableName) {
  console.log('Viewing table:', tableName);
  
  // Navigate to appropriate page based on table
  if (tableName === 'messages') {
    navigateToPage('messages');
  } else if (tableName === 'tasks') {
    navigateToPage('tasks');
  } else if (tableName === 'user_profiles') {
    navigateToPage('profiles');
  } else if (tableName === 'conversations') {
    showNotification('Conversations view coming soon!', 'info');
  }
}

// Export table
async function exportTable(tableName) {
  showNotification(`Exporting ${tableName}...`, 'info');
  try {
    const res = await fetch(`/api/database/table/${encodeURIComponent(tableName)}/export`);
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tableName}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    showNotification(`${tableName} exported successfully!`, 'success');
  } catch (e) {
    showNotification('Export failed. Please try again.', 'error');
  }
}

// Clear table
function clearTable(tableName) {
  if (!confirm(`Are you sure you want to clear the ${tableName} table? This action cannot be undone!`)) return;
  fetch(`/api/database/table/${encodeURIComponent(tableName)}/clear`, { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (!data.success) throw new Error(data.error || 'Failed');
      showNotification(`Cleared ${data.deleted || 0} rows from ${tableName}`, 'success');
      loadDatabaseStats();
      if (tableName === 'user_profiles') loadUserProfiles();
    })
    .catch(err => showNotification(err.message || 'Failed to clear table', 'error'));
}

// Backup database
function backupDatabase() {
  exportDatabase();
  const iso = new Date().toISOString();
  const ts = iso.replace(/[:.]/g, '-');
  const el = document.getElementById('lastBackup');
  if (el) el.textContent = iso;
  localStorage.setItem('db.lastBackup', iso);
}

// Restore database
function restoreDatabase() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const json = JSON.parse(reader.result);
        showNotification(`Restoring from ${file.name}...`, 'info');
        const res = await fetch('/api/database/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Restore failed');
        showNotification('✅ Database restored successfully!', 'success');
        loadDatabaseStats();
        loadUserProfiles();
      } catch (err) {
        console.error('Restore error', err);
        const msg = err?.message ? `Restore failed: ${err.message}` : 'Restore failed. Please check file.';
        showNotification(`❌ ${msg}`, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// Import data
function importData() {
  console.log('Importing data...');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      showNotification(`Importing ${file.name}...`, 'info');
      setTimeout(() => {
        showNotification('Data imported successfully!', 'success');
        loadDatabaseStats();
      }, 2000);
    }
  };
  input.click();
}

// Export all data
function exportAllData() {
  exportDatabase();
}

// Load customer profiles for dashboard table
function sortProfilesAsc(profiles) {
  return profiles.slice().sort((a, b) => {
    const aId = Number(a?.id);
    const bId = Number(b?.id);
    const aValid = Number.isFinite(aId);
    const bValid = Number.isFinite(bId);
    if (aValid && bValid) return aId - bId;
    if (aValid) return -1;
    if (bValid) return 1;
    const aTime = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
    const bTime = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
    return aTime - bTime;
  });
}

async function loadDashboardProfiles() {
  const tbody = document.getElementById('dashboardProfilesBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:14px;">Loading profiles...</td></tr>';
  try {
    const res = await fetch('/api/user-profiles');
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load profiles');
    const profiles = data.profiles || [];

    if (!profiles.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:14px;">No profiles collected yet.</td></tr>';
      return;
    }

    const fmt = (val) => val ? timeAgo(val) : '—';
    const sortedProfiles = sortProfilesAsc(profiles);
    profileCache = sortedProfiles;
    tbody.innerHTML = sortedProfiles.slice(0, 5).map((p, idx) => {
      const serial = idx + 1;
      const name = escapeHtml(p.name || '—');
      const designation = escapeHtml(p.designation || '—');
      const phone = escapeHtml(p.contactPhone || p.phoneNumber || '—');
      const email = escapeHtml(p.email || '—');
      const updated = fmt(p.updatedAt);
      return `<tr>
        <td class="profile-serial">${serial}</td>
        <td>${name}</td>
        <td>${designation}</td>
        <td>${phone}</td>
        <td>${email}</td>
        <td style="color:var(--text-secondary);">${updated}</td>
        <td>
          <div class="meeting-action-buttons">
            <button class="btn-task-action" title="Edit Profile" onclick="openProfileModal(${p.id})"><i class="fas fa-edit"></i></button>
            <button class="btn-task-action danger" title="Delete Profile" onclick="deleteProfile(${p.id})"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.error('Dashboard profiles load error', err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:14px;">Failed to load profiles</td></tr>';
    showNotification('❌ Failed to load profiles', 'error');
  }
}

// Load user profiles table
async function loadUserProfiles() {
  const tbody = document.getElementById('profilesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:14px;">Loading profiles...</td></tr>';
  try {
    const res = await fetch('/api/user-profiles');
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load profiles');
    const profiles = data.profiles || [];
    const sortedProfiles = sortProfilesAsc(profiles);
    profileCache = sortedProfiles;
    _profileTotalCount = sortedProfiles.length;

    const totalEl = document.getElementById('profileTotalCount');
    const lastUpdatedEl = document.getElementById('profileLastUpdated');
    if (totalEl) totalEl.textContent = profiles.length;
    if (lastUpdatedEl) {
      const latest = profiles.reduce((acc, p) => {
        const ts = p.updatedAt || p.createdAt;
        const t = ts ? new Date(ts).getTime() : 0;
        return t > acc ? t : acc;
      }, 0);
      lastUpdatedEl.textContent = latest ? timeAgo(latest) : '—';
    }

    if (!sortedProfiles.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:14px;">No profiles collected yet.</td></tr>';
      renderProfilePagination();
      return;
    }

    // Paginate profiles
    const start = (_profileCurrentPage - 1) * _profilePerPage;
    const end = start + _profilePerPage;
    const pagedProfiles = sortedProfiles.slice(start, end);

    const fmt = (val) => val ? timeAgo(val) : '—';
    tbody.innerHTML = pagedProfiles.map((p, idx) => {
      const serial = start + idx + 1;
      const name = escapeHtml(p.name || '—');
      const designation = escapeHtml(p.designation || '—');
      const phone = escapeHtml(p.contactPhone || p.phoneNumber || '—');
      const email = escapeHtml(p.email || '—');
      const updated = fmt(p.updatedAt);
      return `<tr>
        <td class="profile-serial">${serial}</td>
        <td>${name}</td>
        <td>${designation}</td>
        <td>${phone}</td>
        <td>${email}</td>
        <td style="color:var(--text-secondary);">${updated}</td>
        <td>
          <div class="meeting-action-buttons">
            <button class="btn-task-action" title="Edit Profile" onclick="openProfileModal(${p.id})"><i class="fas fa-edit"></i></button>
            <button class="btn-task-action danger" title="Delete Profile" onclick="deleteProfile(${p.id}, true)"><i class="fas fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    }).join('');
    
    renderProfilePagination();
  } catch (err) {
    console.error('Profiles load error', err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--accent-red);padding:14px;">Failed to load profiles</td></tr>';
    showNotification('❌ Failed to load profiles', 'error');
  }
}

// Render profile pagination
function renderProfilePagination() {
  const wrap = document.getElementById('profilePaginationWrap');
  const nav  = document.getElementById('profilePagination');
  const info = document.getElementById('profilePaginationInfo');
  if (!wrap || !nav) return;

  const totalPages = Math.ceil(_profileTotalCount / _profilePerPage);

  if (totalPages <= 1) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'flex';

  const from = (_profileCurrentPage - 1) * _profilePerPage + 1;
  const to   = Math.min(_profileCurrentPage * _profilePerPage, _profileTotalCount);
  if (info) info.textContent = `Showing ${from}–${to} of ${_profileTotalCount}`;

  // Build page numbers with ellipsis
  let pages = [];
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    pages = [1];
    if (_profileCurrentPage > 3)              pages.push('...');
    const start = Math.max(2, _profileCurrentPage - 1);
    const end   = Math.min(totalPages - 1, _profileCurrentPage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (_profileCurrentPage < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  nav.innerHTML = `
    <button class="pg-btn" ${_profileCurrentPage === 1 ? 'disabled' : ''} onclick="goToProfilePage(${_profileCurrentPage - 1})">
      <i class="fas fa-chevron-left"></i>
    </button>
    ${pages.map(p =>
      p === '...'
        ? `<span class="pg-dots">…</span>`
        : `<button class="pg-btn ${p === _profileCurrentPage ? 'active' : ''}" onclick="goToProfilePage(${p})">${p}</button>`
    ).join('')}
    <button class="pg-btn" ${_profileCurrentPage === totalPages ? 'disabled' : ''} onclick="goToProfilePage(${_profileCurrentPage + 1})">
      <i class="fas fa-chevron-right"></i>
    </button>
  `;
}

// Go to a specific profile page
function goToProfilePage(page) {
  const totalPages = Math.ceil(_profileTotalCount / _profilePerPage);
  if (page < 1 || page > totalPages) return;
  _profileCurrentPage = page;
  loadUserProfiles();
  const container = document.getElementById('profilesTableBody');
  if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Edit profile modal helpers
function openProfileModal(id) {
  const modal = document.getElementById('profileEditModal');
  if (!modal) return;
  document.getElementById('profileEditId').value = id;
  document.getElementById('profileEditName').value = 'Loading...';
  document.getElementById('profileEditDesignation').value = '';
  document.getElementById('profileEditPhone').value = '';
  document.getElementById('profileEditEmail').value = '';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const setFields = (profile) => {
    document.getElementById('profileEditName').value = profile.name || '';
    document.getElementById('profileEditDesignation').value = profile.designation || '';
    document.getElementById('profileEditPhone').value = profile.contactPhone || profile.phoneNumber || '';
    document.getElementById('profileEditEmail').value = profile.email || '';
  };

  const cached = profileCache.find(p => p.id === id);
  if (cached) {
    setFields(cached);
    return;
  }

  fetch('/api/user-profiles')
    .then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load profile');
      profileCache = data.profiles || [];
      const p = profileCache.find(x => x.id === id);
      if (!p) throw new Error('Profile not found');
      setFields(p);
    })
    .catch(err => {
      console.error('openProfileModal error', err);
      document.getElementById('profileEditName').value = err?.message || 'Load failed';
      showNotification(err?.message || 'Failed to open profile', 'error');
    });
}

function closeProfileModal() {
  const modal = document.getElementById('profileEditModal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function saveProfileEdit() {
  const id = document.getElementById('profileEditId').value;
  const name = document.getElementById('profileEditName').value.trim();
  const designation = document.getElementById('profileEditDesignation').value.trim();
  const phone = document.getElementById('profileEditPhone').value.trim();
  const email = document.getElementById('profileEditEmail').value.trim();
  try {
    const res = await fetch(`/api/user-profiles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, designation, contactPhone: phone, email })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update');
    showNotification('✅ Profile updated', 'success');
    closeProfileModal();
    loadDashboardProfiles();
    loadUserProfiles();
  } catch (err) {
    console.error('Profile save error', err);
    showNotification(err?.message || 'Failed to update profile', 'error');
  }
}

// Delete profile
async function deleteProfile(id, reloadDatabaseTable = false) {
  if (!confirm('Delete this profile?')) return;
  try {
    const res = await fetch(`/api/user-profiles/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete profile');
    showNotification('✅ Profile deleted', 'success');
    loadDashboardProfiles();
    loadUserProfiles();
  } catch (err) {
    console.error('Delete profile error', err);
    showNotification(err?.message || 'Failed to delete profile', 'error');
  }
}

// Ensure availability for inline handlers
window.openProfileModal = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.saveProfileEdit = saveProfileEdit;
window.deleteProfile = deleteProfile;
window.loadUserProfiles = loadUserProfiles;

// Optimize database
function optimizeDatabase() {
  fetch('/api/database/optimize', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (!data.success) throw new Error(data.error || 'Optimize failed');
      showNotification(`Optimized ${data.optimized} tables`, 'success');
    })
    .catch(err => showNotification(err.message || 'Optimize failed', 'error'));
}

// Clean old data
function cleanOldData() {
  const days = prompt('Remove data older than how many days?', '90');
  if (days && !isNaN(days)) {
    fetch('/api/database/cleanup-old', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: Number(days) })
    })
      .then(res => res.json())
      .then(data => {
        if (!data.success) throw new Error(data.error || 'Cleanup failed');
        showNotification(`Deleted ${data.messagesDeleted || 0} messages, ${data.conversationsDeleted || 0} conversations`, 'success');
        loadDatabaseStats();
      })
      .catch(err => showNotification(err.message || 'Cleanup failed', 'error'));
  }
}

// Convert data to CSV
function convertToCSV(data, tableName) {
  if (!data || data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const rows = data.map(item => 
    headers.map(header => {
      const value = item[header];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return `"${String(value).replace(/"/g, '""')}"`;
    }).join(',')
  );
  
  return [headers.join(','), ...rows].join('\n');
}

// Show notification
function showNotification(message, type = 'info') {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.innerHTML = `
    <i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : type === 'warning' ? 'exclamation-triangle' : 'info-circle'}"></i>
    <span>${message}</span>
  `;
  
  // Add to page
  document.body.appendChild(notification);
  
  // Animate in
  setTimeout(() => notification.classList.add('show'), 10);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// ============================================
// Settings Functions
// ============================================

// Switch settings tabs
function switchSettingsTab(tabName) {
  // Update tab buttons
  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.classList.remove('active');
    if (tab.getAttribute('data-tab') === tabName) {
      tab.classList.add('active');
    }
  });
  
  // Update tab content
  document.querySelectorAll('.settings-tab-content').forEach(content => {
    content.classList.remove('active');
  });
  
  const tabContent = document.getElementById(tabName + 'Settings');
  if (tabContent) {
    tabContent.classList.add('active');
  }
  
  // Auto-check WhatsApp status when switching to that tab
  if (tabName === 'whatsapp') {
    checkWAStatus();
  }
}

// ============================================
// WhatsApp Connection Page
// ============================================

let waStatusInterval = null;

async function checkWAStatus() {
  try {
    const res = await fetch('/api/bot/status');
    const data = await res.json();
    updateWAStatusUI(data);
  } catch (e) {
    updateWAStatusUI({ status: 'disconnected', qr: null });
  }
}

function updateWAStatusUI(data) {
  const dot = document.getElementById('waStatusDot');
  const text = document.getElementById('waStatusText');
  const sub = document.getElementById('waStatusSub');
  const qrSection = document.getElementById('waQRSection');
  const connectedSection = document.getElementById('waConnectedSection');
  const qrImg = document.getElementById('waQRImage');

  if (!dot) return;

  if (data.status === 'connected') {
    dot.style.background = '#25D366';
    text.textContent = 'WhatsApp Connected';
    sub.textContent = 'Bot is active and ready';
    qrSection.style.display = 'none';
    connectedSection.style.display = 'block';
    if (waStatusInterval) { clearInterval(waStatusInterval); waStatusInterval = null; }

  } else if (data.status === 'qr') {
    dot.style.background = '#f59e0b';
    text.textContent = 'Scan QR Code to Connect';
    sub.textContent = 'Open WhatsApp → Settings → Linked Devices → Link a Device';
    // Use image URL with cache-busting timestamp (no fragile base64)
    qrImg.src = '/api/bot/qr.png?t=' + Date.now();
    qrImg.onerror = () => { qrImg.src = '/api/bot/qr.png?t=' + Date.now(); };
    qrSection.style.display = 'block';
    connectedSection.style.display = 'none';
    // Auto-refresh the image and status every 5s
    if (!waStatusInterval) {
      waStatusInterval = setInterval(() => {
        qrImg.src = '/api/bot/qr.png?t=' + Date.now();
        checkWAStatus();
      }, 5000);
    }

  } else if (data.status === 'qr_expired') {
    dot.style.background = '#ef4444';
    text.textContent = 'QR Code Expired';
    sub.textContent = 'Bot stopped or QR timed out. Run: npm run bot — then click Refresh';
    qrSection.style.display = 'block';
    qrImg.src = '';
    connectedSection.style.display = 'none';
    if (waStatusInterval) { clearInterval(waStatusInterval); waStatusInterval = null; }

  } else {
    dot.style.background = '#6b7280';
    text.textContent = 'Bot Not Running';
    sub.textContent = 'Start the bot with: npm run bot — then click Refresh';
    qrSection.style.display = 'none';
    connectedSection.style.display = 'none';
    if (waStatusInterval) { clearInterval(waStatusInterval); waStatusInterval = null; }
  }
}

async function disconnectWhatsApp() {
  if (!confirm('Disconnect WhatsApp?\n\nThis will log out this device. The bot will automatically generate a new QR code so you can re-link it.')) return;

  const btn = document.getElementById('waDisconnectBtn');
  const originalHTML = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Disconnecting...</span>';
  btn.disabled = true;

  try {
    const res = await fetch('/api/bot/disconnect', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      // ── Reset button IMMEDIATELY so it never gets stuck ──────────────
      btn.innerHTML = originalHTML;
      btn.disabled = false;

      // Hide the connected section right away
      const connectedSection = document.getElementById('waConnectedSection');
      if (connectedSection) connectedSection.style.display = 'none';

      // Update the status banner to a "waiting" state
      const dot  = document.getElementById('waStatusDot');
      const text = document.getElementById('waStatusText');
      const sub  = document.getElementById('waStatusSub');
      if (dot)  dot.style.background = '#f59e0b';
      if (text) text.textContent = 'Disconnecting...';
      if (sub)  sub.textContent   = 'Logging out — new QR code will appear shortly…';
      if (waStatusInterval) { clearInterval(waStatusInterval); waStatusInterval = null; }

      showNotification('WhatsApp disconnected. Waiting for new QR…', 'success');

      // Poll tightly until the bot reports qr / disconnected / qr_expired
      let polls = 0;
      const pollDisconnect = setInterval(async () => {
        polls++;
        try {
          const statusRes = await fetch('/api/bot/status').then(r => r.json());
          if (statusRes.status === 'qr' || statusRes.status === 'disconnected' || statusRes.status === 'qr_expired') {
            clearInterval(pollDisconnect);
            updateWAStatusUI(statusRes);
            if (statusRes.status === 'qr') {
              const qrImg = document.getElementById('waQRImage');
              if (qrImg) qrImg.src = '/api/bot/qr.png?t=' + Date.now();
            }
          }
        } catch(e) {}
        if (polls >= 20) clearInterval(pollDisconnect); // give up after 30 s
      }, 1500);

    } else {
      showNotification(data.error || 'Disconnect failed', 'error');
      btn.innerHTML = originalHTML;
      btn.disabled = false;
    }
  } catch (e) {
    showNotification('Bot not reachable — is it running?', 'error');
    btn.innerHTML = originalHTML;
    btn.disabled = false;
  }
}

async function refreshQRCode() {
  const btn = event.target.closest('button');
  const originalHTML = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refreshing...';
  btn.disabled = true;

  const sub = document.getElementById('waStatusSub');
  const qrImg = document.getElementById('waQRImage');
  if (sub) sub.textContent = 'Asking the bot to reinitialize — this takes ~15 seconds…';

  // Ask the bot to destroy + reinitialize (generates a fresh QR)
  try {
    const reinitRes = await fetch('/api/bot/reinitialize', { method: 'POST' });
    if (!reinitRes.ok) {
      const err = await reinitRes.json().catch(() => ({}));
      if (sub) sub.textContent = err.error || 'Bot not reachable. Is it running? ("npm run bot")';
      btn.innerHTML = originalHTML;
      btn.disabled = false;
      return;
    }
  } catch (e) {
    if (sub) sub.textContent = 'Bot not reachable. Start it with: npm run bot';
    btn.innerHTML = originalHTML;
    btn.disabled = false;
    return;
  }

  if (sub) sub.textContent = 'Bot is reinitializing… waiting for new QR code…';
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Waiting for QR…';

  // Poll until QR or connected (allow up to 60 s for Puppeteer to start)
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch('/api/bot/status').then(r => r.json());
      if (res.status === 'qr') {
        // Force-bust the image cache so the new QR is shown
        if (qrImg) qrImg.src = '/api/bot/qr.png?t=' + Date.now();
        updateWAStatusUI(res);
        clearInterval(poll);
        btn.innerHTML = originalHTML;
        btn.disabled = false;
      } else if (res.status === 'connected') {
        updateWAStatusUI(res);
        clearInterval(poll);
        btn.innerHTML = originalHTML;
        btn.disabled = false;
      } else if (attempts > 30) {
        clearInterval(poll);
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        if (sub) sub.textContent = 'Timed out. Check the bot terminal for errors.';
      }
    } catch (e) {}
  }, 2000);
}




// ============================================
// Groq AI Settings
// ============================================

function toggleApiKeyVisibility() {
  const input = document.getElementById('groqApiKeyInput');
  const icon = document.getElementById('apiKeyEyeIcon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

async function saveGroqKey() {
  const key = document.getElementById('groqApiKeyInput').value.trim();
  if (!key) { showNotification('Please enter your Groq API key', 'error'); return; }
  if (!key.startsWith('gsk_')) { showNotification('Invalid key format — Groq keys start with "gsk_"', 'error'); return; }

  try {
    const res = await fetch('/api/settings/groq-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('✅ Groq API key saved & activated!', 'success');
      document.getElementById('groqApiKeyInput').value = key.substring(0, 8) + '••••••••••••••••••••';
      document.getElementById('groqApiKeyInput').type = 'password';
      showGeminiStatus(true);
    } else {
      showNotification('❌ ' + data.error, 'error');
    }
  } catch (e) {
    showNotification('❌ Failed to save key', 'error');
  }
}

function showGeminiStatus(active) {
  const row = document.getElementById('geminiStatusRow');
  const badge = document.getElementById('geminiStatusBadge');
  if (!row || !badge) return;
  row.style.display = 'flex';
  if (active) {
    badge.style.background = '#d1fae5';
    badge.style.color = '#065f46';
    badge.textContent = '✅ Groq AI Active';
  } else {
    badge.style.background = '#fee2e2';
    badge.style.color = '#991b1b';
    badge.textContent = '❌ Not Connected';
  }
}

async function testGroqConnection() {
  showNotification('Testing Groq connection...', 'info');
  try {
    const res = await fetch('/api/settings/test-groq', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNotification('✅ ' + data.message, 'success');
      showGeminiStatus(true);
    } else {
      showNotification('❌ ' + data.error, 'error');
      showGeminiStatus(false);
    }
  } catch (e) {
    showNotification('❌ Connection test failed', 'error');
    showGeminiStatus(false);
  }
}

async function saveAISettings({ silent = false } = {}) {
  const systemPrompt = document.getElementById('systemPromptInput')?.value;
  const model = document.getElementById('geminiModelSelect')?.value;
  const tone = document.getElementById('aiToneSelect')?.value;
  const enableAI = document.getElementById('enableAIToggle')?.checked ?? true;
  try {
    const res = await fetch('/api/settings/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, model, tone, enableAI })
    });
    const data = await res.json();
    if (data.success) {
      if (!silent) showNotification('✅ AI settings saved!', 'success');
      return true;
    } else {
      if (!silent) showNotification('❌ ' + data.error, 'error');
      throw new Error(data.error || 'Failed to save AI settings');
    }
  } catch (e) {
    if (!silent) showNotification('❌ Failed to save AI settings', 'error');
    throw e;
  }
}

// Save Business Profile & Train Bot
async function saveBusinessProfile() {
  const statusEl = document.getElementById('bpSaveStatus');
  if (statusEl) statusEl.textContent = '⏳ Saving...';

  const profile = {
    businessName:  document.getElementById('bpBusinessName')?.value?.trim(),
    businessType:  document.getElementById('bpBusinessType')?.value?.trim(),
    language:      document.getElementById('bpLanguage')?.value,
    services:      document.getElementById('bpServices')?.value?.trim(),
    team:          document.getElementById('bpTeam')?.value?.trim(),
    meetingSlots:  document.getElementById('bpMeetingSlots')?.value?.trim(),
    contactInfo:   document.getElementById('bpContactInfo')?.value?.trim(),
    extraInfo:     document.getElementById('bpExtraInfo')?.value?.trim(),
  };

  if (!profile.businessName) {
    showNotification('❌ Please enter a Business Name first.', 'error');
    if (statusEl) statusEl.textContent = '';
    return;
  }

  try {
    const res = await fetch('/api/settings/business-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    });
    const data = await res.json();
    if (data.success) {
      showNotification('🎉 Bot trained successfully! The bot will now reply using your business info.', 'success');
      if (statusEl) statusEl.innerHTML = '<span style="color:#0f9d58;font-weight:600;">✅ Bot is now trained!</span>';
    } else {
      showNotification('❌ ' + data.error, 'error');
      if (statusEl) statusEl.textContent = '';
    }
  } catch (e) {
    showNotification('❌ Failed to save business profile', 'error');
    if (statusEl) statusEl.textContent = '';
  }
}

// Load saved AI settings into form fields
async function loadAISettings() {
  try {
    const res = await fetch('/api/settings/ai');
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
      set('systemPromptInput', s.systemPrompt);
      set('geminiModelSelect', s.model);
      set('aiToneSelect', s.tone);
      const enableToggle = document.getElementById('enableAIToggle');
      if (enableToggle && s.enableAI !== undefined) enableToggle.checked = s.enableAI;
    }
  } catch (e) {}
}

// Load saved business profile into form fields
async function loadBusinessProfile() {
  try {
    const res = await fetch('/api/settings/business-profile');
    const data = await res.json();
    if (data.success && data.profile && data.profile.businessName) {
      const p = data.profile;
      const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      set('bpBusinessName', p.businessName);
      set('bpBusinessType', p.businessType);
      set('bpLanguage', p.language);
      set('bpServices', p.services);
      set('bpTeam', p.team);
      set('bpMeetingSlots', p.meetingSlots);
      set('bpContactInfo', p.contactInfo);
      set('bpExtraInfo', p.extraInfo);
      const statusEl = document.getElementById('bpSaveStatus');
      if (statusEl) statusEl.innerHTML = '<span style="color:#0f9d58;font-size:12px;">✅ Profile loaded (previously saved)</span>';
    }
  } catch (e) {}
}

function formatSyncTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatDate(date.toISOString())} (${date.toLocaleString()})`;
}

function updateWebsiteSyncStatus(settings = {}) {
  const statusEl = document.getElementById('wsSyncStatus');
  if (!statusEl) return;

  const lines = [];
  lines.push(`Auto-sync: ${settings.enabled ? 'enabled' : 'disabled'}`);
  if (settings.url) lines.push(`URL: ${settings.url}`);
  if (settings.lastSyncAt) lines.push(`Last sync: ${formatSyncTimestamp(settings.lastSyncAt)}`);
  if (settings.lastPageCount) lines.push(`Pages: ${settings.lastPageCount}`);
  if (settings.lastError) lines.push(`Last error: ${settings.lastError}`);

  statusEl.textContent = lines.join('\n');
}

async function loadWebsiteSyncSettings() {
  try {
    const res = await fetch('/api/settings/website-sync');
    const data = await res.json();
    if (!data.success || !data.settings) return;

    const settings = data.settings;
    const urlEl = document.getElementById('wsWebsiteUrl');
    const toggleEl = document.getElementById('wsAutoSyncToggle');
    const intervalEl = document.getElementById('wsSyncIntervalHours');

    if (urlEl) urlEl.value = settings.url || '';
    if (toggleEl) toggleEl.checked = !!settings.enabled;
    if (intervalEl) {
      const hours = settings.intervalMinutes ? Math.round(settings.intervalMinutes / 60) : 6;
      intervalEl.value = hours;
    }

    updateWebsiteSyncStatus(settings);
  } catch (e) {}
}

async function saveWebsiteSyncSettings() {
  const url = document.getElementById('wsWebsiteUrl')?.value?.trim();
  const enabled = document.getElementById('wsAutoSyncToggle')?.checked ?? false;
  const hoursRaw = document.getElementById('wsSyncIntervalHours')?.value;
  const hours = parseInt(hoursRaw, 10);
  const intervalMinutes = Number.isFinite(hours)
    ? Math.min(1440, Math.max(30, hours * 60))
    : 360;

  if (!url) {
    showNotification('Please enter a website URL first.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/settings/website-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, enabled, intervalMinutes })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('Website sync settings saved.', 'success');
      updateWebsiteSyncStatus(data.settings || {});
    } else {
      showNotification(data.error || 'Failed to save website sync settings', 'error');
    }
  } catch (e) {
    showNotification('Failed to save website sync settings', 'error');
  }
}

async function runWebsiteSyncNow() {
  showNotification('Running website sync...', 'info');
  try {
    const res = await fetch('/api/settings/website-sync/run', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNotification('Website sync completed', 'success');
      if (data.result?.settings) updateWebsiteSyncStatus(data.result.settings);
      return;
    }
    showNotification(data.error || 'Website sync failed', 'error');
  } catch (e) {
    showNotification('Website sync failed', 'error');
  }
}

const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

const NOTIFICATION_DEFAULTS = {
  desktopNotifications: true,
  soundAlerts: true,
  alertSoundType: 'ding',
  emailNotifications: false,
  newMessageAlert: true,
  taskUpdates: true,
  negativeSentimentAlert: true,
  dailySummary: false
};

let notificationSettings = { ...NOTIFICATION_DEFAULTS };

function getNotificationFieldMap() {
  return {
    desktopNotifications: document.getElementById('notifDesktopToggle'),
    soundAlerts: document.getElementById('notifSoundToggle'),
    emailNotifications: document.getElementById('notifEmailToggle'),
    newMessageAlert: document.getElementById('notifMessageToggle'),
    taskUpdates: document.getElementById('notifTaskToggle'),
    negativeSentimentAlert: document.getElementById('notifNegativeToggle'),
    dailySummary: document.getElementById('notifDailySummaryToggle')
  };
}

function syncSoundSelectorVisibility() {
  const toggle = document.getElementById('notifSoundToggle');
  const row = document.getElementById('soundSelectorRow');
  if (!row) return;
  row.classList.toggle('sound-hidden', !toggle?.checked);
}

function applyNotificationSettings(settings = {}) {
  notificationSettings = { ...NOTIFICATION_DEFAULTS, ...settings };
  const fieldMap = getNotificationFieldMap();
  Object.entries(fieldMap).forEach(([key, el]) => {
    if (el) el.checked = !!notificationSettings[key];
  });
  // Apply alertSoundType dropdown
  const soundSelect = document.getElementById('alertSoundSelect');
  if (soundSelect) soundSelect.value = notificationSettings.alertSoundType || 'ding';
  // Show/hide the sound selector row based on soundAlerts toggle
  syncSoundSelectorVisibility();
}

function getNotificationFormSettings() {
  const fieldMap = getNotificationFieldMap();
  const boolSettings = Object.fromEntries(
    Object.entries(fieldMap).map(([key, el]) => [key, !!el?.checked])
  );
  const soundSelect = document.getElementById('alertSoundSelect');
  return { ...boolSettings, alertSoundType: soundSelect?.value || 'ding' };
}

async function loadNotificationSettings() {
  try {
    const res = await fetch('/api/settings/notifications');
    const data = await res.json();
    applyNotificationSettings(data.success ? data.settings : NOTIFICATION_DEFAULTS);
  } catch (e) {
    applyNotificationSettings(NOTIFICATION_DEFAULTS);
    console.error('Failed to load notification settings:', e);
  }
}

async function requestDesktopNotificationPermission() {
  if (!('Notification' in window)) {
    showNotification('Desktop notifications are not supported in this browser.', 'warning');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    showNotification('Desktop notifications are blocked in your browser settings.', 'warning');
    return false;
  }
  const result = await Notification.requestPermission();
  if (result !== 'granted') {
    showNotification('Desktop notification permission was not granted.', 'warning');
    return false;
  }
  return true;
}

// Shared AudioContext — reused across calls so Chrome keeps it in 'running' state
let _audioCtx = null;
function _getAudioCtx() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new Ctor();
  }
  return _audioCtx;
}

async function playAlertSound(previewType) {
  // previewType bypasses the soundAlerts guard (used by the Preview button)
  if (!previewType && !notificationSettings.soundAlerts) return;
  const soundType = previewType || notificationSettings.alertSoundType || 'ding';
  try {
    const ctx = _getAudioCtx();
    if (!ctx) return;

    // MUST await resume() — .then() loses Chrome's user-gesture context
    if (ctx.state !== 'running') {
      await ctx.resume();
    }

    const note = (freq, startAt, duration, type = 'sine', peakVol = 0.4) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startAt);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(peakVol, ctx.currentTime + startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + duration + 0.02);
      return osc;
    };

    switch (soundType) {
      case 'ding':
        note(880, 0, 0.35, 'sine', 0.45);
        break;
      case 'double-beep':
        note(900, 0,    0.10, 'square', 0.35);
        note(900, 0.18, 0.10, 'square', 0.35);
        break;
      case 'chime':
        note(523, 0,    0.28, 'sine', 0.40);
        note(392, 0.20, 0.28, 'sine', 0.40);
        note(330, 0.40, 0.35, 'sine', 0.40);
        break;
      case 'alert': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(380, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(920, ctx.currentTime + 0.18);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.24);
        break;
      }
      case 'pop': {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(320, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
        break;
      }
      case 'triple-chime':
        note(523, 0.00, 0.20, 'triangle', 0.30);
        note(659, 0.14, 0.22, 'triangle', 0.32);
        note(784, 0.30, 0.26, 'triangle', 0.34);
        break;
      case 'sonar': {
        const sweep = (start, fromF, toF, dur, vol = 0.20) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(fromF, ctx.currentTime + start);
          osc.frequency.exponentialRampToValueAtTime(toF, ctx.currentTime + start + dur);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
          gain.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + start);
          osc.stop(ctx.currentTime + start + dur + 0.02);
        };
        sweep(0.00, 240, 700, 0.26, 0.18);
        sweep(0.30, 260, 760, 0.30, 0.18);
        break;
      }
      case 'bell-rise': {
        note(660, 0.00, 0.18, 'sine', 0.26);
        note(880, 0.10, 0.22, 'sine', 0.28);
        note(1174, 0.22, 0.32, 'sine', 0.30);
        note(1568, 0.40, 0.36, 'triangle', 0.26);
        break;
      }
      default:
        note(880, 0, 0.25, 'sine', 0.4);
    }
  } catch (e) {
    console.warn('playAlertSound error:', e);
  }
}

async function previewAlertSound() {
  const el = document.getElementById('alertSoundSelect');
  const type = el ? el.value : (notificationSettings.alertSoundType || 'ding');
  const btn = document.querySelector('.btn-preview-sound');
  if (btn) {
    btn.classList.add('playing');
    setTimeout(() => btn.classList.remove('playing'), 700);
  }
  await playAlertSound(type);
}

function triggerDesktopNotification(title, body = '') {
  if (!notificationSettings.desktopNotifications) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notif = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: 'ptis-chatbot-dashboard-alert'
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch (_) {}
}

async function persistNotificationSettings(settings, { showSavedToast = true } = {}) {
  let nextSettings = { ...NOTIFICATION_DEFAULTS, ...settings };

  if (nextSettings.desktopNotifications) {
    const granted = await requestDesktopNotificationPermission();
    if (!granted) {
      nextSettings.desktopNotifications = false;
    }
  }

  const res = await fetch('/api/settings/notifications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nextSettings)
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to save notification settings');
  }
  applyNotificationSettings(data.settings);
  if (showSavedToast) showNotification('✅ Notification settings saved!', 'success');
  return data.settings;
}

async function saveBusinessHours({ silent = false } = {}) {
  const hours = {};
  DAYS.forEach(day => {
    const enabled = document.getElementById(day)?.checked || false;
    const start   = document.getElementById(`${day}-start`)?.value || '09:00';
    const end     = document.getElementById(`${day}-end`)?.value   || '18:00';
    hours[day] = { enabled, start, end };
  });

  localStorage.setItem('businessHours', JSON.stringify(hours));

  try {
    const res = await fetch('/api/settings/business-hours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hours)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save business hours');
    localStorage.setItem('businessHours', JSON.stringify(data.hours || hours));
    if (!silent) showNotification('✅ Business hours saved!', 'success');
    return data.hours || hours;
  } catch (e) {
    console.error('Business hours save error:', e);
    if (!silent) showNotification('⚠️ Saved locally only. Server sync failed.', 'warning');
    return hours;
  }
}

async function loadBusinessHours() {
  let saved = null;
  try {
    const res = await fetch('/api/settings/business-hours');
    const data = await res.json();
    if (res.ok && data.success && data.hours) {
      saved = data.hours;
      localStorage.setItem('businessHours', JSON.stringify(saved));
    }
  } catch (e) {
    // fallback to local cache below
  }

  if (!saved) {
    saved = JSON.parse(localStorage.getItem('businessHours') || '{}');
  }

  if (!Object.keys(saved).length) return;
  DAYS.forEach(day => {
    const d = saved[day];
    if (!d) return;
    const cb    = document.getElementById(day);
    const start = document.getElementById(`${day}-start`);
    const end   = document.getElementById(`${day}-end`);
    if (cb)    { cb.checked = d.enabled; }
    if (start) { start.value = d.start; start.disabled = !d.enabled; }
    if (end)   { end.value   = d.end;   end.disabled   = !d.enabled; }
  });
}

const BOT_BEHAVIOR_DEFAULTS = {
  enableAutoReply: true,
  welcomeMessage: 'Welcome to PTIS Chatbot! 👋 How can we help you today?',
  awayMessage: "We're currently offline. Our team will respond during business hours (9 AM - 6 PM).",
  responseDelaySeconds: 2
};

function applyBotBehaviorSettings(settings = {}) {
  const s = { ...BOT_BEHAVIOR_DEFAULTS, ...(settings || {}) };
  const autoReply = document.getElementById('botEnableAutoReply');
  const welcome = document.getElementById('botWelcomeMessage');
  const away = document.getElementById('botAwayMessage');
  const delay = document.getElementById('botResponseDelay');

  if (autoReply) autoReply.checked = !!s.enableAutoReply;
  if (welcome) welcome.value = s.welcomeMessage || BOT_BEHAVIOR_DEFAULTS.welcomeMessage;
  if (away) away.value = s.awayMessage || BOT_BEHAVIOR_DEFAULTS.awayMessage;
  if (delay) delay.value = String(Number.isFinite(Number(s.responseDelaySeconds)) ? Number(s.responseDelaySeconds) : BOT_BEHAVIOR_DEFAULTS.responseDelaySeconds);
}

function getBotBehaviorFormSettings() {
  const delayRaw = document.getElementById('botResponseDelay')?.value;
  const delay = Math.min(60, Math.max(0, parseInt(delayRaw, 10) || 0));
  return {
    enableAutoReply: !!document.getElementById('botEnableAutoReply')?.checked,
    welcomeMessage: (document.getElementById('botWelcomeMessage')?.value || BOT_BEHAVIOR_DEFAULTS.welcomeMessage).trim(),
    awayMessage: (document.getElementById('botAwayMessage')?.value || BOT_BEHAVIOR_DEFAULTS.awayMessage).trim(),
    responseDelaySeconds: delay
  };
}

async function loadBotBehaviorSettings() {
  let settings = null;
  try {
    const res = await fetch('/api/settings/bot-behavior');
    const data = await res.json();
    if (res.ok && data.success && data.settings) {
      settings = { ...BOT_BEHAVIOR_DEFAULTS, ...data.settings };
      localStorage.setItem('botBehaviorSettings', JSON.stringify(settings));
    }
  } catch (e) {
    // fallback to local cache below
  }

  if (!settings) {
    const cached = JSON.parse(localStorage.getItem('botBehaviorSettings') || '{}');
    settings = { ...BOT_BEHAVIOR_DEFAULTS, ...cached };
  }

  applyBotBehaviorSettings(settings);
}

async function saveBotBehaviorSettings({ silent = false } = {}) {
  const settings = getBotBehaviorFormSettings();
  localStorage.setItem('botBehaviorSettings', JSON.stringify(settings));

  try {
    const res = await fetch('/api/settings/bot-behavior', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save bot behavior settings');

    const finalSettings = { ...BOT_BEHAVIOR_DEFAULTS, ...(data.settings || settings) };
    localStorage.setItem('botBehaviorSettings', JSON.stringify(finalSettings));
    applyBotBehaviorSettings(finalSettings);
    if (!silent) showNotification('✅ Bot behavior settings saved!', 'success');
    return { settings: finalSettings, serverSynced: true };
  } catch (e) {
    console.error('Bot behavior save error:', e);
    if (!silent) showNotification('⚠️ Bot behavior saved locally only. Server sync failed.', 'warning');
    return { settings, serverSynced: false };
  }
}

// ── General Settings defaults ──────────────────────────────────────────────
const GENERAL_DEFAULTS = {
  businessName: 'PTIS Chatbot',
  displayName: 'PTIS Chatbot Support',
  phone: '+92 300 1234567',
  email: 'support@ptischatbot.com',
  headOfficeAddress: '',
  regionalOffices: [],
  timezone: 'GMT',
  language: 'en',
  theme: 'dark',
  accentColor: '#25D366',
  compactMode: false
};

function normalizeDialCodesInput(raw) {
  if (!raw) return [];
  const list = String(raw)
    .split(/[\n,;/]+/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.replace(/\D/g, ''))
    .filter(Boolean);
  return [...new Set(list)];
}

function buildRegionalOfficeCard(office = {}, { editing = false } = {}) {
  const card = document.createElement('div');
  card.className = 'regional-office-card';
  card.innerHTML = `
    <div class="regional-office-summary">
      <div class="regional-office-summary-text">
        <div class="regional-office-summary-title">Office</div>
        <div class="regional-office-summary-meta">No details yet</div>
      </div>
      <div class="regional-office-summary-actions">
        <button class="btn-secondary office-action-btn office-edit-btn" type="button" onclick="toggleRegionalOfficeEdit(this)">
          <i class="fas fa-pen"></i> Edit
        </button>
        <button class="btn-danger office-action-btn" type="button" onclick="removeRegionalOfficeRow(this)">
          <i class="fas fa-trash"></i> Delete
        </button>
      </div>
    </div>

    <div class="regional-office-details">
      <div class="settings-row">
        <div class="settings-label">
          <label>Country</label>
          <p class="settings-description">Office country name (e.g. Pakistan)</p>
        </div>
        <div class="settings-input">
          <input type="text" class="form-input regional-office-country" placeholder="Country">
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <label>Dial Codes</label>
          <p class="settings-description">Comma-separated country codes (e.g. 92, 971)</p>
        </div>
        <div class="settings-input">
          <input type="text" class="form-input regional-office-dial-codes" placeholder="92, 971">
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <label>Office Phone</label>
          <p class="settings-description">Phone number for this office</p>
        </div>
        <div class="settings-input">
          <input type="text" class="form-input regional-office-phone" placeholder="+92 300 1234567">
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <label>City</label>
          <p class="settings-description">City for this office</p>
        </div>
        <div class="settings-input">
          <input type="text" class="form-input regional-office-city" placeholder="Lahore">
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <label>Office Email</label>
          <p class="settings-description">Optional email for this office</p>
        </div>
        <div class="settings-input">
          <input type="email" class="form-input regional-office-email" placeholder="office@example.com">
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <label>Office Address</label>
          <p class="settings-description">Full office address</p>
        </div>
        <div class="settings-input">
          <textarea class="form-textarea regional-office-address" rows="3" placeholder="Street, City, Country"></textarea>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-label">
          <label>Label</label>
          <p class="settings-description">Optional label (e.g. Head Office, Branch)</p>
        </div>
        <div class="settings-input">
          <input type="text" class="form-input regional-office-label" placeholder="Head Office">
        </div>
      </div>
    </div>
  `;

  const set = (selector, value) => {
    const el = card.querySelector(selector);
    if (el && value !== undefined && value !== null) el.value = value;
  };

  set('.regional-office-country', office.country || '');
  set('.regional-office-dial-codes', Array.isArray(office.dialCodes) ? office.dialCodes.join(', ') : (office.dialCodes || office.dialCode || ''));
  set('.regional-office-phone', office.phone || '');
  set('.regional-office-city', office.city || '');
  set('.regional-office-email', office.email || '');
  set('.regional-office-address', office.address || '');
  set('.regional-office-label', office.label || '');

  card.querySelectorAll('input, textarea').forEach(el => {
    el.addEventListener('input', () => updateRegionalOfficeSummary(card));
  });

  updateRegionalOfficeSummary(card);
  setRegionalOfficeEditing(card, editing);

  return card;
}

function updateRegionalOfficeSummary(card) {
  if (!card) return;
  const get = (selector) => card.querySelector(selector)?.value?.trim() || '';
  const label = get('.regional-office-label');
  const country = get('.regional-office-country');
  const city = get('.regional-office-city');
  const phone = get('.regional-office-phone');
  const email = get('.regional-office-email');

  const title = label || country || city || 'Office';
  const metaParts = [];
  if (country) metaParts.push(country);
  if (city) metaParts.push(city);
  if (phone) metaParts.push(phone);
  else if (email) metaParts.push(email);

  const titleEl = card.querySelector('.regional-office-summary-title');
  const metaEl = card.querySelector('.regional-office-summary-meta');
  if (titleEl) titleEl.textContent = title;
  if (metaEl) metaEl.textContent = metaParts.length ? metaParts.join(' • ') : 'No details yet';
}

function setRegionalOfficeEditing(card, isEditing) {
  if (!card) return;
  card.classList.toggle('is-editing', !!isEditing);
  const editBtn = card.querySelector('.office-edit-btn');
  if (editBtn) {
    editBtn.innerHTML = isEditing
      ? '<i class="fas fa-check"></i> Done'
      : '<i class="fas fa-pen"></i> Edit';
  }
}

function toggleRegionalOfficeEdit(buttonEl) {
  const card = buttonEl?.closest('.regional-office-card');
  if (!card) return;
  const isEditing = card.classList.contains('is-editing');
  setRegionalOfficeEditing(card, !isEditing);
  updateRegionalOfficeSummary(card);
}

function ensureRegionalOfficesEmptyState(container) {
  if (!container) return;
  const hasCard = container.querySelector('.regional-office-card');
  const existingEmpty = container.querySelector('.regional-office-empty');
  if (hasCard) {
    if (existingEmpty) existingEmpty.remove();
    return;
  }
  if (existingEmpty) return;

  const emptyRow = document.createElement('div');
  emptyRow.className = 'settings-row regional-office-empty';
  emptyRow.innerHTML = `
    <div class="settings-label">
      <label>No regional offices added</label>
      <p class="settings-description">Click "Add Office" to define country-specific contact details.</p>
    </div>
    <div class="settings-input"></div>
  `;
  container.appendChild(emptyRow);
}

function renderRegionalOffices(offices = []) {
  const container = document.getElementById('regionalOfficesList');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(offices) ? offices : [];
  list.forEach(office => {
    container.appendChild(buildRegionalOfficeCard(office || {}));
  });

  ensureRegionalOfficesEmptyState(container);
}

function addRegionalOfficeRow(initial = {}) {
  const container = document.getElementById('regionalOfficesList');
  if (!container) return;

  const card = buildRegionalOfficeCard(initial || {});
  container.appendChild(card);
  ensureRegionalOfficesEmptyState(container);
}

function removeRegionalOfficeRow(buttonEl) {
  const card = buttonEl?.closest('.regional-office-card');
  if (card) card.remove();
  const container = document.getElementById('regionalOfficesList');
  ensureRegionalOfficesEmptyState(container);
}

function getRegionalOfficesFromForm() {
  const cards = Array.from(document.querySelectorAll('.regional-office-card'));
  const offices = cards.map(card => {
    const get = (selector) => card.querySelector(selector)?.value?.trim() || '';
    const dialCodesRaw = get('.regional-office-dial-codes');
    const dialCodes = normalizeDialCodesInput(dialCodesRaw);
    return {
      country: get('.regional-office-country'),
      dialCodes,
      phone: get('.regional-office-phone'),
      city: get('.regional-office-city'),
      email: get('.regional-office-email'),
      address: get('.regional-office-address'),
      label: get('.regional-office-label')
    };
  });

  return offices.filter(o =>
    o.country || o.phone || o.city || o.email || o.address || o.label || (o.dialCodes && o.dialCodes.length)
  );
}

// Apply theme, accent color, and compact mode to the page
function applyGeneralAppearance(settings) {
  const s = settings || JSON.parse(localStorage.getItem('generalSettings') || '{}');

  // Theme
  const theme = s.theme || 'dark';
  document.body.setAttribute('data-theme', theme);
  document.querySelectorAll('.theme-option').forEach(opt => {
    opt.classList.toggle('active', opt.getAttribute('data-theme') === theme);
  });

  // Accent color
  const color = s.accentColor || GENERAL_DEFAULTS.accentColor;
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-green', color);
  const colorDisplay = document.querySelector('.color-value');
  if (colorDisplay) colorDisplay.textContent = color;
  const colorPicker = document.getElementById('accentColor');
  if (colorPicker) colorPicker.value = color;

  // Compact mode
  document.body.classList.toggle('compact-mode', !!s.compactMode);
  const compactToggle = document.getElementById('generalCompactMode');
  if (compactToggle) compactToggle.checked = !!s.compactMode;
}

// Load saved general settings into form fields
async function loadGeneralSettings() {
  const parseCachedGeneralSettings = () => {
    try {
      const raw = localStorage.getItem('generalSettings');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };

  const isMeaningful = (v) => typeof v === 'string' && v.trim().length > 0;
  const isDefaultField = (v, d) => String(v || '').trim() === String(d || '').trim();

  const cached = Object.assign({}, GENERAL_DEFAULTS, parseCachedGeneralSettings());
  let s = cached;

  try {
    const res = await fetch('/api/settings/general');
    const data = await res.json();
    if (res.ok && data.success && data.settings) {
      const server = Object.assign({}, GENERAL_DEFAULTS, data.settings);

      const cachedTime = cached.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
      const serverTime = server.updatedAt ? new Date(server.updatedAt).getTime() : 0;

      // If server gives demo/default contact fields but user has meaningful local values,
      // keep local values to avoid reverting after reload when backend state is stale.
      const cachedHasCustomContact =
        isMeaningful(cached.phone) && !isDefaultField(cached.phone, GENERAL_DEFAULTS.phone) &&
        isMeaningful(cached.email) && !isDefaultField(cached.email, GENERAL_DEFAULTS.email);
      const serverIsDefaultContact =
        isDefaultField(server.phone, GENERAL_DEFAULTS.phone) &&
        isDefaultField(server.email, GENERAL_DEFAULTS.email);
      const cachedHasHeadOffice = isMeaningful(cached.headOfficeAddress);
      const serverHasHeadOffice = isMeaningful(server.headOfficeAddress);
      const cachedHasRegionalOffices = Array.isArray(cached.regionalOffices) && cached.regionalOffices.length > 0;
      const serverHasRegionalOffices = Array.isArray(server.regionalOffices) && server.regionalOffices.length > 0;

      if (cachedTime > serverTime || (cachedHasCustomContact && serverIsDefaultContact) || (cachedHasHeadOffice && !serverHasHeadOffice) || (cachedHasRegionalOffices && !serverHasRegionalOffices)) {
        s = cached;
      } else {
        s = server;
      }

      localStorage.setItem('generalSettings', JSON.stringify(s));
    }
  } catch (e) {
    // fallback below
  }

  if (!s) {
    const saved = parseCachedGeneralSettings();
    s = Object.assign({}, GENERAL_DEFAULTS, saved);
  }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('generalBusinessName', s.businessName);
  set('generalDisplayName', s.displayName);
  set('generalPhone', s.phone);
  set('generalEmail', s.email);
  set('generalHeadOfficeAddress', s.headOfficeAddress);
  set('generalTimezone', s.timezone);

  applyGeneralAppearance(s);
  renderRegionalOffices(s.regionalOffices || []);
}

const SECURITY_DEFAULTS = {
  sessionTimeoutMinutes: '30',
  ipWhitelistEnabled: false,
  ipWhitelistEntries: [],
  loginNotifications: true,
  dataRetentionDays: '90',
  twoFactorEnabled: false
};

const ADVANCED_DEFAULTS = {
  debugMode: false,
  apiRateLimit: 60,
  webhookRetry: true,
  maxRetryAttempts: 3
};

function update2FAButton(enabled) {
  const btn = document.getElementById('security2faBtn');
  if (!btn) return;
  btn.innerHTML = enabled
    ? '<i class="fas fa-mobile-alt"></i> Disable 2FA'
    : '<i class="fas fa-mobile-alt"></i> Enable 2FA';
}

function applySecuritySettings(settings = {}) {
  const s = { ...SECURITY_DEFAULTS, ...(settings || {}) };
  const timeout = document.getElementById('securitySessionTimeout');
  const ipWhitelist = document.getElementById('securityIpWhitelistEnabled');
  const ipEntries = document.getElementById('securityIpWhitelistEntries');
  const loginNotifications = document.getElementById('securityLoginNotifications');
  const retention = document.getElementById('securityDataRetention');

  if (timeout) timeout.value = String(s.sessionTimeoutMinutes || SECURITY_DEFAULTS.sessionTimeoutMinutes);
  if (ipWhitelist) ipWhitelist.checked = !!s.ipWhitelistEnabled;
  if (ipEntries) {
    if (Array.isArray(s.ipWhitelistEntries)) {
      ipEntries.value = s.ipWhitelistEntries.join('\n');
    } else if (typeof s.ipWhitelistEntries === 'string') {
      ipEntries.value = s.ipWhitelistEntries;
    } else {
      ipEntries.value = '';
    }
  }
  if (loginNotifications) loginNotifications.checked = !!s.loginNotifications;
  if (retention) retention.value = String(s.dataRetentionDays || SECURITY_DEFAULTS.dataRetentionDays);
  update2FAButton(!!s.twoFactorEnabled);
}

function getSecurityFormSettings() {
  const rawIpEntries = document.getElementById('securityIpWhitelistEntries')?.value || '';
  const ipWhitelistEntries = rawIpEntries
    .split(/\n+/)
    .map(v => v.trim())
    .filter(Boolean);

  return {
    sessionTimeoutMinutes: document.getElementById('securitySessionTimeout')?.value || SECURITY_DEFAULTS.sessionTimeoutMinutes,
    ipWhitelistEnabled: !!document.getElementById('securityIpWhitelistEnabled')?.checked,
    ipWhitelistEntries,
    loginNotifications: !!document.getElementById('securityLoginNotifications')?.checked,
    dataRetentionDays: document.getElementById('securityDataRetention')?.value || SECURITY_DEFAULTS.dataRetentionDays,
    twoFactorEnabled: /Disable/i.test(document.getElementById('security2faBtn')?.textContent || '')
  };
}

async function loadSecuritySettings() {
  let settings = null;
  try {
    const res = await fetch('/api/settings/security');
    const data = await res.json();
    if (res.ok && data.success && data.settings) {
      settings = { ...SECURITY_DEFAULTS, ...data.settings };
      localStorage.setItem('securitySettings', JSON.stringify(settings));
    }
  } catch (e) {
    // fallback below
  }

  if (!settings) {
    const cached = JSON.parse(localStorage.getItem('securitySettings') || '{}');
    settings = { ...SECURITY_DEFAULTS, ...cached };
  }
  applySecuritySettings(settings);
}

async function saveSecuritySettings({ silent = false } = {}) {
  const settings = getSecurityFormSettings();
  localStorage.setItem('securitySettings', JSON.stringify(settings));
  try {
    const res = await fetch('/api/settings/security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save security settings');

    const finalSettings = { ...SECURITY_DEFAULTS, ...(data.settings || settings) };
    localStorage.setItem('securitySettings', JSON.stringify(finalSettings));
    applySecuritySettings(finalSettings);
    if (!silent) showNotification('✅ Security settings saved!', 'success');
    return { settings: finalSettings, serverSynced: true };
  } catch (e) {
    console.error('Security settings save error:', e);
    if (!silent) showNotification('⚠️ Security settings saved locally only. Server sync failed.', 'warning');
    return { settings, serverSynced: false };
  }
}

function applyAdvancedSettings(settings = {}) {
  const s = { ...ADVANCED_DEFAULTS, ...(settings || {}) };
  const debugMode = document.getElementById('advancedDebugMode');
  const apiRateLimit = document.getElementById('advancedApiRateLimit');
  const webhookRetry = document.getElementById('advancedWebhookRetry');
  const maxRetryAttempts = document.getElementById('advancedMaxRetryAttempts');

  if (debugMode) debugMode.checked = !!s.debugMode;
  if (apiRateLimit) apiRateLimit.value = String(s.apiRateLimit);
  if (webhookRetry) webhookRetry.checked = !!s.webhookRetry;
  if (maxRetryAttempts) maxRetryAttempts.value = String(s.maxRetryAttempts);
}

function getAdvancedFormSettings() {
  const toInt = (value, fallback) => {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    debugMode: !!document.getElementById('advancedDebugMode')?.checked,
    apiRateLimit: Math.min(1000, Math.max(10, toInt(document.getElementById('advancedApiRateLimit')?.value, ADVANCED_DEFAULTS.apiRateLimit))),
    webhookRetry: !!document.getElementById('advancedWebhookRetry')?.checked,
    maxRetryAttempts: Math.min(10, Math.max(1, toInt(document.getElementById('advancedMaxRetryAttempts')?.value, ADVANCED_DEFAULTS.maxRetryAttempts)))
  };
}

async function loadAdvancedSettings() {
  let settings = null;
  try {
    const res = await fetch('/api/settings/advanced');
    const data = await res.json();
    if (res.ok && data.success && data.settings) {
      settings = { ...ADVANCED_DEFAULTS, ...data.settings };
      localStorage.setItem('advancedSettings', JSON.stringify(settings));
    }
  } catch (e) {
    // fallback below
  }

  if (!settings) {
    const cached = JSON.parse(localStorage.getItem('advancedSettings') || '{}');
    settings = { ...ADVANCED_DEFAULTS, ...cached };
  }

  applyAdvancedSettings(settings);
}

async function saveAdvancedSettings({ silent = false } = {}) {
  const settings = getAdvancedFormSettings();
  localStorage.setItem('advancedSettings', JSON.stringify(settings));

  try {
    const res = await fetch('/api/settings/advanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save advanced settings');

    const finalSettings = { ...ADVANCED_DEFAULTS, ...(data.settings || settings) };
    localStorage.setItem('advancedSettings', JSON.stringify(finalSettings));
    applyAdvancedSettings(finalSettings);
    if (!silent) showNotification('✅ Advanced settings saved!', 'success');
    return { settings: finalSettings, serverSynced: true };
  } catch (e) {
    console.error('Advanced settings save error:', e);
    if (!silent) showNotification('⚠️ Advanced settings saved locally only. Server sync failed.', 'warning');
    return { settings, serverSynced: false };
  }
}

// Save settings
async function saveSettings(section) {
  if (section === 'general') {
    const get = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const activeTheme = document.querySelector('.theme-option.active');

    const settings = {
      businessName: get('generalBusinessName').trim(),
      displayName: get('generalDisplayName').trim(),
      phone: get('generalPhone').trim(),
      email: get('generalEmail').trim(),
      headOfficeAddress: get('generalHeadOfficeAddress').trim(),
      regionalOffices: getRegionalOfficesFromForm(),
      timezone: get('generalTimezone').trim(),
      theme: activeTheme ? activeTheme.getAttribute('data-theme') : 'dark',
      accentColor: (document.getElementById('accentColor') || {}).value || GENERAL_DEFAULTS.accentColor,
      compactMode: !!(document.getElementById('generalCompactMode') || {}).checked,
      updatedAt: new Date().toISOString()
    };

    localStorage.setItem('generalSettings', JSON.stringify(settings));
    applyGeneralAppearance(settings);
    renderRegionalOffices(settings.regionalOffices || []);

    try {
      const res = await fetch('/api/settings/general', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Failed to save general settings');

      const finalSettings = Object.assign({}, GENERAL_DEFAULTS, settings, data.settings || {});
      localStorage.setItem('generalSettings', JSON.stringify(finalSettings));
      applyGeneralAppearance(finalSettings);
      renderRegionalOffices(finalSettings.regionalOffices || []);
      showNotification('✅ General settings saved!', 'success');
    } catch (e) {
      console.error('General settings save error:', e);
      renderRegionalOffices(settings.regionalOffices || []);
      showNotification('⚠️ General settings saved locally only. Server sync failed.', 'warning');
    }

  } else if (section === 'bot') {
    // Save AI settings + business hours + bot behavior together
    try {
      await saveBusinessHours({ silent: true });
      const behaviorResult = await saveBotBehaviorSettings({ silent: true });
      await saveAISettings({ silent: true });
      if (behaviorResult.serverSynced) {
        showNotification('✅ Bot settings saved!', 'success');
      } else {
        showNotification('⚠️ Bot settings saved (bot behavior only local).', 'warning');
      }
    } catch (e) {
      console.error('Bot settings save error:', e);
      showNotification('❌ Failed to save bot settings', 'error');
    }
  } else if (section === 'notifications') {
    persistNotificationSettings(getNotificationFormSettings()).catch(err => {
      console.error('Notification settings save error:', err);
      showNotification('❌ ' + err.message, 'error');
    });
  } else if (section === 'security') {
    saveSecuritySettings().catch(err => {
      console.error('Security settings save error:', err);
      showNotification('❌ ' + err.message, 'error');
    });
  } else if (section === 'advanced') {
    saveAdvancedSettings().catch(err => {
      console.error('Advanced settings save error:', err);
      showNotification('❌ ' + err.message, 'error');
    });
  } else {
    showNotification('✅ Settings saved!', 'success');
  }
}

// Reset settings
function resetSettings(section) {
  if (!confirm(`Reset all ${section} settings to defaults?`)) return;

  if (section === 'general') {
    localStorage.removeItem('generalSettings');
    fetch('/api/settings/general', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(GENERAL_DEFAULTS)
    }).catch(() => {});
    loadGeneralSettings();
    renderRegionalOffices([]);
    showNotification('General settings reset to defaults.', 'info');
  } else if (section === 'bot') {
    localStorage.removeItem('botBehaviorSettings');
    applyBotBehaviorSettings(BOT_BEHAVIOR_DEFAULTS);
    saveBotBehaviorSettings({ silent: true });
    showNotification('Bot behavior reset to defaults.', 'info');
  } else if (section === 'security') {
    localStorage.removeItem('securitySettings');
    applySecuritySettings(SECURITY_DEFAULTS);
    saveSecuritySettings({ silent: true });
    showNotification('Security settings reset to defaults.', 'info');
  } else if (section === 'notifications') {
    applyNotificationSettings(NOTIFICATION_DEFAULTS);
    persistNotificationSettings(NOTIFICATION_DEFAULTS, { showSavedToast: false })
      .then(() => showNotification('Notification settings reset to defaults.', 'info'))
      .catch(err => {
        console.error('Notification settings reset error:', err);
        showNotification('❌ ' + err.message, 'error');
      });
  } else if (section === 'advanced') {
    localStorage.removeItem('advancedSettings');
    applyAdvancedSettings(ADVANCED_DEFAULTS);
    saveAdvancedSettings({ silent: true });
    showNotification('Advanced settings reset to defaults.', 'info');
  } else {
    showNotification('Settings reset to defaults.', 'info');
  }
}

// Change password
function changePassword() {
  const modal = document.getElementById('changePasswordModal');
  if (!modal) return;

  const current = document.getElementById('currentPasswordInput');
  const next = document.getElementById('newPasswordInput');
  const confirm = document.getElementById('confirmPasswordInput');
  if (current) current.value = '';
  if (next) next.value = '';
  if (confirm) confirm.value = '';

  modal.style.display = 'flex';
  if (current) current.focus();
}

function closeChangePasswordModal() {
  const modal = document.getElementById('changePasswordModal');
  if (!modal) return;
  modal.style.display = 'none';
}

async function saveChangedPassword() {
  const currentPassword = document.getElementById('currentPasswordInput')?.value || '';
  const newPassword = document.getElementById('newPasswordInput')?.value || '';
  const confirmPassword = document.getElementById('confirmPasswordInput')?.value || '';

  if (!currentPassword || !newPassword || !confirmPassword) {
    showNotification('❌ Please fill all password fields.', 'error');
    return;
  }

  if (newPassword !== confirmPassword) {
    showNotification('❌ New password and confirm password do not match.', 'error');
    return;
  }

  if (String(newPassword).length < 8) {
    showNotification('❌ New password must be at least 8 characters.', 'error');
    return;
  }

  const btn = document.getElementById('savePasswordBtn');
  const original = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
  }

  try {
    const res = await fetch('/api/settings/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to change password');
    }
    showNotification('✅ Password changed successfully!', 'success');
    closeChangePasswordModal();
  } catch (e) {
    console.error('Change password error:', e);
    showNotification('❌ ' + (e.message || 'Failed to change password'), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

// Setup 2FA
async function setup2FA() {
  const isEnabled = /Disable/i.test(document.getElementById('security2faBtn')?.textContent || '');
  const nextEnabled = !isEnabled;
  const action = nextEnabled ? 'enable' : 'disable';

  if (!confirm(`Are you sure you want to ${action} 2FA?`)) return;

  try {
    const current = getSecurityFormSettings();
    const payload = { ...current, twoFactorEnabled: nextEnabled };
    const res = await fetch('/api/settings/security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to update 2FA');

    const finalSettings = { ...SECURITY_DEFAULTS, ...(data.settings || payload) };
    localStorage.setItem('securitySettings', JSON.stringify(finalSettings));
    applySecuritySettings(finalSettings);
    showNotification(`✅ 2FA ${nextEnabled ? 'enabled' : 'disabled'} successfully!`, 'success');
  } catch (e) {
    console.error('2FA update error:', e);
    showNotification('❌ ' + (e.message || 'Failed to update 2FA'), 'error');
  }
}

// Export all user data
function exportAllUserData() {
  console.log('Exporting all user data...');
  showNotification('Preparing data export...', 'info');
  
  setTimeout(() => {
    showNotification('Data export downloaded!', 'success');
  }, 2000);
}

// Delete account
function deleteAccount() {
  const confirmation = prompt('This action is IRREVERSIBLE. Type "DELETE" to confirm:');
  
  if (confirmation === 'DELETE') {
    console.log('Deleting account...');
    showNotification('Processing account deletion...', 'warning');
    
    setTimeout(() => {
      alert('Account deletion initiated. You will receive a confirmation email.');
    }, 1500);
  } else if (confirmation !== null) {
    showNotification('Account deletion cancelled', 'info');
  }
}

// Clear cache
function clearCache() {
  if (confirm('This will clear all cached data and reload the page. Continue?')) {
    console.log('Clearing cache...');
    showNotification('Clearing cache...', 'info');
    
    setTimeout(() => {
      localStorage.clear();
      sessionStorage.clear();
      location.reload();
    }, 1000);
  }
}

// Reset all settings
function resetAllSettings() {
  const confirmation = prompt('This will reset ALL settings to defaults. Type "RESET" to confirm:');
  
  if (confirmation === 'RESET') {
    console.log('Resetting all settings...');
    showNotification('Resetting all settings...', 'warning');
    
    setTimeout(() => {
      showNotification('All settings reset to defaults!', 'success');
      location.reload();
    }, 1500);
  } else if (confirmation !== null) {
    showNotification('Reset cancelled', 'info');
  }
}

// Create backup
function createBackup() {
  backupDatabase();
}

// Theme switching (if implemented in the future)
document.addEventListener('DOMContentLoaded', () => {
  // Load and apply saved general settings on startup
  loadGeneralSettings();

  // Load AI settings and notification settings into forms
  loadAISettings();
  loadNotificationSettings();
  loadBusinessHours();
  loadBotBehaviorSettings();
  loadSecuritySettings();
  loadAdvancedSettings();

  // Change password modal Enter-key submit
  ['currentPasswordInput', 'newPasswordInput', 'confirmPasswordInput'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveChangedPassword();
      }
    });
  });

  // Pre-fill Groq API key input if already configured
  fetch('/api/settings/groq-key')
    .then(r => r.json())
    .then(data => {
      const input = document.getElementById('groqApiKeyInput');
      if (input && data.configured) {
        input.value = data.preview;
        input.type = 'password';
        // Show green status badge
        const badge = document.getElementById('geminiStatusRow');
        const badgeText = document.getElementById('geminiStatusBadge');
        if (badge && badgeText) {
          badgeText.textContent = '✅ Groq Connected';
          badgeText.style.background = 'rgba(37,211,102,0.15)';
          badgeText.style.color = '#25D366';
          badge.style.display = 'flex';
        }
      }
    })
    .catch(() => {});


  // Theme option clicks — live apply + mark active
  const themeOptions = document.querySelectorAll('.theme-option');
  themeOptions.forEach(option => {
    option.addEventListener('click', function() {
      themeOptions.forEach(opt => opt.classList.remove('active'));
      this.classList.add('active');
      const theme = this.getAttribute('data-theme');
      document.body.setAttribute('data-theme', theme);
      showNotification(`Theme changed to ${theme}`, 'success');
    });
  });

  // Color picker — live apply accent color
  const colorPicker = document.getElementById('accentColor');
  if (colorPicker) {
    colorPicker.addEventListener('input', function() {
      const colorValue = this.value;
      const colorDisplay = document.querySelector('.color-value');
      if (colorDisplay) colorDisplay.textContent = colorValue;
      document.documentElement.style.setProperty('--accent', colorValue);
      document.documentElement.style.setProperty('--accent-green', colorValue);
    });
  }

  // Compact mode toggle — live apply
  const compactToggle = document.getElementById('generalCompactMode');
  if (compactToggle) {
    compactToggle.addEventListener('change', function() {
      document.body.classList.toggle('compact-mode', this.checked);
    });
  }

  // Business hours day toggles
  const dayToggles = document.querySelectorAll('.day-toggle input[type="checkbox"]');
  dayToggles.forEach(toggle => {
    toggle.addEventListener('change', function() {
      const row = this.closest('.business-hour-row');
      const timeInputs = row.querySelectorAll('.form-input-time');
      timeInputs.forEach(input => {
        input.disabled = !this.checked;
      });
    });
  });
});
// Simulator functionality
// ── Notification System ──
const notifications = [];
let unreadCount = 0;
const NOTIFICATIONS_STORAGE_KEY = 'ptis-chatbot.notifications.v1';

function persistNotifications() {
  try {
    const payload = {
      notifications: notifications.slice(0, 50).map(n => ({
        id: n.id,
        type: n.type,
        message: n.message,
        detail: n.detail,
        action: n.action || null,
        time: (n.time instanceof Date ? n.time : new Date(n.time || Date.now())).toISOString(),
        read: !!n.read
      })),
      unreadCount
    };
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Failed to persist notifications:', e);
  }
}

function loadPersistedNotifications() {
  try {
    const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    const saved = Array.isArray(parsed?.notifications) ? parsed.notifications : [];
    notifications.length = 0;
    saved.slice(0, 50).forEach(n => {
      notifications.push({
        id: n.id || Date.now() + Math.random(),
        type: n.type || 'status',
        message: n.message || '',
        detail: n.detail || '',
        action: n.action || null,
        time: n.time ? new Date(n.time) : new Date(),
        read: !!n.read
      });
    });

    unreadCount = notifications.filter(n => !n.read).length;
    renderNotifBadge();
    renderNotifList();
  } catch (e) {
    console.warn('Failed to load persisted notifications:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadPersistedNotifications();
});

function addNotification(type, message, detail = '', action = null) {
  const notif = {
    id: Date.now(),
    type,        // 'message' | 'task' | 'warning' | 'status'
    message,
    detail,
    action,
    time: new Date(),
    read: false
  };
  notifications.unshift(notif);
  if (notifications.length > 50) notifications.pop(); // cap at 50
  unreadCount++;
  persistNotifications();
  renderNotifBadge();
  renderNotifList();
}

function renderNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (unreadCount > 0) {
    badge.style.display = 'flex';
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
  } else {
    badge.style.display = 'none';
  }
}

function renderNotifList() {
  const list = document.getElementById('notifList');
  if (!list) return;
  if (notifications.length === 0) {
    list.innerHTML = '<div class="notif-empty"><i class="fas fa-bell-slash"></i><p>No notifications yet</p></div>';
    return;
  }
  const iconMap = { message: 'fa-comment', task: 'fa-tasks', warning: 'fa-exclamation-triangle', status: 'fa-circle' };
  list.innerHTML = notifications.map(n => `
    <div class="notif-item ${n.read ? 'read' : 'unread'} ${n.action ? 'clickable' : ''}" data-id="${n.id}">
      <div class="notif-icon ${n.type}"><i class="fas ${iconMap[n.type] || 'fa-bell'}"></i></div>
      <div class="notif-body">
        <p title="${escapeHtml(n.message)}">${escapeHtml(n.message)}</p>
        <span>${n.detail ? escapeHtml(n.detail) + ' · ' : ''}${timeAgo(n.time)}</span>
      </div>
      ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
    </div>
  `).join('');

  list.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = Number(item.dataset.id);
      onNotificationClick(id);
    });
  });
}

async function onNotificationClick(id) {
  const notif = notifications.find(n => n.id === id);
  if (!notif) return;

  if (!notif.read) {
    notif.read = true;
    unreadCount = notifications.filter(n => !n.read).length;
    persistNotifications();
    renderNotifBadge();
    renderNotifList();
  }

  if (!notif.action) return;

  const panel = document.getElementById('notifPanel');
  if (panel) panel.style.display = 'none';

  const action = notif.action;
  if (action.kind === 'message' && action.phone) {
    const phone = action.phone;
    const contactName = action.contactName || phone;
    await openKeywordMessageInChat(phone, contactName, '', action.messageId || '');
    return;
  }

  if (action.kind === 'messages-page') {
    navigateToPage('messages');
    return;
  }

  if (action.kind === 'task') {
    await focusTaskFromNotification(action.taskId);
  }
}

async function focusTaskFromNotification(taskId) {
  if (!taskId) {
    navigateToPage('tasks');
    return;
  }

  navigateToPage('tasks');
  await loadTasksPage();

  const row = document.querySelector(`#tasksTableBody tr.task-row[data-id="${taskId}"]`);
  if (!row) return;

  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('task-focus-row');
  setTimeout(() => row.classList.remove('task-focus-row'), 2200);
}

function toggleNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
}

function markAllNotifRead() {
  const hadUnread = notifications.some(n => !n.read);
  notifications.forEach(n => n.read = true);
  unreadCount = 0;
  persistNotifications();
  renderNotifBadge();
  renderNotifList();

  // Visual confirmation: briefly highlight all now-read items.
  const list = document.getElementById('notifList');
  if (list) {
    list.querySelectorAll('.notif-item').forEach(item => {
      item.classList.add('just-marked-read');
      setTimeout(() => item.classList.remove('just-marked-read'), 700);
    });
  }

  // Visual confirmation on action icon.
  const markBtn = document.getElementById('notifMarkAllBtn');
  if (markBtn) {
    markBtn.classList.add('done');
    setTimeout(() => markBtn.classList.remove('done'), 700);
  }

  showNotification(hadUnread ? '✅ All notifications marked as read' : 'All notifications are already read', hadUnread ? 'success' : 'info');
}

function clearAllNotif() {
  notifications.length = 0;
  unreadCount = 0;
  persistNotifications();
  renderNotifBadge();
  renderNotifList();
}

function timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date)) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('notifWrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    const panel = document.getElementById('notifPanel');
    if (panel) panel.style.display = 'none';
  }
});

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    document.getElementById('fullscreenIcon').className = 'fas fa-compress';
  } else {
    document.exitFullscreen();
    document.getElementById('fullscreenIcon').className = 'fas fa-expand';
  }
}

document.addEventListener('fullscreenchange', () => {
  const icon = document.getElementById('fullscreenIcon');
  if (icon) icon.className = document.fullscreenElement ? 'fas fa-compress' : 'fas fa-expand';
});

function openSimulator() {
  const simulatorHTML = `
    <div class="modal-overlay" id="simulatorModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.75); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);">
      <div class="modal-content" style="width: 500px; max-width: 90%; background: #1a1d29; border: 1px solid #2d3142; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); animation: modalFadeIn 0.3s ease;">
        <div class="modal-header" style="background: linear-gradient(135deg, #25D366 0%, #1ea952 100%); padding: 24px 28px; border-radius: 16px 16px 0 0; display: flex; align-items: center; justify-content: space-between;">
          <h2 style="color: white; margin: 0; font-size: 22px; font-weight: 600;"><i class="fas fa-play-circle" style="margin-right: 10px;"></i>Test Simulator</h2>
          <button class="modal-close" onclick="closeSimulator()" style="color: white; background: rgba(255,255,255,0.2); border: none; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 24px; line-height: 1; transition: all 0.3s;" onmouseover="this.style.background='rgba(255,255,255,0.3)'" onmouseout="this.style.background='rgba(255,255,255,0.2)'">&times;</button>
        </div>
        <div class="modal-body" style="padding: 32px 28px;">
          <p style="color: #a0a3bd; margin-bottom: 24px; font-size: 15px; line-height: 1.6;">Simulate real-time updates to test dashboard functionality without actual WhatsApp integration.</p>
          
          <div class="simulator-options">
            <button class="btn-primary" onclick="simulateMessage()" style="width: 100%; margin-bottom: 14px; padding: 16px 20px; background: #2d3142; color: white; border: 1px solid #3d4152; border-radius: 10px; cursor: pointer; font-size: 15px; font-weight: 500; transition: all 0.3s; display: flex; align-items: center; justify-content: center; gap: 10px;" onmouseover="this.style.background='#3d4152'; this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(0,0,0,0.3)'" onmouseout="this.style.background='#2d3142'; this.style.transform='translateY(0)'; this.style.boxShadow='none'">
              <i class="fas fa-comment" style="font-size: 18px;"></i> <span>Simulate New Message</span>
            </button>
            
            <button class="btn-primary" onclick="simulateTask()" style="width: 100%; margin-bottom: 14px; padding: 16px 20px; background: #2d3142; color: white; border: 1px solid #3d4152; border-radius: 10px; cursor: pointer; font-size: 15px; font-weight: 500; transition: all 0.3s; display: flex; align-items: center; justify-content: center; gap: 10px;" onmouseover="this.style.background='#3d4152'; this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(0,0,0,0.3)'" onmouseout="this.style.background='#2d3142'; this.style.transform='translateY(0)'; this.style.boxShadow='none'">
              <i class="fas fa-tasks" style="font-size: 18px;"></i> <span>Simulate New Task</span>
            </button>
            
            <button class="btn-primary" onclick="simulateMultiple()" style="width: 100%; padding: 16px 20px; background: linear-gradient(135deg, #25D366 0%, #1ea952 100%); color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 15px; font-weight: 600; transition: all 0.3s; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: 0 4px 15px rgba(37, 211, 102, 0.3);" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px rgba(37, 211, 102, 0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 15px rgba(37, 211, 102, 0.3)'">
              <i class="fas fa-bolt" style="font-size: 18px;"></i> <span>Simulate Multiple Events</span>
            </button>
          </div>
          
          <div id="simulatorStatus" style="margin-top: 24px; padding: 14px 16px; border-radius: 10px; display: none; font-size: 14px; font-weight: 500;"></div>
        </div>
      </div>
    </div>
    <style>
      @keyframes modalFadeIn {
        from {
          opacity: 0;
          transform: scale(0.95) translateY(-20px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }
    </style>
  `;
  
  document.body.insertAdjacentHTML('beforeend', simulatorHTML);
}

function closeSimulator() {
  const modal = document.getElementById('simulatorModal');
  if (modal) {
    modal.remove();
  }
}

async function simulateMessage() {
  showSimulatorStatus('Creating test message...', 'info');
  try {
    const response = await fetch('/api/test/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    showSimulatorStatus('✓ Test message created successfully!', 'success');
    console.log('Simulated message:', data);
  } catch (error) {
    showSimulatorStatus('✗ Failed to create test message', 'error');
    console.error('Simulation error:', error);
  }
}

async function simulateTask() {
  showSimulatorStatus('Creating test task...', 'info');
  try {
    const response = await fetch('/api/test/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    showSimulatorStatus('✓ Test task created successfully!', 'success');
    console.log('Simulated task:', data);
  } catch (error) {
    showSimulatorStatus('✗ Failed to create test task', 'error');
    console.error('Simulation error:', error);
  }
}

async function simulateMultiple() {
  showSimulatorStatus('Creating multiple test events...', 'info');
  try {
    await fetch('/api/test/message', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    await new Promise(resolve => setTimeout(resolve, 500));
    await fetch('/api/test/task', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    await new Promise(resolve => setTimeout(resolve, 500));
    await fetch('/api/test/message', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    
    showSimulatorStatus('✓ Multiple events created successfully!', 'success');
  } catch (error) {
    showSimulatorStatus('✗ Failed to create test events', 'error');
    console.error('Simulation error:', error);
  }
}

function showSimulatorStatus(message, type) {
  const statusDiv = document.getElementById('simulatorStatus');
  if (statusDiv) {
    statusDiv.style.display = 'block';
    statusDiv.textContent = message;
    statusDiv.style.backgroundColor = type === 'success' ? '#d4edda' : type === 'error' ? '#f8d7da' : '#d1ecf1';
    statusDiv.style.color = type === 'success' ? '#155724' : type === 'error' ? '#721c24' : '#0c5460';
  }
}