import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, onTestFinished, test } from "vitest";
import { FALLBACK_PUB_CSS, pubStylesheet } from "./look.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "emend-pub-css-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "pub-frame.css") };
}

test.each([
  "</style><script>alert(1)</script>",
  "</unrelated>",
  Buffer.from([0xff]),
  " ".repeat(LIMITS.pubStylesheetBytes + 1),
])("rejected stylesheets fall back and are retried %#", async (source) => {
  const f = await fixture();
  await writeFile(f.path, source);
  expect(await pubStylesheet(f.root)).toBe(FALLBACK_PUB_CSS);
  const css = "@layer emend{@media(width<=767px){body{max-width:none}}}";
  await writeFile(f.path, css);
  expect(await pubStylesheet(f.root)).toBe(css);
});

test("a missing stylesheet is retried, while a successful read stays cached", async () => {
  const f = await fixture();
  expect(await pubStylesheet(f.root)).toBe(FALLBACK_PUB_CSS);
  const css = '@layer emend{body::before{content:"<"}}';
  await writeFile(f.path, css);
  expect(await pubStylesheet(f.root)).toBe(css);
  await writeFile(f.path, "changed");
  expect(await pubStylesheet(f.root)).toBe(css);
});
