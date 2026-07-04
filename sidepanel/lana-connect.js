/**
 * @fileoverview LANA account connect controller (sidepanel).
 *
 * This is where the instance HOST PERMISSION is requested. chrome.permissions
 * .request() must run from a DOCUMENT under a user gesture — it cannot run in
 * the service worker — so the connect flow lives here, not in the SW. Without
 * this grant every LANA fetch (login, cookie probe, inference, ingestion) is
 * blocked, which is the gap the integration review flagged.
 *
 * TO WIRE: import { mountConnect } and call it with your Settings buttons, e.g.
 *   import { mountConnect } from './lana-connect.js';
 *   mountConnect({
 *     onState: (s) => renderAuthBadge(s),
 *     getCredentials: () => ({ email: emailInput.value, password: pwInput.value }),
 *   });
 * and call connectViaCookie()/connectViaLogin()/disconnect() from click handlers.
 *
 * @module sidepanel/lana-connect
 */

import { ensureHostPermission, normalizeInstanceUrl } from '../lib/instance.js';

/** Ask the SW to run an auth/account operation. */
function send(message) {
  return chrome.runtime.sendMessage(message).then((r) => {
    if (r && r.error) throw new Error(r.error);
    return r;
  });
}

/** Current auth state (delegates to the SW handler). */
export function getState() {
  return send({ type: 'LANA_AUTH_STATE' });
}

/** The currently-configured instance (for populating the Settings field). */
export function getInstanceInfo() {
  return send({ type: 'LANA_INSTANCE_GET' }).then((r) => r.instance);
}

/** Set/point the instance (cloud or on-prem), then request its host permission.
 * MUST be invoked from a click handler (user gesture) for the permission prompt.
 *
 * GESTURE ORDER: we normalize the URL synchronously and fire the permission
 * request FIRST, before the awaited LANA_INSTANCE_SET round-trip to the SW.
 * Awaiting that message first would consume the transient user activation and
 * Chrome would reject chrome.permissions.request().
 *
 * @param {{url: string, label?: string, kind?: string}} instance
 * @returns {Promise<{granted: boolean, instance: Object}>}
 */
export async function selectInstance(instance) {
  const url = normalizeInstanceUrl(instance.url); // sync — keeps the gesture
  const granted = await ensureHostPermission(url); // user-gesture required
  const { instance: stored } = await send({ type: 'LANA_INSTANCE_SET', instance });
  return { granted, instance: stored };
}

/**
 * Connect by adopting an existing browser cookie session on the instance.
 * Requests host permission first (needs the grant to send credentials:include).
 * Pass the known instance URL so the permission request fires without an async
 * storage read consuming the click's user gesture.
 * @param {string} [instanceUrl] the configured instance origin
 * @returns {Promise<{adopted: boolean, state: Object}>}
 */
export async function connectViaCookie(instanceUrl) {
  const granted = await ensureHostPermission(instanceUrl); // user gesture
  if (!granted) throw new Error('Permission to reach the LANA instance was declined.');
  return send({ type: 'LANA_ADOPT_COOKIE' });
}

/**
 * PRIMARY connect path: Authorize LANA GPT via OAuth 2.0 + PKCE. Requests host
 * permission first (needs the click's user gesture — this must be the FIRST
 * await), then the SW runs launchWebAuthFlow. Pass the known instance URL so the
 * permission request fires without an async storage read consuming the gesture.
 * @param {string} [instanceUrl] the configured instance origin
 * @returns {Promise<Object>} auth state
 */
export async function connectViaOAuth(instanceUrl) {
  const granted = await ensureHostPermission(instanceUrl); // user gesture (must be first)
  if (!granted) throw new Error('Permission to reach the LANA instance was declined.');
  // launchWebAuthFlow does not itself require a user gesture, so the SW round-trip
  // after the grant is fine.
  return send({ type: 'LANA_AUTHORIZE' });
}

/**
 * Connect by explicit email/password login (legacy / on-prem fallback — OAuth is
 * primary; see connectViaOAuth and contract §1.6).
 * @param {string} email
 * @param {string} password
 * @param {string} [instanceUrl] the configured instance origin
 * @returns {Promise<Object>} auth state
 */
export async function connectViaLogin(email, password, instanceUrl) {
  const granted = await ensureHostPermission(instanceUrl); // user gesture
  if (!granted) throw new Error('Permission to reach the LANA instance was declined.');
  return send({ type: 'LANA_LOGIN', email, password });
}

/** Disconnect (clears stored tokens). */
export function disconnect() {
  return send({ type: 'LANA_LOGOUT' });
}

/**
 * Convenience mount: wires state refresh + exposes the actions. Returns the
 * action set so the caller can bind them to buttons.
 * @param {{onState?: (s: Object) => void}} [opts]
 */
export function mountConnect(opts = {}) {
  const refresh = async () => {
    const state = await getState().catch(() => ({ authenticated: false }));
    opts.onState?.(state);
    return state;
  };
  refresh();
  return { refresh, getInstanceInfo, selectInstance, connectViaOAuth, connectViaCookie, connectViaLogin, disconnect };
}
