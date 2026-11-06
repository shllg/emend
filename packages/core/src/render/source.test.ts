import { expect, it } from "vitest";
import { splitLines } from "../place/linemap.ts";
import { decodeText } from "../text.ts";
import { HIGHLIGHT_LINE_CHARS } from "./highlight.ts";
import { renderSource } from "./source.ts";

it.each(["a\r\nb\r\n", "a\nb\n", "a\nb", "", "x".repeat(HIGHLIGHT_LINE_CHARS + 1), "a\rb\n"])(
  "preserves selectable lines: %j",
  async (text) => {
    const source = await renderSource(text, "sample.ts");
    expect(source.lines.map((line) => line.map((token) => token.text).join(""))).toEqual(splitLines(text));
  },
);
it("highlights with both themes and keeps markup as text", async () => {
  const source = await renderSource("const n: number = 1;\n", "sample.ts");
  expect(source.language).toBe("ts");
  expect(source.lines.flat().some((token) => token.light && token.dark)).toBe(true);
  const text = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<a href="javascript:alert(1)">link</a>';
  expect((await renderSource(text, "sample.html")).lines.map((l) => l.map((t) => t.text).join(""))).toEqual(
    splitLines(text),
  );
  expect(
    (await renderSource("# Title *literal*", "notes.md")).lines
      .flat()
      .map((t) => t.text)
      .join(""),
  ).toBe("# Title *literal*");
});
it("uses one strict UTF-8 rule and strips one leading BOM", () => {
  expect(decodeText(new Uint8Array([239, 187, 191, 97]))).toBe("a");
  for (const bytes of [new Uint8Array([255]), new Uint8Array([97, 0])]) expect(() => decodeText(bytes)).toThrow();
});
it("falls back above the whole-file budget and for unknown extensions", async () => {
  const text = "export const n = 1;\n".repeat(14000);
  const source = await renderSource(text, "large.ts");
  expect(source.language).toBe("text");
  expect(source.lines).toEqual(splitLines(text).map((text) => [{ text }]));
  for (const path of ["config.unknown", "no-extension", "file.constructor", "file.__proto__"])
    expect(await renderSource("plain", path)).toEqual({ language: "text", lines: [[{ text: "plain" }]] });
});
