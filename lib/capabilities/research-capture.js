/**
 * @fileoverview Research capture from arbitrary web pages.
 *
 * Capability #1. Extends capture from just the 5 AI chat sites to ANY page the
 * user is researching. Two halves:
 *   - extractReadable()  runs in the PAGE (content script): pulls the main
 *     article text + metadata out of the DOM with a lightweight readability
 *     heuristic (no external dependency).
 *   - saveClip()         runs in the background: stores the extracted clip in
 *     the local knowledge store (L2) as a conversation-shaped record so the
 *     existing relevance/embeddings pipeline indexes it for free.
 *
 * Broadening capture to any host needs host permission for that page; request
 * it on demand (activeTab / optional permissions) rather than at install.
 *
 * @module lib/capabilities/research-capture
 */

import { dbPut } from '../db.js';

/**
 * Lightweight main-content extraction. Scores block elements by text density
 * and picks the densest subtree. Intended to run in the page context where
 * `document` exists. Deliberately dependency-free (Readability.js would be the
 * heavier upgrade if this proves insufficient).
 *
 * @param {Document} doc
 * @returns {{title: string, url: string, text: string, excerpt: string}}
 */
export function extractReadable(doc) {
  const url = doc.location?.href || '';
  const title =
    doc.querySelector('meta[property="og:title"]')?.content ||
    doc.querySelector('title')?.textContent ||
    doc.title ||
    '';

  const candidates = Array.from(doc.querySelectorAll('article, main, [role="main"], .post, .article, .content, #content'));
  const scope = candidates.length ? candidates : [doc.body].filter(Boolean);

  let best = { node: null, score: 0 };
  for (const root of scope) {
    if (!root) continue;
    const paras = Array.from(root.querySelectorAll('p, li, blockquote'));
    const text = paras.map((p) => p.textContent.trim()).filter((t) => t.length > 40).join('\n\n');
    const score = text.length;
    if (score > best.score) best = { node: root, score, text };
  }

  const text = (best.text || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  const excerpt =
    doc.querySelector('meta[name="description"]')?.content ||
    doc.querySelector('meta[property="og:description"]')?.content ||
    text.slice(0, 240);

  return { title: title.trim(), url, text, excerpt: excerpt.trim() };
}

/**
 * Persist an extracted clip into the local knowledge store as a research
 * "conversation" so it flows through the existing indexing pipeline.
 *
 * @param {{title: string, url: string, text: string, excerpt: string, selection?: string, source?: string, kind?: string}} clip
 * @returns {Promise<{id: string}>}
 */
export async function saveClip(clip) {
  if (!clip || !clip.text?.trim()) throw new Error('saveClip requires extracted text.');
  const now = Date.now();
  const id = `clip:${now}:${Math.abs(hashString(clip.url || clip.title || String(now)))}`;
  const body = clip.selection?.trim() ? clip.selection.trim() : clip.text;
  const record = {
    id,
    title: clip.title || clip.url || 'Web clip',
    // Callers (selection clip, context-menu clip) tag their own source/kind so
    // Captured can segment them under "Clips"; full-page research clips default
    // to the historical 'research'/'clip' shape.
    source: clip.source || 'research',
    kind: clip.kind || 'clip',
    url: clip.url || '',
    createdAt: now,
    updatedAt: now,
    timestamp: now,
    messageCount: 1,
    // Shaped like a conversation turn so relevance/embeddings treat it uniformly.
    messages: [{ role: 'user', content: body, capturedAt: now }],
    excerpt: clip.excerpt || body.slice(0, 240),
  };
  await dbPut('conversations', record);
  return { id };
}

/** Deterministic string hash (djb2) — stable clip ids without Math.random. */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return h | 0;
}
