/**
 * Usage Tracker Service — lib/tracker.js
 *
 * Tracks every interaction with knowledge items (injections, views, exports,
 * copies, search hits) so the analytics layer can determine what is valuable
 * versus noise.
 *
 * Storage strategy:
 *   Uses its OWN IndexedDB database (`AIContextBridgeUsageDB`) with a single
 *   `usage` object store.  This avoids modifying the main db.js schema that
 *   other agents own.  If IndexedDB is unavailable (e.g. in a restricted
 *   context), the tracker falls back to an in-memory store so callers never
 *   see errors.
 *
 * Performance:
 *   All writes are buffered in memory.  The buffer is flushed to IndexedDB
 *   every FLUSH_INTERVAL_MS (5 000 ms) OR when it reaches FLUSH_THRESHOLD
 *   (10 events), whichever comes first.  This keeps tracking completely
 *   non-blocking for the user.
 *
 * Usage Event Schema (IndexedDB `usage` store):
 *   keyPath: 'id'
 *   Indexes:
 *     - 'summaryId'  (non-unique) — fast lookup of all events for a summary
 *     - 'topicId'    (non-unique) — fast lookup of all events for a topic
 *     - 'type'       (non-unique) — filter by event type
 *     - 'timestamp'  (non-unique) — range queries for time-based analytics
 *     - 'source'     (non-unique) — filter by originating system
 *
 * Integration Points:
 *   - Agent 2 (Injector / lib/injector.js) calls trackInjection() and
 *     trackSearchHit() when knowledge is injected into an AI system or
 *     appears as a relevance result.
 *   - Sidepanel (sidepanel/sidepanel.js) calls trackView() when a user
 *     opens a summary detail view.
 *   - Exporter (lib/exporter.js) calls trackExport() when knowledge is
 *     exported to any format.
 *   - Any UI surface calls trackCopy() when a user copies a summary to
 *     the clipboard.
 *
 * ES Module — all exports are named.
 */

import { generateId } from './utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the dedicated IndexedDB database for usage tracking. */
const USAGE_DB_NAME = 'AIContextBridgeUsageDB';

/** Current schema version — bump when adding stores or indexes. */
const USAGE_DB_VERSION = 1;

/** Flush the write buffer after this many milliseconds. */
const FLUSH_INTERVAL_MS = 5_000;

/** Flush the write buffer once it reaches this many events. */
const FLUSH_THRESHOLD = 10;

/** Valid event types. */
const VALID_TYPES = new Set(['inject', 'export', 'view', 'copy', 'search_hit']);

/** Valid source identifiers. */
const VALID_SOURCES = new Set([
  'chatgpt',
  'claude',
  'gemini',
  'copilot',
  'sidepanel',
]);

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Cached database connection. @type {IDBDatabase | null} */
let _db = null;

/** Whether IndexedDB is available in this context. */
let _indexedDBAvailable = true;

/**
 * In-memory fallback store.  Used when IndexedDB is unavailable so the
 * analytics layer still has data for the current session.
 * @type {Array<UsageEvent>}
 */
const _memoryStore = [];

/**
 * Write buffer — events are accumulated here and flushed to IndexedDB in
 * batches for performance.
 * @type {Array<UsageEvent>}
 */
const _writeBuffer = [];

/** Handle returned by setInterval for the periodic flush timer. */
let _flushTimer = null;

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

/**
 * Open (or return the cached) IndexedDB connection for usage tracking.
 *
 * SCHEMA DOCUMENTATION (for the integration agent):
 *   Database: AIContextBridgeUsageDB  v1
 *   Store:    usage
 *     keyPath: 'id'
 *     Indexes:
 *       summaryId  — event.summaryId  (non-unique)
 *       topicId    — event.topicId    (non-unique)
 *       type       — event.type       (non-unique)
 *       timestamp  — event.timestamp  (non-unique)
 *       source     — event.source     (non-unique)
 *
 * @returns {Promise<IDBDatabase>}
 */
function openUsageDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      _indexedDBAvailable = false;
      reject(new Error('IndexedDB is not available'));
      return;
    }

    let request;
    try {
      request = indexedDB.open(USAGE_DB_NAME, USAGE_DB_VERSION);
    } catch (err) {
      _indexedDBAvailable = false;
      reject(err);
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('usage')) {
        const store = db.createObjectStore('usage', { keyPath: 'id' });
        store.createIndex('summaryId', 'summaryId', { unique: false });
        store.createIndex('topicId', 'topicId', { unique: false });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('source', 'source', { unique: false });
      }
    };

    request.onsuccess = () => {
      _db = request.result;

      // If the connection is unexpectedly closed, clear the cached handle so
      // the next call to openUsageDB() re-opens it.
      _db.onclose = () => {
        _db = null;
      };

      resolve(_db);
    };

    request.onerror = () => {
      _indexedDBAvailable = false;
      reject(request.error);
    };
  });
}

// ---------------------------------------------------------------------------
// Write buffer management
// ---------------------------------------------------------------------------

/**
 * Start the periodic flush timer.  Safe to call multiple times — only one
 * timer will ever be running.
 */
function ensureFlushTimer() {
  if (_flushTimer !== null) return;

  _flushTimer = setInterval(() => {
    if (_writeBuffer.length > 0) {
      flushBuffer();
    }
  }, FLUSH_INTERVAL_MS);
}

/**
 * Flush the in-memory write buffer to IndexedDB.
 *
 * This is intentionally fire-and-forget — tracking should never block the
 * user's workflow.  Errors are caught and silently logged.
 *
 * @returns {Promise<void>}
 */
