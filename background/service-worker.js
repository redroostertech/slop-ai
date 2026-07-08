import { processCapture, getActiveCaptures, getCaptureStats } from '../lib/capture.js';
import { findRelevantKnowledge, searchKnowledge } from '../lib/relevance.js';
import { formatForInjection, formatBatchForInjection, formatConversationForInjection } from '../lib/injector.js';
import { trackInjection, trackSearchHit, flush as flushTracker } from '../lib/tracker.js';
import { dbGet, dbGetAll } from '../lib/db.js';
// LANA AI account + hybrid inference cascade.
import { getInstance, setInstance, normalizeInstanceUrl } from '../lib/instance.js';
import { login as lanaLogin, clearAuth as lanaLogout, adoptCookieSession, getAuthState, authorizeOAuth, getEntitlements } from '../lib/lana-auth.js';
import {
  listMatters, sendKnowledge, sendMemory, sendDocument,
  getMemoryPreference, setMemoryPreference, suggestMatters,
  deleteMemory, deleteMatterKnowledge,
} from '../lib/lana-client.js';
import { route as routeTask } from '../lib/router.js';
// Capability modules.
import { synthesizeHandoff } from '../lib/capabilities/handoff.js';
import { importExportText } from '../lib/capabilities/import.js';
import { saveClip } from '../lib/capabilities/research-capture.js';
import { surface } from '../lib/capabilities/surface.js';
import { proposeFills } from '../lib/capabilities/form-fill.js';
// Any-page capability delivery (chrome.scripting on the active tab).
import { clipActiveTab, selectionActiveTab, detectFieldsActiveTab, applyFieldActiveTab, activeTabOrigin } from '../lib/page-capture.js';
// WebLLM offscreen document (WebGPU is unavailable in the service worker).
import { ensureOffscreen } from '../lib/offscreen-manager.js';

console.log('[LANA AI] Service worker loaded successfully');

// Open side panel on toolbar click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// "Notify when done" click-to-focus. Registered in the SW so it survives when the
// side panel is closed (exactly when a completion notification is most likely
// clicked). `chrome.notifications` only exists once the optional permission is
// granted, so guard + also (re)register when it's granted at runtime.
// Track the focused window so a notification click can open the side panel WITHOUT
// an await first — sidePanel.open() must be called while the click's user gesture
// is still live, and any awaited round-trip before it spends the gesture.
let lastFocusedWindowId = -1; // chrome.windows.WINDOW_ID_NONE
chrome.windows?.onFocusChanged?.addListener((wid) => { if (wid !== -1) lastFocusedWindowId = wid; });

async function onNotificationClicked(notifId) {
  const wid = lastFocusedWindowId;
  if (wid !== -1) {
    // Open FIRST (no preceding await → gesture still live), then focus.
    try { chrome.sidePanel.open({ windowId: wid }); } catch { /* gesture/availability */ }
    chrome.windows.update(wid, { focused: true }).catch(() => {});
  } else {
    // Cold-start fallback: we never observed a focused window (SW just woke). The
    // gesture is likely gone after this await, but attempt it anyway.
    try {
      const win = await chrome.windows.getLastFocused();
      if (win) { chrome.sidePanel.open({ windowId: win.id }).catch(() => {}); chrome.windows.update(win.id, { focused: true }).catch(() => {}); }
    } catch { /* best-effort */ }
  }
  try { chrome.notifications.clear(notifId); } catch { /* ignore */ }
}
function registerNotificationClick() {
  if (chrome.notifications?.onClicked && !chrome.notifications.onClicked.hasListener(onNotificationClicked)) {
    chrome.notifications.onClicked.addListener(onNotificationClicked);
  }
}
registerNotificationClick();
chrome.permissions?.onAdded?.addListener?.((p) => {
  if (p?.permissions?.includes('notifications')) registerNotificationClick();
});

// ---------------------------------------------------------------------------
// Context menu: "Clip selection to LANA"
// Fires on any page when the user has selected text. Captures the selection +
// page url/title, persists it to the Captured store (kind:'clip'), then opens
// the side panel and hands off to the Clip Review panel. Registered on install;
// the onClicked listener is registered at top level so it survives SW restarts.
// ---------------------------------------------------------------------------
const CLIP_MENU_ID = 'lana-clip-selection';

function registerClipContextMenu() {
  if (!chrome.contextMenus) return;
  try {
    // removeAll → create avoids a "duplicate id" throw across SW restarts / updates.
    chrome.contextMenus.removeAll(() => {
      // Reading lastError clears the "unchecked runtime.lastError" console warning.
      void chrome.runtime.lastError;
      try {
        chrome.contextMenus.create({
          id: CLIP_MENU_ID,
          title: 'Clip selection to LANA',
          contexts: ['selection'],
        });
      } catch (_e) { /* already exists / unavailable */ }
    });
  } catch (_e) { /* contextMenus unavailable */ }
}

