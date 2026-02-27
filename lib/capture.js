/**
 * Capture Service — lib/capture.js
 *
 * Processes messages captured by content scripts running on AI chat sites.
 * Receives payloads relayed through the service worker, finds or creates
 * the matching conversation in IndexedDB, deduplicates messages by content
 * hash, and keeps running statistics.
 *
 * Exports (ES module — consumed by the service worker):
 *   processCapture(payload)   — main entry point for incoming captures
 *   getActiveCaptures()       — list of conversations being actively captured
 *   getCaptureStats()         — aggregate capture statistics
 */

import { dbPut, dbGet, dbGetAll, dbGetByIndex } from './db.js';
import { generateId, estimateTokens } from './utils.js';

// ---------------------------------------------------------------------------
// In-memory tracking of active captures
// ---------------------------------------------------------------------------

/**
 * Map of active capture sessions keyed by a composite key (source + url).
 * Each entry stores the conversation id and a timestamp of the last activity
 * so we can expire stale sessions.
 *
 * Shape: { [key: string]: { conversationId, source, title, url, lastActivity } }
 */
const activeCaptures = new Map();

/** How long (ms) before an inactive capture is considered stale. */
const STALE_CAPTURE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/** Cumulative stats for the current browser session. */
const stats = {
  totalCaptured: 0,
  bySource: { chatgpt: 0, claude: 0, gemini: 0, copilot: 0 },
  lastCaptureTime: null,
};

// ---------------------------------------------------------------------------
// Content-hash helper for deduplication
// ---------------------------------------------------------------------------

/**
 * Produces a simple but effective hash string from a message's role + content.
 * We intentionally keep this synchronous and lightweight — it does not need
 * to be cryptographically strong, just collision-resistant enough to avoid
 * storing the same message twice within a single conversation.
 */
