/**
 * @fileoverview Cross-platform context handoff (Claude → ChatGPT and back).
 *
 * Capability #4. Synthesize a portable primer from captured context on one
 * platform and hand it to another platform's composer. Uses the hybrid router
 * for the synthesis and the existing injector formatting for the target site.
 *
 * This module produces the TEXT; the actual composer injection is done by the
 * per-site content scripts (content-scripts/sites/*.js via inject.js), which
 * already know each site's input box.
 *
 * @module lib/capabilities/handoff
 */

import { route } from '../router.js';
import { dbGet } from '../db.js';

/** Target-specific framing for the handoff primer. */
const TARGET_FRAMING = {
  chatgpt: 'the user is continuing this work in ChatGPT',
  claude: 'the user is continuing this work in Claude',
  gemini: 'the user is continuing this work in Gemini',
  copilot: 'the user is continuing this work in Copilot',
  generic: 'the user is continuing this work in another assistant',
};

/**
 * Synthesize a handoff primer from one or more captured conversations.
 *
 * @param {Object} args
 * @param {string[]} args.conversationIds  conversations to consolidate
 * @param {string} [args.targetSystem='generic']  chatgpt|claude|gemini|copilot
 * @param {string} [args.focus]  optional user instruction to steer the primer
 * @returns {Promise<{text: string, route: string, escalated: boolean}>}
 */
export async function synthesizeHandoff({ conversationIds, targetSystem = 'generic', focus }) {
  if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
    throw new Error('synthesizeHandoff requires conversationIds.');
  }

  const convs = (await Promise.all(conversationIds.map((id) => dbGet('conversations', id)))).filter(Boolean);
  if (convs.length === 0) throw new Error('No matching conversations found.');

  const transcript = convs
    .map((c) => {
      const head = `# ${c.title || 'Conversation'} (${c.source || 'unknown'})`;
      const turns = (c.messages || [])
        .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
        .join('\n');
      return `${head}\n${turns}`;
    })
    .join('\n\n---\n\n');

  const framing = TARGET_FRAMING[targetSystem] || TARGET_FRAMING.generic;
  const messages = [
    {
      role: 'system',
      content:
        'You consolidate prior AI-assistant conversations into a compact, ' +
        'portable context primer that can be pasted into another assistant so ' +
        'it can continue seamlessly. Preserve decisions, constraints, open ' +
        'questions, and key facts. Be concise and self-contained. Do not invent ' +
        'details. Output plain prose or short bullet lists, no preamble.',
    },
    {
      role: 'user',
      content:
        `Consolidate the following into a primer, given that ${framing}.` +
        (focus ? ` Focus especially on: ${focus}.` : '') +
        `\n\n${transcript}`,
    },
  ];

  // Handoff synthesis benefits from stronger reasoning; let the router escalate
  // when the transcript is large. Not account-scoped, not sensitive by default.
  const result = await route({ messages, highCapability: convs.length > 1, maxTokens: 1200 });
  return { text: result.content, route: result.route, escalated: result.escalated };
}
