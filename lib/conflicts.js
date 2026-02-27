/**
 * @fileoverview Conflict Detection Engine for AI Context Bridge
 *
 * Detects when newer conversations contradict older decisions, insights, or
 * knowledge stored in the knowledge base. Operates in three modes:
 *
 * 1. **Heuristic Pre-filter** (fast, no API) — scans summaries for textual
 *    signals of contradiction using negation patterns, technology switches,
 *    contradictory adjectives, and temporal override phrases.
 *
 * 2. **AI-Powered Verification** (accurate, uses OpenAI) — sends heuristic
 *    candidates to an LLM to confirm whether they represent genuine conflicts,
 *    classify severity, and generate resolution recommendations.
 *
 * 3. **Single Summary Check** — optimized path for checking one newly created
 *    summary against existing knowledge immediately after summarization.
 *
 * Conflicts are stored in `chrome.storage.local` under the `conflicts` key to
 * avoid modifying the shared IndexedDB schema.
 *
 * @module lib/conflicts
 */

import { dbGetAll } from './db.js';
import { generateId } from './utils.js';
import { complete, hasEnabledProvider } from './ai-router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Words and phrases that signal negation or reversal of a prior position.
 * Used by the heuristic pre-filter to flag candidate conflicts.
 * @type {string[]}
 */
const NEGATION_WORDS = [
  "don't", "avoid", "instead", "rather than", "not", "never", "stop",
  "switch from", "migrate from", "replace", "drop", "remove", "abandon",
  "actually", "changed", "reconsidered", "on second thought", "turns out",
  "better alternative", "worse than expected", "doesn't work", "failed"
];

/**
 * Regular expressions that detect technology migration / swap patterns.
 * Each pattern captures the "from" technology and the "to" technology.
 * @type {RegExp[]}
 */
const TECH_SWITCH_PATTERNS = [
  /switch(?:ed|ing)?\s+(?:from\s+)?(\w+)\s+to\s+(\w+)/i,
  /migrat(?:e|ed|ing)\s+(?:from\s+)?(\w+)\s+to\s+(\w+)/i,
  /replac(?:e|ed|ing)\s+(\w+)\s+with\s+(\w+)/i,
  /(\w+)\s+(?:is|was)\s+better\s+than\s+(\w+)/i
];

/**
 * Pairs of contradictory adjectives. If the same entity is described by
 * opposing adjectives across two summaries, that is a candidate conflict.
 * @type {Array<[string, string]>}
 */
const CONTRADICTORY_ADJECTIVE_PAIRS = [
  ['fast', 'slow'],
  ['simple', 'complex'],
  ['easy', 'difficult'],
  ['lightweight', 'heavy'],
  ['lightweight', 'bloated'],
  ['secure', 'insecure'],
  ['scalable', 'unscalable'],
  ['reliable', 'unreliable'],
  ['stable', 'unstable'],
  ['performant', 'slow'],
  ['modern', 'outdated'],
  ['recommended', 'deprecated'],
  ['good', 'bad'],
  ['best', 'worst'],
  ['better', 'worse'],
  ['efficient', 'inefficient'],
  ['clean', 'messy'],
  ['maintainable', 'unmaintainable'],
  ['readable', 'unreadable'],
  ['flexible', 'rigid'],
  ['mature', 'immature']
];

/**
 * Phrases that signal the author is explicitly overriding an earlier opinion.
 * @type {string[]}
 */
const TEMPORAL_OVERRIDE_PHRASES = [
  'actually', 'changed my mind', 'on second thought', 'after testing',
  'after trying', 'after further review', 'after more research',
  'i was wrong', 'turns out', 'in hindsight', 'reconsidered',
  'updated my thinking', 'revised my approach', 'new approach',
  'better approach', 'going forward', 'instead we should', 'no longer',
  'decided against', 'backed off from', 'moved away from',
  'pivoted to', 'pivoting to', 'switching to'
];

/**
 * Common English stopwords to exclude from keyword extraction.
 * Mirrors the set in relevance.js for consistency.
 * @type {Set<string>}
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'were',
  'been', 'are', 'am', 'do', 'does', 'did', 'has', 'had', 'have', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our',
  'their', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'if', 'then', 'else', 'so', 'up', 'out', 'about', 'into', 'over',
  'after', 'before', 'between', 'under', 'again', 'just', 'also', 'than',
  'very', 'too', 'some', 'any', 'all', 'each', 'every', 'both', 'few',
  'more', 'most', 'other', 'such', 'only', 'same', 'here', 'there',
  'now', 'then', 'once', 'still', 'already', 'much', 'many', 'well',
  'back', 'even', 'new', 'way', 'use', 'like', 'get', 'make', 'go',
  'know', 'take', 'see', 'come', 'think', 'look', 'want', 'give', 'need',
  'tell', 'say', 'try', 'ask', 'work', 'seem', 'feel', 'let', 'keep',
  'help', 'show', 'put', 'set', 'run', 'move', 'play', 'turn', 'being',
  'thing', 'things', 'really', 'using', 'used', 'one', 'two', 'first',
  'last', 'long', 'great', 'little', 'own', 'old', 'right', 'while',
  'able', 'done', 'going', 'something', 'anything', 'everything', 'nothing'
]);

/**
 * Minimum heuristic score a candidate must reach to be stored or forwarded
 * to AI verification.
 * @type {number}
 */
