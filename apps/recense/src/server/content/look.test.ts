import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@recense/contract";
import { expect, onTestFinished, test } from "vitest";
import { FALLBACK_PUB_CSS, pubStylesheet, readPubStylesheet } from "./look.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "recense-pub-css-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "pub-frame.css") };
}

test("the fallback fixes each explicit root scheme within the recense layer", () => {
  expect(FALLBACK_PUB_CSS).toBe(
    "@layer recense-file,recense;@layer recense{:root{color-scheme:light dark;background:Canvas;color:CanvasText}:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}}",
  );
});

test.each([
  "</style><script>alert(1)</script>",
  "</unrelated>",
  '@import "https://evil.example/a.css";',
  "body{background:url(https://evil.example/a.png)}",
  String.raw`body{background:u\72l(https://evil.example/a.png)}`,
  '@font-face{src:src("data:font/woff2;base64,AA==")}',
  Buffer.from([0xff]),
  " ".repeat(LIMITS.pubStylesheetBytes + 1),
])("rejected stylesheets fall back and are retried %#", async (source) => {
  const f = await fixture();
  await writeFile(f.path, source);
  await expect(readPubStylesheet(f.root)).rejects.toThrow();
  expect(await pubStylesheet(f.root)).toBe(FALLBACK_PUB_CSS);
  const css = "@layer recense{@media(width<=767px){body{max-width:none}}}";
  await writeFile(f.path, css);
  expect(await pubStylesheet(f.root)).toBe(css);
});

test("a missing stylesheet is retried, while a successful read stays cached", async () => {
  const f = await fixture();
  await expect(readPubStylesheet(f.root)).rejects.toThrow();
  expect(await pubStylesheet(f.root)).toBe(FALLBACK_PUB_CSS);
  const css = '@layer recense{body::before{content:"<"}}';
  await writeFile(f.path, css);
  expect(await pubStylesheet(f.root)).toBe(css);
  await writeFile(f.path, "changed");
  expect(await pubStylesheet(f.root)).toBe(css);
});
