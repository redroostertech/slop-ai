/**
 * @fileoverview Scroll-to-Text-Fragment URL building — pure + unit-testable.
 *
 * Turns clipped passages (UNTRUSTED page text) into a `#:~:text=…` directive so
 * Chrome natively scrolls to and highlights them on the real page. `-` and `,`
 * are fragment delimiters, so they're percent-encoded out of the matched text;
 * everything goes through encodeURIComponent, so the result is always a safe URL
 * fragment (no injection into the URL structure).
 *
 * @module lib/text-fragment
 */

const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');

/**
 * A single `text=…` directive for one passage. Long passages are anchored by
 * their first + last few words (textStart,textEnd) to stay short and robust.
 * @param {string} raw
 * @returns {string} e.g. `text=hello%20world` or `text=first%20six,last%20six`
 */
export function textFragment(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const words = t.split(' ');
  if (words.length <= 12 && t.length <= 100) return `text=${enc(t)}`;
  return `text=${enc(words.slice(0, 6).join(' '))},${enc(words.slice(-6).join(' '))}`;
}

/**
 * Build a full URL that highlights one or more passages on the page. Strips any
 * existing hash on the base URL. Returns the bare URL when no passage encodes.
 * @param {string} url
 * @param {string|string[]} texts
 * @returns {string}
 */
export function fragmentUrl(url, texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const frags = list.map(textFragment).filter(Boolean);
  const base = String(url || '').split('#')[0];
  return frags.length ? `${base}#:~:${frags.join('&')}` : String(url || '');
}
