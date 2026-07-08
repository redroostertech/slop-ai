/**
 * @fileoverview LANA AI account + inference client.
 *
 * Thin wrapper over {@link authorizedFetch} for the two things the extension
 * does against a LANA instance:
 *
 *   INFERENCE (the router escalation target)
 *     - inferenceComplete()  → POST /inference/complete (non-streaming)
 *     - inferenceStream()    → POST /inference/complete (SSE, onDelta callback)
 *   These hit the passthrough endpoint the LANA developer will add (spec:
 *   lana-gpt/docs/EXTENSION_INFERENCE_PASSTHROUGH.md). It forwards to the gateway
 *   → Forge with the server-held key; the extension only ever sends its JWT.
 *
 *   ACCOUNT INGESTION (inject captured context into the primary experience)
 *     - listMatters()   → GET  /matters
 *     - sendKnowledge() → POST /matters/{id}/knowledge/message   (RAG store)
 *     - sendMemory()    → POST /memory                           (short facts)
 *     - getMemoryPreference() → GET  /memory/preference          (per-user toggle)
 *     - setMemoryPreference() → PUT  /memory/preference          (per-user toggle)
 *     - sendDocument()  → POST /documents                        (full pipeline)
 *
 * @module lib/lana-client
 */

import { authorizedFetch } from './lana-auth.js';

/** Parse a JSON error body into a readable message. */
async function errorMessage(resp, fallback) {
  const body = await resp.json().catch(() => ({}));
  return body.detail || body.error?.message || body.error || `${fallback} (${resp.status})`;
}

// ---------------------------------------------------------------------------
// Inference passthrough
// ---------------------------------------------------------------------------

/**
 * Non-streaming completion via the instance passthrough. Requests
 * `stream:false` and returns the assembled text.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {string} [options.tier]  requested model tier: 'auto'|'fast'|'reasoning'
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{content: string, usage: Object|null, model: string|null}>}
 */
export async function inferenceComplete(messages, options = {}) {
  const resp = await authorizedFetch('inference/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      messages,
      stream: false,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2000,
      tier: options.tier || 'auto',
    }),
    signal: options.signal,
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, 'LANA inference failed'));
  const body = await resp.json();
  // Accept either an OpenAI-shaped response or a simplified {content} one, so
  // the extension is resilient to the exact shape the developer implements.
  const content =
    body.choices?.[0]?.message?.content ??
    body.content ??
    body.text ??
    '';
  return { content, usage: body.usage || null, model: body.model || null };
}

/**
 * Streaming completion via the instance passthrough (SSE). Invokes onDelta for
 * each incremental text chunk and resolves with the full text.
 *
 * Parses OpenAI-style `data: {json}\n\n` frames terminated by `data: [DONE]`.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {(delta: string) => void} onDelta
 * @param {Object} [options] same as inferenceComplete, plus options.signal
 * @returns {Promise<{content: string}>}
 */
export async function inferenceStream(messages, onDelta, options = {}) {
  const resp = await authorizedFetch('inference/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2000,
      tier: options.tier || 'auto',
    }),
    signal: options.signal,
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, 'LANA inference failed'));
  if (!resp.body) throw new Error('LANA inference returned no stream body.');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  const consumeEvent = (block) => {
    // A block is one SSE event; gather its data: lines.
    for (const line of block.split('\n')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return true;
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        const delta =
          json.choices?.[0]?.delta?.content ??
          json.choices?.[0]?.message?.content ??
          json.delta ??
          json.text ??
          '';
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // Non-JSON keepalive/comment line — ignore.
      }
    }
    return false;
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Normalize line endings so event boundaries are detected whether the
    // server uses LF (`\n\n`) or CRLF (`\r\n\r\n`, the SSE spec's own default).
    // Without this, a CRLF server never splits mid-stream and onDelta only
    // fires once at the end — streaming silently collapses to a single dump.
    buffer = buffer.replace(/\r\n/g, '\n');
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (consumeEvent(block)) return { content: full };
    }
  }
  // Flush the decoder (in case a multi-byte char straddled the last chunk),
  // then any trailing partial event.
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');
  if (buffer.trim()) consumeEvent(buffer);
  return { content: full };
}

// ---------------------------------------------------------------------------
// Account ingestion
// ---------------------------------------------------------------------------

/**
 * List the signed-in user's matters (case containers).
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function listMatters() {
  const resp = await authorizedFetch('matters', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not load matters'));
  const body = await resp.json();
  const items = Array.isArray(body) ? body : body.matters || body.items || [];
  return items.map((m) => ({ id: m.id, name: m.name || m.title || m.id }));
}

/** Max clip length sent for suggestion/filing — matches the backend cap. */
const MAX_CLIP_CHARS = 8000;

/**
 * Ask the server which of the user's matters a clip of research text should be
 * filed into. Contract: POST /matters/suggest (auth) `{text}` →
 * `{suggestions:[{matter_id,name,score,reason}]}` (top ~5).
 *
 * The clip text is capped at {@link MAX_CLIP_CHARS} to match the backend and is
 * never logged here. A 404 (endpoint not deployed yet) is surfaced as an error
 * tagged `code:'not_deployed'` so the caller can fall back to the local keyword
 * matcher (lib/matter-match.js) rather than treating it as a hard failure.
 *
 * @param {string} text  the clipped research text
 * @returns {Promise<Array<{matter_id: string, name: string, score: number|null, reason: string}>>}
 */
