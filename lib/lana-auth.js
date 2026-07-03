/**
 * @fileoverview LANA AI authentication (hybrid).
 *
 * The extension never holds a Forge inference key. It authenticates to the
 * user's LANA instance and lets the instance pass through to Forge server-side.
 * Two auth modes, tried in this order by {@link authorizedFetch}:
 *
 *   1. COOKIE  — if the user is already logged into the instance in their
 *      browser, the httpOnly `lana_token` cookie rides along on
 *      `credentials: "include"` requests (needs host permission). Zero
 *      friction, no credentials handled by the extension.
 *   2. BEARER  — explicit email/password login → we store access + refresh
 *      tokens and send `Authorization: Bearer`. Works even with no logged-in
 *      tab (the on-prem case) and self-refreshes, because the web app's silent
 *      refresh only fires for the cookie path.
 *
 * Storage: chrome.storage.local key `lanaAuth`.
 *
 * @module lib/lana-auth
 */

import { apiBase, getInstance } from './instance.js';

const AUTH_KEY = 'lanaAuth';

/** Refresh a bearer token this many ms before it actually expires. */
const REFRESH_SKEW_MS = 60_000;

/**
 * @typedef {Object} AuthRecord
 * @property {'cookie'|'bearer'|null} mode
 * @property {string|null} accessToken   bearer only
 * @property {string|null} refreshToken  bearer only
 * @property {number|null} expiresAt     epoch ms, bearer only
 * @property {string|null} email         best-effort, for display
 * @property {string|null} instanceUrl   the instance this record belongs to
 */

/** @returns {Promise<AuthRecord>} */
async function readAuth() {
  const data = await chrome.storage.local.get(AUTH_KEY);
  return (
    data[AUTH_KEY] || {
      mode: null,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      email: null,
      instanceUrl: null,
    }
  );
}

/** @param {AuthRecord} rec */
async function writeAuth(rec) {
  await chrome.storage.local.set({ [AUTH_KEY]: rec });
}

/** Clear all stored auth (logout / instance change / refresh failure). */
export async function clearAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

/**
 * Explicit email/password login → bearer tokens.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<AuthRecord>}
 * @throws {Error} on bad credentials / unreachable instance
 */
export async function login(email, password) {
  const base = await apiBase();
  const resp = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || err.error || `Login failed (${resp.status})`);
  }
  const body = await resp.json();
  if (!body.access_token) throw new Error('Login response missing access_token.');
  const instance = await getInstance();
  const rec = {
    mode: 'bearer',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    email: email || null,
    instanceUrl: instance.url,
  };
  await writeAuth(rec);
  return rec;
}

/**
 * Confirm the stored auth record belongs to the CURRENTLY-configured instance.
 * Guards against sending a token minted for gpt.lanaai.io to a different (e.g.
 * attacker-controlled on-prem) origin after an instance swap. On mismatch we
 * clear auth so nothing is transmitted.
 * @param {AuthRecord} rec
 * @returns {Promise<boolean>} true if the record matches the current instance
 */
async function belongsToCurrentInstance(rec) {
  const instance = await getInstance();
  if (rec.instanceUrl && rec.instanceUrl !== instance.url) {
    await clearAuth();
    return false;
  }
  return true;
}

// Single-flight guard: concurrent LANA calls that both see an expired token
// must NOT each POST /auth/refresh — with a rotating refresh token the second
// call presents a consumed token and would spuriously clear a just-refreshed
// session. All callers share one in-flight refresh.
let _refreshInFlight = null;

/**
 * Exchange the stored refresh token for a fresh access token. Concurrency-safe.
 * @returns {Promise<string|null>} the new access token, or null on failure
 *   (in which case auth is cleared and the user must re-authenticate)
 */
export async function refresh() {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = _doRefresh().finally(() => {
    _refreshInFlight = null;
  });
  return _refreshInFlight;
}

