import { openDB, dbPut, dbGet, dbGetAll, dbGetByIndex, dbDelete, dbClear, dbCount, dbPutBatch } from '../lib/db.js';
import { estimateTokens, formatNumber, formatShorthand, shorthandSpan, escapeHtml, sanitizeFilename, downloadFile, convToMarkdown, generateId, sourceLabel, sourceColor, timeAgo } from '../lib/utils.js';
import { renderMarkdown, renderInlineMarkdown } from '../lib/markdown.js';
import { parseImport } from '../lib/parsers/universal.js';
import { summarizeConversation } from '../lib/summarizer.js';
import { assignToTopic, getAllTopicsWithCounts, getTopicDetail, renameTopic, deleteTopic } from '../lib/knowledge.js';
import { exportKnowledge } from '../lib/exporter.js';
import { getOpenConflicts, getConflictsForSummary, resolveConflict, dismissConflict, getConflictStats, runFullScan, checkNewSummary } from '../lib/conflicts.js';
import { getKnowledgeHealth, getTrending, getStale, getUsageBySource } from '../lib/analytics.js';
import { trackView, trackExport } from '../lib/tracker.js';
import { getProviders, saveProviders, hasEnabledProvider, testProvider, PROVIDER_DEFAULTS } from '../lib/ai-router.js';
import { initEmbeddings, isModelLoaded, isModelLoading, embed, destroyEmbeddings } from '../lib/embeddings.js';

// ===== View Router =====
const views = {
  dashboard: document.getElementById('view-dashboard'),
  import: document.getElementById('view-import'),
  conversations: document.getElementById('view-conversations'),
  'conversation-detail': document.getElementById('view-conversation-detail'),
  knowledge: document.getElementById('view-knowledge'),
  'topic-detail': document.getElementById('view-topic-detail'),
  export: document.getElementById('view-export'),
  'conflict-detail': document.getElementById('view-conflict-detail'),
  analytics: document.getElementById('view-analytics'),
  settings: document.getElementById('view-settings')
};

let viewHistory = [{ name: 'dashboard', data: {} }];

async function navigateTo(name, data = {}) {
  // Stop live capture polling when leaving dashboard
  const prev = viewHistory[viewHistory.length - 1];
  if (prev && prev.name === 'dashboard' && name !== 'dashboard') {
    stopLiveCapturePolling();
  }
  Object.values(views).forEach(v => v.hidden = true);
  views[name].hidden = false;
  viewHistory.push({ name, data });
  await initView(name, data);
  window.scrollTo(0, 0);
}

function goBack() {
  const leaving = viewHistory.pop();
  const prev = viewHistory[viewHistory.length - 1] || { name: 'dashboard', data: {} };
  // Stop polling when leaving dashboard
  if (leaving && leaving.name === 'dashboard') stopLiveCapturePolling();
  Object.values(views).forEach(v => v.hidden = true);
  views[prev.name].hidden = false;
  initView(prev.name, prev.data);
  window.scrollTo(0, 0);
}

// Nav buttons
document.querySelectorAll('[data-nav]').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.nav));
});
document.querySelectorAll('[data-back]').forEach(btn => {
  btn.addEventListener('click', goBack);
});

// Clickable stat cards on dashboard
document.getElementById('stat-conversations-card')?.addEventListener('click', () => navigateTo('conversations'));
document.getElementById('stat-topics-card')?.addEventListener('click', () => navigateTo('knowledge'));
document.getElementById('stat-summarized-card')?.addEventListener('click', async () => {
  await navigateTo('conversations');
  if (convStatusFilter) { convStatusFilter.value = 'summarized'; filterConversations(); }
});
document.getElementById('stat-pending-card')?.addEventListener('click', async () => {
  await navigateTo('conversations');
  if (convStatusFilter) { convStatusFilter.value = 'pending'; filterConversations(); }
});

// ===== Search clear buttons =====
document.querySelectorAll('.search-wrap').forEach(wrap => {
  const input = wrap.querySelector('.search-input');
  const btn = wrap.querySelector('.search-clear');
  if (!input || !btn) return;

  input.addEventListener('input', () => {
    btn.hidden = !input.value;
  });

  btn.addEventListener('click', () => {
    input.value = '';
    btn.hidden = true;
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
});

// ===== View Initializers =====
async function initView(name, data) {
  switch (name) {
    case 'dashboard': return initDashboard();
    case 'import': return initImport();
    case 'conversations': return initConversations();
    case 'conversation-detail': return initConversationDetail(data.id);
    case 'knowledge': return initKnowledge();
    case 'topic-detail': return initTopicDetail(data.id);
    case 'export': return initExport();
    case 'conflict-detail': return initConflictDetail(data.id);
    case 'analytics': return initAnalytics();
    case 'settings': return initSettings();
  }
}

// ===== Skeleton Helpers =====
function skeletonLine(cls = '') {
  return `<div class="skeleton skeleton-line ${cls}"></div>`;
}
function skeletonCards(n = 3) {
  return Array.from({ length: n }, () =>
    `<div class="skeleton-card"><div class="skeleton skeleton-line skeleton-line-long"></div><div class="skeleton skeleton-line skeleton-line-med"></div></div>`
  ).join('');
}
function skeletonPills(n = 4) {
  const widths = [90, 120, 100, 80, 110, 95];
  return Array.from({ length: n }, (_, i) =>
    `<span class="skeleton skeleton-pill" style="width:${widths[i % widths.length]}px"></span>`
  ).join('');
}

// ===== Dashboard =====
async function initDashboard() {
  // Show skeletons
  document.getElementById('stat-total').textContent = '\u00A0\u00A0\u00A0';
  document.getElementById('stat-total').classList.add('skeleton');
  document.getElementById('stat-summarized').textContent = '\u00A0\u00A0';
  document.getElementById('stat-summarized').classList.add('skeleton');
  document.getElementById('stat-pending').textContent = '\u00A0\u00A0';
  document.getElementById('stat-pending').classList.add('skeleton');
  document.getElementById('topic-map').innerHTML = skeletonPills(6);
  document.getElementById('platform-pills').innerHTML = skeletonPills(4);
  document.getElementById('donut-chart').innerHTML = '';
  document.getElementById('donut-center').innerHTML = `<div class="skeleton skeleton-circle" style="width:80px;height:80px;margin:auto"></div>`;

  const convs = await dbGetAll('conversations');
  const summaries = await dbGetAll('summaries');
  const topics = await dbGetAll('topics');

  const summarizedIds = new Set(summaries.map(s => s.conversationId));
  const pending = convs.filter(c => !summarizedIds.has(c.id)).length;

  // Remove skeletons and set real values
  document.getElementById('stat-total').classList.remove('skeleton');
  document.getElementById('stat-summarized').classList.remove('skeleton');
  document.getElementById('stat-pending').classList.remove('skeleton');
  document.getElementById('stat-total').textContent = formatNumber(convs.length);
  document.getElementById('stat-summarized').textContent = formatNumber(summaries.length);
  document.getElementById('stat-pending').textContent = formatNumber(pending);

  // Platform breakdown (combined source counts + tokens)
  const bySource = {};
  const tokensBySource = {};
  const latestBySource = {};
  let totalTokens = 0;
  convs.forEach(c => {
    bySource[c.source] = (bySource[c.source] || 0) + 1;
    const tok = c.estimatedTokens || 0;
    tokensBySource[c.source] = (tokensBySource[c.source] || 0) + tok;
    totalTokens += tok;
    if (c.createdAt && (!latestBySource[c.source] || c.createdAt > latestBySource[c.source])) {
      latestBySource[c.source] = c.createdAt;
    }
  });

  // Platform breakdown donut chart
  const sortedSources = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const platformData = sortedSources.map(([src, count]) => {
    const tokens = tokensBySource[src] || 0;
    const pct = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
    const avgTokens = count > 0 ? Math.round(tokens / count) : 0;
    return { src, count, tokens, pct, avgTokens, latest: latestBySource[src] };
  });

  renderPlatformPills(platformData, null);
  renderDonutChart(platformData, totalTokens, null);
  attachPillListeners(platformData, totalTokens);

  // Topic map — mind-map style nodes
  renderTopicMap(topics, summaries);

  // Summarize options — populate platforms and update button
  await populateSummarizePlatforms();
  updateSummarizeButton();

  // Live captures
  refreshLiveCaptures();
  startLiveCapturePolling();
}

// ===== Live Captures =====
let liveCaptureInterval = null;

function startLiveCapturePolling() {
  stopLiveCapturePolling();
  liveCaptureInterval = setInterval(refreshLiveCaptures, 5000);
}

function stopLiveCapturePolling() {
  if (liveCaptureInterval) {
    clearInterval(liveCaptureInterval);
    liveCaptureInterval = null;
  }
}

async function refreshLiveCaptures() {
  const card = document.getElementById('live-captures-card');
  const list = document.getElementById('live-captures-list');
  if (!card || !list) return;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'CAPTURE_STATUS' });
    const captures = response?.active || [];

    if (captures.length === 0) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    const sourceColors = { chatgpt: '#10a37f', claude: '#d97706', gemini: '#2563eb', copilot: '#7c3aed' };

    list.innerHTML = captures.map(c => {
      const color = sourceColors[c.source] || '#6b7280';
      const ago = timeAgo(c.lastActivity);
      return `<div class="live-capture-item">
        <span class="live-capture-dot" style="background:${color}"></span>
        <span class="live-capture-title">${escapeHtml(c.title || 'Untitled')}</span>
        <span class="live-capture-time">${ago}</span>
      </div>`;
    }).join('');
  } catch {
    card.hidden = true;
  }
}

