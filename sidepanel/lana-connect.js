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

import { getInstance, setInstance, ensureHostPermission } from '../lib/instance.js';

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

/** Set/point the instance (cloud or on-prem), then request its host permission.
 * MUST be invoked from a click handler (user gesture) for the permission prompt.
 * @param {{url: string, label?: string, kind?: string}} instance
 * @returns {Promise<{granted: boolean, instance: Object}>}
 */
export async function selectInstance(instance) {
  const { instance: stored } = await send({ type: 'LANA_INSTANCE_SET', instance });
  const granted = await ensureHostPermission(stored.url); // user-gesture required
  return { granted, instance: stored };
}

/**
 * Connect by adopting an existing browser cookie session on the instance.
 * Requests host permission first (needs the grant to send credentials:include).
 * @returns {Promise<{adopted: boolean, state: Object}>}
 */
export async function connectViaCookie() {
  const instance = await getInstance();
  const granted = await ensureHostPermission(instance.url); // user gesture
  if (!granted) throw new Error('Permission to reach the LANA instance was declined.');
  return send({ type: 'LANA_ADOPT_COOKIE' });
}

/**
 * Connect by explicit email/password login.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} auth state
 */
export async function connectViaLogin(email, password) {
  const instance = await getInstance();
  const granted = await ensureHostPermission(instance.url); // user gesture
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
  return { refresh, selectInstance, connectViaCookie, connectViaLogin, disconnect };
}
