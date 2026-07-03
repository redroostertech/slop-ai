/**
 * @fileoverview Service-worker-side bridge to the WebLLM offscreen document.
 *
 * WebGPU is unavailable in MV3 service workers, so on-device WebLLM generation
 * runs in a hidden offscreen document (offscreen/offscreen.html). This module
 * owns that document's lifecycle and the request/response protocol.
 *
 * All chrome.offscreen access is feature-detected, so importing this module in
 * a context WITHOUT the API (a sidepanel document, a worker, tests) never
 * throws — the helpers simply report "unsupported".
 *
 * Note: chrome.offscreen.createDocument() can only be called from the service
 * worker. Call ensureOffscreen() from the SW (e.g. on startup) if you want the
 * document created eagerly; otherwise request()/probeWebllm() create it lazily.
 *
 * @module lib/offscreen-manager
 */

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const OFFSCREEN_TARGET = 'offscreen';
// 'WORKERS' fits a hidden doc hosting GPU/WASM compute. (Chrome has no WebGPU-
// specific reason enum; WORKERS is the accepted justification bucket.)
const OFFSCREEN_REASONS = ['WORKERS'];
const OFFSCREEN_JUSTIFICATION =
  'Run the on-device WebLLM model over WebGPU, which is unavailable in the MV3 service worker.';

/** Is the chrome.offscreen API present here? (True only in the service worker.) */
export function isOffscreenSupported() {
  return (
    typeof chrome !== 'undefined' &&
    !!chrome.offscreen &&
    typeof chrome.offscreen.createDocument === 'function'
  );
}

/** Does an offscreen document currently exist? */
async function hasOffscreen() {
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return await chrome.offscreen.hasDocument();
  }
  if (chrome.runtime?.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    return Array.isArray(contexts) && contexts.length > 0;
  }
  return false;
}

let _creating = null;

/**
 * Ensure exactly one offscreen document exists. Idempotent and concurrency-safe.
 * Must be called from the service worker.
 *
 * @returns {Promise<boolean>} true if the document exists (or was created)
 */
export async function ensureOffscreen() {
  if (!isOffscreenSupported()) return false;
  try {
    if (await hasOffscreen()) return true;
    if (_creating) {
      await _creating;
      return true;
    }
    _creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: OFFSCREEN_REASONS,
      justification: OFFSCREEN_JUSTIFICATION,
    });
    await _creating;
    return true;
  } catch (err) {
    const msg = String(err?.message || err);
    // A concurrent create loses the race with "Only a single offscreen document
    // may be created" — which means the doc now exists. Treat as success.
    if (msg.includes('single offscreen') || msg.includes('already')) return true;
    return false;
  } finally {
    _creating = null;
  }
}

/** Close the offscreen document if one exists. */
export async function closeOffscreen() {
  if (!isOffscreenSupported()) return;
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch {
    /* nothing to close / already closed */
  }
}

/**
 * Race a promise against a timeout and an optional AbortSignal. Prevents an
 * offscreen call from hanging forever when the WebLLM model download stalls or
 * generation wedges (the offscreen doc stays alive but never replies). The
 * underlying work may still complete offscreen — this only unblocks the caller.
 */
function raceSettle(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const onAbort = () => settle(reject, new Error('aborted'));
    const timer = setTimeout(() => settle(reject, new Error('offscreen_timeout')), timeoutMs);
    if (signal) {
      if (signal.aborted) return settle(reject, new Error('aborted'));
      signal.addEventListener('abort', onAbort);
    }
    promise.then((v) => settle(resolve, v), (e) => settle(reject, e));
  });
}

/**
 * Send a request to the offscreen document and await its reply. Ensures the
 * document exists first. Because the service worker is the SENDER, its own
 * onMessage listener is not invoked, so there is no cross-talk with the SW's
 * message router.
 *
 * @param {object} message a `{ type, ... }` request (target is added here)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] reject if no reply within this window
 * @param {AbortSignal} [opts.signal] reject early if the caller aborts
 * @returns {Promise<object>} the offscreen response (already ok-checked)
 * @throws {Error} on unavailable doc, timeout, abort, or an offscreen-side error
 */
export async function request(message, { timeoutMs = 30000, signal } = {}) {
  const ok = await ensureOffscreen();
  if (!ok) throw new Error('offscreen_unavailable');
  const send = chrome.runtime.sendMessage({ ...message, target: OFFSCREEN_TARGET });
  const res = await raceSettle(send, timeoutMs, signal);
  if (!res) throw new Error('offscreen_no_response');
  if (res.ok === false) throw new Error(res.error || 'offscreen_error');
  return res;
}

let _probe = null;

/**
 * Cheap, cached check: is WebLLM vendored and importable in the offscreen
 * document? Does not download the model. Definitive results
 * (vendored / not-vendored / unsupported) are cached; transient failures (doc
 * not ready yet) are left retryable.
 *
 * @returns {Promise<{available: boolean, error?: string}>}
 */
export async function probeWebllm() {
  if (_probe) return _probe;
  const p = doProbe();
  _probe = p;
  const result = await p;
  const transient =
    !result.available &&
    result.error &&
    !result.error.includes('webllm_not_vendored') &&
    !result.error.includes('offscreen_unsupported');
  if (transient) _probe = null; // let a later call retry
  return result;
}

async function doProbe() {
  if (!isOffscreenSupported()) return { available: false, error: 'offscreen_unsupported' };
  try {
    const res = await request({ type: 'LOCAL_INIT' });
    return { available: !!res.vendored };
  } catch (err) {
    const error = String(err?.message || err);
    // Definitively not vendored → close the now-idle document to free it.
    if (error.includes('webllm_not_vendored')) await closeOffscreen().catch(() => {});
    return { available: false, error };
  }
}

/** Clear the cached probe result (e.g. after the bundle is dropped in). */
export function resetProbe() {
  _probe = null;
}
