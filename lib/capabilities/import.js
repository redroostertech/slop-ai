/**
 * @fileoverview Import ChatGPT / Claude conversation exports.
 *
 * Capability #2 (the "imported" half). Parses the JSON export files the user
 * downloads from ChatGPT and Claude into the extension's conversation shape and
 * stores them in the local knowledge store (L2) so they can be reasoned over by
 * the cascade like any captured conversation.
 *
 * Both vendors periodically change their export schema, so each parser is
 * defensive: it extracts what it recognizes and skips the rest rather than
 * throwing on an unexpected field.
 *
 * @module lib/capabilities/import
 */

import { dbPut } from '../db.js';

/**
 * Parse a ChatGPT `conversations.json` export.
 * Shape: array of conversations, each with a `mapping` of message nodes keyed
 * by id, forming a tree; we linearize by walking parent→child from the root.
 *
 * @param {any} json  parsed JSON
 * @returns {Array<{title: string, source: string, createdAt: number, messages: Array}>}
 */
export function parseChatGPTExport(json) {
  const conversations = Array.isArray(json) ? json : json.conversations || [];
  const out = [];
  for (const conv of conversations) {
    const mapping = conv.mapping || {};
    const nodes = Object.values(mapping);
    // Order by message create_time when present, else mapping insertion order.
    const messages = nodes
      .map((n) => n.message)
      .filter((m) => m && m.content && m.author?.role)
      .filter((m) => ['user', 'assistant'].includes(m.author.role))
      .map((m) => ({
        role: m.author.role,
        content: extractChatGPTContent(m.content),
        capturedAt: m.create_time ? Math.round(m.create_time * 1000) : undefined,
      }))
      .filter((m) => m.content.trim())
      .sort((a, b) => (a.capturedAt || 0) - (b.capturedAt || 0));

    if (messages.length === 0) continue;
    out.push({
      title: conv.title || 'ChatGPT conversation',
      source: 'chatgpt-import',
      createdAt: conv.create_time ? Math.round(conv.create_time * 1000) : Date.now(),
      messages,
    });
  }
  return out;
}

/** ChatGPT content parts → text. Handles the common `{parts:[...]}` shape. */
function extractChatGPTContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content?.parts)) {
    return content.parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n').trim();
  }
  return '';
}

/**
 * Parse a Claude `conversations.json` export.
 * Shape: array of conversations with `name` + `chat_messages`
 * (`sender: 'human'|'assistant'`, `text` or `content:[{type:'text',text}]`).
 *
 * @param {any} json
 * @returns {Array<{title: string, source: string, createdAt: number, messages: Array}>}
 */
export function parseClaudeExport(json) {
  const conversations = Array.isArray(json) ? json : json.conversations || [];
  const out = [];
  for (const conv of conversations) {
    const raw = conv.chat_messages || conv.messages || [];
    const messages = raw
      .map((m) => ({
        role: (m.sender || m.role) === 'assistant' ? 'assistant' : 'user',
        content: extractClaudeText(m),
        capturedAt: m.created_at ? Date.parse(m.created_at) || undefined : undefined,
      }))
      .filter((m) => m.content.trim());

    if (messages.length === 0) continue;
    out.push({
      title: conv.name || conv.title || 'Claude conversation',
      source: 'claude-import',
      createdAt: conv.created_at ? Date.parse(conv.created_at) || Date.now() : Date.now(),
      messages,
    });
  }
  return out;
}

/** Claude message text extraction across the string / content-array shapes. */
function extractClaudeText(m) {
  if (typeof m.text === 'string' && m.text) return m.text;
  if (Array.isArray(m.content)) {
    return m.content.map((b) => (b?.type === 'text' ? b.text : b?.text || '')).join('\n').trim();
  }
  if (typeof m.content === 'string') return m.content;
  return '';
}

/**
 * Auto-detect vendor and parse.
 * @param {any} json
 * @returns {{vendor: 'chatgpt'|'claude'|'unknown', conversations: Array}}
 */
export function parseExport(json) {
  const sample = (Array.isArray(json) ? json[0] : json) || {};
  if (sample.mapping) return { vendor: 'chatgpt', conversations: parseChatGPTExport(json) };
  if (sample.chat_messages || sample.name) return { vendor: 'claude', conversations: parseClaudeExport(json) };
  return { vendor: 'unknown', conversations: [] };
}

/**
 * Parse + persist an export file's text into the local store.
 * @param {string} jsonText  the raw file contents
 * @returns {Promise<{vendor: string, imported: number}>}
 */
export async function importExportText(jsonText) {
  let json;
  try {
    json = JSON.parse(jsonText);
  } catch {
    throw new Error('That file is not valid JSON. Export the conversations.json from ChatGPT or Claude.');
  }
  const { vendor, conversations } = parseExport(json);
  if (vendor === 'unknown') throw new Error('Unrecognized export format (expected a ChatGPT or Claude export).');

  let imported = 0;
  for (const conv of conversations) {
    const id = `${conv.source}:${conv.createdAt}:${imported}`;
    await dbPut('conversations', {
      id,
      title: conv.title,
      source: conv.source,
      createdAt: conv.createdAt,
      updatedAt: conv.createdAt,
      messageCount: conv.messages.length,
      messages: conv.messages,
    });
    imported++;
  }
  return { vendor, imported };
}
