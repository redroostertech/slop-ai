/**
 * @fileoverview The hybrid cascade router.
 *
 * "Local model first; escalate to Forge (via the LANA JWT passthrough) only
 * when it needs more power." This module makes that decision and executes it.
 *
 * Decision inputs (see {@link decideRoute}):
 *   - size        estimated prompt tokens vs the local context window
 *   - capability  task flagged as needing big-model reasoning / synthesis
 *   - reach       task needs account/matter knowledge (L3/L4) → only LANA has it
 *   - sensitivity task pinned on-device (privacy) → never escalate
 *   - connectivity/auth  offline or not signed in → can't escalate
 *
 * Execution ({@link route}):
 *   pinned-local | offline | no-auth        → local (or error if no local)
 *   requiresAccount | tooBig | highCapability → escalate (LANA passthrough)
 *   otherwise                                → DRAFT locally, escalate only if
 *                                              the draft looks low-confidence
 *
 * Fallbacks are symmetric: an escalation failure falls back to local; a local
 * failure escalates; if a bring-your-own-key provider chain exists it's the
 * last resort.
 *
 * @module lib/router
 */

import { generateLocal, isLocalAvailable, getBackend, LOCAL_CONTEXT_TOKENS } from './local-model.js';
import { inferenceComplete } from './lana-client.js';
import { getAuthState } from './lana-auth.js';
import { complete as byoKeyComplete, hasEnabledProvider } from './ai-router.js';

/** Cheap token estimate (~4 chars/token). */
export function estimateTokens(messages) {
  const chars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  return Math.ceil(chars / 4);
}

/** Are we online? Navigator is present in documents; assume online in the SW. */
function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Heuristic confidence check on a locally-produced draft. Low confidence when
 * the draft is empty, suspiciously short, or contains an explicit "I can't /
 * I don't have enough" style hedge — the signals that most often mean the small
 * model punted and the big model should take over.
 *
 * @param {string} draft
 * @returns {{confident: boolean, reason: string}}
 */
export function assessDraft(draft) {
  const text = (draft || '').trim();
  if (text.length < 40) return { confident: false, reason: 'draft_too_short' };
  const hedges = [
    "i can't", 'i cannot', "i don't have", 'i do not have', 'not enough information',
    'unable to', "i'm not sure", 'cannot determine', 'insufficient context',
    'no information', "don't have access",
  ];
  const lower = text.toLowerCase();
  if (hedges.some((h) => lower.includes(h))) return { confident: false, reason: 'draft_hedged' };
  return { confident: true, reason: 'ok' };
}

/**
 * @typedef {Object} Task
 * @property {Array<{role: string, content: string}>} messages
 * @property {boolean} [requiresAccount]  needs L3/L4 (matter/account) context
 * @property {boolean} [highCapability]   explicitly wants big-model reasoning
 * @property {boolean} [sensitive]        pin on-device, never escalate
 * @property {boolean} [forceLocal]       user/UI override → local only
 * @property {boolean} [forceEscalate]    user/UI override → LANA only
 * @property {number}  [temperature]
 * @property {number}  [maxTokens]
 * @property {string}  [tier]             'auto'|'fast'|'reasoning'
 * @property {AbortSignal} [signal]
 */

/**
 * Decide where a task should run WITHOUT executing it. Pure and testable.
 *
 * @param {Task} task
 * @param {Object} ctx
 * @param {boolean} ctx.localAvailable
 * @param {boolean} ctx.authenticated
 * @param {boolean} ctx.online
 * @param {number}  ctx.localWindowTokens
 * @returns {{target: 'local'|'escalate'|'draft-then-verify', reasons: string[]}}
 */
export function decideRoute(task, ctx) {
  const reasons = [];
  const canEscalate = ctx.authenticated && ctx.online;

  // Hard pins first.
  if (task.forceLocal) return { target: 'local', reasons: ['force_local'] };
  if (task.sensitive) return { target: 'local', reasons: ['sensitive_pinned_local'] };
  if (task.forceEscalate) {
    return canEscalate
      ? { target: 'escalate', reasons: ['force_escalate'] }
      : { target: 'local', reasons: ['force_escalate_but_offline_or_no_auth'] };
  }

  // Can't escalate → must be local (caller handles no-local-available).
  if (!canEscalate) {
    reasons.push(ctx.authenticated ? 'offline' : 'not_authenticated');
    return { target: 'local', reasons };
  }

  // Reasons that REQUIRE the big model / account.
  if (task.requiresAccount) reasons.push('requires_account_context');
  const tokens = estimateTokens(task.messages);
  const tooBig = tokens > ctx.localWindowTokens;
  if (tooBig) reasons.push(`too_big:${tokens}>${ctx.localWindowTokens}`);
  if (task.highCapability) reasons.push('high_capability');

  if (task.requiresAccount || tooBig || task.highCapability) {
    return { target: 'escalate', reasons };
  }

  // If there's no local backend here, escalate rather than fail.
  if (!ctx.localAvailable) return { target: 'escalate', reasons: ['no_local_backend'] };

  // Otherwise: try local, verify, escalate only if the draft is weak.
  return { target: 'draft-then-verify', reasons: ['eligible_local'] };
}