// ===== Topic Map =====
function getTopicPalettes() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    bg: [v('--color-blue-light'), v('--color-red-light'), v('--color-green-light'), v('--color-yellow-light'), v('--color-purple-light'), v('--color-orange-light'), v('--color-indigo-light'), v('--color-teal-light')],
    fg: [v('--color-blue-dark'), v('--color-red-dark'), v('--color-green-dark'), v('--color-yellow-dark'), v('--color-purple-dark'), v('--color-orange-dark'), v('--color-indigo-dark'), v('--color-teal-dark')]
  };
}
let _topicPalette = null;
function topicPalette() { if (!_topicPalette) _topicPalette = getTopicPalettes(); return _topicPalette; }

function topicColorIndex(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return Math.abs(h) % topicPalette().bg.length;
}

function renderTopicMap(topics, summaries) {
  const container = document.getElementById('topic-map');
  if (!container) return;

  if (topics.length === 0) {
    container.innerHTML = '<div class="topic-map-empty">No topics yet</div>';
    return;
  }

  // Compute summary counts per topic
  const countMap = {};
  summaries.forEach(s => { if (s.topicId) countMap[s.topicId] = (countMap[s.topicId] || 0) + 1; });

  const enriched = topics.map(t => ({
    ...t,
    summaryCount: countMap[t.id] || 0
  }));

  // Sort by updatedAt desc, take top 8
  enriched.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const top = enriched.slice(0, 8);

  // Render nodes
  container.innerHTML = top.map(t => {
    const ci = topicColorIndex(t.name);
    const sizeClass = t.summaryCount >= 5 ? 'topic-node-lg' : t.summaryCount >= 2 ? 'topic-node-md' : 'topic-node-sm';
    return `<div class="topic-node ${sizeClass}" data-topic-id="${t.id}"
      style="background:${topicPalette().bg[ci]};color:${topicPalette().fg[ci]}">
      <span class="topic-node-label">${escapeHtml(t.name)}</span>
      <span class="topic-node-count">${t.summaryCount}</span>
    </div>`;
  }).join('');

  // Click handlers
  container.querySelectorAll('.topic-node').forEach(node => {
    node.addEventListener('click', () => navigateTo('topic-detail', { id: node.dataset.topicId }));
  });
}

// Topics "View All" button
document.getElementById('topics-view-all')?.addEventListener('click', () => navigateTo('knowledge'));

// ===== Donut Chart =====
const DONUT_CX = 60, DONUT_CY = 60, DONUT_R = 52;
const DONUT_C = 2 * Math.PI * DONUT_R; // ~326.73
const DONUT_STROKE = 14;
const DONUT_GAP = 4;

function renderPlatformPills(platformData, selectedSrc) {
  const container = document.getElementById('platform-pills');
  if (!container) return;
  const allActive = selectedSrc === null;
  let html = `<button class="platform-pill ${allActive ? 'active' : ''}" data-platform="all">
    <span class="pill-dot" style="background:#6b7280"></span>All
  </button>`;
  platformData.forEach(p => {
    html += `<button class="platform-pill ${selectedSrc === p.src ? 'active' : ''}" data-platform="${p.src}">
      <span class="pill-dot" style="background:${sourceColor(p.src)}"></span>${sourceLabel(p.src)}
    </button>`;
  });
  container.innerHTML = html;
}

function renderDonutChart(platformData, totalTokens, selectedSrc) {
  const svg = document.getElementById('donut-chart');
  const center = document.getElementById('donut-center');
  if (!svg || !center) return;

  let svgHTML = `<circle class="donut-track" cx="${DONUT_CX}" cy="${DONUT_CY}" r="${DONUT_R}" fill="none" stroke="#e5e7eb" stroke-width="${DONUT_STROKE}" />`;

  if (platformData.length > 0) {
    svgHTML += `<g transform="rotate(-90 ${DONUT_CX} ${DONUT_CY})">`;
    let offset = 0;
    platformData.forEach(p => {
      const segLen = (p.pct / 100) * DONUT_C;
      const actualSeg = Math.max(segLen - DONUT_GAP, 2);
      const isSelected = selectedSrc === p.src;
      const dimmed = selectedSrc !== null && !isSelected;
      svgHTML += `<circle class="donut-segment" data-src="${p.src}"
        cx="${DONUT_CX}" cy="${DONUT_CY}" r="${DONUT_R}" fill="none"
        stroke="${sourceColor(p.src)}" stroke-width="${isSelected ? DONUT_STROKE + 3 : DONUT_STROKE}"
        stroke-dasharray="${actualSeg} ${DONUT_C - actualSeg}"
        stroke-dashoffset="${-(offset + DONUT_GAP / 2)}"
        style="opacity:${dimmed ? 0.2 : 1}" />`;
      offset += segLen;
    });
    svgHTML += `</g>`;
  }

  svg.innerHTML = svgHTML;
  updateDonutCenter(platformData, totalTokens, selectedSrc);
}

function updateDonutCenter(platformData, totalTokens, selectedSrc) {
  const center = document.getElementById('donut-center');
  if (!center) return;

  if (platformData.length === 0) {
    center.innerHTML = `<span class="donut-center-label">No data</span>`;
  } else if (selectedSrc === null) {
    center.innerHTML = `
      <span class="donut-center-value">${formatShorthand(totalTokens)}</span>
      <span class="donut-center-label">total tokens</span>`;
  } else {
    const p = platformData.find(d => d.src === selectedSrc);
    if (p) {
      center.innerHTML = `
        <span class="donut-center-badge" style="color:${sourceColor(p.src)}">${sourceLabel(p.src)}</span>
        <span class="donut-center-value">${p.pct.toFixed(1)}%</span>
        <span class="donut-center-label">~${formatShorthand(p.tokens)} tokens</span>
        <span class="donut-center-sub">${formatNumber(p.count)} convos</span>`;
    }
  }

  center.classList.remove('donut-center-fade');
  void center.offsetWidth;
  center.classList.add('donut-center-fade');
}

function animateDonut(platformData, totalTokens, selectedSrc) {
  document.querySelectorAll('#donut-chart .donut-segment').forEach(circle => {
    const src = circle.dataset.src;
    const isSelected = selectedSrc === src;
    const dimmed = selectedSrc !== null && !isSelected;
    circle.style.opacity = dimmed ? '0.2' : '1';
    circle.style.strokeWidth = isSelected ? `${DONUT_STROKE + 3}px` : `${DONUT_STROKE}px`;
  });
  updateDonutCenter(platformData, totalTokens, selectedSrc);
}

function attachPillListeners(platformData, totalTokens) {
  const container = document.getElementById('platform-pills');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const pill = e.target.closest('.platform-pill');
    if (!pill) return;
    const platform = pill.dataset.platform;
    const selectedSrc = platform === 'all' ? null : platform;
    container.querySelectorAll('.platform-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    animateDonut(platformData, totalTokens, selectedSrc);
  });
}

// ===== Import =====
function initImport() {
  document.getElementById('import-progress').hidden = true;
  document.getElementById('import-results').hidden = true;
}

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFiles(fileInput.files);
});

document.getElementById('import-another-btn')?.addEventListener('click', () => {
  document.getElementById('import-results').hidden = true;
  document.getElementById('import-progress').hidden = true;
  fileInput.value = '';
});

async function handleFiles(fileList) {
  const progressBox = document.getElementById('import-progress');
  const fill = document.getElementById('import-fill');
  const statusText = document.getElementById('import-status-text');
  const resultsDiv = document.getElementById('import-results');
  const resultsText = document.getElementById('import-results-text');

  progressBox.hidden = false;
  resultsDiv.hidden = true;
  fill.style.width = '0%';

  let totalImported = 0;
  let totalSkipped = 0;
  const sources = new Set();

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    statusText.textContent = `Processing ${file.name}...`;
    fill.style.width = `${((i) / fileList.length) * 100}%`;

    try {
      const result = await parseImport(file);
      sources.add(result.source);

      // Deduplicate
      const existing = await dbGetByIndex('conversations', 'source', result.source);
      const existingIds = new Set(existing.map(c => c.sourceId));

      const newConvs = result.conversations.filter(c => !existingIds.has(c.sourceId));
      totalSkipped += result.conversations.length - newConvs.length;

      if (newConvs.length > 0) {
        await dbPutBatch('conversations', newConvs);
        totalImported += newConvs.length;
      }
    } catch (err) {
      statusText.textContent = `Error processing ${file.name}: ${err.message}`;
      console.error(err);
    }

    fill.style.width = `${((i + 1) / fileList.length) * 100}%`;
  }

  progressBox.hidden = true;
  resultsDiv.hidden = false;

  const sourceList = [...sources].map(s => sourceLabel(s)).join(', ');
  let msg = `Imported ${formatNumber(totalImported)} conversations from ${sourceList}.`;
  if (totalSkipped > 0) msg += ` Skipped ${formatNumber(totalSkipped)} duplicates.`;
  resultsText.textContent = msg;
}

// ===== Conversations =====
let allConversations = [];

let summarizedConvIds = new Set();

