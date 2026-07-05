# LANA AI — UI redesign mockups ("holo tab" charcoal direction)

These six Claude artifacts are the source-of-truth mockups for the agentic
side-panel redesign. They are being ported into the extension under
`sidepanel/lana-ui.css` (design system) + `sidepanel/lana-ui.js` (shell) as the
new top-level views. This file records what each mockup is and which view it
becomes, so the design isn't stranded in artifact URLs.

**Brand:** charcoal `#161616` · off-white `#f5f5f4` · LANA blue `#3067FF`.
Type: SF/system sans, SF Mono for commands. Panel width tracks the side panel.

| # | Mockup (artifact) | Becomes | Backing |
|---|---|---|---|
| 1 | **agent experience** `01c9bec8` | `agent` view (chat + narrated steps), plus reference layouts for Playbooks/History/Settings | Agent loop pending lana-gpt (Phase 3); UI + composer built now |
| 2 | **settings redesign** `1fd345fb` | `settings` view — Account, AI Inference tiers, Your Data | OAuth + account client already wired (Phase 1) |
| 3 | **first-run + authorize** `4b8803bd` | `firstrun` view — heads-up/consent + authorize-waiting | Consent flag + existing OAuth authorize |
| 4 | **composer shortcuts** `f8619dd8` | `agent` composer — `/` playbooks · `#` files/clips · `@` matters | `#`/`@` = Phase 2 grounding; `/` = Phase 4 playbooks |
| 5 | **new playbook** `df460cd5` | New Playbook bottom-sheet (Write it / Record it) | Write-it = local; Record-it = Phase 4 |
| 6 | **captured context** `b802c400` | `captured` view — clips/AI-chats/imports → matter filing | Phase 2 grounding (reuses account ingestion) |

## Phase mapping (PRODUCT_BRIEF.md §11)

- **Phase 1 — Auth** ✅ OAuth 2.0 + PKCE ("Authorize LANA GPT"). *Needs end-to-end testing.*
- **Phase 2 — Grounding** (this migration): `@matter` + `#file` + Captured→matter filing.
- **Phase 3 — Agent loop**: read/navigate/draft + step narration + approval gate (lana-gpt).
- **Phase 4 — Playbooks**: write-it, then record-it.
- **Phase 5 — Polish**: History, suggestions, settings port, entitlement gating, honesty-doc rewrite.

## Environment (no user-facing instance URL)

Per the dev/prod decision: the instance URL is abstracted away from end users
(`lib/env.js`). Production builds target `gpt.lanaai.io`; unpacked/dev builds
target a local instance. On-prem is the only case with an explicit URL, kept as
an under-the-hood override — not a field in the default consumer Settings.

The live mockups (owned by the user) are at `claude.ai/code/artifact/<id>` for
the ids above.
