/**
 * @fileoverview Web Worker for Transformers.js embeddings (module worker)
 *
 * Loads the all-MiniLM-L6-v2 model (quantized, ~6MB) and handles
 * EMBED messages to produce 384-dimensional float vectors.
 *
 * Messages:
 *   IN:  { type: 'INIT' }
 *   OUT: { type: 'INIT_DONE' } | { type: 'INIT_ERROR', error: string }
 *
 *   IN:  { type: 'EMBED', id: string, texts: string[] }
 *   OUT: { type: 'EMBED_DONE', id: string, vectors: number[][] }
 *       | { type: 'EMBED_ERROR', id: string, error: string }
 */

import { pipeline, env } from '../vendor/transformers.min.js';

// Disable multi-threading to avoid blob: URLs blocked by Chrome MV3 CSP
if (env?.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
}

let extractor = null;

async function init() {
  try {
    extractor = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      { quantized: true }
    );

    self.postMessage({ type: 'INIT_DONE' });
  } catch (err) {
    self.postMessage({ type: 'INIT_ERROR', error: err.message });
  }
}

async function embed(id, texts) {
  if (!extractor) {
    self.postMessage({ type: 'EMBED_ERROR', id, error: 'Model not loaded' });
    return;
  }

  try {
    const vectors = [];
    for (const text of texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(output.data));
    }
    self.postMessage({ type: 'EMBED_DONE', id, vectors });
  } catch (err) {
    self.postMessage({ type: 'EMBED_ERROR', id, error: err.message });
  }
}

self.addEventListener('message', (e) => {
  const { type, id, texts } = e.data;

  switch (type) {
    case 'INIT':
      init();
      break;
    case 'EMBED':
      embed(id, texts);
      break;
  }
});