async function initConversations() {
  document.getElementById('conv-list').innerHTML = skeletonCards(6);

  allConversations = await dbGetAll('conversations');
  allConversations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Build set of summarized conversation IDs for badges
  const summaries = await dbGetAll('summaries');
  summarizedConvIds = new Set(summaries.map(s => s.conversationId));
  renderConversationList(allConversations);
}

const convSearch = document.getElementById('conv-search');
const convFilter = document.getElementById('conv-source-filter');
const convStatusFilter = document.getElementById('conv-status-filter');
const convSort = document.getElementById('conv-sort');
const convTokensMin = document.getElementById('conv-tokens-min');
const convTokensMax = document.getElementById('conv-tokens-max');
const convMsgsMin = document.getElementById('conv-msgs-min');
const convMsgsMax = document.getElementById('conv-msgs-max');
const convDateFrom = document.getElementById('conv-date-from');
const convDateTo = document.getElementById('conv-date-to');

convSearch?.addEventListener('input', filterConversations);
convFilter?.addEventListener('change', filterConversations);
convStatusFilter?.addEventListener('change', filterConversations);
convSort?.addEventListener('change', filterConversations);
convTokensMin?.addEventListener('input', filterConversations);
convTokensMax?.addEventListener('input', filterConversations);
convMsgsMin?.addEventListener('input', filterConversations);
convMsgsMax?.addEventListener('input', filterConversations);
convDateFrom?.addEventListener('change', filterConversations);
convDateTo?.addEventListener('change', filterConversations);

function filterConversations() {
  const q = convSearch.value.toLowerCase().trim();
  const source = convFilter.value;
  const status = convStatusFilter?.value || 'all';
  const sortBy = convSort?.value || 'date-desc';
  const tokMin = convTokensMin?.value ? Number(convTokensMin.value) : null;
  const tokMax = convTokensMax?.value ? Number(convTokensMax.value) : null;
  const msgMin = convMsgsMin?.value ? Number(convMsgsMin.value) : null;
  const msgMax = convMsgsMax?.value ? Number(convMsgsMax.value) : null;
  const dateFrom = convDateFrom?.value || null;
  const dateTo = convDateTo?.value || null;

  let filtered = allConversations;

  // Text search
  if (q) filtered = filtered.filter(c =>
    c.title.toLowerCase().includes(q) ||
    (c.messages || []).some(m => m.content.toLowerCase().includes(q))
  );

  // Source filter
  if (source !== 'all') filtered = filtered.filter(c => c.source === source);

  // Status filter
  if (status === 'summarized') filtered = filtered.filter(c => summarizedConvIds.has(c.id));
  if (status === 'pending') filtered = filtered.filter(c => !summarizedConvIds.has(c.id));

  // Token range
  if (tokMin != null) filtered = filtered.filter(c => (c.estimatedTokens || 0) >= tokMin);
  if (tokMax != null) filtered = filtered.filter(c => (c.estimatedTokens || 0) <= tokMax);

  // Message count range
  if (msgMin != null) filtered = filtered.filter(c => (c.messageCount || 0) >= msgMin);
  if (msgMax != null) filtered = filtered.filter(c => (c.messageCount || 0) <= msgMax);

  // Date range
  if (dateFrom) filtered = filtered.filter(c => c.createdAt && c.createdAt >= dateFrom);
  if (dateTo) filtered = filtered.filter(c => c.createdAt && c.createdAt <= dateTo + 'T23:59:59');

  // Sort
  filtered = [...filtered];
  switch (sortBy) {
    case 'date-desc': filtered.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); break;
    case 'date-asc': filtered.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)); break;
    case 'tokens-desc': filtered.sort((a, b) => (b.estimatedTokens || 0) - (a.estimatedTokens || 0)); break;
    case 'tokens-asc': filtered.sort((a, b) => (a.estimatedTokens || 0) - (b.estimatedTokens || 0)); break;
    case 'msgs-desc': filtered.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0)); break;
    case 'msgs-asc': filtered.sort((a, b) => (a.messageCount || 0) - (b.messageCount || 0)); break;
  }

  // Show filter summary
  const summary = document.getElementById('conv-filter-summary');
  if (summary) {
    const activeFilters = [];
    if (q) activeFilters.push(`"${q}"`);
    if (source !== 'all') activeFilters.push(source);
    if (status !== 'all') activeFilters.push(status);
    if (tokMin != null || tokMax != null) activeFilters.push(`${tokMin || 0}–${tokMax || '∞'} tokens`);
    if (msgMin != null || msgMax != null) activeFilters.push(`${msgMin || 0}–${msgMax || '∞'} msgs`);
    if (dateFrom || dateTo) activeFilters.push(`${dateFrom || '…'}→${dateTo || '…'}`);
    summary.textContent = activeFilters.length > 0
      ? `Showing ${formatNumber(filtered.length)} of ${formatNumber(allConversations.length)} — ${activeFilters.join(', ')}`
      : `${formatNumber(filtered.length)} conversations`;
  }

  renderConversationList(filtered);
}

function renderConversationList(list) {
  const container = document.getElementById('conv-list');
  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">No conversations found.</div>';
    return;
  }

  container.innerHTML = list.map(conv => {
    const date = conv.createdAt
      ? new Date(conv.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const isSummarized = summarizedConvIds.has(conv.id);
    const statusBadge = isSummarized
      ? '<span class="badge badge-summarized">&#10003; Summarized</span>'
      : '<span class="badge badge-pending">Pending</span>';

    return `<div class="item-card" data-conv-id="${conv.id}">
      <div class="item-title">${escapeHtml(conv.title)}</div>
      <div class="item-meta">
        <span class="badge badge-source" style="background:${sourceColor(conv.source)}">${sourceLabel(conv.source)}</span>
        ${statusBadge}
        <span class="badge badge-count">${formatNumber(conv.messageCount)} msgs</span>
        <span class="badge badge-tokens">~${formatNumber(conv.estimatedTokens)} tokens</span>
        ${date ? `<span class="badge badge-count">${date}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.item-card').forEach(card => {
    card.addEventListener('click', () => {
      navigateTo('conversation-detail', { id: card.dataset.convId });
    });
  });
}

// ===== Conversation Detail =====
let currentConv = null;

