import { normalizeGlossaryForm } from "@emend/contract";

// The matcher of a doc (Markdown through docGlossary, HTML through the bridge's port). The writeup keeps the
// regex matcher in terms.ts, which stays the reference: for every input the marks are the same.
//
// A regex alternation of up to 450 forms costs, at each position, up to the summed length of all forms, and
// compiling it can take seconds. This matcher walks a prefix tree of the forms instead. A position costs the
// characters the walk compares, including every whitespace character a space in a form consumes; one step
// for each form that ends on the way, with its suffix check and, for an acronym, its exact check; and, once
// per text node, a split into graphemes when a candidate has an uncertain edge. Nothing is compiled, and
// every step is counted against the budget as it is taken.
//
// Rules, the same as the regex path's (terms.ts):
// - A match starts only where the code point before is not a letter, mark, digit or _.
// - Forms are NFC with whitespace runs collapsed; a space in a form matches one or more `\s` characters.
// - Case is ignored except for acronyms (no lowercase letter, at least two uppercase letters).
// - Trailing es or s is allowed when no word character follows it, tried in that order, then nothing.
// - The first form in sorted order (longest first, ties in entry order) that matches and passes `rangeAt`
//   wins; a form that matches but fails `rangeAt` is skipped, with no other suffix tried for it.

// Characters the rule lc(uc(x)) puts in a different class than `/x/iu` does. Found by comparing every
// pair of cased code points with the regex; the fold test in doc-terms.test.ts re-proves the whole table.
const foldExceptions = new Map<number, number>([
  [0x131, 0x131],
  [0x1fd3, 0x390],
  [0x1fe3, 0x3b0],
  [0xfb05, 0xfb06],
]);
const oneCodePoint = (text: string) => {
  const code = text.codePointAt(0) ?? 0;
  return text.length === (code > 0xffff ? 2 : 1) ? code : undefined;
};
/** Equal folds for two code points exactly when `/a/iu` matches b. */
export function foldCodePoint(code: number): number {
  const exception = foldExceptions.get(code);
  if (exception !== undefined) return exception;
  const text = String.fromCodePoint(code);
  const upper = oneCodePoint(text.toUpperCase());
  if (upper !== undefined) {
    const lower = oneCodePoint(String.fromCodePoint(upper).toLowerCase());
    if (lower !== undefined) return lower;
  }
  return oneCodePoint(text.toLowerCase()) ?? code;
}

/** JavaScript's `\s`, on one UTF-16 code unit. */
export const isSpaceUnit = (unit: number) =>
  unit === 32 ||
  (unit >= 9 && unit <= 13) ||
  unit === 0xa0 ||
  unit === 0x1680 ||
  (unit >= 0x2000 && unit <= 0x200a) ||
  unit === 0x2028 ||
  unit === 0x2029 ||
  unit === 0x202f ||
  unit === 0x205f ||
  unit === 0x3000 ||
  unit === 0xfeff;
const wordPattern = /^[\p{L}\p{M}\p{N}_]$/u;

type Form = { entry: number; rank: number; codes: number[]; acronym: boolean };
type Node = { next: Map<number, Node>; space?: Node; forms?: Form[] };
type Range = { start: number; finish: number };

export type DocTermMatcher = {
  trie: true;
  count: number;
  remaining: number;
  forms: Form[];
  root: Node;
  // The caches and the computing functions behind them. Building the tree fills `folds` (not `words`) for the
  // forms' own characters without a charge; the scan charges DOC_TERM_LOOKUP_STEPS for each code point it
  // finds missing in either cache, so a form's characters cost nothing to fold but the first word lookup of
  // each one is charged.
  folds: Map<number, number>;
  words: Map<number, boolean>;
  fold: (code: number) => number;
  word: (code: number) => boolean;
};

/** Steps charged per UTF-16 unit of a text node that must be split into graphemes (measured, see scanDocTerms). */
export const DOC_TERM_SEGMENT_STEPS = 32;
/** Steps charged once per text node that is split into graphemes, whatever its length (measured, see scanDocTerms). */
export const DOC_TERM_SEGMENT_FIXED_STEPS = 256;

