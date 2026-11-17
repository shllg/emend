import type { ThemeBase } from "@emend/contract";
import { expect, test } from "vitest";
import { type DownloadLook, themeDownloadLook } from "../theme/download.ts";
import {
  buildCommentsDownload,
  buildDocDownload,
  buildHtmlDocDownload,
  buildOmittedDownload,
  buildWriteupDownload,
} from "./download.ts";

const details = { project: "Example", branch: null, seq: 1, publishedAt: "2026-01-01T00:00:00Z", links: [] };
const threads = { top: [], blocks: new Map(), topics: new Map(), lines: new Map(), diff: new Map(), end: [] };
const pages = ["writeup", "markdown", "source", "comments", "omitted"] as const;
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
      },
    };
    const html = await render(kind, theme);
    expect(html).toContain(`<meta name="color-scheme" content="${base}">`);
    expect(html).toContain(`:root{color-scheme:${base};`);
    expect(html).not.toContain("prefers-color-scheme");
    const override =
      ":root{--bg:#101112;--sunken:#202122;--fg:#c0c1c2;--strong:#f0f1f2;--muted:#a0a1a2;--border:#303132;--link:oklch(0.8 0.1 60)}";
    expect(html).toContain(override);
    expect(html).toContain(".em-diff-add{background:#12345680}.em-diff-delete{background:oklch(0.6 0.1 20 / 0.2)}");
    expect(html.indexOf(override)).toBeGreaterThan(html.indexOf(`var(--shiki-${base},inherit)`));
    expect(html).not.toContain("Geist");
  }
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
