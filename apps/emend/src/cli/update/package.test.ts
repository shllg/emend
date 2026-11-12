import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkNewEmend } from "./package.ts";

test.each(["folder", "folder-hop", "entry-hop", "missing", "loop"])(
  "refuses an unchecked new package: %s",
  async (kind) => {
    const root = await mkdtemp(join(process.env.EMEND_HOME as string, "package-"));
    const repo = join(root, "repo");
    const safe = join(root, "safe");
    await mkdir(repo);
    await mkdir(join(safe, "dist"), { recursive: true });
    await writeFile(join(safe, "package.json"), JSON.stringify({ name: "@shllg/emend", version: "1.2.3" }));
    await writeFile(join(root, "entry"), "synthetic script");
    let folder = safe;
    if (kind === "folder") folder = repo;
    if (kind === "folder-hop") {
      await symlink(safe, join(repo, "out"));
      await symlink(join(repo, "out"), join(root, "hop"));
      folder = join(root, "hop");
    }
    if (kind === "entry-hop") {
      await symlink(join(root, "entry"), join(repo, "out"));
      await symlink(join(repo, "out"), join(safe, "dist/emend.mjs"));
    }
    if (kind === "loop") await symlink(join(safe, "dist/emend.mjs"), join(safe, "dist/emend.mjs"));
    await expect(checkNewEmend(folder, [repo])).rejects.toThrow();
    expect(await readFile(join(root, "entry"), "utf8")).toBe("synthetic script");
  },
);
