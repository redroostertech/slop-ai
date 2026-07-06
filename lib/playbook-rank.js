/**
 * @fileoverview Pure ranking of playbook suggestions by contextual relevance.
 * Deterministic: ties keep the original order, so with no signal it returns the
 * input order unchanged (safe default). No chrome/DOM deps — unit-testable.
 *
 * @module lib/playbook-rank
 */

/**
 * @param {Array<{cmd:string, desc?:string, src?:string, tags?:string[], sites?:string[]}>} playbooks
 * @param {{composerText?:string, host?:string, captureCount?:number, hasMatters?:boolean}} [ctx]
 * @returns {Array} playbooks sorted by descending relevance (stable on ties)
 */
export function rankPlaybooks(playbooks, ctx = {}) {
  const words = String(ctx.composerText || '').trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  const scored = (playbooks || []).filter(Boolean).map((p, i) => {
    let score = 0;
    const hay = `${p.cmd} ${p.desc || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
    for (const w of words) if (hay.includes(w)) score += 5;              // composer keywords (strongest)
    if (ctx.host && Array.isArray(p.sites) && p.sites.some((s) => ctx.host.includes(s))) score += 3; // active site
    if (ctx.captureCount > 0 && /matter|summ/.test(p.cmd)) score += 2;   // fresh captures → matter/summary
    const isMatterScoped = /matter/.test(`${p.src || ''} ${p.cmd}`.toLowerCase());
    // Only adjust when we actually KNOW the matter state — undefined stays neutral
    // so an empty context returns the input order unchanged.
    if (isMatterScoped && ctx.hasMatters === true) score += 1;          // runnable
    else if (isMatterScoped && ctx.hasMatters === false) score -= 1;    // not runnable → deprioritize
    return { p, score, i };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.map((s) => s.p);
}