async function initConversationDetail(id) {
  if (!id) return;
  document.getElementById('conv-detail-title').textContent = '\u00A0';
  document.getElementById('conv-detail-title').classList.add('skeleton');
  document.getElementById('conv-detail-meta').innerHTML = `<span class="skeleton skeleton-pill" style="width:70px"></span><span class="skeleton skeleton-pill" style="width:90px"></span>`;

  currentConv = await dbGet('conversations', id);
  if (!currentConv) return;

  document.getElementById('conv-detail-title').classList.remove('skeleton');
  document.getElementById('conv-detail-title').textContent = currentConv.title;
  document.getElementById('conv-msg-count').textContent = formatNumber(currentConv.messageCount);

  // Meta badges
  const meta = document.getElementById('conv-detail-meta');
  const date = currentConv.createdAt
    ? new Date(currentConv.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  meta.innerHTML = `
    <span class="badge badge-source" style="background:${sourceColor(currentConv.source)}">${sourceLabel(currentConv.source)}</span>
    <span class="badge badge-tokens">~${formatNumber(currentConv.estimatedTokens)} tokens</span>
    ${date ? `<span class="badge badge-count">${date}</span>` : ''}
  `;

  // Summary, Insights, Decisions — separate cards
  const summaryCard = document.getElementById('conv-summary-card');
  const insightsCard = document.getElementById('conv-insights-card');
  const decisionsCard = document.getElementById('conv-decisions-card');
  summaryCard.hidden = true;
  insightsCard.hidden = true;
  decisionsCard.hidden = true;

  const summaries = await dbGetByIndex('summaries', 'conversationId', id);
  if (summaries.length > 0) {
    const s = summaries[0];
    try { await trackView(s.id, { conversationId: id }); } catch {}

    summaryCard.hidden = false;
    document.getElementById('conv-summary-text').innerHTML = renderMarkdown(s.summary);
    document.getElementById('conv-tags').innerHTML = (s.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');

    if (s.keyInsights?.length) {
      insightsCard.hidden = false;
      document.getElementById('conv-insights').innerHTML = s.keyInsights.map(i => `<li>${renderInlineMarkdown(i)}</li>`).join('');
    }

    if (s.decisions?.length) {
      decisionsCard.hidden = false;
      document.getElementById('conv-decisions').innerHTML = s.decisions.map(d => `<li>${renderInlineMarkdown(d)}</li>`).join('');
    }
  }

  // Messages
  const msgContainer = document.getElementById('conv-messages');
  msgContainer.innerHTML = (currentConv.messages || []).map(msg => `
    <div class="message">
      <div class="message-role ${msg.role}">${msg.role}</div>
      <div class="message-content md-content">${renderMarkdown(msg.content)}</div>
    </div>
  `).join('');

  // Summarize button state
  const convSumBtn = document.getElementById('conv-summarize-btn');
  if (convSumBtn) {
    const hasProvider = await hasEnabledProvider();
    if (!hasProvider) {
      convSumBtn.textContent = 'Add Provider to Summarize';
      convSumBtn.disabled = false;
      convSumBtn._noProvider = true;
    } else {
      convSumBtn._noProvider = false;
      convSumBtn.textContent = summaries.length > 0 ? 'Re-summarize' : 'Summarize';
    }
  }
}

// Conv detail buttons
document.getElementById('conv-summarize-btn')?.addEventListener('click', async () => {
  if (!currentConv) return;
  const btn = document.getElementById('conv-summarize-btn');

  // No provider — go to settings
  if (btn._noProvider) {
    navigateTo('settings');
    return;
  }

  btn.textContent = 'Summarizing...';
  btn.disabled = true;
  try {
    const hasProvider = await hasEnabledProvider();
    if (!hasProvider) { navigateTo('settings'); return; }
    const injCtx = await resolveInjectionContext(currentConv);
    const summary = await summarizeConversation(currentConv, { injectionContext: injCtx });
    await dbPut('summaries', summary);
    const forceTopicId = injCtx?.[0]?.topicId || null;
    await assignToTopic(summary, { forceTopicId });
    // Embed the new summary
    await embedSummary(summary);
    // Check for conflicts with existing knowledge
    try { await checkNewSummary(summary, { useAI: true }); } catch {}
    await initConversationDetail(currentConv.id);
  } catch (err) {
    alert('Summarization failed: ' + err.message);
  } finally {
    btn.textContent = 'Summarize';
    btn.disabled = false;
  }
});

// Conversation detail: bottom drawer
const convDrawer = document.getElementById('conv-drawer');
const convDeleteModal = document.getElementById('conv-delete-modal');

function openConvDrawer() {
  if (convDrawer) convDrawer.hidden = false;
}

function closeConvDrawer() {
  if (convDrawer) convDrawer.hidden = true;
}

document.getElementById('conv-more-btn')?.addEventListener('click', openConvDrawer);
document.getElementById('conv-drawer-close')?.addEventListener('click', closeConvDrawer);

convDrawer?.addEventListener('click', (e) => {
  if (e.target === convDrawer) closeConvDrawer();
});

// Drawer: Export .md
document.getElementById('conv-drawer-export')?.addEventListener('click', () => {
  closeConvDrawer();
  if (!currentConv) return;
  const md = convToMarkdown(currentConv);
  const name = sanitizeFilename(currentConv.title) || 'conversation';
  downloadFile(`${name}.md`, md);
});

// Drawer: Copy
document.getElementById('conv-drawer-copy')?.addEventListener('click', async () => {
  closeConvDrawer();
  if (!currentConv) return;
  const md = convToMarkdown(currentConv);
  await navigator.clipboard.writeText(md);
});

// Drawer: Delete — open confirmation modal
document.getElementById('conv-drawer-delete')?.addEventListener('click', () => {
  closeConvDrawer();
  if (!currentConv) return;
  document.getElementById('conv-delete-name').textContent = currentConv.title;
  if (convDeleteModal) convDeleteModal.hidden = false;
});

document.getElementById('conv-delete-modal-close')?.addEventListener('click', () => {
  if (convDeleteModal) convDeleteModal.hidden = true;
});

document.getElementById('conv-delete-cancel')?.addEventListener('click', () => {
  if (convDeleteModal) convDeleteModal.hidden = true;
});

document.getElementById('conv-delete-confirm')?.addEventListener('click', async () => {
  if (!currentConv) return;
  await dbDelete('conversations', currentConv.id);
  const summaries = await dbGetByIndex('summaries', 'conversationId', currentConv.id);
  for (const s of summaries) await dbDelete('summaries', s.id);
  if (convDeleteModal) convDeleteModal.hidden = true;
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED' }).catch(() => {});
  goBack();
});

// ===== Knowledge Browser =====
let allTopics = [];

async function initKnowledge() {
  document.getElementById('topic-list').innerHTML = skeletonCards(5);
  allTopics = await getAllTopicsWithCounts();
  filterTopics();
}

const topicSearch = document.getElementById('topic-search');
const topicSort = document.getElementById('topic-sort');
const topicConvsFilter = document.getElementById('topic-convs-filter');

topicSearch?.addEventListener('input', filterTopics);
topicSort?.addEventListener('change', filterTopics);
topicConvsFilter?.addEventListener('change', filterTopics);

function filterTopics() {
  const q = (topicSearch?.value || '').toLowerCase().trim();
  const sortBy = topicSort?.value || 'convs-desc';
  const sizeFilter = topicConvsFilter?.value || 'all';

  let filtered = allTopics;

  // Text search
  if (q) {
    filtered = filtered.filter(t =>
      t.name.toLowerCase().includes(q) || t.tags.some(tag => tag.toLowerCase().includes(q))
    );
  }

  // Size filter
  switch (sizeFilter) {
    case '5+': filtered = filtered.filter(t => t.summaryCount >= 5); break;
    case '3+': filtered = filtered.filter(t => t.summaryCount >= 3); break;
    case '1': filtered = filtered.filter(t => t.summaryCount === 1); break;
  }

  // Sort
  filtered = [...filtered];
  switch (sortBy) {
    case 'convs-desc': filtered.sort((a, b) => b.summaryCount - a.summaryCount); break;
    case 'convs-asc': filtered.sort((a, b) => a.summaryCount - b.summaryCount); break;
    case 'name-asc': filtered.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'name-desc': filtered.sort((a, b) => b.name.localeCompare(a.name)); break;
    case 'updated-desc': filtered.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)); break;
    case 'updated-asc': filtered.sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0)); break;
    case 'created-desc': filtered.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)); break;
    case 'created-asc': filtered.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)); break;
  }

  // Filter summary
  const summary = document.getElementById('topic-filter-summary');
  if (summary) {
    const activeFilters = [];
    if (q) activeFilters.push(`"${q}"`);
    if (sizeFilter !== 'all') activeFilters.push(sizeFilter);
    summary.textContent = activeFilters.length > 0
      ? `Showing ${formatNumber(filtered.length)} of ${formatNumber(allTopics.length)} — ${activeFilters.join(', ')}`
      : `${formatNumber(filtered.length)} topics`;
  }

  renderTopicList(filtered);
}