export async function suggestMatters(text) {
  const clip = String(text || '').slice(0, MAX_CLIP_CHARS);
  const resp = await authorizedFetch('matters/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: clip }),
  });
  if (resp.status === 404) {
    const err = new Error('matters/suggest endpoint not deployed');
    err.code = 'not_deployed';
    throw err;
  }
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not suggest matters'));
  const body = await resp.json().catch(() => ({}));
  const items = Array.isArray(body) ? body : body.suggestions || body.matters || [];
  return items
    .map((s) => ({
      matter_id: s.matter_id || s.matterId || s.id,
      name: s.name || s.title || s.matter_id || 'Matter',
      score: typeof s.score === 'number' ? s.score : null,
      reason: s.reason || '',
    }))
    .filter((s) => s.matter_id);
}

/**
 * Cascade delete: remove one memory the extension created (by its server id).
 * 404 is treated as success (already gone). @returns {Promise<boolean>}
 */
export async function deleteMemory(id) {
  if (!id) return true;
  const resp = await authorizedFetch(`memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) throw new Error(await errorMessage(resp, 'Could not delete memory'));
  return true;
}

/**
 * Cascade delete: remove knowledge a capture filed into a matter, by source id
 * (the capture id used at ingest). 404 tolerated. @returns {Promise<Object>}
 */
export async function deleteMatterKnowledge(matterId, sourceId) {
  if (!matterId || !sourceId) return {};
  const resp = await authorizedFetch(
    `matters/${encodeURIComponent(matterId)}/knowledge?source_id=${encodeURIComponent(sourceId)}`,
    { method: 'DELETE' },
  );
  if (!resp.ok && resp.status !== 404) throw new Error(await errorMessage(resp, 'Could not delete matter knowledge'));
  return resp.json().catch(() => ({}));
}

/**
 * Push a captured/synthesized text blob into a matter's knowledgebase (RAG).
 * This is the primary "inject into the primary LANA experience" path.
 *
 * @param {string} matterId
 * @param {Object} args
 * @param {string} args.content   the text to ingest (redacted server-side)
 * @param {string} args.sourceId  stable source id, e.g. the page URL
 * @returns {Promise<Object>} server response
 */
export async function sendKnowledge(matterId, { content, sourceId }) {
  if (!matterId) throw new Error('sendKnowledge requires a matterId.');
  if (!content || !content.trim()) throw new Error('sendKnowledge requires content.');
  const resp = await authorizedFetch(`matters/${encodeURIComponent(matterId)}/knowledge/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, source_id: sourceId || null }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not send to matter knowledge'));
  return resp.json().catch(() => ({}));
}

/**
 * Add a short salient fact to long-term memory (per-user, or per-matter when
 * matterId is given). Injected into the system prompt on future LANA chats.
 *
 * @param {Object} args
 * @param {string} args.fact
 * @param {string} [args.matterId]
 * @returns {Promise<Object>}
 */
export async function sendMemory({ fact, matterId }) {
  if (!fact || !fact.trim()) throw new Error('sendMemory requires a fact.');
  const resp = await authorizedFetch('memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fact, matter_id: matterId || null }),
  });
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not save memory'));
  return resp.json().catch(() => ({}));
}

/**
 * Read the signed-in user's Memory preference — whether LANA keeps long-term
 * memory for them. Contract: GET /memory/preference (auth) → `{enabled: bool}`,
 * default true. Degrades gracefully: a 404 (endpoint not deployed yet), a
 * not-signed-in state, or a network error all resolve to the soft default
 * `{enabled: true}` so the UI never throws over a missing/offline server.
 *
 * @returns {Promise<{enabled: boolean}>}
 */
export async function getMemoryPreference() {
  let resp;
  try {
    resp = await authorizedFetch('memory/preference', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    // Not signed in / offline / instance changed → soft default (memory on).
    return { enabled: true };
  }
  if (resp.status === 404) return { enabled: true }; // endpoint not deployed
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not load memory preference'));
  const body = await resp.json().catch(() => ({}));
  // Absent/garbled body → treat as the documented default (true).
  return { enabled: body.enabled !== false };
}

/**
 * Set the signed-in user's Memory preference. Contract: PUT /memory/preference
 * (auth) `{enabled: bool}`. Tolerates a 404 (endpoint not deployed) by resolving
 * to the requested value so the local client gate still takes effect. Network
 * errors / other non-OK statuses throw so the caller can revert the toggle.
 *
 * @param {boolean} enabled
 * @returns {Promise<{enabled: boolean}>}
 */
export async function setMemoryPreference(enabled) {
  const want = !!enabled;
  const resp = await authorizedFetch('memory/preference', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ enabled: want }),
  });
  if (resp.status === 404) return { enabled: want }; // endpoint not deployed yet
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not save memory preference'));
  const body = await resp.json().catch(() => ({}));
  // Prefer the server's echoed value; fall back to what we asked for.
  return { enabled: typeof body.enabled === 'boolean' ? body.enabled : want };
}

/**
 * Upload captured content as a document (encrypt → redact → chunk → embed, and
 * index into the matter KB when matterId is set). Use for full-page/document
 * capture where the redaction/analysis pipeline is wanted.
 *
 * @param {Object} args
 * @param {string} args.filename
 * @param {string|Blob} args.content   text or a Blob
 * @param {string} [args.matterId]
 * @param {boolean} [args.persist=true]
 * @returns {Promise<Object>}
 */
export async function sendDocument({ filename, content, matterId, persist = true }) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: 'text/plain' });
  const form = new FormData();
  form.append('file', blob, filename || 'capture.txt');
  form.append('persist', String(persist));
  if (matterId) form.append('matter_id', matterId);
  const resp = await authorizedFetch('documents', { method: 'POST', body: form });
  if (!resp.ok) throw new Error(await errorMessage(resp, 'Could not upload document'));
  return resp.json().catch(() => ({}));
}
