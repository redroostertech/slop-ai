import { dbGetAll, dbGet, dbGetByIndex } from './db.js';
import { isModelLoaded, embed, cosineSimilarity } from './embeddings.js';

/**
 * Common English stopwords to exclude from tokenization.
 * Kept minimal to avoid over-filtering domain-specific terms.
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
 * Scoring weight constants for the relevance algorithm.
 * Tuned so tag matches are strongest (most intentional metadata),
 * followed by insights (distilled knowledge), then title (summary).
 */
const WEIGHTS = {
  TAG_MATCH: 3.0,
  TITLE_MATCH: 2.0,
  INSIGHT_MATCH: 1.5,
  DECISION_MATCH: 1.2,
  SUMMARY_MATCH: 0.5,
  RECENCY_MAX_BOOST: 0.3,
  USAGE_BOOST_PER_USE: 0.1,
  USAGE_BOOST_CAP: 0.5
};

/** Number of days over which recency decays to zero. */
const RECENCY_DECAY_DAYS = 90;

/**
 * Tokenize text into lowercase words, removing stopwords and short tokens.
 * Handles hyphenated words, camelCase splitting, and punctuation stripping.
 * @param {string} text
 * @returns {string[]} Array of unique meaningful tokens
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  // Split camelCase before lowercasing
  const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  const words = expanded
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, ' ')
    .split(/[\s\-]+/)
    .filter(w => w.length >= 2 && !STOPWORDS.has(w));

  // Deduplicate while preserving order
  return [...new Set(words)];
}

/**
 * Build a term frequency map from an array of tokens.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  return tf;
}

/**
 * Calculate the overlap score between context tokens and a set of candidate strings.
 * Uses term frequency weighting: words that appear more in context matter more.
 * @param {Map<string, number>} contextTF - Term frequency of context tokens
 * @param {string[]} contextTokens - Unique context tokens
 * @param {string[]} candidateStrings - Array of strings to check against (tags, insights, etc.)
 * @returns {{ score: number, matched: string[] }}
 */
function overlapScore(contextTF, contextTokens, candidateStrings) {
  if (!candidateStrings || candidateStrings.length === 0) {
    return { score: 0, matched: [] };
  }

  const candidateTokens = new Set();
  const candidateOriginals = new Map(); // token -> original string for display

  for (const str of candidateStrings) {
    const tokens = tokenize(str);
    for (const t of tokens) {
      candidateTokens.add(t);
      if (!candidateOriginals.has(t)) {
        candidateOriginals.set(t, str);
      }
    }
  }

  let score = 0;
  const matched = new Set();

  for (const token of contextTokens) {
    if (candidateTokens.has(token)) {
      // Weight by how many times the token appears in context
      const freq = contextTF.get(token) || 1;
      score += Math.log2(1 + freq);
      const orig = candidateOriginals.get(token);
      if (orig) matched.add(orig);
    }
  }

  // Normalize by the number of candidate tokens to avoid bias toward large items
  if (candidateTokens.size > 0) {
    score = score / Math.sqrt(candidateTokens.size);
  }

  return { score, matched: [...matched] };
}

/**
 * Calculate recency boost for a summary.
 * Returns a value between 0 and RECENCY_MAX_BOOST.
 * @param {string} createdAt - ISO date string
 * @returns {number}
 */
function recencyBoost(createdAt) {
  if (!createdAt) return 0;

  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < 0) return WEIGHTS.RECENCY_MAX_BOOST; // future date (clock skew)
  if (ageDays > RECENCY_DECAY_DAYS) return 0;

  // Linear decay over RECENCY_DECAY_DAYS
  return WEIGHTS.RECENCY_MAX_BOOST * (1 - ageDays / RECENCY_DECAY_DAYS);
}

/**
 * Calculate usage popularity boost.
 * @param {number|undefined} usageCount
 * @returns {number}
 */
function usageBoost(usageCount) {
  if (!usageCount || usageCount <= 0) return 0;
  return Math.min(usageCount * WEIGHTS.USAGE_BOOST_PER_USE, WEIGHTS.USAGE_BOOST_CAP);
}

/**
 * Build a human-readable reason string explaining why this result was relevant.
 * @param {Object} matchDetails
 * @returns {string}
 */
