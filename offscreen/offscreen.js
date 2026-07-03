/**
 * @fileoverview WebLLM-over-WebGPU worker, hosted in a hidden offscreen
 * document.
 *
 * WebGPU (`navigator.gpu`) is NOT available in an MV3 service worker, only in
 * documents. So on-device WebLLM generation for the background router runs
 * here, in an offscreen document created by the service worker
 * (chrome.offscreen). The service worker talks to this file over
 * chrome.runtime messaging via lib/offscreen-manager.js.
 *
 * Message protocol (all requests carry `target: 'offscreen'` so this listener
 * only claims its own traffic):
 *
 *   → { target:'offscreen', type:'LOCAL_INIT' }
 *   ← { ok:true, vendored:true }                     runtime is vendored/importable
 *   ← { ok:false, error:'webllm_not_vendored' }      bundle missing (graceful)
 *
 *   → { target:'offscreen', type:'LOCAL_GENERATE', messages, model?, options? }
 *   ← { ok:true, content:'…' }
 *   ← { ok:false, error:'…' }
 *
 * Everything is guarded: if vendor/web-llm.js is absent, LOCAL_INIT reports
 * 'webllm_not_vendored' rather than throwing, so the router cleanly falls back
 * to the Prompt API or escalation.
 *
 * @module offscreen/offscreen
 */

const OFFSCREEN_TARGET = 'offscreen';
const DEFAULT_MODEL = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

/** @type {object|null} the imported WebLLM ESM namespace, once loaded */
let _webllm = null;
let _runtimeChecked = false;
let _runtimeVendored = false;

/** @type {object|null} the lazily-created MLC engine */
let _engine = null;
/** @type {Promise<object>|null} in-flight engine creation (dedupes concurrent) */
let _enginePromise = null;

/**
 * Import the vendored WebLLM runtime. Cheap and side-effect-free beyond the
 * import itself — does NOT create the engine (that would trigger a multi-MB
 * model download). Throws Error('webllm_not_vendored') when the self-hosted
 * bundle is missing or not a valid WebLLM ESM.
 *
 * @returns {Promise<object>} the WebLLM module namespace
 */
async function loadRuntime() {
  if (_runtimeChecked) {
    if (!_runtimeVendored) throw new Error('webllm_not_vendored');
    return _webllm;
  }
  _runtimeChecked = true;
  try {
    // Vendored, self-contained ESM. The extension CSP blocks CDN imports, so
    // this MUST be a local file. See vendor/web-llm.README.md.
    const mod = await import('../vendor/web-llm.js');
    if (!mod || typeof mod.CreateMLCEngine !== 'function') {
      throw new Error('webllm_not_vendored');
    }
    _webllm = mod;
    _runtimeVendored = true;
    return _webllm;
  } catch (err) {
    _runtimeVendored = false;
    // A missing file (404) or a bundle without CreateMLCEngine both mean "not
    // vendored" from the caller's perspective. Log the real cause for the dev.
    console.warn('[LANA AI offscreen] WebLLM runtime unavailable:', err?.message || err);
    throw new Error('webllm_not_vendored');
  }
}

/** Read the user-selected model id from storage, if any. */
async function getStoredModel() {
  try {
    const { localModelId } = await chrome.storage.local.get('localModelId');
    return localModelId || null;
  } catch {
    return null;
  }
}

/**
 * Lazily create + cache the MLC engine. First call downloads the model, so it
 * can be slow; subsequent calls reuse the cached engine.
 *
 * @param {string} [model] explicit model id override
 * @returns {Promise<object>} the WebLLM engine
 */
async function getEngine(model) {
  if (_engine) return _engine;
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const webllm = await loadRuntime(); // throws webllm_not_vendored if absent
    const modelId = model || (await getStoredModel()) || DEFAULT_MODEL;
    const engine = await webllm.CreateMLCEngine(modelId);
    _engine = engine;
    return engine;
  })();
  try {
    return await _enginePromise;
  } catch (err) {
    _enginePromise = null; // allow a later retry
    throw err;
  }
}

/**
 * Handle one offscreen request and return the response body.
 * @param {object} message
 * @returns {Promise<object>}
 */
async function handle(message) {
  switch (message.type) {
    case 'LOCAL_INIT': {
      // Cheap probe: is the runtime vendored/importable? Do not build the
      // engine here (that starts the model download).
      try {
        await loadRuntime();
        return { ok: true, vendored: true };
      } catch (err) {
        return { ok: false, error: err?.message || 'webllm_not_vendored' };
      }
    }

    case 'LOCAL_GENERATE': {
      const engine = await getEngine(message.model);
      const messages = Array.isArray(message.messages) ? message.messages : [];
      const options = message.options || {};
      const reply = await engine.chat.completions.create({
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 1024,
        stream: false,
      });
      const content = reply?.choices?.[0]?.message?.content || '';
      return { ok: true, content };
    }

    default:
      return { ok: false, error: `offscreen_unknown_type:${message.type}` };
  }
}

// Register synchronously at module load so the listener is live by the time
// chrome.offscreen.createDocument() resolves in the service worker.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only claim messages explicitly addressed to the offscreen document; let
  // everything else fall through to the service worker's own handler.
  if (!message || message.target !== OFFSCREEN_TARGET) return false;
  handle(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // async response
});
