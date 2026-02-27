import { extractFromZip, readZipEntry } from '../zip.js';
import { parseChatGPT } from './chatgpt.js';
import { parseClaude } from './claude.js';
import { parseGeminiTakeout, parseGeminiGeneric } from './gemini.js';
import { parseCopilotCsv, parseCopilotJson } from './copilot.js';

export async function parseImport(file) {
  const ext = file.name.toLowerCase().split('.').pop();

  if (ext === 'zip') return await parseZipImport(file);
  if (ext === 'json') return await parseJsonImport(file);
  if (ext === 'csv') return await parseCsvImport(file);

  throw new Error(`Unsupported file type: .${ext}`);
}

async function parseZipImport(file) {
  const { zip } = await extractFromZip(file);

  // Look for conversations.json in the ZIP
  const jsonFiles = [];
  zip.forEach((path, entry) => {
    if (!entry.dir && path.endsWith('.json')) {
      jsonFiles.push({ path, entry });
    }
  });

  // Try conversations.json first (both ChatGPT and Claude use this name)
  for (const { path, entry } of jsonFiles) {
    if (path.endsWith('conversations.json') || path.match(/conversations\.json$/i)) {
      const text = await entry.async('string');
      const data = JSON.parse(text);

      if (Array.isArray(data) && data.length > 0) {
        // ChatGPT: has `mapping` objects
        if (data[0].mapping) {
          return { source: 'chatgpt', conversations: parseChatGPT(data) };
        }
        // Claude: has `chat_messages` arrays
        if (data[0].chat_messages) {
          return { source: 'claude', conversations: parseClaude(data) };
        }
      }
    }
  }

  // Try any other JSON files in the ZIP
  for (const { path, entry } of jsonFiles) {
    const text = await entry.async('string');
    try {
      const data = JSON.parse(text);
      const detected = detectJsonFormat(data);
      if (detected) return detected;
    } catch {
      // Skip non-parseable files
    }
  }

  throw new Error('Could not identify any conversation data in the ZIP file.');
}

async function parseJsonImport(file) {
  const text = await file.text();
  const data = JSON.parse(text);

  const detected = detectJsonFormat(data);
  if (detected) return detected;

  throw new Error('Unrecognized JSON format. Supported: ChatGPT, Claude, Gemini (Takeout), or generic conversation JSON.');
}

async function parseCsvImport(file) {
  const text = await file.text();
  const conversations = parseCopilotCsv(text);
  if (conversations.length === 0) {
    throw new Error('No conversation data found in CSV file.');
  }
  return { source: 'copilot', conversations };
}

function detectJsonFormat(data) {
  if (!data) return null;

  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];

    // ChatGPT: mapping tree structure
    if (first.mapping) {
      return { source: 'chatgpt', conversations: parseChatGPT(data) };
    }

    // Claude: chat_messages flat array
    if (first.chat_messages) {
      return { source: 'claude', conversations: parseClaude(data) };
    }

    // Gemini Takeout: header field
    if (first.header === 'Gemini Apps' || first.header === 'Bard') {
      return { source: 'gemini', conversations: parseGeminiTakeout(data) };
    }

    // Generic with source field
    if (first.messages && first.source) {
      const source = first.source.toLowerCase();
      if (source.includes('copilot')) {
        return { source: 'copilot', conversations: parseCopilotJson(data) };
      }
      if (source.includes('gemini')) {
        return { source: 'gemini', conversations: parseGeminiGeneric(data) };
      }
    }

    // Generic messages array (try gemini generic)
    if (first.messages && Array.isArray(first.messages)) {
      return { source: 'gemini', conversations: parseGeminiGeneric(data) };
    }
  }

  // Single conversation object
  if (data.messages && Array.isArray(data.messages)) {
    if (data.chat_messages) {
      return { source: 'claude', conversations: parseClaude([data]) };
    }
    return { source: 'gemini', conversations: parseGeminiGeneric([data]) };
  }

  return null;
}
