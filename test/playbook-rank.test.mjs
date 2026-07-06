// Unit tests for lib/playbook-rank.js. Run: node test/playbook-rank.test.mjs
import assert from 'node:assert';
import { rankPlaybooks } from '../lib/playbook-rank.js';

const PB = [
  { cmd: 'summarize-matter', desc: 'Key facts', src: 'Matter', tags: ['summarize', 'recap', 'matter'] },
  { cmd: 'draft-demand-letter', desc: 'Draft & save', src: 'Docs', tags: ['draft', 'demand', 'letter'] },
  { cmd: 'digest-inbox', desc: 'Flag emails', src: 'Gmail', tags: ['digest', 'inbox', 'email'], sites: ['mail.google.com'] },
];

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const cmds = (arr) => arr.map((p) => p.cmd);

t('no context → input order preserved (deterministic default)', () => {
  assert.deepEqual(cmds(rankPlaybooks(PB, {})), cmds(PB));
  assert.deepEqual(cmds(rankPlaybooks(PB)), cmds(PB));
});

t('composer keyword ranks the matching playbook first', () => {
  assert.equal(rankPlaybooks(PB, { composerText: 'help me draft a demand letter' })[0].cmd, 'draft-demand-letter');
  assert.equal(rankPlaybooks(PB, { composerText: 'digest my inbox' })[0].cmd, 'digest-inbox');
});

t('active site boosts a site-tagged playbook', () => {
  assert.equal(rankPlaybooks(PB, { host: 'mail.google.com' })[0].cmd, 'digest-inbox');
});

t('fresh captures + matters boost the matter/summary playbook', () => {
  assert.equal(rankPlaybooks(PB, { captureCount: 5, hasMatters: true })[0].cmd, 'summarize-matter');
});

t('no matters deprioritizes matter-scoped playbooks', () => {
  const ranked = rankPlaybooks(PB, { hasMatters: false });
  // summarize-matter (matter-scoped) should not be first when nothing else scores
  assert.notEqual(ranked[0].cmd, 'summarize-matter');
});

t('short words (<3 chars) are ignored, no crash on empty', () => {
  assert.deepEqual(cmds(rankPlaybooks(PB, { composerText: 'a to' })), cmds(PB));
  assert.deepEqual(rankPlaybooks([], { composerText: 'x' }), []);
});

console.log(`\nplaybook-rank.js: ${passed}/${passed} passed`);
