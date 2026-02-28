# Slop - Installation & Setup Guide

Your AI conversations are scattered across ChatGPT, Claude, Gemini, and Copilot. Slop captures, summarizes, and injects your knowledge back — so every new conversation benefits from what you've already learned.

All data stays on your device. No accounts, no cloud sync, no tracking.

---

## Step 1: Install the Extension

1. Unzip the `slop.zip` file to a folder on your computer (e.g., `Desktop/slop`)
2. Open **Google Chrome** and navigate to `chrome://extensions`
3. Toggle **Developer mode** ON (top-right corner)
4. Click **Load unpacked**
5. Select the unzipped folder (the one containing `manifest.json`)
6. Slop will appear in your extensions list with a green puzzle-piece icon

> **Tip:** Pin the extension by clicking the puzzle icon in Chrome's toolbar, then clicking the pin next to "Slop."

---

## Step 2: Set Up an AI Provider

Slop needs an AI provider to summarize your conversations and extract insights. You can use **OpenAI**, **Anthropic Claude**, or **Google Gemini**.

### Open Settings

1. Click the **Slop** icon in Chrome's toolbar — the side panel will open
2. Click the **gear icon** (top-right of the side panel) to open Settings

### Add OpenAI

1. Click **+ Add Provider**
2. Select **OpenAI** from the provider type dropdown
3. The name and endpoint will auto-fill
4. Paste your **API key** (get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys))
5. Choose a model:
   - **gpt-4o-mini** (default) — fast and affordable
   - **gpt-4o** — higher quality, costs more
6. Click **Test Connection** to verify it works
7. Click **Save**

### Add Anthropic Claude (Alternative)

1. Click **+ Add Provider**
2. Select **Claude**
3. Paste your API key from [console.anthropic.com](https://console.anthropic.com/)
4. Choose a model:
   - **claude-sonnet-4** (default)
   - **claude-haiku-3.5** — faster, cheaper
5. Test and save

### Add Google Gemini (Alternative)

1. Click **+ Add Provider**
2. Select **Gemini**
3. Paste your API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
4. Choose a model:
   - **gemini-2.0-flash** (default) — fast
   - **gemini-2.5-pro** — higher quality
5. Test and save

> You can add **multiple providers**. Slop will use them in priority order — drag to reorder. If one fails, it falls back to the next.

---

## Step 3: Start Using Slop

### Automatic Capture

Visit any supported site — **ChatGPT**, **Claude**, **Gemini**, or **Copilot** — and have a conversation. Slop captures messages automatically in the background.

### Smart Sidebar

While chatting, a small floating icon appears on the page. Click it to open the **context sidebar**, which shows relevant knowledge from your past conversations. Click any item to inject it directly into your current chat.

### Import Past Conversations

Already have conversation history? Import it:

1. Open the Slop side panel
2. Go to the **Import** tab
3. Drag and drop your export file:
   - **ChatGPT**: Settings > Data Controls > Export Data (ZIP file)
   - **Claude**: Settings > Export Data (ZIP file)
   - **Gemini**: Google Takeout > Gemini Apps (ZIP file)
   - **Copilot**: Export as CSV or JSON

### Summarize

After importing or capturing conversations:

1. Go to the **Dashboard** tab
2. Click **Summarize Pending** to batch-process all unsummarized conversations
3. Slop extracts key insights, decisions, code snippets, and organizes everything by topic

### Search & Browse

- **Topics** tab: Browse your knowledge organized by theme
- **Conversations** tab: Search and filter all captured conversations
- **Search**: Find anything across your entire knowledge library

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Side panel doesn't open | Click the Slop icon in the toolbar. If missing, check `chrome://extensions` and make sure it's enabled. |
| "No provider configured" | Go to Settings and add at least one AI provider with a valid API key. |
| Test connection fails | Double-check your API key. Make sure you have billing set up on your provider account. |
| Conversations not capturing | Refresh the page. Check that the site is supported (ChatGPT, Claude, Gemini, or Copilot). |
| Extension stopped working after Chrome update | Go to `chrome://extensions`, disable then re-enable Slop. |

---

## Privacy & Security

- **100% local storage** — all conversations, summaries, and API keys stay on your device
- **No accounts or sign-ups** required
- **No telemetry** — Slop sends nothing to our servers
- **API calls go directly** from your browser to your configured AI provider
- Your API key is stored in Chrome's local storage and never leaves your machine

---

## Getting Help

If you run into issues or have feedback, reach out to the team directly via the email this was shared from.
