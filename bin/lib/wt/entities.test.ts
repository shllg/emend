import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// Resolve through declared dependencies, not pnpm store paths or optional global packages.
// A missing source package is a test failure, never a skipped coverage check.
const core = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const remark = createRequire(core.resolve("remark-parse"));
const markdown = createRequire(remark.resolve("mdast-util-from-markdown"));
const decode = createRequire(markdown.resolve("decode-named-character-reference"));
const { characterEntities } = decode("character-entities") as { characterEntities: Record<string, string> };
const rehype = createRequire(core.resolve("rehype-stringify"));
const html = createRequire(rehype.resolve("hast-util-to-html"));
const stringify = createRequire(html.resolve("stringify-entities"));
const { characterEntitiesLegacy } = stringify("character-entities-legacy") as { characterEntitiesLegacy: string[] };

// Include the scanner's chain separators, backslash, dashes and quotation/ignorable characters too.
const punctuation = new Set("#/:.-_()[]<>*~`!,;&\\");
const relevant = (value: string): boolean =>
  [...value, ...value.normalize("NFKC")].some(
    (point) =>
      /[A-Za-z0-9\p{White_Space}\p{Cf}\p{Dash_Punctuation}\p{Quotation_Mark}\p{Default_Ignorable_Code_Point}]/u.test(
        point,
      ) || punctuation.has(point),
  );
const names = Object.keys(characterEntities).sort();
const legacyNames = [...characterEntitiesLegacy].sort();
const subset = (keys: string[]) =>
  Object.fromEntries(
    keys.filter((key) => relevant(characterEntities[key] as string)).map((key) => [key, characterEntities[key]]),
  );
const named = subset(names);
const legacy = subset(legacyNames);

