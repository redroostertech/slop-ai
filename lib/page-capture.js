/**
 * @fileoverview Any-page delivery layer for research-capture and form-fill.
 *
 * The capability modules (lib/capabilities/research-capture.js,
 * lib/capabilities/form-fill.js) contain the *logic* but no way to reach an
 * arbitrary page: their pure DOM functions assume a `document` and reference
 * module-scope helpers that only exist inside those modules. This module is the
 * MV3 delivery seam. It runs on the extension side (service worker or
 * sidepanel) and uses `chrome.scripting.executeScript` to run a SELF-CONTAINED
 * function inside the active tab.
 *
 * KEY MV3 CONSTRAINT: a function handed to `executeScript({ func })` is
 * serialized with `Function.prototype.toString()` and re-parsed in the page's
 * isolated world. It therefore CANNOT close over module imports or module-scope
 * helpers — every helper it needs must be defined inside its own body. The
 * `injected*` functions below are deliberately duplicated + inlined copies of
 * the reviewed capability logic, kept faithful to the originals (same safety
 * properties). Do NOT refactor them to call shared module-scope helpers; that
 * would throw a ReferenceError once injected.
 *
 * Requires the `scripting` permission (already in manifest). On the 5 AI sites,
 * host access comes from `host_permissions`. NOTE: `activeTab` is granted only
 * by invoking the extension action / context menu / keyboard shortcut — NOT by
 * clicking an in-page button — so extending clip/fill to arbitrary hosts needs
 * an explicit host grant, not a reliance on activeTab.
 *
 * TAB CORRELATION: every operation targets an EXPLICIT tabId (the tab that
 * triggered it, threaded from `sender.tab.id`), never a fresh active-tab query.
 * Re-querying the active tab at each hop races a user tab/window switch during
 * the multi-second on-device inference and would deliver a preview to — or fill
 * — the wrong tab. A missing tabId falls back to the active tab (best-effort).
 *
 * @module lib/page-capture
 */

/**
 * Resolve a specific tab by id (the triggering tab), falling back to the active
 * tab only when no id is given. Throws if no scriptable tab is found.
 * @param {number} [tabId]
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function resolveTab(tabId) {
  if (typeof tabId === 'number' && tabId >= 0) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && typeof tab.id === 'number' && tab.id >= 0) return tab;
    } catch (_e) {
      /* the triggering tab was closed — fall through to the active tab */
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
    throw new Error('No scriptable tab available.');
  }
  return tab;
}

// ===========================================================================
// SELF-CONTAINED INJECTED FUNCTIONS
// These run in the PAGE (isolated world). No imports, no outer-scope refs.
// ===========================================================================

/**
 * Injected copy of research-capture.extractReadable(), plus the current text
 * selection (which the pure module fn does not capture). Runs in the page.
 * @returns {{title: string, url: string, text: string, excerpt: string, selection: string}}
 */
