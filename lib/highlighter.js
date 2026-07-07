/**
 * @fileoverview In-page clip highlighter — matches clipped text on a page
 * REGARDLESS of HTML structure and paints it with the native CSS Custom Highlight
 * API (no DOM mutation, no third-party deps, no network).
 *
 * The matching is structure-agnostic because both the page and the clip are
 * flattened to a normalized string (whitespace collapsed, block boundaries →
 * single space, lowercased) before comparison — so a clip that spans several
 * elements (list items, paragraphs) still matches. `flatten`/`locate` are pure
 * and unit-tested; `runHighlight` is the page-context runner (injected via
 * chrome.scripting.executeScript → dynamic import of this web-accessible module).
 *
 * @module lib/highlighter
 */

export const HIGHLIGHT_NAME = 'lana-clip';

/** Normalize for matching: lowercase + collapse whitespace + trim. */
export function normalize(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Flatten segments into a normalized string + a map from each flat-char index to
 * {seg, off} (offset within that segment's ORIGINAL text). Whitespace collapses to
 * a single space; a block boundary forces a separator so adjacent blocks (e.g. list
 * items with no whitespace text node between them) don't run together.
 *
 * @param {Array<{text: string, block?: boolean}>} segments
 * @returns {{flat: string, map: Array<{seg: number, off: number}>}}
 */
export function flatten(segments) {
  let flat = '';
  const map = [];
  let needSpace = false;
  for (let s = 0; s < segments.length; s++) {
    const text = String(segments[s].text || '');
    if (segments[s].block) needSpace = flat.length > 0;
    for (let o = 0; o < text.length; o++) {
      const ch = text[o];
      if (/\s/.test(ch)) { needSpace = flat.length > 0; continue; }
      if (needSpace) { flat += ' '; map.push({ seg: s, off: o }); needSpace = false; }
      flat += ch.toLowerCase();
      map.push({ seg: s, off: o });
    }
  }
  return { flat, map };
}

/**
 * Locate a query in the flattened page. Exact normalized match first; if that
 * fails, a fuzzy fallback anchors on the query's first ~8 words (partial
 * highlight). Returns segment-relative range coords, or null.
 *
 * @returns {{startSeg,startOff,endSeg,endOff}|null}
 */
export function locate(flat, map, query) {
  const q = normalize(query);
  if (q.length < 3) return null;
  const range = (i, len) => {
    const a = map[i], b = map[i + len - 1];
    if (!a || !b) return null;
    return { startSeg: a.seg, startOff: a.off, endSeg: b.seg, endOff: b.off + 1 };
  };
  let i = flat.indexOf(q);
  if (i >= 0) return range(i, q.length);
  // Fuzzy: anchor on the first 8 words if the whole passage moved/changed.
  const head = q.split(' ').slice(0, 8).join(' ');
  if (head.length >= 12) {
    i = flat.indexOf(head);
    if (i >= 0) return range(i, head.length);
  }
  return null;
}

/** Locate several queries; returns the ranges that matched. */
export function locateAll(flat, map, queries) {
  return (queries || []).map((q) => locate(flat, map, q)).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Page-context runner (uses document + CSS Custom Highlight API).      *
 * Injected into the target tab; never runs in node/tests.             *
 * ------------------------------------------------------------------ */

const BLOCK_TAGS = /^(P|DIV|LI|UL|OL|TR|TD|TH|SECTION|ARTICLE|H[1-6]|BLOCKQUOTE|PRE|BR|HEADER|FOOTER|MAIN|ASIDE|FIGURE|FIGCAPTION|DD|DT|DL|TABLE|NAV|FORM|HR)$/;

/**
 * Highlight each clip passage on the current page. Returns the number of matches
 * painted (0 = nothing matched or the API is unavailable → caller can fall back).
 * @param {string[]} clipTexts
 * @returns {number}
 */
export function runHighlight(clipTexts) {
  try {
    if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const tag = n.parentElement && n.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    const segs = [];
    let prevBlock = null;
    let node;
    while ((node = walker.nextNode())) {
      let a = node.parentElement, blockAnc = null;
      while (a) { if (BLOCK_TAGS.test(a.tagName)) { blockAnc = a; break; } a = a.parentElement; }
      nodes.push(node);
      segs.push({ text: node.nodeValue, block: blockAnc !== prevBlock });
      prevBlock = blockAnc;
    }
    const { flat, map } = flatten(segs);
    const ranges = [];
    for (const text of (clipTexts || [])) {
      const loc = locate(flat, map, text);
      if (!loc) continue;
      try {
        const r = document.createRange();
        r.setStart(nodes[loc.startSeg], Math.min(loc.startOff, nodes[loc.startSeg].length));
        r.setEnd(nodes[loc.endSeg], Math.min(loc.endOff, nodes[loc.endSeg].length));
        if (!r.collapsed) ranges.push(r);
      } catch { /* skip an un-buildable range */ }
    }
    if (!ranges.length) return 0;
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
    if (!document.getElementById('lana-hl-style')) {
      const st = document.createElement('style');
      st.id = 'lana-hl-style';
      st.textContent = `::highlight(${HIGHLIGHT_NAME}){ background: rgba(48,103,255,0.30); color: inherit; }`;
      (document.head || document.documentElement).appendChild(st);
    }
    try {
      const el = ranges[0].startContainer.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch { /* best-effort scroll */ }
    return ranges.length;
  } catch { return 0; }
}