function renderTopicList(list) {
  const container = document.getElementById('topic-list');

  if (list.length === 0) {
    container.innerHTML = '<div class="empty-state">No topics found.</div>';
    return;
  }

  container.innerHTML = list.map(t => {
    const updated = t.updatedAt
      ? new Date(t.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    return `<div class="topic-card item-card" data-topic-id="${t.id}">
      <div class="topic-name">${escapeHtml(t.name)}</div>
      <div class="topic-meta">
        <span class="badge badge-count">${formatNumber(t.summaryCount)} conversations</span>
        ${updated ? `<span class="badge badge-count">${updated}</span>` : ''}
        ${t.tags.slice(0, 5).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ')}
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-topic-id]').forEach(card => {
    card.addEventListener('click', () => navigateTo('topic-detail', { id: card.dataset.topicId }));
  });
}

// ===== Knowledge Export Modal =====
const exportConfirmModal = document.getElementById('export-confirm-modal');

document.getElementById('knowledge-export-btn')?.addEventListener('click', () => {
  if (exportConfirmModal) exportConfirmModal.hidden = false;
});

document.getElementById('export-confirm-close')?.addEventListener('click', () => {
  if (exportConfirmModal) exportConfirmModal.hidden = true;
});

document.getElementById('export-confirm-cancel')?.addEventListener('click', () => {
  if (exportConfirmModal) exportConfirmModal.hidden = true;
});

document.getElementById('export-confirm-proceed')?.addEventListener('click', async () => {
  const btn = document.getElementById('export-confirm-proceed');
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Exporting\u2026';
  try {
    const content = await exportKnowledge('markdown', {});
    downloadFile('ai-context-bridge-export.md', content);
    try { await trackExport([], 'markdown'); } catch {}
    if (exportConfirmModal) exportConfirmModal.hidden = true;
  } catch (err) {
    alert('Export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
});

// ===== Topic Detail =====
let currentTopic = null;

async function initTopicDetail(id) {
  if (!id) return;
  document.getElementById('topic-detail-title').textContent = '\u00A0';
  document.getElementById('topic-detail-title').classList.add('skeleton');
  document.getElementById('topic-detail-meta').innerHTML = `<span class="skeleton skeleton-pill" style="width:100px"></span>`;
  document.getElementById('topic-insights').innerHTML = `<li>${skeletonLine('skeleton-line-long')}</li><li>${skeletonLine('skeleton-line-med')}</li>`;
  document.getElementById('topic-decisions').innerHTML = `<li>${skeletonLine('skeleton-line-long')}</li>`;
  document.getElementById('topic-conversations').innerHTML = skeletonCards(3);

  const detail = await getTopicDetail(id);
  if (!detail) return;
  currentTopic = detail;

  document.getElementById('topic-detail-title').classList.remove('skeleton');
  document.getElementById('topic-detail-title').textContent = detail.topic.name;
  document.getElementById('topic-detail-meta').innerHTML = `
    <span class="badge badge-count">${formatNumber(detail.summaries.length)} conversations</span>
    ${detail.topic.tags.slice(0, 8).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
  `;

  // Conversation count in card header
  const topicConvCount = document.getElementById('topic-conv-count');
  if (topicConvCount) topicConvCount.textContent = `${formatNumber(detail.summaries.length)}`;

  // Insights
  const allInsights = detail.summaries.flatMap(s => s.keyInsights || []);
  document.getElementById('topic-insights').innerHTML = allInsights.length
    ? allInsights.map(i => `<li>${renderInlineMarkdown(i)}</li>`).join('')
    : '<li class="empty-state">No insights yet</li>';

  // Decisions
  const allDecisions = detail.summaries.flatMap(s => s.decisions || []);
  document.getElementById('topic-decisions').innerHTML = allDecisions.length
    ? allDecisions.map(d => `<li>${renderInlineMarkdown(d)}</li>`).join('')
    : '<li class="empty-state">No decisions yet</li>';

  // Code
  const allCode = detail.summaries.flatMap(s => s.codeSnippets || []);
  const codeSection = document.getElementById('topic-code-section');
  if (allCode.length > 0) {
    codeSection.hidden = false;
    document.getElementById('topic-code').innerHTML = allCode.map(c =>
      `<div class="code-label">${escapeHtml(c.description || c.language || '')}</div><pre class="code-block">${escapeHtml(c.code)}</pre>`
    ).join('');
  } else {
    codeSection.hidden = true;
  }

  // Conversations
  const convContainer = document.getElementById('topic-conversations');
  const convIds = detail.summaries.map(s => s.conversationId);
  const convs = [];
  for (const cid of convIds) {
    const c = await dbGet('conversations', cid);
    if (c) convs.push(c);
  }
  convContainer.innerHTML = convs.map(c => `
    <div class="item-card" data-conv-id="${c.id}">
      <div class="item-title">${escapeHtml(c.title)}</div>
      <div class="item-meta">
        <span class="badge badge-source" style="background:${sourceColor(c.source)}">${sourceLabel(c.source)}</span>
      </div>
    </div>
  `).join('');
  convContainer.querySelectorAll('[data-conv-id]').forEach(card => {
    card.addEventListener('click', () => navigateTo('conversation-detail', { id: card.dataset.convId }));
  });
}

// Topic more options — bottom drawer
const topicDrawer = document.getElementById('topic-drawer');

function openTopicDrawer() {
  if (topicDrawer) topicDrawer.hidden = false;
}

function closeTopicDrawer() {
  if (topicDrawer) topicDrawer.hidden = true;
}

document.getElementById('topic-more-btn')?.addEventListener('click', openTopicDrawer);
document.getElementById('topic-drawer-close')?.addEventListener('click', closeTopicDrawer);

// Close drawer when clicking overlay
topicDrawer?.addEventListener('click', (e) => {
  if (e.target === topicDrawer) closeTopicDrawer();
});

// Drawer: Export
document.getElementById('drawer-export')?.addEventListener('click', async () => {
  closeTopicDrawer();
  if (!currentTopic) return;
  const content = await exportKnowledge('claude', { topicIds: [currentTopic.topic.id] });
  const name = sanitizeFilename(currentTopic.topic.name) || 'topic';
  downloadFile(`${name}.md`, content);
});

// Drawer: Rename — open rename modal
const topicRenameModal = document.getElementById('topic-rename-modal');
const topicRenameInput = document.getElementById('topic-rename-input');

document.getElementById('drawer-rename')?.addEventListener('click', () => {
  closeTopicDrawer();
  if (!currentTopic) return;
  if (topicRenameInput) topicRenameInput.value = currentTopic.topic.name;
  if (topicRenameModal) topicRenameModal.hidden = false;
  setTimeout(() => topicRenameInput?.select(), 50);
});

document.getElementById('topic-rename-modal-close')?.addEventListener('click', () => {
  if (topicRenameModal) topicRenameModal.hidden = true;
});

document.getElementById('topic-rename-cancel')?.addEventListener('click', () => {
  if (topicRenameModal) topicRenameModal.hidden = true;
});

document.getElementById('topic-rename-save')?.addEventListener('click', async () => {
  if (!currentTopic || !topicRenameInput) return;
  const newName = topicRenameInput.value.trim();
  if (newName && newName !== currentTopic.topic.name) {
    await renameTopic(currentTopic.topic.id, newName);
    if (topicRenameModal) topicRenameModal.hidden = true;
    await initTopicDetail(currentTopic.topic.id);
  } else {
    if (topicRenameModal) topicRenameModal.hidden = true;
  }
});

// Drawer: Delete — show confirmation modal
const topicDeleteModal = document.getElementById('topic-delete-modal');

document.getElementById('drawer-delete')?.addEventListener('click', () => {
  closeTopicDrawer();
  if (!currentTopic) return;
  document.getElementById('topic-delete-name').textContent = currentTopic.topic.name;
  if (topicDeleteModal) topicDeleteModal.hidden = false;
});

document.getElementById('topic-delete-modal-close')?.addEventListener('click', () => {
  if (topicDeleteModal) topicDeleteModal.hidden = true;
});

document.getElementById('topic-delete-cancel')?.addEventListener('click', () => {
  if (topicDeleteModal) topicDeleteModal.hidden = true;
});

document.getElementById('topic-delete-confirm')?.addEventListener('click', async () => {
  if (!currentTopic) return;
  await deleteTopic(currentTopic.topic.id);
  if (topicDeleteModal) topicDeleteModal.hidden = true;
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED' }).catch(() => {});
  goBack();
});

document.getElementById('topic-export-btn')?.addEventListener('click', async () => {
  if (!currentTopic) return;
  const content = await exportKnowledge('claude', { topicIds: [currentTopic.topic.id] });
  const name = sanitizeFilename(currentTopic.topic.name) || 'topic';
  downloadFile(`${name}.md`, content);
});

// ===== Export =====
async function initExport() {
  const scopeRadios = document.querySelectorAll('input[name="export-scope"]');
  const topicSelect = document.getElementById('export-topic-select');

  scopeRadios.forEach(r => r.addEventListener('change', async () => {
    if (r.value === 'selected' && r.checked) {
      topicSelect.hidden = false;
      const topics = await dbGetAll('topics');
      topicSelect.innerHTML = topics.map(t =>
        `<label><input type="checkbox" value="${t.id}"> ${escapeHtml(t.name)}</label>`
      ).join('');
    } else if (r.value === 'all' && r.checked) {
      topicSelect.hidden = true;
    }
  }));
}

document.getElementById('export-download-btn')?.addEventListener('click', async () => {
  const target = document.querySelector('input[name="export-target"]:checked')?.value || 'markdown';
  const scope = document.querySelector('input[name="export-scope"]:checked')?.value || 'all';

  let topicIds = null;
  if (scope === 'selected') {
    topicIds = [...document.querySelectorAll('#export-topic-select input:checked')].map(cb => cb.value);
  }

  const options = {
    topicIds,
    includeInsights: document.getElementById('export-insights').checked,
    includeCode: document.getElementById('export-code').checked,
    includeDecisions: document.getElementById('export-decisions').checked,
    includeRaw: document.getElementById('export-raw').checked,
  };

  try {
    const content = await exportKnowledge(target, options);
    const ext = target === 'json' ? 'json' : 'md';
    downloadFile(`ai-context-bridge-export.${ext}`, content);
    try { await trackExport(topicIds || [], target); } catch {}
  } catch (err) {
    alert('Export failed: ' + err.message);
  }
});

// ===== Settings =====
let editingProviderId = null;

async function initSettings() {
  await renderProviderList();
  updateEmbeddingsStatus();

  // Storage stats
  const convCount = await dbCount('conversations');
  const sumCount = await dbCount('summaries');
  const topicCount = await dbCount('topics');
  document.getElementById('storage-stats').innerHTML = `
    <div class="settings-stat-row"><span class="settings-stat-label">Conversations</span><span class="settings-stat-value">${formatNumber(convCount)}</span></div>
    <div class="settings-stat-row"><span class="settings-stat-label">Summaries</span><span class="settings-stat-value">${formatNumber(sumCount)}</span></div>
    <div class="settings-stat-row"><span class="settings-stat-label">Topics</span><span class="settings-stat-value">${formatNumber(topicCount)}</span></div>
  `;

  // Embeddings stats
  const embCount = await dbCount('embeddings');
  const embStats = document.getElementById('embeddings-stats');
  if (embStats) {
    embStats.textContent = embCount > 0 ? `${formatNumber(embCount)} summaries embedded` : 'No summaries embedded yet';
  }
}

async function renderProviderList() {
  const providers = await getProviders();
  const container = document.getElementById('provider-list');
  if (!container) return;

  if (providers.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:0.5rem">No providers configured yet.</div>';
    return;
  }

  container.innerHTML = providers.map((p, idx) => `
    <div class="provider-card provider-${p.type} ${p.isEnabled ? '' : 'disabled'}" data-provider-id="${p.id}">
      <label class="provider-toggle">
        <input type="checkbox" ${p.isEnabled ? 'checked' : ''} data-toggle-id="${p.id}">
        <span class="toggle-slider"></span>
      </label>
      <div class="provider-info">
        <div class="provider-name">${escapeHtml(p.name)}</div>
        <div class="provider-meta">${p.type} &middot; ${p.defaultModel}</div>
      </div>
      <div class="provider-actions">
        ${idx > 0 ? `<button data-move-up="${p.id}" title="Move up">&#9650;</button>` : ''}
        ${idx < providers.length - 1 ? `<button data-move-down="${p.id}" title="Move down">&#9660;</button>` : ''}
        <button data-edit-id="${p.id}" title="Edit">&#9998;</button>
        <button data-delete-id="${p.id}" title="Delete">&#10005;</button>
      </div>
    </div>
  `).join('');

  // Toggle handlers
  container.querySelectorAll('[data-toggle-id]').forEach(toggle => {
    toggle.addEventListener('change', async () => {
      const providers = await getProviders();
      const p = providers.find(p => p.id === toggle.dataset.toggleId);
      if (p) { p.isEnabled = toggle.checked; await saveProviders(providers); }
      await renderProviderList();
    });
  });

  // Move handlers
  container.querySelectorAll('[data-move-up]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const providers = await getProviders();
      const idx = providers.findIndex(p => p.id === btn.dataset.moveUp);
      if (idx > 0) {
        [providers[idx - 1].priority, providers[idx].priority] = [providers[idx].priority, providers[idx - 1].priority];
        await saveProviders(providers);
        await renderProviderList();
      }
    });
  });

  container.querySelectorAll('[data-move-down]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const providers = await getProviders();
      const idx = providers.findIndex(p => p.id === btn.dataset.moveDown);
      if (idx < providers.length - 1) {
        [providers[idx].priority, providers[idx + 1].priority] = [providers[idx + 1].priority, providers[idx].priority];
        await saveProviders(providers);
        await renderProviderList();
      }
    });
  });

  // Edit handlers
  container.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const providers = await getProviders();
      const p = providers.find(p => p.id === btn.dataset.editId);
      if (p) openProviderModal(p);
    });
  });

  // Delete handlers
  container.querySelectorAll('[data-delete-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this provider?')) return;
      const providers = await getProviders();
      const filtered = providers.filter(p => p.id !== btn.dataset.deleteId);
      await saveProviders(filtered);
      await renderProviderList();
    });
  });
}

function openProviderModal(provider = null) {
  const modal = document.getElementById('provider-modal');
  const title = document.getElementById('provider-modal-title');
  const typeSelect = document.getElementById('provider-type-select');
  const nameInput = document.getElementById('provider-name-input');
  const urlInput = document.getElementById('provider-url-input');
  const keyInput = document.getElementById('provider-key-input');
  const modelSelect = document.getElementById('provider-model-select');
  const matterInput = document.getElementById('provider-matter-input');
  const status = document.getElementById('provider-modal-status');

  editingProviderId = provider?.id || null;
  title.textContent = provider ? 'Edit Provider' : 'Add Provider';
  status.textContent = '';

  if (provider) {
    typeSelect.value = provider.type;
    typeSelect.disabled = true;
    nameInput.value = provider.name;
    urlInput.value = provider.baseUrl;
    keyInput.value = provider.apiKey;
    matterInput.value = provider.extra?.matterId || '';
    updateProviderModelOptions(provider.type, provider.defaultModel);
  } else {
    typeSelect.value = 'openai';
    typeSelect.disabled = false;
    applyProviderDefaults('openai');
  }

  updateProviderUrlVisibility(typeSelect.value);
  updateProviderMatterVisibility(typeSelect.value);
  modal.hidden = false;
}

function applyProviderDefaults(type) {
  const defaults = PROVIDER_DEFAULTS[type];
  if (!defaults) return;
  document.getElementById('provider-name-input').value = defaults.name;
  document.getElementById('provider-url-input').value = defaults.baseUrl;
  document.getElementById('provider-key-input').value = '';
  document.getElementById('provider-matter-input').value = '';
  updateProviderModelOptions(type);
  updateProviderUrlVisibility(type);
  updateProviderMatterVisibility(type);
}

function updateProviderModelOptions(type, selectedModel) {
  const select = document.getElementById('provider-model-select');
  const defaults = PROVIDER_DEFAULTS[type];
  if (!defaults) return;
  select.innerHTML = defaults.models.map(m =>
    `<option value="${m}" ${m === selectedModel ? 'selected' : ''}>${m}</option>`
  ).join('');
}

function updateProviderUrlVisibility(type) {
  const row = document.getElementById('provider-url-row');
  // Show URL for Lana (user must enter), hide for others (preset)
  row.style.display = type === 'lana' ? 'flex' : 'none';
}

function updateProviderMatterVisibility(type) {
  document.getElementById('provider-matter-row').hidden = type !== 'lana';
}

document.getElementById('provider-type-select')?.addEventListener('change', (e) => {
  applyProviderDefaults(e.target.value);
});

document.getElementById('add-provider-btn')?.addEventListener('click', () => {
  openProviderModal();
});

document.getElementById('provider-modal-close')?.addEventListener('click', () => {
  document.getElementById('provider-modal').hidden = true;
});

document.getElementById('provider-test-btn')?.addEventListener('click', async () => {
  const status = document.getElementById('provider-modal-status');
  const type = document.getElementById('provider-type-select').value;
  const defaults = PROVIDER_DEFAULTS[type];

  const config = {
    type,
    baseUrl: type === 'lana' ? document.getElementById('provider-url-input').value.trim() : defaults.baseUrl,
    apiKey: document.getElementById('provider-key-input').value.trim(),
    defaultModel: document.getElementById('provider-model-select').value,
    extra: { matterId: document.getElementById('provider-matter-input').value.trim() || undefined },
  };

  status.textContent = 'Testing...';
  status.className = 'status-text loading';

  const result = await testProvider(config);
  if (result.ok) {
    status.textContent = `Connected (${result.latencyMs}ms)`;
    status.className = 'status-text success';
  } else {
    status.textContent = `Failed: ${result.error}`;
    status.className = 'status-text error';
  }
});

document.getElementById('provider-save-btn')?.addEventListener('click', async () => {
  const type = document.getElementById('provider-type-select').value;
  const defaults = PROVIDER_DEFAULTS[type];
  const name = document.getElementById('provider-name-input').value.trim();
  const apiKey = document.getElementById('provider-key-input').value.trim();
  const model = document.getElementById('provider-model-select').value;
  const baseUrl = type === 'lana'
    ? document.getElementById('provider-url-input').value.trim()
    : defaults.baseUrl;
  const matterId = document.getElementById('provider-matter-input').value.trim();

  if (!name) { alert('Provider name is required.'); return; }
  if (!apiKey) { alert('API key is required.'); return; }
  if (type === 'lana' && !baseUrl) { alert('Base URL is required for Lana AI.'); return; }

  // Request optional host permissions for Lana (non-standard URLs)
  if (type === 'lana' && baseUrl) {
    try {
      const urlObj = new URL(baseUrl);
      const origin = `${urlObj.protocol}//${urlObj.host}/*`;
      await chrome.permissions.request({ origins: [origin] });
    } catch {
      // Permission request failed or was denied — still save
    }
  }

  const providers = await getProviders();

  if (editingProviderId) {
    const existing = providers.find(p => p.id === editingProviderId);
    if (existing) {
      existing.name = name;
      existing.apiKey = apiKey;
      existing.defaultModel = model;
      existing.baseUrl = baseUrl;
      existing.models = defaults.models;
      existing.extra = { matterId: matterId || undefined };
    }
  } else {
    const maxPriority = providers.reduce((max, p) => Math.max(max, p.priority), 0);
    providers.push({
      id: crypto.randomUUID(),
      name,
      type,
      baseUrl,
      apiKey,
      models: defaults.models,
      defaultModel: model,
      isEnabled: true,
      priority: maxPriority + 1,
      extra: { matterId: matterId || undefined },
    });
  }

  await saveProviders(providers);
  document.getElementById('provider-modal').hidden = true;
  await renderProviderList();
});

function updateEmbeddingsStatus() {
  const dot = document.getElementById('embeddings-status-dot');
  const text = document.getElementById('embeddings-status-text');
  if (!dot || !text) return;

  if (isModelLoaded()) {
    dot.className = 'status-dot loaded';
    text.textContent = 'Model loaded';
  } else if (isModelLoading()) {
    dot.className = 'status-dot loading';
    text.textContent = 'Loading model...';
  } else {
    dot.className = 'status-dot';
    text.textContent = 'Not loaded';
  }
}

// Clear all data — show confirmation modal
const clearDataModal = document.getElementById('clear-data-modal');

document.getElementById('clear-all-btn')?.addEventListener('click', () => {
  if (clearDataModal) clearDataModal.hidden = false;
});

document.getElementById('clear-data-modal-close')?.addEventListener('click', () => {
  if (clearDataModal) clearDataModal.hidden = true;
});

document.getElementById('clear-data-cancel')?.addEventListener('click', () => {
  if (clearDataModal) clearDataModal.hidden = true;
});

document.getElementById('clear-data-confirm')?.addEventListener('click', async () => {
  await dbClear('conversations');
  await dbClear('summaries');
  await dbClear('topics');
  await dbClear('embeddings');
  await dbClear('embeddingQueue');
  if (clearDataModal) clearDataModal.hidden = true;
  // Notify content scripts to clear cached results
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED' }).catch(() => {});
  await initSettings();
});

document.getElementById('backup-btn')?.addEventListener('click', async () => {
  const convs = await dbGetAll('conversations');
  const sums = await dbGetAll('summaries');
  const topics = await dbGetAll('topics');
  const backup = { version: '1.0', exportedAt: new Date().toISOString(), conversations: convs, summaries: sums, topics };
  downloadFile('ai-context-bridge-backup.json', JSON.stringify(backup, null, 2));
});

document.getElementById('restore-btn')?.addEventListener('click', () => {
  document.getElementById('restore-input').click();
});

document.getElementById('restore-input')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data.conversations) await dbPutBatch('conversations', data.conversations);
    if (data.summaries) await dbPutBatch('summaries', data.summaries);
    if (data.topics) await dbPutBatch('topics', data.topics);
    alert(`Restored ${data.conversations?.length || 0} conversations, ${data.summaries?.length || 0} summaries, ${data.topics?.length || 0} topics.`);
    await initSettings();
  } catch (err) {
    alert('Restore failed: ' + err.message);
  }
});

