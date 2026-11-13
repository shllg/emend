import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  classifyCommit,
  compareVersions,
  lastTag,
  localDate,
  plan,
  ReleaseError,
  releaseSource,
  SHIPPED_PATHS,
  stampPluginManifests,
  stampVersion,
  versionedManifestText,
} from "./release.ts";

const CLI_JSON = '{\r\n    "name": "@shllg/emend",\r\n    "version" : "0.1.0",\r\n    "other": "0.1.0"\r\n}\r\n';
const VERSION_TS = '// Version.\r\nexport const VERSION = "0.1.0";\r\nexport const OTHER = "0.1.0";\r\n';
let counter = 0;

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
}

function write(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function commit(root: string, subject: string, file = "apps/emend/change.ts", body?: string): void {
  write(root, file, `${++counter}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", subject, ...(body ? ["-m", body] : []));
}

function fixture(t: TestContext, tagged = true): string {
  const root = mkdtempSync(join(tmpdir(), "emend-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  write(root, "apps/emend/package.json", CLI_JSON);
  write(root, "apps/emend/src/version.ts", VERSION_TS);
  write(root, "packages/contract/src/api.ts", 'export const MIN_CLIENT_VERSION = "0.1.0";\n');
  write(root, "plugin/.claude-plugin/plugin.json", '{"name":"emend"}\n');
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./release.ts", import.meta.url), join(root, "scripts/release.ts"));
  commit(root, "chore: start");
  if (tagged) git(root, "tag", "v0.1.0");
  git(root, "update-ref", "refs/remotes/origin/release", "HEAD");
  return root;
}

function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  // Files also capture child output on runners where Node's pipe handles are unavailable.
  const capture = mkdtempSync(join(tmpdir(), "emend-release-output-"));
  const stdout = openSync(join(capture, "stdout"), "w");
  const stderr = openSync(join(capture, "stderr"), "w");
  try {
    const registry = join(capture, "registry.mjs");
    writeFileSync(
      registry,
      `const published = ${JSON.stringify(lastTag(root)?.slice(1))};
globalThis.fetch = async (url) => new Response(null, { status: String(url).endsWith("/" + published) ? 200 : 404 });
`,
    );
    const result = spawnSync(process.execPath, ["--import", registry, join(root, "scripts/release.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", stdout, stderr],
      env: { ...process.env, GITHUB_OUTPUT: "", ...env },
    });
    assert.ifError(result.error);
    return {
      status: result.status,
      stdout: readFileSync(join(capture, "stdout"), "utf8"),
      stderr: readFileSync(join(capture, "stderr"), "utf8"),
    };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
    rmSync(capture, { recursive: true, force: true });
  }
}

function run(root: string, bump: "auto" | "patch" | "minor" = "auto") {
  return plan({ root, bump, date: "2026-11-05", isPublished: async (version) => version === lastTag(root)?.slice(1) });
}

test("nothing to release writes only release=false, leaving the checkout alone", (t) => {
  const root = fixture(t);
  const before = git(root, "status", "--porcelain");
  const result = cli(root, ["plan", "--bump", "auto"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "release: nothing to release since v0.1.0\n");
  assert.equal(git(root, "status", "--porcelain"), before);
  const output = join(root, "output");
  const notes = join(root, "notes.md");
  assert.equal(cli(root, ["plan", "--notes", notes], { GITHUB_OUTPUT: output }).status, 0);
  assert.equal(readFileSync(output, "utf8"), "release=false\n");
  assert(!existsSync(notes));
});

test("test/ci commits, even breaking ones, and non-shipped paths do not count", async (t) => {
  const root = fixture(t);
  commit(root, "test(cli)!: test only");
  commit(root, "ci: pipeline only", "package.json", "BREAKING CHANGE: test footer");
  for (const path of [
    "scripts/tool.ts",
    "docs/releasing.md",
    "sync/example.md",
    "README.md.backup",
    "apps/web-old/x",
  ]) {
    commit(root, "feat: internal work", path);
  }
  assert.equal((await run(root)).release, false);
});

for (const [subject, body, expected] of [
  ["fix(cli): repair launch", "", "0.1.1"],
  ["perf: reduce work", "", "0.1.1"],
  ["chore: maintenance", "", "0.1.1"],
  ["feat(cli): add option", "", "0.2.0"],
  ["fix!: change behavior", "", "0.2.0"],
  ["refactor(core)!: change shape", "", "0.2.0"],
  ["fix: change behavior", "BREAKING CHANGE: new behavior", "0.2.0"],
  ["Change behavior", "BREAKING CHANGE: new behavior", "0.2.0"],
]) {
  test(`${subject} selects ${expected}`, async (t) => {
    const root = fixture(t);
    commit(root, subject, undefined, body);
    assert.equal((await run(root)).version, expected);
    assert.equal(git(root, "status", "--porcelain"), "");
  });
}

test("manual overrides choose minor or patch, except patch refuses breaking changes", async (t) => {
  const root = fixture(t);
  commit(root, "feat: new option");
  assert.equal((await run(root, "patch")).version, "0.1.1");
  assert.equal((await run(root, "minor")).version, "0.2.0");
  commit(root, "fix: breaking", undefined, "BREAKING CHANGE: changed option");
  const result = cli(root, ["plan", "--bump", "patch"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^release: a breaking change requires a minor bump\n$/);
});

test("each shipped path counts, including the root packing hook", async (t) => {
  for (const path of SHIPPED_PATHS) {
    const root = fixture(t);
    commit(root, "fix: shipped", path.endsWith("/") ? `${path}change.txt` : path);
    assert.equal((await run(root)).version, "0.1.1", path);
  }
});

test("renaming a shipped file outside the shipped paths still counts", async (t) => {
  const root = fixture(t);
  git(root, "mv", "apps/emend/change.ts", "internal.txt");
  git(root, "commit", "-q", "-m", "fix: remove shipped file");
  assert.equal((await run(root)).version, "0.1.1");
});

test("a merge retains shipped commits and their feature classification", async (t) => {
  const root = fixture(t);
  git(root, "checkout", "-q", "-b", "feature");
  commit(root, "feat: merged feature");
  git(root, "checkout", "-q", "main");
  commit(root, "ci: workflow", "internal.txt");
  git(root, "merge", "--no-ff", "-m", "Merge feature", "feature");
  assert.equal((await run(root)).version, "0.2.0");
});

test("a merge wrapper cannot turn shipped test/ci changes into a release", async (t) => {
  const root = fixture(t);
  git(root, "checkout", "-q", "-b", "tests");
  commit(root, "test(cli)!: cover changed behavior");
  commit(root, "ci: adjust shipped metadata", "package.json");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-m", "feat!: merge testing changes", "tests");
  assert.equal((await run(root)).release, false);
  assert.equal((await run(root, "patch")).release, false);
});

test("a feature merge wrapper does not upgrade a shipped fix to minor", async (t) => {
  const root = fixture(t);
  git(root, "checkout", "-q", "-b", "fix");
  commit(root, "fix: repair launch");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-m", "feat!: merge repair", "fix");
  const result = await run(root);
  assert.equal(result.version, "0.1.1");
  assert(!result.section?.includes("merge repair"));
});

test("previous is the highest merged plain tag, regardless of tag creation order", async (t) => {
  const root = fixture(t);
  git(root, "tag", "v0.9.0");
  git(root, "tag", "v0.2.0");
  git(root, "tag", "v9.0.0-rc.1");
  git(root, "tag", "v9.0.0+build");
  git(root, "tag", "v01.0.0");
  git(root, "checkout", "-q", "-b", "other");
  commit(root, "feat: unrelated");
  git(root, "tag", "v3.0.0");
  git(root, "checkout", "-q", "main");
  commit(root, "fix: shipped");
  assert.equal(lastTag(root), "v0.9.0");
  assert.equal((await run(root)).version, "0.9.1");
});

test("no previous tag refuses with exit 1 and a single release line", (t) => {
  const root = fixture(t, false);
  const result = cli(root, ["plan"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^release: no plain v<x.y.z> tag is merged into HEAD\n$/);
});

test("an existing target tag on another branch refuses", async (t) => {
  const root = fixture(t);
  git(root, "checkout", "-q", "-b", "other");
  commit(root, "fix: unrelated");
  git(root, "tag", "v0.1.1");
  git(root, "checkout", "-q", "main");
  commit(root, "fix: shipped");
  await assert.rejects(() => run(root), /release: the tag v0.1.1 already exists/);
});

for (const [minimum, reason] of [
  ["0.3.0", "is greater than 0.1.1"],
  ["0.1.1", "already-released"],
  ["0.1.0-beta", "plain version"],
]) {
  test(`MIN_CLIENT_VERSION guard: ${minimum}`, async (t) => {
    const root = fixture(t);
    write(root, "packages/contract/src/api.ts", `export const MIN_CLIENT_VERSION = "${minimum}";\n`);
    commit(root, "fix: change minimum");
    await assert.rejects(() => run(root), new RegExp(`release: MIN_CLIENT_VERSION.*${reason}`));
  });
}

test("notes contain only counted commits; GITHUB_OUTPUT appends the four values", (t) => {
  const root = fixture(t);
  commit(root, "feat(ui): a new view");
  commit(root, "fix(cli): launch safely");
  commit(root, "feat: internal only", "scripts/internal.ts");
  commit(root, "test!: tests only");
  const notes = join(root, "notes.md");
  const output = join(root, "output");
  writeFileSync(output, "existing=value\n");
  const result = cli(root, ["plan", "--notes", notes], { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(output, "utf8"),
    `existing=value\nrelease=true\nresume=false\nversion=0.2.0\nprevious=v0.1.0\nsha=${git(root, "rev-parse", "HEAD").trim()}\n`,
  );
  assert.match(
    readFileSync(notes, "utf8"),
    /^## 0\.2\.0 \(\d{4}-\d{2}-\d{2}\)\n\n### Features\n\n- a new view \(ui\)\n\n### Fixes\n\n- launch safely \(cli\)\n$/,
  );
});

test("stamp preserves every byte outside the two version literals", (t) => {
  const root = fixture(t);
  stampVersion(root, "0.12.3");
  assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), CLI_JSON.replace('"0.1.0"', '"0.12.3"'));
  assert.equal(
    readFileSync(join(root, "apps/emend/src/version.ts"), "utf8"),
    VERSION_TS.replace('"0.1.0"', '"0.12.3"'),
  );
  assert.equal(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"), '{"name":"emend"}\n');
});

for (const version of [
  "1.2",
  "v1.2.3",
  "1.2.3-beta.1",
  "1.2.3+build",
  "01.2.3",
  "1.02.3",
  "1.2.03",
  "1.2.3\n",
  "1.2.3\r",
]) {
  test(`stamp refuses ${JSON.stringify(version)} before writing`, (t) => {
    const root = fixture(t);
    const result = cli(root, ["stamp", version]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^release: version must be plain x.y.z\n$/);
    assert.equal(git(root, "status", "--porcelain"), "");
  });
}

for (const source of ["// missing\n", 'export const VERSION = "0.1.0";\nexport const VERSION = "0.1.0";\n']) {
  test(`stamp refuses missing/duplicate VERSION lines without changing the manifest`, (t) => {
    const root = fixture(t);
    write(root, "apps/emend/src/version.ts", source);
    assert.throws(() => stampVersion(root, "0.2.0"), /exactly one/);
    assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), CLI_JSON);
    assert.equal(readFileSync(join(root, "apps/emend/src/version.ts"), "utf8"), source);
  });
}

test("stamp refuses a nested first version instead of modifying the wrong key", (t) => {
  const root = fixture(t);
  const manifest = '{"nested":{"version":"0.1.0"},"version":"0.1.0"}';
  write(root, "apps/emend/package.json", manifest);
  assert.throws(() => stampVersion(root, "0.2.0"), /top-level version/);
  assert.equal(readFileSync(join(root, "apps/emend/package.json"), "utf8"), manifest);
});

const PLUGIN_MANIFEST = "plugin/.claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

test("repository manifests gain exactly one version line after the top-level name", (t) => {
  const root = fixture(t);
  for (const [file, url] of [
    [PLUGIN_MANIFEST, new URL("../plugin/.claude-plugin/plugin.json", import.meta.url)],
    [MARKETPLACE_MANIFEST, new URL("../.claude-plugin/marketplace.json", import.meta.url)],
  ] as const) {
    const original = readFileSync(url, "utf8");
    write(root, file, original);
    const expected = original.replace('  "name": "emend",\n', '  "name": "emend",\n  "version": "0.3.0",\n');
    assert.notEqual(expected, original);
    assert.equal(versionedManifestText(root, file, "0.3.0"), expected);
    assert.equal(readFileSync(join(root, file), "utf8"), original);
  }
});

for (const [style, original, expected] of [
  [
    "CRLF and tabs",
    '{\r\n\t"name" : "emend",\r\n\t"owner": {"name":"x"}\r\n}\r\n',
    '{\r\n\t"name" : "emend",\r\n\t"version": "0.3.0",\r\n\t"owner": {"name":"x"}\r\n}\r\n',
  ],
  ["compact JSON", '{"name":"emend"}\n', '{"name":"emend","version": "0.3.0"}\n'],
  [
    "escaped name strings",
    '{"name":"e\\\"mend","other":true}',
    '{"name":"e\\\"mend","version": "0.3.0","other":true}',
  ],
]) {
  test(`manifest stamping preserves ${style}`, (t) => {
    const root = fixture(t);
    write(root, PLUGIN_MANIFEST, original);
    assert.equal(versionedManifestText(root, PLUGIN_MANIFEST, "0.3.0"), expected);
  });
}

for (const version of ['"0.1.0"', "null", "false"]) {
  test(`manifest stamping refuses an existing top-level version of ${version}`, (t) => {
    const root = fixture(t);
    write(root, PLUGIN_MANIFEST, `{"name":"emend","version":${version}}`);
    assert.throws(() => versionedManifestText(root, PLUGIN_MANIFEST, "0.3.0"), {
      message: `release: ${PLUGIN_MANIFEST} must carry no version`,
    });
  });
}

test("manifest stamping refuses a nested first name instead of changing the wrong object", (t) => {
  const root = fixture(t);
  write(root, PLUGIN_MANIFEST, '{"owner":{"name":"x"},"name":"emend"}');
  assert.throws(
    () => versionedManifestText(root, PLUGIN_MANIFEST, "0.3.0"),
    (error) =>
      error instanceof ReleaseError &&
      error.message === `release: could not set the top-level version in ${PLUGIN_MANIFEST}`,
  );
});

test("manifest stamping writes both outputs and leaves checkout files unchanged", (t) => {
  const root = fixture(t);
  write(root, MARKETPLACE_MANIFEST, '{"name":"emend","plugins":[{"name":"emend","source":"./plugin"}]}\n');
  const before = [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST].map((file) => readFileSync(join(root, file), "utf8"));
  const out = join(root, "output/manifests");
  stampPluginManifests(root, "0.3.0", out);
  for (const [i, file] of [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST].entries()) {
    assert.equal(readFileSync(join(root, file), "utf8"), before[i]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, basename(file)), "utf8")), {
      ...JSON.parse(before[i]),
      version: "0.3.0",
    });
  }
});

for (const invalid of [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST]) {
  test(`invalid ${invalid} prevents either manifest output from being written`, (t) => {
    const root = fixture(t);
    write(root, MARKETPLACE_MANIFEST, '{"name":"emend"}\n');
    write(root, invalid, "{invalid JSON");
    const out = join(root, "output");
    assert.throws(() => stampPluginManifests(root, "0.3.0", out), ReleaseError);
    assert(!existsSync(join(out, "plugin.json")));
    assert(!existsSync(join(out, "marketplace.json")));
    assert(!existsSync(out));
  });
}

test("manifest stamping refuses non-plain versions before writing", (t) => {
  const root = fixture(t);
  const out = join(root, "output");
  for (const version of ["v0.3.0", "0.3.0-beta", "0.3.0+build", "00.3.0", "0.3.0\n"]) {
    assert.throws(() => stampPluginManifests(root, version, out), {
      message: "release: version must be plain x.y.z",
    });
  }
  assert(!existsSync(out));
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("the manifests command writes both stamped files and exits successfully", (t) => {
  const root = fixture(t);
  write(root, MARKETPLACE_MANIFEST, '{"name":"emend"}\n');
  const out = join(root, "output");
  const result = cli(root, ["manifests", "0.3.0", out]);
  assert.equal(result.status, 0, result.stderr);
  for (const file of ["plugin.json", "marketplace.json"]) {
    assert.equal(readFileSync(join(out, file), "utf8"), '{"name":"emend","version": "0.3.0"}\n');
  }
});

test("usage errors exit 2", (t) => {
  const root = fixture(t);
  for (const args of [
    [],
    ["unknown"],
    ["stamp"],
    ["stamp", "0.1.1", "extra"],
    ["manifests"],
    ["manifests", "0.3.0"],
    ["manifests", "0.3.0", "output", "extra"],
    ["manifests", "--version", "output"],
    ["manifests", "0.3.0", "--output"],
    ["plan", "--bump"],
    ["plan", "--bump", "major"],
    ["plan", "--notes"],
    ["plan", "--unknown", "x"],
    ["plan", "--bump", "auto", "--bump", "minor"],
  ]) {
    const result = cli(root, args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^Usage: node scripts\/release.ts /);
  }
});

test("helpers preserve date, classification and numeric ordering", () => {
  assert.equal(localDate(new Date(2026, 0, 2, 12)), "2026-01-02");
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.0", "1.0.0"), -1);
  assert.equal(classifyCommit("fix(cli): launch", "")?.line, "- launch (cli)");
});

function pendingRelease(t: TestContext) {
  const root = fixture(t);
  git(root, "tag", "v0.0.9");
  commit(root, "fix(cli): recover this release");
  git(root, "checkout", "-q", "-b", "tests");
  commit(root, "test!: excluded tests", "apps/emend/recovery.test.ts");
  commit(root, "ci: excluded pipeline", "packages/pipeline.txt");
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-m", "feat!: excluded merge wrapper", "tests");
  commit(root, "feat: excluded internal tooling", "scripts/internal.ts");
  git(root, "tag", "-a", "v0.1.1", "-m", "Synthetic release");
  const sha = git(root, "rev-parse", "HEAD").trim();
  git(root, "tag", "v0.2.0-rc.1");
  return { root, sha };
}

function stampRelease(root: string, source: string, version: string, previous?: string): string {
  const original = readFileSync(join(root, PLUGIN_MANIFEST), "utf8");
  try {
    git(root, "read-tree", source);
    const manifest = JSON.parse(git(root, "show", `${source}:${PLUGIN_MANIFEST}`));
    write(root, PLUGIN_MANIFEST, JSON.stringify({ ...manifest, version }));
    git(root, "add", PLUGIN_MANIFEST);
    const tree = git(root, "write-tree").trim();
    const stamp = git(
      root,
      "commit-tree",
      tree,
      "-p",
      source,
      ...(previous ? ["-p", previous] : []),
      "-m",
      `chore: stamp ${version}`,
    ).trim();
    git(root, "update-ref", "refs/remotes/origin/release", stamp);
    return stamp;
  } finally {
    git(root, "read-tree", "HEAD");
    write(root, PLUGIN_MANIFEST, original);
  }
}

test("a stamp of the newest tag permits planning a new release", async (t) => {
  const root = fixture(t);
  const first = git(root, "rev-parse", "HEAD").trim();
  const previous = stampRelease(root, first, "0.1.0");
  assert.equal(git(root, "show", "-s", "--format=%P", previous).trim(), first);
  commit(root, "fix: next release");
  git(root, "tag", "v0.1.1");
  const tagged = git(root, "rev-parse", "HEAD").trim();
  const stamp = stampRelease(root, tagged, "0.1.1", previous);
  assert.equal(git(root, "show", "-s", "--format=%P", stamp).trim(), `${tagged} ${previous}`);
  assert.equal(releaseSource(root, stamp), tagged);
  commit(root, "feat: next feature");
  const result = await run(root);
  assert.equal(result.resume, false);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.sha, git(root, "rev-parse", "HEAD").trim());
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a published newest tag resumes when release is the previous tag's stamp", async (t) => {
  const { root, sha } = pendingRelease(t);
  stampRelease(root, git(root, "rev-parse", "v0.1.0").trim(), "0.1.0");
  commit(root, "feat: later work must wait");
  const result = await plan({ root, isPublished: async () => true });
  assert.equal(result.resume, true);
  assert.equal(result.version, "0.1.1");
  assert.equal(result.sha, sha);
  assert(!result.section?.includes("later work"));
});

for (const mode of ["new", "resume"] as const) {
  test(`${mode} planning refuses a stamp whose source is ahead of HEAD`, async (t) => {
    const root = mode === "resume" ? pendingRelease(t).root : fixture(t);
    if (mode === "new") commit(root, "fix: candidate");
    const sha = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "-b", "later-release");
    commit(root, "fix: already released");
    stampRelease(root, git(root, "rev-parse", "HEAD").trim(), "0.2.0");
    git(root, "checkout", "-q", "main");
    await assert.rejects(
      plan({ root, isPublished: async () => mode === "new" }),
      (error) =>
        error instanceof ReleaseError &&
        error.message === `release: refs/remotes/origin/release is ahead of or diverged from ${sha}; refusing a stale release`,
    );
  });
}

test("a legacy release commit without a plugin manifest remains its own source", async (t) => {
  const root = fixture(t);
  git(root, "rm", PLUGIN_MANIFEST);
  commit(root, "fix: legacy release");
  const released = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-ref", "refs/remotes/origin/release", released);
  assert.equal(releaseSource(root, released), released);
  commit(root, "fix: later work");
  assert.equal((await run(root)).version, "0.1.1");
});

test("invalid JSON at the release head refuses planning", async (t) => {
  const root = fixture(t);
  write(root, PLUGIN_MANIFEST, "{invalid JSON");
  commit(root, "fix: invalid release manifest");
  git(root, "update-ref", "refs/remotes/origin/release", "HEAD");
  await assert.rejects(run(root), (error) => error instanceof ReleaseError && /not valid JSON/.test(error.message));
});

test("a versioned release commit without a parent is refused", (t) => {
  const root = fixture(t);
  write(root, PLUGIN_MANIFEST, '{"name":"emend","version":"0.1.0"}');
  git(root, "add", PLUGIN_MANIFEST);
  const tree = git(root, "write-tree").trim();
  const orphan = git(root, "commit-tree", tree, "-m", "chore: orphan stamp").trim();
  assert.throws(
    () => releaseSource(root, orphan),
    (error) => error instanceof ReleaseError && /no first parent/.test(error.message),
  );
});

test("a published tag contained by release plans new shipped commits normally", async (t) => {
  const { root, sha } = pendingRelease(t);
  commit(root, "chore: later release branch commit", "internal.txt");
  git(root, "update-ref", "refs/remotes/origin/release", "HEAD");
  commit(root, "feat: a later feature");
  const checked: string[] = [];
  const result = await plan({
    root,
    isPublished: async (version) => {
      checked.push(version);
      return version === "0.1.1";
    },
  });
  assert.deepEqual(checked, ["0.1.1", "0.2.0"]);
  assert.equal(result.resume, false);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.previous, "v0.1.1");
  assert.notEqual(result.sha, sha);
  assert.equal(result.sha, git(root, "rev-parse", "HEAD").trim());
  assert.match(result.section ?? "", /a later feature/);
  assert(!result.section?.includes("recover this release"));
});

for (const bump of ["auto", "patch", "minor"] as const) {
  test(`an unpublished tag resumes its peeled commit and ignores --bump ${bump}`, async (t) => {
    const { root, sha } = pendingRelease(t);
    const output = join(root, "output");
    const notes = join(root, "notes.md");
    const lines: string[] = [];
    const result = await plan({
      root,
      bump,
      notes,
      output,
      date: "2026-11-05",
      stdout: (line) => lines.push(line),
      isPublished: async (version) => {
        assert.equal(version, "0.1.1");
        return false;
      },
    });
    assert.deepEqual(result, {
      release: true,
      resume: true,
      version: "0.1.1",
      previous: "v0.1.0",
      sha,
      section: "## 0.1.1 (2026-11-05)\n\n### Fixes\n\n- recover this release (cli)\n",
    });
    assert.notEqual(result.sha, git(root, "rev-parse", "refs/tags/v0.1.1").trim(), "peel the annotated tag");
    assert.equal(readFileSync(notes, "utf8"), result.section);
    assert.equal(
      readFileSync(output, "utf8"),
      `release=true\nresume=true\nversion=0.1.1\nprevious=v0.1.0\nsha=${sha}\n`,
    );
    const ignored = bump === "auto" ? "" : `; --bump ${bump} ignored when resuming`;
    assert.deepEqual(lines, [`release: resumes v0.1.1 at ${sha} since v0.1.0${ignored}`]);
  });
}

test("a published tag resumes when release is behind, with no new commits", async (t) => {
  const { root, sha } = pendingRelease(t);
  const result = await plan({ root, isPublished: async () => true });
  assert.equal(result.release, true);
  assert.equal(result.version, "0.1.1");
  assert.equal(result.previous, "v0.1.0");
  assert.equal(result.sha, sha);
});

test("CLI awaits the registry check and emits a resume for a published tag with release behind", (t) => {
  const { root, sha } = pendingRelease(t);
  const result = cli(root, ["plan", "--bump", "minor"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^release: resumes v0\.1\.1 /);
  assert(result.stdout.includes(sha));
  assert(result.stdout.includes("--bump minor ignored"));
});

test("a custom release ref is used instead of origin/release", async (t) => {
  const { root } = pendingRelease(t);
  git(root, "update-ref", "refs/heads/published", "HEAD");
  const result = await plan({ root, releaseRef: "refs/heads/published", isPublished: async () => true });
  assert.equal(result.release, false);
});

for (const published of [true, false]) {
  test(`a missing release ref refuses instead of resuming (published=${published})`, async (t) => {
    const { root } = pendingRelease(t);
    git(root, "update-ref", "-d", "refs/remotes/origin/release");
    await assert.rejects(plan({ root, isPublished: async () => published }), {
      name: "Error",
      message: "release: release ref refs/remotes/origin/release is missing or invalid",
    });
  });
}

test("a registry callback error refuses without writing outputs or notes", async (t) => {
  const { root } = pendingRelease(t);
  const output = join(root, "output");
  const notes = join(root, "notes.md");
  await assert.rejects(
    plan({
      root,
      notes,
      output,
      isPublished: async () => {
        throw new Error("network unavailable");
      },
    }),
    (error) => error instanceof ReleaseError && /^release: could not check npm/.test(error.message),
  );
  assert(!existsSync(output));
  assert(!existsSync(notes));
});

test("the first tag refuses to resume without an earlier plain tag", async (t) => {
  const root = fixture(t, false);
  commit(root, "fix: first release");
  git(root, "tag", "v0.1.0");
  await assert.rejects(
    plan({ root, isPublished: async () => false }),
    (error) => error instanceof ReleaseError && /cannot resume v0\.1\.0: no earlier plain tag/.test(error.message),
  );
});

for (const status of [200, 404, 302, 403, 429, 503]) {
  test(`the default npm query treats HTTP ${status} explicitly`, async (t) => {
    const { root, sha } = pendingRelease(t);
    if (status !== 404) git(root, "update-ref", "refs/remotes/origin/release", sha);
    const query = t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "https://registry.npmjs.org/@shllg%2Femend/0.1.1");
      assert.equal(options.redirect, "manual");
      assert(options.signal instanceof AbortSignal);
      return new Response(null, { status });
    });
    if (status === 200 || status === 404) {
      assert.equal((await plan({ root })).release, status === 404);
    } else {
      await assert.rejects(
        plan({ root }),
        (error) => error instanceof ReleaseError && error.message.includes(`npm returned HTTP ${status}`),
      );
    }
    assert.equal(query.mock.callCount(), 1);
  });
}

test("a default npm query network error is a refusal", async (t) => {
  const { root } = pendingRelease(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    plan({ root }),
    (error) => error instanceof ReleaseError && /^release: could not check npm/.test(error.message),
  );
});

test("merge-base errors are refusals, never interpreted as release lag", async (t) => {
  const { root } = pendingRelease(t);
  const spawn = t.mock.method(childProcess, "spawnSync", () => ({ status: 128 }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      plan({ root, isPublished: async () => false }),
      (error) => error instanceof ReleaseError && /^release: could not check whether/.test(error.message),
    );
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

for (const mode of ["new", "resume"] as const) {
  for (const relation of ["ahead", "diverged"] as const) {
    test(`${mode} planning refuses a release ref ${relation} from its planned commit`, async (t) => {
      const root = mode === "resume" ? pendingRelease(t).root : fixture(t);
      if (mode === "new") commit(root, "fix: new release candidate");
      const sha = git(root, "rev-parse", "HEAD").trim();
      git(root, "checkout", "-q", "-b", "release-work", relation === "ahead" ? sha : "v0.1.0");
      commit(root, "fix: code already released", "apps/emend/released.ts");
      const releaseRef = "refs/heads/released";
      git(root, "update-ref", releaseRef, "HEAD");
      git(root, "checkout", "-q", "main");
      const output = join(root, "output");
      const notes = join(root, "notes.md");
      await assert.rejects(
        plan({ root, releaseRef, output, notes, isPublished: async () => mode === "new" }),
        (error) =>
          error instanceof ReleaseError &&
          error.message === `release: ${releaseRef} is ahead of or diverged from ${sha}; refusing a stale release`,
      );
      assert(!existsSync(output));
      assert(!existsSync(notes));
    });
  }
}

test("a new version can advance from a release ref equal to the planned commit", async (t) => {
  const root = fixture(t);
  commit(root, "fix: current release branch");
  git(root, "update-ref", "refs/remotes/origin/release", "HEAD");
  const result = await run(root);
  assert.equal(result.resume, false);
  assert.equal(result.version, "0.1.1");
  assert.equal(result.sha, git(root, "rev-parse", "HEAD").trim());
});

test("an unpublished tag already held by release is refused", async (t) => {
  const { root, sha } = pendingRelease(t);
  git(root, "update-ref", "refs/remotes/origin/release", sha);
  await assert.rejects(
    plan({ root, isPublished: async () => false }),
    (error) =>
      error instanceof ReleaseError &&
      error.message === "release: release already holds v0.1.1's commit but npm lacks 0.1.1",
  );
});

test("an unpublished tag cannot be published from a later HEAD because of provenance", async (t) => {
  const { root } = pendingRelease(t);
  commit(root, "feat: later work");
  await assert.rejects(
    plan({ root, isPublished: async () => false }),
    (error) =>
      error instanceof ReleaseError &&
      error.message ===
        "release: v0.1.1 is tagged but not on npm; publish it from a run at its commit (re-run the failed jobs of the run that tagged it) or push a higher lightweight tag at main's HEAD and start the workflow",
  );
});

test("a published tag can resume marking from a later HEAD", async (t) => {
  const { root, sha } = pendingRelease(t);
  commit(root, "feat!: later work must wait");
  const result = await plan({ root, isPublished: async () => true });
  assert.equal(result.resume, true);
  assert.equal(result.sha, sha);
  assert.equal(result.version, "0.1.1");
  assert(!result.section?.includes("later work"));
});

test("a new version already present on npm refuses before writing outputs", async (t) => {
  const root = fixture(t);
  commit(root, "fix: new work");
  const checked: string[] = [];
  const output = join(root, "output");
  await assert.rejects(
    plan({
      root,
      output,
      isPublished: async (version) => {
        checked.push(version);
        return true;
      },
    }),
    (error) => error instanceof ReleaseError && error.message === "release: npm already has 0.1.1",
  );
  assert.deepEqual(checked, ["0.1.0", "0.1.1"]);
  assert(!existsSync(output));
});

test("a registry error when checking a new version is a refusal", async (t) => {
  const root = fixture(t);
  commit(root, "fix: new work");
  await assert.rejects(
    plan({
      root,
      isPublished: async (version) => {
        if (version === "0.1.0") return true;
        throw new Error("registry unavailable");
      },
    }),
    (error) => error instanceof ReleaseError && error.message === "release: could not check npm for @shllg/emend@0.1.1",
  );
});

for (const mode of ["new", "resume"] as const) {
  test(`${mode} planning refuses errors in the reverse ancestry check`, async (t) => {
    const root = mode === "new" ? fixture(t) : pendingRelease(t).root;
    if (mode === "new") commit(root, "fix: new work");
    const planned = git(root, "rev-parse", "HEAD").trim();
    const released = git(root, "rev-parse", "refs/remotes/origin/release").trim();
    const original = childProcess.spawnSync;
    const calls: string[][] = [];
    const spawn = t.mock.method(childProcess, "spawnSync", (program, args, options) => {
      calls.push(args);
      if (calls.length === 2) return { status: 128 };
      return original(program, args, options);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        plan({ root, isPublished: async () => mode === "new" }),
        (error) => error instanceof ReleaseError && /^release: could not check whether/.test(error.message),
      );
      assert.deepEqual(calls[1], ["-C", root, "merge-base", "--is-ancestor", released, planned]);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  });
}
