/**
 * @fileoverview LANA AI — new UI shell controller ("holo tab" redesign).
 *
 * Owns the charcoal agentic side panel (`.lana-shell`): the Agent home + `/#@`
 * composer, Playbooks, Captured (→ matter filing = Phase 2 grounding), History,
 * the redesigned Settings, and first-run onboarding.
 *
 * Deliberately separate from the legacy `sidepanel.js` (which still powers the
 * dashboard/analytics/knowledge views, reachable via "Advanced"). This module
 * talks to the same backends directly — `lana-connect.js` for account/auth,
 * the SW for matters/ingestion, and IndexedDB for captured data — so it never
 * collides with sidepanel.js over shared element IDs.
 *
 * @module sidepanel/lana-ui
 */

import { getEnv, defaultInstance } from '../lib/env.js';
import { dbGetAll, dbCount } from '../lib/db.js';
import {
  mountConnect, getState, getInstanceInfo,
  connectViaOAuth, disconnect,
} from './lana-connect.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const shell = $('#lana-shell');
const MAX_COMPOSER = 8000; // cap composer length (pasted content included)

/** Cached instance URL — preloaded so OAuth's permission request keeps the click gesture. */
let instanceUrlValue = '';
/** Cached auth state. */
let authState = { authenticated: false };

/* ============================ view router ============================== */

const HOME = 'agent';
let currentView = HOME;

function showView(name) {
  $$('.l-view', shell).forEach((v) => v.classList.toggle('on', v.dataset.lview === name));
  currentView = name;
  shell.scrollTop = 0;
  if (name === 'settings') renderSettings();
  if (name === 'captured') renderCaptured();
  if (name === 'history') renderHistory();
  if (name === 'playbooks') renderPlaybooks();
}

function wireRouter() {
  $$('[data-lnav]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.lnav)));
  $$('[data-lback]').forEach((b) => b.addEventListener('click', () => showView(HOME)));
  $('#l-new')?.addEventListener('click', resetAgent);
}

/* ---- Legacy "Advanced" escape hatch: hide the shell, reveal legacy views,
        and float a "Back to LANA" pill to return. ---- */
let restorePill = null;
function openLegacy(navName) {
  shell.style.display = 'none';
  if (!restorePill) {
    restorePill = document.createElement('button');
    restorePill.textContent = '‹ Back to LANA';
    restorePill.style.cssText =
      'position:fixed;top:10px;left:10px;z-index:9999;background:#3067ff;color:#fff;' +
      'border:none;border-radius:999px;padding:7px 13px;font:600 12px -apple-system,sans-serif;' +
      'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    restorePill.addEventListener('click', () => {
      restorePill.hidden = true;
      shell.style.display = '';
      window.__lanaStopLegacyPolling?.(); // legacy dashboard may have started polling while visible
    });
    document.body.appendChild(restorePill);
  }
  restorePill.hidden = false;
  document.querySelector(`[data-nav="${navName}"]`)?.click();
}

/* ============================ Agent + composer ========================= */

let hasMessages = false;

function resetAgent() {
  hasMessages = false;
  $('#l-agent-chat').innerHTML = '';
  $('#l-agent-chat').hidden = true;
  $('#l-agent-empty').hidden = false;
  const inp = $('#l-cinput');
  inp.textContent = '';
  updateSendEnabled();
  showView(HOME);
  inp.focus();
}

function appendChat(html) {
  const chat = $('#l-agent-chat');
  if (!hasMessages) {
    hasMessages = true;
    $('#l-agent-empty').hidden = true;
    chat.hidden = false;
  }
  const div = document.createElement('div');
  div.innerHTML = html;
  while (div.firstChild) chat.appendChild(div.firstChild);
  $('#l-agent-scroll').scrollTop = $('#l-agent-scroll').scrollHeight;
}