// ===== Injection Context Resolution =====
/**
 * Resolve injection context from a conversation's metadata for lineage-aware
 * summarization. Returns null if no injection context exists.
 */
async function resolveInjectionContext(conversation) {
  const ctx = conversation.metadata?.injectionContext;
  if (!Array.isArray(ctx) || ctx.length === 0) return null;
  const resolved = [];
  for (const item of ctx) {
    const summary = await dbGet('summaries', item.summaryId);
    resolved.push({
      summaryId: item.summaryId,
      topicId: item.topicId || (summary?.topicId || null),
      title: summary?.title || item.summaryId,
    });
  }
  return resolved;
}

// ===== Batch Summarization =====
let isSummarizing = false;
let cancelSummarization = false;

const summarizePlatform = document.getElementById('summarize-platform');
const summarizeDateFrom = document.getElementById('summarize-date-from');
const summarizeDateTo = document.getElementById('summarize-date-to');

summarizePlatform?.addEventListener('change', updateSummarizeButton);
summarizeDateFrom?.addEventListener('change', updateSummarizeButton);
summarizeDateTo?.addEventListener('change', updateSummarizeButton);

// Populate platform dropdown with only imported sources
async function populateSummarizePlatforms() {
  if (!summarizePlatform) return;
  const convs = await dbGetAll('conversations');
  const sources = [...new Set(convs.map(c => c.source).filter(Boolean))].sort();
  summarizePlatform.innerHTML = '<option value="all">All Platforms</option>' +
    sources.map(src => `<option value="${src}">${sourceLabel(src)}</option>`).join('');
}

