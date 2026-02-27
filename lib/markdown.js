/**
 * Lightweight Markdown Renderer — lib/markdown.js
 *
 * Converts markdown text to safe HTML. Escapes raw HTML first (XSS prevention),
 * then applies markdown transformations.
 *
 * Supports: bold, italic, headers, fenced code blocks, inline code, horizontal
 * rules, unordered/ordered lists, blockquotes, line breaks.
 */

import { escapeHtml } from './utils.js';

/**
 * Render markdown text to HTML.
 *
 * @param {string} text — raw markdown string
 * @returns {string} — safe HTML string
 */
export function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML first to prevent XSS
  let html = escapeHtml(text);

  // Extract fenced code blocks before processing anything else
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code-block"><code class="md-lang-${lang || 'text'}">${code.trimEnd()}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // Inline code (must come before other inline transforms)
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // Headers (# to ####)
  html = html.replace(/^#### (.+)$/gm, '<h4 class="md-h4">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="md-h1">$1</h1>');

  // Horizontal rules
  html = html.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="md-hr">');

  // Bold and italic (order matters: bold first)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Blockquotes (consecutive > lines grouped)
  html = html.replace(/^(?:&gt;) (.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');
  // Merge adjacent blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote class="md-blockquote">/g, '\n');

  // Unordered lists (- or * at start of line)
  html = html.replace(/^(?:[-*]) (.+)$/gm, '<li class="md-li">$1</li>');
  html = html.replace(/((?:<li class="md-li">.*<\/li>\n?)+)/g, '<ul class="md-ul">$1</ul>');

  // Ordered lists (1. 2. etc)
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-li">$1</li>');
  // Wrap consecutive <li> not already in <ul> into <ol>
  html = html.replace(/(?:^|(?<=<\/ul>|<\/ol>|\n))(<li class="md-li">(?:.*<\/li>\n?)+)/gm, (match) => {
    // Only wrap if not already inside a <ul>
    if (html.indexOf('<ul class="md-ul">' + match) === -1) {
      return `<ol class="md-ol">${match}</ol>`;
    }
    return match;
  });

  // Paragraphs: double newlines → paragraph breaks
  html = html.replace(/\n{2,}/g, '</p><p class="md-p">');

  // Single newlines → <br> (but not inside block elements)
  html = html.replace(/(?<!\>)\n(?!\<)/g, '<br>');

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    html = html.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }

  // Wrap in paragraph if content exists and doesn't start with a block element
  if (html && !/^\s*<(?:h[1-4]|pre|ul|ol|blockquote|hr|p)/.test(html)) {
    html = `<p class="md-p">${html}</p>`;
  }

  // Clean up empty paragraphs
  html = html.replace(/<p class="md-p">\s*<\/p>/g, '');

  return html;
}

/**
 * Render inline markdown only (bold, italic, code — no blocks).
 * Useful for list items and short text snippets.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderInlineMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  return html;
}
