// Unit tests for lib/notify.js gating. Run: node test/notify.test.mjs
import assert from 'node:assert';

let prefs = { notify: true };
let permGranted = true;
let created = [];
let focused = false;

globalThis.document = { hasFocus: () => focused };
globalThis.chrome = {
  storage: { local: { get: async () => ({ lanaAgentPrefs: prefs }) } },
  permissions: { contains: async () => permGranted, request: async () => true },
  notifications: { create: (id, opts) => created.push({ id, opts }) },
  runtime: { getURL: (p) => `chrome-extension://x/${p}` },
};

const { notifyDone, requestNotifPermission } = await import('../lib/notify.js');

let passed = 0;
const t = async (name, fn) => { created = []; await fn(); passed++; console.log(`  ✓ ${name}`); };

await t('shows a notification when enabled, unfocused, permitted', async () => {
  prefs = { notify: true }; permGranted = true; focused = false;
  assert.equal(await notifyDone({ id: 'x', title: 'T', message: 'M' }), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, 'x');
  assert.match(created[0].opts.iconUrl, /icon48\.png$/);
});

await t('suppressed when the toggle is OFF', async () => {
  prefs = { notify: false };
  assert.equal(await notifyDone({ id: 'x' }), false);
  assert.equal(created.length, 0);
});

await t('suppressed when the panel is focused (unless force)', async () => {
  prefs = { notify: true }; focused = true;
  assert.equal(await notifyDone({ id: 'x' }), false);
  assert.equal(await notifyDone({ id: 'x', force: true }), true); // force bypasses focus (SW path)
});

await t('suppressed when the notifications permission is not granted', async () => {
  prefs = { notify: true }; focused = false; permGranted = false;
  assert.equal(await notifyDone({ id: 'x' }), false);
  assert.equal(created.length, 0);
});

await t('requestNotifPermission delegates to chrome.permissions.request', async () => {
  assert.equal(await requestNotifPermission(), true);
});

console.log(`\nnotify.js: ${passed}/${passed} passed`);
