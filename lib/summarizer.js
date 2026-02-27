import { estimateTokens, generateId } from './utils.js';
import { complete } from './ai-router.js';

const MAX_CONTEXT_TOKENS = 12000;

export async function summarizeConversation(conversation, options = {}) {
  const injectionContext = options.injectionContext || null;

  const truncatedMessages = truncateToTokenBudget(conversation.messages, MAX_CONTEXT_TOKENS - 2000);

  const conversationText = truncatedMessages.map(m => {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    return `**${label}:**\n${m.content}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are a knowledge extraction assistant. Analyze the following AI conversation and produce a structured summary. Output valid JSON matching this exact schema:

{
  "title": "A concise descriptive title (max 80 chars)",
  "summary": "2-3 paragraph summary of what was discussed, what was accomplished, and key outcomes",
  "keyInsights": ["Array of 3-7 key insights, takeaways, or lessons learned"],
  "decisions": ["Array of decisions made or conclusions reached, if any"],
  "codeSnippets": [{"language": "lang", "code": "code here", "description": "what this code does"}],
  "tags": ["Array of 5-15 lowercase topic tags for categorization"],
  "suggestedTopicName": "A broad topic category this conversation belongs to (e.g., 'React Development', 'Database Design', 'API Architecture')"
}

Focus on extracting actionable knowledge. Tags should be specific enough to be useful for filtering. If code snippets are discussed, extract the most important ones. If no code is present, return an empty array for codeSnippets. If no decisions were made, return an empty array for decisions.`;

  let userContent = `Analyze this conversation titled "${conversation.title}" from ${conversation.source}:\n\n${conversationText}`;

  if (injectionContext && injectionContext.length > 0) {
    const parentNames = injectionContext.map(c => c.title || c.summaryId).join(', ');
    userContent += `\n\n---\nNote: This conversation was informed by previously captured knowledge: ${parentNames}. The summary should acknowledge any continuation or expansion of those topics.`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  const result = await complete(messages, {
    temperature: 0.3,
    maxTokens: 2000,
    jsonMode: true,
    model: options.model,
  });

  let parsed;
  try {
    parsed = JSON.parse(result.content);
  } catch (parseErr) {
    throw new Error(`Failed to parse AI response as JSON: ${parseErr.message}`);
  }

  return {
    id: generateId(),
    conversationId: conversation.id,
    topicId: null,
    title: parsed.title || conversation.title,
    summary: parsed.summary || '',
    keyInsights: parsed.keyInsights || [],
    decisions: parsed.decisions || [],
    codeSnippets: parsed.codeSnippets || [],
    tags: parsed.tags || [],
    suggestedTopicName: parsed.suggestedTopicName || 'General',
    createdAt: new Date().toISOString(),
    metadata: {
      modelUsed: result.model,
      providerUsed: result.providerType,
      providerId: result.providerId,
      tokensUsed: result.usage?.total_tokens || 0,
      promptVersion: injectionContext ? 2 : 1,
      derivedFrom: injectionContext
        ? injectionContext.map(c => ({ summaryId: c.summaryId, topicId: c.topicId }))
        : null,
    }
  };
}

function truncateToTokenBudget(messages, maxTokens) {
  let totalTokens = 0;
  const result = [];

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg.content);
    if (totalTokens + msgTokens > maxTokens) {
      const remaining = maxTokens - totalTokens;
      if (remaining > 100) {
        result.push({ ...msg, content: msg.content.slice(0, remaining * 4) + '\n[... truncated]' });
      }
      break;
    }
    result.push(msg);
    totalTokens += msgTokens;
  }

  return result;
}
