/**
 * Unit tests for the hybrid cascade router's DECISION logic (lib/router.js).
 * Pure functions — no browser needed. Run: `npm test` (or `node this-file`).
 *
 * We shim the browser globals the module graph touches so the ESM import
 * resolves under Node. decideRoute/assessDraft/estimateTokens don't call them.
 */
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  runtime: {}, offscreen: {}, permissions: {},
};
globalThis.self = globalThis;

const { decideRoute, assessDraft, estimateTokens } = await import('../lib/router.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('  FAIL:', name); } };
const msgs = (chars) => [{ role: 'user', content: 'x'.repeat(chars) }];
const ctxOn = { localAvailable: true, authenticated: true, online: true, localWindowTokens: 4096 };

// Privacy pins — must NEVER escalate.
ok('sensitive -> local', decideRoute({ messages: msgs(10), sensitive: true }, ctxOn).target === 'local');
ok('forceLocal -> local', decideRoute({ messages: msgs(10), forceLocal: true }, ctxOn).target === 'local');
ok('sensitive stays local even huge+account',
  decideRoute({ messages: msgs(999999), sensitive: true, requiresAccount: true }, ctxOn).target === 'local');

// Escalation triggers.
ok('requiresAccount -> escalate', decideRoute({ messages: msgs(10), requiresAccount: true }, ctxOn).target === 'escalate');
ok('highCapability -> escalate', decideRoute({ messages: msgs(10), highCapability: true }, ctxOn).target === 'escalate');
ok('too big -> escalate', decideRoute({ messages: msgs(4096 * 4 + 400) }, ctxOn).target === 'escalate');
ok('no local backend -> escalate', decideRoute({ messages: msgs(10) }, { ...ctxOn, localAvailable: false }).target === 'escalate');

// Connectivity / auth gate — can't escalate, must stay local.
ok('offline -> local', decideRoute({ messages: msgs(10) }, { ...ctxOn, online: false }).target === 'local');
ok('not authed -> local', decideRoute({ messages: msgs(10) }, { ...ctxOn, authenticated: false }).target === 'local');
ok('forceEscalate but offline -> local',
  decideRoute({ messages: msgs(10), forceEscalate: true }, { ...ctxOn, online: false }).target === 'local');

// Happy path.
ok('small + ready -> draft-then-verify', decideRoute({ messages: msgs(40) }, ctxOn).target === 'draft-then-verify');

// Draft confidence heuristic.
ok('empty draft not confident', assessDraft('').confident === false);
ok('short draft not confident', assessDraft('too short').confident === false);
ok('hedged draft not confident',
  assessDraft("I'm sorry, I cannot determine that from the provided information at all here.").confident === false);
ok('good draft confident',
  assessDraft('The statute of limitations for this claim is four years under the applicable code, and the deadline has not passed.').confident === true);

// Token estimate.
ok('token estimate ~ chars/4', estimateTokens(msgs(400)) === 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
