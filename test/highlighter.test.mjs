// Unit tests for lib/highlighter.js pure matching. Run: node test/highlighter.test.mjs
import assert from 'node:assert';
import { normalize, flatten, locate, locateAll, segmentsOf } from '../lib/highlighter.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

t('normalize: lowercase + collapse whitespace + trim', () => {
  assert.equal(normalize('  Hello   \n World  '), 'hello world');
});

t('flatten: inline-split text nodes join with NO space', () => {
  // "Man" + "age 1" split across inline nodes (not block) → "manage 1"
  const { flat } = flatten([{ text: 'Man' }, { text: 'age 1' }]);
  assert.equal(flat, 'manage 1');
});

t('flatten: block boundaries insert a separator (list items dont run together)', () => {
  const { flat } = flatten([
    { text: 'Manage 1 brand', block: true },
    { text: 'Manage all your brands', block: true },
    { text: 'Schedule up to 20 posts', block: true },
  ]);
  assert.equal(flat, 'manage 1 brand manage all your brands schedule up to 20 posts');
});

t('flatten: internal whitespace collapses; map points back to original offsets', () => {
  const { flat, map } = flatten([{ text: 'Hello   world' }]);
  assert.equal(flat, 'hello world');
  // 'w' is at flat index 6; original offset of 'w' in "Hello   world" is 8
  assert.equal(map[6].off, 8);
  assert.equal(map[6].seg, 0);
});

t('locate: structure-agnostic — a clip spanning blocks matches the flattened page', () => {
  const { flat, map } = flatten([
    { text: 'Manage 1 brand', block: true },
    { text: 'Manage all your brands', block: true },
    { text: 'Schedule up to 20 posts', block: true },
  ]);
  // The clip was captured run-on across the three <li>s:
  const loc = locate(flat, map, 'Manage 1 brand Manage all your brands Schedule up to 20 posts');
  assert.ok(loc, 'should match across blocks');
  assert.equal(loc.startSeg, 0);
  assert.equal(loc.startOff, 0);
  assert.equal(loc.endSeg, 2); // ends in the third block
});

t('locate: exact single-block match returns correct offsets', () => {
  const { flat, map } = flatten([{ text: 'The quick brown fox jumps' }]);
  const loc = locate(flat, map, 'quick brown fox');
  assert.equal(loc.startSeg, 0);
  assert.equal(loc.startOff, 4);   // 'quick' starts at index 4
  assert.equal(loc.endOff, 19);    // end of 'fox' (+1)
});

t('locate: fuzzy fallback anchors on the first words when the tail changed', () => {
  const { flat, map } = flatten([{ text: 'Re-queued 11 leads to restart from step 1 today only maybe' }]);
  // query tail differs from the page tail, but the head matches
  const loc = locate(flat, map, 'Re-queued 11 leads to restart from step 1 NEXT WEEK definitely');
  assert.ok(loc, 'fuzzy head match should succeed');
  assert.equal(loc.startOff, 0);
});

t('locate: too-short or absent queries → null', () => {
  const { flat, map } = flatten([{ text: 'hello there world' }]);
  assert.equal(locate(flat, map, 'hi'), null);
  assert.equal(locate(flat, map, 'nowhere to be found on this page at all'), null);
});

t('locateAll: returns only the matches', () => {
  const { flat, map } = flatten([{ text: 'alpha beta gamma delta epsilon zeta' }]);
  const res = locateAll(flat, map, ['beta gamma', 'not here anywhere', 'delta epsilon']);
  assert.equal(res.length, 2);
});

t('normalize: folds smart apostrophe/quote/dash to ASCII', () => {
  assert.equal(normalize('brands’ social — grow'), "brands' social - grow");
});

t('locate: a smart-apostrophe clip matches a plain-apostrophe page (and vice versa)', () => {
  // page uses a plain apostrophe; clip captured a smart one
  const { flat, map } = flatten([{ text: "Manage all your brands' social networks" }]);
  const loc = locate(flat, map, 'Manage all your brands’ social networks');
  assert.ok(loc, 'smart vs plain apostrophe should still match');
});

t('segmentsOf: splits a run-on list on 2+ spaces into items', () => {
  const clip = 'Manage 1 brand   Manage all your brands social networks   Schedule up to 20 posts';
  assert.deepEqual(segmentsOf(clip), [
    'Manage 1 brand',
    'Manage all your brands social networks',
    'Schedule up to 20 posts',
  ]);
});

console.log(`\nhighlighter.js: ${passed}/${passed} passed`);
