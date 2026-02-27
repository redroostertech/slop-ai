import { estimateTokens, generateId } from '../utils.js';

export function parseGeminiTakeout(data) {
  const activities = (Array.isArray(data) ? data : [data])
    .filter(a => a.header === 'Gemini Apps' || a.header === 'Bard')
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  if (activities.length === 0) return [];

  const conversations = [];
  let current = null;

  for (const activity of activities) {
    const timestamp = new Date(activity.time).toISOString();
    const userContent = (activity.title || '').trim();
    const assistantContent = (activity.subtitles?.[0]?.name || '').trim();

    // New conversation if gap > 30 minutes
    const gap = current
      ? Date.now() - new Date(current.lastTime).getTime() > 0
        ? new Date(timestamp) - new Date(current.lastTime)
        : Infinity
      : Infinity;

    if (gap > 30 * 60 * 1000 || !current) {
      if (current) conversations.push(finalize(current));
      current = {
        id: generateId(),
        sourceId: generateId(),
        source: 'gemini',
        title: userContent.slice(0, 80) || 'Gemini Conversation',
        createdAt: timestamp,
        messages: [],
        lastTime: timestamp
      };
    }

    if (userContent) {
      current.messages.push({
        id: generateId(),
        role: 'user',
        content: userContent,
        timestamp,
        metadata: {}
      });
    }
    if (assistantContent) {
      current.messages.push({
        id: generateId(),
        role: 'assistant',
        content: assistantContent,
        timestamp,
        metadata: {}
      });
    }
    current.lastTime = timestamp;
  }

  if (current) conversations.push(finalize(current));
  return conversations.filter(c => c.messages.length > 0);
}

export function parseGeminiGeneric(data) {
  const items = Array.isArray(data) ? data : [data];

  return items.map(item => {
    const messages = (item.messages || []).map(m => ({
      id: generateId(),
      role: m.role === 'model' ? 'assistant' : (m.role || 'user'),
      content: (m.content || m.text || m.parts?.map(p => p.text).join('\n') || '').trim(),
      timestamp: m.timestamp || null,
      metadata: {}
    })).filter(m => m.content);

    if (messages.length === 0) return null;

    const totalText = messages.map(m => m.content).join(' ');

    return {
      id: generateId(),
      sourceId: item.id || generateId(),
      source: 'gemini',
      title: item.title || messages[0]?.content.slice(0, 80) || 'Gemini Conversation',
      createdAt: item.timestamp || item.created_at || new Date().toISOString(),
      updatedAt: null,
      importedAt: new Date().toISOString(),
      messageCount: messages.length,
      estimatedTokens: estimateTokens(totalText),
      messages,
      metadata: {
        originalFormat: 'gemini-generic',
        contentMayBeTruncated: false
      }
    };
  }).filter(Boolean);
}

function finalize(conv) {
  const totalText = conv.messages.map(m => m.content).join(' ');
  return {
    ...conv,
    updatedAt: conv.lastTime,
    importedAt: new Date().toISOString(),
    messageCount: conv.messages.length,
    estimatedTokens: estimateTokens(totalText),
    metadata: {
      originalFormat: 'gemini-takeout',
      contentMayBeTruncated: true
    }
  };
}
