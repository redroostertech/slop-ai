/**
 * Capture Orchestrator — content-scripts/capture.js
 *
 * Injected into all four supported AI chat sites.  This script:
 *   1. Detects which site the user is on from window.location.hostname.
 *   2. Waits for the matching site-specific observer script (loaded by
 *      the manifest as a separate content script) to register itself on
 *      window.__ACB_SITE.
 *   3. Hooks into the observer's callbacks to buffer incoming messages.
 *   4. Debounces — waits 2 seconds after the last message before flushing
 *      the buffer to the service worker.
 *   5. Communicates with the background service worker via
 *      chrome.runtime.sendMessage using the CAPTURE_* message protocol.
 *
 * Runs as a plain content script (IIFE, no ES modules).
 */
(function () {
  'use strict';

  // Guard against double-injection
  if (window.__ACB_CAPTURE_ORCHESTRATOR) return;
  window.__ACB_CAPTURE_ORCHESTRATOR = true;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /** How long to wait (ms) after the last received message before flushing. */
  const DEBOUNCE_MS = 2000;

  /** Maximum buffer size — flush immediately if this many messages accumulate. */
  const MAX_BUFFER_SIZE = 50;

  /** How long (ms) to wait for the site module to register before giving up. */
  const SITE_MODULE_TIMEOUT = 15000;

  /** Polling interval (ms) when waiting for the site module. */
  const SITE_MODULE_POLL_MS = 200;

  // ---------------------------------------------------------------------------
  // Site detection
  // ---------------------------------------------------------------------------

  /**
   * Map of hostname patterns to source identifiers.  We check if the current
   * hostname includes each key — this is intentionally broad so that it
   * works with subdomains and regional variants.
   */
  const SITE_MAP = {
    'chat.openai.com': 'chatgpt',
    'chatgpt.com': 'chatgpt',
    'claude.ai': 'claude',
    'gemini.google.com': 'gemini',
    'copilot.microsoft.com': 'copilot',
  };

  function detectSite() {
    const host = location.hostname.toLowerCase();
    for (const [pattern, source] of Object.entries(SITE_MAP)) {
      if (host === pattern || host.endsWith('.' + pattern)) {
        return source;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const source = detectSite();
  if (!source) {
    // Not on a supported site — silently bail out.
    return;
  }

  /** Buffer of messages waiting to be flushed. */
  let messageBuffer = [];

  /** Handle for the debounce timer. */
  let debounceTimer = null;

  /** Whether capturing is active. */
  let isCapturing = false;

  // ---------------------------------------------------------------------------
  // Communication with the service worker
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the background service worker.  Wrapped in a try/catch
   * because the extension context can be invalidated if the extension is
   * reloaded while the page is still open.
   */
  function sendToBackground(message) {
    try {
      if (chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage(message).catch((err) => {
          // Extension context invalidated — stop capturing gracefully
          if (err.message && err.message.includes('Extension context invalidated')) {
            stopCapture();
          }
        });
      }
    } catch {
      // Silently fail — the extension was likely unloaded
    }
  }

  // ---------------------------------------------------------------------------
  // Buffer management & debounced flush
  // ---------------------------------------------------------------------------

  /**
   * Flush the current message buffer to the service worker.
   */
  function flushBuffer() {
    if (messageBuffer.length === 0) return;

    // Grab current metadata from the site module
    const meta = window.__ACB_SITE
      ? window.__ACB_SITE.getConversationMeta()
      : { title: document.title, url: location.href, source };

    // Drain injection context set by inject.js (knowledge lineage tracking)
    let injectionContext = null;
    if (Array.isArray(window.__ACB_INJECTION_CONTEXT) && window.__ACB_INJECTION_CONTEXT.length > 0) {
      injectionContext = window.__ACB_INJECTION_CONTEXT.splice(0);
    }

    const payload = {
      source: meta.source || source,
      title: meta.title || 'Untitled',
      url: meta.url || location.href,
      messages: messageBuffer.slice(), // copy
      injectionContext,
    };

    messageBuffer = [];

    sendToBackground({
      type: 'CAPTURE_MESSAGES',
      payload,
    });
  }

  /**
   * Called by the site observer whenever new messages are detected.
   * Adds them to the buffer and resets the debounce timer.
   *
   * @param {Array} messages — [{role, content, timestamp}]
   */
  function onMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;

    messageBuffer.push(...messages);

    // If buffer is getting large, flush immediately
    if (messageBuffer.length >= MAX_BUFFER_SIZE) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      flushBuffer();
      return;
    }

    // Otherwise reset the debounce timer
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushBuffer();
    }, DEBOUNCE_MS);
  }

  /**
   * Called by the site observer when a conversation boundary is detected
   * (e.g. user navigated to a different chat thread).
   *
   * @param {object} meta — { title, url, source }
   */
  function onConversationChange(meta) {
    // Flush any pending messages from the old conversation first
    clearTimeout(debounceTimer);
    debounceTimer = null;
    flushBuffer();

    // Notify the service worker of the conversation switch
    sendToBackground({
      type: 'CAPTURE_CONVERSATION_START',
      payload: {
        source: meta.source || source,
        title: meta.title,
        url: meta.url || location.href,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function startCapture() {
    if (isCapturing) return;
    if (!window.__ACB_SITE) return;

    isCapturing = true;
    window.__ACB_SITE.startObserving(onMessages, onConversationChange);

    // Signal the service worker that we started capturing
    const meta = window.__ACB_SITE.getConversationMeta();
    sendToBackground({
      type: 'CAPTURE_CONVERSATION_START',
      payload: {
        source: meta.source || source,
        title: meta.title,
        url: meta.url || location.href,
      },
    });
  }

  function stopCapture() {
    if (!isCapturing) return;
    isCapturing = false;

    // Flush remaining messages
    clearTimeout(debounceTimer);
    debounceTimer = null;
    flushBuffer();

    if (window.__ACB_SITE) {
      window.__ACB_SITE.stopObserving();
    }
  }

  // ---------------------------------------------------------------------------
  // Listen for messages from the service worker (e.g. enable/disable capture)
  // ---------------------------------------------------------------------------

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'CAPTURE_STATUS') {
        sendResponse({
          isCapturing,
          source,
          url: location.href,
          bufferedMessages: messageBuffer.length,
        });
        return true; // async response
      }

      if (message.type === 'CAPTURE_ENABLE') {
        startCapture();
        sendResponse({ ok: true });
        return true;
      }

      if (message.type === 'CAPTURE_DISABLE') {
        stopCapture();
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Wait for the site module to load, then start
  // ---------------------------------------------------------------------------

  /**
   * The site-specific script (e.g. sites/chatgpt.js) is loaded as a separate
   * content script by the manifest.  It sets window.__ACB_SITE when ready.
   * We poll for it because content script load order is not guaranteed.
   */
  function waitForSiteModule() {
    const start = Date.now();

    const poll = () => {
      if (window.__ACB_SITE) {
        startCapture();
        return;
      }
      if (Date.now() - start > SITE_MODULE_TIMEOUT) {
        // Timed out — the site-specific script failed to load or register.
        // This is not fatal; the extension just won't capture on this page.
        console.warn('[AI Context Bridge] Site observer module did not register in time for:', source);
        return;
      }
      setTimeout(poll, SITE_MODULE_POLL_MS);
    };

    poll();
  }

  // Kick off once the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForSiteModule);
  } else {
    waitForSiteModule();
  }

  // Clean up on page unload
  window.addEventListener('beforeunload', () => {
    stopCapture();
  });
})();
