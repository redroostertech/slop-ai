/**
 * Claude DOM Observer — content-scripts/sites/claude.js
 *
 * Observes the Claude conversation DOM in real-time to capture user and
 * assistant messages as they appear.  Uses a content-stability approach:
 * messages are only emitted once their content has stopped changing for
 * a stability period, ensuring we capture final output not streaming chunks.
 *
 * Runs as a plain content script (no ES modules).  Exposes its API on
 * window.__ACB_SITE so the capture orchestrator can call it.
 *
 * Target host: claude.ai
 */
(function () {
  'use strict';

  if (window.__ACB_SITE) return;

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  const SEL = {
    chatContainer: '[class*="conversation-content"], main, [role="main"]',
    userMessage: '.font-user-message, [data-testid="user-message"], [class*="user-message"]',
    assistantMessage: '[data-is-streaming], [class*="response-content"], [class*="assistant-message"], [data-testid="assistant-message"]',
    messageRow: '[class*="message-row"], [class*="chat-message"], [data-testid*="message"]',
    titleElement: '[class*="conversation-title"], nav a[aria-current="page"], [data-testid="conversation-title"]',
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
    clone.querySelectorAll('button, [class*="copy"], [class*="action"], svg, [class*="icon"]').forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  /**
   * Determine the role of a message element by walking up the DOM.
   */
  function classifyRole(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      const cls = node.className || '';
      const testId = node.getAttribute?.('data-testid') || '';

      if (
        cls.includes('font-user-message') ||
        cls.includes('user-message') ||
        testId.includes('user-message')
      ) {
        return 'user';
      }
      if (
        node.hasAttribute?.('data-is-streaming') ||
        cls.includes('response-content') ||
        cls.includes('assistant-message') ||
        testId.includes('assistant-message')
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
   * Collect all message elements in the DOM, regardless of role classification
   * strategy.  Returns an array of { el, role, contentEl }.
   */
  function collectMessageElements() {
    const found = [];
    const seen = new Set();

    // Strategy 1: explicit user and assistant selectors
    const userEls = document.querySelectorAll(SEL.userMessage);
    const assistantEls = document.querySelectorAll(SEL.assistantMessage);

    for (const el of userEls) {
      if (seen.has(el)) continue;
      seen.add(el);
      found.push({ el, role: classifyRole(el) || 'user', contentEl: el });
    }
    for (const el of assistantEls) {
      if (seen.has(el)) continue;
      seen.add(el);
      found.push({ el, role: classifyRole(el) || 'assistant', contentEl: el });
    }

    // Strategy 2 (fallback): walk message rows
    if (found.length === 0) {
      const rows = document.querySelectorAll(SEL.messageRow);
      for (const row of rows) {
        if (seen.has(row)) continue;
        const role = classifyRole(row);
        if (!role) continue;
        seen.add(row);
        found.push({ el: row, role, contentEl: row });
      }
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
      if (role !== 'user' && role !== 'assistant') continue;

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
      title = document.title.replace(/\s*[\|–—]\s*Claude.*$/i, '').trim();
    }
    if (!title || title === 'Claude') {
      title = 'Claude Conversation';
    }
    return { title, url: location.href, source: 'claude' };
  }

  window.__ACB_SITE = { startObserving, stopObserving, getConversationMeta };
})();
