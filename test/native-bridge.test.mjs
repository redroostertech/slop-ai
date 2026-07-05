// Unit tests for lib/native-bridge.js. Run: node test/native-bridge.test.mjs
import assert from 'node:assert';

const mem = {};
let portBehavior = () => {};
globalThis.chrome = {
  runtime: {
    lastError: null,
    connectNative() {
      const msgL = [], discL = [];
      const port = {
        onMessage: { addListener: (fn) => msgL.push(fn) },
        onDisconnect: { addListener: (fn) => discL.push(fn) },
        disconnect() {},
        postMessage(m) {
          // drive the "host" reaction on next tick so listeners are all registered
          setTimeout(() => portBehavior(m, {
            emit: (x) => msgL.forEach((f) => f(x)),
            disconnect: () => discL.forEach((f) => f()),
          }), 0);
        },
      };
      return port;
    },
  },
  storage: {
    local: {
      get: async (k) => { const keys = typeof k === 'string' ? [k] : Object.keys(k || {}); const o = {}; for (const key of keys) if (key in mem) o[key] = mem[key]; return o; },
      set: async (o) => { Object.assign(mem, o); },
    },
  },
};

const NB = await import('../lib/native-bridge.js');
const A = await import('../lib/accounts.js');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

await t('requestAccountFromDesktop resolves the account bundle on PROVISION_RESULT', async () => {
  portBehavior = (m, port) => { if (m.type === 'PROVISION_REQUEST') port.emit({ type: 'PROVISION_RESULT', account: { instanceUrl: 'https://t.example', email: 'a@b.co', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 } }); };
  const acct = await NB.requestAccountFromDesktop({ instanceUrl: 'https://t.example' });
  assert.equal(acct.accessToken, 'AT');
  assert.equal(acct.instanceUrl, 'https://t.example');
});

await t('connectViaDesktop links the provisioned account (source=native)', async () => {
  portBehavior = (m, port) => port.emit({ type: 'PROVISION_RESULT', account: { instanceUrl: 'https://t.example', email: 'a@b.co', accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 } });
  const { id } = await NB.connectViaDesktop({ instanceUrl: 'https://t.example' });
  assert.ok(id);
  const active = await A.getActiveAccount();
  assert.equal(active.accessToken, 'AT2');
  assert.equal(active.source, 'native');
});

await t('rejects with the host error message', async () => {
  portBehavior = (m, port) => port.emit({ error: 'User declined in the desktop app' });
  await assert.rejects(NB.requestAccountFromDesktop(), /User declined/);
});

await t('rejects when the host disconnects (not installed)', async () => {
  portBehavior = (m, port) => { chrome.runtime.lastError = { message: 'Specified native messaging host not found.' }; port.disconnect(); };
  await assert.rejects(NB.requestAccountFromDesktop(), /native messaging host not found/);
  chrome.runtime.lastError = null;
});

await t('times out cleanly when the host never answers', async () => {
  portBehavior = () => {}; // silence
  await assert.rejects(NB.requestAccountFromDesktop({}, { timeoutMs: 30 }), /Timed out/);
});

await t('isDesktopAvailable → true on any response, false on disconnect', async () => {
  portBehavior = (m, port) => port.emit({ type: 'PONG' });
  assert.equal(await NB.isDesktopAvailable(), true);
  portBehavior = (m, port) => port.disconnect();
  assert.equal(await NB.isDesktopAvailable({ timeoutMs: 50 }), false);
});

await t('rejects an invalid bundle (non-https instanceUrl) at the boundary', async () => {
  portBehavior = (m, port) => port.emit({ type: 'PROVISION_RESULT', account: { instanceUrl: 'http://evil.tld', accessToken: 'X' } });
  await assert.rejects(NB.requestAccountFromDesktop(), /invalid token bundle/);
});

await t('rejects an invalid bundle (non-string accessToken)', async () => {
  portBehavior = (m, port) => port.emit({ type: 'PROVISION_RESULT', account: { instanceUrl: 'https://ok.example', accessToken: { evil: 1 } } });
  await assert.rejects(NB.requestAccountFromDesktop(), /invalid token bundle/);
});

console.log(`\nnative-bridge.js: ${passed}/${passed} passed`);
