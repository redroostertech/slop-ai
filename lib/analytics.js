/**
 * Analytics Service — lib/analytics.js
 *
 * Aggregates raw usage events from the tracker (lib/tracker.js) into
 * actionable insights: usefulness scores, trending topics, stale knowledge
 * detection, timeline charts, and an overall "knowledge health" metric.
 *
 * All heavy computation is cached with a configurable TTL so repeated
 * queries from the sidepanel dashboard are fast.
 *
 * Integration Points:
 *   - Sidepanel dashboard (sidepanel/sidepanel.js) renders the Knowledge
 *     Health card, trending items, and stale-knowledge warnings using data
 *     from this module.
 *   - Agent 2's relevance engine (lib/relevance.js) calls
 *     getSummaryScores() to boost frequently-used items in search results.
 *   - Agent 4's conflict detection (lib/conflicts.js) can call
 *     getSummaryScores() to prioritise checking high-value knowledge first.
 *
 * ES Module — all exports are named.
 */

import { getAllUsageEvents } from './tracker.js';
import { dbGetAll, dbGet } from './db.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long (ms) cached analytics results stay valid before being
 * recomputed on the next access.
 */
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Scoring weights — higher numbers mean the action is more valuable.
 *
 *   inject     (10) — user actively chose to send this knowledge to an AI
 *   copy       ( 8) — user wanted this content enough to copy it
 *   export     ( 5) — medium value — part of a bulk action
 *   view       ( 1) — low value — could be casual browsing
 *   search_hit (0.5) — minimal — the item merely appeared in a result list
 */
const SCORE_WEIGHTS = {
  inject: 10,
  copy: 8,
  export: 5,
  view: 1,
  search_hit: 0.5,
};

/** Number of days over which the recency multiplier decays from 1.0 to 0.3. */
const RECENCY_DECAY_DAYS = 90;

/** Minimum recency multiplier (events older than RECENCY_DECAY_DAYS). */
const RECENCY_FLOOR = 0.3;

// ---------------------------------------------------------------------------
// Cache infrastructure
// ---------------------------------------------------------------------------

/**
 * Simple in-memory cache keyed by string.  Each entry has a timestamp so
 * we can evict stale data.
 *
 * @type {Map<string, { data: any, timestamp: number }>}
 */
const _cache = new Map();

/**
 * Retrieve a value from the cache if it exists and is not expired.
 *
 * @param {string} key
 * @returns {any | undefined}
 */
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * Store a value in the cache.
 *
 * @param {string} key
 * @param {any}    data
 */
function cacheSet(key, data) {
  _cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Invalidate the entire analytics cache.
 *
 * Useful after a batch of new tracking events are flushed or when the user
 * triggers a manual refresh.
 */
export function invalidateCache() {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the recency multiplier for a given timestamp.
 *
 * Returns 1.0 for events that happened today and decays linearly to
 * RECENCY_FLOOR over RECENCY_DECAY_DAYS.
 *
 * @param {string} isoTimestamp — ISO 8601 date string
 * @returns {number} Multiplier in the range [RECENCY_FLOOR, 1.0]
 */
function recencyMultiplier(isoTimestamp) {
  const ageMs = Date.now() - new Date(isoTimestamp).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays <= 0) return 1.0;
  if (ageDays >= RECENCY_DECAY_DAYS) return RECENCY_FLOOR;

  // Linear decay from 1.0 to RECENCY_FLOOR over RECENCY_DECAY_DAYS.
  const decay = 1.0 - ((1.0 - RECENCY_FLOOR) * (ageDays / RECENCY_DECAY_DAYS));
  return Math.max(RECENCY_FLOOR, decay);
}

/**
 * Group an array of events by a given key (extracted via `keyFn`).
 *
 * @template T
 * @param {T[]}                items
 * @param {(item: T) => string} keyFn
 * @returns {Map<string, T[]>}
 */
function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key == null) continue; // skip events with no grouping key
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/**
 * Compute the raw (un-normalised) usefulness score for a single summary
 * given its usage events.
 *
 * @param {UsageEvent[]} events
 * @returns {{ rawScore: number, injections: number, views: number, exports: number, copies: number, searchHits: number, lastUsed: string|null }}
 */
