/**
 * @fileoverview Surface relevant info from LANA (and, later, other agents).
 *
 * Capability #5. While the user is on any page or chatting, surface relevant
 * context from their LANA account (L3/L4) and eventually other connected
 * agents. Two sources:
 *   - LOCAL (L2): already implemented by lib/relevance.js (findRelevantKnowledge)
 *   - LANA  (L3/L4): retrieval from the account — implemented here.
 *
 * STATUS: SCAFFOLD. The exact LANA retrieval endpoint the extension may call is
 * not yet finalized (the account API exposes /search and /corpus, but a
 * client-facing "surface relevant context" endpoint is part of the passthrough
 * spec the LANA developer will implement). The function is written against the
 * expected shape and clearly guarded; wire the final path when the spec lands.
 *
 * The "other agents" part is a pluggable SourceProvider interface (below) so
 * additional sources register uniformly — this is where the connector concept
 * lives on the extension side.
 *
 * @module lib/capabilities/surface
 */

import { authorizedFetch } from '../lana-auth.js';

/**
 * @typedef {Object} SurfaceHit
 * @property {string} title
 * @property {string} snippet
 * @property {string} source   e.g. 'lana:matter' | 'lana:memory' | 'local'
 * @property {number} score
 * @property {string} [ref]    matter id / url / doc id for follow-through
 */

/**
 * A source that can be queried for relevant context. Register more (other
 * agents/tools) via {@link registerSource}.
 * @typedef {Object} SourceProvider
 * @property {string} id
 * @property {(query: string, opts: Object) => Promise<SurfaceHit[]>} query
 */

/** @type {Map<string, SourceProvider>} */
const SOURCES = new Map();

/** Register a pluggable context source (an "agent"). */
export function registerSource(provider) {
  if (!provider?.id || typeof provider.query !== 'function') {
    throw new Error('A source needs an id and a query() function.');
  }
  SOURCES.set(provider.id, provider);
}

/** The built-in LANA account source. */
const lanaSource = {
  id: 'lana',
  /**
   * Query the LANA account for relevant context.
   * TODO(spec): confirm the endpoint + payload with the passthrough spec. The
   * current guess is `POST /search { query, scope }`. Until confirmed this
   * returns [] on any non-2xx so it never breaks the surfacing UI.
   */
  async query(query, opts = {}) {
    try {
      const resp = await authorizedFetch('search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, scope: opts.matterId ? 'matter' : 'account', matter_id: opts.matterId || null, limit: opts.limit || 5 }),
      });
      if (!resp.ok) return [];
      const body = await resp.json().catch(() => ({}));
      const items = body.results || body.hits || [];
      return items.map((it) => ({
        title: it.title || it.name || 'LANA result',
        snippet: it.snippet || it.text || it.excerpt || '',
        source: it.matter_id ? 'lana:matter' : 'lana:memory',
        score: it.score ?? 0,
        ref: it.matter_id || it.id || it.ref || null,
      }));
    } catch {
      return [];
    }
  },
};
registerSource(lanaSource);

/**
 * Surface relevant context for the given text across all registered sources.
 * Runs sources concurrently; a failing source contributes nothing rather than
 * failing the whole surface.
 *
 * @param {string} query
 * @param {Object} [opts]
 * @param {string} [opts.matterId]
 * @param {number} [opts.limit=5]
 * @returns {Promise<SurfaceHit[]>} merged, score-sorted
 */
export async function surface(query, opts = {}) {
  if (!query || !query.trim()) return [];
  const results = await Promise.all(
    Array.from(SOURCES.values()).map((s) => s.query(query, opts).catch(() => []))
  );
  return results.flat().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, opts.limit || 10);
}
