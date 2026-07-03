# LANA AI extension — roadmap / deferred tasks

## TASK: Expand Clip + Form-fill beyond the 5 AI sites

**Status:** deferred (2026-07-03). Today, the Clip and Fill triggers live in the
injected sidebar, which only runs on the 5 AI sites (ChatGPT, Claude, Gemini,
Copilot), and `host_permissions` is scoped to exactly those origins. `chrome.
scripting`-based delivery (`lib/page-capture.js`) already works on any activeTab,
so the capability layer is ready — this is a scope/surface decision, not new
plumbing.

To expand to **arbitrary web pages** (the research-clipper use case), pick one:

1. **Broaden the injected sidebar** — add a content-script entry matching
   `http://*/*` + `https://*/*` for `content-scripts/inject/inject.js`, broaden
   `web_accessible_resources` to match, and broaden `host_permissions` (or lean
   on `optional_host_permissions` + a runtime `chrome.permissions.request`).
   Cost: the install prompt becomes "read and change data on all sites"; the
   trigger button appears on every page.
2. **Toolbar / context-menu entry (activeTab, no broad grant)** — trigger Clip
   from the extension action or a right-click menu so `activeTab` grants
   scripting for that one tab on the gesture. No all-sites permission; the
   sidebar UI isn't needed on the page. Preview renders in the sidepanel.
   **Recommended** — smallest permission footprint.

Also for expansion:
- Render the form-fill **preview in the sidepanel** (reuse the inject.js preview
  logic) so arbitrary pages don't need the injected sidebar at all.
- A **memory-allowlist picker** UI so form-fill can use account memory safely
  (today `allowedMemory` is passed empty → fills come only from page context;
  no account PII is eligible to leave the device until this exists).

## Other deferred follow-ups

- **Vendor the WebLLM bundle** — see `vendor/web-llm.README.md` (runtime +
  weight-hosting decision documented; weights → Cloudflare R2 `weights.lanaai.io`).
- **Embed/summarize imported + clipped records** so they surface by content, not
  just title/recency (relevance.js currently scores unsummarized records on
  title + recency + embeddings only).
- **lana-gpt passthrough** — implement metering, rate-limiting, and confirm the
  redaction posture per `lana-gpt/docs/EXTENSION_INFERENCE_PASSTHROUGH.md`.
- **On-prem discovery** — pull instance/discovery URLs from RedRoosterTech-Web
  so cloud/on-prem instances are auto-configured.

## Bigger bet: Model Control Plane

Cross-app system to publish/version/resolve/verify/hot-swap local-model weights
across every LANA runtime (WebLLM extension, llama.cpp iOS, vLLM Forge) — fine-tune
once, deploy everywhere. Full spec: **`docs/MODEL_CONTROL_PLANE.md`**. The
extension is the reference client; to be spec-compliant it still needs signature +
hash verification added to the `localModelConfig` load path.