function injectedExtractReadable() {
  const doc = document;
  const url = doc.location && doc.location.href ? doc.location.href : '';
  const title =
    (doc.querySelector('meta[property="og:title"]') || {}).content ||
    (doc.querySelector('title') || {}).textContent ||
    doc.title ||
    '';

  const candidates = Array.from(
    doc.querySelectorAll('article, main, [role="main"], .post, .article, .content, #content')
  );
  const scope = candidates.length ? candidates : [doc.body].filter(Boolean);

  let best = { node: null, score: 0, text: '' };
  for (const root of scope) {
    if (!root) continue;
    const paras = Array.from(root.querySelectorAll('p, li, blockquote'));
    const text = paras
      .map((p) => p.textContent.trim())
      .filter((t) => t.length > 40)
      .join('\n\n');
    const score = text.length;
    if (score > best.score) best = { node: root, score, text };
  }

  const text = (best.text || (doc.body && doc.body.textContent) || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const excerpt =
    (doc.querySelector('meta[name="description"]') || {}).content ||
    (doc.querySelector('meta[property="og:description"]') || {}).content ||
    text.slice(0, 240);

  let selection = '';
  try {
    selection = (window.getSelection && window.getSelection().toString()) || '';
  } catch (_e) {
    selection = '';
  }

  return {
    title: String(title).trim(),
    url,
    text,
    excerpt: String(excerpt).trim(),
    selection: selection.trim(),
  };
}

/**
 * Injected copy of form-fill.detectFields(). Inlines sanitizeLabel/labelFor/
 * stableSelector because those module-scope helpers don't exist in the page.
 * Keeps the reviewed safety: skips password/hidden/file/submit/button/image and
 * disabled fields, sanitizes untrusted labels. Runs in the page.
 * @returns {Array<{name: string, label: string, type: string, selector: string}>}
 */
function injectedDetectFields() {
  const doc = document;

  function sanitizeLabel(raw) {
    return String(raw || '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, ' ')
      .replace(/["`{}<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function labelFor(el) {
    if (el.id) {
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl.textContent.trim();
    }
    const wrap = el.closest('label');
    return wrap ? wrap.textContent.trim() : '';
  }

  function stableSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    return el.tagName.toLowerCase();
  }

  const inputs = Array.from(doc.querySelectorAll('input, textarea'));
  return inputs
    .filter((el) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return (
        !['password', 'hidden', 'file', 'submit', 'button', 'image'].includes(type) &&
        !el.disabled
      );
    })
    .map((el) => ({
      name: sanitizeLabel(el.name || el.id || ''),
      label: sanitizeLabel(
        labelFor(el) ||
          el.getAttribute('placeholder') ||
          el.getAttribute('aria-label') ||
          el.name ||
          ''
      ),
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      selector: stableSelector(el),
    }))
    // Drop tag-only selectors (no id/name): they always match many elements so
    // applyField would always refuse them — offering them just misleads.
    .filter((f) => (f.selector.startsWith('#') || f.selector.includes('[name=')) && (f.label || f.name));
}

/**
 * Injected copy of form-fill.applyField(). Applies ONE approved value to ONE
 * field. Preserves the reviewed safety contract:
 *   - refuses when the selector matches 0 elements (not_found) or >1
 *     (ambiguous_selector), so an approved value can't silently land in a
 *     different field than the one previewed;
 *   - sets the value via the native setter and dispatches input/change so
 *     frameworks notice, but NEVER clicks submit or dispatches a submit event.
 * Runs in the page. `approved` is passed via executeScript `args`.
 * @param {{selector: string, value: string}} approved
 * @returns {{ok: boolean, reason?: string}}
 */
function injectedApplyField(approved) {
  const doc = document;
  if (!approved || !approved.selector) return { ok: false, reason: 'invalid_input' };

  let matches;
  try {
    matches = doc.querySelectorAll(approved.selector);
  } catch (_e) {
    return { ok: false, reason: 'invalid_selector' };
  }
  if (matches.length === 0) return { ok: false, reason: 'not_found' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous_selector' };

  const el = matches[0];
  const view = doc.defaultView || window;
  const isTextarea = el instanceof view.HTMLTextAreaElement;
  const isInput = el instanceof view.HTMLInputElement;
  if (!isTextarea && !isInput) return { ok: false, reason: 'unsupported_element' };
  const proto = isTextarea ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')
    ? Object.getOwnPropertyDescriptor(proto, 'value').set
    : null;
  if (setter) setter.call(el, approved.value);
  else el.value = approved.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

// ===========================================================================
// PUBLIC ORCHESTRATION API (runs on the extension side)
// ===========================================================================

/**
 * Inject the readable-extraction fn into the active tab and return the clip.
 * The caller is responsible for sending LANA_SAVE_CLIP with the result.
 * @returns {Promise<{title: string, url: string, text: string, excerpt: string, selection: string}|null>}
 */
export async function clipActiveTab(tabId) {
  const tab = await resolveTab(tabId);
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectedExtractReadable,
  });
  const result = injection && injection[0] ? injection[0].result : null;
  return result || null;
}

/**
 * Inject the field-detection fn into the active tab and return detected fields.
 * @returns {Promise<Array<{name: string, label: string, type: string, selector: string}>>}
 */
export async function detectFieldsActiveTab(tabId) {
  const tab = await resolveTab(tabId);
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectedDetectFields,
  });
  const result = injection && injection[0] ? injection[0].result : null;
  return Array.isArray(result) ? result : [];
}

/**
 * Inject the guarded single-field apply fn into the active tab.
 * @param {{selector: string, value: string}} approved
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function applyFieldActiveTab(approved, tabId) {
  if (!approved || typeof approved.selector !== 'string' || typeof approved.value !== 'string') {
    return { ok: false, reason: 'invalid_input' };
  }
  const tab = await resolveTab(tabId);
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectedApplyField,
    args: [{ selector: approved.selector, value: approved.value }],
  });
  const result = injection && injection[0] ? injection[0].result : null;
  return result || { ok: false, reason: 'no_result' };
}

/**
 * Convenience: the active tab's origin, for the form-fill domain-awareness
 * warning and to pass to proposeFills({ origin }). Empty string if unavailable.
 * @returns {Promise<string>}
 */
export async function activeTabOrigin(tabId) {
  const tab = await resolveTab(tabId);
  try {
    return tab.url ? new URL(tab.url).origin : '';
  } catch (_e) {
    return '';
  }
}