async function _doRefresh() {
  const rec = await readAuth();
  if (rec.mode !== 'bearer' || !rec.refreshToken) return null;
  // Never send the refresh token to an origin it wasn't issued for.
  if (!(await belongsToCurrentInstance(rec))) return null;
  const base = await apiBase();
  let resp;
  try {
    resp = await fetch(`${base}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API accepts the refresh token in the Authorization header OR body;
        // send both so either server implementation is satisfied.
        Authorization: `Bearer ${rec.refreshToken}`,
      },
      body: JSON.stringify({ refresh_token: rec.refreshToken }),
    });
  } catch {
    return null; // network error — keep the record, caller falls back
  }
  if (!resp.ok) {
    await clearAuth();
    return null;
  }
  const body = await resp.json().catch(() => ({}));
  if (!body.access_token) {
    await clearAuth();
    return null;
  }
  const next = {
    ...rec,
    accessToken: body.access_token,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
  };
  await writeAuth(next);
  return next.access_token;
}

/**
 * Return a valid bearer access token, refreshing proactively if it's within
 * the skew window of expiry. Returns null in cookie mode (nothing to send) or
 * when not authenticated.
 * @returns {Promise<string|null>}
 */
export async function getAccessToken() {
  const rec = await readAuth();
  if (rec.mode !== 'bearer' || !rec.accessToken) return null;
  if (rec.expiresAt && Date.now() >= rec.expiresAt - REFRESH_SKEW_MS) {
    return (await refresh()) || null;
  }
  return rec.accessToken;
}

/**
 * Probe whether the user has a live cookie session on the instance. GETs
 * `/me` with credentials included; a 200 means the httpOnly cookie is valid.
 * Requires host permission for the instance origin (see instance.js).
 * @returns {Promise<{ok: boolean, email?: string}>}
 */
export async function detectCookieSession() {
  const base = await apiBase();
  try {
    const resp = await fetch(`${base}/me`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) return { ok: false };
    const me = await resp.json().catch(() => ({}));
    return { ok: true, email: me.email || me.user?.email };
  } catch {
    return { ok: false };
  }
}

/**
 * If a cookie session is live, record COOKIE mode so authorizedFetch uses it.
 * Call this after granting host permission. Bearer mode (explicit login) takes
 * precedence and is never overwritten here.
 * @returns {Promise<AuthRecord|null>}
 */
export async function adoptCookieSession() {
  const rec = await readAuth();
  if (rec.mode === 'bearer') return rec; // explicit login wins
  const probe = await detectCookieSession();
  if (!probe.ok) return null;
  const instance = await getInstance();
  const next = {
    mode: 'cookie',
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    email: probe.email || null,
    instanceUrl: instance.url,
  };
  await writeAuth(next);
  return next;
}

/**
 * Current auth state for UI.
 * @returns {Promise<{authenticated: boolean, mode: string|null, email: string|null}>}
 */
export async function getAuthState() {
  const rec = await readAuth();
  return {
    authenticated: rec.mode === 'bearer' ? !!rec.accessToken : rec.mode === 'cookie',
    mode: rec.mode,
    email: rec.email,
  };
}

/**
 * The one fetch every LANA account/inference call should go through. Applies
 * the right auth for the current mode and retries ONCE on a 401 (bearer:
 * refresh then retry; cookie: nothing to retry, surfaces the 401).
 *
 * @param {string} path   path under the instance `/api/v1`, e.g. `matters` or
 *                        `inference/complete`. Leading slash optional.
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 * @throws {Error} when not authenticated at all
 */
export async function authorizedFetch(path, init = {}) {
  const rec = await readAuth();
  if (!rec.mode) throw new Error('Not signed in to LANA. Connect your account in Settings.');
  // Refuse to send credentials to an origin the record wasn't issued for.
  if (!(await belongsToCurrentInstance(rec))) {
    throw new Error('LANA instance changed; reconnect your account in Settings.');
  }
  const base = await apiBase();
  const url = `${base}/${String(path).replace(/^\/+/, '')}`;

  const doFetch = async (accessToken) => {
    const headers = new Headers(init.headers || {});
    const reqInit = { ...init, headers };
    if (rec.mode === 'cookie') {
      reqInit.credentials = 'include';
    } else {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return fetch(url, reqInit);
  };

  if (rec.mode === 'cookie') return doFetch(null);

  // Bearer: never fire an unauthenticated request. If we can't obtain a token
  // (missing / proactive refresh failed → auth cleared), surface it instead of
  // silently sending a bare, guaranteed-401 request.
  const token = await getAccessToken();
  if (!token) throw new Error('LANA session expired. Reconnect your account in Settings.');
  let resp = await doFetch(token);
  if (resp.status === 401) {
    const fresh = await refresh();
    if (fresh) resp = await doFetch(fresh);
  }
  return resp;
}
