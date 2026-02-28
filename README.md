<p align="center">
  <img src="icons/icon128.png" alt="Slop" width="128" height="128" />
</p>

<h1 align="center">Slop</h1>

<p align="center">
  <strong>Your AI conversations are scattered. Slop gives them a memory.</strong>
</p>

<p align="center">
  Captures, summarizes, and injects your knowledge back — across ChatGPT, Claude, Gemini &amp; Copilot.
</p>

<p align="center">
  100% local. No accounts. No cloud. No tracking.
</p>

---

## What It Does

You talk to AI every day. But every new chat starts from scratch — no memory of what you've already discussed, decided, or built.

Slop fixes that:

1. **Captures** your conversations automatically across ChatGPT, Claude, Gemini, and Copilot
2. **Summarizes** them — pulling out key insights, decisions, and code
3. **Organizes** everything by topic
4. **Surfaces** relevant context while you chat, with one-click injection

No more repeating yourself. No more lost context.

---

## Features

- **Multi-platform** — works on ChatGPT, Claude, Gemini, and Microsoft Copilot
- **Automatic capture** — no copy-pasting or manual saving
- **AI-powered summaries** — extracts insights, decisions, and code snippets
- **Smart sidebar** — shows relevant knowledge while you chat
- **One-click inject** — drop context into any AI chat, formatted per platform
- **Topic organization** — knowledge sorts itself automatically
- **Contradiction detection** — flags when old notes conflict with new ones
- **Import/export** — bring in past conversations, export your knowledge base
- **Search** — find anything across your entire knowledge library
- **Analytics** — dashboard for knowledge health and trends
- **Privacy-first** — everything stays on your machine

---

## Installation

### From Source (Developer Mode)

1. Clone the repo:
   ```bash
   git clone https://github.com/redroostertech/slop-ai.git
   ```

2. Open Chrome and go to `chrome://extensions`

3. Toggle **Developer mode** ON (top-right)

4. Click **Load unpacked** and select the cloned folder

5. Pin the extension from Chrome's puzzle icon in the toolbar

### From ZIP (Early Adopters)

See [INSTALL_GUIDE.md](INSTALL_GUIDE.md) for step-by-step instructions.

---

## Setup

Slop needs an AI provider to power summarization. You bring your own API key.

1. Click the Slop icon in Chrome's toolbar to open the side panel
2. Click the **gear icon** to open Settings
3. Click **+ Add Provider** and choose one:

| Provider | Get an API Key | Recommended Model |
|----------|---------------|-------------------|
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `gpt-4o-mini` |
| **Anthropic Claude** | [console.anthropic.com](https://console.anthropic.com/) | `claude-sonnet-4` |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.0-flash` |

4. Paste your key, select a model, click **Test Connection**, then **Save**

You can add multiple providers — Slop uses them in priority order with automatic fallback.

---

## Usage

### Automatic Capture
Visit any supported AI site and chat normally. Slop captures messages in the background.

### Smart Sidebar
A floating icon appears on supported sites. Click it to see relevant knowledge from past conversations and inject it into your current chat.

### Import Past Conversations
Drag and drop export files into the Import tab:
- **ChatGPT** — Settings > Data Controls > Export Data (ZIP)
- **Claude** — Settings > Export Data (ZIP)
- **Gemini** — Google Takeout > Gemini Apps (ZIP)
- **Copilot** — CSV or JSON export

### Summarize
Go to the Dashboard and click **Summarize Pending** to batch-process conversations, or summarize individually from any conversation detail view.

---

## Project Structure

```
slop-ai/
├── manifest.json              # Chrome extension manifest (MV3)
├── background/
│   └── service-worker.js      # Background message router
├── sidepanel/
│   ├── sidepanel.html         # Side panel UI
│   ├── sidepanel.js           # Side panel logic
│   └── sidepanel.css          # Styles
├── content-scripts/
│   ├── sites/                 # Per-platform capture scripts
│   ├── capture.js             # Conversation capture logic
│   └── inject/                # Smart sidebar injection
├── lib/
│   ├── ai-router.js           # Multi-provider AI routing
│   ├── summarizer.js          # AI summarization engine
│   ├── knowledge.js           # Topic organization
│   ├── relevance.js           # Knowledge scoring
│   ├── injector.js            # Context formatting
│   ├── conflicts.js           # Contradiction detection
│   ├── embeddings.js          # Vector embeddings
│   ├── analytics.js           # Knowledge health metrics
│   ├── db.js                  # IndexedDB storage layer
│   ├── exporter.js            # Export (Markdown, XML, JSON)
│   └── parsers/               # Import parsers (ChatGPT, Claude, Gemini, Copilot)
└── icons/                     # Extension icons
```

---

## Contributing

Contributions are welcome! Here's how to get started:

### Reporting Issues
Open an [issue](https://github.com/redroostertech/slop-ai/issues) with:
- What you expected to happen
- What actually happened
- Browser version and any console errors

### Submitting Changes

1. Fork the repo
2. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes
4. Test manually by loading the unpacked extension in Chrome
5. Commit with a clear message describing what and why
6. Open a pull request against `main`

### Guidelines

- Keep changes focused — one feature or fix per PR
- Follow existing code patterns and naming conventions
- Test on at least one supported platform (ChatGPT, Claude, Gemini, or Copilot)
- No external build tools or npm dependencies — the extension runs as plain ES modules
- Don't commit API keys or personal data

### Areas Where Help Is Needed

- Additional AI platform support
- Improved conversation capture selectors as sites update their DOM
- Better summarization prompts
- Accessibility improvements
- Bug reports from different Chrome versions and OS environments

---

## Privacy

- All data is stored locally in your browser (IndexedDB + Chrome storage)
- API keys never leave your machine — calls go directly to your chosen provider
- No telemetry, analytics, or tracking of any kind
- No accounts, no sign-ups, no servers

---

## License

Copyright (c) 2025-2026 **RedRooster Technologies Inc.** All rights reserved.

This software is provided under a proprietary license. See [LICENSE](LICENSE) for full terms.

---

<p align="center">
  Built by <a href="https://github.com/redroostertech">RedRooster Technologies Inc.</a>
</p>
