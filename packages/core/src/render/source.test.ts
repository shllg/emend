import { SourceToken, SyntaxRole } from "@recense/contract";
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
it("highlights with syntax roles and keeps markup as text", async () => {
  const source = await renderSource("const n: number = 1;\n", "sample.ts");
  expect(source.language).toBe("ts");
  expect(source.lines.flat().some((token) => token.syntax === "keyword")).toBe(true);
  expect(source.lines.flat().every((token) => !("light" in token) && !("dark" in token))).toBe(true);
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

it.each([
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">link</a>',
  '<div style="color:red" onclick="alert(1)">raw HTML</div>',
  '<svg onload="alert(1)"><script>alert(1)</script></svg>',
  'graph TD; A-->B; click A "javascript:alert(1)"',
])("preserves hostile source as text with only enum roles: %s", async (text) => {
  for (const path of ["sample.html", "sample.md", "sample.ts"]) {
    const { lines } = await renderSource(text, path);
    expect(
      lines
        .flat()
        .map((token) => token.text)
        .join(""),
    ).toBe(text);
    for (const token of lines.flat()) {
      expect(SourceToken.parse(token)).toEqual(token);
      expect(Object.keys(token).every((key) => key === "text" || key === "syntax")).toBe(true);
      if (token.syntax) expect(SyntaxRole.options).toContain(token.syntax);
    }
  }
});

it("omits plain roles and merges adjacent tokens of the same role", async () => {
  const { lines } = await renderSource("const count: number = 1; // comment\ncount.member + count.other;", "sample.ts");
  expect(lines.flat()).toContainEqual({ text: "count" });
  for (const line of lines) {
    for (let index = 1; index < line.length; index++) {
      expect(line[index]?.syntax).not.toBe(line[index - 1]?.syntax);
    }
    expect(line.every((token) => token.syntax !== "plain")).toBe(true);
  }
});
