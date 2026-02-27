/**
 * Injection service for AI Context Bridge.
 * Formats knowledge for target AI systems and handles insertion into chat inputs.
 */

/**
 * Format a knowledge item for injection into a specific AI system.
 * Each system gets optimized formatting for best comprehension.
 *
 * @param {Object} summary - The summary object to inject
 * @param {Object} topic - Parent topic object (may be null)
 * @param {string} targetSystem - 'chatgpt'|'claude'|'gemini'|'copilot'
 * @returns {string} Formatted text ready to paste
 */
export function formatForInjection(summary, topic, targetSystem) {
  if (!summary) return '';

  switch (targetSystem) {
    case 'claude':
      return formatForClaude(summary, topic);
    case 'chatgpt':
      return formatForChatGPT(summary, topic);
    case 'gemini':
      return formatForGemini(summary, topic);
    case 'copilot':
      return formatForCopilot(summary, topic);
    default:
      return formatForChatGPT(summary, topic);
  }
}

/**
 * Format multiple knowledge items into a combined context block.
 *
 * @param {Array<{summary: Object, topic: Object|null}>} items
 * @param {string} targetSystem
 * @returns {string}
 */
export function formatBatchForInjection(items, targetSystem) {
  if (!items || items.length === 0) return '';

  if (targetSystem === 'claude') {
    let output = '<context>\n';
    output += 'The following knowledge was gathered from previous AI conversations and is provided as relevant context.\n\n';

    for (const { summary, topic } of items) {
      output += formatClaudeSection(summary, topic);
      output += '\n---\n\n';
    }

    output += '</context>\n\n';
    return output;
  }

  // Markdown-based systems
  let output = '## Relevant Context from Knowledge Base\n\n';
  output += '_The following was gathered from previous AI conversations._\n\n';

  for (const { summary, topic } of items) {
    output += formatMarkdownSection(summary, topic);
    output += '\n---\n\n';
  }

  return output;
}

// ---------------------------------------------------------------------------
// Format helpers for each AI system
// ---------------------------------------------------------------------------

function formatForClaude(summary, topic) {
  let output = '<context>\n';
  output += formatClaudeSection(summary, topic);
  output += '</context>\n\n';
  return output;
}

function formatClaudeSection(summary, topic) {
  let section = '';
  const topicName = topic?.name || 'General';

  section += `Topic: ${topicName}\n`;
  section += `Title: ${summary.title}\n\n`;
  section += `${summary.summary}\n\n`;

  if (summary.keyInsights && summary.keyInsights.length > 0) {
    section += 'Key Insights:\n';
    for (const insight of summary.keyInsights) {
      section += `- ${insight}\n`;
    }
    section += '\n';
  }

  if (summary.decisions && summary.decisions.length > 0) {
    section += 'Decisions Made:\n';
    for (const decision of summary.decisions) {
      section += `- ${decision}\n`;
    }
    section += '\n';
  }

  if (summary.codeSnippets && summary.codeSnippets.length > 0) {
    section += 'Code Reference:\n';
    for (const snippet of summary.codeSnippets) {
      if (snippet.description) {
        section += `${snippet.description}:\n`;
      }
      section += `\`\`\`${snippet.language || ''}\n${snippet.code}\n\`\`\`\n\n`;
    }
  }

  return section;
}

function formatForChatGPT(summary, topic) {
  return formatMarkdownSection(summary, topic);
}

function formatForGemini(summary, topic) {
  return formatMarkdownSection(summary, topic);
}

function formatForCopilot(summary, topic) {
  return formatMarkdownSection(summary, topic);
}

