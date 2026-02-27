/**
 * @fileoverview Multi-Provider AI Router for AI Context Bridge
 *
 * Routes AI inference requests through a priority-ordered chain of providers:
 * Lana AI -> OpenAI -> Claude -> Gemini
 *
 * Each provider has its own adapter that normalizes request/response formats.
 * Providers are stored in chrome.storage.local under the key `aiProviders`.
 *
 * @module lib/ai-router
 */

// ---------------------------------------------------------------------------
// Provider Type Defaults
// ---------------------------------------------------------------------------

const PROVIDER_DEFAULTS = {
  lana: {
    name: 'Lana AI',
    baseUrl: '',
    models: ['lana-default'],
    defaultModel: 'lana-default',
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4o-mini', 'gpt-4o'],
    defaultModel: 'gpt-4o-mini',
  },
  claude: {
    name: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-3-5-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: ['gemini-2.0-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.0-flash',
  },
};

// ---------------------------------------------------------------------------
// Provider Storage
// ---------------------------------------------------------------------------

/**
 * Get all configured providers, sorted by priority (lower = first).
 * On first run, migrates legacy openaiApiKey/openaiModel settings.
 * @returns {Promise<Array<Object>>}
 */
export async function getProviders() {
  const data = await chrome.storage.local.get(['aiProviders', 'openaiApiKey', 'openaiModel']);

  if (data.aiProviders && data.aiProviders.length > 0) {
    return data.aiProviders.sort((a, b) => a.priority - b.priority);
  }

  // Migration: convert legacy OpenAI settings to provider entry
  if (data.openaiApiKey) {
    const migrated = [{
      id: crypto.randomUUID(),
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: data.openaiApiKey,
      models: ['gpt-4o-mini', 'gpt-4o'],
      defaultModel: data.openaiModel || 'gpt-4o-mini',
      isEnabled: true,
      priority: 1,
      extra: {},
    }];
    await chrome.storage.local.set({ aiProviders: migrated });
    // Clean up legacy keys
    await chrome.storage.local.remove(['openaiApiKey', 'openaiModel']);
    return migrated;
  }

  return [];
}

/**
 * Save the full provider list.
 * @param {Array<Object>} providers
 * @returns {Promise<void>}
 */
export async function saveProviders(providers) {
  await chrome.storage.local.set({ aiProviders: providers });
}

/**
 * Get the highest-priority enabled provider.
 * @returns {Promise<Object|null>}
 */
export async function getActiveProvider() {
  const providers = await getProviders();
  return providers.find(p => p.isEnabled) || null;
}

/**
 * Check if at least one provider is enabled.
 * @returns {Promise<boolean>}
 */
export async function hasEnabledProvider() {
  const providers = await getProviders();
  return providers.some(p => p.isEnabled);
}

// ---------------------------------------------------------------------------
// Provider Adapters
// ---------------------------------------------------------------------------

/**
 * Lana AI adapter — OpenAI-compatible format with custom matter_id field.
 */
async function lanaAdapter(provider, messages, options) {
  const model = options.model || provider.defaultModel;
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2000,
  };

  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  if (provider.extra?.matterId) {
    body.matter_id = provider.extra.matterId;
  }

  const response = await fetch(`${provider.baseUrl}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Lana API error: ${response.status}`);
  }

  const result = await response.json();
  return {
    content: result.choices[0].message.content,
    providerId: provider.id,
    providerType: 'lana',
    model,
    usage: result.usage || null,
  };
}

/**
 * OpenAI adapter — standard chat completions API.
 */
async function openaiAdapter(provider, messages, options) {
  const model = options.model || provider.defaultModel;
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.maxTokens ?? 2000,
  };

  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
  }

  const result = await response.json();
  return {
    content: result.choices[0].message.content,
    providerId: provider.id,
    providerType: 'openai',
    model,
    usage: result.usage || null,
  };
}

/**
 * Claude adapter — Anthropic Messages API.
 * System prompt is a separate field, not a message.
 * No native JSON mode — uses prompt-based JSON instruction.
 */
