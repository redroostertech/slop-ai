// Unit tests for the Memory-preference client methods in lib/lana-client.js.
// Exercises getMemoryPreference/setMemoryPreference through the real
// authorizedFetch path (active-account branch) with a stubbed global fetch.
// Run: node test/lana-memory-pref.test.mjs
import assert from 'node:assert';

// In-memory chrome.storage.local stub (shared by accounts + auth).
const mem = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => { const keys = typeof k === 'string' ? [k] : Object.keys(k || {}); const o = {}; for (const key of keys) if (key in mem) o[key] = mem[key]; return o; },
    set: async (o) => { Object.assign(mem, o); },
    remove: async (k) => { const keys = typeof k === 'string' ? [k] : k; for (const key of keys) delete mem[key]; },
  } },
  runtime: {}, permissions: {},
};

// Controllable fetch stub — records the last request and returns a scripted resp.
let seen = null;
let fetchImpl = async () => { throw new Error('fetch not scripted'); };
globalThis.fetch = (...args) => { seen = { url: args[0], init: args[1] }; return fetchImpl(...args); };
const jsonResp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const A = await import('../lib/accounts.js');
const C = await import('../lib/lana-client.js');

// Sign in via a linked active account (authorizedFetch → account instance + token).
await A.linkAccount({ instanceUrl: 'https://t.example', email: 'm@x.co', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, source: 'native' });

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ---- getMemoryPreference ----

await t('GET returns the server value (enabled:false) and hits memory/preference', async () => {
  fetchImpl = async () => jsonResp(200, { enabled: false });
  const r = await C.getMemoryPreference();
  assert.deepEqual(r, { enabled: false });
  assert.match(String(seen.url), /\/api\/v1\/memory\/preference$/);
  assert.equal((seen.init && seen.init.method) || 'GET', 'GET');
});

await t('GET with an absent/garbled body soft-defaults to enabled:true', async () => {
  fetchImpl = async () => jsonResp(200, {});
  assert.deepEqual(await C.getMemoryPreference(), { enabled: true });
});

await t('GET 404 (endpoint not deployed) → enabled:true, no throw', async () => {
  fetchImpl = async () => jsonResp(404, {});
  assert.deepEqual(await C.getMemoryPreference(), { enabled: true });
});

await t('GET network error → enabled:true, no throw', async () => {
  fetchImpl = async () => { throw new Error('offline'); };
  assert.deepEqual(await C.getMemoryPreference(), { enabled: true });
});

await t('GET 500 throws (a real server error is not swallowed)', async () => {
  fetchImpl = async () => jsonResp(500, { detail: 'boom' });
  await assert.rejects(C.getMemoryPreference(), /boom|preference/);
});

// ---- setMemoryPreference ----

await t('PUT sends {enabled} and echoes the server value', async () => {
  fetchImpl = async () => jsonResp(200, { enabled: true });
  const r = await C.setMemoryPreference(true);
  assert.deepEqual(r, { enabled: true });
  assert.equal(seen.init.method, 'PUT');
  assert.deepEqual(JSON.parse(seen.init.body), { enabled: true });
});

await t('PUT coerces truthy input to a boolean in the body', async () => {
  fetchImpl = async () => jsonResp(200, { enabled: false });
  const r = await C.setMemoryPreference(0);
  assert.deepEqual(JSON.parse(seen.init.body), { enabled: false });
  assert.deepEqual(r, { enabled: false });
});

await t('PUT 404 → resolves to the requested value (local gate still applies)', async () => {
  fetchImpl = async () => jsonResp(404, {});
  assert.deepEqual(await C.setMemoryPreference(false), { enabled: false });
});

await t('PUT 500 throws so the caller can revert the toggle', async () => {
  fetchImpl = async () => jsonResp(500, { detail: 'nope' });
  await assert.rejects(C.setMemoryPreference(true), /nope|preference/);
});

console.log(`\nlana-client memory preference: ${passed}/${passed} passed`);
