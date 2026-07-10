// Fallback spelling suggestions for when the OS spellchecker returns none.
// On macOS, Electron delegates spellcheck to the system; for badly-mangled words it often
// hands back an empty suggestion list. We mine macOS's built-in word list for near-matches so
// the right-click menu almost always has something to click. No dependency — /usr/share/dict/words
// is a plain newline-delimited file that ships with the OS.

import { readFileSync } from 'fs';

/** Levenshtein edit distance, bounded: returns `max + 1` as soon as it's provably over `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Up to `limit` dictionary words within edit distance 2 of `word`, best first.
 * ponytail: first-letter + length prefilter keeps this fast (a few ms over ~200k words); it
 * misses misspellings whose first letter is wrong — fine, those are rare and the OS usually
 * catches them. Preserves the misspelling's leading capitalization.
 */
export function spellSuggest(word: string, dict: string[], limit = 5): string[] {
  const w = word.toLowerCase();
  if (w.length < 2) return [];
  const first = w[0];
  const out: { word: string; d: number }[] = [];
  for (const dw of dict) {
    if (dw[0] !== first || Math.abs(dw.length - w.length) > 2) continue;
    const d = editDistance(w, dw, 2);
    if (d <= 2) out.push({ word: dw, d });
  }
  out.sort((a, b) => a.d - b.d || a.word.length - b.word.length);
  const cap = word[0] !== word[0].toLowerCase();
  return out.slice(0, limit).map((c) => (cap ? c.word[0].toUpperCase() + c.word.slice(1) : c.word));
}

let cached: string[] | null = null;
/** The system word list, lowercased and stripped of proper nouns. Empty if the file is absent. */
export function systemDict(): string[] {
  if (cached) return cached;
  try {
    cached = readFileSync('/usr/share/dict/words', 'utf8')
      .split('\n')
      .filter((w) => w.length > 1 && !/[^a-z]/.test(w)); // lowercase-only → drops proper nouns/punctuation
  } catch {
    cached = [];
  }
  return cached;
}
