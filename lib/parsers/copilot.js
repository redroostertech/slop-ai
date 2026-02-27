import { estimateTokens, generateId } from '../utils.js';

export function parseCopilotCsv(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return [];

  return rows.map((row, i) => {
    const messages = [];
    const userContent = (row.Query || row.Prompt || row.Input || Object.values(row)[0] || '').trim();
    const assistantContent = (row.Response || row.Answer || row.Output || Object.values(row)[1] || '').trim();

    if (userContent) {
      messages.push({ id: generateId(), role: 'user', content: userContent, timestamp: null, metadata: {} });
    }
    if (assistantContent) {
      messages.push({ id: generateId(), role: 'assistant', content: assistantContent, timestamp: null, metadata: {} });
    }

    if (messages.length === 0) return null;

    const totalText = messages.map(m => m.content).join(' ');
    const timestamp = row.Timestamp || row.Date || row.time || null;

    return {
      id: generateId(),
      sourceId: `copilot-${i}`,
      source: 'copilot',
      title: userContent.slice(0, 80) || `Copilot Activity ${i + 1}`,
      createdAt: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
      updatedAt: null,
      importedAt: new Date().toISOString(),
      messageCount: messages.length,
      estimatedTokens: estimateTokens(totalText),
      messages,
      metadata: {
        originalFormat: 'copilot-csv',
        contentMayBeTruncated: true
      }
    };
  }).filter(Boolean);
}

export function parseCopilotJson(data) {
  const items = Array.isArray(data) ? data : [data];

  return items.map(item => {
    const messages = (item.messages || []).map(m => ({
      id: generateId(),
      role: m.role === 'bot' ? 'assistant' : (m.role || 'user'),
      content: (m.content || m.text || '').trim(),
      timestamp: m.timestamp || null,
      metadata: {}
    })).filter(m => m.content);

    if (messages.length === 0) return null;

    const totalText = messages.map(m => m.content).join(' ');

    return {
      id: generateId(),
      sourceId: item.id || generateId(),
      source: 'copilot',
      title: item.title || messages[0]?.content.slice(0, 80) || 'Copilot Conversation',
      createdAt: item.timestamp || item.created_at || new Date().toISOString(),
      updatedAt: null,
      importedAt: new Date().toISOString(),
      messageCount: messages.length,
      estimatedTokens: estimateTokens(totalText),
      messages,
      metadata: {
        originalFormat: 'copilot-json'
      }
    };
  }).filter(Boolean);
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
