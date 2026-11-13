import { LIMITS, WriteupInput } from "@emend/contract";
import { test } from "vitest";
import { renderWriteup } from "./writeup.ts";

test("glossary matching with 450 long forms sharing a prefix", async () => {
  const prefix = `${"x ".repeat(49)}x`;
  const form = (index: number) => `${prefix}${String.fromCharCode(0x4e00 + index)}`;
  const glossary = Array.from({ length: LIMITS.glossaryTerms }, (_, index) => ({
    term: form(index * (LIMITS.glossaryAliases + 1)),
    aliases: Array.from({ length: LIMITS.glossaryAliases }, (_, alias) =>
      form(index * (LIMITS.glossaryAliases + 1) + alias + 1),
    ),
    definition: "A synthetic definition.",
  }));
  const prose = "x ".repeat(384_000);
  const writeup = WriteupInput.parse({ overview: prose, tldr: prose, decisions: "", topics: {}, glossary });
  const start = performance.now();
  const rendered = await renderWriteup(writeup, []);
  const ms = performance.now() - start;
  const marks = rendered.sections.reduce(
    (count, section) =>
      count + section.blocks.reduce((sum, block) => sum + (block.html.match(/data-emend-term=/g)?.length ?? 0), 0),
    0,
  );
  // Keep each measurement on one JSON line, outside the test console reporter.
  process.stdout.write(
    `${JSON.stringify({ bench: "glossary-worst-case", proseBytes: prose.length * 2, ms, marks })}\n`,
  );
});