function computeRawScore(events) {
  let injections = 0;
  let views = 0;
  let exports = 0;
  let copies = 0;
  let searchHits = 0;
  let lastUsed = null;

  let weightedSum = 0;

  for (const event of events) {
    const weight = SCORE_WEIGHTS[event.type] ?? 0;
    const recency = recencyMultiplier(event.timestamp);
    weightedSum += weight * recency;

    switch (event.type) {
      case 'inject':
        injections++;
        break;
      case 'view':
        views++;
        break;
      case 'export':
        exports++;
        break;
      case 'copy':
        copies++;
        break;
      case 'search_hit':
        searchHits++;
        break;
    }

    if (!lastUsed || event.timestamp > lastUsed) {
      lastUsed = event.timestamp;
    }
  }

  return { rawScore: weightedSum, injections, views, exports, copies, searchHits, lastUsed };
}

// ---------------------------------------------------------------------------
// Public API — Summary Scores
// ---------------------------------------------------------------------------

/**
 * Get a "usefulness score" for every summary that has at least one usage
 * event.  Scores are normalised to 0–100 relative to the highest-scoring
 * summary so they are easy to display in a UI.
 *
 * Scoring algorithm:
 *   rawScore = SUM over events of (typeWeight * recencyMultiplier)
 *   normalisedScore = (rawScore / maxRawScore) * 100   (capped at 100)
 *
 * Integration point:  Agent 2's relevance engine (lib/relevance.js) can
 * use these scores as a boost signal when ranking search results.
 *
 * @returns {Promise<Map<string, SummaryScore>>}
 *
 * @typedef {object} SummaryScore
 * @property {number}      score      — normalised 0–100
 * @property {number}      injections — total injection count
 * @property {number}      views      — total view count
 * @property {number}      exports    — total export count
 * @property {number}      copies     — total copy count
 * @property {number}      searchHits — total search-hit count
 * @property {string|null} lastUsed   — ISO timestamp of last usage
 */
export async function getSummaryScores() {
  const cached = cacheGet('summaryScores');
  if (cached) return cached;

  const events = await getAllUsageEvents();
  const bySummary = groupBy(events, (e) => e.summaryId);

  /** @type {Map<string, SummaryScore>} */
  const scores = new Map();
  let maxRaw = 0;

  // First pass: compute raw scores.
  for (const [summaryId, summaryEvents] of bySummary) {
    const raw = computeRawScore(summaryEvents);
    scores.set(summaryId, /** @type {any} */ (raw));
    if (raw.rawScore > maxRaw) maxRaw = raw.rawScore;
  }

  // Second pass: normalise to 0–100.
  for (const [summaryId, data] of scores) {
    data.score = maxRaw > 0 ? Math.round((data.rawScore / maxRaw) * 100) : 0;
    delete data.rawScore; // internal detail — don't expose
  }

  cacheSet('summaryScores', scores);
  return scores;
}

// ---------------------------------------------------------------------------
// Public API — Top Topics
// ---------------------------------------------------------------------------

/**
 * Get the most valuable topics ranked by the aggregate usage score of
 * their summaries.
 *
 * @param {number} [limit=10] — Maximum number of topics to return.
 * @returns {Promise<TopicRanking[]>}
 *
 * @typedef {object} TopicRanking
 * @property {string}   topicId
 * @property {string}   topicName
 * @property {number}   totalScore   — sum of normalised scores for the topic's summaries
 * @property {number}   summaryCount — how many summaries belong to this topic
 * @property {string[]} topSummaries — IDs of the highest-scoring summaries (up to 5)
 */