const HEURISTIC_SCORE_THRESHOLD = 0.3;

/**
 * Minimum AI confidence score required to persist a verified conflict.
 * @type {number}
 */
const AI_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Maximum number of concurrent AI verification requests.
 * @type {number}
 */
const MAX_CONCURRENT_AI_REQUESTS = 5;

// ---------------------------------------------------------------------------
// Text Utilities
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase meaningful words.
 * Splits camelCase, strips punctuation, removes stopwords.
 *
 * @param {string} text - Raw input text
 * @returns {string[]} Array of unique, meaningful tokens
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  const words = expanded
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, ' ')
    .split(/[\s\-]+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));

  return [...new Set(words)];
}

/**
 * Extract all meaningful keywords from a summary's decisions, insights, tags,
 * and title. Returns a deduplicated set.
 *
 * @param {Object} summary - A summary record
 * @returns {Set<string>} Set of meaningful keyword tokens
 */
function extractKeywords(summary) {
  const sources = [
    summary.title || '',
    ...(summary.decisions || []),
    ...(summary.keyInsights || []),
    ...(summary.tags || [])
  ];

  const tokens = new Set();
  for (const source of sources) {
    for (const token of tokenize(source)) {
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Calculate the Jaccard similarity coefficient between two sets.
 *
 * @param {Set<string>} setA
 * @param {Set<string>} setB
 * @returns {number} Value between 0 and 1
 */
function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Calculate the overlap coefficient between two tag arrays.
 * overlap = |A intersect B| / min(|A|, |B|)
 * Returns 0 if either array is empty.
 *
 * @param {string[]} tagsA
 * @param {string[]} tagsB
 * @returns {number} Value between 0 and 1
 */
function tagOverlap(tagsA, tagsB) {
  if (!tagsA || !tagsB || tagsA.length === 0 || tagsB.length === 0) return 0;

  const setA = new Set(tagsA.map(t => t.toLowerCase()));
  const setB = new Set(tagsB.map(t => t.toLowerCase()));

  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }

  const minSize = Math.min(setA.size, setB.size);
  return minSize === 0 ? 0 : intersection / minSize;
}

/**
 * Check whether a text string contains any of the provided phrases.
 *
 * @param {string} text - Text to search within
 * @param {string[]} phrases - Phrases to search for
 * @returns {string[]} Array of matched phrases found in the text
 */
function findMatchingPhrases(text, phrases) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return phrases.filter(phrase => lower.includes(phrase.toLowerCase()));
}

/**
 * Extract technology names referenced by technology switch regex patterns.
 *
 * @param {string} text - Text to scan
 * @returns {Array<{from: string, to: string, pattern: string}>} Detected switches
 */
function detectTechSwitches(text) {
  if (!text) return [];

  const switches = [];
  for (const pattern of TECH_SWITCH_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      switches.push({
        from: match[1].toLowerCase(),
        to: match[2].toLowerCase(),
        pattern: match[0]
      });
    }
  }
  return switches;
}

/**
 * Find contradictory adjective usage between two text strings.
 * Checks if the same conceptual entity is described with opposing adjectives.
 *
 * @param {string} textA - Older text
 * @param {string} textB - Newer text
 * @returns {Array<{adjA: string, adjB: string}>} Contradictory pairs found
 */
