/**
 * @fileoverview Build environment resolution (dev vs production).
 *
 * The end user should never have to type or pick an instance URL. Which LANA
 * deployment the extension talks to is decided by *how the extension was
 * installed*, not by a settings field:
 *
 *   - **production** — installed from the Chrome Web Store (`installType`
 *     `normal`/`admin`/`sideload`) → talks to the hosted cloud, gpt.lanaai.io.
 *   - **development** — loaded unpacked (`installType === 'development'`) →
 *     talks to a local dev instance so we can iterate without touching prod.
 *
 * `chrome.management.getSelf()` is available WITHOUT the "management" permission
 * (it only reads info about the calling extension), so this needs no manifest
 * change. On-prem customers are the one case that still needs an explicit URL;
 * that stays an under-the-hood override (see lib/instance.js), never a field in
 * the default consumer UI.
 *
 * @module lib/env
 */

/** Hosted production cloud. */
export const PROD_INSTANCE = { url: 'https://gpt.lanaai.io', label: 'LANA GPT', kind: 'cloud' };

/**
 * Local dev instance — the lana-gpt Next.js web (which also proxies /api/v1 to
 * the API); the extension never talks to the private API host directly. The
 * current local stack serves the web on 127.0.0.1:13001. Override with
 * chrome.storage.local `lanaDevInstance` if your dev box differs.
 */
export const DEV_INSTANCE = { url: 'http://127.0.0.1:13001', label: 'LANA GPT (dev)', kind: 'dev' };

let _envCache = null;

/**
 * Resolve the build environment once (cached for the worker/page lifetime).
 * @returns {Promise<{isDev: boolean, name: 'development'|'production', installType: string}>}
 */
export async function getEnv() {
  if (_envCache) return _envCache;
  let installType = 'normal';
  try {
    const self = await chrome.management.getSelf();
    if (self && self.installType) installType = self.installType;
  } catch {
    // getSelf can fail in some contexts (e.g. very early SW start); assume prod.
  }
  const isDev = installType === 'development';
  _envCache = { isDev, name: isDev ? 'development' : 'production', installType };
  return _envCache;
}

/** Convenience: is this an unpacked/dev build? */
export async function isDev() {
  return (await getEnv()).isDev;
}

/**
 * The instance the extension should default to for this build, with no user
 * input. Dev builds may override the dev URL via chrome.storage.local
 * `lanaDevInstance` (a bare URL string or a {url,label} object).
 * @returns {Promise<{url: string, label: string, kind: string}>}
 */
export async function defaultInstance() {
  const { isDev } = await getEnv();
  if (!isDev) return { ...PROD_INSTANCE };
  try {
    const { lanaDevInstance } = await chrome.storage.local.get('lanaDevInstance');
    if (typeof lanaDevInstance === 'string' && lanaDevInstance.trim()) {
      return { ...DEV_INSTANCE, url: lanaDevInstance.trim() };
    }
    if (lanaDevInstance && lanaDevInstance.url) {
      return { ...DEV_INSTANCE, ...lanaDevInstance };
    }
  } catch { /* fall through to the built-in dev default */ }
  return { ...DEV_INSTANCE };
}