async function getFilteredPending() {
  const convs = await dbGetAll('conversations');
  const summaries = await dbGetAll('summaries');
  const summarizedIds = new Set(summaries.map(s => s.conversationId));
  let pending = convs.filter(c => !summarizedIds.has(c.id));

  const platform = summarizePlatform?.value || 'all';
  if (platform !== 'all') pending = pending.filter(c => c.source === platform);

  const from = summarizeDateFrom?.value || null;
  const to = summarizeDateTo?.value || null;
  if (from) pending = pending.filter(c => c.createdAt && c.createdAt >= from);
  if (to) pending = pending.filter(c => c.createdAt && c.createdAt <= to + 'T23:59:59');

  return pending;
}

async function updateSummarizeButton() {
  if (isSummarizing) return;
  const btn = document.getElementById('dashboard-summarize-btn');
  if (!btn) return;

  const hasProvider = await hasEnabledProvider();
  if (!hasProvider) {
    btn.textContent = 'Add a Provider to Summarize';
    btn.disabled = false;
    btn.onclick = btn.onclick || null;
    btn._noProvider = true;
    return;
  }
  btn._noProvider = false;

  const pending = await getFilteredPending();
  const platform = summarizePlatform?.value || 'all';
  const platLabel = platform === 'all' ? '' : ` ${sourceLabel(platform)}`;

  btn.textContent = pending.length > 0
    ? `Summarize ${formatNumber(pending.length)}${platLabel} Pending`
    : `All${platLabel} Summarized`;
  btn.disabled = pending.length === 0;
}

document.getElementById('dashboard-summarize-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('dashboard-summarize-btn');

  // No provider — go to settings
  if (btn._noProvider) {
    navigateTo('settings');
    return;
  }

  // If already running, cancel
  if (isSummarizing) {
    cancelSummarization = true;
    btn.textContent = 'Stopping...';
    return;
  }

  const hasProvider = await hasEnabledProvider();
  if (!hasProvider) { navigateTo('settings'); return; }

  const pending = await getFilteredPending();

  if (pending.length === 0) return;

  const BATCH = 5;
  let done = 0;
  let failed = 0;

  isSummarizing = true;
  cancelSummarization = false;
  btn.textContent = 'Stop Summarizing';
  btn.classList.add('btn-stop');

  for (let i = 0; i < pending.length; i += BATCH) {
    if (cancelSummarization) break;

    const batch = pending.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (conv) => {
        const injCtx = await resolveInjectionContext(conv);
        const summary = await summarizeConversation(conv, { injectionContext: injCtx });
        await dbPut('summaries', summary);
        const forceTopicId = injCtx?.[0]?.topicId || null;
        await assignToTopic(summary, { forceTopicId });
        // Embed the new summary
        await embedSummary(summary);
        return summary;
      })
    );
    done += results.filter(r => r.status === 'fulfilled').length;
    failed += results.filter(r => r.status === 'rejected').length;
    btn.textContent = `Stop (${formatNumber(done)}/${formatNumber(pending.length)})`;

    if (i + BATCH < pending.length && !cancelSummarization) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  isSummarizing = false;
  btn.classList.remove('btn-stop');

  if (cancelSummarization) {
    btn.textContent = `Stopped: ${formatNumber(done)}/${formatNumber(pending.length)} summarized`;
  } else {
    btn.textContent = `Done! ${formatNumber(done)} summarized${failed ? `, ${failed} failed` : ''}`;
  }

  cancelSummarization = false;
  setTimeout(() => initDashboard(), 2000);
});

// ===== Conflicts (merged into analytics) =====
let allConflicts = [];

// ===== Conflict Detail =====
let currentConflict = null;

async function initConflictDetail(id) {
  const conflicts = await getOpenConflicts();
  currentConflict = conflicts.find(c => c.id === id);
  if (!currentConflict) {
    // Check resolved/dismissed too
    const { conflicts: all = [] } = await chrome.storage.local.get('conflicts');
    currentConflict = all.find(c => c.id === id);
  }
  if (!currentConflict) return;

  const severityColors = { high: '#dc2626', medium: '#d97706', low: '#6b7280' };
  document.getElementById('conflict-detail-meta').innerHTML = `
    <span class="badge" style="background:${severityColors[currentConflict.severity || 'medium']};color:#fff">${currentConflict.severity || 'medium'}</span>
    <span class="badge badge-count">${currentConflict.type?.replace('_', ' ') || 'conflict'}</span>
    <span class="badge badge-count">${currentConflict.status || 'open'}</span>
  `;

  document.getElementById('conflict-older-content').textContent = currentConflict.olderContent || '';
  document.getElementById('conflict-newer-content').textContent = currentConflict.newerContent || '';
  document.getElementById('conflict-analysis').innerHTML = currentConflict.analysis
    ? `<div class="card"><h4>Analysis</h4><p>${escapeHtml(currentConflict.analysis)}</p></div>` : '';
  document.getElementById('conflict-recommendation').innerHTML = currentConflict.recommendation
    ? `<div class="card"><h4>Recommendation</h4><p>${escapeHtml(currentConflict.recommendation)}</p></div>` : '';
}

document.getElementById('conflict-keep-newer')?.addEventListener('click', async () => {
  if (!currentConflict) return;
  await resolveConflict(currentConflict.id, 'keep_newer');
  goBack();
});
document.getElementById('conflict-keep-older')?.addEventListener('click', async () => {
  if (!currentConflict) return;
  await resolveConflict(currentConflict.id, 'keep_older');
  goBack();
});
document.getElementById('conflict-keep-both')?.addEventListener('click', async () => {
  if (!currentConflict) return;
  await resolveConflict(currentConflict.id, 'keep_both');
  goBack();
});
document.getElementById('conflict-dismiss')?.addEventListener('click', async () => {
  if (!currentConflict) return;
  await dismissConflict(currentConflict.id);
  goBack();
});

