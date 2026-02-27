/**
 * Copilot DOM Observer — content-scripts/sites/copilot.js
 *
 * Observes the Microsoft Copilot conversation DOM in real-time to capture
 * user and assistant messages as they appear.  Uses a content-stability
 * approach: messages are only emitted once their content has stopped changing
 * for a stability period, ensuring we capture final output not streaming chunks.
 *
 * Runs as a plain content script (no ES modules).  Exposes its API on
 * window.__ACB_SITE so the capture orchestrator can call it.
 *
 * Target host: copilot.microsoft.com
 */
(function () {
  'use strict';

  if (window.__ACB_SITE) return;

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  const SEL = {
    chatContainer: '#chat-container, main, [role="main"], .chat-container',
    chatTurn: '.chat-turn, [class*="chat-turn"], [data-testid="chat-turn"], cib-chat-turn',
    userMessage: '.user-message, [data-testid="user-message"], [class*="user-request"], cib-message-group[source="user"]',
    botMessage: '.bot-message, [data-testid="bot-message"], [class*="bot-response"], [class*="assistant-message"], cib-message-group[source="bot"]',
    messageContent: '.message-content, [class*="message-text"], .content, .text-message-content, cib-shared',
    titleElement: '.conversation-title, [data-testid="conversation-title"], [class*="thread-title"]',
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let observer = null;
  let onMessageCallback = null;
  let onConversationChangeCallback = null;
  let lastPath = location.pathname;
  let _origPushState = null;
  let _origReplaceState = null;

  /** Stability tracking: DOM element → { content, lastChanged, emitted } */
  const elementState = new Map();

  /** Timer for periodic stability checks */
  let stabilityTimer = null;

  /** How long content must be unchanged before we consider it final (ms) */
  const STABILITY_MS = 1500;

  /** How often to check for stable content (ms) */
  const CHECK_INTERVAL_MS = 500;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function extractText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
      'button, [class*="copy"], [class*="action"], [class*="icon"], svg, [class*="feedback"], [class*="citation"]'
    ).forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  /**
   * Determine the role by examining the element and its ancestors.
   */
  function classifyRole(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      const cls = node.className || '';
      const testId = node.getAttribute?.('data-testid') || '';
      const source = node.getAttribute?.('source') || '';

      if (
        cls.includes('user-message') ||
        cls.includes('user-request') ||
        testId.includes('user-message') ||
        source === 'user'
      ) {
        return 'user';
      }
      if (
        cls.includes('bot-message') ||
        cls.includes('bot-response') ||
        cls.includes('assistant-message') ||
        testId.includes('bot-message') ||
        source === 'bot'
      ) {
        return 'assistant';
      }
      node = node.parentElement;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Content-stability capture
  // ---------------------------------------------------------------------------

  /**
   * Collect all message elements from chat turns or direct selectors.
   * Returns an array of { el, role, contentEl }.
   */
  function collectMessageElements() {
    const found = [];
    const seen = new Set();

    // Strategy 1: iterate over chat turns
    const turns = document.querySelectorAll(SEL.chatTurn);
    if (turns.length > 0) {
      for (const turn of turns) {
        const userEl = turn.querySelector(SEL.userMessage);
        if (userEl && !seen.has(userEl)) {
          seen.add(userEl);
          const contentEl = userEl.querySelector(SEL.messageContent) || userEl;
          found.push({ el: userEl, role: 'user', contentEl });
        }
        const botEl = turn.querySelector(SEL.botMessage);
        if (botEl && !seen.has(botEl)) {
          seen.add(botEl);
          const contentEl = botEl.querySelector(SEL.messageContent) || botEl;
          found.push({ el: botEl, role: 'assistant', contentEl });
        }
      }
    }

    // Strategy 2 (fallback): query user and bot elements directly
    if (found.length === 0) {
      document.querySelectorAll(SEL.userMessage).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const contentEl = el.querySelector(SEL.messageContent) || el;
        found.push({ el, role: 'user', contentEl });
      });
      document.querySelectorAll(SEL.botMessage).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const contentEl = el.querySelector(SEL.messageContent) || el;
        found.push({ el, role: classifyRole(el) || 'assistant', contentEl });
      });
    }

    return found;
  }

  /**
   * Scan all message elements, update their tracked content, and emit
   * any messages whose content has been stable for STABILITY_MS.
   */
  function scanAndEmitStable() {
    const now = Date.now();
    const messageEls = collectMessageElements();
    const toEmit = [];

    for (const { el, role, contentEl } of messageEls) {
      const content = extractText(contentEl);
      if (!content) continue;

      const state = elementState.get(el);

      if (!state) {
        elementState.set(el, { content, lastChanged: now, emitted: false });
        continue;
      }

      if (state.emitted) {
        if (state.content !== content) {
          state.content = content;
          state.lastChanged = now;
          state.emitted = false;
        }
        continue;
      }

      if (state.content !== content) {
        state.content = content;
        state.lastChanged = now;
        continue;
      }

      if (now - state.lastChanged >= STABILITY_MS) {
        state.emitted = true;
        toEmit.push({ role, content, timestamp: new Date().toISOString() });
      }
    }

    if (toEmit.length > 0 && onMessageCallback) {
      onMessageCallback(toEmit);
    }
  }

  function startStabilityChecks() {
    if (stabilityTimer) return;
    stabilityTimer = setInterval(scanAndEmitStable, CHECK_INTERVAL_MS);
  }

  function stopStabilityChecks() {
    if (stabilityTimer) {
      clearInterval(stabilityTimer);
      stabilityTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Conversation change detection
  // ---------------------------------------------------------------------------

  function checkForConversationChange() {
    const currentPath = location.pathname;
    if (currentPath !== lastPath) {
      lastPath = currentPath;
      elementState.clear();
      if (onConversationChangeCallback) {
        onConversationChangeCallback(getConversationMeta());
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function startObserving(onMessage, onConversationChange) {
    if (observer) return;

    onMessageCallback = onMessage;
    onConversationChangeCallback = onConversationChange;
    lastPath = location.pathname;

    const target = document.querySelector(SEL.chatContainer) || document.body;
    observer = new MutationObserver(() => {
      checkForConversationChange();
    });

    observer.observe(target, { childList: true, subtree: true, characterData: true });

    window.addEventListener('popstate', checkForConversationChange);
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      checkForConversationChange();
    };
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      checkForConversationChange();
    };
    _origPushState = originalPushState;
    _origReplaceState = originalReplaceState;

    startStabilityChecks();
    scanAndEmitStable();
  }

  function stopObserving() {
    stopStabilityChecks();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    window.removeEventListener('popstate', checkForConversationChange);
    if (_origPushState) history.pushState = _origPushState;
    if (_origReplaceState) history.replaceState = _origReplaceState;
    _origPushState = null;
    _origReplaceState = null;
    onMessageCallback = null;
    onConversationChangeCallback = null;
    elementState.clear();
  }

  function getConversationMeta() {
    let title = '';
    const titleEl = document.querySelector(SEL.titleElement);
    if (titleEl) {
      title = (titleEl.textContent || '').trim();
    }
    if (!title) {
      title = document.title.replace(/\s*[\|–—]\s*(Microsoft\s+)?Copilot.*$/i, '').trim();
    }
    if (!title || title.toLowerCase() === 'copilot' || title.toLowerCase() === 'microsoft copilot') {
      title = 'Copilot Conversation';
    }
    return { title, url: location.href, source: 'copilot' };
  }

  window.__ACB_SITE = { startObserving, stopObserving, getConversationMeta };
})();
