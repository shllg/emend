import { LIMITS, WriteupInput } from "@emend/contract";
import { test, vi } from "vitest";
import * as matching from "./terms.ts";
import { renderWriteup } from "./writeup.ts";

const formCount = LIMITS.glossaryTerms * (LIMITS.glossaryAliases + 1);

test.each([
  {
    name: "glossary-symbol-prefix",
    prefix: "⊕".repeat(LIMITS.glossaryTermChars - 1),
    symbol: "⊕",
    paragraphChars: 256,
    paragraphsPerSection: 18,
  },
  {
    name: "glossary-repeated-symbol",
    prefix: "",
    symbol: String.fromCharCode(0x2500 + formCount - 1),
    paragraphChars: 1024,
    paragraphsPerSection: 256,
  },
])(
  "$name spends the default work budget on small text nodes",
  async ({ name, prefix, symbol, paragraphChars, paragraphsPerSection }) => {
    const form = (index: number) => `${prefix}${String.fromCharCode(0x2500 + index)}`;
    const glossary = Array.from({ length: LIMITS.glossaryTerms }, (_, index) => ({
      term: form(index * (LIMITS.glossaryAliases + 1)),
      aliases: Array.from({ length: LIMITS.glossaryAliases }, (_, alias) =>
        form(index * (LIMITS.glossaryAliases + 1) + alias + 1),
      ),
      definition: "A synthetic definition.",
    }));
    const prose = Array.from({ length: paragraphsPerSection }, () => symbol.repeat(paragraphChars)).join("\n\n");
    const source = { overview: prose, tldr: prose, decisions: "", topics: {} };
    // Warm the shared renderer before comparing each case with its baseline.
    await renderWriteup({ overview: "", tldr: "", decisions: "", topics: {} }, []);
    const matchers: ReturnType<typeof matching.termMatcher>[] = [];
    const buildMatcher = matching.termMatcher;
    const capture = vi.spyOn(matching, "termMatcher").mockImplementation((...args) => {
      const matcher = buildMatcher(...args);
      matchers.push(matcher);
      return matcher;
    });
    try {
      for (const withGlossary of [false, true]) {
        matchers.length = 0;
        const writeup = WriteupInput.parse({ ...source, ...(withGlossary ? { glossary } : {}) });
        const start = performance.now();
        const rendered = await renderWriteup(writeup, []);
        const ms = performance.now() - start;
        const matcher = matchers.at(-1);
        if (withGlossary && !matcher) throw new Error("Missing benchmark matcher");
        const units = matcher ? matching.TERM_MATCH_WORK_BUDGET - matcher.remaining : 0;
        const marks = rendered.sections
          .flatMap((section) => section.blocks)
          .reduce((count, block) => count + (block.html.match(/data-emend-term=/g)?.length ?? 0), 0);
        const measurement = { bench: withGlossary ? name : `${name}-baseline`, ms, units, marks };
        // Keep each measurement on one JSON line, outside the test console reporter.
        process.stdout.write(`${JSON.stringify(measurement)}\n`);
      }
    } finally {
      capture.mockRestore();
    }
  },
);
