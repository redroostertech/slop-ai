# LANA AI — Chrome Web Store Listing

## Version
**1.0.0** (First Release)

---

## Short Description (132 char max)
LANA GPT in your browser: capture AI research, ground it in your matters, and act on it — private by default, you in control.

---

## The Problem

Your research and reasoning are scattered across AI tools and never make it back
into the work they belong to.

You research something in ChatGPT. You reason through it with Claude. You pull a
statute or a spec from a web page. Then it all evaporates into old tabs — and your
LANA account, where the work actually lives, never sees any of it.

**Your best research is trapped in chats and pages you'll never find again.**

---

## The Solution

**LANA AI is LANA GPT, projected into your browser.**

It captures what you research (on your device), lets you file it into the
**matter** it belongs to, and runs reusable **playbooks** grounded in that
context — private by default, and never acting without your review.

- You research like normal across ChatGPT, Claude, Gemini, and Copilot
- LANA captures and organizes it, on your device
- You file the useful parts into a matter in your LANA account
- Playbooks (and, soon, a browser agent) do the multi-step work — grounded in your
  own context, drafting but never sending without your approval

---

## How It Works (4 Steps)

**1. You work like normal.** Research across any supported AI site. LANA captures
in the background — locally.

**2. It captures and organizes.** Conversations, clips, and imports land in a
private **Captured** inbox on your device.

**3. You ground it in a matter.** File a chat or clip into the matter it belongs
to (agent-suggested or your pick). Now it's knowledge your account can reason over.

**4. You act — with a gate.** Run a playbook with `/name`. When the agent ships,
it narrates each step and **drafts, never sends, without your explicit approval.**

---

## What You Get

- **Works everywhere** — ChatGPT, Claude, Gemini, and Microsoft Copilot
- **Automatic capture** — no copy-pasting, no manual saving
- **On-device model + local search** — instant, private answers from your history
- **Matters** — ground captured context in your LANA account
- **`/#@` composer** — run playbooks, reference files/clips, ground in a matter
- **Playbooks** — set up a workflow once, run it with `/name`
- **Import your history** — bring in past conversations from any platform
- **Local-first & opt-in** — capture works offline; the account connects only when you authorize it

---

## Who Is This For?

- **LANA GPT users** who want their account present where the research happens
- **Legal and knowledge professionals** who live in the browser and manage matters
- **Anyone** tired of research that never accumulates into their real work

---

## Privacy — the honest version

- **Local-first.** Captured conversations, summaries, and your search index live on
  your device (IndexedDB + Chrome storage).
- **Nothing syncs until you authorize it.** Connecting your LANA account is an
  explicit OAuth step. Before that, nothing captured leaves the device.
- **When you send, it's minimized.** Content filed to a matter is redacted on your
  device before it leaves; agent observations are PII-redacted server-side before
  they reach the model. We claim *minimized, redacted, and logged — not "nothing
  ever leaves."*
- **You're in control.** The agent drafts but never sends, submits, or files
  without your explicit per-action approval.
- **No third-party tracking.** No ad networks, no analytics SDKs. The only server
  LANA talks to is your own LANA instance, after you authorize it.

---

## Pricing
Free to install. Account features require a LANA GPT account.

---

## Category
Productivity

## Tags
ai, chatgpt, claude, gemini, copilot, knowledge, matters, legal, context, productivity

---

## Changelog

### v1.0.0 — First Release
- Live capture on ChatGPT, Claude, Gemini, and Copilot
- On-device model + local semantic search over your history
- Authorize LANA GPT (OAuth 2.0 + PKCE) — opt-in account sync
- Captured inbox: triage clips, AI chats, and imports into matters
- `/#@` composer: playbooks, files/clips, matters
- Playbooks: reusable workflows run with `/name`
- Import past conversations (JSON, CSV, ZIP); export your local knowledge base
- Local-first by default; account features are explicit and consented