const markRun = /\p{M}+/gu;
/**
 * True when the text has more than 30 combining marks (`\p{M}`) in a row, which Unicode's Stream-Safe Text
 * Format (UAX #15) does not allow and real text never has. `String.prototype.normalize` reorders marks by
 * combining class, and on a longer run of marks in the wrong order its time grows with the square of the
 * run (80,000 units took 2.4 s), so a doc path checks this first and treats such text as unmarkable.
 * `\p{M}` covers every non-starter: for every code point c that is not `\p{M}`, ("ͅ" + c) in NFD still
 * starts with U+0345, the mark of the highest combining class (the test in doc-terms.test.ts checks all of
 * Unicode). The check reads each code point once.
 */
export function longMarkRun(text: string) {
  markRun.lastIndex = 0;
  for (let match = markRun.exec(text); match; match = markRun.exec(text)) {
    const run = match[0];
    if (run.length <= 30) continue;
    // Code points, not units: a mark outside the BMP takes two.
    let count = 0;
    for (let index = 0; index < run.length; index += (run.codePointAt(index) ?? 0) > 0xffff ? 2 : 1)
      if (++count > 30) return true;
  }
  return false;
}
/** Steps charged the first time a code point is folded, and the first time it is classified as a word character. */
export const DOC_TERM_LOOKUP_STEPS = 32;

/**
 * True when the text has a grapheme cluster boundary at `index` for certain, without segmenting: at either
 * end, and between two ASCII code units except CR LF (UAX #29: GB1, GB2, GB3 to GB5; no ASCII character is
 * Extend, ZWJ, SpacingMark, Prepend, Regional_Indicator, Hangul or Extended_Pictographic).
 */
export function certainBoundary(view: string, index: number) {
  if (index <= 0 || index >= view.length) return true;
  const before = view.charCodeAt(index - 1);
  const after = view.charCodeAt(index);
  return before < 0x80 && after < 0x80 && !(before === 13 && after === 10);
}

export function docTermMatcher(entries: { term: string; aliases?: string[] }[], budget: number): DocTermMatcher {
  const folds = new Map<number, number>();
  const words = new Map<number, boolean>();
  const fold = (code: number) => {
    let folded = folds.get(code);
    if (folded === undefined) {
      folded = foldCodePoint(code);
      folds.set(code, folded);
    }
    return folded;
  };
  const word = (code: number) => {
    let is = words.get(code);
    if (is === undefined) {
      is = wordPattern.test(String.fromCodePoint(code));
      words.set(code, is);
    }
    return is;
  };
  const forms: Form[] = entries
    .flatMap((entry, index) =>
      [entry.term, ...(entry.aliases ?? [])].map((form) => ({ form: normalizeGlossaryForm(form), entry: index })),
    )
    .filter(({ form }) => form.length > 0)
    .sort((a, b) => b.form.length - a.form.length)
    .map(({ form, entry }, rank) => ({
      entry,
      rank,
      codes: Array.from(form, (char) => char.codePointAt(0) ?? 0),
      acronym: !/\p{Ll}/u.test(form) && (form.match(/\p{Lu}/gu)?.length ?? 0) >= 2,
    }));
  const root: Node = { next: new Map() };
  for (const form of forms) {
    let node = root;
    for (const code of form.codes) {
      if (code === 32) node = node.space ??= { next: new Map() };
      else {
        const key = fold(code);
        let child = node.next.get(key);
        if (!child) {
          child = { next: new Map() };
          node.next.set(key, child);
        }
        node = child;
      }
    }
    node.forms ??= [];
    node.forms.push(form);
  }
  return { trie: true, count: entries.length, remaining: budget, forms, root, folds, words, fold, word };
}

