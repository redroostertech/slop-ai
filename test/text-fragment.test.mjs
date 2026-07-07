// Unit tests for lib/text-fragment.js. Run: node test/text-fragment.test.mjs
import assert from 'node:assert';
import { textFragment, fragmentUrl } from '../lib/text-fragment.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

t('short passage → single encoded textStart', () => {
  assert.equal(textFragment('Hello world'), 'text=Hello%20world');
});

t('empty / whitespace → no fragment', () => {
  assert.equal(textFragment(''), '');
  assert.equal(textFragment('   '), '');
});

t('long passage → textStart,textEnd anchored by first/last 6 words', () => {
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  const f = textFragment(long);
  assert.equal(f, 'text=one%20two%20three%20four%20five%20six,eight%20nine%20ten%20eleven%20twelve%20thirteen');
});

t('collapses internal whitespace/newlines', () => {
  assert.equal(textFragment('Re-queued\n  11   leads'), 'text=Re%2Dqueued%2011%20leads'); // note '-' → %2D
});

t('fragment delimiters (- and ,) in text are percent-encoded (no structure break)', () => {
  const f = textFragment('a, b-c');
  assert.ok(!/[,-]/.test(f.replace('text=', '')), 'no raw , or - survive in the directive'); // both encoded
  assert.match(f, /%2C/); // comma → %2C
  assert.match(f, /%2D/); // dash  → %2D
});

t('injection-safe: &, #, text=, quotes can not escape the fragment', () => {
  const evil = 'x&text=INJECT#:~:evil"onmouseover=';
  const f = textFragment(evil);
  // Only ONE "text=" (ours); the payload is fully encoded.
  assert.equal(f.match(/text=/g).length, 1);
  assert.ok(!f.includes('&') && !f.includes('#') && !f.includes('"'));
});

t('fragmentUrl single passage', () => {
  assert.equal(fragmentUrl('https://x.com/p', 'Hello world'), 'https://x.com/p#:~:text=Hello%20world');
});

t('fragmentUrl joins multiple passages with &', () => {
  const u = fragmentUrl('https://x.com/p', ['aaa', 'bbb']);
  assert.equal(u, 'https://x.com/p#:~:text=aaa&text=bbb');
});

t('fragmentUrl strips an existing hash on the base', () => {
  assert.equal(fragmentUrl('https://x.com/p#section', 'aaa'), 'https://x.com/p#:~:text=aaa');
});

t('fragmentUrl with no usable text → bare url', () => {
  assert.equal(fragmentUrl('https://x.com/p', ['', '  ']), 'https://x.com/p');
});

console.log(`\ntext-fragment.js: ${passed}/${passed} passed`);
