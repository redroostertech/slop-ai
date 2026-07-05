// Tests that lib/lana-auth.js consumes the active linked account for API calls.
// Run: node test/lana-auth-multiaccount.test.mjs
import assert from 'node:assert';

const mem = {};
globalThis.chrome = {
  storage: { local: {
    get: async (k) => { const ks = typeof k === 'string' ? [k] : Object.keys(k || {}); const o = {}; for (const x of ks) if (x in mem) o[x] = mem[x]; return o; },
    set: async (o) => { Object.assign(mem, o); },
  } },
  management: { getSelf: async () => ({ installType: 'development' }) },
};
let fetchImpl = async () => { throw new Error('unset'); };
globalThis.fetch = (...a) => fetchImpl(...a);

const A = await import('../lib/accounts.js');
const Auth = await import('../lib/lana-auth.js');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

await A.linkAccount({ instanceUrl: 'https://tenant.example', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, source: 'native' });

await t('authorizedFetch targets the active account instance + bearer', async () => {
  let seen;
  fetchImpl = async (url, init) => { seen = { url, auth: new Headers(init.headers).get('Authorization') }; return { status: 200, ok: true, json: async () => ({}) }; };
  await Auth.authorizedFetch('matters');
  assert.equal(seen.url, 'https://tenant.example/api/v1/matters');
  assert.equal(seen.auth, 'Bearer AT');
});

await t('on 401 it refreshes via the account instance /oauth/token, retries, and persists the new token', async () => {
  fetchImpl = async (url, init) => {
    if (url.endsWith('/matters')) {
      const auth = new Headers(init.headers).get('Authorization');
      return auth === 'Bearer AT' ? { status: 401, ok: false } : { status: 200, ok: true, json: async () => ({}) };
    }
    if (url.endsWith('/oauth/token')) {
      const body = JSON.parse(init.body);
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.client_id, 'lana-extension');
      assert.equal(body.refresh_token, 'RT');
      return { status: 200, ok: true, json: async () => ({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }) };
    }
    throw new Error('unexpected ' + url);
  };
  const resp = await Auth.authorizedFetch('matters');
  assert.equal(resp.status, 200);
  const act = await A.getActiveAccount();
  assert.equal(act.accessToken, 'AT2');
  assert.equal(act.refreshToken, 'RT2');
});

await t('getAuthState + getEntitlements reflect the active account', async () => {
  const st = await Auth.getAuthState();
  assert.equal(st.authenticated, true);
  assert.equal(st.mode, 'bearer');
  // entitlements decode from the (non-JWT here) token → {} without throwing
  assert.deepEqual(await Auth.getEntitlements(), {});
});

await t('a dead refresh (invalid_grant) surfaces the 401 without throwing', async () => {
  await A.updateTokens((await A.getActiveAccount()).id, { accessToken: 'ATx', refreshToken: 'RTx' });
  fetchImpl = async (url) => {
    if (url.endsWith('/matters')) return { status: 401, ok: false };
    if (url.endsWith('/oauth/token')) return { status: 400, ok: false, json: async () => ({ error: 'invalid_grant' }) };
    throw new Error('unexpected ' + url);
  };
  const resp = await Auth.authorizedFetch('matters');
  assert.equal(resp.status, 401); // retry not attempted (refresh dead)
});

await t('concurrent 401s trigger a SINGLE refresh (single-flight, no replay)', async () => {
  await A.updateTokens((await A.getActiveAccount()).id, { accessToken: 'AT3', refreshToken: 'RT3', expiresIn: 3600 });
  let tokenPosts = 0;
  fetchImpl = async (url, init) => {
    if (url.endsWith('/matters')) {
      const auth = new Headers(init.headers).get('Authorization');
      return auth === 'Bearer AT4' ? { status: 200, ok: true } : { status: 401, ok: false };
    }
    if (url.endsWith('/oauth/token')) { tokenPosts += 1; await new Promise((r) => setTimeout(r, 10)); return { status: 200, ok: true, json: async () => ({ access_token: 'AT4', refresh_token: 'RT4', expires_in: 3600 }) }; }
    throw new Error('unexpected ' + url);
  };
  const results = await Promise.all([Auth.authorizedFetch('matters'), Auth.authorizedFetch('matters'), Auth.authorizedFetch('matters')]);
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
  assert.equal(tokenPosts, 1); // ONE refresh for 3 concurrent 401s — no consumed-token replay
});

console.log(`\nlana-auth multi-account: ${passed}/${passed} passed`);
