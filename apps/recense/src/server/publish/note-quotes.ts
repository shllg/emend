type Range = { start: number; end: number };
export type QuoteMatch = Range | "quote_missing" | "quote_ambiguous";

/** KMP over trimmed whole lines. Keeping the prefix after a match also finds overlapping matches. */
export function matchNoteQuote(lines: readonly string[], quote: string): QuoteMatch {
  const pattern = quote
    .trim()
    .split("\n")
    .map((line) => line.trim());
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched > 0 && pattern[i] !== pattern[matched]) matched = prefix[matched - 1] ?? 0;
    if (pattern[i] === pattern[matched]) matched++;
    prefix[i] = matched;
  }

  let range: Range | undefined;
  let matched = 0;
  for (const [index, line] of lines.entries()) {
    while (matched > 0 && line !== pattern[matched]) matched = prefix[matched - 1] ?? 0;
    if (line === pattern[matched]) matched++;
    if (matched === pattern.length) {
      if (range) return "quote_ambiguous";
      const end = index + 1;
      range = { start: end - matched + 1, end };
      matched = prefix[matched - 1] ?? 0;
    }
  }
  return range ?? "quote_missing";
}

export function matchNoteQuotes(bytes: ArrayBuffer, quotes: string[]) {
  const lines = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [i, line] of lines.entries()) lines[i] = line.trim();
  return { count: lines.length, matches: new Map(quotes.map((quote) => [quote, matchNoteQuote(lines, quote)])) };
}