export async function getTopTopics(limit = 10) {
  const cached = cacheGet(`topTopics_${limit}`);
  if (cached) return cached;

  const scores = await getSummaryScores();

  // Load all topics to map summaries to their topic.
  let topics;
  try {
    topics = await dbGetAll('topics');
  } catch {
    topics = [];
  }

  // Build a map of topicId -> { totalScore, summaries: [{id, score}] }
  /** @type {Map<string, { topicName: string, totalScore: number, summaries: {id:string, score:number}[] }>} */
  const topicAgg = new Map();

  for (const topic of topics) {
    topicAgg.set(topic.id, {
      topicName: topic.name,
      totalScore: 0,
      summaries: [],
    });
  }

  for (const [summaryId, data] of scores) {
    // We need the summary record to find its topicId.  If the summary's
    // topicId is not in the map, skip it (orphaned data).
    let topicId = null;
    try {
      const summary = await dbGet('summaries', summaryId);
      topicId = summary?.topicId;
    } catch {
      // Ignore — summary may have been deleted.
    }

    if (!topicId || !topicAgg.has(topicId)) continue;

    const agg = topicAgg.get(topicId);
    agg.totalScore += data.score;
    agg.summaries.push({ id: summaryId, score: data.score });
  }

  // Sort summaries within each topic and pick the top 5.
  const result = [];
  for (const [topicId, agg] of topicAgg) {
    agg.summaries.sort((a, b) => b.score - a.score);
    result.push({
      topicId,
      topicName: agg.topicName,
      totalScore: agg.totalScore,
      summaryCount: agg.summaries.length,
      topSummaries: agg.summaries.slice(0, 5).map((s) => s.id),
    });
  }

  // Filter out topics with zero usage
  const withUsage = result.filter(t => t.totalScore > 0);
  withUsage.sort((a, b) => b.totalScore - a.totalScore);
  const trimmed = withUsage.slice(0, limit);

  cacheSet(`topTopics_${limit}`, trimmed);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Public API — Trending Knowledge
// ---------------------------------------------------------------------------

/**
 * Identify knowledge items whose usage is increasing (or decreasing)
 * compared to the prior period.
 *
 * Compares the last `days` to the preceding `days` and labels each summary
 * as 'rising', 'stable', or 'declining'.
 *
 * @param {number} [days=7] — Window size in days.
 * @returns {Promise<TrendingItem[]>}
 *
 * @typedef {object} TrendingItem
 * @property {string} summaryId
 * @property {string} title          — human-readable summary title
 * @property {number} recentUsage    — event count in the recent window
 * @property {number} previousUsage  — event count in the prior window
 * @property {'rising'|'stable'|'declining'} trend
 */
export async function getTrending(days = 7) {
  const cached = cacheGet(`trending_${days}`);
  if (cached) return cached;

  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  const recentStart = new Date(now - days * msPerDay).toISOString();
  const previousStart = new Date(now - 2 * days * msPerDay).toISOString();
  const recentEnd = new Date(now).toISOString();

  const events = await getAllUsageEvents();

  // Bucket events into recent vs previous windows.
  /** @type {Map<string, { recent: number, previous: number }>} */
  const buckets = new Map();

  for (const event of events) {
    const sid = event.summaryId;
    if (!sid) continue;

    if (!buckets.has(sid)) buckets.set(sid, { recent: 0, previous: 0 });
    const bucket = buckets.get(sid);

    if (event.timestamp >= recentStart && event.timestamp <= recentEnd) {
      bucket.recent++;
    } else if (event.timestamp >= previousStart && event.timestamp < recentStart) {
      bucket.previous++;
    }
  }

  // Build result and classify trend.
  const result = [];
  for (const [summaryId, counts] of buckets) {
    // Skip items with zero activity in both windows.
    if (counts.recent === 0 && counts.previous === 0) continue;

    let trend = 'stable';
    if (counts.recent > counts.previous * 1.25) {
      trend = 'rising';
    } else if (counts.recent < counts.previous * 0.75) {
      trend = 'declining';
    }

    // Resolve a human-readable title and conversationId for navigation.
    // Old usage events may have a conversation ID stored as summaryId (bug),
    // so we try multiple lookups: summary → conversation via summary → direct conversation lookup.
    let title = summaryId;
    let conversationId = null;
    try {
      const summary = await dbGet('summaries', summaryId);
      if (summary) {
        title = summary.title || summaryId;
        conversationId = summary.conversationId || null;
        if (!summary.title && summary.conversationId) {
          const conv = await dbGet('conversations', summary.conversationId);
          if (conv?.title) title = conv.title;
        }
      } else {
        // summaryId might actually be a conversation ID (legacy bug)
        const conv = await dbGet('conversations', summaryId);
        if (conv?.title) {
          title = conv.title;
          conversationId = summaryId;
        }
      }
    } catch {
      // Ignore — use the ID as fallback.
    }

    // Skip orphaned events where both summary and conversation are deleted
    if (title === summaryId) continue;

    result.push({
      summaryId,
      conversationId,
      title,
      recentUsage: counts.recent,
      previousUsage: counts.previous,
      trend,
    });
  }

  // Deduplicate by resolved title — merge counts when two summaryIds
  // resolve to the same title (e.g. legacy events referencing the same conversation).
  /** @type {Map<string, typeof result[0]>} */
  const byTitle = new Map();
  for (const item of result) {
    if (byTitle.has(item.title)) {
      const existing = byTitle.get(item.title);
      existing.recentUsage += item.recentUsage;
      existing.previousUsage += item.previousUsage;
      // Keep the conversationId if the existing one is missing
      if (!existing.conversationId) existing.conversationId = item.conversationId;
    } else {
      byTitle.set(item.title, { ...item });
    }
  }

  // Re-classify trend after merging counts
  const deduped = [...byTitle.values()].map(item => {
    let trend = 'stable';
    if (item.recentUsage > item.previousUsage * 1.25) trend = 'rising';
    else if (item.recentUsage < item.previousUsage * 0.75) trend = 'declining';
    return { ...item, trend };
  });

  // Sort by recent usage descending, then by trend (rising first).
  const trendOrder = { rising: 0, stable: 1, declining: 2 };
  deduped.sort(
    (a, b) =>
      trendOrder[a.trend] - trendOrder[b.trend] ||
      b.recentUsage - a.recentUsage,
  );

  cacheSet(`trending_${days}`, deduped);
  return deduped;
}

// ---------------------------------------------------------------------------
// Public API — Stale Knowledge
// ---------------------------------------------------------------------------

/**
 * Find knowledge items that have not been used recently and may be
 * candidates for archival or review.
 *
 * A summary is considered stale if its most recent usage event is older
 * than `daysThreshold` days ago, OR if it has never been used at all.
 *
 * @param {number} [daysThreshold=30] — Days since last use before
 *   considering an item stale.
 * @returns {Promise<StaleItem[]>}
 *
 * @typedef {object} StaleItem
 * @property {string}      summaryId
 * @property {string}      title       — human-readable summary title
 * @property {string|null} lastUsed    — ISO timestamp or null if never used
 * @property {number}      daysSinceUse — days since last usage (Infinity if never used)
 */
export async function getStale(daysThreshold = 30) {
  const cached = cacheGet(`stale_${daysThreshold}`);
  if (cached) return cached;

  const scores = await getSummaryScores();

  // Also load all summaries to find ones with ZERO usage events.
  let allSummaries;
  try {
    allSummaries = await dbGetAll('summaries');
  } catch {
    allSummaries = [];
  }

  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  const result = [];

  // Set of summaryIds that have at least one event.
  const usedIds = new Set(scores.keys());

  for (const summary of allSummaries) {
    const scoreData = scores.get(summary.id);
    let lastUsed = scoreData?.lastUsed || null;
    let daysSinceUse = Infinity;

    if (lastUsed) {
      daysSinceUse = (now - new Date(lastUsed).getTime()) / msPerDay;
    }

    if (daysSinceUse >= daysThreshold) {
      result.push({
        summaryId: summary.id,
        conversationId: summary.conversationId || null,
        title: summary.title || summary.id,
        lastUsed,
        daysSinceUse: lastUsed ? Math.round(daysSinceUse) : Infinity,
      });
    }
  }

  // Sort: never-used first, then by most stale.
  result.sort((a, b) => b.daysSinceUse - a.daysSinceUse);

  cacheSet(`stale_${daysThreshold}`, result);
  return result;
}

// ---------------------------------------------------------------------------
// Public API — Usage Timeline
// ---------------------------------------------------------------------------

/**
 * Get daily usage counts over a period.  Useful for charting a usage
 * timeline in the sidepanel dashboard.
 *
 * @param {number} [days=30] — Number of days of history to return.
 * @returns {Promise<TimelineEntry[]>}
 *
 * @typedef {object} TimelineEntry
 * @property {string} date        — 'YYYY-MM-DD'
 * @property {number} injections
 * @property {number} views
 * @property {number} exports
 * @property {number} copies
 * @property {number} searchHits
 * @property {number} total
 */
export async function getUsageTimeline(days = 30) {
  const cached = cacheGet(`timeline_${days}`);
  if (cached) return cached;

  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;

  // Pre-fill all days so the chart never has gaps.
  /** @type {Map<string, TimelineEntry>} */
  const dayMap = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * msPerDay);
    const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
    dayMap.set(key, {
      date: key,
      injections: 0,
      views: 0,
      exports: 0,
      copies: 0,
      searchHits: 0,
      total: 0,
    });
  }

  const startDate = new Date(now.getTime() - days * msPerDay).toISOString();
  const events = await getAllUsageEvents();

  for (const event of events) {
    if (event.timestamp < startDate) continue;

    const dayKey = event.timestamp.slice(0, 10);
    const entry = dayMap.get(dayKey);
    if (!entry) continue; // outside our window

    switch (event.type) {
      case 'inject':
        entry.injections++;
        break;
      case 'view':
        entry.views++;
        break;
      case 'export':
        entry.exports++;
        break;
      case 'copy':
        entry.copies++;
        break;
      case 'search_hit':
        entry.searchHits++;
        break;
    }
    entry.total++;
  }

  const result = [...dayMap.values()];
  cacheSet(`timeline_${days}`, result);
  return result;
}

