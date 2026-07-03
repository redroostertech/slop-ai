# Local model weights — swapping, self-hosting, and fine-tuning

The on-device model (the "handle it locally" half of the cascade) runs via WebLLM
/ MLC over WebGPU. There are two ways to change what weights it loads, both driven
by `chrome.storage.local` and honored by **both** local paths
(`offscreen/offscreen.js` for the background router, `lib/local-model.js` for the
in-document path):

| Storage key | Meaning |
|-------------|---------|
| `localModelId` | A **prebuilt** MLC model id (e.g. `Qwen2.5-1.5B-Instruct-q4f16_1-MLC`). Default path today. |
| `localModelConfig` | A **custom self-hosted** model: `{ model, model_id, model_lib, overrides? }`. Dormant until set — with nothing configured we load the lightweight prebuilt. |

> **Status: infrastructure only, not deployed.** The custom path is wired but
> inert. For now the extension loads lightweight prebuilt models. Set
> `localModelConfig` only when you actually host custom weights.

## `localModelConfig` contract

```jsonc
{
  "model":     "https://weights.lanaai.io/lana-legal-1.5b/",          // dir of MLC weight shards + mlc-chat-config.json
  "model_id":  "lana-legal-1.5b",                                     // the id WebLLM selects
  "model_lib": "https://weights.lanaai.io/libs/Qwen2.5-1.5B-q4f16_1-webgpu.wasm", // compiled model lib
  "overrides": { "context_window_size": 4096 }                       // optional
}
```
- `model` — URL to the **weight shards** directory (the MLC output: `params_shard_*.bin` + `mlc-chat-config.json` + `tokenizer.*`).
- `model_lib` — URL to the **compiled WASM** for the architecture. For a
  **same-architecture fine-tune** (e.g. you fine-tuned Qwen2.5-1.5B), **reuse
  MLC's prebuilt lib** for that model/quant — you do NOT need to recompile. Only
  a new architecture needs `mlc_llm compile`.

Whatever host you use must be reachable by the offscreen document's `fetch`: add
its origin to `host_permissions` (or request at runtime) and, if you tighten the
CSP, allow it in `connect-src`. See `vendor/web-llm.README.md`.

## Fine-tuning a custom LANA local model

Training happens **off-device** (GPU box — your RunPod/Forge infra). The browser
only does inference. Pipeline:

### 1. Fine-tune (LoRA is usually enough)
```bash
# Base: a small instruct model matching the prebuilt you ship (Qwen2.5-1.5B).
# Use PEFT/LoRA on your instruction dataset, then merge the adapter into the base.
python train_lora.py --base Qwen/Qwen2.5-1.5B-Instruct --data legal_sft.jsonl ...
python merge_lora.py --base Qwen/Qwen2.5-1.5B-Instruct --adapter out/adapter --out out/lana-legal-1.5b
```

### 2. Convert + quantize to MLC
```bash
pip install mlc-llm-nightly   # or build from source; pin the version WebLLM expects
mlc_llm convert_weight ./out/lana-legal-1.5b \
  --quantization q4f16_1 -o ./dist/lana-legal-1.5b
mlc_llm gen_config ./out/lana-legal-1.5b \
  --quantization q4f16_1 --conv-template qwen2 -o ./dist/lana-legal-1.5b
# Same architecture as a prebuilt → reuse that prebuilt's model_lib; skip compile.
# New architecture only:
# mlc_llm compile ./dist/lana-legal-1.5b/mlc-chat-config.json \
#   --device webgpu -o ./dist/libs/lana-legal-1.5b-webgpu.wasm
```

### 3. Host the output
Upload `./dist/lana-legal-1.5b/` (weight shards + config + tokenizer) and, if you
compiled one, the `.wasm` lib to **Cloudflare R2** behind `weights.lanaai.io`
(no egress fees), or the on-prem customer's host.

### 4. Point the extension at it
Set `chrome.storage.local.localModelConfig` to the contract above (via a Settings
control or programmatically). Reload — the offscreen router picks it up; no code
change needed.

## ⚠️ Privacy caveat (this is a legal product)

Fine-tuning **memorizes** training data into the weights — a model can regurgitate
verbatim strings it was trained on. **Do not train on raw client PII.** Use
de-identified, synthetic, or firm-approved data, apply the same redaction
discipline the rest of the stack enforces, and keep per-firm tunes on that firm's
own (on-prem) host. Distilling from Forge's server model (to make the local answer
read like the server one) should use non-PII prompts/outputs.

## Ideas this unlocks
- **Legal-domain local model** — a small model that already "speaks legal," so the
  on-device tier is useful without escalating.
- **Forge distillation** — tune the local model to mimic Forge's Qwen-27B style so
  the local→escalate cascade feels consistent.
- **Per-firm / on-prem tunes** — a model fine-tuned on a firm's approved data,
  hosted on their box: a strong sovereign differentiator.