function formatMarkdownSection(summary, topic) {
  let output = '';
  const topicName = topic?.name || 'General';

  output += `### ${topicName}: ${summary.title}\n\n`;
  output += `${summary.summary}\n\n`;

  if (summary.keyInsights && summary.keyInsights.length > 0) {
    output += '**Key Insights:**\n';
    for (const insight of summary.keyInsights) {
      output += `- ${insight}\n`;
    }
    output += '\n';
  }

  if (summary.decisions && summary.decisions.length > 0) {
    output += '**Decisions:**\n';
    for (const decision of summary.decisions) {
      output += `- ${decision}\n`;
    }
    output += '\n';
  }

  if (summary.codeSnippets && summary.codeSnippets.length > 0) {
    output += '**Code Reference:**\n';
    for (const snippet of summary.codeSnippets) {
      if (snippet.description) {
        output += `*${snippet.description}*\n`;
      }
      output += `\`\`\`${snippet.language || ''}\n${snippet.code}\n\`\`\`\n\n`;
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Conversation formatting for injection
// ---------------------------------------------------------------------------

/**
 * Format a raw conversation for injection into a specific AI system.
 * Uses the last 6 messages to keep the context manageable.
 *
 * @param {Object} conversation - The conversation object
 * @param {string} targetSystem - 'chatgpt'|'claude'|'gemini'|'copilot'
 * @returns {string} Formatted text ready to paste
 */
export function formatConversationForInjection(conversation, targetSystem) {
  if (!conversation) return '';

  const messages = (conversation.messages || []).slice(-6);
  const title = conversation.title || 'Untitled Conversation';
  const source = conversation.source || 'unknown';

  if (targetSystem === 'claude') {
    let output = '<context>\n';
    output += `Previous conversation from ${source}: ${title}\n\n`;
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'Human';
      output += `${role}: ${msg.content}\n\n`;
    }
    output += '</context>\n\n';
    return output;
  }

  // Markdown-based systems (ChatGPT, Gemini, Copilot)
  let output = `### Previous Conversation: ${title}\n`;
  output += `_Source: ${source}_\n\n`;
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? '**Assistant**' : '**User**';
    output += `${role}: ${msg.content}\n\n`;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Chat input detection and text insertion
// ---------------------------------------------------------------------------

/**
 * Selector configurations for each AI site's chat input.
 * Ordered by specificity (most specific/reliable first).
 */
const INPUT_SELECTORS = {
  chatgpt: [
    '#prompt-textarea',
    'textarea[data-id]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'form textarea'
  ],
  claude: [
    'div.ProseMirror[contenteditable="true"]',
    'fieldset textarea',
    'div[contenteditable="true"][data-placeholder]',
    'div.is-editor-empty[contenteditable="true"]'
  ],
  gemini: [
    '.ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt"]'
  ],
  copilot: [
    'textarea#searchbox',
    '#userInput',
    'textarea[placeholder*="message"]',
    '#searchbox'
  ]
};

/**
 * Get the chat input element for the current AI site.
 *
 * @param {string} site - 'chatgpt'|'claude'|'gemini'|'copilot'
 * @returns {Element|null}
 */
export function getChatInput(site) {
  const selectors = INPUT_SELECTORS[site];
  if (!selectors) return null;

  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (e) {
      // Invalid selector, skip
      continue;
    }
  }

  return null;
}

/**
 * Detect which AI site we are on based on the current URL.
 *
 * @returns {string|null} 'chatgpt'|'claude'|'gemini'|'copilot' or null
 */
export function detectCurrentSite() {
  const hostname = window.location.hostname;

  if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) {
    return 'chatgpt';
  }
  if (hostname.includes('claude.ai')) {
    return 'claude';
  }
  if (hostname.includes('gemini.google.com')) {
    return 'gemini';
  }
  if (hostname.includes('copilot.microsoft.com')) {
    return 'copilot';
  }

  return null;
}

/**
 * Insert text into the chat input of the current AI site.
 * Handles both textarea and contenteditable (ProseMirror/Quill) elements.
 * Triggers the appropriate synthetic events so React/ProseMirror/Quill
 * recognize the text change.
 *
 * @param {Element} input - The input element
 * @param {string} text - Text to insert
 */
export function insertIntoChatInput(input, text) {
  if (!input || !text) return;

  const tagName = input.tagName.toLowerCase();
  const isContentEditable = input.getAttribute('contenteditable') === 'true';

  if (tagName === 'textarea' || tagName === 'input') {
    insertIntoTextarea(input, text);
  } else if (isContentEditable) {
    insertIntoContentEditable(input, text);
  }
}

/**
 * Insert text into a standard textarea element.
 * Uses native input setter to bypass React's synthetic event system,
 * then dispatches input events so React state updates.
 *
 * @param {HTMLTextAreaElement} textarea
 * @param {string} text
 */
function insertIntoTextarea(textarea, text) {
  // Focus the textarea
  textarea.focus();

  // Get existing value
  const existing = textarea.value;
  const prefix = existing.length > 0 ? existing + '\n\n' : '';
  const newValue = prefix + text;

  // Use the native setter to bypass React's controlled input
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, 'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(textarea, newValue);
  } else {
    textarea.value = newValue;
  }

  // Dispatch events that React and other frameworks listen to
  textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

  // Also dispatch a more specific InputEvent for frameworks that need it
  try {
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    }));
  } catch (e) {
    // InputEvent constructor might not support all options in every browser
  }

  // Move cursor to end
  textarea.selectionStart = textarea.selectionEnd = newValue.length;

  // Trigger auto-resize if the textarea has auto-grow behavior
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

/**
 * Insert text into a contenteditable element (ProseMirror, Quill, etc.).
 * Uses multiple strategies for maximum compatibility:
 * 1. execCommand (deprecated but widely supported)
 * 2. Manual DOM insertion with synthetic events
 *
 * @param {HTMLElement} element
 * @param {string} text
 */
function insertIntoContentEditable(element, text) {
  element.focus();

  // Determine existing content
  const existingText = element.textContent || '';
  const separator = existingText.trim().length > 0 ? '\n\n' : '';

  // Move selection to end
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false); // collapse to end
  selection.removeAllRanges();
  selection.addRange(range);

  // Strategy 1: Use execCommand (works with ProseMirror's input handling)
  const fullText = separator + text;
  const execResult = document.execCommand('insertText', false, fullText);

  if (!execResult) {
    // Strategy 2: Manual DOM insertion
    // For ProseMirror, we need to work with its paragraph structure
    const lines = fullText.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // Insert a line break
        const br = document.createElement('br');
        range.insertNode(br);
        range.setStartAfter(br);
        range.collapse(true);
      }

      if (lines[i].length > 0) {
        const textNode = document.createTextNode(lines[i]);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
      }
    }

    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Dispatch events for framework reactivity
  element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

  // For ProseMirror specifically, also dispatch keydown/keyup to trigger its handlers
  element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
  element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));

  // Dispatch a compositionend event as a fallback for some editors
  try {
    element.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: text
    }));
  } catch (e) {
    // CompositionEvent may not be available
  }
}