function buildReason(matchDetails) {
  const parts = [];

  if (matchDetails.tagMatches.length > 0) {
    parts.push(`Matched tags: ${matchDetails.tagMatches.slice(0, 5).join(', ')}`);
  }
  if (matchDetails.titleMatches.length > 0) {
    parts.push(`Title keywords: ${matchDetails.titleMatches.slice(0, 3).join(', ')}`);
  }
  if (matchDetails.insightMatches.length > 0) {
    parts.push(`Insight match: ${matchDetails.insightMatches.slice(0, 2).join(', ')}`);
  }
  if (matchDetails.decisionMatches.length > 0) {
    parts.push(`Decision match: ${matchDetails.decisionMatches.slice(0, 2).join(', ')}`);
  }
  if (matchDetails.hasRecencyBoost) {
    parts.push('Recent');
  }
  if (matchDetails.hasUsageBoost) {
    parts.push('Frequently used');
  }
  if (matchDetails.hasEmbeddingScore) {
    parts.push('Semantic match');
  }

  return parts.length > 0 ? parts.join(' | ') : 'General relevance';
}

/**
 * Find relevant knowledge for the given context text.
 * Searches all summaries in IndexedDB and scores them against the context
 * using a TF-IDF-like algorithm with tag, title, insight, and decision overlap,
 * plus recency and usage boosts.
 *
 * @param {string} contextText - The current conversation/user input on the AI site
 * @param {Object} [options={}]
 * @param {number} [options.maxResults=5] - Maximum number of results to return
 * @param {number} [options.minScore=0.1] - Minimum relevance score threshold
 * @returns {Promise<Array<{summary: Object, topic: Object|null, score: number, reason: string}>>}
 */
