import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_FONTS } from "../apps/web/src/lib/built-in-fonts.ts";
import { cleanPackageDocs } from "./package-docs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = join(root, "apps/recense");
let temporary: string | undefined;
let check = "create temporary folder";
let failed: string | undefined;

try {
  temporary = mkdtempSync(join(tmpdir(), "recense-check-package-"));
  const work = realpathSync(temporary);
  const pack = join(work, "pack");
  mkdirSync(pack);
  const command = (label: string, program: string, args: string[], cwd = work, env = process.env) => {
    check = label;
    return execFileSync(program, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
  };
  // `--tarball <path>` checks that exact file instead of packing a new one.
  const flag = process.argv.indexOf("--tarball");
  let tarball: string;
  if (flag === -1) {
    command("pnpm pack", "pnpm", ["pack", "--pack-destination", pack], pkg);
    check = "packed tarball";
    const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    tarball = join(pack, tarballs[0]);
  } else {
    check = "--tarball path";
    const given = process.argv[flag + 1];
    assert(given && !given.startsWith("-") && process.argv.length === flag + 2);
    tarball = resolve(given);
  }
  const entries = new Set(command("tarball contents", "tar", ["-tzf", tarball]).trim().split(/\r?\n/));
  const allowed = new Set([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/bin/recense",
    "package/bin/emend",
    "package/dist/recense.mjs",
    "package/dist/publish-worker.mjs",
  ]);
  for (const name of entries) {
    check = `tarball excludes the theme skill ${JSON.stringify(name)}`;
    assert(!name.includes("recense-theme"));
    const permitted =
      allowed.has(name) || name.startsWith("package/dist/web/") || name.startsWith("package/dist/skills/");
    if (!permitted || name.startsWith("package/dist/web/.vite/") ||
        name.endsWith(".map") || name.split("/").some((part) => part === "." || part === "..")) {
      check = `unexpected tarball entry ${JSON.stringify(name)}`;
      throw new Error("not allowed");
    }
    check = `tarball excludes obsolete fonts ${JSON.stringify(name)}`;
    assert(
      !/^package\/dist\/web\/(?:licenses\/(?:hanken-grotesk|martian-mono)-OFL\.txt$|assets\/(?:.*\/)?(?:hanken-grotesk|martian-mono)-)/.test(name),
    );
  }
  for (const name of [
    "README.md",
    "LICENSE",
    "bin/recense",
    "bin/emend",
    "dist/recense.mjs",
    "dist/publish-worker.mjs",
    "dist/web/index.html",
    "dist/web/pub-frame.css",
    "dist/skills/recense-review/SKILL.md",
    "dist/skills/recense-review/references/writing.md",
    "dist/skills/recense-feedback/SKILL.md",
    "dist/skills/recense-publish/SKILL.md",
  ]) {
    check = `tarball includes ${name}`;
    assert(entries.has(`package/${name}`));
  }
  for (const { slug } of BUILT_IN_FONTS) {
    const name = `dist/web/licenses/${slug}-OFL.txt`;
    check = `tarball includes ${name}`;
    assert(entries.has(`package/${name}`));
  }
  const extracted = join(work, "extracted");
  mkdirSync(extracted);
  command("extract package documents", "tar", [
    "-xzf",
    tarball,
    "-C",
    extracted,
    "package/README.md",
    "package/LICENSE",
    "package/package.json",
  ]);
  for (const name of ["README.md", "LICENSE"]) {
    check = `${name} matches repository root`;
    assert.deepEqual(readFileSync(join(extracted, "package", name)), readFileSync(join(root, name)));
  }

  check = "read packed manifest";
  const manifestText = readFileSync(join(extracted, "package/package.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  check = "packed manifest has no @recense/ references";
  assert(!manifestText.includes("@recense/"));
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    check = `packed manifest has no ${field}`;
    const value = manifest[field];
    assert(!value || (typeof value === "object" && Object.keys(value).length === 0));
  }
  for (const script of ["preinstall", "install", "postinstall", "prepare"]) {
    check = `packed manifest has no ${script} script`;
    assert(!Object.hasOwn(manifest.scripts ?? {}, script));
  }

  check = "read version";
  const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
  const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"));
  check = "plugin.json on main carries no version; the release workflow stamps it on the release branch";
  assert(!Object.hasOwn(plugin, "version"));
  const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  check = "marketplace.json on main carries no version; the release workflow stamps it on the release branch";
  assert(!Object.hasOwn(marketplace, "version"));
  assert(!Object.hasOwn(marketplace.metadata ?? {}, "version"));
  for (const entry of marketplace.plugins) {
    check = "marketplace plugin entries carry no version; plugin.json supplies it on the release branch";
    assert(!Object.hasOwn(entry, "version"));
  }
  const userconfig = join(work, "userconfig");
  const globalconfig = join(work, "globalconfig");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  // Isolate npm's config, cache and install prefix, including config supplied through the environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
  env.RECENSE_HOME = join(work, "state");
  env.HOME = join(work, "home");
  mkdirSync(env.HOME);
  command(
    "offline npm install",
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      work,
      "--cache",
      work,
      "--offline",
      "--userconfig",
      userconfig,
      "--globalconfig",
      globalconfig,
      tarball,
    ],
    work,
    env,
  );
  const installed = join(work, "bin/recense");
  const actualVersion = command("installed recense --version", installed, ["--version"], work, env);
  check = "installed version matches package";
  assert.equal(actualVersion, `recense ${version}\n`);
  // The old command still works: same stdout, one line about the rename on stderr.
  const alias = spawnSync(join(work, "bin/emend"), ["--version"], { cwd: work, env, encoding: "utf8" });
  check = "installed emend alias runs recense";
  assert.equal(alias.status, 0);
  assert.equal(alias.stdout, `recense ${version}\n`);
  assert.equal(
    alias.stderr,
    "emend is now recense: use the recense command. The emend command goes away in a later release.\n",
  );

  const skills = join(work, "skills");
  const output = command(
    "installed skills dry run",
    installed,
    ["skills", "install", "--dry-run", "--dir", skills],
    work,
    env,
  );
  check = "skills link into installed package";
  assert.equal(
    output,
    ["recense-feedback", "recense-publish", "recense-review"]
      .map(
        (name) =>
          `would link ${join(skills, name)} -> ${join(work, "lib/node_modules/@shllg/recense/dist/skills", name)}\n`,
      )
      .join(""),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
  failed = `check:package: ${check} failed (${detail})`;
} finally {
  try {
    cleanPackageDocs(root);
  } catch {
    failed = "check:package: document cleanup failed";
  }
  if (temporary) {
    try {
      rmSync(temporary, { recursive: true, force: true });
    } catch {
      failed = "check:package: cleanup failed";
    }
  }
}

if (failed) {
  console.error(failed);
  process.exitCode = 1;
} else {
  console.log("check:package ok");
}
