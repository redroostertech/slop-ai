# LANA AI — Installation & Setup Guide

LANA AI is LANA GPT projected into your browser: capture what you research across
ChatGPT, Claude, Gemini, and Copilot, ground it in your matters, and act on it.

**Local-first and private by default.** Captured data stays on your device, and
nothing syncs to your LANA account until you authorize it. When you do send
(filing to a matter, or escalating a heavy question to LANA cloud), content is
minimized and redacted before it leaves — not "nothing ever leaves."

---

## Step 1: Install the Extension

1. Unzip the `lana-ai.zip` file to a folder on your computer (e.g., `Desktop/lana-ai`).
2. Open **Google Chrome** and navigate to `chrome://extensions`.
3. Toggle **Developer mode** ON (top-right corner).
4. Click **Load unpacked**.
5. Select the unzipped folder (the one containing `manifest.json`).
6. LANA AI will appear in your extensions list.

> **Tip:** Pin the extension by clicking the puzzle icon in Chrome's toolbar, then
> the pin next to "LANA AI."

---

## Step 2: First Run — Heads-up & Consent

Open the side panel (click the **LANA AI** toolbar icon). On first run you'll see:

1. A short **heads-up** screen explaining what's captured (and that it stays on
   your device until you authorize sync), that you stay in control, and that
   clipped content is treated as data, not instructions.
2. A prompt to **Authorize LANA GPT**.

---

## Step 3: Connect Your Account (recommended)

Click **Authorize LANA GPT**. A LANA tab opens; sign in if needed and approve
access. The panel updates automatically when authorization completes.

- You don't enter an instance URL — dev builds target a local instance, production
  builds target the hosted cloud, automatically.
- **Prefer to stay local?** You can skip this and use capture, on-device search,
  and organization entirely on-device. Authorize later from **Settings** anytime.

### Advanced: bring-your-own AI providers

If your plan enables it, you can add OpenAI / Anthropic / Gemini keys for local
summarization under **Settings → Advanced**. Keys are stored locally and call the
provider directly. LANA tries enabled providers in priority order with fallback.

---

## Step 4: Start Using LANA AI

### Capture
Visit any supported site — **ChatGPT**, **Claude**, **Gemini**, or **Copilot** —
and work normally. LANA captures in the background. Clips and imports land in the
**Captured** inbox.

### Ground to a matter
Open **Captured**, and **Attach to matter** on a chat or clip (agent-suggested or
your pick). In the composer: `@` references a matter, `#` a file/clip, `/` a playbook.

### Run a playbook
Type `/` in the composer and pick a playbook (e.g. `/summarize-matter`), or create
one from the **Playbooks** view.

### Import Past Conversations
1. Open the side panel → **Advanced → Import** (or the Import tab).
2. Drag and drop your export file:
   - **ChatGPT**: Settings → Data Controls → Export Data (ZIP)
   - **Claude**: Settings → Export Data (ZIP)
   - **Gemini**: Google Takeout → Gemini Apps (ZIP)
   - **Copilot**: Export as CSV or JSON

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Side panel doesn't open | Click the LANA AI icon in the toolbar. If missing, check `chrome://extensions` and make sure it's enabled. |
| "Authorize" hangs on the spinner | Make sure the LANA tab finished loading and you approved access. Use **Reopen it**, or **Skip for now** and authorize later from Settings. |
| Matters don't appear | Authorize LANA GPT first (Settings). Matters load from your account. |
| Conversations not capturing | Refresh the page. Check the site is supported (ChatGPT, Claude, Gemini, Copilot). |
| Extension stopped after a Chrome update | Go to `chrome://extensions`, disable then re-enable LANA AI. |

---

## Privacy & Security

- **Local-first storage** — captured conversations, summaries, and the search index
  stay on your device.
- **Opt-in account sync** — nothing reaches your LANA account until you authorize
  it (OAuth 2.0 + PKCE).
- **Minimized on send** — content filed to a matter is redacted on-device before it
  leaves; agent observations are PII-redacted server-side before the model.
- **You approve consequential actions** — the agent drafts but never sends/submits
  without your explicit per-action approval.
- **No third-party tracking** — no ad networks or analytics SDKs; LANA talks only to
  your own LANA instance, after you authorize it.
- BYO API keys are stored locally and never leave your machine except to call your
  chosen provider.

---

## Getting Help

If you run into issues or have feedback, reach out to the team directly via the
email this was shared from.