function findContradictoryAdjectives(textA, textB) {
  if (!textA || !textB) return [];

  const lowerA = textA.toLowerCase();
  const lowerB = textB.toLowerCase();
  const found = [];

  for (const [adj1, adj2] of CONTRADICTORY_ADJECTIVE_PAIRS) {
    // Check both orderings: adj1 in older & adj2 in newer, or vice versa
    if (
      (lowerA.includes(adj1) && lowerB.includes(adj2)) ||
      (lowerA.includes(adj2) && lowerB.includes(adj1))
    ) {
      found.push({
        adjA: lowerA.includes(adj1) ? adj1 : adj2,
        adjB: lowerB.includes(adj1) ? adj1 : adj2
      });
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Core Heuristic Comparison
// ---------------------------------------------------------------------------

/**
 * Compare the decisions and insights from two summaries and return an array
 * of candidate conflict signals with associated scores.
 *
 * The comparison considers:
 * 1. Keyword overlap between the two items (same nouns / technologies)
 * 2. Negation / contradiction signals
 * 3. Technology switch patterns
 * 4. Contradictory adjectives
 * 5. Temporal override phrases in the newer content
 *
 * @param {Object} older - The chronologically older summary
 * @param {Object} newer - The chronologically newer summary
 * @returns {Array<{olderContent: string, newerContent: string, signals: string[], score: number}>}
 */
function compareDecisions(older, newer) {
  const candidates = [];

  // Gather all comparable content pairs
  const olderItems = [
    ...(older.decisions || []).map(d => ({ text: d, type: 'decision' })),
    ...(older.keyInsights || []).map(i => ({ text: i, type: 'insight' }))
  ];

  const newerItems = [
    ...(newer.decisions || []).map(d => ({ text: d, type: 'decision' })),
    ...(newer.keyInsights || []).map(i => ({ text: i, type: 'insight' }))
  ];

  if (olderItems.length === 0 || newerItems.length === 0) return candidates;

  for (const olderItem of olderItems) {
    const olderTokens = new Set(tokenize(olderItem.text));
    if (olderTokens.size === 0) continue;

    for (const newerItem of newerItems) {
      const newerTokens = new Set(tokenize(newerItem.text));
      if (newerTokens.size === 0) continue;

      // Step 1: Check keyword overlap — must share at least some terminology
      const overlap = jaccardSimilarity(olderTokens, newerTokens);
      if (overlap < 0.05) continue; // Completely unrelated, skip

      const signals = [];
      let score = 0;

      // Step 2: Negation / contradiction words in the newer item referencing
      // keywords from the older item
      const negationsInNewer = findMatchingPhrases(newerItem.text, NEGATION_WORDS);
      if (negationsInNewer.length > 0) {
        // Verify that the negation is about something from the older item
        const sharedTokens = [...olderTokens].filter(t => newerTokens.has(t));
        if (sharedTokens.length > 0) {
          signals.push(`negation_pattern: "${negationsInNewer.join('", "')}" with shared keywords [${sharedTokens.join(', ')}]`);
          score += 0.25 + (negationsInNewer.length * 0.05);
        }
      }

      // Also check negations in older item that newer contradicts
      const negationsInOlder = findMatchingPhrases(olderItem.text, NEGATION_WORDS);
      if (negationsInOlder.length > 0) {
        const sharedTokens = [...olderTokens].filter(t => newerTokens.has(t));
        if (sharedTokens.length > 0) {
          signals.push(`reverse_negation: older says "${negationsInOlder.join('", "')}" with shared keywords [${sharedTokens.join(', ')}]`);
          score += 0.15;
        }
      }

      // Step 3: Technology switch patterns
      const newerSwitches = detectTechSwitches(newerItem.text);
      for (const sw of newerSwitches) {
        // Check if the older item mentions the "from" technology positively
        if (olderTokens.has(sw.from)) {
          signals.push(`tech_switch: "${sw.pattern}" (older mentions ${sw.from})`);
          score += 0.35;
        }
      }

      const olderSwitches = detectTechSwitches(olderItem.text);
      for (const sw of olderSwitches) {
        // If the older item switched TO something the newer item contradicts
        if (newerTokens.has(sw.from) || newerTokens.has(sw.to)) {
          signals.push(`prior_switch: older had "${sw.pattern}"`);
          score += 0.15;
        }
      }

      // Step 4: Contradictory adjectives about shared topics
      const contradictions = findContradictoryAdjectives(olderItem.text, newerItem.text);
      if (contradictions.length > 0) {
        for (const c of contradictions) {
          signals.push(`contradictory_adjective: "${c.adjA}" vs "${c.adjB}"`);
          score += 0.2;
        }
      }

      // Step 5: Temporal override phrases in the newer content
      const overrides = findMatchingPhrases(newerItem.text, TEMPORAL_OVERRIDE_PHRASES);
      if (overrides.length > 0) {
        const sharedTokens = [...olderTokens].filter(t => newerTokens.has(t));
        if (sharedTokens.length > 0) {
          signals.push(`temporal_override: "${overrides.join('", "')}" with shared keywords [${sharedTokens.join(', ')}]`);
          score += 0.2 + (overrides.length * 0.05);
        }
      }

      // Step 6: Boost score based on keyword overlap strength
      // Higher overlap means more likely to be about the same thing
      if (overlap > 0.15) {
        score += overlap * 0.3;
      }

      // Only emit if we found at least one signal
      if (signals.length > 0) {
        candidates.push({
          olderContent: olderItem.text,
          newerContent: newerItem.text,
          olderContentType: olderItem.type,
          newerContentType: newerItem.type,
          signals,
          score: Math.min(score, 1.0) // Cap at 1.0
        });
      }
    }
  }

  return candidates;
}

/**
 * Compare two summaries at the summary level (title, tags, overall text) for
 * additional conflict signals beyond individual decision/insight pairs.
 * This catches cases where the overall thrust of two summaries conflicts
 * even if no single decision-to-decision pair is flagged.
 *
 * @param {Object} older - The chronologically older summary
 * @param {Object} newer - The chronologically newer summary
 * @returns {Array<{olderContent: string, newerContent: string, signals: string[], score: number}>}
 */
function compareSummaryLevel(older, newer) {
  const candidates = [];

  const olderText = [
    older.title || '',
    older.summary || '',
    ...(older.decisions || []),
    ...(older.keyInsights || [])
  ].join(' ');

  const newerText = [
    newer.title || '',
    newer.summary || '',
    ...(newer.decisions || []),
    ...(newer.keyInsights || [])
  ].join(' ');

  // Look for tech switches at the full summary level
  const newerSwitches = detectTechSwitches(newerText);
  const olderKeywords = extractKeywords(older);

  for (const sw of newerSwitches) {
    if (olderKeywords.has(sw.from)) {
      const signals = [`summary_level_tech_switch: "${sw.pattern}" contradicts older knowledge about ${sw.from}`];
      candidates.push({
        olderContent: `Summary "${older.title}" discusses ${sw.from}`,
        newerContent: `Summary "${newer.title}" suggests: ${sw.pattern}`,
        olderContentType: 'summary',
        newerContentType: 'summary',
        signals,
        score: 0.3
      });
    }
  }

  // Look for contradictory adjectives at the full-text level when there is
  // meaningful keyword overlap
  const newerKeywords = extractKeywords(newer);
  const keywordOverlap = jaccardSimilarity(olderKeywords, newerKeywords);

  if (keywordOverlap > 0.15) {
    const adjConflicts = findContradictoryAdjectives(olderText, newerText);
    if (adjConflicts.length >= 2) {
      // Multiple contradictory adjective pairs about overlapping topics
      const signals = adjConflicts.map(c => `summary_adjective_conflict: "${c.adjA}" vs "${c.adjB}"`);
      candidates.push({
        olderContent: `Summary "${older.title}"`,
        newerContent: `Summary "${newer.title}"`,
        olderContentType: 'summary',
        newerContentType: 'summary',
        signals,
        score: Math.min(0.2 + (adjConflicts.length * 0.1), 0.7)
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Heuristic Candidate Discovery (Mode 1)
// ---------------------------------------------------------------------------

/**
 * Scan all summaries in the knowledge base for potential conflicts using fast
 * heuristic text analysis. No API calls are made.
 *
 * The algorithm:
 * 1. Groups summaries by topic for intra-topic comparison (primary).
 * 2. Cross-topic comparisons are performed only when tag overlap > 50%.
 * 3. For each ordered pair (older, newer), runs `compareDecisions()` and
 *    `compareSummaryLevel()` to collect signals and scores.
 * 4. Deduplicates and returns candidates above the heuristic threshold.
 *
 * @returns {Promise<Array<{
 *   olderSummaryId: string,
 *   newerSummaryId: string,
 *   olderTopicId: string|null,
 *   newerTopicId: string|null,
 *   olderContent: string,
 *   newerContent: string,
 *   signals: string[],
 *   heuristicScore: number
 * }>>} Candidate conflict pairs sorted by score descending
 */
export async function findCandidateConflicts() {
  let summaries, topics;
  try {
    [summaries, topics] = await Promise.all([
      dbGetAll('summaries'),
      dbGetAll('topics')
    ]);
  } catch (err) {
    console.error('[Conflicts] Failed to fetch data for heuristic scan:', err);
    return [];
  }

  if (!summaries || summaries.length < 2) return [];

  // Build topic lookup
  const topicMap = new Map();
  if (topics) {
    for (const topic of topics) {
      topicMap.set(topic.id, topic);
    }
  }

  // Group summaries by topic
  /** @type {Map<string, Object[]>} topicId -> summaries sorted by createdAt asc */
  const byTopic = new Map();
  /** @type {Object[]} summaries without a topic */
  const unassigned = [];

  for (const s of summaries) {
    if (s.topicId) {
      if (!byTopic.has(s.topicId)) byTopic.set(s.topicId, []);
      byTopic.get(s.topicId).push(s);
    } else {
      unassigned.push(s);
    }
  }

  // Sort each group chronologically (oldest first)
  for (const group of byTopic.values()) {
    group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  const allCandidates = [];

  // --- Intra-topic comparisons ---
  for (const [topicId, group] of byTopic.entries()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const older = group[i];
        const newer = group[j];

        const decisionCandidates = compareDecisions(older, newer);
        const summaryCandidates = compareSummaryLevel(older, newer);
        const combined = [...decisionCandidates, ...summaryCandidates];

        for (const candidate of combined) {
          if (candidate.score >= HEURISTIC_SCORE_THRESHOLD) {
            allCandidates.push({
              olderSummaryId: older.id,
              newerSummaryId: newer.id,
              olderTopicId: older.topicId,
              newerTopicId: newer.topicId,
              olderContent: candidate.olderContent,
              newerContent: candidate.newerContent,
              signals: candidate.signals,
              heuristicScore: candidate.score
            });
          }
        }
      }
    }
  }

  // --- Cross-topic comparisons (only when tag overlap > 50%) ---
  const topicIds = [...byTopic.keys()];
  for (let i = 0; i < topicIds.length; i++) {
    for (let j = i + 1; j < topicIds.length; j++) {
      const topicA = topicMap.get(topicIds[i]);
      const topicB = topicMap.get(topicIds[j]);
      if (!topicA || !topicB) continue;

      const overlap = tagOverlap(topicA.tags || [], topicB.tags || []);
      if (overlap <= 0.5) continue;

      // Compare all summary pairs across the two topics
      const groupA = byTopic.get(topicIds[i]);
      const groupB = byTopic.get(topicIds[j]);

      for (const sA of groupA) {
        for (const sB of groupB) {
          // Determine chronological order
          const aTime = new Date(sA.createdAt).getTime();
          const bTime = new Date(sB.createdAt).getTime();
          const older = aTime <= bTime ? sA : sB;
          const newer = aTime <= bTime ? sB : sA;

          const decisionCandidates = compareDecisions(older, newer);
          const summaryCandidates = compareSummaryLevel(older, newer);
          const combined = [...decisionCandidates, ...summaryCandidates];

          for (const candidate of combined) {
            if (candidate.score >= HEURISTIC_SCORE_THRESHOLD) {
              allCandidates.push({
                olderSummaryId: older.id,
                newerSummaryId: newer.id,
                olderTopicId: older.topicId,
                newerTopicId: newer.topicId,
                olderContent: candidate.olderContent,
                newerContent: candidate.newerContent,
                signals: candidate.signals,
                heuristicScore: candidate.score
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate by (olderSummaryId, newerSummaryId, olderContent, newerContent)
  const seen = new Set();
  const deduplicated = [];
  for (const c of allCandidates) {
    const key = `${c.olderSummaryId}|${c.newerSummaryId}|${c.olderContent}|${c.newerContent}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(c);
    }
  }

  // Sort by heuristicScore descending
  deduplicated.sort((a, b) => b.heuristicScore - a.heuristicScore);

  return deduplicated;
}

// ---------------------------------------------------------------------------
// AI-Powered Verification (Mode 2)
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for conflict verification.
 * @returns {string}
 */
function buildVerificationSystemPrompt() {
  return `You are a knowledge-base conflict detection assistant. Your job is to analyze two pieces of information from a user's knowledge base and determine if they genuinely conflict with each other.

A "conflict" means the two items cannot both be true or acted upon simultaneously — they represent contradictory decisions, opposing recommendations, or incompatible approaches.

Things that are NOT conflicts:
- Natural evolution or refinement of an idea (e.g., adding nuance to an earlier take)
- Complementary information (both can be true)
- Different aspects of the same topic being discussed
- Level of detail differences (one is more specific than the other)
- Context-dependent advice (one is for frontend, the other for backend)

You must respond with valid JSON matching this exact schema:

{
  "isConflict": true/false,
  "type": "decision_conflict" | "insight_conflict" | "approach_conflict" | "fact_conflict",
  "severity": "high" | "medium" | "low",
  "analysis": "1-2 sentence explanation of why this is or is not a conflict",
  "recommendation": "1-2 sentence recommendation for resolving the conflict (or 'No conflict detected' if not a real conflict)",
  "confidenceScore": 0.0 to 1.0
}

Conflict types:
- decision_conflict: Opposite decisions were made (use X vs avoid X)
- insight_conflict: Contradictory conclusions or lessons learned
- approach_conflict: Different approaches recommended for the same problem
- fact_conflict: Contradictory factual claims

Severity:
- high: Directly opposite decisions or recommendations that cannot coexist
- medium: Different approaches that could cause confusion if both are followed
- low: Minor discrepancy or subtle difference in emphasis

Be conservative — only mark something as a conflict if you are fairly confident. Evolution of thinking is natural and healthy, not a conflict.`;
}

/**
 * Build the user prompt for a single conflict candidate.
 *
 * @param {Object} candidate - A candidate from findCandidateConflicts()
 * @returns {string}
 */
function buildVerificationUserPrompt(candidate) {
  return `Analyze these two pieces of knowledge for potential conflict:

**OLDER item** (from earlier conversation):
"${candidate.olderContent}"

**NEWER item** (from more recent conversation):
"${candidate.newerContent}"

**Heuristic signals detected:**
${candidate.signals.map(s => `- ${s}`).join('\n')}

**Heuristic confidence score:** ${candidate.heuristicScore.toFixed(2)}

Is this a genuine conflict, or just natural evolution / complementary information?`;
}

/**
 * Verify a single candidate conflict using the AI router.
 *
 * @param {Object} candidate - A candidate from findCandidateConflicts()
 * @returns {Promise<Object|null>} Verified conflict object or null if not a real conflict
 */
async function verifySingleCandidate(candidate) {
  const systemPrompt = buildVerificationSystemPrompt();
  const userPrompt = buildVerificationUserPrompt(candidate);

  try {
    const result = await complete(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      { temperature: 0.2, maxTokens: 1000, jsonMode: true }
    );

    const parsed = JSON.parse(result.content);
    const tokensUsed = result.usage?.total_tokens || 0;

    // Only persist if the AI confirms it is a conflict above the confidence threshold
    if (!parsed.isConflict || parsed.confidenceScore < AI_CONFIDENCE_THRESHOLD) {
      return null;
    }

    return {
      id: generateId(),
      type: parsed.type || 'approach_conflict',
      severity: parsed.severity || 'medium',
      status: 'open',

      olderSummaryId: candidate.olderSummaryId,
      newerSummaryId: candidate.newerSummaryId,
      olderTopicId: candidate.olderTopicId,
      newerTopicId: candidate.newerTopicId,

      olderContent: candidate.olderContent,
      newerContent: candidate.newerContent,

      analysis: parsed.analysis || '',
      recommendation: parsed.recommendation || '',

      resolvedAt: null,
      resolution: null,
      resolutionNote: null,

      detectedAt: new Date().toISOString(),
      metadata: {
        modelUsed: result.model,
        providerUsed: result.providerType,
        confidenceScore: parsed.confidenceScore,
        heuristicScore: candidate.heuristicScore,
        tokensUsed,
        signals: candidate.signals
      }
    };
  } catch (err) {
    console.error('[Conflicts] Failed to verify candidate:', err);
    return null;
  }
}

/**
 * Use AI to verify whether heuristic candidate conflicts are genuine.
 *
 * Candidates are processed in batches of up to {@link MAX_CONCURRENT_AI_REQUESTS}
 * concurrent requests to respect rate limits and avoid excessive parallelism.
 *
 * @param {Array} candidates - Candidate array from {@link findCandidateConflicts}
 * @param {Object} [options={}]
 * @param {number} [options.maxCandidates=20] - Max candidates to verify
 * @returns {Promise<Array<Object>>} Array of verified conflict objects
 */
export async function verifyConflicts(candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];

  const hasProvider = await hasEnabledProvider();
  if (!hasProvider) {
    console.warn('[Conflicts] No AI provider configured — skipping AI verification');
    return [];
  }

  const maxCandidates = options.maxCandidates || 20;

  // Take top candidates by heuristic score
  const toVerify = candidates.slice(0, maxCandidates);
  const verified = [];

  // Process in batches to respect rate limits
  for (let i = 0; i < toVerify.length; i += MAX_CONCURRENT_AI_REQUESTS) {
    const batch = toVerify.slice(i, i + MAX_CONCURRENT_AI_REQUESTS);
    const results = await Promise.allSettled(
      batch.map(candidate => verifySingleCandidate(candidate))
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        verified.push(result.value);
      }
    }
  }

  return verified;
}

// ---------------------------------------------------------------------------
// Single Summary Check (Mode 3)
// ---------------------------------------------------------------------------

/**
 * Check a newly created summary against existing knowledge for conflicts.
 * This is the primary integration point — called after every summarization.
 *
 * Flow:
 * 1. Finds existing summaries that share the same topic or have high tag overlap.
 * 2. Runs heuristic comparison against each.
 * 3. Optionally verifies high-scoring candidates with AI.
 * 4. Stores any confirmed conflicts.
 *
 * @param {Object} summary - The newly created summary record
 * @param {Object} [options={}]
 * @param {boolean} [options.useAI=true] - Whether to use AI verification
 * @returns {Promise<Array<Object>>} Array of detected conflict objects (empty if none found)
 */
export async function checkNewSummary(summary, options = { useAI: true }) {
  if (!summary || !summary.id) {
    console.warn('[Conflicts] checkNewSummary called with invalid summary');
    return [];
  }

  let existingSummaries, topics;
  try {
    [existingSummaries, topics] = await Promise.all([
      dbGetAll('summaries'),
      dbGetAll('topics')
    ]);
  } catch (err) {
    console.error('[Conflicts] Failed to fetch data for new summary check:', err);
    return [];
  }

  if (!existingSummaries || existingSummaries.length === 0) return [];

  // Build topic lookup
  const topicMap = new Map();
  if (topics) {
    for (const topic of topics) {
      topicMap.set(topic.id, topic);
    }
  }

  // Filter to summaries that are comparable to the new one:
  // 1. Same topic
  // 2. Different topic but high tag overlap (> 50%)
  // Exclude the summary itself
  const comparables = existingSummaries.filter(existing => {
    if (existing.id === summary.id) return false;

    // Same topic — always compare
    if (summary.topicId && existing.topicId === summary.topicId) return true;

    // Different topic — compare only if tag overlap > 50%
    const overlap = tagOverlap(summary.tags || [], existing.tags || []);
    return overlap > 0.5;
  });

  if (comparables.length === 0) return [];

  // The new summary is always the "newer" one
  const newSummaryTime = new Date(summary.createdAt).getTime();
  const candidates = [];

  for (const existing of comparables) {
    const existingTime = new Date(existing.createdAt).getTime();
    const older = existingTime <= newSummaryTime ? existing : summary;
    const newer = existingTime <= newSummaryTime ? summary : existing;

    const decisionCandidates = compareDecisions(older, newer);
    const summaryCandidates = compareSummaryLevel(older, newer);

    for (const candidate of [...decisionCandidates, ...summaryCandidates]) {
      if (candidate.score >= HEURISTIC_SCORE_THRESHOLD) {
        candidates.push({
          olderSummaryId: older.id,
          newerSummaryId: newer.id,
          olderTopicId: older.topicId,
          newerTopicId: newer.topicId,
          olderContent: candidate.olderContent,
          newerContent: candidate.newerContent,
          signals: candidate.signals,
          heuristicScore: candidate.score
        });
      }
    }
  }

  if (candidates.length === 0) return [];

  // Deduplicate
  const seen = new Set();
  const deduplicated = candidates.filter(c => {
    const key = `${c.olderSummaryId}|${c.newerSummaryId}|${c.olderContent}|${c.newerContent}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let conflicts = [];

  const hasProvider = options.useAI ? await hasEnabledProvider() : false;

  if (options.useAI && hasProvider) {
    // AI verification
    conflicts = await verifyConflicts(deduplicated, {
      maxCandidates: 10 // Limit for single-summary checks
    });
  } else {
    // No AI — store heuristic-only conflicts for high-confidence candidates
    for (const candidate of deduplicated) {
      if (candidate.heuristicScore >= 0.5) {
        conflicts.push({
          id: generateId(),
          type: 'approach_conflict', // Default; AI would refine this
          severity: candidate.heuristicScore >= 0.7 ? 'high' : 'medium',
          status: 'open',

          olderSummaryId: candidate.olderSummaryId,
          newerSummaryId: candidate.newerSummaryId,
          olderTopicId: candidate.olderTopicId,
          newerTopicId: candidate.newerTopicId,

          olderContent: candidate.olderContent,
          newerContent: candidate.newerContent,

          analysis: `Heuristic analysis detected potential conflict based on: ${candidate.signals.join('; ')}`,
          recommendation: 'Review both items and decide which reflects your current thinking.',

          resolvedAt: null,
          resolution: null,
          resolutionNote: null,

          detectedAt: new Date().toISOString(),
          metadata: {
            modelUsed: null,
            confidenceScore: candidate.heuristicScore,
            heuristicScore: candidate.heuristicScore,
            tokensUsed: 0,
            signals: candidate.signals
          }
        });
      }
    }
  }

  // Persist any conflicts found
  for (const conflict of conflicts) {
    await saveConflict(conflict);
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Conflict Storage
// ---------------------------------------------------------------------------

/**
 * Persist a conflict record to chrome.storage.local.
 * Conflicts are stored as an array under the key `conflicts`.
 *
 * @param {Object} conflict - A complete conflict record matching the schema
 * @returns {Promise<void>}
 */
async function saveConflict(conflict) {
  try {
    const { conflicts = [] } = await chrome.storage.local.get('conflicts');
    conflicts.push(conflict);
    await chrome.storage.local.set({ conflicts });
  } catch (err) {
    console.error('[Conflicts] Failed to save conflict:', err);
    throw err;
  }
}

/**
 * Update an existing conflict in chrome.storage.local by ID.
 *
 * @param {string} conflictId - The conflict's unique ID
 * @param {Object} updates - Fields to merge into the conflict record
 * @returns {Promise<Object|null>} The updated conflict, or null if not found
 */
async function updateConflict(conflictId, updates) {
  try {
    const { conflicts = [] } = await chrome.storage.local.get('conflicts');
    const index = conflicts.findIndex(c => c.id === conflictId);

    if (index === -1) {
      console.warn(`[Conflicts] Conflict not found: ${conflictId}`);
      return null;
    }

    conflicts[index] = { ...conflicts[index], ...updates };
    await chrome.storage.local.set({ conflicts });
    return conflicts[index];
  } catch (err) {
    console.error('[Conflicts] Failed to update conflict:', err);
    throw err;
  }
}

/**
 * Retrieve all conflicts from chrome.storage.local.
 *
 * @returns {Promise<Array<Object>>} All stored conflict records
 */
async function getAllConflicts() {
  try {
    const { conflicts = [] } = await chrome.storage.local.get('conflicts');
    return conflicts;
  } catch (err) {
    console.error('[Conflicts] Failed to retrieve conflicts:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public Query & Management API
// ---------------------------------------------------------------------------

/**
 * Get all open (unresolved, non-dismissed) conflicts.
 *
 * @returns {Promise<Array<Object>>} Conflicts with status === 'open',
 *   sorted by severity (high first) then by detection date (newest first)
 */
export async function getOpenConflicts() {
  const all = await getAllConflicts();

  const open = all.filter(c => c.status === 'open');

  // Sort: high severity first, then by detectedAt descending
  const severityOrder = { high: 0, medium: 1, low: 2 };
  open.sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (sevDiff !== 0) return sevDiff;
    return new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime();
  });

  return open;
}

/**
 * Get all conflicts associated with a specific topic.
 * Matches conflicts where either the older or newer summary belongs to the topic.
 *
 * @param {string} topicId - The topic's unique ID
 * @returns {Promise<Array<Object>>} Matching conflicts sorted by detectedAt descending
 */
export async function getConflictsForTopic(topicId) {
  if (!topicId) return [];

  const all = await getAllConflicts();

  return all
    .filter(c => c.olderTopicId === topicId || c.newerTopicId === topicId)
    .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
}

/**
 * Get all conflicts associated with a specific summary.
 * Matches conflicts where either the older or newer item is the given summary.
 *
 * @param {string} summaryId - The summary's unique ID
 * @returns {Promise<Array<Object>>} Matching conflicts sorted by detectedAt descending
 */
export async function getConflictsForSummary(summaryId) {
  if (!summaryId) return [];

  const all = await getAllConflicts();

  return all
    .filter(c => c.olderSummaryId === summaryId || c.newerSummaryId === summaryId)
    .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
}

/**
 * Resolve a conflict by choosing a resolution strategy.
 *
 * @param {string} conflictId - The conflict's unique ID
 * @param {"keep_newer"|"keep_older"|"keep_both"|"custom"} resolution - Resolution strategy
 * @param {string} [note=''] - Optional human-written resolution note
 * @returns {Promise<Object|null>} The updated conflict record, or null if not found
 */
export async function resolveConflict(conflictId, resolution, note = '') {
  if (!conflictId || !resolution) {
    console.warn('[Conflicts] resolveConflict requires conflictId and resolution');
    return null;
  }

  const validResolutions = ['keep_newer', 'keep_older', 'keep_both', 'custom'];
  if (!validResolutions.includes(resolution)) {
    console.warn(`[Conflicts] Invalid resolution: "${resolution}". Must be one of: ${validResolutions.join(', ')}`);
    return null;
  }

  return updateConflict(conflictId, {
    status: 'resolved',
    resolution,
    resolutionNote: note,
    resolvedAt: new Date().toISOString()
  });
}

/**
 * Dismiss a conflict, marking it as not a real conflict.
 * Dismissed conflicts are hidden from the open list but retained for auditing.
 *
 * @param {string} conflictId - The conflict's unique ID
 * @returns {Promise<Object|null>} The updated conflict record, or null if not found
 */
export async function dismissConflict(conflictId) {
  if (!conflictId) {
    console.warn('[Conflicts] dismissConflict requires a conflictId');
    return null;
  }

  return updateConflict(conflictId, {
    status: 'dismissed',
    resolvedAt: new Date().toISOString()
  });
}

/**
 * Get aggregate statistics about conflicts in the knowledge base.
 *
 * @returns {Promise<{
 *   total: number,
 *   open: number,
 *   resolved: number,
 *   dismissed: number,
 *   highSeverity: number,
 *   mediumSeverity: number,
 *   lowSeverity: number
 * }>}
 */
export async function getConflictStats() {
  const all = await getAllConflicts();

  return {
    total: all.length,
    open: all.filter(c => c.status === 'open').length,
    resolved: all.filter(c => c.status === 'resolved').length,
    dismissed: all.filter(c => c.status === 'dismissed').length,
    highSeverity: all.filter(c => c.severity === 'high').length,
    mediumSeverity: all.filter(c => c.severity === 'medium').length,
    lowSeverity: all.filter(c => c.severity === 'low').length
  };
}

// ---------------------------------------------------------------------------
// Full Scan (Orchestrator)
// ---------------------------------------------------------------------------

/**
 * Run a comprehensive conflict scan across the entire knowledge base.
 *
 * Steps:
 * 1. Find heuristic candidates (fast, free)
 * 2. Filter out candidates that duplicate already-known conflicts
 * 3. Verify remaining candidates with AI (if API key provided)
 * 4. Store all confirmed conflicts
 *
 * @param {Object} [options={}]
 * @param {number} [options.maxCandidates=20] - Max candidates to send to AI
 * @param {number} [options.heuristicThreshold=0.3] - Min heuristic score to consider
 * @returns {Promise<{found: number, verified: number, conflicts: Array<Object>}>}
 *   Summary of scan results
 */
export async function runFullScan(options = {}) {
  const {
    maxCandidates = 20,
    heuristicThreshold = HEURISTIC_SCORE_THRESHOLD
  } = options;

  console.log('[Conflicts] Starting full conflict scan...');

  // Step 1: Heuristic discovery
  const candidates = await findCandidateConflicts();
  const filteredCandidates = candidates.filter(c => c.heuristicScore >= heuristicThreshold);

  console.log(`[Conflicts] Found ${filteredCandidates.length} heuristic candidates (from ${candidates.length} total pairs)`);

  if (filteredCandidates.length === 0) {
    return { found: 0, verified: 0, conflicts: [] };
  }

  // Step 2: Filter out candidates that match already-known conflicts
  const existingConflicts = await getAllConflicts();
  const existingKeys = new Set(
    existingConflicts.map(c =>
      `${c.olderSummaryId}|${c.newerSummaryId}|${c.olderContent}|${c.newerContent}`
    )
  );

  const newCandidates = filteredCandidates.filter(c => {
    const key = `${c.olderSummaryId}|${c.newerSummaryId}|${c.olderContent}|${c.newerContent}`;
    return !existingKeys.has(key);
  });

  console.log(`[Conflicts] ${newCandidates.length} new candidates after deduplication against existing conflicts`);

  if (newCandidates.length === 0) {
    return { found: filteredCandidates.length, verified: 0, conflicts: [] };
  }

  // Step 3: Verify with AI or store heuristic-only
  let verifiedConflicts = [];
  const hasProvider = await hasEnabledProvider();

  if (hasProvider) {
    verifiedConflicts = await verifyConflicts(newCandidates, {
      maxCandidates
    });
  } else {
    // No API key — store high-confidence heuristic-only conflicts
    for (const candidate of newCandidates) {
      if (candidate.heuristicScore >= 0.5) {
        verifiedConflicts.push({
          id: generateId(),
          type: 'approach_conflict',
          severity: candidate.heuristicScore >= 0.7 ? 'high' : 'medium',
          status: 'open',

          olderSummaryId: candidate.olderSummaryId,
          newerSummaryId: candidate.newerSummaryId,
          olderTopicId: candidate.olderTopicId,
          newerTopicId: candidate.newerTopicId,

          olderContent: candidate.olderContent,
          newerContent: candidate.newerContent,

          analysis: `Heuristic analysis detected potential conflict based on: ${candidate.signals.join('; ')}`,
          recommendation: 'Review both items and decide which reflects your current thinking.',

          resolvedAt: null,
          resolution: null,
          resolutionNote: null,

          detectedAt: new Date().toISOString(),
          metadata: {
            modelUsed: null,
            confidenceScore: candidate.heuristicScore,
            heuristicScore: candidate.heuristicScore,
            tokensUsed: 0,
            signals: candidate.signals
          }
        });
      }
    }
  }

  // Step 4: Store verified conflicts
  for (const conflict of verifiedConflicts) {
    await saveConflict(conflict);
  }

  console.log(`[Conflicts] Full scan complete: ${verifiedConflicts.length} conflicts stored`);

  return {
    found: filteredCandidates.length,
    verified: verifiedConflicts.length,
    conflicts: verifiedConflicts
  };
}
