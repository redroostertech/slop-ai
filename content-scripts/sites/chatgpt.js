/**
 * ChatGPT DOM Observer — content-scripts/sites/chatgpt.js
 *
 * Observes the ChatGPT conversation DOM in real-time to capture user and
 * assistant messages as they appear.  Uses a content-stability approach:
 * messages are only emitted once their content has stopped changing for
 * a stability period, ensuring we capture final output not streaming chunks.
 *
 * Runs as a plain content script (no ES modules).  Exposes its API on
 * window.__ACB_SITE so the capture orchestrator can call it.
 *
 * Target host: chat.openai.com / chatgpt.com
 */
(function () {
  'use strict';

  if (window.__ACB_SITE) return;

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  const SEL = {
    messageByRole: '[data-message-author-role]',
    streamingIndicator: '.result-streaming',
    streamingThinking: '[data-is-streaming="true"]',
    chatContainer: 'main',
    titleInNav: 'nav a.bg-token-sidebar-surface-secondary, nav a[class*="active"]',
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
    clone.querySelectorAll('button, [class*="copy"], [class*="action"]').forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  function isStreaming() {
    return !!(
      document.querySelector(SEL.streamingIndicator) ||
      document.querySelector(SEL.streamingThinking)
    );
  }

  // ---------------------------------------------------------------------------
  // Content-stability capture
  // ---------------------------------------------------------------------------

  /**
   * Scan all message elements, update their tracked content, and emit
   * any messages whose content has been stable for STABILITY_MS.
   */
  function scanAndEmitStable() {
    const now = Date.now();
    const messageEls = document.querySelectorAll(SEL.messageByRole);
    const toEmit = [];

    for (const el of messageEls) {
      const role = el.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') continue;

      let contentEl;
      if (role === 'user') {
        contentEl = el.querySelector('.whitespace-pre-wrap, .break-words');
      } else {
        contentEl = el.querySelector('.markdown, .whitespace-pre-wrap');
      }
      if (!contentEl) contentEl = el;

      const content = extractText(contentEl);
      if (!content) continue;

      const state = elementState.get(el);

      if (!state) {
        // New element — start tracking
        elementState.set(el, { content, lastChanged: now, emitted: false });
        continue;
      }

      if (state.emitted) {
        // Already emitted — skip unless content changed (edited message)
        if (state.content !== content) {
          state.content = content;
          state.lastChanged = now;
          state.emitted = false;
        }
        continue;
      }

      if (state.content !== content) {
        // Content still changing — update and reset timer
        state.content = content;
        state.lastChanged = now;
        continue;
      }

      // Content unchanged — check if stable long enough
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
      // Don't harvest here — the stability timer handles emission
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

    // Start periodic stability-based scanning
    startStabilityChecks();

    // Do an initial scan
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
    const activeLinkEl = document.querySelector(SEL.titleInNav);
    if (activeLinkEl) {
      title = (activeLinkEl.textContent || '').trim();
    }
    if (!title) {
      title = document.title.replace(/\s*[\|–—]\s*ChatGPT.*$/i, '').trim();
    }
    if (!title || title === 'ChatGPT') {
      title = 'ChatGPT Conversation';
    }
    return { title, url: location.href, source: 'chatgpt' };
  }

  window.__ACB_SITE = { startObserving, stopObserving, getConversationMeta };
})();
