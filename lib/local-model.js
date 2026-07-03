/**
 * @fileoverview On-device generation for the hybrid router.
 *
 * This is the "handle it locally" half of the cascade. It is backend-pluggable:
 *
 *   'prompt-api' — Chrome's built-in Prompt API (`LanguageModel`, Gemini Nano).
 *     Zero download, on-device, and — unlike WebGPU — available in the
 *     extension SERVICE WORKER, so the router can run it in the background.
 *     Availability is gated on Chrome version + hardware.
 *
 *   'webllm' — MLC WebLLM over WebGPU, run DIRECTLY in the current context.
 *     Used in a DOCUMENT with WebGPU (e.g. the sidepanel). Dynamically imports
 *     the vendored ESM at vendor/web-llm.js (CSP blocks CDN imports, so it must
 *     be self-hosted); never imported in the service worker (no WebGPU there).
 *
 *   'offscreen-webllm' — the same WebLLM/WebGPU model, but reached from the
 *     SERVICE WORKER (which has no WebGPU) by delegating to a hidden offscreen
 *     document. The offscreen doc imports the vendored ESM at `vendor/web-llm.js`
 *     and runs the engine; the SW talks to it via lib/offscreen-manager.js.
 *     This realizes the "WebGPU (WebLLM)" local backend for the background
 *     router. Guarded end-to-end: if the bundle is not vendored, availability
 *     is false and the router falls back to the Prompt API or escalates.
 *
 * getBackend() picks the best available backend for the CURRENT context:
 *   offscreen-webllm (SW, if vendored) > webllm (in-document) > prompt-api.
 *
 * @module lib/local-model
 */

import {
  isOffscreenSupported,
  probeWebllm,
  request as offscreenRequest,
} from './offscreen-manager.js';

/** Rough token budget per backend, used by the router's size gate. */
export const LOCAL_CONTEXT_TOKENS = {
  'prompt-api': 4096,
  webllm: 8192,
  'offscreen-webllm': 8192,
};

/** Is Chrome's built-in Prompt API present in this context? */
function hasPromptApi() {
  // The global has moved across Chrome versions: `LanguageModel` (current),
  // `self.ai.languageModel` (earlier). Detect both.
  return (
    typeof self !== 'undefined' &&
    (typeof self.LanguageModel !== 'undefined' ||
      typeof self.ai?.languageModel !== 'undefined')
  );
}

/** Handle to the Prompt API factory regardless of which global exposes it. */
function promptApiFactory() {
  if (typeof self.LanguageModel !== 'undefined') return self.LanguageModel;
  return self.ai.languageModel;
}

/** Is WebGPU available in this context (window/offscreen only, not the SW)? */
function hasWebGpu() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Lazily import the vendored WebLLM ESM (in-document / WebGPU contexts). Cached.
 * The bundle is `vendor/web-llm.js` (self-contained, exports CreateMLCEngine).
 * Only call this where WebGPU exists — never in the service worker (the
 * offscreen document handles the SW path). import() of an extension-local ESM
 * is allowed by the extension CSP.
 */
