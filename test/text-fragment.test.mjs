// Unit tests for lib/text-fragment.js. Run: node test/text-fragment.test.mjs
import assert from 'node:assert';
import { segments, fragmentsFor, fragmentUrl } from '../lib/text-fragment.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

t('segments: splits list items (newlines) and drops tiny bits', () => {
  const clip = 'Manage 1 brand\nManage all your brands social networks\nSchedule up to 20 posts per month';
  assert.deepEqual(segments(clip), [
    'Manage 1 brand',
    'Manage all your brands social networks',
    'Schedule up to 20 posts per month',
  ]);
});

t('segments: splits multiple sentences within a line', () => {
  const clip = 'A sequence is the ordered list of emails. Open Edit steps to change the copy or schedule.';
  const s = segments(clip);
  assert.equal(s.length, 2);
  assert.match(s[0], /^A sequence is the ordered list of emails\.$/);
});

t('segments: skips fragments under 3 words (too ambiguous to anchor)', () => {
  assert.deepEqual(segments('Hi there\nok'), []); // 2 words and 1 word — both dropped
});

t('fragmentsFor: one directive per segment (list → per item)', () => {
  const frags = fragmentsFor('Manage 1 brand\nSchedule up to 20 posts per month');
  assert.equal(frags.length, 2);
  frags.forEach((f) => assert.match(f, /^text=/));
});

t('long segment → textStart,textEnd anchors (first/last 7 words)', () => {
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
  const f = fragmentsFor(long)[0];
  assert.equal(f, 'text=one%20two%20three%20four%20five%20six%20seven,ten%20eleven%20twelve%20thirteen%20fourteen%20fifteen%20sixteen');
});

t('fragment delimiters (- and ,) percent-encoded out of the text', () => {
  const f = fragmentsFor('step 1, step 2 - and so on continues')[0];
  assert.ok(!/[,-]/.test(f.replace('text=', '')));
  assert.match(f, /%2C/); assert.match(f, /%2D/);
});

t('injection-safe: a hostile clip cannot inject a second directive', () => {
  const evil = 'x and y and z & text=INJECT #:~:evil " onmouseover=alert';
  const f = fragmentsFor(evil).join('&');
  assert.equal((f.match(/text=/g) || []).length, 1); // only OUR text=
  assert.ok(!f.includes('#') && !f.includes('"'));
});

t('fragmentUrl: multi-line clip → multiple highlights joined with &', () => {
  const u = fragmentUrl('https://x.com/p', 'Manage 1 brand\nSchedule up to 20 posts per month');
  assert.equal(u, 'https://x.com/p#:~:text=Manage%201%20brand&text=Schedule%20up%20to%2020%20posts%20per%20month');
});

t('fragmentUrl: several clips all contribute fragments', () => {
  const u = fragmentUrl('https://x.com/p', ['alpha beta gamma delta', 'one two three four']);
  assert.equal(u, 'https://x.com/p#:~:text=alpha%20beta%20gamma%20delta&text=one%20two%20three%20four');
});

t('fragmentUrl: strips an existing hash; bare url when nothing usable', () => {
  assert.equal(fragmentUrl('https://x.com/p#sec', 'alpha beta gamma delta'), 'https://x.com/p#:~:text=alpha%20beta%20gamma%20delta');
  assert.equal(fragmentUrl('https://x.com/p', ['', 'hi']), 'https://x.com/p');
});

t('fragmentUrl: caps the number of fragments', () => {
  const many = Array.from({ length: 40 }, (_, i) => `segment number ${i} here`).join('\n');
  const count = (fragmentUrl('https://x.com/p', many).match(/text=/g) || []).length;
  assert.ok(count <= 24, `expected ≤24 fragments, got ${count}`);
});

console.log(`\ntext-fragment.js: ${passed}/${passed} passed`);