function contentHash(role, content) {
  const str = `${role}:${content}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0; // Convert to 32-bit int
  }
  // Return a hex string so it is easy to compare / store
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Composite key for matching a capture session to a conversation
// ---------------------------------------------------------------------------

/**
 * Build a lookup key from source + URL (stripped of query/hash so minor
 * URL changes don't create duplicate conversations).
 */
function captureKey(source, url) {
  try {
    const u = new URL(url);
    // Use origin + pathname — ignore query params and hash
    return `${source}::${u.origin}${u.pathname}`;
  } catch {
    return `${source}::${url}`;
  }
}

// ---------------------------------------------------------------------------
// Conversation matching
// ---------------------------------------------------------------------------

/**
 * Try to find an existing conversation that matches the captured payload.
 *
 * Matching strategy (in priority order):
 *   1. If we already have an active capture session for this source+url,
 *      load that conversation by id.
 *   2. Search IndexedDB for a conversation with the same source whose
 *      metadata.captureUrl matches the URL (canonical path match).
 *   3. Fall through to creating a new conversation.
 */
async function findConversation(source, url, title) {
  const key = captureKey(source, url);

  // 1. Check in-memory active captures first (fast path)
  if (activeCaptures.has(key)) {
    const session = activeCaptures.get(key);
    const conv = await dbGet('conversations', session.conversationId);
    if (conv) return conv;
    // If it was deleted out from under us, fall through
    activeCaptures.delete(key);
  }

  // 2. Scan conversations with same source for a URL match
  const candidates = await dbGetByIndex('conversations', 'source', source);
  for (const conv of candidates) {
    const existingUrl = conv.metadata?.captureUrl;
    if (existingUrl && captureKey(source, existingUrl) === key) {
      return conv;
    }
  }

  // 3. No match found
  return null;
}

// ---------------------------------------------------------------------------
// Core processing
// ---------------------------------------------------------------------------

/**
 * processCapture — main entry point.
 *
 * @param {object} payload
 * @param {string} payload.source    — 'chatgpt' | 'claude' | 'gemini' | 'copilot'
 * @param {string} payload.title     — current conversation title (may update)
 * @param {string} payload.url       — page URL at time of capture
 * @param {Array}  payload.messages  — [{role, content, timestamp}]
 *
 * @returns {{ conversationId: string, newMessages: number }}
 */
export async function processCapture(payload) {
  const { source, title, url, messages, injectionContext } = payload;

  if (!source || !Array.isArray(messages) || messages.length === 0) {
    return { conversationId: null, newMessages: 0 };
  }

  // Attempt to find or create the conversation
  let conversation = await findConversation(source, url, title);
  const isNew = !conversation;

  if (isNew) {
    const now = new Date().toISOString();
    conversation = {
      id: generateId(),
      sourceId: generateId(),
      source,
      title: title || 'Untitled Capture',
      createdAt: now,
      updatedAt: now,
      importedAt: now,
      messageCount: 0,
      estimatedTokens: 0,
      messages: [],
      metadata: {
        originalFormat: 'live-capture',
        captureUrl: url,
        capturedAt: now,
      },
    };
  }

  // Build a set of existing content hashes for fast dedup lookup
  const existingHashes = new Set();
  for (const msg of conversation.messages) {
    existingHashes.add(contentHash(msg.role, msg.content));
  }

  // Filter incoming messages to only truly new ones
  const newMessages = [];
  for (const msg of messages) {
    const content = (msg.content || '').trim();
    if (!content) continue;

    const hash = contentHash(msg.role, content);
    if (existingHashes.has(hash)) continue;

    existingHashes.add(hash); // prevent duplicates within the same batch
    newMessages.push({
      id: generateId(),
      role: msg.role,
      content,
      timestamp: msg.timestamp || new Date().toISOString(),
      metadata: {
        capturedLive: true,
        ...(msg.metadata || {}),
      },
    });
  }

  if (newMessages.length === 0) {
    // Nothing new — still refresh the active-capture timestamp
    const key = captureKey(source, url);
    if (activeCaptures.has(key)) {
      activeCaptures.get(key).lastActivity = Date.now();
    }
    return { conversationId: conversation.id, newMessages: 0 };
  }

  // Append new messages
  conversation.messages.push(...newMessages);
  conversation.messageCount = conversation.messages.length;

  // Recompute token estimate from full content
  const totalText = conversation.messages.map((m) => m.content).join(' ');
  conversation.estimatedTokens = estimateTokens(totalText);

  // Update title if a better one is available
  if (title && title !== 'Untitled' && title !== 'New Chat') {
    conversation.title = title;
  }

  conversation.updatedAt = new Date().toISOString();
  if (conversation.metadata) {
    conversation.metadata.captureUrl = url;
  }

  // Merge injection context (knowledge lineage) into conversation metadata
  if (Array.isArray(injectionContext) && injectionContext.length > 0 && conversation.metadata) {
    if (!conversation.metadata.injectionContext) {
      conversation.metadata.injectionContext = [];
    }
    const existing = new Set(conversation.metadata.injectionContext.map(c => c.summaryId));
    for (const ctx of injectionContext) {
      if (!existing.has(ctx.summaryId)) {
        conversation.metadata.injectionContext.push(ctx);
        existing.add(ctx.summaryId);
      }
    }
  }

  // Persist
  await dbPut('conversations', conversation);

  // Enqueue for embedding (deduplicates via conv:{id} key)
  try {
    await dbPut('embeddingQueue', {
      id: `conv:${conversation.id}`,
      conversationId: conversation.id,
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Non-critical — embedding will happen on next sidepanel open
  }

  // Notify sidepanel for immediate embedding (best-effort)
  try {
    chrome.runtime.sendMessage({ type: 'CONVERSATION_CAPTURED', conversationId: conversation.id }).catch(() => {});
  } catch {
    // Sidepanel may not be open
  }

  // Update in-memory tracking
  const key = captureKey(source, url);
  activeCaptures.set(key, {
    conversationId: conversation.id,
    source,
    title: conversation.title,
    url,
    lastActivity: Date.now(),
  });

  // Update stats
  stats.totalCaptured += newMessages.length;
  if (stats.bySource[source] !== undefined) {
    stats.bySource[source] += newMessages.length;
  }
  stats.lastCaptureTime = new Date().toISOString();

  return { conversationId: conversation.id, newMessages: newMessages.length };
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns the list of conversations currently being actively captured.
 * Prunes stale sessions automatically.
 */
export function getActiveCaptures() {
  const now = Date.now();
  const result = [];

  for (const [key, session] of activeCaptures) {
    if (now - session.lastActivity > STALE_CAPTURE_TIMEOUT) {
      activeCaptures.delete(key);
      continue;
    }
    result.push({
      conversationId: session.conversationId,
      source: session.source,
      title: session.title,
      url: session.url,
      lastActivity: new Date(session.lastActivity).toISOString(),
    });
  }

  return result;
}

/**
 * Returns aggregate capture statistics for the current browser session.
 */
export function getCaptureStats() {
  return { ...stats, bySource: { ...stats.bySource } };
}
