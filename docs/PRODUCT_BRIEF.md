# LANA AI — Product Brief

**Status:** Draft for review · **Date:** 2026-07-03
**Companion:** `lana-gpt/docs/AGENT_PLAYBOOK_CONTRACT.md` (the technical contract),
`docs/MODEL_CONTROL_PLANE.md`, `docs/LOCAL_MODEL_WEIGHTS.md`.

---

## 1. One line

**LANA AI is LANA GPT projected into your browser** — an agent that captures what
you research, grounds itself in your matters, and acts on your behalf, privately
by default, with you in control.

## 2. Who it's for

Legal professionals (solo → firm) who live in the browser: researching in
ChatGPT/Claude, reading email, pulling documents, and managing matters in LANA
GPT — today across disconnected tabs, with context that never accumulates.

## 3. The problem

- Research and reasoning are **scattered** across AI tools and never make it back
  into the matter they belong to.
- The LANA GPT account (matters, documents, memory) is a **separate destination**,
  not present where the work happens.
- Generic browser agents **start cold** — they don't know your matters, your
  prior research, or your firm's context.

## 4. What it is

An always-available side panel that does three things, in one loop:

1. **Capture** — clips of pages you research, your live ChatGPT/Claude sessions,
   and bulk imports of your AI history. Private, on-device by default.
2. **Ground** — everything flows toward **matters**. Captured context is filed
   (by you, or agent-suggested) into a matter and becomes first-class knowledge.
3. **Act** — a browser agent + reusable **playbooks** do multi-step work
   (summarize a matter, draft a demand letter, digest the inbox), grounded in
   that context — and **draft, never send, without your review.**

## 5. Why it wins — the moat

Same browser-agent capability as the generic tools, but **grounded**. LANA's agent
already knows your matters, your research clips, and every AI conversation you've
imported. The browser-agent is table stakes; **the grounded, private context is
the defensibility.** (See `docs/` context-flow.)

## 6. The experience (surfaces)

| Surface | Job |
|---|---|
| **First run** | Heads-up consent → Authorize LANA GPT (OAuth). |
| **Agent chat** | Ask/act. `/` runs a playbook, `#` references a file/clip, `@` grounds in a matter. Steps narrate; drafts never auto-send. |
| **Playbooks** | Reusable workflows. Create by **writing** instructions or **recording** a task once. Run with `/name`. |
| **Captured** | Clips + AI chats + imports, triaged into matters (agent-suggested). |
| **History** | Every run, clip, and playbook, searchable. |
| **Settings** | Account, AI Inference (local-first, no model names), Agent (memory, notify, playbook suggestions), Skills, General. |

## 7. The four pillars (and their guarantees)

1. **Private by default.** The on-device model answers what it can; the private
   tier + local search never leave the device. When the *agent* acts, page
   observations go to the cloud **PII-redacted server-side before they reach the
   model (Forge)**; captured/attached content is redacted on-device before send.
   Honest carve-out: page *screenshots* can't be pixel-redacted on-device at
   speed, so `screenshot` is gated + logged as egress, not silently redacted. We
   claim minimized-redacted-logged, not "nothing ever leaves."
2. **You're in control.** Nothing syncs to your account until authorized; the
   agent drafts but **never sends/submits without explicit per-action approval**;
   consent gate on first run.
3. **Grounded in your work.** Matters are the unit; captured context becomes
   matter knowledge the agent reasons over.
4. **One identity.** Authorize LANA GPT once; the token carries your org and
   entitlements, which drive what you can do across every LANA product.

## 8. Safety model (non-negotiable — this is a legal product)

- **The human-in-the-loop gate is the guarantee.** Consequential actions (send,
  submit, file, pay, delete, cross-origin navigate) are gated on explicit
  per-action approval, on both client and server, keyed on **effect, not verb**
  (a `<div>` "Send" button and a side-effecting `navigate` are caught at dispatch,
  not by trusting a label). Never auto-run.
- **Prompt injection is defended, but treated as best-effort.** Untrusted page
  content is delimited and constrained (it can't widen the agent's privileges,
  pick a matter, or shape an approval), and URL/egress params can't be built from
  page content — but the *real* backstop is the human gate above, not a
  classifier. We do not claim the injection defense is complete.
- **Redaction where it's real.** Agent observations are redacted server-side
  before Forge; captured content on-device before send; screenshots are the
  disclosed carve-out (pillar 1).
- **Scoped, disclosed browser control.** `chrome.debugger` attaches only during an
  active session — with Chrome's own "started debugging" banner visible — and
  hard-detaches on end/crash. That banner is a deliberate transparency cost we
  accept; adding the `debugger` permission is disclosed in onboarding.
- **Cloud-dependent by design.** The agent runs in lana-gpt, so it needs a
  connection; the on-device tier + capture still work offline.
- **Consent + transparency.** The heads-up screen, visible step narration, and a
  full History of every run *and every egress event*.

## 9. Architecture (one paragraph)

The extension is the **face** (UI), the **hands** (executes agent actions in the
tab, captures pages), and the **private tier** (on-device model). **lana-gpt is
the brain + memory** (the agent orchestration loop, playbooks, matters, context,
and Forge inference). They meet over the `gpt.lanaai.io/api/v1` proxy with an
authorized token (**OAuth+PKCE — to be built; the shipped client still uses a
password/cookie grant**, see contract §1.6). The agent runs in lana-gpt and calls
the extension as a *tool* to see and act on the browser. Full protocol:
`AGENT_PLAYBOOK_CONTRACT.md`.

## 10. What already exists vs. what's new

**Built (extension):** capture (AI sites) + clip, ChatGPT/Claude import, the
on-device model + hybrid router, local search, the LANA account client + account
ingestion, the settings/redesign direction. **Built (lana-gpt):** matters +
knowledge ingestion, Forge inference, the passthrough scaffold.

**New (this direction):** OAuth authorize flow · the agent action loop · playbooks
(write + record) · `/#@` composer · Captured triage → matter · History · the agent
surfaces. Agents + playbooks are being implemented in lana-gpt now.

## 11. Build sequence (proposed)

1. **Auth** — OAuth authorize (extension + lana-gpt `/oauth/*`). Unblocks everything.
2. **Grounding** — `@matter` + `#file` + Captured→matter filing (reuses existing
   ingestion). Delivers value without the agent.
3. **Agent loop v1** — read + navigate + draft (no consequential actions yet) +
   step narration + the approval gate. The hardest, highest-value piece.
4. **Playbooks** — write-it first (run stored instructions), then record-it.
5. **Polish** — History, suggestions, settings redesign port, entitlement gating.

Each phase is shippable. The agent loop (3) is the real engineering lift and where
safety review must be deepest.

## 12. Open product decisions

- Build-our-own agent runtime (chosen) → confirm the CDP scope + latency budget.
- Approval granularity (per-action, default for legal) vs per-session trust.
- What "Record it" captures and where secret-redaction happens.
- Entitlement matrix: which capabilities gate on which plan.
- On-prem parity for the agent loop (same contract, customer's Forge).
