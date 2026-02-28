import { estimateTokens, generateId } from '../utils.js';

export function parseClaude(jsonData) {
  const raw = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;

  return raw.map(conv => {
    const messages = (conv.chat_messages || [])
      .filter(msg => msg.sender === 'human' || msg.sender === 'assistant')
      .map(msg => ({
        id: generateId(),
        role: msg.sender === 'human' ? 'user' : 'assistant',
        content: extractClaudeContent(msg),
        timestamp: msg.created_at || null,
        metadata: {
          hasAttachments: (msg.attachments?.length || 0) > 0
        }
      }))
      .filter(m => m.content.trim());

    if (messages.length === 0) return null;

    const totalText = messages.map(m => m.content).join(' ');

    return {
      id: generateId(),
      sourceId: conv.uuid || generateId(),
      source: 'claude',
      title: conv.name || 'Untitled',
      createdAt: conv.created_at || new Date().toISOString(),
      updatedAt: conv.updated_at || null,
      importedAt: new Date().toISOString(),
      messageCount: messages.length,
      estimatedTokens: estimateTokens(totalText),
      messages,
      metadata: {
        originalFormat: 'claude-zip',
        summary: conv.summary || null
      }
    };
  }).filter(Boolean);
}

function extractClaudeContent(msg) {
  if (msg.text && msg.text.trim()) return msg.text.trim();

  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();
  }

  return '';
}
