/**
 * AI Context Bridge — Injection Sidebar Content Script
 *
 * Creates a floating sidebar on AI chat sites that shows relevant knowledge
 * from the user's knowledge base and allows one-click injection into the chat.
 *
 * This is a CONTENT SCRIPT — no ES modules. Uses IIFE to avoid polluting
 * the global namespace. All communication with the background service worker
 * happens via chrome.runtime.sendMessage.
 */
(function () {
  'use strict';

  // =========================================================================
  // Guard: only run once, only on supported sites
  // =========================================================================
  if (window.__acbInjectorLoaded) return;
  window.__acbInjectorLoaded = true;

  const SITE = detectSite();
  if (!SITE) return;

  // =========================================================================
  // Constants
  // =========================================================================
  const DEBOUNCE_MS = 3000;
  const MAX_CONTEXT_MESSAGES = 5;
  const MAX_VISIBLE_TAGS = 5;
  const MAX_CONTEXT_KEYWORDS = 8;

  // Chat message selectors per site (for context extraction)
  const MESSAGE_SELECTORS = {
    chatgpt: '[data-message-author-role="user"] .whitespace-pre-wrap, [data-message-author-role="user"] .markdown',
    claude: '[data-testid="user-message"], div.font-user-message',
    gemini: '.query-text, .user-query-text, [data-message-author="user"]',
    copilot: '.user-message, [data-content="user-message"]'
  };

  // Chat container selectors for MutationObserver
  const CHAT_CONTAINER_SELECTORS = {
    chatgpt: 'main, [role="presentation"]',
    claude: '#__next, main',
    gemini: 'main, .conversation-container',
    copilot: '#app, main'
  };

  // Chat input selectors (mirrored from injector.js for the content script)
  const INPUT_SELECTORS = {
    chatgpt: ['#prompt-textarea', 'textarea[data-id]', 'div[contenteditable="true"][id="prompt-textarea"]', 'form textarea'],
    claude: ['div.ProseMirror[contenteditable="true"]', 'fieldset textarea', 'div[contenteditable="true"][data-placeholder]', 'div.is-editor-empty[contenteditable="true"]'],
    gemini: ['.ql-editor[contenteditable="true"]', 'rich-textarea .ql-editor', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"][aria-label*="prompt"]'],
    copilot: ['textarea#searchbox', '#userInput', 'textarea[placeholder*="message"]', '#searchbox']
  };

  // =========================================================================
  // State
  // =========================================================================
  let isOpen = false;
  let results = [];
  let lastContextText = '';
  let isSearchMode = false;
  let isLoading = false;
  let lastError = null;
  let extractRequestId = 0;
  let searchDebounceTimer = null;
  let shadowRoot = null;
  let observer = null;

  // DOM references (inside shadow)
  let triggerBtn = null;
  let panelEl = null;
  let backdropEl = null;
  let resultsList = null;
  let searchInput = null;
  let contextBar = null;
  let footerEl = null;
  let toastEl = null;
  let badgeEl = null;

  // =========================================================================
  // Site Detection
  // =========================================================================
  function detectSite() {
    const h = location.hostname;
    if (h.includes('chat.openai.com') || h.includes('chatgpt.com')) return 'chatgpt';
    if (h.includes('claude.ai')) return 'claude';
    if (h.includes('gemini.google.com')) return 'gemini';
    if (h.includes('copilot.microsoft.com')) return 'copilot';
    return null;
  }

  // =========================================================================
  // SVG Icons (inline to avoid external requests)
  // =========================================================================
  const ICONS = {
    bridge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    inject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    preview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
    chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    chevUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>'
  };

  // =========================================================================
  // Utility Functions
  // =========================================================================
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function truncateText(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.slice(0, maxLen) + '...';
  }

  // =========================================================================
  // Shadow DOM Setup
  // =========================================================================
  function init() {
    // Create host element
    const host = document.createElement('div');
    host.id = 'acb-inject-host';
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 999999; pointer-events: none;';
    document.body.appendChild(host);

    shadowRoot = host.attachShadow({ mode: 'closed' });

    // Load styles into shadow DOM
    const styleEl = document.createElement('style');
    styleEl.textContent = getStyles();
    shadowRoot.appendChild(styleEl);

    // Build the UI
    buildTriggerButton();
    buildBackdrop();
    buildPanel();

    // Start observing the chat for context changes
    startChatObserver();

    // Listen for data changes (e.g. user cleared data in sidepanel)
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'DATA_CHANGED') {
        results = [];
        lastContextText = '';
        isSearchMode = false;
        if (isOpen) {
          extractAndScore(true);
        }
      }
    });

    // Initial context scan after a short delay (let the page load)
    setTimeout(() => extractAndScore(), 2000);
  }

  function getStyles() {
    // Fetch the CSS from the extension bundle
    // Content scripts can use chrome.runtime.getURL to reference bundled files
    // However, for reliability we embed the styles directly using fetch
    // We'll do a synchronous return with a fetch fallback
    return CSS_TEXT;
  }

  // =========================================================================
  // Build UI Components
  // =========================================================================
  function buildTriggerButton() {
    triggerBtn = document.createElement('button');
    triggerBtn.className = 'acb-trigger';
    triggerBtn.setAttribute('aria-label', 'AI Context Bridge');
    triggerBtn.style.pointerEvents = 'auto';
    const iconUrl = chrome.runtime.getURL('icons/icon48.png');
    triggerBtn.innerHTML = `
      <img class="acb-trigger-logo" src="${iconUrl}" alt="AI Context Bridge" />
      <span class="acb-trigger-badge" id="acb-badge">0</span>
    `;
    triggerBtn.addEventListener('click', togglePanel);
    shadowRoot.appendChild(triggerBtn);
    badgeEl = triggerBtn.querySelector('#acb-badge');
  }

  function buildBackdrop() {
    backdropEl = document.createElement('div');
    backdropEl.className = 'acb-backdrop';
    backdropEl.style.pointerEvents = 'none';
    backdropEl.addEventListener('click', closePanel);
    shadowRoot.appendChild(backdropEl);
  }

  function buildPanel() {
    panelEl = document.createElement('div');
    panelEl.className = 'acb-panel';
    panelEl.style.pointerEvents = 'auto';
    panelEl.innerHTML = `
      <!-- Header -->
      <div class="acb-header">
        <div class="acb-header-title">
          <img class="acb-header-logo" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="Slop" />
        </div>
        <button class="acb-close-btn" aria-label="Close panel">
          ${ICONS.close}
        </button>
      </div>

      <!-- Context Bar -->
      <div class="acb-context-bar" id="acb-context-bar">
        <span>Detected context:</span>
        <div class="acb-context-keywords" id="acb-context-keywords">
          <span class="acb-keyword-chip">Analyzing...</span>
        </div>
      </div>

      <!-- Search -->
      <div class="acb-search-wrap">
        <span class="acb-search-icon">${ICONS.search}</span>
        <input type="text" class="acb-search-input" id="acb-search"
               placeholder="Search knowledge base..." autocomplete="off" />
        <button class="acb-search-clear" id="acb-search-clear" type="button" aria-label="Clear search">&times;</button>
      </div>

      <!-- Results -->
      <div class="acb-results" id="acb-results"></div>

      <!-- Footer -->
      <div class="acb-footer" id="acb-footer" style="display: none;">
        <button class="acb-inject-all-btn" id="acb-inject-all" disabled>
          Inject All Context
        </button>
      </div>

      <!-- Toast -->
      <div class="acb-toast" id="acb-toast"></div>
    `;

    // Wire up event listeners
    panelEl.querySelector('.acb-close-btn').addEventListener('click', closePanel);

    searchInput = panelEl.querySelector('#acb-search');
    searchInput.addEventListener('input', onSearchInput);

    const searchClearBtn = panelEl.querySelector('#acb-search-clear');
    searchClearBtn.addEventListener('click', () => {
      searchInput.value = '';
      searchClearBtn.classList.remove('visible');
      onSearchInput();
      searchInput.focus();
    });

    panelEl.querySelector('#acb-inject-all').addEventListener('click', onInjectAll);

    resultsList = panelEl.querySelector('#acb-results');
    contextBar = panelEl.querySelector('#acb-context-bar');
    footerEl = panelEl.querySelector('#acb-footer');
    toastEl = panelEl.querySelector('#acb-toast');

    shadowRoot.appendChild(panelEl);
  }

  // =========================================================================
  // Panel Open / Close
  // =========================================================================
  function togglePanel() {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function openPanel() {
    isOpen = true;
    panelEl.classList.add('open');
    backdropEl.classList.add('visible');
    backdropEl.style.pointerEvents = 'auto';
    triggerBtn.classList.add('hidden');
    searchInput.value = '';
    isSearchMode = false;

    // Force fresh scoring on open to recover from stale/failed state
    extractAndScore(true);
  }

  function closePanel() {
    isOpen = false;
    panelEl.classList.remove('open');
    backdropEl.classList.remove('visible');
    backdropEl.style.pointerEvents = 'none';
    triggerBtn.classList.remove('hidden');
  }

  // =========================================================================
  // Context Extraction
  // =========================================================================
  function extractContextText() {
    const selector = MESSAGE_SELECTORS[SITE];
    if (!selector) return '';

    try {
      const messageEls = document.querySelectorAll(selector);
      if (!messageEls || messageEls.length === 0) return '';

      // Get the last N user messages
      const messages = [];
      const els = Array.from(messageEls).slice(-MAX_CONTEXT_MESSAGES);
      for (const el of els) {
        const text = (el.textContent || '').trim();
        if (text.length > 0) {
          messages.push(text);
        }
      }

      return messages.join('\n\n');
    } catch (e) {
      console.warn('[AI Context Bridge] Failed to extract context:', e);
      return '';
    }
  }

  function extractKeywords(text) {
    if (!text) return [];

    const stopwords = new Set([
      'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
      'this', 'that', 'i', 'you', 'we', 'they', 'my', 'your', 'do', 'does',
      'did', 'has', 'had', 'have', 'will', 'would', 'could', 'should', 'can',
      'what', 'which', 'who', 'how', 'when', 'where', 'why', 'not', 'no',
      'me', 'him', 'her', 'us', 'them', 'if', 'so', 'just', 'about', 'like',
      'get', 'make', 'know', 'think', 'want', 'need', 'use', 'using', 'used'
    ]);

    const words = text.toLowerCase()
      .replace(/[^a-z0-9\-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopwords.has(w));

    // Count frequency
    const freq = {};
    for (const w of words) {
      freq[w] = (freq[w] || 0) + 1;
    }

    // Sort by frequency descending, take top N
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CONTEXT_KEYWORDS)
      .map(([word]) => word);
  }

  // =========================================================================
  // Relevance Scoring (via background service worker)
  // =========================================================================
  async function extractAndScore(forceRefresh = false) {
    const contextText = extractContextText();

    // Skip if context hasn't changed meaningfully — but still render cached results
    if (!forceRefresh && contextText === lastContextText && results.length > 0) {
      if (isOpen && !isSearchMode) renderResults();
      return;
    }

    // Skip if already loading the same context (prevent duplicate in-flight requests)
    if (!forceRefresh && isLoading && contextText === lastContextText) {
      return;
    }

    lastContextText = contextText;
    lastError = null;

    // Update context keywords display
    updateContextBar(contextText);

    if (!contextText || contextText.trim().length < 10) {
      // Not enough context yet
      results = [];
      updateBadge(0);
      if (isOpen) renderResults();
      return;
    }

    isLoading = true;
    if (isOpen) renderLoading();

    // Track this request so stale responses from earlier calls are ignored
    const requestId = ++extractRequestId;

    console.log('[AI Context Bridge] Sending FIND_RELEVANT, context length:', contextText.length, 'requestId:', requestId);

    try {
      const response = await sendMessage({
        type: 'FIND_RELEVANT',
        contextText: contextText,
        options: { maxResults: 8, minScore: 0.1 }
      });

      console.log('[AI Context Bridge] Got response:', response ? `${response.results?.length || 0} results` : 'null/undefined');

      // Ignore stale response if a newer request was fired
      if (requestId !== extractRequestId) return;

      if (response && response.results) {
        results = response.results;
      } else {
        results = [];
      }
    } catch (err) {
      // Ignore stale errors
      if (requestId !== extractRequestId) return;

      if (err.message && err.message.includes('Extension context invalidated')) {
        console.info('[AI Context Bridge] Extension was reloaded — relevance scoring unavailable until page refresh.');
        lastError = 'Extension was reloaded. Please refresh the page.';
      } else if (err.message && err.message.includes('timed out')) {
        console.warn('[AI Context Bridge] Service worker timed out — retrying once...');
        // Retry once on timeout (service worker may have been waking up)
        try {
          const retry = await sendMessage({
            type: 'FIND_RELEVANT',
            contextText: contextText,
            options: { maxResults: 8, minScore: 0.1 }
          });
          if (requestId !== extractRequestId) return;
          if (retry && retry.results) {
            results = retry.results;
          } else {
            results = [];
          }
        } catch (retryErr) {
          if (requestId !== extractRequestId) return;
          console.warn('[AI Context Bridge] Retry also failed:', retryErr.message || retryErr);
          lastError = 'Could not reach service worker. Try closing and reopening the panel.';
          results = [];
        }
      } else {
        console.warn('[AI Context Bridge] Relevance scoring failed:', err.message || err);
        lastError = 'Relevance scoring failed. Click retry to try again.';
        results = [];
      }
    }

    isLoading = false;
    updateBadge(results.length);
    if (isOpen && !isSearchMode) renderResults();
  }

  async function performSearch(query) {
    if (!query || query.trim().length < 2) {
      isSearchMode = false;
      renderResults();
      return;
    }

    isSearchMode = true;
    isLoading = true;
    renderLoading();

    try {
      const response = await sendMessage({
        type: 'SEARCH_KNOWLEDGE',
        query: query.trim(),
        options: { maxResults: 10 }
      });

      if (response && response.results) {
        results = response.results;
      } else {
        results = [];
      }
    } catch (err) {
      console.warn('[AI Context Bridge] Search failed:', err);
      lastError = err.message && err.message.includes('timed out')
        ? 'Search timed out. Try again.'
        : 'Search failed. Try again.';
      results = [];
    }

    isLoading = false;
    renderResults();
  }

  // =========================================================================
  // Message Passing
  // =========================================================================
  function sendMessage(msg, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Service worker response timed out'));
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // =========================================================================
  // UI Rendering
  // =========================================================================
  function updateBadge(count) {
    if (!badgeEl) return;
    badgeEl.textContent = String(count);
    if (count > 0) {
      badgeEl.classList.add('has-items');
    } else {
      badgeEl.classList.remove('has-items');
    }
  }

  function updateContextBar(contextText) {
    if (!contextBar) return;
    const keywordsEl = contextBar.querySelector('#acb-context-keywords');
    if (!keywordsEl) return;

    const keywords = extractKeywords(contextText);

    if (keywords.length === 0) {
      keywordsEl.innerHTML = '<span class="acb-keyword-chip">No context detected yet</span>';
    } else {
      keywordsEl.innerHTML = keywords
        .map(kw => `<span class="acb-keyword-chip">${escapeHtml(kw)}</span>`)
        .join('');
    }
  }

  function renderLoading() {
    if (!resultsList) return;
    const skeletonCard = `
      <div class="acb-card acb-skeleton-card">
        <div class="acb-skeleton-line" style="width:35%;height:8px;margin-bottom:8px"></div>
        <div class="acb-skeleton-line" style="width:80%;height:11px;margin-bottom:10px"></div>
        <div class="acb-skeleton-line" style="width:100%;height:4px;margin-bottom:8px"></div>
        <div class="acb-skeleton-line" style="width:60%;height:9px;margin-bottom:10px"></div>
        <div style="display:flex;gap:6px">
          <div class="acb-skeleton-line" style="width:50px;height:24px;border-radius:6px"></div>
          <div class="acb-skeleton-line" style="width:56px;height:24px;border-radius:6px"></div>
        </div>
      </div>`;
    resultsList.innerHTML = skeletonCard + skeletonCard + skeletonCard;
    if (footerEl) footerEl.style.display = 'none';
  }

  function renderResults() {
    if (!resultsList) return;

    if (isLoading) {
      renderLoading();
      return;
    }

    if (results.length === 0) {
      renderEmptyState();
      if (footerEl) footerEl.style.display = 'none';
      return;
    }

    let html = '';
    for (let i = 0; i < results.length; i++) {
      html += renderCard(results[i], i);
    }
    resultsList.innerHTML = html;

    // Wire up card event listeners
    for (let i = 0; i < results.length; i++) {
      const card = resultsList.querySelector(`[data-index="${i}"]`);
      if (!card) continue;

      const injectBtn = card.querySelector('.acb-btn-inject');
      const previewBtn = card.querySelector('.acb-btn-preview');

      if (injectBtn) {
        injectBtn.addEventListener('click', () => onInjectSingle(i));
      }
      if (previewBtn) {
        previewBtn.addEventListener('click', () => onTogglePreview(i));
      }
    }

    // Show footer with Inject All
    if (footerEl) {
      footerEl.style.display = 'block';
      const injectAllBtn = footerEl.querySelector('#acb-inject-all');
      if (injectAllBtn) {
        injectAllBtn.disabled = false;
        injectAllBtn.textContent = `Inject All (${results.length} items)`;
        injectAllBtn.classList.remove('success');
      }
    }
  }

  function renderCard(item, index) {
    const { summary, topic, score, reason, type } = item;
    const isConversation = type === 'conversation';
    const topicName = isConversation
      ? (summary.source || 'Conversation').charAt(0).toUpperCase() + (summary.source || 'conversation').slice(1)
      : (topic ? topic.name : 'General');
    const title = summary.title || 'Untitled';
    const maxScore = 10;
    const percentage = Math.min(Math.round((score / maxScore) * 100), 100);

    let detailHtml = '';
    if (isConversation) {
      // Show source badge + message preview
      const sourceColors = { chatgpt: '#10a37f', claude: '#d97706', gemini: '#2563eb', copilot: '#7c3aed' };
      const srcColor = sourceColors[summary.source] || '#6b7280';
      const msgs = (summary.messages || []).slice(-2);
      let previewText = '';
      if (msgs.length > 0) {
        previewText = msgs.map(m => `${m.role}: ${(m.content || '').slice(0, 80)}`).join(' | ');
        if (previewText.length > 120) previewText = previewText.slice(0, 120) + '...';
      }
      detailHtml = `<div class="acb-card-tags">` +
        `<span class="acb-tag" style="background:${srcColor};color:#fff">${escapeHtml(summary.source || 'conversation')}</span>` +
        `<span class="acb-tag">${summary.messageCount || 0} msgs</span>` +
        `</div>`;
      if (previewText) {
        detailHtml += `<div class="acb-card-reason" style="font-style:italic;margin-top:4px">${escapeHtml(previewText)}</div>`;
      }
    } else {
      const tags = (summary.tags || []).slice(0, MAX_VISIBLE_TAGS);
      if (tags.length > 0) {
        detailHtml = '<div class="acb-card-tags">' +
          tags.map(t => `<span class="acb-tag">${escapeHtml(t)}</span>`).join('') +
          '</div>';
      }
    }

    return `
      <div class="acb-card" data-index="${index}" data-type="${isConversation ? 'conversation' : 'summary'}">
        <div class="acb-card-topic">${escapeHtml(topicName)}</div>
        <div class="acb-card-title">${escapeHtml(title)}</div>

        <div class="acb-score-row">
          <div class="acb-score-bar-track">
            <div class="acb-score-bar-fill" style="width: ${percentage}%"></div>
          </div>
          <span class="acb-score-label">${percentage}%</span>
        </div>

        <div class="acb-card-reason">${escapeHtml(reason)}</div>

        ${detailHtml}

        <div class="acb-card-actions">
          <button class="acb-btn acb-btn-inject" data-action="inject" title="Inject into chat">
            ${ICONS.inject}
            <span>Inject</span>
          </button>
          <button class="acb-btn acb-btn-preview" data-action="preview" title="Preview full content">
            ${ICONS.preview}
            <span>Preview</span>
          </button>
        </div>

        <div class="acb-preview" id="acb-preview-${index}">
          ${isConversation ? renderConversationPreview(summary) : renderPreviewContent(summary)}
        </div>
      </div>
    `;
  }

  function renderConversationPreview(summary) {
    const messages = (summary.messages || []).slice(-6);
    if (messages.length === 0) return '<div class="acb-preview-text">No messages</div>';

    let html = '';
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      const content = (msg.content || '').slice(0, 200);
      html += `<div class="acb-preview-section-title">${role}</div>`;
      html += `<div class="acb-preview-text">${escapeHtml(content)}${msg.content && msg.content.length > 200 ? '...' : ''}</div>`;
    }
    return html;
  }

  function renderPreviewContent(summary) {
    let html = '';

    // Summary text
    if (summary.summary) {
      html += `<div class="acb-preview-text">${escapeHtml(summary.summary)}</div>`;
    }

    // Key insights
    if (summary.keyInsights && summary.keyInsights.length > 0) {
      html += '<div class="acb-preview-section-title">Key Insights</div>';
      html += '<ul class="acb-preview-list">';
      for (const insight of summary.keyInsights) {
        html += `<li>${escapeHtml(insight)}</li>`;
      }
      html += '</ul>';
    }

    // Decisions
    if (summary.decisions && summary.decisions.length > 0) {
      html += '<div class="acb-preview-section-title">Decisions</div>';
      html += '<ul class="acb-preview-list">';
      for (const decision of summary.decisions) {
        html += `<li>${escapeHtml(decision)}</li>`;
      }
      html += '</ul>';
    }

    // Code snippets
    if (summary.codeSnippets && summary.codeSnippets.length > 0) {
      html += '<div class="acb-preview-section-title">Code</div>';
      for (const snippet of summary.codeSnippets) {
        if (snippet.description) {
          html += `<div class="acb-preview-code-label">${escapeHtml(snippet.description)}</div>`;
        }
        html += `<pre class="acb-preview-code">${escapeHtml(snippet.code || '')}</pre>`;
      }
    }

    return html;
  }

  function renderEmptyState() {
    let title, message, showRetry = false;

    if (lastError) {
      title = 'Connection Issue';
      message = lastError;
      showRetry = true;
    } else if (isSearchMode) {
      title = 'No Results';
      message = 'No results found for your search. Try different keywords.';
    } else {
      title = 'No Relevant Knowledge';
      message = 'No relevant knowledge found for the current conversation. Try adding more context or searching manually.';
    }

    resultsList.innerHTML = `
      <div class="acb-empty">
        <div class="acb-empty-icon">${ICONS.empty}</div>
        <div class="acb-empty-title">${title}</div>
        <div class="acb-empty-desc">${message}</div>
        ${showRetry ? '<button class="acb-btn acb-btn-retry" id="acb-retry-btn">Retry</button>' : ''}
      </div>
    `;

    if (showRetry) {
      const retryBtn = resultsList.querySelector('#acb-retry-btn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          lastError = null;
          lastContextText = '';
          extractAndScore(true);
        });
      }
    }
  }

  // =========================================================================
  // User Actions
  // =========================================================================
  function onSearchInput() {
    const query = searchInput.value.trim();
    const clearBtn = shadowRoot.querySelector('#acb-search-clear');
    if (clearBtn) clearBtn.classList.toggle('visible', query.length > 0);

    if (query.length === 0) {
      isSearchMode = false;
      // Restore auto-detected results
      lastContextText = ''; // Force re-score
      extractAndScore();
      return;
    }

    // Debounced search
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => performSearch(query), 500);
  }

  async function onInjectSingle(index) {
    if (index < 0 || index >= results.length) return;

    const item = results[index];
    const { summary, topic, type } = item;

    try {
      // Request formatted text from background
      const isConversation = type === 'conversation';
      const response = await sendMessage(isConversation ? {
        type: 'FORMAT_CONVERSATION_INJECTION',
        conversationId: summary.id,
        targetSystem: SITE
      } : {
        type: 'FORMAT_INJECTION',
        summaryId: summary.id,
        topicId: topic ? topic.id : null,
        targetSystem: SITE
      });

      if (!response || !response.text) {
        showToast('Failed to format knowledge', true);
        return;
      }

      // Find and insert into chat input
      const input = findChatInput();
      if (!input) {
        // Fallback: copy to clipboard
        await navigator.clipboard.writeText(response.text);
        showToast('Copied to clipboard (chat input not found)');
        updateInjectButton(index, true);
        notifyUsage(summary.id);
        recordInjectionContext(summary.id, topic ? topic.id : null);
        return;
      }

      insertIntoChatInput(input, response.text);
      showToast('Knowledge injected into chat');
      updateInjectButton(index, true);

      // Notify usage for tracking
      notifyUsage(summary.id);
      recordInjectionContext(summary.id, topic ? topic.id : null);
    } catch (err) {
      console.error('[AI Context Bridge] Injection failed:', err);
      showToast('Injection failed: ' + err.message, true);
    }
  }

  async function onInjectAll() {
    if (results.length === 0) return;

    const injectAllBtn = footerEl.querySelector('#acb-inject-all');
    if (injectAllBtn) {
      injectAllBtn.disabled = true;
      injectAllBtn.textContent = 'Injecting...';
    }

    try {
      // Separate summary and conversation results
      const summaryItems = results.filter(r => r.type !== 'conversation');
      const convItems = results.filter(r => r.type === 'conversation');

      // Format summaries as batch, conversations individually
      const textParts = [];

      if (summaryItems.length > 0) {
        const batchResponse = await sendMessage({
          type: 'FORMAT_BATCH_INJECTION',
          items: summaryItems.map(r => ({
            summaryId: r.summary.id,
            topicId: r.topic ? r.topic.id : null
          })),
          targetSystem: SITE
        });
        if (batchResponse && batchResponse.text) textParts.push(batchResponse.text);
      }

      for (const r of convItems) {
        const convResponse = await sendMessage({
          type: 'FORMAT_CONVERSATION_INJECTION',
          conversationId: r.summary.id,
          targetSystem: SITE
        });
        if (convResponse && convResponse.text) textParts.push(convResponse.text);
      }

      const response = { text: textParts.join('\n') };

      if (!response || !response.text) {
        showToast('Failed to format knowledge', true);
        if (injectAllBtn) {
          injectAllBtn.disabled = false;
          injectAllBtn.textContent = `Inject All (${results.length} items)`;
        }
        return;
      }

      const input = findChatInput();
      if (!input) {
        await navigator.clipboard.writeText(response.text);
        showToast('Copied to clipboard (chat input not found)');
      } else {
        insertIntoChatInput(input, response.text);
        showToast('All knowledge injected into chat');
      }

      // Notify usage and record lineage for all items
      for (const item of results) {
        notifyUsage(item.summary.id);
        recordInjectionContext(item.summary.id, item.topic ? item.topic.id : null);
      }

      if (injectAllBtn) {
        injectAllBtn.classList.add('success');
        injectAllBtn.textContent = 'Injected!';
        setTimeout(() => {
          injectAllBtn.classList.remove('success');
          injectAllBtn.disabled = false;
          injectAllBtn.textContent = `Inject All (${results.length} items)`;
        }, 2000);
      }
    } catch (err) {
      console.error('[AI Context Bridge] Batch injection failed:', err);
      showToast('Injection failed: ' + err.message, true);
      if (injectAllBtn) {
        injectAllBtn.disabled = false;
        injectAllBtn.textContent = `Inject All (${results.length} items)`;
      }
    }
  }

  function onTogglePreview(index) {
    const previewEl = resultsList.querySelector(`#acb-preview-${index}`);
    if (!previewEl) return;

    const isCurrentlyOpen = previewEl.classList.contains('open');
    previewEl.classList.toggle('open');

    // Update button text
    const card = resultsList.querySelector(`[data-index="${index}"]`);
    if (card) {
      const btn = card.querySelector('.acb-btn-preview span');
      if (btn) {
        btn.textContent = isCurrentlyOpen ? 'Preview' : 'Hide';
      }
    }
  }

  function updateInjectButton(index, success) {
    const card = resultsList.querySelector(`[data-index="${index}"]`);
    if (!card) return;

    const btn = card.querySelector('.acb-btn-inject');
    if (!btn) return;

    if (success) {
      btn.classList.add('success');
      btn.innerHTML = `${ICONS.check}<span>Injected</span>`;
      setTimeout(() => {
        btn.classList.remove('success');
        btn.innerHTML = `${ICONS.inject}<span>Inject</span>`;
      }, 2000);
    }
  }

  function notifyUsage(summaryId) {
    sendMessage({ type: 'INJECT_USED', summaryId, targetSystem: SITE }).catch(() => {
      // Non-critical, silently ignore
    });
  }

  /**
   * Record that knowledge was injected so the capture orchestrator can tag
   * the conversation with its lineage (summaryId + topicId).
   * capture.js reads and drains this array in flushBuffer().
   */
  function recordInjectionContext(summaryId, topicId) {
    if (!window.__ACB_INJECTION_CONTEXT) window.__ACB_INJECTION_CONTEXT = [];
    window.__ACB_INJECTION_CONTEXT.push({ summaryId, topicId, timestamp: Date.now() });
  }

  // =========================================================================
  // Toast Notifications
  // =========================================================================
  function showToast(message, isError) {
    if (!toastEl) return;

    toastEl.textContent = message;
    toastEl.classList.toggle('error', !!isError);
    toastEl.classList.add('visible');

    setTimeout(() => {
      toastEl.classList.remove('visible');
    }, 2500);
  }

  // =========================================================================
  // Chat Input Detection & Insertion (content script version)
  // =========================================================================
  function findChatInput() {
    const selectors = INPUT_SELECTORS[SITE];
    if (!selectors) return null;

    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  function insertIntoChatInput(input, text) {
    if (!input || !text) return;

    const tagName = input.tagName.toLowerCase();
    const isContentEditable = input.getAttribute('contenteditable') === 'true';

    if (tagName === 'textarea' || tagName === 'input') {
      insertIntoTextarea(input, text);
    } else if (isContentEditable) {
      insertIntoContentEditable(input, text);
    }
  }

  function insertIntoTextarea(textarea, text) {
    textarea.focus();

    const existing = textarea.value;
    const prefix = existing.length > 0 ? existing + '\n\n' : '';
    const newValue = prefix + text;

    // Use native setter to bypass React controlled input
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(textarea, newValue);
    } else {
      textarea.value = newValue;
    }

    // Dispatch events for framework reactivity
    textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    try {
      textarea.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
    } catch (e) {
      // Fallback: some browsers don't support all InputEvent options
    }

    textarea.selectionStart = textarea.selectionEnd = newValue.length;

    // Auto-resize
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function insertIntoContentEditable(element, text) {
    element.focus();

    const existingText = element.textContent || '';
    const separator = existingText.trim().length > 0 ? '\n\n' : '';
    const fullText = separator + text;

    // Move selection to end
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    // Strategy 1: execCommand (widely compatible with ProseMirror)
    const execResult = document.execCommand('insertText', false, fullText);

    if (!execResult) {
      // Strategy 2: Manual DOM insertion
      const lines = fullText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
          const br = document.createElement('br');
          range.insertNode(br);
          range.setStartAfter(br);
          range.collapse(true);
        }
        if (lines[i].length > 0) {
          const textNode = document.createTextNode(lines[i]);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
        }
      }
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Trigger framework event handlers
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));

    try {
      element.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: text
      }));
    } catch (e) {
      // CompositionEvent may not be available
    }
  }

  // =========================================================================
  // Chat Observer (watches for new messages to re-score)
  // =========================================================================
  function startChatObserver() {
    const containerSelector = CHAT_CONTAINER_SELECTORS[SITE];
    if (!containerSelector) return;

    // Try to find the container, retry if not yet available
    let attempts = 0;
    const maxAttempts = 20;

    function tryAttach() {
      let container = null;
      const selectors = containerSelector.split(', ');
      for (const sel of selectors) {
        container = document.querySelector(sel.trim());
        if (container) break;
      }

      if (!container) {
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(tryAttach, 1000);
        }
        return;
      }

      observer = new MutationObserver(debouncedExtractAndScore);
      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    const debouncedExtractAndScore = debounce(() => {
      if (!isSearchMode) {
        extractAndScore();
      }
    }, DEBOUNCE_MS);

    tryAttach();
  }

  // =========================================================================
  // Inline CSS (embedded to avoid async loading issues in Shadow DOM)
  // =========================================================================
  const CSS_TEXT = `
/* Reset */
:host {
  all: initial;
  font-family: 'Helvetica Neue', Helvetica, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1d1d1f;
  box-sizing: border-box;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; font-family: inherit; }

/* Trigger Button */
.acb-trigger {
  position: fixed;
  top: 50%;
  right: 0;
  transform: translateY(-50%);
  z-index: 999999;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: 10px 0 0 10px;
  background: #fff;
  color: #1d1d1f;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.acb-trigger:hover {
  transform: translateY(-50%) translateX(-4px);
  box-shadow: 0 2px 6px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06);
}
.acb-trigger:active { transform: translateY(-50%) translateX(-2px); }
.acb-trigger-logo { width: 24px; height: 24px; border-radius: 4px; }
.acb-trigger-badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px; background: rgba(0,0,0,0.06);
  font-size: 10px; font-weight: 700; line-height: 16px;
  text-align: center; display: none;
}
.acb-trigger-badge.has-items {
  display: inline-flex; align-items: center; justify-content: center;
  background: #d97706; color: #fff;
}
.acb-trigger.hidden {
  transform: translateY(-50%) translateX(100%); opacity: 0; pointer-events: none;
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease;
}

/* Panel */
.acb-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 340px; max-width: 90vw; z-index: 999999;
  display: flex; flex-direction: column;
  background: #f5f5f7;
  border-left: 1px solid #e5e7eb;
  box-shadow: -8px 0 30px rgba(0,0,0,0.08);
  transform: translateX(100%); opacity: 0;
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
  pointer-events: none;
}
.acb-panel.open {
  transform: translateX(0); opacity: 1; pointer-events: auto;
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
}

/* Header */
.acb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #e5e7eb;
  background: #fff;
  flex-shrink: 0;
}
.acb-header-title {
  font-size: 14px; font-weight: 700; color: #1d1d1f;
  display: flex; align-items: center; gap: 8px;
}
.acb-header-logo { width: 22px; height: 22px; border-radius: 4px; flex-shrink: 0; }
.acb-close-btn {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border: none; border-radius: 6px;
  background: transparent; color: #6b7280; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.acb-close-btn:hover { background: #f3f4f6; color: #1d1d1f; }
.acb-close-btn svg { width: 16px; height: 16px; }

/* Context Bar */
.acb-context-bar {
  padding: 10px 16px; border-bottom: 1px solid #e5e7eb;
  font-size: 11px; color: #6b7280; flex-shrink: 0; background: #fff;
}
.acb-context-keywords { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.acb-keyword-chip {
  display: inline-block; padding: 2px 7px; border-radius: 4px;
  background: #eff6ff; color: #2563eb;
  font-size: 10px; font-weight: 500; line-height: 1.4;
}

/* Search */
.acb-search-wrap {
  padding: 10px 16px; border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0; position: relative; background: #fff;
}
.acb-search-input {
  width: 100%; padding: 7px 12px 7px 32px;
  border: 1px solid #e5e7eb; border-radius: 6px;
  background: #fff; color: #1d1d1f;
  font-size: 13px; font-family: inherit;
  outline: none; transition: border-color 0.15s;
}
.acb-search-input::placeholder { color: #9ca3af; }
.acb-search-input:focus { border-color: #2563eb; }
.acb-search-clear {
  position: absolute; right: 22px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer;
  font-size: 16px; line-height: 1; color: #6b7280;
  padding: 0 4px; border-radius: 50%;
  display: none; transition: color 0.15s, background 0.15s;
}
.acb-search-clear:hover { color: #1d1d1f; background: #e5e7eb; }
.acb-search-clear.visible { display: block; }
.acb-search-icon {
  position: absolute; left: 26px; top: 50%; transform: translateY(-50%);
  width: 14px; height: 14px; color: #6b7280; pointer-events: none;
}

/* Results */
.acb-results {
  flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px 0;
  scrollbar-width: thin; scrollbar-color: #d1d5db transparent;
}
.acb-results::-webkit-scrollbar { width: 4px; }
.acb-results::-webkit-scrollbar-track { background: transparent; }
.acb-results::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 2px; }
.acb-results::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

/* Card */
.acb-card {
  margin: 0 10px 8px; padding: 12px 14px;
  border: 1px solid rgba(0,0,0,0.04); border-radius: 8px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
  transition: box-shadow 0.15s;
}
.acb-card:hover { box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
.acb-card-topic {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: #2563eb; margin-bottom: 4px;
}
.acb-card-title {
  font-size: 13px; font-weight: 600; color: #1d1d1f;
  margin-bottom: 6px; line-height: 1.35;
}

/* Score */
.acb-score-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.acb-score-bar-track { flex: 1; height: 4px; border-radius: 2px; background: #e5e7eb; overflow: hidden; }
.acb-score-bar-fill { height: 100%; border-radius: 2px; background: #2563eb; transition: width 0.4s cubic-bezier(0.22,1,0.36,1); }
.acb-score-label { font-size: 10px; font-weight: 600; color: #2563eb; min-width: 32px; text-align: right; }

/* Reason */
.acb-card-reason { font-size: 11px; color: #6b7280; margin-bottom: 8px; line-height: 1.4; }

/* Tags */
.acb-card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.acb-tag {
  display: inline-block; padding: 2px 7px; border-radius: 4px;
  background: #eff6ff; color: #2563eb;
  font-size: 10px; font-weight: 500; line-height: 1.4;
}

/* Card Actions */
.acb-card-actions { display: flex; gap: 6px; }
.acb-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border: 1px solid transparent; border-radius: 6px;
  font-size: 11px; font-weight: 500; font-family: inherit; cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s;
}
.acb-btn:active { transform: scale(0.97); }
.acb-btn svg { width: 12px; height: 12px; flex-shrink: 0; }
.acb-btn-inject {
  background: linear-gradient(135deg, #262624, #0D0D0D);
  color: #F2F2F2;
  box-shadow: 0 2px 8px rgba(13,13,13,0.3), 0 1px 3px rgba(0,0,0,0.15);
}
.acb-btn-inject:hover { box-shadow: 0 4px 14px rgba(13,13,13,0.4), 0 2px 6px rgba(0,0,0,0.2); }
.acb-btn-inject.success { background: linear-gradient(135deg, #22c55e, #16a34a); }
.acb-btn-preview { background: transparent; color: #6b7280; border-color: #e5e7eb; }
.acb-btn-preview:hover { background: rgba(0,0,0,0.03); color: #1d1d1f; border-color: #9ca3af; }

/* Preview */
.acb-preview { max-height: 0; overflow: hidden; transition: max-height 0.3s ease, opacity 0.2s ease; opacity: 0; }
.acb-preview.open { max-height: 400px; overflow-y: auto; opacity: 1; margin-top: 10px; padding-top: 10px; border-top: 1px solid #e5e7eb; }
.acb-preview-text { font-size: 12px; color: #374151; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
.acb-preview-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #2563eb; margin-top: 10px; margin-bottom: 4px; }
.acb-preview-list { padding-left: 16px; margin-bottom: 6px; }
.acb-preview-list li { font-size: 12px; color: #374151; margin-bottom: 3px; line-height: 1.5; }
.acb-preview-code { background: #1e293b; color: #e2e8f0; border-radius: 6px; padding: 8px 10px; margin: 6px 0; font-family: 'SF Mono', Menlo, monospace; font-size: 11px; overflow-x: auto; white-space: pre; line-height: 1.5; }
.acb-preview-code-label { font-size: 10px; color: #6b7280; margin-bottom: 2px; font-style: italic; }

/* Footer */
.acb-footer { padding: 12px 16px; border-top: 1px solid #e5e7eb; background: #fff; flex-shrink: 0; }
.acb-inject-all-btn {
  width: 100%; padding: 9px 16px; border: none; border-radius: 6px;
  background: linear-gradient(135deg, #262624, #0D0D0D);
  color: #F2F2F2; font-size: 13px; font-weight: 600; font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(13,13,13,0.3), 0 1px 3px rgba(0,0,0,0.15);
  transition: box-shadow 0.15s, transform 0.1s;
}
.acb-inject-all-btn:hover { box-shadow: 0 4px 14px rgba(13,13,13,0.4), 0 2px 6px rgba(0,0,0,0.2); transform: translateY(-1px); }
.acb-inject-all-btn:active { box-shadow: 0 1px 4px rgba(13,13,13,0.3); transform: translateY(0); }
.acb-inject-all-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
.acb-inject-all-btn.success { background: linear-gradient(135deg, #22c55e, #16a34a); }

/* Empty State */
.acb-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 24px; text-align: center; }
.acb-empty-icon { width: 48px; height: 48px; color: #d1d5db; margin-bottom: 16px; }
.acb-empty-title { font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 6px; }
.acb-empty-desc { font-size: 12px; color: #6b7280; line-height: 1.5; max-width: 220px; }
.acb-btn-retry {
  margin-top: 12px; padding: 6px 16px;
  background: #e5e7eb; color: #374151; border: 1px solid #e5e7eb;
  border-radius: 6px; font-size: 12px; cursor: pointer; transition: background 0.15s;
}
.acb-btn-retry:hover { background: #d1d5db; }

/* Skeleton Loading */
@keyframes acb-shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.acb-skeleton-card { pointer-events: none; }
.acb-skeleton-line {
  background: linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%);
  background-size: 200% 100%;
  animation: acb-shimmer 1.5s ease-in-out infinite;
  border-radius: 4px;
}

/* Toast */
.acb-toast {
  position: absolute; bottom: 70px; left: 16px; right: 16px;
  padding: 10px 14px; border-radius: 8px; background: #10a37f;
  color: #fff; font-size: 12px; font-weight: 600; text-align: center;
  opacity: 0; transform: translateY(8px);
  transition: opacity 0.25s ease, transform 0.25s ease; pointer-events: none;
}
.acb-toast.visible { opacity: 1; transform: translateY(0); }
.acb-toast.error { background: #dc2626; }

/* Backdrop */
.acb-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  z-index: 999998; background: rgba(0,0,0,0.3);
  opacity: 0; pointer-events: none;
  transition: opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
.acb-backdrop.visible {
  opacity: 1; pointer-events: auto;
  transition: opacity 0.25s ease;
}

/* Responsive */
@media (max-width: 480px) {
  .acb-panel { width: 100vw; max-width: 100vw; }
  .acb-trigger { width: 36px; height: 36px; }
  .acb-trigger-logo { width: 20px; height: 20px; }
}
@media (max-height: 500px) {
  .acb-header { padding: 10px 14px; }
  .acb-card { padding: 10px 12px; margin: 0 8px 6px; }
  .acb-footer { padding: 8px 14px; }
}
  `;

  // =========================================================================
  // Initialization
  // =========================================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to let the AI site initialize its own DOM
    setTimeout(init, 500);
  }

  // Cleanup on navigation (SPA)
  window.addEventListener('beforeunload', () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  });

})();
