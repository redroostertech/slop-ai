# LANA Model Control Plane — Spec

**Status:** Draft for review · **Author:** platform · **Date:** 2026-07-03
**Reference client:** the LANA AI browser extension (`ai-context-bridge`)

A single system to **publish, version, resolve, distribute, verify, and hot-swap**
local-AI model weights across every LANA app — so you fine-tune a model *once* and
every product picks it up seamlessly, with integrity guarantees and per-tenant
control. Think "remote config / feature flags, but for weights."

---

## 0. Runtimes in scope

Your apps run different local runtimes; a weight file for one does not load in
another. The control plane's whole job is to hide that.

| Surface | Runtime | Weight format | Notes |
|---------|---------|---------------|-------|
| Browser extension | **WebLLM / MLC** (WebGPU) | MLC shards (`q4f16_1`…) **+ WASM `model_lib`** | Reference client; `localModelConfig` already wired |
| LanaAI iOS | **llama.cpp** (`Packages/LlamaCppXC`) | **GGUF** (`Q4_K_M`…) | On-device mobile |
| Forge (server) | **vLLM** | safetensors / **AWQ / FP8** | Not "local," but a model host — same registry |

---

## 1. Core abstraction: logical model → per-runtime artifacts

```
"lana-legal-1.5b" @ v3            ← you fine-tune ONCE
   ├── runtime=webllm   format=MLC/q4f16_1   (+ model_lib)   → extension
   ├── runtime=llamacpp format=GGUF/Q4_K_M                   → iOS
   └── runtime=vllm     format=AWQ                           → Forge
```

A client asks: *"resolve `lana-legal-1.5b` for my runtime + tenant"* → gets a
signed pointer to the right artifact. Swapping a model = publishing a new version
and moving a channel; clients pick it up on next load (or hot-swap).

---

## 2. Registry schema (the catalog)

Each logical model is an entry; each entry lists immutable, content-addressed
artifacts. Store as signed JSON on R2 (static, cache-friendly) or behind a small
service — see §11.

```jsonc
{
  "id": "lana-legal-1.5b",
  "family": "qwen2.5-1.5b",              // base architecture (drives model_lib reuse)
  "purpose": "legal-assistant",
  "tenant_scope": "global",              // "global" | "tenant:<id>" | "onprem"
  "versions": [
    {
      "version": "3",
      "created_at": "2026-07-03T00:00:00Z",
      "channel": "stable",               // "stable" | "canary" | "revoked"
      "notes": "distilled from Forge qwen3.5-27b; legal SFT v3",
      "artifacts": [
        {
          "runtime": "webllm",
          "format": "MLC",
          "quantization": "q4f16_1",
          "url": "https://weights.lanaai.io/cas/<sha256>/",   // content-addressed
          "sha256": "<manifest hash of the shard set>",
          "size_bytes": 980000000,
          "model_lib": "https://weights.lanaai.io/libs/qwen2.5-1.5b-q4f16_1-webgpu.wasm",
          "model_lib_sha256": "<hash>",
          "context_window": 4096,
          "min_client": "1.1.0"
        },
        { "runtime": "llamacpp", "format": "GGUF", "quantization": "Q4_K_M",
          "url": "https://weights.lanaai.io/cas/<sha256>/model.gguf",
          "sha256": "<hash>", "size_bytes": 1050000000, "min_client": "2.0.0" },
        { "runtime": "vllm", "format": "AWQ",
          "url": "s3://lana-weights/lana-legal-1.5b-awq/", "sha256": "<hash>" }
      ]
    }
  ]
}
```

Rules: **versions are immutable**; you never overwrite, you publish a new one.
`channel` selects what clients get. `tenant_scope` isolates on-prem/per-firm models.

---

## 3. Resolver / discovery API

Clients don't read the raw catalog; they resolve. This is the extension of the
**discovery** idea (RedRoosterTech-Web hosting discovery URLs).

```
GET /v1/models/resolve
    ?app=lana-extension&platform=chrome&runtime=webllm
    &purpose=legal-assistant&tenant=<id>&channel=stable
Authorization: Bearer <tenant/app token>

→ 200  a SIGNED manifest (see §4). On-prem instances return their OWN host URLs.
→ 304  client already has the current version (ETag).
→ 404  no model for that (runtime, tenant, purpose).
```

The resolver applies channel + per-tenant pin + rollout % (§7) and returns the
one artifact the client should load. On-prem: the resolver points at the
customer's host, never the cloud bucket.

---

## 4. Client contract (the generalized `localModelConfig`)

Every client consumes the same **signed manifest** shape (this is `localModelConfig`
lifted to a cross-platform, verifiable contract):

```jsonc
{
  "logical_id": "lana-legal-1.5b",
  "version": "3",
  "runtime": "webllm",
  "format": "MLC",
  "artifact": {
    "url": "https://weights.lanaai.io/cas/<sha256>/",
    "sha256": "<hash>",
    "size_bytes": 980000000,
    "model_lib": "https://.../qwen2.5-1.5b-q4f16_1-webgpu.wasm",
    "model_lib_sha256": "<hash>"
  },
  "context_window": 4096,
  "overrides": {},
  "sig": "<ed25519 signature over the canonicalized manifest>"
}
```