/**
 * Marks the first use of each entry in `view`, left to right. `rangeAt` is markTerms' own check of a
 * candidate range; `mark` takes each new mark and returns true when no entry is left.
 *
 * The charges, all in steps (the same list in docs/api.md and in the bridge's copy):
 * - 1 per code point compared (each tree lookup), including the failing one;
 * - 1 per whitespace character a space of a form consumes;
 * - 1 per start position tried, also one the word-boundary rule refuses;
 * - 1 per form that ends on the way, and 1 per code point of the s/es suffix check;
 * - 1 per code point of an acronym's exact check;
 * - DOC_TERM_LOOKUP_STEPS the first time a code point is folded and the first time it is classified as a
 *   word character (once per matcher; the forms' own characters are folded, so cached, when the tree is
 *   built, but not classified);
 * - DOC_TERM_SEGMENT_FIXED_STEPS plus DOC_TERM_SEGMENT_STEPS per UTF-16 unit of the text node when it must be
 *   split into graphemes. That happens once per node, when a candidate range has an edge that is not
 *   certainBoundary (ordinary ASCII text never needs it), or at the start when `segmented` says the caller
 *   already split the node.
 * Returns false when a step did not fit the budget: the budget is then spent, and the caller drops the
 * marks of this text node. `segment()` splits the node for `rangeAt`; until it is called `rangeAt` may
 * treat every certainBoundary index as a boundary.
 *
 * Measured with standalone scripts on this machine (median of five runs), 10,000,000 steps take about 0.25 s
 * or less on every shape tried: the hostile 450-form shapes, 450 forms on one tree node (the slowest),
 * refused acronyms, 150,000 tiny text nodes that each need a split, a budget spent through segmentation
 * alone and one spent through first-seen lookups alone. Ordinary English prose costs about 1.2 to 2 steps per
 * character (1.2 when few words start a term, about 1.9 against 50 terms made of common words), so the budget
 * covers about 5,000,000 to 8,000,000 characters of it. Non-ASCII prose in paragraphs of about 1,000
 * characters that each hold a candidate with a non-ASCII edge costs about 33 steps per character (about
 * 300,000 characters). Not counted, each linear in the text: building the tree (3 to 6 ms for 450 forms), the
 * check for a run of more than 30 combining marks (about 20 ns per byte on one two-byte mark after each ASCII
 * character, the most matches per byte: 21 ms for a 1 MiB doc and 0.17 s for 8 MiB) and the NFC normalization
 * of each text node. The 30-mark rule keeps every reordered run to at most 63 non-starters (3 from a starter
 * plus 2 from each of 30 marks), so the cost stays linear. An input built to need the most reordering
 * (U+1F82, then 13 x U+0344, 9 x U+0F75 and 8 x U+0F73, repeated) takes about 55 ns per byte: 58 ms and
 * 0.46 s. A text node with a longer run of marks gets no marks.
 */
