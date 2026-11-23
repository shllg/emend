import { normalizeGlossaryForm } from "@emend/contract";

// The matcher of a doc (Markdown through docGlossary, HTML through the bridge's port). The writeup keeps the
// regex matcher in terms.ts, which stays the reference: for every input the marks are the same.
//
// A regex alternation of up to 450 forms costs, at each position, up to the summed length of all forms, and
// compiling it can take seconds. This matcher walks a prefix tree of the forms instead. A position costs at
// most the depth of the tree (a form is at most 100 characters) plus the forms that end on the way, nothing is
// compiled, and every step is counted against the budget as it is taken.
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
  fold: (code: number) => number;
  word: (code: number) => boolean;
};

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
  return { trie: true, count: entries.length, remaining: budget, forms, root, fold, word };
}

/**
 * Marks the first use of each entry in `view`, left to right. `rangeAt` is markTerms' own check of a
 * candidate range; `mark` takes each new mark and returns true when no entry is left.
 *
 * Counts one step per code point compared (each tree lookup), per whitespace character a space consumes,
 * per start position tried (also one refused by the word-boundary rule), per form that ends on the way
 * and per code point of an acronym's exact check. Returns false when a step did not fit the budget: the
 * budget is then spent, and the caller drops the marks of this text node.
 */
export function scanDocTerms(
  matcher: DocTermMatcher,
  view: string,
  rangeAt: (index: number, length: number) => Range | undefined,
  seen: Set<number>,
  mark: (entry: number, range: Range) => boolean,
): boolean {
  const { root, fold, word } = matcher;
  const size = view.length;
  const foldE = fold(101);
  const foldS = fold(115);
  let left = matcher.remaining;

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
      const range = rangeAt(start, finish - start);
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
