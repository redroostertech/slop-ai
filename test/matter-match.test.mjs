// Unit tests for lib/matter-match.js. Run: node test/matter-match.test.mjs
import assert from 'node:assert';
import { matchMatters } from '../lib/matter-match.js';

const MATTERS = [
  { id: 'm1', name: 'Acme Corp acquisition' },
  { id: 'm2', name: 'Smith personal injury' },
  { id: 'm3', name: 'Johnson landlord dispute' },
];

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const ids = (arr) => arr.map((s) => s.matter_id);

t('ranks the matter whose name keywords appear in the clip', () => {
  const out = matchMatters('The Acme acquisition closed after due diligence on the corp.', MATTERS);
  assert.equal(out[0].matter_id, 'm1');
  assert.ok(out[0].score > 0);
  assert.match(out[0].reason, /acme|acquisition|corp/i);
});

t('returns only matters with a keyword hit', () => {
  const out = matchMatters('landlord withheld the security deposit from the tenant', MATTERS);
  assert.deepEqual(ids(out), ['m3']);
});

t('no keyword overlap → empty (honest default, UI falls back to manual pick)', () => {
  assert.deepEqual(matchMatters('completely unrelated weather forecast', MATTERS), []);
});

t('empty / missing inputs are safe', () => {
  assert.deepEqual(matchMatters('', MATTERS), []);
  assert.deepEqual(matchMatters('acme', []), []);
  assert.deepEqual(matchMatters('acme', null), []);
  assert.deepEqual(matchMatters(null, MATTERS), []);
});

t('stopwords and short tokens do not create spurious matches', () => {
  // "The Case" is all stopwords ('the','case') → no signal.
  const noise = [{ id: 'x', name: 'The Case' }];
  assert.deepEqual(matchMatters('the case is about the case', noise), []);
});

t('respects the limit and sorts by descending score', () => {
  const many = [
    { id: 'a', name: 'contract' },              // 1/1 keyword → score 1.0
    { id: 'b', name: 'contract dispute review' }, // 1/3 → ~0.33
    { id: 'c', name: 'lease' },
  ];
  const out = matchMatters('a contract question', many, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].matter_id, 'a');
});

t('accepts matter_id as the id field (server-shaped input)', () => {
  const out = matchMatters('acme deal', [{ matter_id: 'z', name: 'Acme deal' }]);
  assert.equal(out[0].matter_id, 'z');
});

console.log(`\nmatter-match.js: ${passed}/${passed} passed`);