function sendMessage() {
  const inp = $('#l-cinput');
  const text = inp.textContent.trim();
  if (!text) return;
  appendChat(`<div class="l-bubble">${esc(text)}</div>`);
  inp.textContent = '';
  updateSendEnabled();
  hideMenu();

  // The agent action loop runs in lana-gpt (PRODUCT_BRIEF §11 Phase 3) and is
  // not live yet. Be honest about that rather than fake a response.
  const note = authState.authenticated
    ? 'The agent loop (read · navigate · draft, with an approval gate) is landing in Phase 3. Your message was captured — grounding (<b>@matter</b> / <b>#file</b>) and playbooks come online first.'
    : 'Authorize LANA GPT in Settings to enable cloud reasoning. The agent action loop ships in Phase 3; until then you can capture, ground to matters, and run playbooks.';
  setTimeout(() => appendChat(`<div class="l-msg">${note}</div>`), 120);
}

function updateSendEnabled() {
  const text = $('#l-cinput').textContent.trim();
  $('#l-send').disabled = !text;
}

function wireAgent() {
  $$('[data-ltry]').forEach((b) => b.addEventListener('click', () => {
    const inp = $('#l-cinput');
    inp.textContent = b.dataset.ltry;
    inp.focus();
    placeCaretEnd(inp);
    updateSendEnabled();
  }));
  const inp = $('#l-cinput');
  inp.addEventListener('input', () => { updateSendEnabled(); onComposerInput(); });
  inp.addEventListener('keydown', (e) => {
    if (menuOpen && menuHasItems()) {
      if (e.key === 'Escape') { hideMenu(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { moveMenuSel(1); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { moveMenuSel(-1); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { if (pickSelected()) { e.preventDefault(); return; } }
      // Caret navigation off the trailing token — dismiss rather than linger.
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) hideMenu();
    } else if (menuOpen && e.key === 'Escape') { hideMenu(); e.preventDefault(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#l-send').addEventListener('click', sendMessage);
  $('#l-attach').addEventListener('click', () => { insertTrigger('#'); });
  // Paste plain text only — the composer sends textContent, so a rich/HTML paste
  // would render formatting/images that silently vanish on send. Insert the
  // text/plain flavor and cap total length.
  inp.addEventListener('paste', (e) => {
    e.preventDefault();
    const clip = (e.clipboardData || window.clipboardData);
    const text = clip ? clip.getData('text/plain') : '';
    const room = Math.max(0, MAX_COMPOSER - inp.textContent.length);
    document.execCommand('insertText', false, text.slice(0, room));
  });
  // Keep focus/caret when clicking a menu row (mousedown would blur the input).
  $('#l-menu')?.addEventListener('mousedown', (e) => e.preventDefault());
  // Dismiss the trigger menu on any click outside the composer/menu.
  document.addEventListener('mousedown', (e) => {
    if (!menuOpen) return;
    const menu = $('#l-menu');
    if (menu.contains(e.target) || inp.contains(e.target)) return;
    hideMenu();
  });
}

function menuRows() { return $$('#l-menu .l-mrow[data-insert]'); }
function menuHasItems() { return menuRows().length > 0; }

function moveMenuSel(dir) {
  const rows = menuRows();
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.classList.contains('sel'));
  if (i < 0) i = 0;
  rows[i].classList.remove('sel');
  i = (i + dir + rows.length) % rows.length;
  rows[i].classList.add('sel');
  rows[i].scrollIntoView({ block: 'nearest' });
}

function pickSelected() {
  const row = $('#l-menu .l-mrow.sel[data-insert]') || menuRows()[0];
  if (!row) return false;
  const trig = currentTrigger();
  if (!trig) { hideMenu(); return true; }
  pickMenu(row.dataset.insert, trig);
  return true;
}

/* ---- trigger menu (/ playbooks · # files · @ matters) ---- */
let menuOpen = false;

function insertTrigger(ch) {
  const inp = $('#l-cinput');
  inp.focus();
  const cur = inp.textContent;
  inp.textContent = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + ch;
  placeCaretEnd(inp);
  updateSendEnabled();
  onComposerInput();
}

function currentTrigger() {
  // Trailing token of the composer, but only when the trigger char is at the
  // start of input or preceded by whitespace — so `bob@acme.com` or a `/path`
  // inside a word does NOT pop the menu. `raw` excludes the leading boundary so
  // pickMenu's length-based splice stays correct.
  const text = $('#l-cinput').textContent;
  const m = text.match(/(^|\s)([\/#@])([^\s\/#@]*)$/);
  if (!m) return null;
  return { ch: m[2], query: m[3].toLowerCase(), raw: m[2] + m[3] };
}

async function onComposerInput() {
  const trig = currentTrigger();
  if (!trig) { hideMenu(); return; }
  let items = [];
  let hint = '';
  if (trig.ch === '/') { hint = 'Playbooks · Enter to run'; items = (await getPlaybooks()).map((p) => ({ mono: true, pre: '/', name: p.cmd, desc: p.desc, insert: '/' + p.cmd })); }
  else if (trig.ch === '#') { hint = 'Files & clips'; items = (await getCapturedItems()).slice(0, 8).map((it) => ({ mono: true, name: slug(it.title), badge: it.badge, insert: '#' + slug(it.title) })); }
  else if (trig.ch === '@') { hint = 'Matters'; items = (await getMatters()).map((m) => ({ name: m.name, desc: m.meta, insert: '@' + m.name })); }

  if (trig.query) items = items.filter((it) => (it.name || '').toLowerCase().includes(trig.query));
  showMenu(hint, items, trig);
}

function showMenu(hint, items, trig) {
  const menu = $('#l-menu');
  if (!items.length) {
    const empty = trig.ch === '@'
      ? 'Authorize LANA GPT to see your matters'
      : trig.ch === '#' ? 'Nothing captured yet' : 'No playbooks';
    menu.innerHTML = `<div class="l-mhint">${esc(hint)}</div><div class="l-mrow" style="cursor:default"><span class="l-mdesc" style="margin:0">${esc(empty)}</span></div>`;
  } else {
    menu.innerHTML = `<div class="l-mhint">${esc(hint)}</div>` + items.map((it, i) => `
      <div class="l-mrow${i === 0 ? ' sel' : ''}" data-insert="${esc(it.insert)}">
        <span class="l-mname${it.mono ? '' : ' plain'}">${it.pre ? `<span class="pre">${it.pre}</span>` : ''}${esc(it.name)}</span>
        ${it.badge ? `<span class="l-badge opt" style="margin-left:auto">${esc(it.badge)}</span>` : ''}
        ${it.desc ? `<span class="l-mdesc">${esc(it.desc)}</span>` : ''}
      </div>`).join('');
    $$('.l-mrow[data-insert]', menu).forEach((row) => row.addEventListener('click', () => pickMenu(row.dataset.insert, trig)));
  }
  menu.hidden = false;
  menuOpen = true;
}

function pickMenu(insert, trig) {
  const inp = $('#l-cinput');
  const text = inp.textContent;
  inp.textContent = text.slice(0, text.length - trig.raw.length) + insert + ' ';
  placeCaretEnd(inp);
  hideMenu();
  updateSendEnabled();
  inp.focus();
}

function hideMenu() { const m = $('#l-menu'); if (m) { m.hidden = true; } menuOpen = false; }

function placeCaretEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ============================ data helpers ============================= */

const slug = (s) => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';

const PLATFORM = {
  chatgpt: { cls: 'gpt', glyph: 'G', label: 'ChatGPT' },
  openai: { cls: 'gpt', glyph: 'G', label: 'ChatGPT' },
  claude: { cls: 'claude', glyph: 'C', label: 'Claude' },
  gemini: { cls: 'gpt', glyph: 'G', label: 'Gemini' },
  copilot: { cls: 'import', glyph: 'M', label: 'Copilot' },
};

function convText(c) {
  const parts = [c.title || ''];
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  for (const m of msgs.slice(0, 40)) {
    const t = m.content || m.text || '';
    if (t) parts.push(`${m.role || ''}: ${t}`.trim());
  }
  return parts.filter(Boolean).join('\n').slice(0, 20000);
}

async function getCapturedItems() {
  let convs = [];
  try { convs = await dbGetAll('conversations'); } catch { convs = []; }
  return convs
    .sort((a, b) => (b.timestamp || b.updatedAt || 0) - (a.timestamp || a.updatedAt || 0))
    .map((c) => {
      const src = (c.source || c.platform || '').toLowerCase();
      const p = PLATFORM[src] || { cls: 'import', glyph: '·', label: src || 'Chat' };
      return {
        id: c.id, title: c.title || '(untitled)', platform: p, kind: c.kind || 'chat',
        badge: p.label, when: c.timestamp || c.updatedAt || 0, source: src, _c: c,
      };
    });
}

let _mattersCache = null;
/** Drop the cached matter list so the next getMatters() refetches. Call on any
 *  auth transition — otherwise the first (unauth) empty result sticks forever. */
function resetMattersCache() { _mattersCache = null; }
async function getMatters() {
  if (_mattersCache) return _mattersCache;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'LANA_LIST_MATTERS' });
    const matters = (r && r.matters) || [];
    const mapped = matters.map((m) => ({
      id: m.id || m.matter_id || m.matterId,
      name: m.name || m.title || m.id || 'Matter',
      meta: m.status || m.description || '',
    }));
    // Only cache a non-empty result; an empty list (typically unauthenticated)
    // must not become permanent — re-query until matters actually arrive.
    if (mapped.length) _mattersCache = mapped;
    return mapped;
  } catch { return []; }
}

const DEFAULT_PLAYBOOKS = [
  { cmd: 'summarize-matter', desc: 'Key facts, deadlines…', src: 'Matter' },
  { cmd: 'draft-demand-letter', desc: 'Draft & save to matter', src: 'Docs' },
  { cmd: 'intake-client', desc: 'From email → new matter', src: 'Gmail' },
  { cmd: 'research-authority', desc: 'Statutes + case law', src: 'Corpus' },
  { cmd: 'digest-inbox', desc: 'Flag matter emails', src: 'Gmail' },
];
async function getPlaybooks() {
  try {
    const { lanaPlaybooks } = await chrome.storage.local.get('lanaPlaybooks');
    if (Array.isArray(lanaPlaybooks) && lanaPlaybooks.length) return lanaPlaybooks;
  } catch { /* fall through */ }
  return DEFAULT_PLAYBOOKS;
}

/* ============================ Captured view ============================ */

let capturedSeg = 'all';

async function renderCaptured() {
  const list = $('#l-captured-list');
  const items = await getCapturedItems();
  const filtered = items.filter((it) => {
    if (capturedSeg === 'all') return true;
    if (capturedSeg === 'chats') return it.kind === 'chat';
    if (capturedSeg === 'clips') return it.kind === 'clip';
    if (capturedSeg === 'imports') return it.kind === 'import' || it.source === 'import';
    return true;
  });
  $('#l-captured-count').textContent = `${items.length}`;
  if (!filtered.length) {
    list.innerHTML = `<div class="l-emptynote">Nothing captured here yet.<br>Your ChatGPT/Claude sessions and clips will appear as you browse.</div>`;
    return;
  }
  const matters = await getMatters();
  list.innerHTML = filtered.map((it) => `
    <div class="l-item" data-cid="${esc(it.id)}">
      <div class="l-itop">
        <span class="l-sico ${it.platform.cls}">${esc(it.platform.glyph)}</span>
        <div class="l-ititle">${esc(it.title)}<div class="l-imeta">${esc(it.platform.label)}${it.when ? ' · ' + timeAgo(it.when) : ''}</div></div>
      </div>
      <div class="l-actions">
        <span class="l-sp"></span>
        <button class="l-btn l-btn-ghost" data-file="${esc(it.id)}" ${matters.length ? '' : 'disabled title="Authorize LANA GPT to file to a matter"'}>Attach to matter ▾</button>
      </div>
    </div>`).join('');
  $$('[data-file]', list).forEach((b) => b.addEventListener('click', () => openMatterPicker(b, b.dataset.file)));
}

async function openMatterPicker(anchor, cid) {
  const matters = await getMatters();
  if (!matters.length) return;
  // lightweight inline menu under the button
  const existing = $('#l-file-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'l-file-menu';
  menu.className = 'l-menu';
  menu.style.cssText = 'position:fixed;z-index:60;max-width:280px';
  menu.innerHTML = `<div class="l-mhint">File to matter</div>` + matters.map((m) => `<div class="l-mrow" data-mid="${esc(m.id)}"><span class="l-mname plain">${esc(m.name)}</span>${m.meta ? `<span class="l-mdesc">${esc(m.meta)}</span>` : ''}</div>`).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.right - 280)}px`;
  menu.style.top = `${r.bottom + 6}px`;
  const dismiss = () => {
    menu.remove();
    document.removeEventListener('click', close, true);
    window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize);
  };
  const close = (e) => { if (!menu.contains(e.target)) dismiss(); };
  // Fixed-position menu is anchored to a one-time rect — scroll/resize would
  // orphan it over unrelated rows, so dismiss instead of letting it float.
  const onScrollResize = () => dismiss();
  setTimeout(() => {
    document.addEventListener('click', close, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
  }, 0);
  $$('.l-mrow[data-mid]', menu).forEach((row) => row.addEventListener('click', async () => {
    dismiss(); // remove the menu AND unbind the capture-phase listener (no leak)
    await fileToMatter(cid, row.dataset.mid, anchor);
  }));
}

async function fileToMatter(cid, matterId, anchor) {
  const items = await getCapturedItems();
  const it = items.find((x) => String(x.id) === String(cid));
  if (!it) return;
  anchor.textContent = 'Filing…';
  anchor.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'LANA_SEND_KNOWLEDGE',
      matterId,
      content: convText(it._c),
      sourceId: String(it.id),
    });
    if (res && res.error) throw new Error(res.error);
    const card = anchor.closest('.l-item');
    const matters = await getMatters();
    const name = (matters.find((m) => String(m.id) === String(matterId)) || {}).name || 'matter';
    card.querySelector('.l-actions').innerHTML =
      `<span class="l-filed"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 12 2 2 4-4"/></svg>Filed to <span class="l-mtag">@${esc(name)}</span></span>`;
  } catch (err) {
    anchor.textContent = 'Attach to matter ▾';
    anchor.disabled = false;
    flashStatus(`Couldn't file: ${err.message}`);
  }
}

/* ============================ History view ============================= */

async function renderHistory() {
  const list = $('#l-history-list');
  const items = await getCapturedItems();
  const q = ($('#l-history-search')?.value || '').toLowerCase();
  const filtered = q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
  if (!filtered.length) {
    list.innerHTML = `<div class="l-emptynote">No history yet.</div>`;
    return;
  }
  list.innerHTML = filtered.slice(0, 100).map((it) => `
    <div class="l-hitem">
      <div class="t">${esc(it.title)}</div>
      <div class="m"><span class="g"></span>${it.when ? timeAgo(it.when) : 'recent'}<span class="l-hpill">${esc(it.platform.label)}</span></div>
    </div>`).join('');
}

/* ============================ Playbooks view ========================== */

async function renderPlaybooks() {
  const list = $('#l-playbooks-list');
  const pbs = await getPlaybooks();
  const q = ($('#l-pb-search')?.value || '').toLowerCase();
  const filtered = q ? pbs.filter((p) => p.cmd.toLowerCase().includes(q)) : pbs;
  list.innerHTML = `<div class="l-eyebrow2">Suggested for legal</div><div class="l-pbcard" style="margin-top:8px">` +
    filtered.map((p) => `
      <div class="l-pb" data-run="${esc(p.cmd)}">
        <div class="t"><span class="cmd">/${esc(p.cmd)}</span>${p.src ? `<span class="src">${esc(p.src)}</span>` : ''}</div>
        <div class="d">${esc(p.desc)}</div>
      </div>`).join('') + `</div>`;
  $$('[data-run]', list).forEach((row) => row.addEventListener('click', () => {
    showView(HOME);
    const inp = $('#l-cinput');
    inp.textContent = '/' + row.dataset.run + ' ';
    inp.focus();
    placeCaretEnd(inp);
    updateSendEnabled();
  }));
}

/* ============================ Settings view =========================== */

async function renderSettings() {
  authState = await getState().catch(() => ({ authenticated: false }));
  const authed = !!authState.authenticated;
  $('#l-set-account-connected').hidden = !authed;
  $('#l-set-account-disconnected').hidden = authed;
  const chip = $('#l-set-chip');
  chip.className = 'l-chip ' + (authed ? 'on' : 'off');
  chip.innerHTML = `<span class="l-dot"></span>${authed ? 'Connected' : 'Not connected'}`;
  if (authed) {
    $('#l-set-email').textContent = authState.email || `Connected (${authState.mode || 'session'})`;
    $('#l-set-synced').textContent = 'Connected · synced just now';
  }
  // Inference tier 2 reflects account state
  const cloud = $('#l-tier-cloud');
  cloud.className = 'l-state ' + (authed ? 'ready' : 'wait');
  cloud.innerHTML = authed
    ? '<span class="d"></span>Ready'
    : '<span class="d"></span>Authorize LANA GPT to enable';

  // Data counts
  try {
    const [c, s, t] = await Promise.all([dbCount('conversations'), dbCount('summaries'), dbCount('topics')]);
    $('#l-set-data').innerHTML = [
      ['Conversations', c], ['Summaries', s], ['Topics', t],
    ].map(([k, v]) => `<div class="l-srow" style="padding:9px 2px;border:none;border-bottom:1px solid var(--l-border-soft);background:none;border-radius:0"><div class="st" style="font-weight:400;color:var(--l-dim)">${k}</div><span class="l-mname plain" style="font-weight:650">${v}</span></div>`).join('');
  } catch { $('#l-set-data').innerHTML = ''; }

  // Agent toggles from storage
  try {
    const { lanaAgentPrefs } = await chrome.storage.local.get('lanaAgentPrefs');
    const prefs = lanaAgentPrefs || { memory: true, suggest: true, notify: false };
    $$('[data-ltoggle]').forEach((t) => t.classList.toggle('on', !!prefs[t.dataset.ltoggle]));
  } catch { /* defaults already in markup */ }
}

function wireSettings() {
  $('#l-set-authorize')?.addEventListener('click', () => {
    flashStatus('Opening LANA GPT to authorize…', false);
    connectViaOAuth(instanceUrlValue)
      .then((state) => { authState = state || { authenticated: false }; resetMattersCache(); renderSettings(); flashStatus(state?.authenticated ? 'Authorized.' : 'Authorization did not complete.'); })
      .catch((err) => flashStatus(err.message, true));
  });
  $('#l-set-disconnect')?.addEventListener('click', () => {
    disconnect().then(() => { authState = { authenticated: false }; resetMattersCache(); renderSettings(); }).catch((e) => flashStatus(e.message, true));
  });
  $$('[data-ltoggle]').forEach((t) => t.addEventListener('click', async () => {
    t.classList.toggle('on');
    const prefs = {};
    $$('[data-ltoggle]').forEach((x) => { prefs[x.dataset.ltoggle] = x.classList.contains('on'); });
    try { await chrome.storage.local.set({ lanaAgentPrefs: prefs }); } catch { /* ignore */ }
  }));
  $('#l-set-export')?.addEventListener('click', () => { const b = document.getElementById('backup-btn'); if (b) b.click(); else openLegacy('settings'); });
  $('#l-set-import')?.addEventListener('click', () => { const b = document.getElementById('restore-btn'); if (b) b.click(); else openLegacy('settings'); });
  $('#l-set-advanced')?.addEventListener('click', () => openLegacy('settings'));
}

function flashStatus(msg, isError) {
  const el = $('#l-set-status');
  if (!el) return;
  el.hidden = false;
  el.textContent = msg;
  el.style.color = isError ? 'var(--l-danger)' : 'var(--l-dim)';
}

/* ============================ Playbooks sheet ========================= */

function wirePlaybookSheet() {
  const scrim = $('#l-newpb-scrim');
  const open = () => { scrim.hidden = false; };
  const close = () => { scrim.hidden = true; };
  $('#l-pb-new')?.addEventListener('click', open);
  $('#l-pb-new2')?.addEventListener('click', open);
  scrim?.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  $$('[data-lpb]').forEach((o) => o.addEventListener('click', () => {
    const mode = o.dataset.lpb;
    close();
    if (mode === 'write') {
      // Write-it: minimal prompt-based creation for v1 (full editor = Phase 4).
      const name = window.prompt('Playbook name (used as /name):');
      if (!name) return;
      const steps = window.prompt('What should this playbook do?');
      if (steps == null) return;
      savePlaybook({ cmd: slug(name), desc: steps.slice(0, 80), src: 'Custom', steps });
    } else {
      flashStatus('Record-it lands in Phase 4 (record a task once → repeatable playbook).');
      showView('settings');
    }
  }));
}

async function savePlaybook(pb) {
  let list = [];
  try { const r = await chrome.storage.local.get('lanaPlaybooks'); list = r.lanaPlaybooks || DEFAULT_PLAYBOOKS.slice(); } catch { list = DEFAULT_PLAYBOOKS.slice(); }
  list.unshift(pb);
  try { await chrome.storage.local.set({ lanaPlaybooks: list }); } catch { /* ignore */ }
  renderPlaybooks();
}

/* ============================ First run =============================== */

async function maybeFirstRun() {
  let consented = false;
  try { const r = await chrome.storage.local.get('lanaConsent'); consented = !!r.lanaConsent; } catch { /* treat as not consented */ }
  if (consented) { showView(HOME); return; }
  showView('firstrun');
  wireFirstRun();
}

function wireFirstRun() {
  const consent = $('#l-fr-consent');
  consent?.addEventListener('click', () => consent.classList.toggle('checked'));
  $('#l-fr-continue')?.addEventListener('click', () => {
    // CRITICAL: do NOT await before connectViaOAuth. connectViaOAuth →
    // ensureHostPermission → chrome.permissions.request needs this click's user
    // activation, and any awaited async (e.g. storage.set) before it spends the
    // gesture → the permission prompt is rejected and onboarding hangs. Persist
    // consent fire-and-forget (unawaited) so the OAuth call stays synchronous.
    chrome.storage.local.set({ lanaConsent: true, lanaEuResident: consent?.classList.contains('checked') || false });
    if (authState.authenticated) { showView(HOME); return; }
    $('#l-fr-1').hidden = true;
    $('#l-fr-2').hidden = false;
    connectViaOAuth(instanceUrlValue)
      .then((state) => { authState = state || { authenticated: false }; resetMattersCache(); resetAgent(); })
      .catch(() => { /* stay on waiting screen; user can Skip */ });
  });
  $('#l-fr-skip')?.addEventListener('click', () => resetAgent());
  $('#l-fr-reopen')?.addEventListener('click', (e) => { e.preventDefault(); connectViaOAuth(instanceUrlValue).then((s) => { authState = s || authState; resetMattersCache(); resetAgent(); }).catch(() => {}); });
}

/* ============================ Captured segbar / search ================ */

function wireMisc() {
  $$('#l-captured-segs .l-seg').forEach((b) => b.addEventListener('click', () => {
    $$('#l-captured-segs .l-seg').forEach((x) => x.classList.toggle('on', x === b));
    capturedSeg = b.dataset.lseg;
    renderCaptured();
  }));
  $('#l-history-search')?.addEventListener('input', () => renderHistory());
  $('#l-pb-search')?.addEventListener('input', () => renderPlaybooks());
}

/* ============================ boot ==================================== */

let _booted = false;
async function boot() {
  if (_booted) return; // module scripts run at readyState 'interactive', then
  _booted = true;       // DOMContentLoaded fires too — guard against double-wiring.
  // Preload instance URL so OAuth's permission request keeps the click gesture.
  // MUST end up non-empty — connectViaOAuth('') falls back to an awaited
  // getInstance() that would consume the click gesture (see finding #5).
  try { const inst = await getInstanceInfo(); if (inst?.url) instanceUrlValue = inst.url; } catch { /* fall through to env default */ }
  if (!instanceUrlValue) {
    try { instanceUrlValue = (await defaultInstance()).url; } catch { instanceUrlValue = 'https://gpt.lanaai.io'; }
  }
  // Env badge (dev builds)
  try { const env = await getEnv(); if (env.isDev) { const b = $('#l-env-badge'); if (b) { b.hidden = false; b.textContent = 'dev'; } } } catch { /* ignore */ }
  // Cache auth state up front so first-run + agent copy are correct. Guard hard:
  // if the SW round-trip fails (or throws synchronously), we still wire the UI.
  try {
    mountConnect({ onState: (s) => {
      const was = !!authState.authenticated;
      authState = s || authState;
      if (!!authState.authenticated !== was) resetMattersCache(); // auth flipped → refetch matters
    } });
  } catch { /* SW not ready */ }
  try { authState = (await getState()) || { authenticated: false }; } catch { authState = { authenticated: false }; }

  wireRouter();
  wireAgent();
  wireSettings();
  wirePlaybookSheet();
  wireMisc();
  updateSendEnabled();

  await maybeFirstRun();
}

/* ============================ util ==================================== */

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (nowish() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// Date.now via a wrapper so it's easy to find; fine in a live UI (not a workflow).
function nowish() { return Date.now(); }

document.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
