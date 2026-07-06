/**
 * @fileoverview "Notify when done" — desktop notifications for completed tasks,
 * gated by the Agent → Notify preference. Works from the side panel (current
 * tasks) and the service worker (future agent-loop completions).
 *
 * Gating (all required): the `lanaAgentPrefs.notify` toggle is ON, the
 * `notifications` optional permission is granted, and — for panel-created
 * notifications — the panel isn't already focused (don't ping someone watching).
 *
 * @module lib/notify
 */

async function notifyEnabled() {
  try {
    const { lanaAgentPrefs } = await chrome.storage.local.get('lanaAgentPrefs');
    return !!(lanaAgentPrefs && lanaAgentPrefs.notify);
  } catch { return false; }
}

async function hasNotifPermission() {
  try { return await chrome.permissions.contains({ permissions: ['notifications'] }); }
  catch { return false; }
}

/** True only in a focused document (side panel). In the SW, `document` is undefined. */
function panelIsFocused() {
  try { return typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus(); }
  catch { return false; }
}

/**
 * Show a completion notification if enabled + permitted + the panel isn't focused.
 * Uses a STABLE id per task type so a repeat replaces rather than stacks (no spam).
 *
 * @param {{id?: string, title?: string, message?: string, force?: boolean}} opts
 *   force skips the focus check (use for SW-originated agent-loop completions).
 * @returns {Promise<boolean>} whether a notification was shown
 */
export async function notifyDone({ id = 'lana-task', title = 'LANA AI', message = '', force = false } = {}) {
  if (!(await notifyEnabled())) return false;
  if (!force && panelIsFocused()) return false;
  if (!(await hasNotifPermission())) return false;
  if (typeof chrome === 'undefined' || !chrome.notifications || !chrome.notifications.create) return false;
  try {
    const iconUrl = chrome.runtime?.getURL ? chrome.runtime.getURL('icons/icon48.png') : 'icons/icon48.png';
    chrome.notifications.create(id, { type: 'basic', iconUrl, title, message, priority: 0 });
    return true;
  } catch { return false; }
}

/**
 * Request the `notifications` optional permission. MUST be called from a user
 * gesture (e.g. flipping the toggle on). Returns whether it's now granted.
 * @returns {Promise<boolean>}
 */
export async function requestNotifPermission() {
  try { return await chrome.permissions.request({ permissions: ['notifications'] }); }
  catch { return false; }
}