async function onClipContextMenuClicked(info, tab) {
  if (info.menuItemId !== CLIP_MENU_ID) return;
  let text = (info.selectionText || '').trim();
  if (!text) return;
  // Open the side panel FIRST while the context-menu click gesture is still live
  // (sidePanel.open requires a user gesture; awaiting IndexedDB before it would
  // spend the gesture and the panel wouldn't open).
  if (tab && typeof tab.windowId === 'number') {
    try { chrome.sidePanel.open({ windowId: tab.windowId }); } catch { /* gesture/availability */ }
  }
  // info.selectionText is Chrome-truncated (~1000 chars) — bad for clipping a full
  // research passage. Re-read the live selection via scripting (the context-menu
  // click grants activeTab for this tab); fall back to the truncated text.
  if (tab && typeof tab.id === 'number') {
    try {
      const full = await selectionActiveTab(tab.id);
      const sel = full && typeof full.selection === 'string' ? full.selection.trim() : '';
      if (sel.length > text.length) text = sel;
    } catch { /* keep info.selectionText */ }
  }
  const clip = {
    title: (tab && tab.title) || '',
    url: info.pageUrl || (tab && tab.url) || '',
    text,
    selection: text,
    source: 'clip',
    kind: 'clip',
  };
  try {
    const saved = await saveClip(clip);
    // Stash the clip so the side panel can pick it up for review (covers both the
    // just-opened and already-open panel; a runtime message nudges the open one).
    try {
      await chrome.storage.local.set({
        lanaPendingClipReview: { id: saved.id, clip: { ...clip, id: saved.id }, ts: Date.now() },
      });
    } catch { /* storage unavailable */ }
    try { chrome.runtime.sendMessage({ type: 'LANA_CLIP_REVIEW_READY', id: saved.id }).catch(() => {}); } catch { /* no listener */ }
  } catch (err) {
    // Don't log the clip text; only that saving failed.
    console.warn('[LANA AI] Clip save failed:', err?.message || err);
  }
}

registerClipContextMenu();
chrome.runtime.onInstalled?.addListener?.(registerClipContextMenu);
chrome.contextMenus?.onClicked?.addListener?.(onClipContextMenuClicked);

// Warm the WebLLM offscreen document up front (best-effort). No-ops if the
// "offscreen" permission or the vendored runtime is missing; the router also
// creates it lazily on first use.
ensureOffscreen().catch((err) =>
  console.warn('[LANA AI] ensureOffscreen failed:', err?.message || err)
);

// Message types that touch the authenticated LANA account, inference, or the
// account config. These must come from an EXTENSION PAGE (sidepanel/offscreen),
// never a content script — otherwise a malicious/XSS'd script on one of the 5
// AI sites could read matters/account data, write to matters, or spend inference
// quota via chrome.runtime.sendMessage. (The clip/fill triggers are content-
// script-initiated by design and return no account data, so they're allowed.)
const EXTENSION_ONLY_MESSAGES = new Set([
  'LANA_INSTANCE_GET', 'LANA_INSTANCE_SET', 'LANA_AUTH_STATE', 'LANA_AUTHORIZE',
  'LANA_LOGIN', 'LANA_ADOPT_COOKIE', 'LANA_LOGOUT', 'LANA_LIST_MATTERS', 'LANA_SEND_KNOWLEDGE',
  'LANA_SEND_MEMORY', 'LANA_GET_MEMORY_PREF', 'LANA_SET_MEMORY_PREF', 'LANA_SUGGEST_MATTERS',
  'LANA_DELETE_MEMORY', 'LANA_DELETE_KNOWLEDGE',
  'LANA_SEND_DOCUMENT', 'LANA_ROUTE', 'LANA_HANDOFF', 'LANA_CLIP_SELECTION',
  'LANA_IMPORT', 'LANA_SURFACE', 'LANA_PROPOSE_FILLS',
]);

/** True only for messages from one of this extension's own pages (not a tab/content script). */
function isTrustedExtensionSender(sender) {
  return (
    !!sender &&
    sender.id === chrome.runtime.id &&
    !sender.tab && // content scripts carry a tab; extension pages don't
    typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)
  );
}

// Message router — connects content scripts + extension pages to lib modules
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reject account/inference messages that don't come from a trusted extension page.
  if (EXTENSION_ONLY_MESSAGES.has(message?.type) && !isTrustedExtensionSender(sender)) {
    console.warn('[LANA AI] Rejected untrusted sender for', message?.type, sender?.url);
    sendResponse({ error: 'forbidden_sender' });
    return false;
  }
  handleMessage(message, sender).then(result => {
    sendResponse(result);
  }).catch(err => {
    // "Not signed in" is an expected state, not a fault — log it quietly so it
    // doesn't surface as a red error in the extension's error panel.
    const benign = err?.code === 'NOT_SIGNED_IN' || /not signed in/i.test(err?.message || '');
    if (benign) console.debug('[LANA AI]', message.type, '→', err.message);
    else console.error('[LANA AI] Message error:', message.type, err);
    sendResponse({ error: err.message, code: err?.code });
  });
  return true; // keep channel open for async response
});

