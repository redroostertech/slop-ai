// Unit tests for lib/accounts.js (multi-account store). Run: node test/accounts.test.mjs
import assert from 'node:assert';

// In-memory chrome.storage.local stub.
const mem = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => { const keys = typeof k === 'string' ? [k] : Object.keys(k || {}); const o = {}; for (const key of keys) if (key in mem) o[key] = mem[key]; return o; },
      set: async (o) => { Object.assign(mem, o); },
    },
  },
};

const A = await import('../lib/accounts.js');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// fresh store
assert.equal(await A.accountCount(), 0);
assert.equal(await A.getActiveAccount(), null);

await t('linkAccount adds + auto-activates the first account', async () => {
  const { id } = await A.linkAccount({ instanceUrl: 'https://gpt.lanaai.io', email: 'Mike@x.co', accessToken: 'at1', refreshToken: 'rt1', expiresIn: 3600, source: 'native' });
  assert.ok(id);
  const list = await A.listAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].isActive, true);
  assert.equal(list[0].email, 'Mike@x.co');
});

await t('listAccounts strips token material', async () => {
  const list = await A.listAccounts();
  assert.equal(list[0].accessToken, undefined);
  assert.equal(list[0].refreshToken, undefined);
});

await t('getActiveAccount returns tokens for authorized calls', async () => {
  const act = await A.getActiveAccount();
  assert.equal(act.accessToken, 'at1');
  assert.equal(act.tokenType, 'Bearer');
  assert.ok(act.expiresAt > Date.now());
});

await t('re-linking same instance+email upserts (no duplicate), preserves addedAt', async () => {
  const before = (await A.getActiveAccount()).addedAt;
  await new Promise((r) => setTimeout(r, 5));
  await A.linkAccount({ instanceUrl: 'https://gpt.lanaai.io/', email: 'mike@x.co', accessToken: 'at1b', refreshToken: 'rt1b' });
  assert.equal(await A.accountCount(), 1); // case-insensitive email + trailing slash → same id
  const act = await A.getActiveAccount();
  assert.equal(act.accessToken, 'at1b');
  assert.equal(act.addedAt, before);
});

await t('second distinct instance adds a second account, first stays active', async () => {
  await A.linkAccount({ instanceUrl: 'https://tenant.example', email: 'mike@x.co', accessToken: 'at2', source: 'oauth' });
  assert.equal(await A.accountCount(), 2);
  const list = await A.listAccounts();
  assert.equal(list.filter((a) => a.isActive).length, 1);
  assert.equal((await A.getActiveAccount()).accessToken, 'at1b');
});

await t('setActiveAccount switches the active pointer', async () => {
  const list = await A.listAccounts();
  const other = list.find((a) => !a.isActive);
  assert.equal(await A.setActiveAccount(other.id), true);
  assert.equal((await A.getActiveAccount()).accessToken, 'at2');
});

await t('updateTokens rotates in place', async () => {
  const act = await A.getActiveAccount();
  await A.updateTokens(act.id, { accessToken: 'at2-rotated', refreshToken: 'rt2-new', expiresIn: 60 });
  assert.equal((await A.getActiveAccount()).accessToken, 'at2-rotated');
});

await t('removeAccount unlinks + reassigns active', async () => {
  const act = await A.getActiveAccount();
  assert.equal(await A.removeAccount(act.id), true);
  assert.equal(await A.accountCount(), 1);
  assert.equal((await A.getActiveAccount()).accessToken, 'at1b'); // fell back to remaining
});

await t('linkAccount rejects a non-https instanceUrl (no token to attacker origin)', async () => {
  await assert.rejects(A.linkAccount({ instanceUrl: 'http://evil.tld', accessToken: 'x' }), /https/);
  await assert.rejects(A.linkAccount({ instanceUrl: 'not a url', accessToken: 'x' }), /./);
});

await t('linkAccount rejects a non-string accessToken', async () => {
  await assert.rejects(A.linkAccount({ instanceUrl: 'https://ok.example', accessToken: { evil: 1 } }), /accessToken/);
});

await t('updateTokens does not wipe the refresh token on null/absent', async () => {
  const { id } = await A.linkAccount({ instanceUrl: 'https://keep.example', accessToken: 'x', refreshToken: 'KEEP' });
  await A.setActiveAccount(id);
  await A.updateTokens(id, { accessToken: 'x2', refreshToken: null });
  assert.equal((await A.getActiveAccount()).refreshToken, 'KEEP');
  await A.updateTokens(id, { accessToken: 'x3' }); // absent → keep
  assert.equal((await A.getActiveAccount()).refreshToken, 'KEEP');
  await A.updateTokens(id, { accessToken: 'x4', refreshToken: 'NEW' }); // real rotation → update
  assert.equal((await A.getActiveAccount()).refreshToken, 'NEW');
});

console.log(`\naccounts.js: ${passed}/${passed} passed`);
