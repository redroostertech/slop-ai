/**
 * @fileoverview Desktop-bridge client — the extension's side of the handoff.
 *
 * The LANA desktop app (lana-ai-client) runs a loopback HTTP "PAC bridge" on
 * 127.0.0.1:7890 that, after a user consent prompt, hands a companion app a
 * token for the tenant the desktop app is signed into. For the browser
 * extension the bridge mints a SCOPED, app-gated token via the backend
 * /api/v1/oauth/provision endpoint (never the raw desktop session), and returns
 * it here. We validate it at the trust boundary and link it into the
 * multi-account store. See docs/IDENTITY_AND_ROAMING.md §3.
 *
 * Transport is loopback fetch (not native messaging) to reuse the existing
 * desktop bridge. Requires host permission for http://127.0.0.1/*.
 *
 * @module lib/native-bridge
 */

import { linkAccount } from './accounts.js';

/** The desktop PAC bridge. Loopback-only by the desktop app's hard rule. */
export const BRIDGE_ORIGIN = 'http://127.0.0.1:7890';
export const BRIDGE_TOKEN_PATH = '/lana-bridge/companion/request-token';
export const BRIDGE_HEALTH_PATH = '/lana-bridge/health';
/** On-the-wire companion app id the desktop bridge + backend recognize. */
export const APP_ID = 'lana-extension';

/** Is a host loopback (safe for cleartext http)? */
function isLoopbackHost(h) {
  const host = (h || '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Trust-boundary validation of the token bundle from the bridge (review HIGH):
 *  a non-string token, or an instanceUrl that isn't https (or http-loopback for
 *  dev), must never enter the store — it would later be sent as a bearer to an
 *  attacker origin. */
function validBundle(a) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.accessToken !== 'string' || !a.accessToken) return false;
  let u;
  try { u = new URL(a.instanceUrl); } catch { return false; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) return false;
  for (const f of ['email', 'label', 'refreshToken', 'tokenType']) {
    if (a[f] != null && typeof a[f] !== 'string') return false;
  }
  if (a.expiresIn != null && !(Number.isFinite(a.expiresIn) && a.expiresIn > 0)) return false;
  return true;
}

/**
 * Request a provisioned account from the desktop app over the loopback bridge.
 * Rejects (no side effects) if the app isn't running, the user declines, or it
 * times out — callers fall back to browser OAuth.
 *
 * @param {{instanceUrl?: string}} [_opts] reserved
 * @param {{timeoutMs?: number}} [cfg]
 * @returns {Promise<Object>} the validated account bundle
 */
export async function requestAccountFromDesktop(_opts = {}, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(`${BRIDGE_ORIGIN}${BRIDGE_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: APP_ID }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('Timed out waiting for the LANA desktop app.');
    throw new Error('The LANA desktop app isn’t reachable. Open it, or use browser sign-in.');
  }
  clearTimeout(timer);

  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    const code = data && data.error ? data.error : `http_${resp.status}`;
    if (code === 'denied') throw new Error('You declined the connection in the LANA desktop app.');
    if (code === 'not_signed_in') throw new Error('Sign in to the LANA desktop app first.');
    throw new Error(`The desktop app refused the request (${code}).`);
  }
  const account = data && data.account;
  if (!validBundle(account)) throw new Error('The desktop app returned an invalid token bundle.');
  return account;
}

/**
 * Provision via the desktop app AND link it into the account store. Returns only
 * the token-derived, stripped identity (never the raw token). Throws with no
 * side effects on failure so the caller can offer the OAuth fallback.
 *
 * @param {{instanceUrl?: string}} [opts]
 * @returns {Promise<{id: string, account: {email: (string|null), instanceUrl: string}}>}
 */
export async function connectViaDesktop(opts = {}) {
  const bundle = await requestAccountFromDesktop(opts);
  const { id, email, instanceUrl } = await linkAccount({ ...bundle, source: 'native' });
  return { id, account: { email, instanceUrl } };
}

/**
 * Best-effort probe: is the desktop bridge reachable? Hits the loopback health
 * endpoint (which the bridge answers 204 without a consent prompt). Never throws.
 * @returns {Promise<boolean>}
 */
export async function isDesktopAvailable({ timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BRIDGE_ORIGIN}${BRIDGE_HEALTH_PATH}`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return resp.status === 204 || resp.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}