export async function findRelevantKnowledge(contextText, options = {}) {
  const { maxResults = 5, minScore = 0.1 } = options;

  if (!contextText || typeof contextText !== 'string' || contextText.trim().length === 0) {
    return [];
  }

  const contextTokens = tokenize(contextText);
  if (contextTokens.length === 0) return [];

  const contextTF = termFrequency(contextTokens);

  // Fetch all summaries, topics, and conversations
  let summaries, topics, conversations;
  try {
    [summaries, topics, conversations] = await Promise.all([
      dbGetAll('summaries'),
      dbGetAll('topics'),
      dbGetAll('conversations')
    ]);
  } catch (err) {
    console.error('[AI Context Bridge] Failed to fetch data for relevance scoring:', err);
    return [];
  }

  if ((!summaries || summaries.length === 0) && (!conversations || conversations.length === 0)) return [];

  // Build topic lookup map
  const topicMap = new Map();
  if (topics) {
    for (const topic of topics) {
      topicMap.set(topic.id, topic);
    }
  }

  // Check if embeddings are available for hybrid scoring
  const useEmbeddings = isModelLoaded();
  let contextVector = null;
  let embeddingMap = new Map(); // summaryId -> vector
  let convEmbeddingMap = new Map(); // conversationId -> vector

  if (useEmbeddings) {
    try {
      const [contextVectors] = await Promise.all([
        embed([contextText]),
        (async () => {
          const allEmbeddings = await dbGetAll('embeddings');
          for (const emb of allEmbeddings) {
            if (emb.type === 'conversation' && emb.conversationId) {
              convEmbeddingMap.set(emb.conversationId, emb.vector);
            } else if (emb.summaryId) {
              embeddingMap.set(emb.summaryId, emb.vector);
            }
          }
        })()
      ]);
      contextVector = contextVectors[0];
    } catch {
      // Embeddings failed — fall back to keyword only
    }
  }

  // Score each summary
  const scored = [];

  for (const summary of summaries) {
    const matchDetails = {
      tagMatches: [],
      titleMatches: [],
      insightMatches: [],
      decisionMatches: [],
      hasRecencyBoost: false,
      hasUsageBoost: false,
      hasEmbeddingScore: false
    };

    // 1. Tag overlap (strongest signal -- tags are curated metadata)
    const tagResult = overlapScore(contextTF, contextTokens, summary.tags || []);
    const tagScore = tagResult.score * WEIGHTS.TAG_MATCH;
    matchDetails.tagMatches = tagResult.matched;

    // 2. Title keyword overlap
    const titleResult = overlapScore(contextTF, contextTokens, [summary.title || '']);
    const titleScore = titleResult.score * WEIGHTS.TITLE_MATCH;
    matchDetails.titleMatches = titleResult.matched;

    // 3. Key insights keyword overlap
    const insightResult = overlapScore(contextTF, contextTokens, summary.keyInsights || []);
    const insightScore = insightResult.score * WEIGHTS.INSIGHT_MATCH;
    matchDetails.insightMatches = insightResult.matched;

    // 4. Decisions keyword overlap
    const decisionResult = overlapScore(contextTF, contextTokens, summary.decisions || []);
    const decisionScore = decisionResult.score * WEIGHTS.DECISION_MATCH;
    matchDetails.decisionMatches = decisionResult.matched;

    // 5. Summary body match (low weight to avoid noise from long text)
    const summaryTokens = tokenize(summary.summary || '');
    let summaryBodyScore = 0;
    if (summaryTokens.length > 0) {
      const summarySet = new Set(summaryTokens);
      let bodyMatches = 0;
      for (const token of contextTokens) {
        if (summarySet.has(token)) bodyMatches++;
      }
      summaryBodyScore = (bodyMatches / Math.sqrt(summaryTokens.length)) * WEIGHTS.SUMMARY_MATCH;
    }

    // 6. Recency boost
    const recency = recencyBoost(summary.createdAt);
    matchDetails.hasRecencyBoost = recency > 0.05;

    // 7. Usage boost
    const usage = usageBoost(summary.usageCount);
    matchDetails.hasUsageBoost = usage > 0;

    // Combine keyword scores
    const keywordScore = tagScore + titleScore + insightScore + decisionScore + summaryBodyScore;

    // 8. Embedding similarity (hybrid scoring)
    let totalScore;
    if (contextVector && embeddingMap.has(summary.id)) {
      const embSimilarity = cosineSimilarity(contextVector, embeddingMap.get(summary.id));
      // Hybrid: 70% embedding, 30% keyword + boosts
      totalScore = (embSimilarity * 0.7) + (keywordScore * 0.3) + recency + usage;
      matchDetails.hasEmbeddingScore = true;
    } else {
      // Keyword-only fallback
      totalScore = keywordScore + recency + usage;
    }

    if (totalScore >= minScore) {
      const topic = summary.topicId ? (topicMap.get(summary.topicId) || null) : null;

      scored.push({
        summary,
        topic,
        score: Math.round(totalScore * 1000) / 1000, // 3 decimal places
        reason: buildReason(matchDetails)
      });
    }
  }

  // Score unsummarized conversations
  if (conversations && conversations.length > 0) {
    const summarizedConvIds = new Set((summaries || []).map(s => s.conversationId));

    for (const conv of conversations) {
      if (summarizedConvIds.has(conv.id)) continue; // already covered by summary

      // Title keyword match
      const titleResult = overlapScore(contextTF, contextTokens, [conv.title || '']);
      const titleScore = titleResult.score * WEIGHTS.TITLE_MATCH;

      // Recency boost
      const recency = recencyBoost(conv.updatedAt || conv.createdAt);

      let totalScore;
      const hasEmbeddingScore = contextVector && convEmbeddingMap.has(conv.id);

      if (hasEmbeddingScore) {
        const embSimilarity = cosineSimilarity(contextVector, convEmbeddingMap.get(conv.id));
        totalScore = (embSimilarity * 0.7) + (titleScore * 0.3) + recency;
      } else {
        totalScore = titleScore + recency;
      }

      if (totalScore >= minScore) {
        const reasonParts = [];
        if (titleResult.matched.length > 0) reasonParts.push(`Title keywords: ${titleResult.matched.slice(0, 3).join(', ')}`);
        if (recency > 0.05) reasonParts.push('Recent');
        if (hasEmbeddingScore) reasonParts.push('Semantic match');

        scored.push({
          summary: {
            id: conv.id,
            title: conv.title,
            createdAt: conv.createdAt,
            source: conv.source,
            messageCount: conv.messageCount,
            messages: conv.messages,
          },
          topic: null,
          score: Math.round(totalScore * 1000) / 1000,
          reason: reasonParts.length > 0 ? reasonParts.join(' | ') : 'General relevance',
          type: 'conversation',
        });
      }
    }
  }

  // Sort by score descending, then by recency for tie-breaking
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 0.001) {
      // Tie-break by creation date (newer first)
      const aTime = new Date(a.summary.createdAt || 0).getTime();
      const bTime = new Date(b.summary.createdAt || 0).getTime();
      return bTime - aTime;
    }
    return b.score - a.score;
  });

  return scored.slice(0, maxResults);
}

/**
 * Search knowledge base by a manual query string.
 * Similar to findRelevantKnowledge but with lower minimum score threshold
 * for broader results in manual search.
 *
 * @param {string} query - User's search query
 * @param {Object} [options={}]
 * @param {number} [options.maxResults=10]
 * @returns {Promise<Array<{summary: Object, topic: Object|null, score: number, reason: string}>>}
 */
export async function searchKnowledge(query, options = {}) {
  return findRelevantKnowledge(query, {
    maxResults: options.maxResults || 10,
    minScore: 0.05 // Lower threshold for manual searches
  });
}
