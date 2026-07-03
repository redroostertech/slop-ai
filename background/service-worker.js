import { processCapture, getActiveCaptures, getCaptureStats } from '../lib/capture.js';
import { findRelevantKnowledge, searchKnowledge } from '../lib/relevance.js';
import { formatForInjection, formatBatchForInjection, formatConversationForInjection } from '../lib/injector.js';
import { trackInjection, trackSearchHit, flush as flushTracker } from '../lib/tracker.js';
import { dbGet, dbGetAll } from '../lib/db.js';
// LANA AI account + hybrid inference cascade.
import { getInstance, setInstance } from '../lib/instance.js';
import { login as lanaLogin, clearAuth as lanaLogout, adoptCookieSession, getAuthState } from '../lib/lana-auth.js';
import { listMatters, sendKnowledge, sendMemory, sendDocument } from '../lib/lana-client.js';
import { route as routeTask } from '../lib/router.js';
// Capability modules.
import { synthesizeHandoff } from '../lib/capabilities/handoff.js';
import { importExportText } from '../lib/capabilities/import.js';
import { saveClip } from '../lib/capabilities/research-capture.js';
import { surface } from '../lib/capabilities/surface.js';
import { proposeFills } from '../lib/capabilities/form-fill.js';

console.log('[LANA AI] Service worker loaded successfully');

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

    case 'GET_KNOWLEDGE_DATA': {
      const [summaries, topics, conversations] = await Promise.all([
        dbGetAll('summaries'),
        dbGetAll('topics'),
        dbGetAll('conversations')
      ]);
      // Trim conversations to only fields needed for scoring + rendering
      const lightConversations = (conversations || []).map(c => ({
        id: c.id,
        title: c.title,
        source: c.source,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
        messages: (c.messages || []).slice(-6)
      }));
      return { summaries: summaries || [], topics: topics || [], conversations: lightConversations };
    }

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

    // ===== LANA AI: instance + auth =====
    case 'LANA_INSTANCE_GET':
      return { instance: await getInstance() };

    case 'LANA_INSTANCE_SET':
      // Changing instance invalidates any existing session for the old host.
      await lanaLogout();
      return { instance: await setInstance(message.instance) };

    case 'LANA_AUTH_STATE':
      return await getAuthState();

    case 'LANA_LOGIN':
      // Returns a minimal, non-secret view; tokens stay in storage.
      await lanaLogin(message.email, message.password);
      return await getAuthState();

    case 'LANA_ADOPT_COOKIE': {
      const rec = await adoptCookieSession();
      return { adopted: !!rec, state: await getAuthState() };
    }

    case 'LANA_LOGOUT':
      await lanaLogout();
      return { ok: true };

    // ===== LANA AI: account ingestion =====
    case 'LANA_LIST_MATTERS':
      return { matters: await listMatters() };

    case 'LANA_SEND_KNOWLEDGE':
      return await sendKnowledge(message.matterId, {
        content: message.content,
        sourceId: message.sourceId,
      });

    case 'LANA_SEND_MEMORY':
      return await sendMemory({ fact: message.fact, matterId: message.matterId });

    case 'LANA_SEND_DOCUMENT':
      return await sendDocument({
        filename: message.filename,
        content: message.content,
        matterId: message.matterId,
        persist: message.persist,
      });

    // ===== LANA AI: hybrid inference cascade =====
    // Background route uses the Prompt API locally (WebGPU/WebLLM isn't
    // available in the service worker) or escalates to LANA. The sidepanel can
    // import lib/router.js directly to get the WebLLM backend when vendored.
    case 'LANA_ROUTE': {
      const result = await routeTask(message.task);
      return result;
    }

    // ===== LANA AI: capabilities =====
    // Cross-platform handoff: consolidate captured conversations into a primer.
    case 'LANA_HANDOFF':
      return await synthesizeHandoff({
        conversationIds: message.conversationIds,
        targetSystem: message.targetSystem,
        focus: message.focus,
      });

    // Import a ChatGPT/Claude export file's text into the local store.
    case 'LANA_IMPORT':
      return await importExportText(message.jsonText);

    // Save a page clip extracted by the content script into the local store.
    case 'LANA_SAVE_CLIP':
      return await saveClip(message.clip);

    // Surface relevant context from LANA (+ other registered sources).
    case 'LANA_SURFACE':
      return { results: await surface(message.query, message.options || {}) };

    // Propose form fills (on-device / sensitive-pinned). Detection + apply run
    // in the page (content script); only the reasoning runs here.
    case 'LANA_PROPOSE_FILLS':
      return await proposeFills({
        fields: message.fields,
        context: message.context,
        allowedMemory: message.allowedMemory,
        origin: message.origin,
      });

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// Flush tracker data before service worker suspends
chrome.runtime.onSuspend?.addListener(() => {
  flushTracker();
});