/**
 * Execute a task through the cascade.
 *
 * @param {Task} task
 * @returns {Promise<{content: string, route: string, backend: string|null, reasons: string[], escalated: boolean}>}
 */
export async function route(task) {
  if (!task || !Array.isArray(task.messages) || task.messages.length === 0) {
    throw new Error('route() requires task.messages.');
  }

  const [localAvailable, auth, backend] = await Promise.all([
    isLocalAvailable(),
    getAuthState(),
    getBackend(),
  ]);
  const ctx = {
    localAvailable,
    authenticated: auth.authenticated,
    online: isOnline(),
    localWindowTokens: LOCAL_CONTEXT_TOKENS[backend] || 4096,
  };

  const decision = decideRoute(task, ctx);
  const genOpts = {
    temperature: task.temperature,
    maxTokens: task.maxTokens,
    tier: task.tier,
    signal: task.signal,
  };

  // A hard privacy pin: sensitive OR user-forced local. These must NEVER leave
  // the device, so the executor below refuses to construct any escalation
  // fallback for them (the security review's C2). decideRoute already routes
  // them to 'local'; this is the enforcement that actually holds the line.
  const pinnedLocal = !!(task.sensitive || task.forceLocal);

  const runLocal = async (reasons) => {
    const r = await generateLocal(task.messages, genOpts);
    if (!r.content || !r.content.trim()) throw new Error('local_empty_completion');
    return { content: r.content, route: 'local', backend: r.backend, reasons, escalated: false };
  };
  const runEscalate = async (reasons) => {
    if (pinnedLocal) throw new Error('escalation_blocked_pinned_local'); // belt-and-suspenders
    const r = await inferenceComplete(task.messages, genOpts);
    if (!r.content || !r.content.trim()) throw new Error('lana_empty_completion');
    return { content: r.content, route: 'lana', backend: 'forge', reasons, escalated: true };
  };
  // Absolute last resort: a user's own OpenAI/Claude/Gemini key, if configured.
  // Also off-device, so it is likewise blocked for pinned-local tasks.
  const runByoKey = async (reasons) => {
    if (pinnedLocal) return null;
    if (!(await hasEnabledProvider())) return null;
    const r = await byoKeyComplete(task.messages, genOpts);
    return { content: r.content, route: 'byo-key', backend: r.providerType, reasons, escalated: true };
  };

  const withFallback = async (primary, secondary, reasons) => {
    try {
      return await primary(reasons);
    } catch (primaryErr) {
      try {
        const alt = await secondary([...reasons, `fallback_after:${primaryErr.message}`]);
        if (alt) return alt;
      } catch (secondaryErr) {
        const byo = await runByoKey([...reasons, `byo_fallback:${secondaryErr.message}`]).catch(() => null);
        if (byo) return byo;
        throw new Error(`Both local and LANA failed: ${primaryErr.message} / ${secondaryErr.message}`);
      }
      const byo = await runByoKey(reasons).catch(() => null);
      if (byo) return byo;
      throw primaryErr;
    }
  };

  switch (decision.target) {
    case 'local': {
      if (pinnedLocal) {
        // Privacy pin: on-device ONLY, no fallback of any kind. If there's no
        // local backend here, fail loudly rather than silently escalating.
        if (!localAvailable) {
          throw new Error('This task is pinned on-device, but no local model is available in this context.');
        }
        return runLocal([...decision.reasons, 'pinned_local']);
      }
      // Non-pinned 'local' is only reached when escalation isn't possible
      // (offline / not authenticated) — or, defensively, when local is missing
      // but we actually could escalate.
      if (localAvailable) return runLocal(decision.reasons);
      if (ctx.authenticated && ctx.online) {
        return runEscalate([...decision.reasons, 'local_unavailable_escalated']);
      }
      throw new Error('Offline and no on-device model is available.');
    }

    case 'escalate':
      return withFallback(runEscalate, runLocal, decision.reasons);

    case 'draft-then-verify': {
      let draft;
      try {
        draft = await generateLocal(task.messages, genOpts);
      } catch (err) {
        // Local blew up mid-draft → escalate.
        return withFallback(runEscalate, runLocal, [...decision.reasons, `local_draft_error:${err.message}`]);
      }
      const verdict = assessDraft(draft.content);
      if (verdict.confident) {
        return { content: draft.content, route: 'local', backend: draft.backend, reasons: decision.reasons, escalated: false };
      }
      // Weak draft → escalate, but keep the draft as a fallback if LANA fails.
      try {
        const esc = await runEscalate([...decision.reasons, `escalated:${verdict.reason}`]);
        return esc;
      } catch (escErr) {
        const byo = await runByoKey([...decision.reasons, `byo_after_escalate_fail:${escErr.message}`]).catch(() => null);
        if (byo) return byo;
        // Fall back to the (imperfect) local draft rather than nothing.
        return { content: draft.content, route: 'local', backend: draft.backend, reasons: [...decision.reasons, `kept_weak_draft:${escErr.message}`], escalated: false };
      }
    }

    default:
      throw new Error(`Unknown route target: ${decision.target}`);
  }
}