async function flushBuffer() {
  if (_writeBuffer.length === 0) return;

  // Drain the buffer atomically so new events added during the flush go
  // into a fresh buffer.
  const batch = _writeBuffer.splice(0, _writeBuffer.length);

  // Always keep the in-memory store up-to-date (used as fallback and by
  // analytics for the current session).
  _memoryStore.push(...batch);

  if (!_indexedDBAvailable) return;

  try {
    const db = await openUsageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('usage', 'readwrite');
      const store = tx.objectStore('usage');
      for (const event of batch) {
        store.put(event);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // Put events back into memory store — they are already there from above.
    // Just log the error so it can be diagnosed.
    console.warn('[tracker] Failed to flush usage events to IndexedDB:', err);
  }
}

// ---------------------------------------------------------------------------
// Event construction helpers
// ---------------------------------------------------------------------------

/**
 * Build a well-formed usage event object, filling in defaults.
 *
 * @param {Partial<UsageEvent>} partial
 * @returns {UsageEvent}
 */
function buildEvent(partial) {
  return {
    id: partial.id || generateId(),
    type: partial.type || 'view',
    summaryId: partial.summaryId || null,
    topicId: partial.topicId || null,
    conversationId: partial.conversationId || null,
    source: partial.source || 'sidepanel',
    context: partial.context || {},
    timestamp: partial.timestamp || new Date().toISOString(),
  };
}

/**
 * Validate an event's required fields.
 *
 * @param {UsageEvent} event
 * @returns {boolean}
 */
function validateEvent(event) {
  if (!event.type || !VALID_TYPES.has(event.type)) {
    console.warn('[tracker] Invalid event type:', event.type);
    return false;
  }
  if (event.source && !VALID_SOURCES.has(event.source)) {
    console.warn('[tracker] Unknown source (allowing anyway):', event.source);
    // Allow unknown sources — the set may grow over time.
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API — Core tracking
// ---------------------------------------------------------------------------

/**
 * Record a usage event.
 *
 * This is the lowest-level tracking function.  Convenience wrappers
 * (trackInjection, trackView, etc.) delegate here.
 *
 * The event is validated, enriched with defaults, buffered in memory, and
 * flushed to IndexedDB asynchronously.  This function returns immediately
 * after buffering — it will never slow down the caller.
 *
 * @param {Partial<UsageEvent>} event — See the Usage Event Schema at the
 *   top of this file for the full shape.
 * @returns {Promise<UsageEvent | null>} The fully-formed event, or null if
 *   validation failed.
 */
export async function trackUsage(event) {
  const full = buildEvent(event);

  if (!validateEvent(full)) return null;

  _writeBuffer.push(full);
  ensureFlushTimer();

  // If the buffer has reached the threshold, flush immediately.
  if (_writeBuffer.length >= FLUSH_THRESHOLD) {
    // Non-blocking — don't await.
    flushBuffer().catch(() => {});
  }

  return full;
}

/**
 * Record that a summary was injected into an AI chat.
 *
 * Integration point:  Called by Agent 2's injector (lib/injector.js) after
 * successfully injecting context into a target AI system.
 *
 * @param {string} summaryId    — ID of the injected summary
 * @param {string} targetSystem — 'chatgpt' | 'claude' | 'gemini' | 'copilot'
 * @param {object} [extra]      — Optional extra context fields
 * @returns {Promise<UsageEvent | null>}
 */
export async function trackInjection(summaryId, targetSystem, extra = {}) {
  return trackUsage({
    type: 'inject',
    summaryId,
    topicId: extra.topicId || null,
    conversationId: extra.conversationId || null,
    source: targetSystem,
    context: {
      injectedInto: targetSystem,
      ...extra.context,
    },
  });
}

/**
 * Record that a summary was viewed in the sidepanel.
 *
 * Integration point:  Called by the sidepanel (sidepanel/sidepanel.js) when
 * a user opens a summary's detail view.
 *
 * @param {string} summaryId — ID of the viewed summary
 * @param {object} [extra]   — Optional extra context fields
 * @returns {Promise<UsageEvent | null>}
 */
export async function trackView(summaryId, extra = {}) {
  return trackUsage({
    type: 'view',
    summaryId,
    topicId: extra.topicId || null,
    conversationId: extra.conversationId || null,
    source: 'sidepanel',
    context: extra.context || {},
  });
}

/**
 * Record that knowledge was exported.
 *
 * Integration point:  Called by the exporter (lib/exporter.js) or sidepanel
 * after a successful export operation.
 *
 * @param {string[]} topicIds     — IDs of the exported topics
 * @param {string}   targetFormat — 'markdown' | 'json' | 'claude' | 'chatgpt' | 'gemini'
 * @param {object}   [extra]      — Optional extra context fields
 * @returns {Promise<Array<UsageEvent | null>>}
 */
export async function trackExport(topicIds, targetFormat, extra = {}) {
  const events = [];
  for (const topicId of topicIds) {
    const event = await trackUsage({
      type: 'export',
      summaryId: extra.summaryId || null,
      topicId,
      conversationId: extra.conversationId || null,
      source: 'sidepanel',
      context: {
        exportTarget: targetFormat,
        ...extra.context,
      },
    });
    events.push(event);
  }
  return events;
}

/**
 * Record that a summary appeared as a search or relevance result.
 *
 * Integration point:  Called by Agent 2's relevance engine
 * (lib/relevance.js) when a summary matches a search/relevance query.
 *
 * @param {string} summaryId   — ID of the matched summary
 * @param {string} searchQuery — The query that produced the match
 * @param {object} [extra]     — Optional extra context fields
 * @returns {Promise<UsageEvent | null>}
 */
export async function trackSearchHit(summaryId, searchQuery, extra = {}) {
  return trackUsage({
    type: 'search_hit',
    summaryId,
    topicId: extra.topicId || null,
    conversationId: extra.conversationId || null,
    source: extra.source || 'sidepanel',
    context: {
      searchQuery,
      ...extra.context,
    },
  });
}

/**
 * Record that a summary was copied to the clipboard.
 *
 * Integration point:  Called by any UI surface (sidepanel, injected sidebar)
 * when the user copies a summary's content.
 *
 * @param {string} summaryId — ID of the copied summary
 * @param {object} [extra]   — Optional extra context fields
 * @returns {Promise<UsageEvent | null>}
 */
export async function trackCopy(summaryId, extra = {}) {
  return trackUsage({
    type: 'copy',
    summaryId,
    topicId: extra.topicId || null,
    conversationId: extra.conversationId || null,
    source: extra.source || 'sidepanel',
    context: extra.context || {},
  });
}

// ---------------------------------------------------------------------------
// Public API — Query helpers
// ---------------------------------------------------------------------------

/**
 * Get all raw usage events for a specific summary.
 *
 * Uses the `summaryId` index on the usage store for efficient retrieval.
 * Also includes any events still in the write buffer that have not been
 * flushed yet.
 *
 * @param {string} summaryId
 * @returns {Promise<UsageEvent[]>}
 */
export async function getUsageForSummary(summaryId) {
  let persisted = [];

  if (_indexedDBAvailable) {
    try {
      const db = await openUsageDB();
      persisted = await new Promise((resolve, reject) => {
        const tx = db.transaction('usage', 'readonly');
        const idx = tx.objectStore('usage').index('summaryId');
        const req = idx.getAll(summaryId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[tracker] Failed to query usage by summaryId:', err);
    }
  }

  // Merge with in-memory events that have not been persisted (or when
  // IndexedDB is down, use the full memory store).
  const persistedIds = new Set(persisted.map((e) => e.id));
  const fromMemory = (_indexedDBAvailable ? _writeBuffer : _memoryStore)
    .filter((e) => e.summaryId === summaryId && !persistedIds.has(e.id));

  return [...persisted, ...fromMemory].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
}

/**
 * Get all usage events within a time range.
 *
 * Uses the `timestamp` index with an IDBKeyRange for efficient retrieval.
 *
 * @param {string|Date} startDate — ISO 8601 string or Date
 * @param {string|Date} endDate   — ISO 8601 string or Date
 * @returns {Promise<UsageEvent[]>}
 */
export async function getUsageInRange(startDate, endDate) {
  const start =
    typeof startDate === 'string' ? startDate : startDate.toISOString();
  const end = typeof endDate === 'string' ? endDate : endDate.toISOString();

  let persisted = [];

  if (_indexedDBAvailable) {
    try {
      const db = await openUsageDB();
      persisted = await new Promise((resolve, reject) => {
        const tx = db.transaction('usage', 'readonly');
        const idx = tx.objectStore('usage').index('timestamp');
        const range = IDBKeyRange.bound(start, end);
        const req = idx.getAll(range);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[tracker] Failed to query usage by time range:', err);
    }
  }

  // Merge with buffered events in the same range.
  const persistedIds = new Set(persisted.map((e) => e.id));
  const fromMemory = (_indexedDBAvailable ? _writeBuffer : _memoryStore)
    .filter(
      (e) =>
        e.timestamp >= start &&
        e.timestamp <= end &&
        !persistedIds.has(e.id),
    );

  return [...persisted, ...fromMemory].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
}

/**
 * Get ALL usage events.  Prefer the more targeted query methods above when
 * possible — this pulls everything from IndexedDB.
 *
 * Used internally by the analytics layer (lib/analytics.js).
 *
 * @returns {Promise<UsageEvent[]>}
 */
export async function getAllUsageEvents() {
  let persisted = [];

  if (_indexedDBAvailable) {
    try {
      const db = await openUsageDB();
      persisted = await new Promise((resolve, reject) => {
        const tx = db.transaction('usage', 'readonly');
        const req = tx.objectStore('usage').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[tracker] Failed to get all usage events:', err);
    }
  }

  // Merge with any un-flushed events.
  const persistedIds = new Set(persisted.map((e) => e.id));
  const fromMemory = (_indexedDBAvailable ? _writeBuffer : _memoryStore)
    .filter((e) => !persistedIds.has(e.id));

  return [...persisted, ...fromMemory].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
  );
}

// ---------------------------------------------------------------------------
// Public API — Maintenance
// ---------------------------------------------------------------------------

/**
 * Delete all usage data from both IndexedDB and the in-memory stores.
 *
 * Intended for privacy/reset scenarios.
 *
 * @returns {Promise<void>}
 */
export async function clearUsageData() {
  // Clear in-memory state.
  _writeBuffer.length = 0;
  _memoryStore.length = 0;

  if (!_indexedDBAvailable) return;

  try {
    const db = await openUsageDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('usage', 'readwrite');
      tx.objectStore('usage').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[tracker] Failed to clear usage data:', err);
  }
}

/**
 * Force-flush any buffered events to IndexedDB immediately.
 *
 * Useful when the extension is about to suspend (e.g. service worker idle
 * timeout) and we want to persist everything.
 *
 * Integration point:  The service worker (background/service-worker.js) can
 * call this in a `beforeunload` or idle handler to prevent data loss.
 *
 * @returns {Promise<void>}
 */
export async function flush() {
  await flushBuffer();
}

/**
 * Tear down the tracker — clear timers and close the DB connection.
 *
 * Primarily useful for testing.
 */
export function destroy() {
  if (_flushTimer !== null) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  if (_db) {
    _db.close();
    _db = null;
  }
}
