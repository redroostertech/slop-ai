/**
 * @fileoverview Embeddings interface for Transformers.js
 *
 * Manages a Web Worker that runs the all-MiniLM-L6-v2 model for
 * generating 384-dimensional sentence embeddings. Used for semantic
 * relevance scoring and topic matching.
 *
 * @module lib/embeddings
 */

let worker = null;
let modelLoaded = false;
let modelLoading = false;
let pendingRequests = new Map();
let requestCounter = 0;

/**
 * Initialize the embeddings worker and start loading the model.
 * Safe to call multiple times — only the first call spawns the worker.
 * @returns {Promise<boolean>} true if model loaded successfully
 */
export function initEmbeddings() {
  if (modelLoaded) return Promise.resolve(true);
  if (modelLoading) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (modelLoaded) { clearInterval(check); resolve(true); }
        if (!modelLoading && !modelLoaded) { clearInterval(check); resolve(false); }
      }, 200);
    });
  }

  modelLoading = true;

  return new Promise((resolve) => {
    try {
      worker = new Worker(
        new URL('./embeddings-worker.js', import.meta.url),
        { type: 'module' }
      );

      worker.addEventListener('message', handleWorkerMessage);
      worker.addEventListener('error', (err) => {
        console.error('[Embeddings] Worker error:', err.message);
        modelLoading = false;
        resolve(false);
      });

      // Listen for init completion
      const onInit = (e) => {
        if (e.data.type === 'INIT_DONE') {
          modelLoaded = true;
          modelLoading = false;
          worker.removeEventListener('message', onInit);
          resolve(true);
        } else if (e.data.type === 'INIT_ERROR') {
          console.error('[Embeddings] Init error:', e.data.error);
          modelLoading = false;
          worker.removeEventListener('message', onInit);
          resolve(false);
        }
      };
      worker.addEventListener('message', onInit);

      worker.postMessage({ type: 'INIT' });
    } catch (err) {
      console.error('[Embeddings] Failed to create worker:', err);
      modelLoading = false;
      resolve(false);
    }
  });
}

/**
 * Handle messages from the worker.
 */
function handleWorkerMessage(e) {
  const { type, id, vectors, error } = e.data;

  if (type === 'EMBED_DONE' && pendingRequests.has(id)) {
    pendingRequests.get(id).resolve(vectors);
    pendingRequests.delete(id);
  } else if (type === 'EMBED_ERROR' && pendingRequests.has(id)) {
    pendingRequests.get(id).reject(new Error(error));
    pendingRequests.delete(id);
  }
}

/**
 * Embed an array of text strings into vectors.
 * @param {string[]} texts - Texts to embed
 * @returns {Promise<number[][]>} Array of 384-dim vectors
 */
export function embed(texts) {
  if (!modelLoaded || !worker) {
    return Promise.reject(new Error('Embeddings model not loaded'));
  }

  const id = String(++requestCounter);
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ type: 'EMBED', id, texts });
  });
}

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} Similarity score between -1 and 1
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Check if the embedding model is loaded and ready.
 * @returns {boolean}
 */
export function isModelLoaded() {
  return modelLoaded;
}

/**
 * Check if the model is currently loading.
 * @returns {boolean}
 */
export function isModelLoading() {
  return modelLoading;
}

/**
 * Terminate the worker and release resources.
 */
export function destroyEmbeddings() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  modelLoaded = false;
  modelLoading = false;
  pendingRequests.clear();
}
