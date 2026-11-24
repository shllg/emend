import { SyntaxRole, type ThemeBase } from "@recense/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import { expect, test } from "vitest";
import { type DownloadLook, themeDownloadLook } from "../theme/download.ts";
import { checkThemeDocument, resolveTheme, themeCopyDocument } from "../theme/theme.ts";
import { visitElements } from "./blocks.ts";
import {
  buildCommentsDownload,
  buildDocDownload,
  buildHtmlDocDownload,
  buildOmittedDownload,
  buildWriteupDownload,
} from "./download.ts";
import { renderSource } from "./source.ts";
import { syntaxColors } from "./syntax-theme.ts";

const details = { project: "Example", branch: null, seq: 1, publishedAt: "2026-01-01T00:00:00Z", links: [] };
const threads = { top: [], blocks: new Map(), topics: new Map(), lines: new Map(), diff: new Map(), end: [] };
const pages = ["writeup", "markdown", "source", "comments", "omitted"] as const;

test.each(["light", "dark"] as const)("downloads define syntax colours from the %s base", async (theme) => {
  const html = await buildOmittedDownload({ title: "Syntax", theme });
  const colors = resolveTheme(theme);
  for (const css of Object.values(syntaxColors)) {
    const token = css.slice(6, -1) as keyof typeof colors;
    expect(html).toContain(`--${token}:${colors[token]}`);
  }
});

test("source downloads use only fixed role colours, ahead of legacy colours", async () => {
  const html = await buildDocDownload({
    title: "Syntax",
    details,
    resolveMedia: async () => null,
    content: {
      kind: "source",
      lines: [
        SyntaxRole.options.map((syntax) => ({ text: syntax, syntax, light: "#123456", dark: "#abcdef" })),
        ["__proto__", "constructor", "red;}</style><script>", "var(--x)"].map((syntax) => ({
          text: "invalid role",
          syntax: syntax as SyntaxRole,
        })),
      ],
    },
  });
  expect(html).not.toContain("--shiki-light:#123456");
  const styles: unknown[] = [];
  visitElements(fromHtml(html), (node) => {
    if (node.tagName === "span" && node.properties.style) styles.push(node.properties.style);
  });
  expect(styles).toEqual(SyntaxRole.options.map((role) => `color:${syntaxColors[role]}`));
});

