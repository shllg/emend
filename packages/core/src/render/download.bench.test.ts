import { expect, test, vi } from "vitest";
import { buildHtmlDocDownload } from "./download.ts";

test.each([
  {
    name: "download-nested-image-set",
    source: () =>
      `<style>i{background:${"image-set(".repeat(2000)}${"x".repeat(100_000)}${")".repeat(2000)}}p{color:green}</style>`,
    expected: "background:/**/none/**/",
    count: 1,
  },
  {
    name: "download-repeated-image-set",
    source: () => `<style>${'i{background:image-set("missing.png" 1x)}'.repeat(5000)}</style>`,
    expected: 'image-set(/**/"data:,"/**/ 1x)',
    count: 5000,
  },
  ...["element", "attribute"].map((placement) => ({
    name: `download-adversarial-css-${placement}`,
    source: () => {
      const nested = `i{background:${"image-set(".repeat(3000)}"nested.png"${")".repeat(3000)}}`;
      const rules = 'i{background:image-set("missing.png" 1x)}'.repeat(5000);
      const strings = `i{background:image-set(${'"missing.png" '.repeat(5000)}1x)}`;
      const unterminated = `"a${'\\"'.repeat(40_000)}`;
      const prefix = nested + rules + strings;
      const filler = "x".repeat(8 * 1024 * 1024 - prefix.length - unterminated.length - 4);
      const source = `${prefix}/*${filler}*/${unterminated}`;
      return placement === "element" ? `<style>${source}</style>` : `<div style='${source}'></div>`;
    },
    expected: "data:,",
    count: 10_000,
  })),
  ...["element", "attribute"].map((placement) => ({
    name: `download-unterminated-import-${placement}`,
    source: () => {
      const source = `@import url(${" ".repeat(20_000)}`;
      return placement === "element" ? `<style>${source}</style>` : `<p style="${source}">Text</p>`;
    },
    expected: "@import",
    count: 0,
  })),
])("$name", async ({ name, source, expected, count }) => {
  const input = source();
  const resolveAsset = vi.fn(async () => null);
  const pause = vi.fn(async () => {});
  const start = performance.now();
  const html = await buildHtmlDocDownload({
    html: input,
    docPath: "docs/index.html",
    title: "Fallback",
    resolveAsset,
    pause,
  });
  const ms = performance.now() - start;
  expect(html.split(expected).length - 1).toBe(count);
  process.stdout.write(
    `${JSON.stringify({ bench: name, ms, inputChars: input.length, outputChars: html.length, resolutions: resolveAsset.mock.calls.length, pauses: pause.mock.calls.length })}\n`,
  );
});

test.each(["imports", "links"])("download-discarded-css-%s", async (kind) => {
  const mib = 1024 * 1024;
  const suffix = ".large{color:green}";
  const stylesheet = `/*${"x".repeat(4 * mib - suffix.length - 4)}*/${suffix}`;
  const imports = '@import "large.css";'.repeat(64);
  const input =
    kind === "imports" ? `<style>${imports}</style>` : '<link rel="stylesheet" href="large.css">'.repeat(64);
  const asset = { mediaType: "text/css", bytes: new TextEncoder().encode(stylesheet) };
  const resolveAsset = vi.fn(async () => asset);
  const pause = vi.fn(async () => {});
  const start = performance.now();
  const html = await buildHtmlDocDownload({
    html: `${input}<style>.late{color:red}</style><p style="color:red">Kept text</p>`,
    docPath: "doc.html",
    title: "Work budget",
    resolveAsset,
    inlineBudget: 4 * mib - 1,
    pause,
  });
  const ms = performance.now() - start;
  expect(html.match(/Some content was left out/g)).toHaveLength(1);
  process.stdout.write(
    `${JSON.stringify({ bench: `download-discarded-css-${kind}`, ms, stylesheetBytes: asset.bytes.byteLength, references: 64, resolutions: resolveAsset.mock.calls.length, pauses: pause.mock.calls.length })}\n`,
  );
});
