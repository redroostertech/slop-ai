# Vendoring the WebLLM (MLC) runtime

The "WebGPU (WebLLM)" local backend needs the MLC **WebLLM** runtime bundled
inside the extension. It is intentionally **not** committed here (multi-MB) and
**cannot** be loaded from a CDN: the extension CSP is

```
script-src 'self' 'wasm-unsafe-eval'; object-src 'self'
```

which blocks any remote `import`. WebLLM must therefore be **self-hosted**.

## What to drop in

Create exactly one file:

```
vendor/web-llm.js
```

It must be a **single, self-contained ES module** (no bare/relative imports to
other files, no CDN URLs) that exports at least:

- `CreateMLCEngine(modelId, options?)` — the async engine factory used by
  `offscreen/offscreen.js`.

(The full `MLCEngine`, `prebuiltAppConfig`, etc. may also be exported; only
`CreateMLCEngine` is required.)

## How to produce it

Package: [`@mlc-ai/web-llm`](https://www.npmjs.com/package/@mlc-ai/web-llm)
Pin a specific version (this integration was written against the `0.2.x` line;
use the latest `0.2.x` unless you have a reason not to).

Option A — use the published ESM build directly:

1. `npm install @mlc-ai/web-llm@^0.2`
2. Copy the distributed ESM bundle to `vendor/web-llm.js`. In recent releases
   this is `node_modules/@mlc-ai/web-llm/lib/index.js` (an ESM). Confirm it is
   a single self-contained file; if it pulls in sibling chunks, use Option B.

Option B — bundle it yourself into one file (recommended, guarantees CSP-safe
single-file output):

```bash
npm install @mlc-ai/web-llm@^0.2 esbuild
npx esbuild --bundle --format=esm --platform=browser \
  --outfile=vendor/web-llm.js \
  node_modules/@mlc-ai/web-llm/lib/index.js
```

Do **not** minify away `CreateMLCEngine`'s name; keep it exported.

## Verify

```bash
# Must parse as an ES module:
node --input-type=module --check < vendor/web-llm.js

# Must export the factory:
grep -n "CreateMLCEngine" vendor/web-llm.js | head
```

Then reload the unpacked extension. The service-worker router will detect the
runtime (via `chrome.offscreen` + a `LOCAL_INIT` probe) and start using the
`offscreen-webllm` backend automatically. No code changes are needed once the
file is present — everything is guarded to no-op until it is.

## Notes

- **WASM**: WebLLM compiles WASM. The CSP already allows `'wasm-unsafe-eval'`,
  so that works from extension pages (the offscreen document).
- **Model weights** are fetched at first generation from the MLC/HuggingFace
  CDN over `fetch()`. That is a network `connect-src` request (not `script-src`)
  and is not blocked by the script CSP. The default model id is
  `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`; override it by setting
  `chrome.storage.local.localModelId`.
- **WebGPU**: required. It exists in the offscreen document (and sidepanel) but
  not in the service worker — which is the entire reason for the offscreen doc.
- **In-document use** (the direct `webllm` backend, e.g. the sidepanel) expects
  the runtime as a global `self.webllm`. If you want that path too, additionally
  load the bundle so it assigns `self.webllm` (e.g. a `<script type="module">`
  that does `import * as webllm from '../vendor/web-llm.js'; self.webllm = webllm;`).
  The background `offscreen-webllm` path does not need this — it imports the ESM
  directly.

## Hosting — two separate things

There are two artifacts, hosted differently:

| Artifact | Size | Where it lives |
|----------|------|----------------|
| **WebLLM runtime** (`vendor/web-llm.js`) | ~1–2 MB | **Bundled in the extension package.** Ships with the extension; no external hosting. |
| **Model weights** (e.g. Qwen2.5-1.5B q4) | ~0.9–1.5 GB | **Downloaded at first use, cached in-browser** (Cache API / IndexedDB). NOT bundled — too big for a Web Store package. This is the real hosting decision. |

### Weight-hosting options

- **A. HuggingFace / MLC CDN (default, zero-setup):** MLC's prebuilt weights live
  on `huggingface.co` / their CDN. No hosting cost; one-time download per user,
  then cached. Requires `connect-src` + host access for the weight host. Privacy:
  the weight host sees the *download* request (never inference data).
- **B. Self-host on Cloudflare R2 — RECOMMENDED for LANA.** Put the MLC weight
  shards behind e.g. `https://weights.lanaai.io` and point WebLLM's
  `appConfig.model_list[].model_url` at it. **R2 has no egress fees**, which is
  ideal for large static files served to many users. Gives full control and a
  consistent **sovereign** story (aligns with Forge's `x-sovereign` tier and the
  legal/privacy positioning). Cost = storage + bandwidth.
- **C. On-prem:** the customer hosts weights on their own box; their instance
  config points `model_url` at it. Zero external egress — the on-brand default
  for on-prem/enterprise.

**Decision:** runtime is vendored in-package (above). For weights, self-host on
**Cloudflare R2 (`weights.lanaai.io`)** as the product default, with the URL
configurable so on-prem repoints to the customer's host. Fall back to the HF CDN
only for a zero-setup dev/preview build.

### What that requires in the extension

Whichever weight host you choose, the offscreen document's `fetch()` needs it
allowed:
- add the weight origin to `host_permissions` (or request it at runtime), and
- ensure the extension-page CSP permits `connect-src` to that origin (the
  current CSP only constrains `script-src`/`object-src`, so `fetch()` to a
  declared host works, but pin `connect-src` explicitly if you tighten the CSP).
Set the model via `chrome.storage.local.localModelId` and, for self-hosting, a
custom `appConfig` in `offscreen/offscreen.js`'s engine creation.