// ===== Analytics =====
async function initAnalytics() {
  // Show skeletons
  document.getElementById('health-score').textContent = '\u00A0\u00A0';
  document.getElementById('health-score').classList.add('skeleton');
  document.getElementById('health-used').textContent = '\u00A0\u00A0\u00A0\u00A0';
  document.getElementById('health-used').classList.add('skeleton');
  document.getElementById('trending-list').innerHTML = skeletonCards(3);
  document.getElementById('stale-list').innerHTML = skeletonCards(3);
  document.getElementById('usage-by-source').innerHTML = skeletonCards(2);

  try {
    // Knowledge Health
    const health = await getKnowledgeHealth();
    document.getElementById('health-score').classList.remove('skeleton');
    document.getElementById('health-used').classList.remove('skeleton');
    document.getElementById('health-score').textContent = health.score;
    document.getElementById('health-used').textContent = `${formatNumber(health.usedSummaries)} / ${formatNumber(health.totalSummaries)}`;
    document.getElementById('health-recommendation').textContent = health.recommendation || '';

    // Trending
    const trending = await getTrending(7);
    const trendContainer = document.getElementById('trending-list');
    if (trending.length === 0) {
      trendContainer.innerHTML = '<div class="empty-state">No trending data yet. Use your knowledge (inject, copy, export) to see trends.</div>';
    } else {
      trendContainer.innerHTML = trending.slice(0, 5).map(t => {
        const arrow = t.trend === 'rising' ? '&#9650;' : t.trend === 'declining' ? '&#9660;' : '&#9679;';
        const color = t.trend === 'rising' ? '#16a34a' : t.trend === 'declining' ? '#dc2626' : '#6b7280';
        const convId = t.conversationId || '';
        return `<div class="item-card" ${convId ? `data-conv-id="${convId}"` : ''}>
          <div class="item-title">${escapeHtml(t.title || 'Untitled')}</div>
          <div class="item-meta"><span style="color:${color}">${arrow} ${t.trend}</span> &middot; ${t.recentUsage} uses (7d)</div>
        </div>`;
      }).join('');
      trendContainer.querySelectorAll('[data-conv-id]').forEach(card => {
        card.addEventListener('click', () => navigateTo('conversation-detail', { id: card.dataset.convId }));
      });
    }

    // Stale
    const stale = await getStale(30);
    const staleContainer = document.getElementById('stale-list');
    if (stale.length === 0) {
      staleContainer.innerHTML = '<div class="empty-state">No stale knowledge</div>';
    } else {
      staleContainer.innerHTML = stale.slice(0, 5).map(s => {
        const staleMeta = s.daysSinceUse === Infinity
          ? 'Never used'
          : `${formatNumber(s.daysSinceUse)} days since last use`;
        const convId = s.conversationId || '';
        return `<div class="item-card" ${convId ? `data-conv-id="${convId}"` : ''}>
          <div class="item-title">${escapeHtml(s.title || 'Untitled')}</div>
          <div class="item-meta">${staleMeta}</div>
        </div>`;
      }).join('');
      staleContainer.querySelectorAll('[data-conv-id]').forEach(card => {
        card.addEventListener('click', () => navigateTo('conversation-detail', { id: card.dataset.convId }));
      });
    }

    // Usage by source
    const bySource = await getUsageBySource();
    const sourceContainer = document.getElementById('usage-by-source');
    const entries = Object.entries(bySource);
    sourceContainer.innerHTML = entries.length === 0
      ? '<div class="empty-state">No usage data yet</div>'
      : entries.map(([src, data]) => {
        const parts = [];
        if (data.injections) parts.push(`${data.injections} injections`);
        if (data.copies) parts.push(`${data.copies} copies`);
        if (data.exports) parts.push(`${data.exports} exports`);
        if (data.views) parts.push(`${data.views} views`);
        if (data.searchHits) parts.push(`${data.searchHits} search hits`);
        const total = (data.injections || 0) + (data.views || 0) + (data.exports || 0) + (data.copies || 0) + (data.searchHits || 0);
        return `<div class="source-usage-row">
          <div class="source-usage-header">
            <span class="badge badge-source" style="background:${sourceColor(src)}">${sourceLabel(src)}</span>
            <span class="source-usage-total">${formatNumber(total)} actions</span>
          </div>
          ${parts.length > 0 ? `<div class="source-usage-detail">${parts.join(' · ')}</div>` : ''}
        </div>`;
      }).join('');

    // Conflicts (merged into analytics)
    try {
      const conflictStats = await getConflictStats();
      document.getElementById('conflict-open').textContent = formatNumber(conflictStats.open);
      document.getElementById('conflict-open-count').textContent = formatNumber(conflictStats.open);
      document.getElementById('conflict-resolved').textContent = formatNumber(conflictStats.resolved);

      allConflicts = await getOpenConflicts();
      const conflictContainer = document.getElementById('conflict-list');

      if (allConflicts.length === 0) {
        conflictContainer.innerHTML = '<div class="empty-state">No open conflicts</div>';
      } else {
        conflictContainer.innerHTML = allConflicts.map(c => {
          const severity = c.severity || 'medium';
          const severityColors = { high: '#dc2626', medium: '#d97706', low: '#6b7280' };
          return `<div class="item-card" data-conflict-id="${c.id}">
            <div class="item-title">${escapeHtml(c.olderContent?.slice(0, 60) || 'Conflict')}</div>
            <div class="item-meta">
              <span class="badge" style="background:${severityColors[severity]};color:#fff">${severity}</span>
              <span class="badge badge-count">${c.type?.replace('_', ' ') || 'conflict'}</span>
            </div>
          </div>`;
        }).join('');

        conflictContainer.querySelectorAll('[data-conflict-id]').forEach(card => {
          card.addEventListener('click', () => navigateTo('conflict-detail', { id: card.dataset.conflictId }));
        });
      }
    } catch { /* conflicts module may not be loaded yet */ }

  } catch (err) {
    console.error('Analytics init error:', err);
  }
}

// Conflict scan button (inside analytics)
document.getElementById('conflict-scan-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('conflict-scan-btn');
  btn.textContent = 'Scanning\u2026';
  btn.disabled = true;
  try {
    const result = await runFullScan();
    btn.textContent = `${result.conflicts.length} found`;
    setTimeout(() => { btn.textContent = 'Scan'; btn.disabled = false; }, 3000);
    await initAnalytics();
  } catch (err) {
    btn.textContent = 'Failed';
    btn.disabled = false;
    alert('Scan error: ' + err.message);
  }
});

// ===== Analytics Info Toggles =====
document.querySelectorAll('.info-btn[data-info]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const box = document.getElementById(`info-${btn.dataset.info}`);
    if (box) box.hidden = !box.hidden;
  });
});

// ===== Embedding Helpers =====

/**
 * Embed a single summary and store the vector in IndexedDB.
 */
async function embedSummary(summary) {
  if (!isModelLoaded()) return;
  try {
    const text = [
      summary.title || '',
      summary.summary || '',
      ...(summary.keyInsights || []),
      ...(summary.decisions || []),
      ...(summary.tags || []),
    ].join(' ');

    const [vector] = await embed([text]);
    await dbPut('embeddings', {
      id: generateId(),
      summaryId: summary.id,
      type: 'summary',
      vector,
      text: text.slice(0, 500),
      createdAt: new Date().toISOString(),
      modelVersion: 'all-MiniLM-L6-v2',
    });
  } catch {
    // Embedding failed — non-critical
  }
}

/**
 * Batch embed all summaries that don't have embeddings yet.
 */
async function batchEmbedMissing() {
  if (!isModelLoaded()) return;
  try {
    const summaries = await dbGetAll('summaries');
    const existingEmbeddings = await dbGetAll('embeddings');
    const embeddedIds = new Set(
      existingEmbeddings.filter(e => e.type === 'summary').map(e => e.summaryId)
    );
    const missing = summaries.filter(s => !embeddedIds.has(s.id));

    for (const summary of missing) {
      await embedSummary(summary);
    }

    if (missing.length > 0) {
      console.log(`[Embeddings] Batch embedded ${missing.length} summaries`);
    }
  } catch (err) {
    console.error('[Embeddings] Batch embed error:', err);
  }
}

// ===== Conversation Embedding Pipeline =====

/**
 * Prepare text from a conversation for embedding.
 * Combines title + last 8 messages, truncated to ~1000 chars.
 */
function prepareConversationText(conv) {
  const parts = [conv.title || ''];
  const msgs = conv.messages || [];
  const recent = msgs.slice(-8);
  for (const msg of recent) {
    parts.push(`${msg.role}: ${msg.content}`);
  }
  return parts.join('\n').slice(0, 1000);
}

/**
 * Embed a single conversation and store the vector in IndexedDB.
 */
async function embedConversation(conv) {
  if (!isModelLoaded()) return;
  try {
    const text = prepareConversationText(conv);
    const [vector] = await embed([text]);
    await dbPut('embeddings', {
      id: `conv-emb:${conv.id}`,
      conversationId: conv.id,
      type: 'conversation',
      vector,
      text: text.slice(0, 500),
      createdAt: new Date().toISOString(),
      modelVersion: 'all-MiniLM-L6-v2',
    });
  } catch {
    // Embedding failed — non-critical
  }
}

/**
 * Process the embedding queue: embed all queued conversations, then remove them.
 */
async function processEmbeddingQueue() {
  if (!isModelLoaded()) return;
  try {
    const queue = await dbGetAll('embeddingQueue');
    if (queue.length === 0) return;

    console.log(`[Embeddings] Processing ${queue.length} queued conversations`);
    for (const entry of queue) {
      const conv = await dbGet('conversations', entry.conversationId);
      if (conv) {
        await embedConversation(conv);
      }
      await dbDelete('embeddingQueue', entry.id);
    }
    console.log(`[Embeddings] Queue processing complete`);
  } catch (err) {
    console.error('[Embeddings] Queue processing error:', err);
  }
}

// Listen for CONVERSATION_CAPTURED to embed immediately when sidepanel is open
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CONVERSATION_CAPTURED' && isModelLoaded()) {
    dbGet('conversations', message.conversationId).then(conv => {
      if (conv) embedConversation(conv);
    }).then(() => {
      // Remove from queue since we embedded it
      dbDelete('embeddingQueue', `conv:${message.conversationId}`).catch(() => {});
    }).catch(() => {});
  }
});

// ===== Sticky filter shadow on scroll =====
const stickyEl = document.querySelector('.sticky-filters');
if (stickyEl) {
  const io = new IntersectionObserver(
    ([e]) => stickyEl.classList.toggle('is-stuck', e.intersectionRatio < 1),
    { threshold: [1], rootMargin: '-1px 0px 0px 0px' }
  );
  io.observe(stickyEl);
}

// ===== Init =====
initDashboard();

// Start loading embeddings model in the background
initEmbeddings().then(async loaded => {
  if (loaded) {
    console.log('[Embeddings] Model loaded successfully');
    await batchEmbedMissing();
    await processEmbeddingQueue();
  } else {
    console.log('[Embeddings] Model not available — using keyword-only scoring');
  }
});
