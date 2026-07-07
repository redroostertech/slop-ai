/**
 * @fileoverview Pure client-side fallback matcher: rank a user's matters by
 * keyword overlap with a clip of research text. Used by the Clip Review panel
 * when the server's `POST matters/suggest` endpoint is unavailable (404 / not
 * deployed), the user is offline, or unauthenticated — so the "recommended
 * matters" experience still works with only the locally-known matter list.
 *
 * Deterministic and dependency-free (no chrome/DOM): ties keep input order, so
 * with no keyword signal it returns nothing (an empty recommendation set is the
 * honest default — the UI then falls back to a plain manual pick).
 *
 * Mirrors the ranking idea in lib/playbook-rank.js (keyword hits over a small
 * haystack) but is shaped to the `{matter_id, name, score, reason}` contract the
 * server endpoint returns, so the UI treats server + fallback results uniformly.
 *
 * @module lib/matter-match
 */

/** Common words that carry no matching signal — excluded from tokenization. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'him', 'she', 'its', 'who',
  'that', 'this', 'with', 'from', 'they', 'will', 'been', 'have', 'were', 'their',
  'what', 'when', 'your', 'them', 'then', 'than', 'into', 'over', 'such', 'only',
  'also', 'here', 'there', 'about', 'would', 'could', 'should', 'which', 'these',
  'those', 'shall', 'matter', 'case',
]);

/**
 * Split text into a de-duplicated set of lowercased alphanumeric tokens of
 * length ≥ 3, dropping stopwords.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Rank matters by how many of their name's keywords appear in the clip text.
 *
 * @param {string} text  the clipped research text
 * @param {Array<{id?: string, matter_id?: string, name?: string, title?: string}>} matters
 * @param {number} [limit=5]  max recommendations to return
 * @returns {Array<{matter_id: string, name: string, score: number, reason: string}>}
 *   descending by score; only matters with at least one keyword hit. `score` is a
 *   0..1 confidence (matched name-keywords / total name-keywords).
 */
export function matchMatters(text, matters, limit = 5) {
  const clipTokens = new Set(tokenize(text));
  if (!clipTokens.size) return [];

  const scored = (matters || [])
    .filter(Boolean)
    .map((m, i) => {
      const id = m.id || m.matter_id || m.matterId;
      const name = m.name || m.title || id || '';
      const nameTokens = tokenize(name);
      const matched = nameTokens.filter((t) => clipTokens.has(t));
      // Confidence: fraction of the matter name's keywords found in the clip.
      const score = nameTokens.length ? matched.length / nameTokens.length : 0;
      const reason = matched.length
        ? `Clip mentions ${matched.slice(0, 3).join(', ')}`
        : '';
      return { matter_id: id, name: String(name), score, reason, hits: matched.length, i };
    })
    .filter((s) => s.matter_id && s.hits > 0);

  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored
    .slice(0, Math.max(0, limit))
    .map((s) => ({ matter_id: s.matter_id, name: s.name, score: s.score, reason: s.reason }));
}
