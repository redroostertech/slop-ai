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
 *   'webllm' — MLC WebLLM over WebGPU (the chosen upgrade path for a larger,
 *     faster local model). REQUIRES two things this repo does not yet ship:
 *       (a) the WebLLM runtime vendored at `vendor/web-llm.js` (CSP blocks CDN
 *           imports, so it must be bundled), and
 *       (b) a DOCUMENT context — WebGPU is NOT available in MV3 service workers,
 *           so background use needs an offscreen document (chrome.offscreen).
 *     The adapter is wired but guarded: it throws a clear, actionable error
 *     until the runtime is vendored. See BACKENDS.webllm.note.
 *
 * getBackend() picks the best available backend for the CURRENT context.
 *
 * @module lib/local-model
 */

/** Rough token budget per backend, used by the router's size gate. */
export const LOCAL_CONTEXT_TOKENS = {
  'prompt-api': 4096,
  webllm: 8192,
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

/** Has the WebLLM runtime been vendored? */
function hasWebLlmRuntime() {
  return typeof self !== 'undefined' && typeof self.webllm !== 'undefined';
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
      'WebLLM is not vendored yet. Bundle the MLC runtime at vendor/web-llm.js ' +
      'and run it from a document/offscreen context (WebGPU is unavailable in ' +
      'the service worker). Until then the router falls back to prompt-api or ' +
      'escalates to LANA.',
    async available() {
      return hasWebGpu() && hasWebLlmRuntime();
    },
    async generate(messages, options) {
      if (!hasWebLlmRuntime()) throw new Error(BACKENDS.webllm.note);
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
/** Lazily create + cache the WebLLM engine (document/offscreen context only). */
async function getWebLlmEngine() {
  if (_webllmEngine) return _webllmEngine;
  const model = (await chrome.storage.local.get('localModelId')).localModelId || 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
  _webllmEngine = await self.webllm.CreateMLCEngine(model);
  return _webllmEngine;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The best available backend name for the current context, or null if none.
 * Prefers WebLLM (bigger/faster) when its runtime + WebGPU are present,
 * otherwise the Prompt API.
 * @returns {Promise<'webllm'|'prompt-api'|null>}
 */
export async function getBackend() {
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
