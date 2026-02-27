export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export function formatNumber(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US');
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_').slice(0, 80);
}

export function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function convToMarkdown(conv) {
  let md = `# ${conv.title}\n`;
  if (conv.createdAt) {
    const date = new Date(conv.createdAt).toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
    md += `**Date:** ${date}\n`;
  }
  md += `**Source:** ${conv.source}\n`;
  md += '\n---\n\n';

  (conv.messages || []).forEach(msg => {
    const label = msg.role === 'user' ? 'User' : 'Assistant';
    md += `**${label}:**\n\n${msg.content}\n\n---\n\n`;
  });

  return md;
}

export function generateId() {
  return crypto.randomUUID();
}

export function sourceLabel(source) {
  const labels = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    gemini: 'Gemini',
    copilot: 'Copilot'
  };
  return labels[source] || source;
}

export function sourceColor(source) {
  const style = getComputedStyle(document.documentElement);
  const varName = `--color-${source}`;
  const fromToken = style.getPropertyValue(varName).trim();
  return fromToken || { chatgpt: '#10a37f', claude: '#d97706', gemini: '#2563eb', copilot: '#7c3aed' }[source] || '#6b7280';
}

export function formatShorthand(n) {
  if (n == null || isNaN(n)) return '0';
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const val = n / 1000;
    return (val < 10 ? val.toFixed(1) : Math.round(val)) + 'K';
  }
  if (n < 1_000_000_000) {
    const val = n / 1_000_000;
    return (val < 10 ? val.toFixed(1) : Math.round(val)) + 'M';
  }
  const val = n / 1_000_000_000;
  return (val < 10 ? val.toFixed(1) : Math.round(val)) + 'B';
}

export function shorthandSpan(n) {
  const short = formatShorthand(n);
  const full = formatNumber(n);
  if (short === full || short === String(n)) return `<span>${short}</span>`;
  return `<span class="shorthand" title="${full}">${short}</span>`;
}

export function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
