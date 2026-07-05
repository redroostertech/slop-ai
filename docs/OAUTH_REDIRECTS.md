# OAuth redirect URIs — dev vs prod (Option B)

The extension authorizes via `chrome.identity.launchWebAuthFlow`. Its redirect
URI is derived **only from the extension ID**:

```
redirect_uri = chrome.identity.getRedirectURL()  →  https://<EXTENSION_ID>.chromiumapp.org/
```

The redirect does **not** change per deployment or version bump — it changes
only if the extension ID changes. So each lana-gpt instance's
`OAUTH_REDIRECT_ALLOWLIST` is configured **once**.

We use **Option B: separate dev and prod identities** (a dev token can't be
replayed against prod).

## Dev

The dev **public key is pinned in `manifest.json`** (`"key"`), so every unpacked
load resolves to the same ID on any machine/checkout:

| | value |
|---|---|
| Extension ID | `amnemhhhbmhhaecklpelnhggpcifngdp` |
| **Redirect URI** | `https://amnemhhhbmhhaecklpelnhggpcifngdp.chromiumapp.org/` |

**→ Add that redirect URI to the DEV lana-gpt `OAUTH_REDIRECT_ALLOWLIST`** (on
both the api and web services). Dev builds target `http://localhost:3000`
automatically (see `lib/env.js`).

Private key: `keys/dev-extension.pem` (gitignored via `*.pem`). It is **not**
needed to load unpacked — the pinned public `"key"` alone fixes the ID. Keep it
only if you later want to pack a signed `.crx` with this identity. To reproduce
the ID from the key:

```sh
openssl rsa -in keys/dev-extension.pem -pubout -outform DER -out /tmp/p.der
node -e 'const d=require("fs").readFileSync("/tmp/p.der");\
const h=require("crypto").createHash("sha256").update(d).digest("hex").slice(0,32);\
console.log([...h].map(c=>String.fromCharCode(97+parseInt(c,16))).join(""))'
```

## Prod (cloud + on-prem)

The prod ID is **assigned by the Chrome Web Store** and is fixed once the item
exists — it can't be computed ahead of time. Capture it once at first upload:

1. **Strip (or replace) the dev `"key"`** from `manifest.json` in the packaged
   build — the Store manages the prod identity.
2. Upload the item; read its ID from the dashboard (or `chrome://extensions`).
3. The prod redirect is `https://<STORE_ID>.chromiumapp.org/`.
4. **Add it to the PROD `OAUTH_REDIRECT_ALLOWLIST`.**

Then it never changes again across releases.

### One redirect, every instance

The redirect is tied to the **extension ID, not the instance**. The same
published extension authorizes against the cloud *and* every on-prem box, so
they all allowlist the **same** prod redirect value:

| Deployment | Extension used | Allowlist entry to set |
|---|---|---|
| Dev (localhost) | unpacked dev build | `https://amnemhhhbmhhaecklpelnhggpcifngdp.chromiumapp.org/` |
| Cloud (gpt.lanaai.io) | Store build | `https://<STORE_ID>.chromiumapp.org/` |
| On-prem (each customer) | Store build | `https://<STORE_ID>.chromiumapp.org/` (same as cloud) |

So there is **no new redirect per deployment** — on-prem installers should ship
the prod redirect pre-seeded in their default `OAUTH_REDIRECT_ALLOWLIST`, and a
new cloud region needs nothing extra.

**Exception — custom/white-label builds.** If a customer runs their *own* build
of the extension (different `"key"` → different ID, e.g. a re-branded on-prem
package), that build has its own redirect `https://<THAT_ID>.chromiumapp.org/`,
and only that customer's on-prem allowlist needs it. Give each such build its
own key and record its ID here.

## Do / don't

- ✅ Allowlist the **exact** `https://<id>.chromiumapp.org/` per instance.
- ❌ Never wildcard `https://*.chromiumapp.org/*` — any extension could then
  receive a code (PKCE protects the exchange, but this weakens the redirect
  check).