// Keep Unicode values escaped, so invisible characters cannot change how the source is displayed.
const quote = (value: string) =>
  JSON.stringify(value).replace(/[^\x20-\x7e]/gu, (point) =>
    point
      .split("")
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
const renderMap = (name: string, values: Record<string, string | undefined>) =>
  `export const ${name}: Readonly<Record<string, string>> = Object.freeze({\n${Object.entries(values)
    .map(([key, value]) => `  ${quote(key)}: ${quote(value as string)},`)
    .join("\n")}\n});\n`;
const renderNames = (name: string, keys: string[]) => {
  const chunks: string[] = [];
  let chunk = "";
  for (const key of keys) {
    if (chunk.length + key.length > 90) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += `${key} `;
  }
  chunks.push(chunk.trimEnd());
  return `export const ${name}: ReadonlySet<string> = new Set(\n  (${chunks.map(quote).join(" +\n    ")}).split(" "),\n);\n`;
};

if (process.argv.includes("--generate")) {
  const header = `/**
 * Generated from the WHATWG HTML named character references, as published in
 * character-entities and character-entities-legacy (MIT), already installed in node_modules.
 * Values are retained when they or their NFKC form affect closing syntax: ASCII letters/digits,
 * whitespace, #/:.-_()[]<>*~\x60!, Unicode format characters, and the scanner's list separators,
 * backslash, dashes, quotes and default-ignorable characters. Name sets distinguish other valid names
 * (decoded as U+FFFD) from unknown names (left literal).
 * Regenerate from the repository root:
 *   node bin/lib/wt/entities.test.ts --generate
 *   pnpm exec biome format --write bin/lib/wt/entities.ts
 */\n\n`;
  writeFileSync(
    new URL("./entities.ts", import.meta.url),
    header +
      renderMap("namedEntities", named) +
      "\n" +
      renderMap("legacyEntities", legacy) +
      "\n" +
      renderNames("htmlEntityNames", names) +
      "\n" +
      renderNames("legacyEntityNames", legacyNames),
  );
  console.log(
    `Generated ${Object.keys(named).length} semicolon and ${Object.keys(legacy).length} legacy values; ${names.length} HTML5 and ${legacyNames.length} legacy names.`,
  );
} else {
  const table = await import("./entities.ts");
  const { decodeClosingReferences } = await import("./github.ts");
  test("committed semicolon entity table equals the syntax-relevant HTML5 subset", () => {
    assert.deepEqual(table.namedEntities, named);
    assert.deepEqual([...table.htmlEntityNames].sort(), names);
  });
  test("committed legacy entity table equals the syntax-relevant legacy subset", () => {
    assert.deepEqual(table.legacyEntities, legacy);
    assert.deepEqual([...table.legacyEntityNames].sort(), legacyNames);
  });
  test("entity coverage distinguishes syntax, irrelevant values and unknown names", () => {
    for (const name of [
      "num",
      "sol",
      "period",
      "comma",
      "semi",
      "amp",
      "quot",
      "bsol",
      "hyphen",
      "Copf",
      "NewLine",
      "ZeroWidthSpace",
    ])
      assert.equal(table.namedEntities[name], characterEntities[name], name);
    assert.equal(table.namedEntities.copy, undefined);
    assert.ok(table.htmlEntityNames.has("copy"));
    assert.ok(!table.htmlEntityNames.has("fix"));
    assert.ok(!table.htmlEntityNames.has("mask"));
    assert.ok(table.legacyEntityNames.has("nbsp"));
    assert.ok(!table.legacyEntityNames.has("num"));
  });
  test("decoding covers every valid HTML5 name, replacing only syntax-irrelevant values", () => {
    for (const name of names) {
      const expected = named[name] ?? "\ufffd";
      assert.equal(decodeClosingReferences(`&${name};`), expected, name);
      assert.equal(decodeClosingReferences(`&${name};`, true), expected, name);
    }
  });
  test("legacy names decode only in the HTML reading and use the longest prefix", () => {
    for (const name of legacyNames) {
      assert.equal(decodeClosingReferences(`&${name}`), `&${name}`, name);
      assert.equal(decodeClosingReferences(`&${name}`, true), legacy[name] ?? "\ufffd", name);
    }
    assert.equal(decodeClosingReferences("&notin;", true), "\ufffd");
    assert.equal(decodeClosingReferences("&notit;", true), "\ufffdit;");
    assert.equal(decodeClosingReferences("&nbsp57", true), "\u00a057");
  });
  test("unknown names stay literal and decoded references are never decoded a second time", () => {
    for (const legacy of [false, true]) {
      for (const name of ["fix", "mask", "constructor", "toString", "MadeUpEntity"])
        assert.equal(decodeClosingReferences(`&${name};`, legacy), `&${name};`);
      assert.equal(decodeClosingReferences("&amp;num;57", legacy), "&num;57");
      assert.equal(decodeClosingReferences("&#38;num;57", legacy), "&num;57");
    }
  });
  test("HTML numeric references accept omitted semicolons and arbitrary leading zeros", () => {
    for (const reference of ["&#32", "&#x20", "&#X20", "&#00000032;", "&#x0000020;", `&#${"0".repeat(32_000)}32`]) {
      assert.equal(decodeClosingReferences(reference), reference);
      assert.equal(decodeClosingReferences(reference, true), " ");
    }
    assert.equal(decodeClosingReferences("&#32#57", true), " #57");
    assert.equal(decodeClosingReferences("&#x23g", true), "#g");
    assert.equal(decodeClosingReferences("&#35;57", true), "#57");
    assert.equal(decodeClosingReferences("&#38num;57", true), "&num;57");
    for (const reference of ["&#0", "&#xD800", "&#1114112", `&#${"9".repeat(32_000)}`])
      assert.equal(decodeClosingReferences(reference, true), "\ufffd");
    for (const reference of ["&#", "&#x", "&#;", "&#x;", "&#-32", "&#xg"])
      assert.equal(decodeClosingReferences(reference, true), reference);
  });
}
