# Desktop → extension handoff — end-to-end test runbook

The one part of the identity/roaming build that can't be verified headlessly: the
loopback PAC-bridge handoff between the **LANA desktop app** and the **Chrome
extension**. Everything up to this seam is unit-tested + reviewed; this runbook
exercises the full loop on a real machine.

## Flow under test
```
Extension (Settings → Connect via LANA desktop app)
  → fetch http://127.0.0.1:7890/lana-bridge/companion/request-token  { app: "lana-extension" }
  → desktop app shows consent (Lex modal)  → user allows
  → desktop app POST <tenant>/api/v1/oauth/provision  (Bearer = desktop session)  { client_id: "lana-extension" }
  → backend mints SCOPED token (app=lana-extension, session-backed, rotating refresh)
  → bridge returns { account: { instanceUrl, accessToken, refreshToken, ... } }
  → extension linkAccount() → appears under Settings → Linked accounts
```

## Prereqs
1. **Backend (LANA-AI)** running, with provisioning enabled:
   - `OAUTH_PROVISIONING_ENABLED=true` (secure default is OFF).
   - (For the OAuth fallback path only: `OAUTH_REDIRECT_ALLOWLIST=https://amnemhhhbmhhaecklpelnhggpcifngdp.chromiumapp.org/`.)
   - Apply migration `20260704_oauth_idp.sql`; `lana restart`.
2. **Desktop app (lana-ai-client)** running and **signed into the tenant** (so the bridge has a session + `getToken()` returns it). Bridge listens on `127.0.0.1:7890`.
3. **Extension** loaded unpacked (dev id `amnemhhhbmhhaecklpelnhggpcifngdp`).

## Steps
1. Extension → **Settings → Linked accounts → “Connect via LANA desktop app.”**
2. A consent prompt appears **in the desktop app** — approve (optionally “always allow”).
3. The account appears under **Linked accounts** with an **Active** badge.

## Pass criteria
- ✅ Account linked; `source: 'native'`.
- ✅ The stored token is **scoped**: decode the `accessToken` JWT → `app === "lana-extension"` (NOT a full web-login token).
- ✅ The desktop app **never** returned its raw session token to the extension (bridge response is `{ account: … }`, not `{ token, server }`).
- ✅ Declining the consent → extension shows a friendly error and links nothing.
- ✅ With the desktop app closed → “Connect via desktop app” fails cleanly and points to browser sign-in.
- ✅ Switch/unlink work; a second instance links as a distinct account (multi-account roaming).

## Notes
- The extension needs host permission `http://127.0.0.1/*` (in the manifest) to reach the bridge; MV3 host-permission fetches bypass CORS, and the bridge enforces loopback-only.
- Refresh rotation, org-recheck, and the 90-day family cap are exercised by the backend unit tests (`tests/unit/oauth-idp.*`); this runbook covers the handoff + scoping.
