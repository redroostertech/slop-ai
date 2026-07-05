/**
 * @fileoverview Multi-account store for the extension (roaming across instances).
 *
 * The extension can be linked to several LANA instances at once — a LANA GPT
 * account, one or more LANA AI tenants (cloud/on-prem) — each with its own
 * per-user token. This module owns that list and the "active account" pointer.
 * It is the client foundation for the unified-identity/roaming initiative
 * (docs/IDENTITY_AND_ROAMING.md): multi-account from day one, no single-account
 * assumptions.
 *
 * Tokens are provisioned either by the desktop app over native messaging
 * (primary) or the browser OAuth flow (fallback); both land here the same way.
 *
 * Storage: chrome.storage.local key `lanaAccounts` = {
 *   accounts: [{ id, instanceUrl, label, email, accessToken, refreshToken,
 *                tokenType, expiresAt, source, addedAt }],
 *   activeId: string|null
 * }
 *
 * @module lib/accounts
 */

const KEY = 'lanaAccounts';

/** Stable account id from instance origin + email (so re-linking updates in place). */
function accountId(instanceUrl, email) {
  let origin = instanceUrl;
  try { origin = new URL(instanceUrl).origin; } catch { /* keep as-is */ }
  return `${origin}::${(email || '').toLowerCase()}`;
}

async function readStore() {
  try {
    const data = await chrome.storage.local.get(KEY);
    const s = data[KEY];
    if (s && Array.isArray(s.accounts)) return { accounts: s.accounts, activeId: s.activeId || null };
  } catch { /* fall through to empty */ }
  return { accounts: [], activeId: null };
}

async function writeStore(store) {
  await chrome.storage.local.set({ [KEY]: store });
  return store;
}

/** Public view of an account with the token material stripped (safe to render/log). */
function publicView(a) {
  if (!a) return null;
  return {
    id: a.id, instanceUrl: a.instanceUrl, label: a.label, email: a.email,
    source: a.source, addedAt: a.addedAt, expiresAt: a.expiresAt,
    isActive: undefined, // filled by callers that know activeId
  };
}

/** All linked accounts (token material stripped). */
export async function listAccounts() {
  const { accounts, activeId } = await readStore();
  return accounts.map((a) => ({ ...publicView(a), isActive: a.id === activeId }));
}

/** The active account WITH tokens (for making authorized calls). Null if none. */
export async function getActiveAccount() {
  const { accounts, activeId } = await readStore();
  if (!activeId) return accounts.length ? accounts[0] : null;
  return accounts.find((a) => a.id === activeId) || (accounts.length ? accounts[0] : null);
}

/** Count of linked accounts. */
export async function accountCount() {
  return (await readStore()).accounts.length;
}

/**
 * Link (or re-link) an account from a provisioned token bundle. Upserts by
 * (instance origin + email) so re-provisioning refreshes tokens in place rather
 * than duplicating. Becomes active if it's the first account.
 *
 * @param {{instanceUrl:string, email?:string, label?:string,
 *          accessToken:string, refreshToken?:string, tokenType?:string,
 *          expiresIn?:number, source?:'native'|'oauth'}} bundle
 * @returns {Promise<{id:string}>}
 */
export async function linkAccount(bundle) {
  if (!bundle || !bundle.instanceUrl || !bundle.accessToken) {
    throw new Error('linkAccount requires instanceUrl and accessToken');
  }
  const store = await readStore();
  const id = accountId(bundle.instanceUrl, bundle.email);
  const now = Date.now();
  const record = {
    id,
    instanceUrl: bundle.instanceUrl,
    label: bundle.label || bundle.email || (() => { try { return new URL(bundle.instanceUrl).host; } catch { return bundle.instanceUrl; } })(),
    email: bundle.email || null,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken || null,
    tokenType: bundle.tokenType || 'Bearer',
    expiresAt: bundle.expiresIn ? now + bundle.expiresIn * 1000 : null,
    source: bundle.source || 'oauth',
    addedAt: now,
  };
  const idx = store.accounts.findIndex((a) => a.id === id);
  if (idx >= 0) {
    // preserve original addedAt on re-link
    record.addedAt = store.accounts[idx].addedAt || now;
    store.accounts[idx] = record;
  } else {
    store.accounts.push(record);
  }
  if (!store.activeId) store.activeId = id;
  await writeStore(store);
  return { id };
}

/** Update just the tokens for an account (e.g. after a refresh rotation). */
export async function updateTokens(id, { accessToken, refreshToken, expiresIn }) {
  const store = await readStore();
  const a = store.accounts.find((x) => x.id === id);
  if (!a) return false;
  if (accessToken) a.accessToken = accessToken;
  if (refreshToken !== undefined) a.refreshToken = refreshToken;
  if (expiresIn) a.expiresAt = Date.now() + expiresIn * 1000;
  await writeStore(store);
  return true;
}

/** Switch the active account. */
export async function setActiveAccount(id) {
  const store = await readStore();
  if (!store.accounts.some((a) => a.id === id)) return false;
  store.activeId = id;
  await writeStore(store);
  return true;
}

/** Unlink an account; if it was active, fall back to the first remaining. */
export async function removeAccount(id) {
  const store = await readStore();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.activeId === id) store.activeId = store.accounts.length ? store.accounts[0].id : null;
  await writeStore(store);
  return store.accounts.length < before;
}
