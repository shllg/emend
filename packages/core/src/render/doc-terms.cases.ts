/** Shared with the HTML bridge's tests: the seeded random glossaries and texts of the doc matcher. All synthetic. */

/** A small seeded generator, so a failure repeats. */
export function generator(seed: number) {
  let state = seed;
  return (limit: number) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * limit);
  };
}

const chars = (...codes: number[]) => String.fromCodePoint(...codes);

// Pieces whose case folding crosses scripts and lengths, regex metacharacters, combining marks, astral
// characters, a CJK character and plain words; several have a non-ASCII edge, so the grapheme check runs.
export const termPieces = [
  "budget",
  "Budget",
  "BUDGET",
  "hub",
  "API",
  "api",
  "APIs",
  "C++",
  "a.b",
  "(x)",
  chars(0x17f),
  chars(0x3c2),
  chars(0x3c3),
  chars(0x3a3),
  chars(0x212a),
  "k",
  "K",
  chars(0xb5),
  chars(0x3bc),
  chars(0xdf),
  chars(0x1e9e),
  chars(0x130),
  chars(0x131),
  "i",
  "I",
  chars(0xab70),
  chars(0x13a0),
  chars(0x10428),
  chars(0x10400),
  chars(0x1d49c),
  chars(0x1f600),
  chars(0xe9),
  chars(0x65, 0x301),
  chars(0x301),
  chars(0x6f22),
  "x",
  "s",
  "es",
  "ES",
  "S",
  "item",
  `Zo${chars(0xe9)}`,
  "1",
  "_",
  "-",
  ".",
  chars(0x390),
  chars(0x1fd3),
  chars(0xfb05),
  "ab",
  "AB",
  "CD",
];

// What may sit between two pieces of a text: nothing, spaces, other whitespace, a mark, a digit, a zero-width space.
export const termGaps = [
  "",
  "",
  " ",
  " ",
  "  ",
  "\t",
  "\n",
  chars(0xa0),
  chars(0x3000),
  ` ${chars(0x2003)} `,
  "-",
  "_",
  "1",
  chars(0x301),
  chars(0x200b),
];

export type TermCase = { entries: { term: string; aliases: string[] }[]; values: string[] };

/** One random glossary and a few texts that reuse its forms, so that matches are common. */
export function randomTermCase(seed: number): TermCase {
  const next = generator(seed);
  const pick = <T>(list: T[]) => list[next(list.length)] as T;
  const form = () => Array.from({ length: 1 + next(3) }, () => pick(termPieces)).join(pick([" ", " ", "  ", ""]));
  const entries = Array.from({ length: 1 + next(6) }, () => ({
    term: form(),
    aliases: Array.from({ length: next(3) }, form),
  }));
  const forms = entries.flatMap((entry) => [entry.term, ...entry.aliases]);
  const piece = () => (next(3) === 0 ? pick(forms).replace(/ /g, pick(termGaps)) : pick(termPieces));
  const values = Array.from({ length: 1 + next(3) }, () =>
    Array.from({ length: 2 + next(14) }, () => `${piece()}${next(4) === 0 ? pick(["s", "es", "S", "ES"]) : ""}`).reduce(
      (joined, part) => `${joined}${pick(termGaps)}${part}`,
    ),
  );
  return { entries, values };
}