**Client responsibilities (identical across platforms):**
1. Resolve → receive manifest.
2. **Verify `sig`** against a pinned public key. Reject if invalid.
3. Download artifact(s) to a content-addressed cache.
4. **Verify `sha256`** of every artifact (weights AND `model_lib`) before load. Reject on mismatch.
5. Load into the runtime.
6. Keep **last-known-good** for offline + rollback; update in the background; **atomic swap** (never tear a running session).
7. Report telemetry (§10).

Per-platform mapping:
- **Browser** → today's `chrome.storage.local.localModelConfig` + `local-model.js`/`offscreen.js`. **GAP:** the current client does **not** yet verify signature/hash — see §12.
- **iOS** → a GGUF file path handed to `LlamaCppXC` after verification.
- **Server (Forge)** → the vLLM model dir / served-model name; resolution at deploy/reload.

---

## 5. Distribution / hosting

- **Cloudflare R2**, content-addressed keys (`/cas/<sha256>/…`) → immutable,
  infinitely cacheable, dedupes identical artifacts. No egress fees.
- **Per-tenant / on-prem:** resolver returns the tenant's own host; weights never
  cross the tenant boundary.
- Range requests for shard streaming; long-lived CDN cache (safe because
  content-addressed).

---

## 6. Security (the #1 requirement — this is a legal product)

- **Signed manifests (Ed25519).** Clients pin the public key(s); verify before
  trusting any URL or hash. Support key rotation (multiple valid keys).
- **Hash-verify every artifact before load** — weights *and* the WebLLM WASM
  `model_lib`, which is **executable code**. A compromised registry or MITM'd
  fetch is a code-injection path into the product; hash pinning closes it.
- **HTTPS only.** No plaintext weight fetches (ties to the extension's existing
  http+bearer caveat).
- **Tenant isolation:** a tenant token can only resolve models scoped to it.
- **Kill-switch:** `channel: "revoked"` → clients refuse to load that version.

---

## 7. Versioning & rollout

- Immutable versions; **channels** (`stable`/`canary`); **percentage rollout** by
  a stable hash of the client id; **per-tenant pin** to a fixed version; **rollback**
  = move the channel pointer back (clients hold last-known-good so it's instant).

---

## 8. Conversion pipeline (fine-tune once → all runtimes)

Automate in CI:

```
tuned checkpoint (merged)
  ├─ MLC   : mlc_llm convert_weight + gen_config (q4f16_1)  → webllm artifact
  │          (same architecture → reuse the prebuilt model_lib; no recompile)
  ├─ GGUF  : llama.cpp convert_hf_to_gguf + quantize (Q4_K_M) → llamacpp artifact
  └─ AWQ   : autoawq / vLLM quantization                    → vllm artifact
→ hash each → sign the manifest → upload to R2 (/cas/<sha256>/) → register version
```

See `docs/LOCAL_MODEL_WEIGHTS.md` for the browser/MLC half in detail.

---

## 9. Offline & caching

Content-addressed cache keyed by sha256; last-known-good survives resolver
outages; background download of the next version; atomic swap on completion.

## 10. Telemetry

Per client: which `logical_id@version` is loaded, load success/failure, download
errors, per-model latency. Drives rollout/rollback decisions. Metadata only — no
inference content.

---

## 11. Rollout plan (phased)

1. **Foundations** — registry schema + R2 `/cas/` layout + Ed25519 signing +
   make the **browser client spec-compliant** (add §4 verify steps).
2. **Resolver API** + the **Forge/vLLM** client (server-side resolution at reload).
3. **iOS client** (`LlamaCppXC` + GGUF + verification).
4. **Rollout controls** (channels/canary/pin) + the **conversion CI**.

---

## 12. Open decisions (need a call)

- **Signing key management** — where the private key lives (HSM/KMS?), rotation.
- **Registry storage** — static signed JSON on R2, vs a small service on
  RedRoosterTech-Web (the discovery home). Static is simpler; a service enables
  per-tenant/rollout logic server-side.
- **Weight licensing** — redistributing derived weights inherits the base model's
  license (Qwen/Llama terms). Confirm redistribution rights per base model.
- **Reference-client gap** — the extension's `localModelConfig` must add signature
  + hash verification (§4.2/4.4) to be spec-compliant. Small, but required before
  any custom weights ship.

---

## Appendix: reference client (extension) — current vs spec

| Spec step | Extension today |
|-----------|-----------------|
| Custom weights via config | ✅ `localModelConfig` → WebLLM appConfig (offscreen + in-document) |
| Prebuilt fallback / dormant default | ✅ loads lightweight prebuilt when unset |
| Resolve from a discovery API | ⬜ (manual config today) |
| Signature verify | ⬜ **to add** |
| Hash verify before load | ⬜ **to add** |
| Content-addressed cache / LKG / atomic swap | 🟡 WebLLM caches weights; no version/LKG logic yet |