let _webllmModulePromise = null;
function loadWebLlmModule() {
  if (!_webllmModulePromise) _webllmModulePromise = import('../vendor/web-llm.js');
  return _webllmModulePromise;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

const BACKENDS = {
  'prompt-api': {
    async available() {
      if (!hasPromptApi()) return false;
      try {
        const factory = promptApiFactory();
        // Both API shapes expose an availability/capabilities probe. Treat ONLY
        // a ready model as available — `downloadable`/`after-download` means a
        // multi-GB fetch would block on first use, and reporting it as ready
        // interacts badly with the router's on-device pin (it would appear to
        // satisfy a sensitive task, then stall or throw). A separate prepare()
        // step should trigger the download explicitly (see prepareLocal()).
        if (typeof factory.availability === 'function') {
          const a = await factory.availability();
          return a === 'available' || a === 'readily';
        }
        if (typeof factory.capabilities === 'function') {
          const c = await factory.capabilities();
          return c?.available === 'readily';
        }
        return true;
      } catch {
        return false;
      }
    },
    async generate(messages, options) {
      const factory = promptApiFactory();
      const { system, prompt } = splitMessages(messages);
      const session = await factory.create(system ? { initialPrompts: [{ role: 'system', content: system }] } : {});
      try {
        const text = await session.prompt(prompt, options.signal ? { signal: options.signal } : undefined);
        return String(text ?? '');
      } finally {
        session.destroy?.();
      }
    },
  },

  webllm: {
    note:
      'In-document WebLLM over WebGPU (e.g. the sidepanel). Dynamically imports ' +
      'the vendored ESM at vendor/web-llm.js. Only usable where WebGPU exists; ' +
      'the service-worker path uses offscreen-webllm instead.',
    async available() {
      if (!hasWebGpu()) return false; // never import the 6MB bundle in the SW
      try {
        const mod = await loadWebLlmModule();
        return typeof mod.CreateMLCEngine === 'function';
      } catch {
        return false; // bundle missing / not importable here
      }
    },
    async generate(messages, options) {
      const engine = await getWebLlmEngine();
      const reply = await engine.chat.completions.create({
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 1024,
        stream: false,
      });
      return reply.choices?.[0]?.message?.content || '';
    },
  },

  'offscreen-webllm': {
    note:
      'Background WebLLM path. Runs in a hidden offscreen document because the ' +
      'service worker has no WebGPU. Requires vendor/web-llm.js (self-hosted ' +
      'ESM) — see vendor/web-llm.README.md. Falls back to prompt-api/escalation ' +
      'until vendored.',
    async available() {
      // Only relevant where WebGPU is missing (the service worker). In a
      // document that HAS WebGPU, prefer the direct 'webllm' backend.
      if (hasWebGpu()) return false;
      if (!isOffscreenSupported()) return false;
      const { available } = await probeWebllm();
      return available;
    },
    async generate(messages, options) {
      // AbortSignal is not structured-cloneable across the message boundary, so
      // only the serializable knobs cross into the offscreen document. The
      // signal + a bounded timeout are honored on THIS side (offscreen-manager
      // raceSettle): a stalled first-use model download rejects here rather than
      // hanging the route forever, and an aborting caller unblocks promptly.
      const res = await offscreenRequest(
        {
          type: 'LOCAL_GENERATE',
          messages,
          options: { temperature: options.temperature, maxTokens: options.maxTokens },
        },
        { timeoutMs: 120000, signal: options.signal }
      );
      return res.content || '';
    },
  },
};

/** Split OpenAI-style messages into a system string + a single user prompt. */
function splitMessages(messages) {
  let system = '';
  const parts = [];
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
    else parts.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  }
  return { system, prompt: parts.join('\n\n') };
}

let _webllmEngine = null;
/**
 * Lazily create + cache the WebLLM engine (in-document WebGPU path). Supports a
 * custom self-hosted model via `localModelConfig` (same contract as
 * offscreen/offscreen.js); otherwise loads a lightweight prebuilt model. Kept
 * in sync with the offscreen path so both contexts honor custom weights.
 */
async function getWebLlmEngine() {
  if (_webllmEngine) return _webllmEngine;
  const webllm = await loadWebLlmModule();
  const { localModelId, localModelConfig: c } = await chrome.storage.local.get([
    'localModelId',
    'localModelConfig',
  ]);
  if (c && c.model && c.model_id && c.model_lib) {
    _webllmEngine = await webllm.CreateMLCEngine(c.model_id, {
      appConfig: {
        model_list: [
          { model: c.model, model_id: c.model_id, model_lib: c.model_lib, ...(c.overrides || {}) },
        ],
      },
    });
  } else {
    _webllmEngine = await webllm.CreateMLCEngine(
      localModelId || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
    );
  }
  return _webllmEngine;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The best available backend name for the current context, or null if none.
 * Prefers WebLLM (bigger/faster) when reachable — via the offscreen document
 * from the service worker, or directly in a WebGPU document — otherwise the
 * Prompt API.
 * @returns {Promise<'offscreen-webllm'|'webllm'|'prompt-api'|null>}
 */
export async function getBackend() {
  if (await BACKENDS['offscreen-webllm'].available()) return 'offscreen-webllm';
  if (await BACKENDS.webllm.available()) return 'webllm';
  if (await BACKENDS['prompt-api'].available()) return 'prompt-api';
  return null;
}

/** Is on-device generation possible in this context at all? */
export async function isLocalAvailable() {
  return (await getBackend()) !== null;
}

/**
 * Generate text on-device.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{content: string, backend: string}>}
 * @throws {Error} if no local backend is available in this context
 */
export async function generateLocal(messages, options = {}) {
  const backend = await getBackend();
  if (!backend) {
    throw new Error(
      'No on-device model available here (needs Chrome Prompt API, or WebLLM ' +
        'vendored + a WebGPU document context).'
    );
  }
  const content = await BACKENDS[backend].generate(messages, options);
  return { content, backend };
}

export { BACKENDS };
