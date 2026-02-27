import { estimateTokens, generateId } from '../utils.js';

export function parseChatGPT(jsonData) {
  const raw = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;

  return raw.map(conv => {
    const messages = extractMessages(conv.mapping);
    if (messages.length === 0) return null;

    const totalText = messages.map(m => m.content).join(' ');

    return {
      id: generateId(),
      sourceId: conv.id || conv.conversation_id || generateId(),
      source: 'chatgpt',
      title: conv.title || 'Untitled',
      createdAt: conv.create_time ? new Date(conv.create_time * 1000).toISOString() : new Date().toISOString(),
      updatedAt: conv.update_time ? new Date(conv.update_time * 1000).toISOString() : null,
      importedAt: new Date().toISOString(),
      messageCount: messages.length,
      estimatedTokens: estimateTokens(totalText),
      messages,
      metadata: {
        originalFormat: 'chatgpt-zip'
      }
    };
  }).filter(Boolean);
}

function extractMessages(mapping) {
  if (!mapping) return [];

  let rootId = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent || !mapping[node.parent]) {
      rootId = id;
      break;
    }
  }
  if (!rootId) return [];

  const messages = [];
  const visited = new Set();

  function walk(nodeId) {
    if (!nodeId || visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = mapping[nodeId];
    if (!node) return;

    if (node.message) {
      const msg = node.message;
      const role = msg.author?.role;
      if (role === 'user' || role === 'assistant') {
        let content = '';
        if (msg.content?.parts) {
          content = msg.content.parts
            .filter(p => typeof p === 'string')
            .join('\n');
        } else if (msg.content?.text) {
          content = msg.content.text;
        }
        if (content.trim()) {
          messages.push({
            id: generateId(),
            role,
            content: content.trim(),
            timestamp: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
            metadata: {
              model: msg.metadata?.model_slug || null
            }
          });
        }
      }
    }

    if (node.children) {
      for (const childId of node.children) {
        walk(childId);
      }
    }
  }

  walk(rootId);
  return messages;
}
