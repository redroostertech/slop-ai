import { processCapture, getActiveCaptures, getCaptureStats } from '../lib/capture.js';
import { findRelevantKnowledge, searchKnowledge } from '../lib/relevance.js';
import { formatForInjection, formatBatchForInjection, formatConversationForInjection } from '../lib/injector.js';
import { trackInjection, trackSearchHit, flush as flushTracker } from '../lib/tracker.js';
import { dbGet, dbGetAll } from '../lib/db.js';

console.log('[AI Context Bridge] Service worker loaded successfully');

// Open side panel on toolbar click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Message router — connects content scripts to lib modules
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AI Context Bridge] Received message:', message.type);
  handleMessage(message, sender).then(result => {
    console.log('[AI Context Bridge] Sending response for:', message.type, result ? 'ok' : 'empty');
    sendResponse(result);
  }).catch(err => {
    console.error('[AI Context Bridge] Message error:', message.type, err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    // ===== Live Capture (Agent 1) =====
    case 'CAPTURE_MESSAGES': {
      const captureResult = await processCapture(message.payload);
      // Broadcast to sidepanel (best-effort, it may not be open)
      if (captureResult.newMessages > 0) {
        try {
          chrome.runtime.sendMessage({
            type: 'CONVERSATION_CAPTURED',
            conversationId: captureResult.conversationId,
          }).catch(() => {});
        } catch { /* sidepanel not open */ }
      }
      return captureResult;
    }

    case 'CAPTURE_CONVERSATION_START':
      return { ok: true };

    case 'CAPTURE_STATUS':
      return {
        active: await getActiveCaptures(),
        stats: await getCaptureStats()
      };

    // ===== Context Injection (Agent 2) =====
    case 'FIND_RELEVANT': {
      console.log('[AI Context Bridge] FIND_RELEVANT context length:', message.contextText?.length);
      const summaries = await dbGetAll('summaries');
      console.log('[AI Context Bridge] Summaries in DB:', summaries?.length || 0);
      const relevant = await findRelevantKnowledge(message.contextText, message.options);
      console.log('[AI Context Bridge] Relevant results:', relevant?.length || 0);
      return { results: relevant };
    }

    case 'SEARCH_KNOWLEDGE':
      const searchResults = await searchKnowledge(message.query, message.options);
      return { results: searchResults };

    case 'FORMAT_INJECTION': {
      const summary = await dbGet('summaries', message.summaryId);
      const topic = message.topicId ? await dbGet('topics', message.topicId) : null;
      if (!summary) return { error: 'Summary not found' };
      const text = formatForInjection(summary, topic, message.targetSystem);
      return { text };
    }

    case 'FORMAT_BATCH_INJECTION': {
      const items = [];
      for (const item of (message.items || [])) {
        const s = await dbGet('summaries', item.summaryId);
        const t = item.topicId ? await dbGet('topics', item.topicId) : null;
        if (s) items.push({ summary: s, topic: t });
      }
      const text = formatBatchForInjection(items, message.targetSystem);
      return { text };
    }

    // ===== Usage Tracking (Agent 3) =====
    case 'INJECT_USED':
      await trackInjection(message.summaryId, message.targetSystem || 'unknown');
      // Increment usageCount on the summary for relevance boosting
      const usedSummary = await dbGet('summaries', message.summaryId);
      if (usedSummary) {
        usedSummary.usageCount = (usedSummary.usageCount || 0) + 1;
        const { dbPut } = await import('../lib/db.js');
        await dbPut('summaries', usedSummary);
      }
      return { ok: true };

    case 'TRACK_SEARCH_HIT':
      await trackSearchHit(message.summaryId, message.searchQuery);
      return { ok: true };

    // ===== Conversation Injection =====
    case 'FORMAT_CONVERSATION_INJECTION': {
      const conv = await dbGet('conversations', message.conversationId);
      if (!conv) return { error: 'Conversation not found' };
      const text = formatConversationForInjection(conv, message.targetSystem);
      return { text };
    }

    // ===== Capture Control =====
    case 'CAPTURE_ENABLE':
    case 'CAPTURE_DISABLE':
      // Relay to content script on the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, message);
      }
      return { ok: true };

    case 'DATA_CHANGED': {
      // Broadcast to all tabs so content scripts can refresh
      const allTabs = await chrome.tabs.query({});
      for (const t of allTabs) {
        try {
          chrome.tabs.sendMessage(t.id, { type: 'DATA_CHANGED' }).catch(() => {});
        } catch { /* tab may not have content script */ }
      }
      return { ok: true };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// Flush tracker data before service worker suspends
chrome.runtime.onSuspend?.addListener(() => {
  flushTracker();
});
