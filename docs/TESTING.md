# Testing the LANA AI extension

## 0. Prerequisites
- **Chrome 128+** (for the Prompt API + WebGPU). Chrome Canary/Dev is safest.
- For the **local WebLLM model**: a machine with a GPU. Verify WebGPU at
  `chrome://gpu` (look for "WebGPU: Hardware accelerated").
- Optional Gemini Nano (Prompt API fallback): `chrome://on-device-internals`.

## 1. Load it
1. Go to `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select `~/Documents/ai-context-bridge`.
4. The **LANA AI** icon (dark tile, light corner brackets) appears in the toolbar.

## 2. Confirm a clean load
- On `chrome://extensions`, under LANA AI click **service worker** → opens the
  SW devtools console. You should see `[LANA AI] Service worker loaded
  successfully` and no red errors.
- If the card shows an **Errors** button, open it — that's the first thing to fix.
- After any code change: click the **↻ reload** icon on the extension card.

## 3. Tier 1 — capture + clip (works now, NO account needed)
1. Open **claude.ai** or **chatgpt.com** and have a short conversation.
2. A trigger button appears on the **right edge** of the page → click it to open
   the injected sidebar (should say LANA AI, with **Clip** and **Fill** buttons).
3. Click the **toolbar icon** → the **side panel** opens (dashboard). The
   Conversations count should reflect what was captured.
4. **Clip:** in the injected sidebar, click **Clip** → toast "Clipped to your
   LANA library" → the clip shows up under Conversations (source: research).

## 4. Tier 2 — connect a LANA account
1. Side panel → **⚙ Settings** → **LANA Account** card.
2. Instance defaults to `https://gpt.lanaai.io`. Click **Save** → Chrome prompts
   for host permission → **Allow**.
3. **Connect with browser session** (if you're logged into gpt.lanaai.io in this
   browser) or use the **email/password** sign-in. The status badge should flip
   to connected.
4. What works: auth + listing matters + sending captured context to a matter
   (account ingestion uses existing endpoints).
5. What does NOT work yet: **inference escalation** — the router's "escalate to
   LANA" path calls `/api/v1/inference/complete`, which is still a scaffold on
   lana-gpt (not deployed). See §6.

## 5. Tier 3 — the on-device model (WebLLM)
The local model is exercised by any routed task. Easiest UI path: **Fill** on a
page with a form (form-fill reasoning is pinned on-device). Or drive it directly
from the **side panel devtools console** (right-click the panel → Inspect):

```js
chrome.runtime.sendMessage(
  { type: 'LANA_ROUTE', task: { messages: [{ role: 'user', content: 'Summarize in 5 words: the sky is blue because of Rayleigh scattering.' }], forceLocal: true } },
  (r) => console.log('route result:', r)
);
```
- **First run downloads the model (~1 GB, Qwen2.5-1.5B)** — slow once, cached
  after. Watch progress in the **offscreen document console** (see §7).
- Expected result: `{ content: "...", route: "local", backend: "prompt-api" | "offscreen-webllm", escalated: false }`.
- If WebGPU is unavailable and Gemini Nano isn't present, a `forceLocal` task
  correctly errors ("pinned on-device, but no local model") rather than leaking.

## 6. Tier 4 — full local→escalate loop (blocked)
Not testable until the **lana-gpt passthrough** is wired into `main.py` and
deployed (see `lana-gpt/docs/EXTENSION_INFERENCE_PASSTHROUGH.md`). Once live, a
routed task that exceeds the local window / needs account context returns
`{ route: "lana", escalated: true }`.

## 7. Debugging
- **Service worker logs:** `chrome://extensions` → LANA AI → *service worker*.
- **Offscreen doc (WebLLM):** `chrome://extensions` → LANA AI → under *Inspect
  views* an `offscreen/offscreen.html` entry appears once created; open it to see
  model download/compile logs.
- **Content script (injected sidebar):** open devtools on the AI-site page.
- **Side panel:** right-click the panel → Inspect.
- **Router logic (no browser):** from the repo, `npm test` → 16/16.

## 8. Known limitations while testing
- Form-fill passes **empty allowed-memory**, so it fills only from page context
  (few proposals until a memory-allowlist UI exists) — by design (no account PII
  eligible to leave yet).
- Clip/Fill work on the **5 AI sites** only for now (host_permissions scope).
- WebLLM bundle is vendored, but weights download on first use.