export function scanDocTerms(
  matcher: DocTermMatcher,
  view: string,
  rangeAt: (index: number, length: number) => Range | undefined,
  seen: Set<number>,
  mark: (entry: number, range: Range) => boolean,
  segment: () => void,
  segmented: boolean,
): boolean {
  const { root, folds, words } = matcher;
  const size = view.length;
  const foldE = matcher.fold(101);
  const foldS = matcher.fold(115);
  let left = matcher.remaining;
  // The first use of a code point costs steps; later uses read the cache.
  const fold = (code: number) => {
    const cached = folds.get(code);
    if (cached !== undefined) return cached;
    left -= DOC_TERM_LOOKUP_STEPS;
    return matcher.fold(code);
  };
  const word = (code: number) => {
    const cached = words.get(code);
    if (cached !== undefined) return cached;
    left -= DOC_TERM_LOOKUP_STEPS;
    return matcher.word(code);
  };
  // A candidate's grapheme check. Segmenting the node is charged once; a range whose edges are certain
  // boundaries needs no segmentation.
  const accept = (start: number, finish: number) => {
    if (!segmented && !(certainBoundary(view, start) && certainBoundary(view, finish))) {
      left -= DOC_TERM_SEGMENT_FIXED_STEPS + DOC_TERM_SEGMENT_STEPS * size;
      if (left < 0) return;
      segment();
      segmented = true;
    }
    return rangeAt(start, finish - start);
  };
  if (segmented) left -= DOC_TERM_SEGMENT_FIXED_STEPS + DOC_TERM_SEGMENT_STEPS * size;

  const wordBefore = (index: number) => {
    if (index <= 0) return false;
    let code = view.charCodeAt(index - 1);
    if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
      const high = view.charCodeAt(index - 2);
      if (high >= 0xd800 && high <= 0xdbff) code = (high - 0xd800) * 0x400 + (code - 0xdc00) + 0x10000;
    }
    return word(code);
  };
  const wordAt = (index: number) => index < size && word(view.codePointAt(index) ?? 0);

  // Where the form, taken exactly (an acronym), ends from `start`, or -1.
  const exactEnd = (form: Form, start: number) => {
    let index = start;
    for (const code of form.codes) {
      if (index >= size) return -1;
      if (code === 32) {
        if (!isSpaceUnit(view.charCodeAt(index))) return -1;
        do {
          index++;
          left--;
        } while (index < size && isSpaceUnit(view.charCodeAt(index)) && left >= 0);
      } else {
        left--;
        const here = view.codePointAt(index) ?? 0;
        if (here !== code) return -1;
        index += here > 0xffff ? 2 : 1;
      }
      if (left < 0) return -1;
    }
    return index;
  };

  // The end of the match with es, s or nothing after the form, the first that no word character follows.
  const withSuffix = (end: number, exact: boolean) => {
    if (end < size) {
      left--;
      const first = view.codePointAt(end) ?? 0;
      if ((exact ? first === 101 : fold(first) === foldE) && end + 1 < size) {
        left--;
        const second = view.codePointAt(end + 1) ?? 0;
        if ((exact ? second === 115 : fold(second) === foldS) && !wordAt(end + 2)) return end + 2;
      }
      if ((exact ? first === 115 : fold(first) === foldS) && !wordAt(end + 1)) return end + 1;
    }
    return wordAt(end) ? -1 : end;
  };

  const find = (start: number): { entry: number; length: number; range: Range } | undefined => {
    let node = root;
    let index = start;
    let ends: { form: Form; end: number }[] | undefined;
    while (index < size) {
      const unit = view.charCodeAt(index);
      if (isSpaceUnit(unit)) {
        left--;
        if (!node.space) break;
        do {
          index++;
          left--;
        } while (index < size && isSpaceUnit(view.charCodeAt(index)) && left >= 0);
        node = node.space;
      } else {
        const code = view.codePointAt(index) ?? 0;
        left--;
        const child = node.next.get(fold(code));
        if (!child) break;
        node = child;
        index += code > 0xffff ? 2 : 1;
      }
      if (left < 0) return;
      if (node.forms) {
        left -= node.forms.length;
        ends ??= [];
        for (const form of node.forms) ends.push({ form, end: index });
      }
    }
    if (left < 0 || !ends) return;
    if (ends.length > 1) ends.sort((a, b) => a.form.rank - b.form.rank);
    for (const { form, end } of ends) {
      let literal = end;
      if (form.acronym) {
        literal = exactEnd(form, start);
        if (left < 0) return;
        if (literal < 0) continue;
      }
      const finish = withSuffix(literal, form.acronym);
      if (left < 0) return;
      if (finish < 0) continue;
      const range = accept(start, finish);
      if (left < 0) return;
      if (range) return { entry: form.entry, length: finish - start, range };
    }
  };

  let index = 0;
  let previousWord = false;
  while (index < size) {
    left--;
    if (left < 0) break;
    const code = view.codePointAt(index) ?? 0;
    if (!previousWord) {
      const hit = find(index);
      if (left < 0) break;
      if (hit) {
        index += hit.length;
        previousWord = wordBefore(index);
        if (left < 0) break;
        if (!seen.has(hit.entry) && mark(hit.entry, hit.range)) break;
        continue;
      }
    }
    previousWord = word(code);
    index += code > 0xffff ? 2 : 1;
  }
  const fits = left >= 0;
  matcher.remaining = fits ? left : 0;
  return fits;
}
