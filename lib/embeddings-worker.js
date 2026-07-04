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

// --- Offline, fully-bundled model loading -----------------------------------
// Everything the model needs ships inside the extension; nothing is fetched
// from a CDN at runtime. This keeps embeddings private (no data leaves the
// device) and working offline.
//
//   models/Xenova/all-MiniLM-L6-v2/{config,tokenizer,...}.json + onnx/*.onnx
//   vendor/ort/ort-wasm{,-simd}.wasm   (onnxruntime-web 1.14.0, matches the
//                                        bundled transformers.js 2.17.2)
//
// Absolute chrome-extension:// URLs resolved from this worker's own location so
// they're correct regardless of the extension id. Same-origin fetches from the
// worker need no web_accessible_resources entry.
env.allowRemoteModels = false;              // never hit huggingface.co
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', import.meta.url).href;
env.useBrowserCache = false;                // files are local; skip CacheStorage

if (env?.backends?.onnx?.wasm) {
  // Single-threaded: the threaded ort build needs cross-origin isolation
  // (SharedArrayBuffer), which an MV3 extension worker doesn't have. This also
  // avoids the blob: worker URLs that Chrome MV3 CSP blocks.
  env.backends.onnx.wasm.numThreads = 1;
  // Load the .wasm runtime from the bundled copy, not the default jsDelivr CDN.
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
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
