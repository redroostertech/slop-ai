/**
 * @fileoverview Scroll-to-Text-Fragment URL building — pure + unit-testable.
 *
 * Turns clipped passages (UNTRUSTED page text) into `#:~:text=…` directives so
 * Chrome natively scrolls to and highlights them on the real page.
 *
 * A clip often spans multiple lines / list items / sentences, and Chrome only
 * highlights a fragment when it finds an EXACT contiguous match — so a single
 * fragment for a whole multi-block selection usually fails. We therefore split a
 * clip into segments (newlines/list items → sentences) and emit one fragment per
 * segment, so each list item and sentence highlights independently.
 *
 * Safety: `-` and `,` are fragment delimiters and are percent-encoded out of the
 * text; everything goes through encodeURIComponent, so untrusted text can never
 * inject a second directive or break the URL structure.
 *
 * @module lib/text-fragment
 */

const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');
const MAX_FRAGMENTS = 24; // keep the URL sane even for a big multi-clip group

/** Split a clip into highlightable segments: lines/list items, then sentences. */
export function segments(raw) {
  return String(raw || '')
    .split(/\r?\n+/)                                  // paragraphs / list items
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))   // sentences within a line
    .map((s) => s.replace(/[ \t]+/g, ' ').trim())
    .filter((s) => s.split(' ').filter(Boolean).length >= 3); // skip 1-2 word bits (match too loosely)
}

/** One `text=…` directive for a single segment (start,end anchors for long ones). */
function oneFragment(seg) {
  const words = seg.split(' ');
  if (words.length <= 14 && seg.length <= 120) return `text=${enc(seg)}`;
  return `text=${enc(words.slice(0, 7).join(' '))},${enc(words.slice(-7).join(' '))}`;
}

/** All `text=…` directives for one clip (may be multi-line). */
export function fragmentsFor(raw) {
  return segments(raw).map(oneFragment).filter(Boolean);
}

/**
 * Build a URL that highlights every segment of one or more clips on the page.
 * Strips an existing hash; caps the fragment count; bare URL when nothing encodes.
 * @param {string} url
 * @param {string|string[]} clips  one clip's text, or several clips' texts
 * @returns {string}
 */
export function fragmentUrl(url, clips) {
  const list = Array.isArray(clips) ? clips : [clips];
  const frags = list.flatMap(fragmentsFor).slice(0, MAX_FRAGMENTS);
  const base = String(url || '').split('#')[0];
  return frags.length ? `${base}#:~:${frags.join('&')}` : String(url || '');
}
