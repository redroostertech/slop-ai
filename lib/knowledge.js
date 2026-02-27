import { dbPut, dbGet, dbGetAll, dbGetByIndex, dbDelete } from './db.js';
import { generateId } from './utils.js';
import { isModelLoaded, embed, cosineSimilarity } from './embeddings.js';

export async function assignToTopic(summary, options = {}) {
  const { forceTopicId } = options;
  const suggestedName = summary.suggestedTopicName || 'General';

  let topic = null;
  if (forceTopicId) {
    topic = await dbGet('topics', forceTopicId);
  }
  if (!topic) {
    topic = await findSimilarTopic(suggestedName);
  }

  if (!topic) {
    topic = {
      id: generateId(),
      name: suggestedName,
      description: '',
      parentTopicId: null,
      summaryIds: [],
      tags: (summary.tags || []).slice(0, 5),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  summary.topicId = topic.id;

  if (!topic.summaryIds.includes(summary.id)) {
    topic.summaryIds.push(summary.id);
  }

  // Merge tags
  const tagSet = new Set([...topic.tags, ...(summary.tags || [])]);
  topic.tags = [...tagSet].slice(0, 20);
  topic.updatedAt = new Date().toISOString();

  await dbPut('summaries', summary);
  await dbPut('topics', topic);

  return topic;
}

async function findSimilarTopic(name) {
  const allTopics = await dbGetAll('topics');
  const normalized = name.toLowerCase().trim();

  // Exact match
  const exact = allTopics.find(t => t.name.toLowerCase().trim() === normalized);
  if (exact) return exact;

  // Substring match
  for (const topic of allTopics) {
    const tn = topic.name.toLowerCase().trim();
    if (tn.includes(normalized) || normalized.includes(tn)) return topic;
  }

  // Levenshtein distance for close matches
  for (const topic of allTopics) {
    const tn = topic.name.toLowerCase().trim();
    if (levenshtein(tn, normalized) <= 4) return topic;
  }

  // Embedding-based fallback: compare name against topic embeddings
  if (isModelLoaded() && allTopics.length > 0) {
    try {
      const allEmbeddings = await dbGetAll('embeddings');
      if (allEmbeddings.length > 0) {
        // Build topic aggregate vectors (average of summary vectors in topic)
        const topicVectors = new Map();
        const topicSummaryCounts = new Map();

        for (const emb of allEmbeddings) {
          // Find which topic this summary belongs to
          const summary = await dbGet('summaries', emb.summaryId);
          if (!summary?.topicId) continue;

          if (!topicVectors.has(summary.topicId)) {
            topicVectors.set(summary.topicId, new Array(emb.vector.length).fill(0));
            topicSummaryCounts.set(summary.topicId, 0);
          }

          const vec = topicVectors.get(summary.topicId);
          for (let i = 0; i < emb.vector.length; i++) {
            vec[i] += emb.vector[i];
          }
          topicSummaryCounts.set(summary.topicId, topicSummaryCounts.get(summary.topicId) + 1);
        }

        // Normalize topic vectors to averages
        for (const [topicId, vec] of topicVectors) {
          const count = topicSummaryCounts.get(topicId);
          for (let i = 0; i < vec.length; i++) {
            vec[i] /= count;
          }
        }

        // Embed the query name
        const [nameVector] = await embed([name]);
        let bestTopic = null;
        let bestSim = 0;

        for (const [topicId, vec] of topicVectors) {
          const sim = cosineSimilarity(nameVector, vec);
          if (sim > bestSim) {
            bestSim = sim;
            bestTopic = allTopics.find(t => t.id === topicId);
          }
        }

        if (bestTopic && bestSim > 0.75) {
          return bestTopic;
        }
      }
    } catch {
      // Embedding fallback failed — return null to create new topic
    }
  }

  return null;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export async function getAllTopicsWithCounts() {
  const topics = await dbGetAll('topics');
  return topics.map(t => ({
    ...t,
    summaryCount: t.summaryIds?.length || 0
  })).sort((a, b) => b.summaryCount - a.summaryCount);
}

export async function getTopicDetail(topicId) {
  const topic = await dbGet('topics', topicId);
  if (!topic) return null;

  const summaries = [];
  for (const sid of (topic.summaryIds || [])) {
    const s = await dbGet('summaries', sid);
    if (s) summaries.push(s);
  }

  return { topic, summaries };
}

export async function renameTopic(topicId, newName) {
  const topic = await dbGet('topics', topicId);
  if (!topic) return;
  topic.name = newName;
  topic.updatedAt = new Date().toISOString();
  await dbPut('topics', topic);
}

export async function deleteTopic(topicId) {
  const topic = await dbGet('topics', topicId);
  if (!topic) return;

  // Unlink summaries (set topicId to null)
  for (const sid of (topic.summaryIds || [])) {
    const s = await dbGet('summaries', sid);
    if (s) {
      s.topicId = null;
      await dbPut('summaries', s);
    }
  }

  await dbDelete('topics', topicId);
}

export async function mergeTopics(keepId, mergeId) {
  const keep = await dbGet('topics', keepId);
  const merge = await dbGet('topics', mergeId);
  if (!keep || !merge) return;

  // Move summaries
  for (const sid of (merge.summaryIds || [])) {
    const s = await dbGet('summaries', sid);
    if (s) {
      s.topicId = keepId;
      await dbPut('summaries', s);
    }
    if (!keep.summaryIds.includes(sid)) {
      keep.summaryIds.push(sid);
    }
  }

  // Merge tags
  const tagSet = new Set([...keep.tags, ...merge.tags]);
  keep.tags = [...tagSet].slice(0, 20);
  keep.updatedAt = new Date().toISOString();

  await dbPut('topics', keep);
  await dbDelete('topics', mergeId);
}