/** Auth state + UX-only entitlements — the single shape every auth handler returns. */
async function fullAuthState() {
  const [state, entitlements] = await Promise.all([getAuthState(), getEntitlements()]);
  return { ...state, entitlements };
}

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

    case 'LANA_INSTANCE_SET': {
      // Validate the URL BEFORE clearing auth — a malformed URL must not log the
      // user out while failing to change the instance.
      const url = normalizeInstanceUrl(message.instance?.url);
      // Changing instance invalidates any existing session for the old host.
      await lanaLogout();
      return { instance: await setInstance({ ...message.instance, url }) };
    }

    case 'LANA_AUTH_STATE':
      // Auth state + UX-only entitlements (server enforces authz regardless).
      return await fullAuthState();

    // Authorize LANA GPT via OAuth 2.0 + PKCE. Runs here because chrome.identity
    // .launchWebAuthFlow needs the extension context; the sidepanel requests the
    // host permission (user gesture) before sending this. Returns the full state
    // (incl. entitlements) so the UI can gate features immediately after auth.
    case 'LANA_AUTHORIZE':
      await authorizeOAuth();
      return await fullAuthState();

    case 'LANA_LOGIN':
      // Legacy email/password (kept for on-prem per contract §1.6). OAuth is primary.
      await lanaLogin(message.email, message.password);
      return await fullAuthState();

    case 'LANA_ADOPT_COOKIE': {
      const rec = await adoptCookieSession();
      return { adopted: !!rec, state: await fullAuthState() };
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

    // Recommend which matters a clip should be filed into. Throws on 404/offline/
    // unauth; the sidepanel catches that and falls back to the local keyword
    // matcher (lib/matter-match.js). The clip text is never logged.
    case 'LANA_SUGGEST_MATTERS':
      return { suggestions: await suggestMatters(message.text) };

    case 'LANA_SEND_MEMORY':
      return await sendMemory({ fact: message.fact, matterId: message.matterId });

    case 'LANA_DELETE_MEMORY':
      return { ok: await deleteMemory(message.id) };

    case 'LANA_DELETE_KNOWLEDGE':
      return await deleteMatterKnowledge(message.matterId, message.sourceId);

    case 'LANA_GET_MEMORY_PREF':
      return await getMemoryPreference();

    case 'LANA_SET_MEMORY_PREF':
      return await setMemoryPreference(message.enabled);

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

    // Clip the CURRENT SELECTION on the active tab (side-panel "Clip selection"
    // affordance). Grabs window.getSelection() via chrome.scripting, persists it
    // to Captured (kind:'clip'), and returns the saved clip so the panel can open
    // the Clip Review. Extension-page-only (allowlisted); the panel has no tab so
    // resolveTab falls back to the active tab.
    case 'LANA_CLIP_SELECTION': {
      const sel = await selectionActiveTab();
      const selection = (sel && sel.selection || '').trim();
      if (!selection) return { error: 'Select some text on the page first, then clip it.' };
      const clip = {
        title: (sel && sel.title) || '',
        url: (sel && sel.url) || '',
        text: selection,
        selection,
        source: 'clip',
        kind: 'clip',
      };
      const saved = await saveClip(clip);
      return { ok: true, id: saved.id, clip: { ...clip, id: saved.id } };
    }

    // Clip the TRIGGERING tab via chrome.scripting, then persist it. Uses the
    // sender's tab id (not a fresh active-tab query) so a tab switch during the
    // operation can't clip the wrong page.
    case 'LANA_CLIP_ACTIVE_TAB': {
      const clip = await clipActiveTab(sender.tab?.id);
      if (!clip || !clip.text?.trim()) return { error: 'Nothing to clip on this page.' };
      const saved = await saveClip(clip);
      return { ok: true, id: saved.id, clip };
    }

    // Detect fields on the TRIGGERING tab → propose fills (on-device) → push the
    // preview back to THAT SAME tab. Threading sender.tab.id through detect +
    // origin + preview keeps (fields, origin, preview target) correlated even
    // if the user switches tabs during the multi-second inference.
    case 'LANA_START_FORM_FILL': {
      const tabId = sender.tab?.id;
      const fields = await detectFieldsActiveTab(tabId);
      const origin = await activeTabOrigin(tabId);
      const { proposals } = await proposeFills({
        fields,
        context: message.context || '',
        allowedMemory: message.allowedMemory || [],
        origin,
      });
      if (proposals.length === 0) return { ok: true, count: 0, origin, delivered: false };
      // Deliver the preview to the exact tab whose fields we scraped, and report
      // whether it landed (the caller shows an error if it didn't).
      let delivered = false;
      if (typeof tabId === 'number') {
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'LANA_FILL_PREVIEW', proposals, origin });
          delivered = true;
        } catch (_e) {
          delivered = false;
        }
      }
      return { ok: true, count: proposals.length, origin, delivered };
    }

    // Apply ONE approved field to the TRIGGERING tab (called from that tab's
    // preview surface, so sender.tab.id is the same tab the fields came from).
    case 'LANA_APPLY_FIELD':
      return await applyFieldActiveTab(message.approved, sender.tab?.id);

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// Flush tracker data before service worker suspends
chrome.runtime.onSuspend?.addListener(() => {
  flushTracker();
});
