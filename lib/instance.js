/**
 * @fileoverview LANA AI instance configuration.
 *
 * The extension can point at any LANA deployment — the hosted cloud, or a
 * customer's on-prem box — by changing ONE value: the instance base URL.
 * Everything else (auth, inference passthrough, account ingestion) is derived
 * from it. This module owns that value and the host-permission plumbing that
 * lets the extension actually reach it.
 *
 * Storage: chrome.storage.local key `lanaInstance` = { url, label, kind }.
 *
 * @module lib/instance
 */

const INSTANCE_KEY = 'lanaInstance';

/** Built-in presets shown in Settings. On-prem is a free-form URL entry. */
export const INSTANCE_PRESETS = [
  { url: 'https://gpt.lanaai.io', label: 'LANA AI Cloud', kind: 'cloud' },
];

/** The default instance when the user hasn't chosen one. */
export const DEFAULT_INSTANCE = INSTANCE_PRESETS[0];

/**
 * Normalize a user-entered instance URL: trims, strips a trailing slash, and
 * validates the scheme. On-prem may legitimately be http:// on a LAN, so we
 * allow http as well as https, but reject anything else.
 *
 * @param {string} raw
 * @returns {string} normalized origin+path (no trailing slash)
 * @throws {Error} if the URL is unparseable or uses a disallowed scheme
 */
export function normalizeInstanceUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('Instance URL is required.');
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: ${trimmed}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`Instance URL must be http or https, got ${u.protocol}`);
  }
  // Keep origin + any path prefix (some on-prem deployments live under a path),
  // but drop a trailing slash so `${base}/api/v1/...` never doubles up.
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * Get the configured instance, falling back to the default.
 * @returns {Promise<{url: string, label: string, kind: string}>}
 */
export async function getInstance() {
  const data = await chrome.storage.local.get(INSTANCE_KEY);
  const stored = data[INSTANCE_KEY];
  if (stored && stored.url) return stored;
  return { ...DEFAULT_INSTANCE };
}

/**
 * Persist a new instance selection. Normalizes the URL first so downstream
 * code can trust it. Does NOT request host permission — call
 * {@link ensureHostPermission} separately (it needs a user gesture).
 *
 * @param {{url: string, label?: string, kind?: string}} instance
 * @returns {Promise<{url: string, label: string, kind: string}>} the stored value
 */
export async function setInstance(instance) {
  const url = normalizeInstanceUrl(instance.url);
  const value = {
    url,
    label: instance.label || url,
    kind: instance.kind || (url === DEFAULT_INSTANCE.url ? 'cloud' : 'onprem'),
  };
  await chrome.storage.local.set({ [INSTANCE_KEY]: value });
  return value;
}

/**
 * The `/api/v1` base for the given (or configured) instance.
 * @param {string} [instanceUrl]
 * @returns {Promise<string>|string}
 */
export async function apiBase(instanceUrl) {
  const url = instanceUrl || (await getInstance()).url;
  return `${url}/api/v1`;
}

/**
 * Build a match pattern for the instance origin, e.g. `https://gpt.lanaai.io/*`,
 * suitable for chrome.permissions.request / contains.
 * @param {string} url
 * @returns {string}
 */
export function originPattern(url) {
  const u = new URL(url);
  return `${u.origin}/*`;
}

/**
 * Do we already hold host permission for this instance origin?
 * @param {string} [instanceUrl]
 * @returns {Promise<boolean>}
 */
export async function hasHostPermission(instanceUrl) {
  const url = instanceUrl || (await getInstance()).url;
  return chrome.permissions.contains({ origins: [originPattern(url)] });
}

/**
 * Request host permission for the instance origin. MUST be called from a user
 * gesture (e.g. a Settings button click) or Chrome rejects it. We keep the
 * blanket all-hosts grant out of the install prompt precisely so this
 * per-instance request is the trust moment.
 *
 * @param {string} [instanceUrl]
 * @returns {Promise<boolean>} true if granted
 */
export async function ensureHostPermission(instanceUrl) {
  // Prefer the passed URL so callers can keep this the FIRST await off a user
  // gesture (an `await getInstance()` here would consume the user activation).
  const url = instanceUrl || (await getInstance()).url;
  // Call request() directly — it resolves true WITHOUT a prompt when the
  // permission is already held. Inserting an awaited permissions.contains()
  // check first would spend the user activation, so Chrome would reject the
  // prompt on the first (real) grant with "must be called during a user gesture".
  return chrome.permissions.request({ origins: [originPattern(url)] });
}
