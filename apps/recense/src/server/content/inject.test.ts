import { createHash } from "node:crypto";
import { parseDocHtml } from "@recense/core";
import { expect, test } from "vitest";
import { HTML_DOC_CSP } from "../http/headers.ts";
import { BRIDGE_SOURCE } from "./bridge.ts";
import { injectBridge, injectLook } from "./inject.ts";

test.each([
  ["<!doctype html><html><body>Seed</body></html>", "<!doctype html>", "<html><body>Seed</body></html>"],
  ["<!DOCTYPE HTML><p>Seed</p>", "<!DOCTYPE HTML>", "<p>Seed</p>"],
  ['<?xml version="1.0"?><!DOCTYPE html><p>Seed</p>', '<?xml version="1.0"?><!DOCTYPE html>', "<p>Seed</p>"],
  ["<!--x--!><!doctype html><p>Seed</p>", "<!--x--!><!doctype html>", "<p>Seed</p>"],
  ["<!--><!doctype html><p>Seed</p>", "<!--><!doctype html>", "<p>Seed</p>"],
  ["<!---><!doctype html><p>Seed</p>", "<!---><!doctype html>", "<p>Seed</p>"],
  ["<!DOCTYPEhtml><p>Seed</p>", "<!DOCTYPEhtml>", "<p>Seed</p>"],
  ["</ ><!doctype html><p>Seed</p>", "</ ><!doctype html>", "<p>Seed</p>"],
  ["<!x><!doctype html><p>Seed</p>", "<!x><!doctype html>", "<p>Seed</p>"],
  [
    "<!x><?y><!--x--!>\n</?><!DOCTYPEhtml>\t<!z><p>Seed</p>",
    "<!x><?y><!--x--!>\n</?><!DOCTYPEhtml>\t<!z>",
    "<p>Seed</p>",
  ],
  [
    "\uFEFF \n<!--first--><!DOCTYPE HTML>\t<!--second--> <p>Seed</p>",
    "\uFEFF \n<!--first--><!DOCTYPE HTML>\t<!--second--> ",
    "<p>Seed</p>",
  ],
  ["<p>Seed</p>", "", "<p>Seed</p>"],
  ["\n<!--unfinished", "\n", "<!--unfinished"],
  ["<!--unfinished <!doctype html>", "", "<!--unfinished <!doctype html>"],
  ["<!doctype html><!--unfinished", "<!doctype html>", "<!--unfinished"],
  ["<?unfinished", "", "<?unfinished"],
  ["<!unfinished", "", "<!unfinished"],
  ["</ unfinished", "", "</ unfinished"],
  ["<!--safe--> <?unfinished", "<!--safe--> ", "<?unfinished"],
  ["<!doctype html>\n<!unfinished", "<!doctype html>\n", "<!unfinished"],
  ["</p><!doctype html>", "", "</p><!doctype html>"],
  ["<!--x--!>content--><!doctype html>", "<!--x--!>", "content--><!doctype html>"],
  ["<!--x-->content--!><!doctype html>", "<!--x-->", "content--!><!doctype html>"],
  ["<!--first--> <p>Seed</p>", "<!--first--> ", "<p>Seed</p>"],
  ["<!doctype html><!doctype html><p>Seed</p>", "<!doctype html>", "<!doctype html><p>Seed</p>"],
])("inserts the pub stylesheet after the safe prefix: %s", (source, prefix, rest) => {
  const css = "@layer recense{p{color:var(--fg-reading)}}";
  expect(injectLook(source, css)).toBe(`${prefix}<style>${css}</style>${rest}`);
  for (const theme of ["light", "dark"] as const)
    expect(injectLook(source, css, theme)).toBe(`${prefix}<html data-theme="${theme}"><style>${css}</style>${rest}`);
});

test.each(["light", "dark"] as const)(
  "the fixed %s root wins over the page's theme and retains its other attributes",
  (theme) => {
    const source = `<!doctype html><html data-theme="${theme === "light" ? "dark" : "light"}" lang="en"><body>Plan</body></html>`;
    const injected = injectLook(source, "@layer recense{}", theme);
    expect(injected).toBe(
      `<!doctype html><html data-theme="${theme}"><style>@layer recense{}</style>${source.slice(15)}`,
    );
    const root = parseDocHtml(injected)?.childNodes.find((node) => node.nodeName === "html");
    expect(root && "attrs" in root ? root.attrs : []).toEqual([
      { name: "data-theme", value: theme },
      { name: "lang", value: "en" },
    ]);
  },
);

test("adding the look leaves exactly one bridge with the hash allowed by the unchanged CSP", () => {
  const css = "@layer recense{body{margin:0}}";
  const html = injectBridge(injectLook("<!doctype html><body><style>body{margin:1px}</style>Seed</body>", css));
  expect(html).toMatch(/^<!doctype html><style>@layer recense/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.[1]).toBe(BRIDGE_SOURCE);
  const hash = createHash("sha256")
    .update(scripts[0]?.[1] ?? "")
    .digest("base64");
  expect(HTML_DOC_CSP).toContain(`script-src 'sha256-${hash}'`);
});

test("injects one self-contained script before the last case-insensitive body close, otherwise appends", () => {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  expect(injectBridge("<body>seed</BODY>tail</bOdY>")).toBe(`<body>seed</BODY>tail${script}</bOdY>`);
  expect(injectBridge("<p>seed</p>")).toBe(`<p>seed</p>${script}`);
  expect(injectBridge("<body>İ</BoDy>")).toBe(`<body>İ${script}</BoDy>`);
  expect(BRIDGE_SOURCE).not.toMatch(/<\/script|\bimport\s/i);
});

test("body-close text in a script before the real body close preserves one bridge and its hash", () => {
  const html = '<body><p>Seed</p><script>const ending = "</body>";</script></body>';
  const injected = injectBridge(html);
  const at = html.lastIndexOf("</body>");
  expect(injected).toBe(`${html.slice(0, at)}<script>${BRIDGE_SOURCE}</script>${html.slice(at)}`);
  const texts = [...injected.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const bridges = texts.filter((text) => text === BRIDGE_SOURCE);
  expect(bridges).toHaveLength(1);
  expect(injected.split(BRIDGE_SOURCE)).toHaveLength(2);
  expect(
    createHash("sha256")
      .update(bridges[0] ?? "")
      .digest("base64"),
  ).toBe(createHash("sha256").update(BRIDGE_SOURCE).digest("base64"));
});