// ---------------------------------------------------------------------------
// Public API — Usage by Source
// ---------------------------------------------------------------------------

/**
 * Break down usage counts by source system (chatgpt, claude, gemini,
 * copilot, sidepanel).
 *
 * @returns {Promise<Record<string, SourceBreakdown>>}
 *
 * @typedef {object} SourceBreakdown
 * @property {number} injections
 * @property {number} views
 * @property {number} exports
 * @property {number} copies
 * @property {number} searchHits
 * @property {number} total
 */
export async function getUsageBySource() {
  const cached = cacheGet('usageBySource');
  if (cached) return cached;

  const events = await getAllUsageEvents();

  /** @type {Record<string, SourceBreakdown>} */
  const result = {};

  for (const event of events) {
    const src = event.source || 'unknown';
    if (!result[src]) {
      result[src] = {
        injections: 0,
        views: 0,
        exports: 0,
        copies: 0,
        searchHits: 0,
        total: 0,
      };
    }

    const bucket = result[src];
    switch (event.type) {
      case 'inject':
        bucket.injections++;
        break;
      case 'view':
        bucket.views++;
        break;
      case 'export':
        bucket.exports++;
        break;
      case 'copy':
        bucket.copies++;
        break;
      case 'search_hit':
        bucket.searchHits++;
        break;
    }
    bucket.total++;
  }

  cacheSet('usageBySource', result);
  return result;
}

