// Unit tests for lib/native-bridge.js (loopback-HTTP desktop bridge client).
// Run: node test/native-bridge.test.mjs
import assert from 'node:assert';

const mem = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => { const keys = typeof k === 'string' ? [k] : Object.keys(k || {}); const o = {}; for (const key of keys) if (key in mem) o[key] = mem[key]; return o; },
  set: async (o) => { Object.assign(mem, o); },
} } };

// Controllable fetch stub.
let fetchImpl = async () => { throw new Error('not set'); };
globalThis.fetch = (...args) => fetchImpl(...args);
const jsonResp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const NB = await import('../lib/native-bridge.js');
const A = await import('../lib/accounts.js');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

await t('requestAccountFromDesktop POSTs the app id + returns the account bundle', async () => {
  let seen;
  fetchImpl = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return jsonResp(200, { account: { instanceUrl: 'https://t.example', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 } }); };
  const acct = await NB.requestAccountFromDesktop();
  assert.match(seen.url, /127\.0\.0\.1:7890\/lana-bridge\/companion\/request-token/);
  assert.equal(seen.body.app, 'lana-extension');
  assert.equal(acct.accessToken, 'AT');
});

await t('accepts an http-LOOPBACK dev instanceUrl', async () => {
  fetchImpl = async () => jsonResp(200, { account: { instanceUrl: 'http://localhost:8080', accessToken: 'ATdev' } });
  const acct = await NB.requestAccountFromDesktop();
  assert.equal(acct.instanceUrl, 'http://localhost:8080');
});

await t('connectViaDesktop links the account (source=native), returns stripped id', async () => {
  fetchImpl = async () => jsonResp(200, { account: { instanceUrl: 'https://t.example', accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 } });
  const { id, account } = await NB.connectViaDesktop();
  assert.ok(id);
  assert.equal(account.accessToken, undefined); // stripped
  assert.equal((await A.getActiveAccount()).accessToken, 'AT2');
  assert.equal((await A.getActiveAccount()).source, 'native');
});

await t('maps denied / not-signed-in to friendly errors', async () => {
  fetchImpl = async () => jsonResp(403, { error: 'denied' });
  await assert.rejects(NB.requestAccountFromDesktop(), /declined/);
  fetchImpl = async () => jsonResp(401, { error: 'not_signed_in' });
  await assert.rejects(NB.requestAccountFromDesktop(), /Sign in/);
});

await t('rejects when the bridge is unreachable', async () => {
  fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(NB.requestAccountFromDesktop(), /isn’t reachable|reachable/);
});

await t('rejects an invalid bundle (non-loopback http instanceUrl) at the boundary', async () => {
  fetchImpl = async () => jsonResp(200, { account: { instanceUrl: 'http://evil.tld', accessToken: 'X' } });
  await assert.rejects(NB.requestAccountFromDesktop(), /invalid token bundle/);
});

await t('isDesktopAvailable → true on 204, false when unreachable', async () => {
  fetchImpl = async () => jsonResp(204, null);
  assert.equal(await NB.isDesktopAvailable(), true);
  fetchImpl = async () => { throw new Error('down'); };
  assert.equal(await NB.isDesktopAvailable({ timeoutMs: 50 }), false);
});

console.log(`\nnative-bridge.js: ${passed}/${passed} passed`);
