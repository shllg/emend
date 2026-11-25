import type { PathLike } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { detectInstall, misePackageFolders } from "./install.ts";
import { misePackageFixtures } from "./test-support.ts";

type Operation = "realpath" | "lstat";
let failure: { operation: Operation; path: string; code: string } | undefined;

function checkFailure(operation: Operation, path: PathLike) {
  if (failure?.operation === operation && failure.path === path) {
    throw Object.assign(new Error(failure.code), { code: failure.code });
  }
}

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async realpath(...args: Parameters<typeof fs.realpath>) {
      checkFailure("realpath", args[0]);
      return fs.realpath(...args);
    },
    async lstat(...args: Parameters<typeof fs.lstat>) {
      checkFailure("lstat", args[0]);
      return fs.lstat(...args);
    },
  };
});

afterEach(() => {
  failure = undefined;
});

const pkg = "node_modules/@shllg/recense";

async function fixture(layout: "aube" | "pnpm11") {
  const root = await realpath(await mkdtemp(join(process.env.RECENSE_HOME as string, "install-errors-")));
  const install = join(root, "mise/installs/npm-shllg-recense/0.1.0");
  const { folder, links } = misePackageFixtures(install)[layout];
  const entry = join(folder, "dist/recense.mjs");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "@shllg/recense" }));
  for (const [target, link] of links) {
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link);
  }
  return { install, folder, entry };
}

test.each(["EACCES", "ENOENT", "ENOTDIR"])("aube falls back only for a missing candidate (%s)", async (code) => {
  const { install, folder, entry } = await fixture("aube");
  const fallback = join(install, "5", pkg);
  await mkdir(dirname(fallback), { recursive: true });
  await symlink(folder, fallback);
  failure = { operation: "realpath", path: join(install, pkg), code };

  expect(await detectInstall(entry)).toEqual(
    code === "EACCES" ? { kind: "unknown" } : { kind: "mise", entry: join(fallback, "dist/recense.mjs") },
  );
});

test.each(["EACCES", "ENOENT", "ENOTDIR"])("v11 listings skip only missing children (%s)", async (code) => {
  const { install } = await fixture("pnpm11");
  const link = join(install, "v11", "f".repeat(64));
  const perInstall = join(await realpath(link), pkg);
  failure = { operation: "lstat", path: link, code };

  expect(await misePackageFolders(install)).toEqual(code === "EACCES" ? undefined : [perInstall]);
});
