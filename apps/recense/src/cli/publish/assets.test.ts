import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { collectAssets } from "./assets.ts";

test("skips assets outside the doc folder with one warning per reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-assets-"));
  try {
    const folder = join(dir, "doc");
    await mkdir(join(folder, "img"), { recursive: true });
    await writeFile(join(folder, "style.css"), "body{}");
    await writeFile(join(folder, "img/a.png"), "image");
    await writeFile(join(dir, "outside.css"), "private");
    await symlink(join(dir, "outside.css"), join(folder, "escape.css"));
    const refs = [
      "./style.css?v=1#x",
      "img/a.png",
      "../x.css",
      "/abs.css",
      "https://example.test/a.css",
      ".hidden/x.png",
      "escape.css",
      "missing.png",
      "x.txt",
    ];
    await writeFile(join(folder, "plan.html"), refs.map((ref) => `<img src="${ref}"><img src="${ref}">`).join(""));
    const warnings: string[] = [];
    expect((await collectAssets(join(folder, "plan.html"), (line) => warnings.push(line))).map((a) => a.ref)).toEqual([
      "style.css",
      "img/a.png",
    ]);
    expect(warnings).toHaveLength(7);
    expect(warnings.every((line) => line.startsWith("recense: skipped "))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only real element attributes count, never comments, textareas or script strings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recense-asset-tags-"));
  try {
    await writeFile(join(dir, "private.png"), "not referenced");
    await writeFile(
      join(dir, "plan.html"),
      `<!-- <img src="private.png"> --><script>const s = '<img src="private.png">';</script><textarea><img src="private.png"></textarea>`,
    );
    expect(await collectAssets(join(dir, "plan.html"), () => {})).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an asset alias cannot resolve through a Git metadata short-name segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "recense-asset-metadata-"));
  try {
    await mkdir(join(root, "vendor/GIT~1. "), { recursive: true });
    const metadata = join(root, "vendor/GIT~1. /config");
    await writeFile(metadata, "synthetic metadata");
    await symlink(metadata, join(root, "image.png"));
    await writeFile(join(root, "plan.html"), '<img src="image.png">');
    await expect(collectAssets(join(root, "plan.html"), () => {})).rejects.toThrow(
      `refusing to read inside the git folder: ${metadata}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