async function claudeAdapter(provider, messages, options) {
  const model = options.model || provider.defaultModel;

  // Extract system message and convert remaining to Claude format
  let systemText = '';
  const claudeMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
    } else {
      claudeMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content,
      });
    }
  }

  // If JSON mode is requested, append instruction to system prompt
  if (options.jsonMode && systemText) {
    systemText += '\n\nIMPORTANT: You must respond with valid JSON only. No other text before or after the JSON.';
  }

  const body = {
    model,
    max_tokens: options.maxTokens ?? 2000,
    messages: claudeMessages,
  };

  if (systemText) {
    body.system = systemText;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${response.status}`);
  }

  const result = await response.json();
  const content = result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  return {
    content,
    providerId: provider.id,
    providerType: 'claude',
    model,
    usage: result.usage ? {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
    } : null,
  };
}

/**
 * Gemini adapter — Google Generative AI API.
 * Uses contents/parts format with 'model' role for assistant.
 */
async function geminiAdapter(provider, messages, options) {
  const model = options.model || provider.defaultModel;

  // Convert messages to Gemini format
  let systemInstruction = '';
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content;
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxTokens ?? 2000,
    },
  };

  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  if (options.jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const url = `${provider.baseUrl}/v1beta/models/${model}:generateContent?key=${provider.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const errMsg = err.error?.message || `Gemini API error: ${response.status}`;
    throw new Error(errMsg);
  }

  const result = await response.json();
  const content = result.candidates?.[0]?.content?.parts
    ?.map(p => p.text)
    .join('') || '';

  return {
    content,
    providerId: provider.id,
    providerType: 'gemini',
    model,
    usage: result.usageMetadata ? {
      prompt_tokens: result.usageMetadata.promptTokenCount || 0,
      completion_tokens: result.usageMetadata.candidatesTokenCount || 0,
      total_tokens: result.usageMetadata.totalTokenCount || 0,
    } : null,
  };
}

const ADAPTERS = {
  lana: lanaAdapter,
  openai: openaiAdapter,
  claude: claudeAdapter,
  gemini: geminiAdapter,
};

// ---------------------------------------------------------------------------
// Core Router
// ---------------------------------------------------------------------------

/**
 * Send a completion request through the provider chain.
 * Tries providers in priority order; on failure, falls back to the next.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} [options={}]
 * @param {number} [options.temperature] - Sampling temperature
 * @param {number} [options.maxTokens] - Max tokens to generate
 * @param {boolean} [options.jsonMode] - Request JSON output
 * @param {string} [options.model] - Override model for this request
 * @returns {Promise<{content: string, providerId: string, providerType: string, model: string, usage: Object|null}>}
 */
export async function complete(messages, options = {}) {
  const providers = await getProviders();
  const enabled = providers.filter(p => p.isEnabled);

  if (enabled.length === 0) {
    throw new Error('No AI providers configured. Add a provider in Settings.');
  }

  const errors = [];

  for (const provider of enabled) {
    const adapter = ADAPTERS[provider.type];
    if (!adapter) {
      errors.push({ provider: provider.name, error: `Unknown provider type: ${provider.type}` });
      continue;
    }

    try {
      const result = await adapter(provider, messages, options);
      return result;
    } catch (err) {
      console.warn(`[AI Router] ${provider.name} failed:`, err.message);
      errors.push({ provider: provider.name, error: err.message });
    }
  }

  // All providers failed
  const details = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
  throw new Error(`All AI providers failed. ${details}`);
}

// ---------------------------------------------------------------------------
// Connection Test
// ---------------------------------------------------------------------------

/**
 * Test connectivity to a provider.
 * Sends a minimal request and measures latency.
 *
 * @param {Object} config - Provider config object
 * @returns {Promise<{ok: boolean, error?: string, latencyMs: number}>}
 */
export async function testProvider(config) {
  const adapter = ADAPTERS[config.type];
  if (!adapter) {
    return { ok: false, error: `Unknown provider type: ${config.type}`, latencyMs: 0 };
  }

  const testMessages = [
    { role: 'system', content: 'Respond with exactly: OK' },
    { role: 'user', content: 'Test' },
  ];

  const start = performance.now();
  try {
    await adapter(config, testMessages, { temperature: 0, maxTokens: 10 });
    const latencyMs = Math.round(performance.now() - start);
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return { ok: false, error: err.message, latencyMs };
  }
}

// ---------------------------------------------------------------------------
// Utility Exports
// ---------------------------------------------------------------------------

export { PROVIDER_DEFAULTS };