// ---------------------------------------------------------------------------
// Public API — Knowledge Health
// ---------------------------------------------------------------------------

/**
 * Calculate an overall "knowledge health" score for the entire knowledge
 * base.
 *
 * The score (0–100) considers:
 *   - What percentage of summaries have been used at all (40% weight)
 *   - Average usefulness score of used summaries     (30% weight)
 *   - Recency — how recently knowledge was used       (30% weight)
 *
 * Also returns a human-readable recommendation string that the sidepanel
 * can display directly.
 *
 * @returns {Promise<KnowledgeHealth>}
 *
 * @typedef {object} KnowledgeHealth
 * @property {number}      score          — 0–100
 * @property {number}      totalSummaries — total summaries in the knowledge base
 * @property {number}      usedSummaries  — summaries with at least one usage event
 * @property {number}      avgScore       — average normalised score of used summaries
 * @property {string|null} topPerformer   — summaryId of the highest-scoring summary
 * @property {string}      recommendation — actionable advice
 */
export async function getKnowledgeHealth() {
  const cached = cacheGet('knowledgeHealth');
  if (cached) return cached;

  const scores = await getSummaryScores();

  let allSummaries;
  try {
    allSummaries = await dbGetAll('summaries');
  } catch {
    allSummaries = [];
  }

  const totalSummaries = allSummaries.length;
  const usedSummaries = scores.size;

  // Average score of used summaries.
  let totalScore = 0;
  let topPerformer = null;
  let topScore = -1;
  let mostRecentUsage = null;

  for (const [summaryId, data] of scores) {
    totalScore += data.score;
    if (data.score > topScore) {
      topScore = data.score;
      topPerformer = summaryId;
    }
    if (data.lastUsed && (!mostRecentUsage || data.lastUsed > mostRecentUsage)) {
      mostRecentUsage = data.lastUsed;
    }
  }

  const avgScore = usedSummaries > 0 ? Math.round(totalScore / usedSummaries) : 0;

  // --- Component scores ---

  // 1. Coverage: % of summaries that have been used.
  const coverageRatio =
    totalSummaries > 0 ? usedSummaries / totalSummaries : 0;
  const coverageScore = Math.min(100, Math.round(coverageRatio * 100));

  // 2. Quality: average score of used summaries (already 0–100).
  const qualityScore = avgScore;

  // 3. Recency: how recently was ANY knowledge used?
  let recencyScore = 0;
  if (mostRecentUsage) {
    const daysSinceLast =
      (Date.now() - new Date(mostRecentUsage).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLast <= 1) recencyScore = 100;
    else if (daysSinceLast <= 7) recencyScore = 80;
    else if (daysSinceLast <= 14) recencyScore = 60;
    else if (daysSinceLast <= 30) recencyScore = 40;
    else recencyScore = 20;
  }

  // Weighted combination.
  const healthScore = Math.round(
    coverageScore * 0.4 + qualityScore * 0.3 + recencyScore * 0.3,
  );

  // --- Recommendation ---
  let recommendation;
  if (totalSummaries === 0) {
    recommendation =
      'No knowledge captured yet. Start by importing or capturing a conversation.';
  } else if (usedSummaries === 0) {
    recommendation =
      'None of your knowledge has been used yet. Try injecting summaries into your AI chats to get value from your knowledge base.';
  } else if (coverageRatio < 0.2) {
    recommendation =
      'Most of your knowledge is unused. Review and prune low-value items, or try injecting more summaries.';
  } else if (recencyScore < 40) {
    recommendation =
      'Your knowledge base has not been used recently. Check if your summaries are still relevant.';
  } else if (healthScore >= 80) {
    recommendation =
      'Your knowledge base is healthy and actively used. Keep it up!';
  } else if (healthScore >= 50) {
    recommendation =
      'Good usage patterns. Consider reviewing stale items and boosting high-value topics.';
  } else {
    recommendation =
      'There is room for improvement. Try exporting or injecting your best summaries more often.';
  }

  const result = {
    score: healthScore,
    totalSummaries,
    usedSummaries,
    avgScore,
    topPerformer,
    recommendation,
  };

  cacheSet('knowledgeHealth', result);
  return result;
}
