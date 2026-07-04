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

/** OAuth public client (PKCE) config — contract v0.2 §1. */
const OAUTH_CLIENT_ID = 'lana-extension';
const OAUTH_SCOPES =
  'matters.read matters.write agent.run playbooks.read playbooks.write inference';

// --- PKCE / random helpers (Web Crypto; available in the SW + documents) ---

/** base64url with no padding. */
function base64url(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Cryptographically-random URL-safe string (32 bytes → 43 chars by default). */
function randomUrlSafe(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 code challenge for a verifier. */
async function s256Challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(digest);
}

/**
 * @typedef {Object} AuthRecord
 * @property {'cookie'|'bearer'|null} mode
 * @property {'oauth'|'password'|null} [provider]  which bearer flow issued it —
 *   drives the refresh endpoint (oauth → /oauth/token, password → /auth/refresh)
 * @property {string|null} accessToken   bearer only
 * @property {string|null} refreshToken  bearer only
 * @property {number|null} expiresAt     epoch ms, bearer only
 * @property {string|null} [scope]       granted OAuth scopes
 * @property {string|null} email         best-effort, for display
 * @property {string|null} instanceUrl   the instance this record belongs to
 */

/** @returns {Promise<AuthRecord>} */
async function readAuth() {
  const data = await chrome.storage.local.get(AUTH_KEY);
  return (
    data[AUTH_KEY] || {
      mode: null,
      provider: null,
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      scope: null,
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
    provider: 'password',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    scope: null,
    email: email || null,
    instanceUrl: instance.url,
  };
  await writeAuth(rec);
  return rec;
}

/**
 * Authorize LANA GPT via OAuth 2.0 authorization-code + PKCE (contract v0.2 §1).
 * Opens the instance's `/oauth/authorize` in the dedicated auth window; the
 * instance decides login-vs-consent. Runs in a context with `chrome.identity`
 * (the service worker) and needs the `identity` permission + host permission for
 * the instance origin (granted before calling this).
 *
 * @returns {Promise<{authenticated: boolean, mode: string|null, email: string|null}>}
 * @throws {Error} on user cancel, state mismatch, or token exchange failure
 */
export async function authorizeOAuth() {
  const instance = await getInstance();
  // Pin the base to THIS instance for the whole flow (closes a mid-flow swap window).
  const base = await apiBase(instance.url);
  const redirectUri = chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/
  const verifier = randomUrlSafe(32);
  const challenge = await s256Challenge(verifier);
  const state = randomUrlSafe(16);

  // NOTE ON BASES (intentional, not a bug): `/oauth/authorize` is a USER-FACING
  // consent PAGE served by the web app at the instance ROOT (it reuses the
  // browser login session and renders HTML), so launchWebAuthFlow opens
  // `${instance.url}/oauth/authorize`. `/oauth/token` is the JSON API endpoint,
  // under `${base}` = `${instance.url}/api/v1`. Contract §1 documents this split.
  const authUrl =
    `${instance.url}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}`;

  // Throws on user-cancel/timeout; returns the full chromiumapp.org redirect URL.
  const redirect = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!redirect) throw new Error('Authorization was cancelled.');
  const params = new URL(redirect).searchParams;
  if (params.get('error')) {
    throw new Error(`Authorization failed: ${params.get('error_description') || params.get('error')}`);
  }
  // Verify state BEFORE using the code (CSRF).
  if (params.get('state') !== state) throw new Error('Authorization state mismatch (possible CSRF).');
  const code = params.get('code');
  if (!code) throw new Error('Authorization returned no code.');

  const tok = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!tok.ok) {
    const err = await tok.json().catch(() => ({}));
    throw new Error(err.error_description || err.error || `Token exchange failed (${tok.status})`);
  }
  const body = await tok.json();
  if (!body.access_token) throw new Error('Token response missing access_token.');

  await writeAuth({
    mode: 'bearer',
    provider: 'oauth',
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
    scope: body.scope || OAUTH_SCOPES,
    email: null,
    instanceUrl: instance.url,
  });
  return getAuthState();
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
  if (rec.instanceUrl === instance.url) return true;
  // Fail closed. A record bound to a DIFFERENT origin gets cleared so its token
  // is never transmitted. A record with NO instanceUrl is untrusted too (don't
  // send), but we don't wipe it — a fix-up path can set the binding.
  if (rec.instanceUrl) await clearAuth();
  return false;
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

  // Branch on the issuing flow (fixes the single-bearer-schema conflict):
  //   oauth    → POST /oauth/token grant_type=refresh_token (rotating, single-use)
  //   password → legacy POST /auth/refresh
  const isOAuth = rec.provider === 'oauth';
  const url = isOAuth ? `${base}/oauth/token` : `${base}/auth/refresh`;
  const init = isOAuth
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: rec.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      }
    : {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Legacy API accepts the refresh token in the header OR body.
          Authorization: `Bearer ${rec.refreshToken}`,
        },
        body: JSON.stringify({ refresh_token: rec.refreshToken }),
      };

  let resp;
  try {
    resp = await fetch(url, init);
  } catch {
    return null; // network error — keep the record, caller falls back to it
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
    // OAuth rotates the refresh token; adopt the new one when present.
    refreshToken: body.refresh_token || rec.refreshToken,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
  };
  await writeAuth(next);
  return next.accessToken; // (property is camelCase; access_token would be undefined)
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
  const nearExpiry = rec.expiresAt && Date.now() >= rec.expiresAt - REFRESH_SKEW_MS;
  if (nearExpiry) {
    const fresh = await refresh();
    if (fresh) return fresh;
    // Proactive refresh failed. If it was TRANSIENT (network error → _doRefresh
    // kept the record) and the current token hasn't actually expired, keep using
    // it rather than forcing a spurious reconnect. If refresh cleared auth (a
    // 401/rotation failure), the record is gone → return null.
    const after = await readAuth();
    if (after.mode === 'bearer' && after.accessToken && after.expiresAt && Date.now() < after.expiresAt) {
      return after.accessToken;
    }
    return null;
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
 * Base64url-decode a JWT payload. NO signature verification — this is for
 * DISPLAY/UX only (email, entitlements). The server independently verifies the
 * token and authorizes every request (contract §7). Never trust this for a
 * security decision. Returns null on any parse failure.
 */
function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const bin = atob(b64 + pad);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)); // utf-8 safe
  } catch {
    return null;
  }
}

