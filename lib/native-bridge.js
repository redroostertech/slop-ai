/**
 * @fileoverview Native-messaging client — the extension's side of the 1Password-
 * style handoff. Talks to the LANA desktop app's native-messaging host to obtain
 * a per-user token for the tenant the desktop app is logged into, then links it
 * into the multi-account store. This is the PRIMARY provisioning path (see
 * docs/IDENTITY_AND_ROAMING.md §3); browser OAuth is the fallback.
 *
 * Flow: extension → connectNative(host) → host bridges to the running desktop
 * app (logged in) → app calls the tenant backend POST /api/v1/oauth/provision →
 * token bundle comes back over the port → linkAccount().
 *
 * @module lib/native-bridge
 */

import { linkAccount } from './accounts.js';

/** Native-messaging host id — must match the host manifest the desktop app installs. */
export const NATIVE_HOST = 'io.lanaai.desktop';

/** Trust-boundary validation of a token bundle from the native host (review HIGH):
 *  a non-string token or a non-https instanceUrl must never enter the store — it
 *  would later be sent as a bearer to an attacker origin. */
function validBundle(a) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.accessToken !== 'string' || !a.accessToken) return false;
  let u;
  try { u = new URL(a.instanceUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  for (const f of ['email', 'label', 'refreshToken', 'tokenType']) {
    if (a[f] != null && typeof a[f] !== 'string') return false;
  }
  if (a.expiresIn != null && !(Number.isFinite(a.expiresIn) && a.expiresIn > 0)) return false;
  return true;
}

/**
 * Request a provisioned account from the desktop app over native messaging.
 * Rejects (without side effects) if the host isn't installed, the app isn't
 * running, the user declines, or it times out — callers fall back to OAuth.
 *
 * @param {{instanceUrl?: string}} [opts]
 * @param {{timeoutMs?: number}} [cfg]
 * @returns {Promise<Object>} the account bundle
 *   { instanceUrl, email?, label?, accessToken, refreshToken?, tokenType?, expiresIn? }
 */
export function requestAccountFromDesktop({ instanceUrl } = {}, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      reject(new Error('The LANA desktop app isn’t connected. Install/open it, or use browser sign-in.'));
      return;
    }

    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* already gone */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for the LANA desktop app.')),
      timeoutMs
    );

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'PROVISION_RESULT') {
        if (validBundle(msg.account)) finish(resolve, msg.account);
        else finish(reject, new Error('The desktop app returned an invalid token bundle.'));
      } else if (msg.error) {
        finish(reject, new Error(String(msg.error)));
      }
      // else: ignore unrelated/keepalive frames
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      // Common case: no host registered → "Specified native messaging host not found".
      finish(reject, new Error(err && err.message ? err.message : 'The desktop app closed the connection.'));
    });

    port.postMessage({ type: 'PROVISION_REQUEST', instanceUrl: instanceUrl || null, source: 'extension' });
  });
}

/**
 * High-level: provision via the desktop app AND link it into the account store.
 * Returns the linked account id. Throws (with no side effects) on failure so the
 * caller can offer the OAuth fallback.
 *
 * @param {{instanceUrl?: string}} [opts]
 * @returns {Promise<{id: string, account: Object}>}
 */
export async function connectViaDesktop(opts = {}) {
  const bundle = await requestAccountFromDesktop(opts);
  // linkAccount returns only the token-derived, stripped identity — do NOT leak
  // the raw token bundle (with accessToken/refreshToken) back to UI closures.
  const { id, email, instanceUrl } = await linkAccount({ ...bundle, source: 'native' });
  return { id, account: { email, instanceUrl } };
}

/**
 * Best-effort probe: is a desktop native host reachable? Sends a PING and
 * resolves true on any PONG/response, false otherwise. Never throws.
 * @returns {Promise<boolean>}
 */
export function isDesktopAvailable({ timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let port;
    try { port = chrome.runtime.connectNative(NATIVE_HOST); } catch { resolve(false); return; }
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(t); try { port.disconnect(); } catch {} resolve(v); };
    const t = setTimeout(() => done(false), timeoutMs);
    port.onMessage.addListener(() => done(true));
    port.onDisconnect.addListener(() => done(false));
    try { port.postMessage({ type: 'PING' }); } catch { done(false); }
  });
}
