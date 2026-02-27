/**
 * Gemini DOM Observer — content-scripts/sites/gemini.js
 *
 * Observes the Gemini conversation DOM in real-time to capture user and
 * assistant messages as they appear.  Uses a content-stability approach:
 * messages are only emitted once their content has stopped changing for
 * a stability period, ensuring we capture final output not streaming chunks.
 *
 * Runs as a plain content script (no ES modules).  Exposes its API on
 * window.__ACB_SITE so the capture orchestrator can call it.
 *
 * Target host: gemini.google.com
 */
(function () {
  'use strict';

  if (window.__ACB_SITE) return;

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  const SEL = {
    chatContainer: '.conversation-container, main, [role="main"]',
    conversationTurn: 'conversation-turn, [class*="conversation-turn"]',
    userMessage: '.query-text, .user-query, [data-message-author-role="user"], user-query',
    modelMessage: '.model-response-text, .response-container-content, message-content, model-response',
    titleElement: '.conversation-title, [data-conversation-title], nav a[aria-selected="true"]',
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
    clone.querySelectorAll('button, [class*="copy"], [class*="action"], [class*="icon"], svg, .chip-container').forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  // ---------------------------------------------------------------------------
  // Content-stability capture
  // ---------------------------------------------------------------------------

  /**
   * Collect all message elements from conversation turns or direct selectors.
   * Returns an array of { el, role, contentEl }.
   */
  function collectMessageElements() {
    const found = [];
    const seen = new Set();

    // Strategy 1: iterate over conversation turns
    const turns = document.querySelectorAll(SEL.conversationTurn);
    if (turns.length > 0) {
      for (const turn of turns) {
        const userEl = turn.querySelector(SEL.userMessage);
        if (userEl && !seen.has(userEl)) {
          seen.add(userEl);
          found.push({ el: userEl, role: 'user', contentEl: userEl });
        }
        const modelEl = turn.querySelector(SEL.modelMessage);
        if (modelEl && !seen.has(modelEl)) {
          seen.add(modelEl);
          found.push({ el: modelEl, role: 'assistant', contentEl: modelEl });
        }
      }
    }

    // Strategy 2 (fallback): query user and model elements directly
    if (found.length === 0) {
      document.querySelectorAll(SEL.userMessage).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        found.push({ el, role: 'user', contentEl: el });
      });
      document.querySelectorAll(SEL.modelMessage).forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        found.push({ el, role: 'assistant', contentEl: el });
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
      title = document.title.replace(/\s*[\|–—]\s*Gemini.*$/i, '').trim();
    }
    if (!title || title === 'Gemini') {
      title = 'Gemini Conversation';
    }
    return { title, url: location.href, source: 'gemini' };
  }

  window.__ACB_SITE = { startObserving, stopObserving, getConversationMeta };
})();