/**
 * The org's entitlements from the access token's `entitlements` claim (contract
 * §7). UX-ONLY — used to show/hide features (e.g. hide BYO providers when
 * `byo_providers` is false). The SERVER is the source of truth and enforces
 * authz regardless; a tampered client token changes only what UI renders.
 * @returns {Promise<Object>} the entitlements object, or {} when unavailable
 */
export async function getEntitlements() {
  const rec = await readAuth();
  if (rec.mode !== 'bearer' || !rec.accessToken) return {};
  const claims = decodeJwtPayload(rec.accessToken);
  return (claims && typeof claims.entitlements === 'object' && claims.entitlements) || {};
}

/**
 * Current auth state for UI. `email` falls back to the token's `email` claim
 * when not stored (OAuth doesn't return it in the token response).
 * @returns {Promise<{authenticated: boolean, mode: string|null, provider: string|null, email: string|null}>}
 */
export async function getAuthState() {
  const rec = await readAuth();
  let email = rec.email;
  if (!email && rec.mode === 'bearer' && rec.accessToken) {
    email = decodeJwtPayload(rec.accessToken)?.email || null;
  }
  return {
    authenticated: rec.mode === 'bearer' ? !!rec.accessToken : rec.mode === 'cookie',
    mode: rec.mode,
    provider: rec.provider || null,
    email,
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