test.each([
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(1)">',
  '<a href="javascript:alert(1)">link</a>',
  '<div style="color:red" onclick="alert(1)">raw HTML</div>',
  '<svg onload="alert(1)"><script>alert(1)</script></svg>',
  'graph TD; A-->B; click A "javascript:alert(1)"',
])("source downloads escape hostile tokens: %s", async (text) => {
  const source = await renderSource(text, "sample.html");
  const html = await buildDocDownload({
    title: "Syntax",
    details,
    resolveMedia: async () => null,
    content: { kind: "source", lines: source.lines },
  });
  visitElements(fromHtml(html), (node) => {
    expect(node.tagName).not.toMatch(/^(script|img|svg|a)$/);
    expect(Object.keys(node.properties).some((key) => /^on/i.test(key))).toBe(false);
    if (node.tagName === "code") expect(hastText(node)).toBe(text);
    if (node.tagName === "span" && node.properties.style)
      expect(Object.values(syntaxColors).map((color) => `color:${color}`)).toContain(node.properties.style);
  });
});
function render(kind: (typeof pages)[number], theme: DownloadLook) {
  const input = { title: "Example", details, resolveMedia: async () => null, theme };
  switch (kind) {
    case "writeup":
      return buildWriteupDownload({
        ...input,
        writeup: { sections: [] },
        topics: [],
        diff: { files: [], hunks: async () => [] },
      });
    case "markdown":
      return buildDocDownload({ ...input, content: { kind: "markdown", blocks: [] } });
    case "source":
      return buildDocDownload({ ...input, content: { kind: "source", lines: [] } });
    case "comments":
      return buildCommentsDownload({ ...input, threads });
    case "omitted":
      return buildOmittedDownload(input);
  }
}
test.each(pages)("%s uses the look after its base styles", async (kind) => {
  for (const base of ["dark", "light"] as const) {
    const theme: DownloadLook = {
      base,
      colors: {
        bg: "#101112",
        sunken: "#202122",
        fg: "#c0c1c2",
        strong: "#f0f1f2",
        muted: "#a0a1a2",
        border: "#303132",
        link: "oklch(0.8 0.1 60)",
        diffAdd: "#12345680",
        diffDel: "oklch(0.6 0.1 20 / 0.2)",
        synPlain: "#d0d1d2",
        synKeyword: "#d3d4d5",
        synType: "#d6d7d8",
        synFunction: "#d9dadb",
        synString: "#dcddde",
        synNumber: "#dfe0e1",
        synComment: "#e2e3e4",
        synPunct: "#e5e6e7",
        diffAddFg: "#a0ffa0",
        diffDelFg: "#ffa0a0",
      },
    };
    const html = await render(kind, theme);
    expect(html).toContain(`<meta name="color-scheme" content="${base}">`);
    expect(html).toContain(`:root{color-scheme:${base};`);
    expect(html).not.toContain("prefers-color-scheme");
    const override =
      ":root{--bg:#101112;--sunken:#202122;--fg:#c0c1c2;--strong:#f0f1f2;--muted:#a0a1a2;--border:#303132;--link:oklch(0.8 0.1 60);" +
      "--syn-plain:#d0d1d2;--syn-keyword:#d3d4d5;--syn-type:#d6d7d8;--syn-function:#d9dadb;" +
      "--syn-string:#dcddde;--syn-number:#dfe0e1;--syn-comment:#e2e3e4;--syn-punct:#e5e6e7;" +
      "--diff-add-fg:#a0ffa0;--diff-del-fg:#ffa0a0}";
    expect(html).toContain(override);
    expect(html).toContain(".em-diff-add{background:#12345680}.em-diff-delete{background:oklch(0.6 0.1 20 / 0.2)}");
    expect(html.indexOf(override)).toBeGreaterThan(html.indexOf(`var(--shiki-${base},var(--syn-plain))`));
    expect(html).not.toContain("Geist");
  }
});
test("a dark-base theme with a light palette exports its own syntax colours", async () => {
  const source = checkThemeDocument({ ...themeCopyDocument("light"), base: "dark" }, "light-palette");
  expect(source.valid, JSON.stringify(source)).toBe(true);
  if (!source.valid) throw new Error("Expected a valid theme");
  const theme = themeDownloadLook(source);
  const light = resolveTheme("light");
  expect(theme.base).toBe("dark");
  expect(theme.colors.sunken).toBe(light["bg-sunken"]);
  expect(theme.colors.synPlain).toBe(light["syn-plain"]);
  const html = await buildDocDownload({
    title: "Syntax",
    details,
    resolveMedia: async () => null,
    theme,
    content: { kind: "source", lines: [[{ text: "plain", syntax: "plain" }]] },
  });
  const baseSyntax = `--syn-plain:${resolveTheme("dark")["syn-plain"]}`;
  const ownSyntax = `--syn-plain:${theme.colors.synPlain}`;
  expect(html).toContain('<meta name="color-scheme" content="dark">');
  expect(html).toContain(`--sunken:${theme.colors.sunken}`);
  expect(html).toContain(baseSyntax);
  expect(html).toContain(ownSyntax);
  expect(html.lastIndexOf(ownSyntax)).toBeGreaterThan(html.lastIndexOf(baseSyntax));
  expect(html).toContain('<span style="color:var(--syn-plain)">plain</span>');
});
test.each([
  "red",
  "rgb(0 0 0)",
  "var(--x)",
  "url(x)",
  "#fff;background:red",
  "oklch(1 0 0);}",
  '"#ffffff"',
  "oklch(1e0 0 0)",
  "</style><script>alert(1)</script>",
  "#fff",
])("rejects unsafe look colour %s instead of producing a document", async (value) => {
  const look = themeDownloadLook("dark");
  // Every key is checked, even diff colours on pages without a diff.
  for (const key of Object.keys(look.colors) as (keyof DownloadLook["colors"])[]) {
    const theme = { ...look, colors: { ...look.colors, [key]: value } };
    for (const kind of pages) await expect(render(kind, theme)).rejects.toThrow();
  }
});
test("a look's base is validated before it can enter CSS", async () => {
  await expect(
    buildOmittedDownload({
      title: "Example",
      theme: { ...themeDownloadLook("dark"), base: "dark;}</style>" as ThemeBase },
    }),
  ).rejects.toThrow();
});
test("an HTML doc keeps its own look with a custom theme", async () => {
  const input = {
    title: "Example",
    html: "<style>p{color:purple}</style><p>Example</p>",
    docPath: "example.html",
    resolveAsset: async () => null,
  };
  expect(await buildHtmlDocDownload({ ...input, theme: themeDownloadLook("dark") })).toBe(
    await buildHtmlDocDownload(input),
  );
});
