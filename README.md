<p align="center">
  <img src="icons/icon128.png" alt="LANA AI" width="128" height="128" />
</p>

<h1 align="center">LANA AI</h1>

<p align="center">
  <strong>LANA GPT, projected into your browser.</strong>
</p>

<p align="center">
  Capture what you research across ChatGPT, Claude, Gemini &amp; Copilot, ground it
  in your matters, and act on it — private by default, with you in control.
</p>

<p align="center">
  Local-first. Nothing syncs to your LANA account until <em>you</em> authorize it.
</p>

---

## What It Does

Your research and reasoning are scattered across AI tools and never make it back
into the work they belong to. Your LANA GPT account — your matters, documents,
and memory — is a separate destination, not present where the work happens.

LANA AI closes that loop, in one side panel:

1. **Capture** — your live ChatGPT/Claude/Gemini/Copilot sessions, clips of pages
   you research, and bulk imports of your AI history. Private, on your device by
   default.
2. **Ground** — file captured context into a **matter** (by you, or
   agent-suggested) so it becomes first-class knowledge in your LANA account.
3. **Act** — reusable **playbooks** and (soon) a browser agent do multi-step work
   grounded in that context — and **draft, never send, without your review.**

---

## Privacy posture — honest version

LANA AI is **local-first and private by default**, but it is not a closed box —
it connects to your LANA account when you ask it to. Here is exactly what that
means:

- **The capture tier stays on your device.** Captured conversations, summaries,
  topics, and the on-device search index live in your browser (IndexedDB +
  Chrome storage). The on-device model answers what it can locally.
- **Nothing syncs to your LANA account until you authorize it.** Authorization is
  an explicit OAuth step ("Authorize LANA GPT"). Before that, no captured content
  leaves the device.
- **When you do send** — filing a capture to a matter, or letting a heavy
  question escalate to LANA cloud — captured/attached content is redacted on the
  device before it leaves, and agent observations are PII-redacted server-side
  before they reach the model. We claim **minimized, redacted, and logged — not
  "nothing ever leaves."**
- **You stay in control.** The agent drafts but never sends, submits, or files
  without your explicit per-action approval.
- **No third-party tracking.** No ad networks, no analytics SDKs, no selling data.
  The only server LANA AI talks to is your own LANA instance, and only after you
  authorize it.

See [`docs/PRODUCT_BRIEF.md`](docs/PRODUCT_BRIEF.md) §7–8 for the full pillars and
safety model.

---

## Features

- **Multi-platform capture** — ChatGPT, Claude, Gemini, and Microsoft Copilot
- **Automatic capture** — no copy-pasting or manual saving
- **On-device model + local search** — instant, private answers from your own history
- **Matters** — file captured context into your LANA matters (`@matter`)
- **`/#@` composer** — `/` runs a playbook, `#` references a file/clip, `@` grounds in a matter
- **Playbooks** — reusable workflows you set up once and run with `/name`
- **Captured inbox** — triage clips, AI chats, and imports into matters
- **Import/export** — bring in past conversations, export your local knowledge base
- **Contradiction detection** — flags when old notes conflict with new ones
- **Search & analytics** — find anything; see knowledge health
- **Local-first** — capture works offline; the account is opt-in

---

## Installation

### From Source (Developer Mode)

1. Clone the repo (RedRooster Technologies).
2. Open Chrome and go to `chrome://extensions`.
3. Toggle **Developer mode** ON (top-right).
4. Click **Load unpacked** and select the cloned folder.
5. Pin the extension from Chrome's puzzle icon.

Dev builds automatically target a local LANA instance; production builds target
the hosted cloud — you never enter an instance URL. See
[`docs/OAUTH_REDIRECTS.md`](docs/OAUTH_REDIRECTS.md).

### From ZIP (Early Adopters)

See [INSTALL_GUIDE.md](INSTALL_GUIDE.md) for step-by-step instructions.

---

## Setup

Open the side panel (click the LANA AI toolbar icon). On first run you'll see a
short heads-up + consent screen, then:

1. **Authorize LANA GPT** (recommended) — one OAuth step connects your account so
   you can sync matters/memory and route heavier questions to LANA cloud. Nothing
   syncs until you do this.
2. **On-device only** — you can capture, search, and organize entirely locally
   without authorizing anything.

**Bring-your-own AI providers** (OpenAI / Anthropic / Gemini) remain available as
an advanced option for local summarization if your plan enables them:

| Provider | Get an API Key |
|----------|---------------|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic Claude** | [console.anthropic.com](https://console.anthropic.com/) |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

---

## Usage

### Capture
Visit any supported AI site and chat normally — LANA captures in the background.
Clips and bulk imports land in the **Captured** inbox.

### Ground to a matter
In the **Captured** inbox, file a chat/clip into a matter (agent-suggested or your
pick). In the composer, `@` references a matter, `#` a file/clip, `/` a playbook.

### Act
Run a playbook with `/name`. When the agent ships, it narrates each step and
drafts — never sends — without your approval.

### Import Past Conversations
Drag export files into the Import tab: ChatGPT (Data Controls → Export), Claude
(Settings → Export), Gemini (Google Takeout), Copilot (CSV/JSON).

---

## Architecture (one paragraph)

The extension is the **face** (UI), the **hands** (captures pages, executes agent
actions in the tab), and the **private tier** (on-device model). **LANA GPT is
the brain + memory** — the agent loop, playbooks, matters, and Forge inference.
They meet over your instance's `/api/v1` proxy with an authorized OAuth token.
Full protocol: `docs/PRODUCT_BRIEF.md` and the lana-gpt agent/playbook contract.

---

## Contributing

- Keep changes focused — one feature or fix per PR.
- No external build tools or npm dependencies — the extension runs as plain ES modules.
- Test by loading the unpacked extension in Chrome on at least one platform.
- Run adversarial review on nontrivial changes before declaring done.
- Don't commit API keys, tokens, or personal data (`*.pem` is gitignored).

---

## Privacy

- The capture tier (conversations, summaries, topics, search index) is stored
  locally in your browser.
- Nothing syncs to your LANA account until you authorize it; on send, content is
  redacted (on-device for captures, server-side for agent observations).
- No third-party telemetry, analytics, or tracking.
- BYO API keys are stored locally and call your chosen provider directly.

---

## License

Copyright (c) 2025-2026 **RedRooster Technologies Inc.** All rights reserved.

This software is provided under a proprietary license. See [LICENSE](LICENSE) for full terms.

---

<p align="center">
  Built by <a href="https://github.com/redroostertech">RedRooster Technologies Inc.</a>
</p>
