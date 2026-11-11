import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib, { brotliCompressSync, crc32, deflateSync } from "node:zlib";
import {
  checkBuffer,
  checkPublic,
  checkPublicPush,
  checkText,
  checkTextSpans,
  loadPrivateTerms,
  type PrivateTerms,
  PublicCheckError,
  readPushDestination,
  ScanBudget,
} from "./check-public.ts";

const script = fileURLToPath(new URL("./check-public.ts", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "public-check-"));
writeFileSync(path.join(root, ".gitconfig"), "[user]\nname = Fixture\nemail = fixture@example.com\n[commit]\ngpgsign = false\n");
const childEnv = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  LC_ALL: "C",
};
const context = process.env.NODE_TEST_CONTEXT;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, childEnv);
if (context !== undefined) process.env.NODE_TEST_CONTEXT = context;
after(() => rmSync(root, { recursive: true, force: true }));

const empty: PrivateTerms = { terms: [], allowed: [], notes: [] };
// Synthetic values are built from parts: neither this source nor the lifecycle hygiene gate matches them.
const home = (name: string, mac = false) => ["/", mac ? "Users" : "home", "/", name, "/file"].join("");
const host = (labels: string) => [labels, "ts", "net"].join(".");
const ip = (...parts: number[]) => parts.join(".");
const email = (local: string, domain: string) => [local, domain].join("@");
const trailer = ["Co-Auth", "ored-By: ", "Test"].join("");
const generated = ["Generated with ", "Claude Code"].join("");
const secret = ["gh", "p_", "A".repeat(36)].join("");
const blockedMail = email("fixture", ["mail", "fixture"].join("."));
const allowMarker = ["check-public:", " allow"].join("");

function check(text: string, attribution = true): string[] {
  return checkText(text, "--text #1", empty, { attribution });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function directory(): string {
  return mkdtempSync(path.join(root, "repo-"));
}
function commit(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
function repo(): string {
  const cwd = directory();
  git(cwd, "init", "--quiet", "-b", "main");
  writeFileSync(path.join(cwd, ".gitignore"), "/.private-terms\nignored.txt\n");
  commit(cwd, "initial");
  const remote = directory();
  git(remote, "init", "--quiet", "--bare", "-b", "main");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "--quiet", "origin", "main");
  git(cwd, "switch", "--quiet", "-c", "feature");
  return cwd;
}
function nodeCaptured(cwd: string, args: string[], env: Record<string, string> = {}) {
  const capture = directory();
  const stdout = path.join(capture, "stdout");
  const stderr = path.join(capture, "stderr");
  const out = openSync(stdout, "w");
  const err = openSync(stderr, "w");
  try {
    const result = spawnSync(process.execPath, args, {
      cwd,
      env: { ...childEnv, ...env },
      stdio: ["ignore", out, err],
      timeout: 19_000,
    });
    assert.ifError(result.error);
    return { status: result.status, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8") };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}) {
  return nodeCaptured(cwd, [script, ...args], env);
}

test("home paths reject real names and accept each placeholder on both platforms", () => {
  for (const mac of [true, false]) {
    assert.deepEqual(check(home("fixture-person", mac)), ["--text #1: real home path"]);
    for (const name of ["someone", "user", "runner"]) assert.deepEqual(check(home(name, mac)), []);
    assert.equal(check(home("runner-extra", mac)).length, 1);
  }
});

test("tailnet hostnames accept exact example labels and angle-bracket placeholders", () => {
  for (const labels of ["fixture", "host.fixture", "HOST.FIXTURE", "notexample", "example-extra"]) {
    assert.deepEqual(check(`https://${host(labels)}:443/`), ["--text #1: tailnet host name"]);
  }
  for (const labels of ["example", "host.example", "<hub>", "host.<tailnet>", "<hub>.<tailnet>"]) {
    assert.deepEqual(check(host(labels)), []);
  }
  assert.equal(check(`${host("example")} ${host("fixture")}`).length, 1);
});

test("IPv4 rules cover all private ranges, edges, and exact placeholder exceptions", () => {
  for (const parts of [
    [10, 0, 0, 0],
    [10, 255, 255, 255],
    [172, 16, 0, 0],
    [172, 31, 255, 255],
    [192, 168, 0, 0],
    [100, 64, 0, 0],
    [100, 127, 255, 255],
  ]) {
    assert.deepEqual(check(ip(...parts)), ["--text #1: private or tailnet IPv4 address (use 192.0.2.x or 2001:db8:: for documentation)"]);
  }
  for (const parts of [
    [10, 1, 2, 3],
    [100, 64, 0, 1],
    [100, 100, 100, 100],
    [172, 15, 255, 255],
    [172, 32, 0, 0],
    [100, 63, 255, 255],
    [100, 128, 0, 0],
    [192, 167, 1, 1],
    [127, 0, 0, 1],
    [10, 256, 0, 1],
  ]) {
    assert.deepEqual(check(ip(...parts)), []);
  }
  assert.equal(check(ip(10, 1, 2, 30)).length, 1);
});

test("email rules accept reserved domains and their subdomains", () => {
  for (const domain of [
    "example.com",
    "example.org",
    "example.net",
    "sub.example.com",
    "sub.example.org",
    "deep.sub.example.net",
    "team.test",
    "team.invalid",
    "team.example",
    "team.localhost",
    "deep.team.test",
    "deep.team.invalid",
    "deep.team.example",
    "deep.team.localhost",
    "example.com.invalid",
  ]) {
    assert.deepEqual(check(email("Fixture", domain.toUpperCase())), []);
  }
  for (const domain of [
    "notexample.com",
    "example.com.fixture",
    "test.fixture",
    "team.invalid.fixture",
    "team.localhost.fixture",
  ]) {
    assert.deepEqual(check(email("fixture", domain)), ["--text #1: email address"]);
  }
});

test("email local parts start with a letter or digit, not package or template quotes", () => {
  for (const value of [
    "'@scope.io/pkg'",
    "`@file.md",
    '"@scope/pkg"',
    ...["+noreply", "-noreply"].map((local) => email(local, "mail.fixture")),
  ]) {
    assert.deepEqual(check(value), []);
  }
  for (const local of ["a.b", "0.b", "a".repeat(64)]) {
    assert.deepEqual(check(email(local, "fixturecorp.dev")), ["--text #1: email address"]);
  }
  assert.deepEqual(check(email("a".repeat(65), "fixturecorp.dev")), []);
});

test("email rules exempt git only on the two public hosts and reserved domains", () => {
  for (const local of ["git", "GIT"]) {
    for (const domain of ["example.com", "github.com", "gitlab.com"]) {
      assert.deepEqual(check(email(local, domain)), []);
    }
  }
  for (const value of [
    blockedMail,
    email("person", "github.com"),
    ...["not-noreply", "notgit", "git+fixture"].map((local) => email(local, "mail.fixture")),
  ]) {
    assert.deepEqual(check(value), ["--text #1: email address"]);
  }
});

test("URL user-info is not an email address; paths, queries and adjacent addresses still are", () => {
  for (const scheme of ["https", "SSH", "git+ssh", "proto.1-ext"]) {
    for (const user of ["fixture", "fixture:password", "fixture:p%40ssword"]) {
      assert.deepEqual(
        check(`${scheme}://${email(user, "mail.fixture")}:443/path`),
        user === "fixture:p%40ssword" ? ["--text #1: URL password"] : [],
      );
    }
  }
  for (const value of [
    `https://public.example/mailto:${blockedMail}`,
    `https://public.example/?contact=mailto:${blockedMail}`,
    `https://public.example/#mailto:${blockedMail}`,
    `https://fixture@mail.fixture ${blockedMail}`,
    `https://fixture@mail.fixture\n${blockedMail}`,
  ]) {
    assert.deepEqual(check(value), ["--text #1: email address"]);
  }
});

test("email exceptions never suppress other rules or private terms", () => {
  assert.deepEqual(check(["https://", `fixture:${secret}`, "@mail.fixture/path"].join("")), [
    "--text #1: URL password",
    "--text #1: secret shape",
  ]);
  assert.deepEqual(check(`https://fixture@${ip(10, 20, 30, 40)}/path`), ["--text #1: private or tailnet IPv4 address (use 192.0.2.x or 2001:db8:: for documentation)"]);
  assert.deepEqual(check(`https://${email("git", host("fixture"))}`), ["--text #1: tailnet host name"]);
  const terms = { ...empty, terms: [{ value: "fixturecorp", line: 1 }] };
  for (const value of [
    email("fixturecorp", "team.invalid"),
    "https://fixturecorp@mail.fixture/path",
    email("git", "fixturecorp.example"),
  ]) {
    assert.deepEqual(checkText(value, "--text #1", terms), ["--text #1: private term (file line 1)"]);
  }
});

test("secret shapes detect each family and enforce the specified minimum lengths", () => {
  const families: [string, number, string][] = [
    ...["p", "o", "u", "s", "r"].map((kind): [string, number, string] => [["gh", kind, "_"].join(""), 36, "A"]),
    [["github", "_pat_"].join(""), 22, "_"],
    ...["ant", "proj"].map((kind): [string, number, string] => [["sk", kind, ""].join("-"), 20, "-"]),
    [["AK", "IA"].join(""), 16, "Z"],
    [["np", "m_"].join(""), 36, "a"],
  ];
  for (const [prefix, length, character] of families) {
    assert.deepEqual(check(prefix + character.repeat(length)), ["--text #1: secret shape"]);
    assert.deepEqual(check(prefix + character.repeat(length - 1)), []);
  }
  for (const kind of ["a", "b", "p", "r", "s"])
    assert.deepEqual(check(["xo", "x", kind, "-123-abc"].join("")), ["--text #1: secret shape"]);
  for (const kind of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    assert.deepEqual(check(["-----", "BEGIN ", kind, "PRIVATE", " KEY", "-----"].join("")), [
      "--text #1: secret shape",
    ]);
  }
});

test("attribution is checked only when requested", () => {
  for (const text of [trailer, trailer.toLowerCase(), generated]) {
    assert.deepEqual(check(text), ["--text #1: attribution"]);
    assert.deepEqual(check(text, false), []);
  }
});

test("the trailing comment marker exempts ordinary generic rules only on its own line", () => {
  for (const [value, rule] of [
    [home("fixture-person"), "real home path"],
    [host("fixture"), "tailnet host name"],
    [ip(10, 20, 30, 40), "private or tailnet IPv4 address (use 192.0.2.x or 2001:db8:: for documentation)"],
    [blockedMail, "email address"],
    [trailer, "attribution"],
    [generated, "attribution"],
  ]) {
    assert.deepEqual(checkText(`${value} // ${allowMarker}`, "file", empty, { lineExemptions: true }), []);
    assert.deepEqual(checkText(`${value} ${allowMarker} in prose`, "file", empty, { lineExemptions: true }), [
      `file: ${rule}`,
    ]);
    // A prefixed trailer is no longer at the start of a line, regardless of marker exemptions.
    const prefixed = `${allowMarker} ${value}`;
    for (const lineExemptions of [false, true])
      assert.deepEqual(
        checkText(prefixed, "file", empty, { lineExemptions }),
        value === trailer ? [] : [`file: ${rule}`],
      );
    assert.deepEqual(
      checkText(`${value}\r\n${value} // ${allowMarker}\r\n${value}`, "fixture.md", empty, {
        lines: true,
        lineExemptions: true,
      }),
      [`fixture.md:1: ${rule}`, `fixture.md:3: ${rule}`],
    );
  }
});

test("the line marker never skips private terms from either the file or the environment", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "# local\nfixturecorp\n");
  writeFileSync(path.join(cwd, "marked.md"), `${secret} fixturecorp fixture-team // ${allowMarker}\n`);
  const result = cli(cwd, [], { EMEND_PRIVATE_TERMS: "fixture-team" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "marked.md:1: secret shape\nmarked.md:1: private term (file line 2)\nmarked.md:1: private term (env line 1)\n",
  );
  for (const value of [secret, "fixturecorp", "fixture-team"]) assert(!result.stderr.includes(value));
});

test("the line marker cannot disable redaction in a reported filename", () => {
  assert.deepEqual(checkText(blockedMail, `${secret} ${allowMarker}`, empty), [
    `[redacted] ${allowMarker}: email address`,
  ]);
});

test("private lists preserve line numbers and only file allowed phrases take effect", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "# synthetic\n\nfixturecorp\n!fixturecorp/public-tool\n");
  const env = { EMEND_PRIVATE_TERMS: "# environment\nfixture-team\n!fixture-team/public\n!fixturecorp/shared\n" };
  const terms = loadPrivateTerms(cwd, env, { root: cwd });
  assert.deepEqual(terms.notes, ["check:public: allowed phrases in EMEND_PRIVATE_TERMS are ignored"]);
  assert.deepEqual(checkText("FIXTURECORP and fixture-team", "--text #1", terms), [
    "--text #1: private term (file line 3)",
    "--text #1: private term (env line 2)",
  ]);
  assert.deepEqual(checkText("FIXTURECORP/PUBLIC-TOOL", "x", terms), []);
  assert.deepEqual(checkText("fixture-team/public", "x", terms), ["x: private term (env line 2)"]);
  assert.deepEqual(checkText("fixturecorp/shared", "x", terms), ["x: private term (file line 3)"]);
  assert.deepEqual(checkText("fixturecorp/public-tool fixturecorp", "x", terms), ["x: private term (file line 3)"]);
  assert.equal(checkText("fixturecorp/private", "x", terms).length, 1);
  assert.equal(
    checkText(secret, "x", { ...terms, allowed: [secret.toLowerCase()] }).length,
    1,
    "phrases cannot suppress generic rules",
  );
});

test("allowed phrases must contain the whole hit, including overlapping occurrences", () => {
  const terms = { ...empty, terms: [{ value: "aba", line: 1 }], allowed: ["aba"] };
  assert.deepEqual(checkText("ababa", "x", terms), []);
  assert.equal(checkText("abcd", "x", { ...terms, terms: [{ value: "abcd", line: 1 }], allowed: ["abc"] }).length, 1);
});

test("linked worktrees use the main checkout's list", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "fixturecorp\n");
  const linked = path.join(root, `linked-${path.basename(cwd)}`);
  git(cwd, "worktree", "add", "--quiet", "-b", "linked", linked);
  writeFileSync(path.join(linked, ".private-terms"), "decoy\n");
  const result = cli(linked, ["--text", "fixturecorp"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "--text #1:1:1: private term (file line 1)\n");
});

test("the no-list note occurs exactly once and is not a failure", () => {
  const result = cli(repo(), []);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "check:public: no private terms list; generic rules only\n");
  const outside = directory();
  writeFileSync(path.join(outside, ".private-terms"), "unused-synthetic-term");
  const supplied = cli(outside, ["--root", outside, "--text", "public"], { EMEND_PRIVATE_TERMS: "fixturecorp" });
  assert.equal(supplied.status, 0);
  assert.equal(supplied.stderr, "");
});

test("explicit files and texts are repeatable, isolated and never echo matches", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  writeFileSync(path.join(cwd, "draft.md"), `clean\n${home("fixture-person")}\n${trailer}\n`);
  writeFileSync(path.join(cwd, "second.md"), generated);
  const result = cli(
    cwd,
    ["--file", "draft.md", "--file", "second.md", "--text", blockedMail, "--text", "fixturecorp"],
    { EMEND_PRIVATE_TERMS: "fixturecorp" },
  );
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    "draft.md:2: real home path\ndraft.md:3: attribution\nsecond.md:1: attribution\n--text #1:1:1: email address\n--text #2:1:1: private term (env line 1)\n",
  );
  for (const value of [home("fixture-person"), trailer, generated, blockedMail, "fixturecorp"])
    assert(!result.stderr.includes(value));
  assert.equal(cli(cwd, ["--text", "clean"], { EMEND_PRIVATE_TERMS: "fixturecorp" }).status, 0);
});

test("locations and errors cannot disclose a term, content or terminal controls", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const file = "fixturecorp\n.md";
  writeFileSync(path.join(cwd, file), secret);
  const env = { EMEND_PRIVATE_TERMS: "fixturecorp" };
  const result = cli(cwd, ["--file", file], env);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "[redacted]?.md:1: secret shape\n");
  for (const args of [
    ["--file", "fixturecorp-missing"],
    ["--commits", "fixturecorp-missing..HEAD"],
    ["--fixturecorp"],
  ]) {
    const failed = cli(cwd, args, env);
    assert.notEqual(failed.status, 0);
    assert(!failed.stderr.includes("fixturecorp"));
    assert.equal(failed.stdout, "");
  }
});

test("case folding cannot move a private hit outside its redacted location", () => {
  const terms = { ...empty, terms: [{ value: "fixturecorp", line: 1 }] };
  const prefix = "İ".repeat(12);
  assert.deepEqual(checkText("FIXTURECORP", `${prefix}fixturecorp.md`, terms), [
    `${prefix}[redacted].md: private term (file line 1)`,
  ]);
  assert.deepEqual(checkText(`${prefix}\nFIXTURECORP`, "draft.md", terms, { lines: true }), [
    "draft.md:2: private term (file line 1)",
  ]);
});

test("each occurrence produces its own redacted hit line", () => {
  assert.deepEqual(check(`${blockedMail} ${blockedMail}`), ["--text #1: email address", "--text #1: email address"]);
});

test("default mode covers tracked and untracked files, refuses unknown binary and skips ignored files", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "tracked.md"), "clean");
  writeFileSync(path.join(cwd, "deleted.md"), "clean");
  commit(cwd, "files");
  rmSync(path.join(cwd, "deleted.md"));
  writeFileSync(path.join(cwd, "tracked.md"), blockedMail);
  writeFileSync(path.join(cwd, "untracked.md"), home("fixture-person"));
  writeFileSync(path.join(cwd, "ignored.txt"), secret);
  writeFileSync(path.join(cwd, "binary.bin"), Buffer.from(`\0${secret}`));
  writeFileSync(path.join(cwd, "attribution.md"), trailer);
  const hits = checkPublic({ cwd, env: {} }).hits;
  assert.deepEqual(hits.sort(), [
    "binary.bin: binary file of unknown type",
    "tracked.md:1: email address",
    "untracked.md:1: real home path",
  ]);
  assert.equal(cli(cwd, []).status, 1);
});

test("symlinks scan their stored target without reading outside the repository", () => {
  const cwd = repo();
  const outside = path.join(directory(), "outside");
  writeFileSync(outside, secret);
  symlinkSync(outside, path.join(cwd, "link"));
  assert.deepEqual(checkPublic({ cwd, env: {} }).hits, []);
});

test("commit mode checks every message in range, including merges, but ignores files", () => {
  const cwd = repo();
  const first = commit(cwd, `first\n\n${trailer}`);
  git(cwd, "branch", "side", "main");
  const second = commit(cwd, blockedMail);
  git(cwd, "switch", "--quiet", "side");
  commit(cwd, "side");
  git(cwd, "switch", "--quiet", "feature");
  git(cwd, "merge", "--no-ff", "side", "-m", generated);
  const merged = git(cwd, "rev-parse", "HEAD");
  writeFileSync(path.join(cwd, "untracked.md"), secret);
  const result = cli(cwd, ["--commits", "main..HEAD"], { EMEND_PRIVATE_TERMS: "fixturecorp" });
  assert.equal(result.status, 1);
  assert.deepEqual(
    result.stderr.trim().split("\n").sort(),
    [
      `commit ${first.slice(0, 7)} message:3:1: attribution`,
      `commit ${second.slice(0, 7)} message:1:1: email address`,
      `commit ${merged.slice(0, 7)} message:1:1: attribution`,
    ].sort(),
  );
  for (const value of [trailer, blockedMail, generated, secret]) assert(!result.stderr.includes(value));
  assert.equal(cli(cwd, ["--commits", "HEAD..HEAD"]).status, 0);
});

test("default commit base matches check-sync locally and with SYNC_BASE in CI", () => {
  const cwd = repo();
  const bad = commit(cwd, generated);
  git(cwd, "branch", "-f", "main", bad);
  assert.equal(checkPublic({ cwd, env: {} }).hits.length, 1, "origin/main takes precedence");
  assert.deepEqual(checkPublic({ cwd, env: { SYNC_BASE: bad } }).hits, []);
  git(cwd, "update-ref", "-d", "refs/remotes/origin/main");
  assert.deepEqual(checkPublic({ cwd, env: {} }).hits, [], "falls back to main");
  assert.equal(cli(cwd, [], { SYNC_BASE: "missing" }).status, 1);
});

test("unborn repositories still scan files", () => {
  const cwd = directory();
  git(cwd, "init", "--quiet", "-b", "main");
  writeFileSync(path.join(cwd, "draft.md"), blockedMail);
  assert.deepEqual(checkPublic({ cwd, env: {} }).hits, ["draft.md:1: email address"]);
});

test("push scanning reads committed blobs, including content removed later", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "past.md"), secret);
  commit(cwd, "first");
  rmSync(path.join(cwd, "past.md"));
  const head = commit(cwd, "remove");
  assert.deepEqual(checkPublicPush(cwd, head).hits, ["past.md:1: secret shape"]);
});

test("bad usage exits two without echoing arguments", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  for (const args of [
    ["--file"],
    ["--text"],
    ["--commits"],
    ["--other"],
    ["plain"],
    ["--commits", "main..HEAD", "--text", "x"],
    ["--commits", "main..HEAD", "--commits", "main..HEAD"],
  ]) {
    assert.equal(cli(cwd, args).status, 2);
  }
  assert.equal(cli(cwd, ["--text", ""], { EMEND_PRIVATE_TERMS: "fixturecorp" }).status, 0);
});

test("the scanner and its tests do not match their own generic patterns", () => {
  for (const file of [script, fileURLToPath(import.meta.url)]) {
    assert.deepEqual(checkText(readFileSync(file, "utf8"), "source", empty), []);
  }
});

for (const [family, unit] of [
  ["local part", "a"],
  ["dotted labels", "a."],
  ["scheme", "a+.-"],
  ["base64", "Ab0+/="],
]) {
  test(`regression: linear scan of one MiB of ${family}`, { timeout: 20_000 }, () => {
    const result = nodeCaptured(directory(), [
      "--input-type=module",
      "-e",
      `
      import { checkText } from ${JSON.stringify(script)};
      const text = ${JSON.stringify(unit)}.repeat(1048576).slice(0, 1048576);
      process.stdout.write(JSON.stringify(checkText(text, "x", { terms: [], allowed: [], notes: [] })));
    `,
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "[]");
  });
}

test("regression: paths and directories are checked even when contents are clean or deleted", () => {
  const cwd = repo();
  const files = [`fixturecorp/readme.md`, `${host("fixture")}/readme.md`, `${blockedMail} ${allowMarker}.txt`];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), "public");
  }
  writeFileSync(path.join(cwd, ".private-terms"), "fixturecorp");
  const head = commit(cwd, "files");
  for (const file of files) rmSync(path.join(cwd, file));
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    assert.ok(hits.includes("<redacted path>: private term (file line 1) (path)"));
    assert.ok(hits.includes("<redacted path>: tailnet host name (path)"));
    assert.ok(hits.includes("<redacted path>: email address (path)"));
    assert.ok(hits.every((hit) => hit.startsWith("<redacted path>:")));
  }
});

test("regression: known binary files retain private checks in latin1 and UTF-16LE", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "fixturecorp");
  for (const encoding of ["latin1", "utf16le"] as const) {
    writeFileSync(
      path.join(cwd, `${encoding}.woff2`),
      Buffer.concat([Buffer.from("wOF2"), Buffer.from(`\0${secret}\nfixturecorp`, encoding)]),
    );
  }
  const head = commit(cwd, "binary files");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    assert.deepEqual(hits.sort(), [
      "latin1.woff2: invalid compressed font data",
      "latin1.woff2: secret shape",
      "latin1.woff2:2: private term (file line 1)",
      "utf16le.woff2: invalid compressed font data",
      "utf16le.woff2: secret shape",
      "utf16le.woff2:2: private term (file line 1)",
    ]);
  }
});

test("regression: private terms normalize Unicode, invisible characters and encoded spaces", () => {
  const terms = { ...empty, terms: [{ value: "Fixture Corp", line: 3 }] };
  for (const value of [
    "ＦＩＸＴＵＲＥ ＣＯＲＰ",
    "fixture\u200bcorp",
    "fix\u00adturecorp",
    "fixtureCorp",
    "fixture-corp",
    "fixture___corp",
    "fixture \n\t corp",
    "fixture\u00a0corp",
    ...["%20", "&nbsp;", "&#32;", "&#x20;", "&#160;", "&#xa0;"].map((space) => `fixture${space}corp`),
  ])
    assert.deepEqual(checkText(value, "x", terms), ["x: private term (file line 3)"]);
  assert.deepEqual(checkText("fixturecorp", "x", { ...terms, terms: [{ value: "fixture-corp", line: 1 }] }), []);
  assert.deepEqual(checkText("fixture[a]corp", "x", { ...terms, terms: [{ value: "fixture[a]corp", line: 1 }] }), [
    "x: private term (file line 1)",
  ]);
  const unicode = { ...empty, terms: [{ value: "Café ΣΟΣ", line: 1 }] };
  assert.deepEqual(checkText("Cafe\u0301 ΣΟΣ", "x", unicode), ["x: private term (file line 1)"]);
  const composed = { ...empty, terms: [{ value: "\uac00", line: 1 }] };
  assert.deepEqual(checkText("\u3131\u314f", "x", composed), ["x: private term (file line 1)"]);
});

test("regression: allowed phrases normalize like terms and offsets retain original lines", () => {
  const terms = {
    ...empty,
    terms: [{ value: "fixture\u200b corp", line: 2 }],
    allowed: ["ＦＩＸＴＵＲＥ&nbsp;ＣＯＲＰ/public"],
  };
  assert.deepEqual(checkText("fixtureCorp/public", "x", terms), []);
  const value = "İ ﬃ\nfixture\u00ad\ncorp/public\nfixture\u200bcorp\n";
  assert.deepEqual(checkText(value, "draft.md", terms, { lines: true }), ["draft.md:4: private term (file line 2)"]);
});

test("regression: explicit modes require a list and --root selects it without git discovery", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "draft.md"), "public");
  for (const args of [
    ["--file", "draft.md"],
    ["--text", "public"],
    ["--push", "HEAD"],
  ]) {
    const missing = cli(cwd, args);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, "check:public: private terms list required; ask the owner to create <main>/.private-terms; agents never create, read or edit it\n");
    for (const value of ["", "# deliberate empty list", "fixturecorp"]) {
      const refused = cli(cwd, args, { EMEND_PRIVATE_TERMS: value });
      assert.equal(refused.status, 1);
      assert.equal(refused.stderr, "check:public: private terms list required; ask the owner to create <main>/.private-terms; agents never create, read or edit it\n");
    }
  }
  const main = directory();
  writeFileSync(path.join(main, ".private-terms"), "fixturecorp\n");
  const result = cli(cwd, ["--root", main, "--text", "fixturecorp"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "--text #1:1:1: private term (file line 1)\n");
  writeFileSync(path.join(main, ".private-terms"), "unused-synthetic-term");
  assert.equal(cli(cwd, ["--root", main, "--text", "public"]).status, 0);
});

test("regression: symlink entrypoint executes and explicit symlink files are refused", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const linkedScript = path.join(cwd, "gate.ts");
  symlinkSync(script, linkedScript);
  const result = nodeCaptured(cwd, [linkedScript, "--text", secret], { EMEND_PRIVATE_TERMS: "fixturecorp" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "--text #1:1:1: secret shape\n");
  writeFileSync(path.join(cwd, "target.md"), "public");
  symlinkSync("target.md", path.join(cwd, "draft.md"));
  const refused = cli(cwd, ["--file", "draft.md"], { EMEND_PRIVATE_TERMS: "fixturecorp" });
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, "check:public: could not read a file\n");
});

test("regression: sent text and commit messages cannot use the file allow marker", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const marked = `${secret} ${allowMarker}`;
  const head = commit(cwd, marked);
  assert.deepEqual(checkPublic({ cwd, texts: [marked] }).hits, ["--text #1:1:1: secret shape"]);
  assert.deepEqual(checkPublic({ cwd, commits: "main..HEAD" }).hits, [`commit ${head.slice(0, 7)} message:1:1: secret shape`]);
  assert.equal(cli(cwd, ["--text", marked]).status, 1);
});

test("regression: bracketed attribution and additional trailers are flagged", () => {
  for (const value of [
    ["Generated with [", "Claude Code]"].join(""),
    ["Generated with [", "Claude Code](https://example.com)"].join(""),
    ["Assisted", "-by: Fixture"].join(""),
    ["Generated", "-by: Fixture"].join(""),
  ])
    assert.deepEqual(check(value), ["--text #1: attribution"]);
});

test("regression: home paths cover boundaries, Windows and variable placeholders", () => {
  const bases = [["/", "home", "/"].join(""), ["/", "Users", "/"].join(""), ["C:", "Users", ""].join("\\")];
  for (const base of bases) {
    for (const end of ["", '"', "/repo", " ", ".", ",", ")", "\\repo"]) {
      assert.deepEqual(check(`${base}fixture-person${end}`), ["--text #1: real home path"]);
    }
    for (const name of ["someone", "user", "runner", "<person>", "$VAR", "${VAR}", "~"]) {
      assert.deepEqual(check(`${base}${name}`), []);
    }
  }
});

test("regression: address and tailnet exemptions apply to their exact scope", () => {
  assert.deepEqual(check(`${ip(10, 20, 30, 40)}.`), ["--text #1: private or tailnet IPv4 address (use 192.0.2.x or 2001:db8:: for documentation)"]);
  for (const suffix of ["::1", ":0:0:0:0:1", "::/48"]) {
    assert.deepEqual(check(["fd7a", "115c", "a1e0"].join(":") + suffix), ["--text #1: private or tailnet IPv6 address (use 192.0.2.x or 2001:db8:: for documentation)"]);
  }
  assert.deepEqual(check(host("example.fixture")), ["--text #1: tailnet host name"]);
  assert.deepEqual(check(host("<host>.fixture")), ["--text #1: tailnet host name"]);
  for (const local of ["git", "noreply", "no-reply"]) {
    assert.deepEqual(check(email(local, "mail.fixture")), ["--text #1: email address"]);
  }
  assert.deepEqual(check(email("fixture", ["users", "noreply", "github", "com"].join("."))), [
    "--text #1: email address",
  ]);
  for (const separator of [",", ";", ")(", "]["]) {
    assert.deepEqual(check(`https://${email("fixture", "mail.fixture")}${separator}${blockedMail}`), [
      "--text #1: email address",
    ]);
  }
  assert.deepEqual(check(`https://${email("fixture", host("fixture"))}`), ["--text #1: tailnet host name"]);
});

test("regression: printed locations remove format controls and list hits name their source", () => {
  assert.deepEqual(checkText(secret, "draft\u202e\u2066\u200b.md", empty), ["draft???.md: secret shape"]);
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "# local\nfixturecorp");
  const terms = loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "# env\n# second\nfixtureteam" }, { root: cwd });
  assert.deepEqual(checkText("fixturecorp fixtureteam", "x", terms), [
    "x: private term (file line 2)",
    "x: private term (env line 3)",
  ]);
});

test("regression: replacement objects cannot hide a pushed blob or commit message", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "draft.md"), secret);
  const bad = commit(cwd, trailer);
  const badBlob = git(cwd, "rev-parse", "HEAD:draft.md");
  writeFileSync(path.join(cwd, "draft.md"), "public");
  const good = commit(cwd, "public");
  const goodBlob = git(cwd, "rev-parse", "HEAD:draft.md");
  git(cwd, "replace", badBlob, goodBlob);
  git(cwd, "replace", bad, good);
  assert.deepEqual(checkPublicPush(cwd, bad).hits, [
    `commit ${bad.slice(0, 7)} message:1:1: attribution`,
    "draft.md:1: secret shape",
  ]);
});

test("regression: commit scanning disables configured signature verification", () => {
  const cwd = repo();
  const marker = path.join(cwd, "verified");
  const verifier = path.join(cwd, "verify-signature");
  writeFileSync(verifier, '#!/bin/sh\n: > "$GATE_SIGNATURE_MARKER"\nexit 1\n');
  chmodSync(verifier, 0o755);
  git(cwd, "config", "gpg.program", verifier);
  git(cwd, "config", "log.showSignature", "true");
  const input = [
    `tree ${git(cwd, "rev-parse", "HEAD^{tree}")}`,
    `parent ${git(cwd, "rev-parse", "HEAD")}`,
    "author Fixture <fixture@example.com> 1234567890 +0000",
    "committer Fixture <fixture@example.com> 1234567890 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " fixture",
    " -----END PGP SIGNATURE-----",
    "",
    "public",
    "",
  ].join("\n");
  const commitFile = path.join(cwd, "commit-object");
  writeFileSync(commitFile, input);
  const sha = git(cwd, "hash-object", "-t", "commit", "-w", commitFile);
  process.env.GATE_SIGNATURE_MARKER = marker;
  try {
    assert.deepEqual(checkPublic({ cwd, commits: `${sha}^..${sha}` }).hits, []);
    assert.equal(existsSync(marker), false);
  } finally {
    delete process.env.GATE_SIGNATURE_MARKER;
  }
});

test("regression: URL spans and line offsets are reused for many email hits", { timeout: 20_000 }, () => {
  const result = nodeCaptured(directory(), [
    "--input-type=module",
    "-e",
    `
    import assert from "node:assert/strict";
    import { checkText } from ${JSON.stringify(script)};
    const email = ["fixture", "mail.fixture"].join("@");
    const row = "https://fixture@example.com " + email + "\\n";
    const count = Math.ceil(1048576 / row.length);
    const hits = checkText(row.repeat(count), "file", { terms: [], allowed: [], notes: [] }, { lines: true });
    assert.equal(hits.length, count);
    assert.equal(hits.at(-1), "file:" + count + ": email address");
    process.stdout.write("ok");
  `,
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
});

test("1: emend tokens, Tailscale keys, PGP blocks and URL passwords", () => {
  for (const prefix of ["em", "ems", "emp"].map((kind) => `${kind}_`)) {
    for (const ending of ["a", "_", "-"]) {
      const token = prefix + "a".repeat(42) + ending;
      assert.deepEqual(check(`'${token}'`), ["--text #1: secret shape"]);
      for (const value of [token.slice(0, -1), `${token}a`, `a${token}`, `_${token}`])
        assert.deepEqual(check(value), []);
    }
  }
  assert.deepEqual(check(["tskey", "auth", "a".repeat(24)].join("-")), ["--text #1: secret shape"]);
  assert.deepEqual(check(["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" ")), ["--text #1: secret shape"]);
  assert.deepEqual(check(["https://", "user:p%40ssword", "@fixturecorp.dev"].join("")), ["--text #1: URL password"]);
  for (const user of ["user", "user:"]) assert.deepEqual(check(["https://", user, "@example.com"].join("")), []);
});

test("2: quoted emails are checked while package and instruction mentions stay clean", () => {
  for (const quote of ["'", "`", '"', "(", "[", "<", "“", ":"]) {
    assert.deepEqual(check(quote + email("name", "fixturecorp.dev") + quote), ["--text #1: email address"]);
  }
  for (const value of ["'@scope.io/pkg'", "`@AGENTS.md", "'@scope/pkg'"]) assert.deepEqual(check(value), []);
});

test("3: home boundaries, named tilde paths and JSON Windows paths", () => {
  for (const base of [["/", "home", "/"].join(""), ["/", "Users", "/"].join("")]) {
    for (const prefix of ["", '"', "HOME="])
      assert.deepEqual(check(`${prefix}${base}fixtureuser`), ["--text #1: real home path"]);
    for (const prefix of ["a", "9", ".", "_", "-", "apps/web/src/routes"])
      assert.deepEqual(check(`${prefix}${base}settings.tsx`), []);
  }
  assert.deepEqual(check(["~", "fixtureuser/repo"].join("")), ["--text #1: real home path"]);
  for (const value of ["~/repo", "~user/repo", "~someone/repo", "~runner/repo"]) assert.deepEqual(check(value), []);
  assert.deepEqual(check(JSON.stringify(["C:", "Users", "fixtureuser"].join("\\"))), ["--text #1: real home path"]);
});

test("4: generated attribution covers every tool, casing and bracket form", () => {
  for (const tool of ["Claude", "Claude Code", "Codex", "ChatGPT", "GPT", "Copilot", "OpenCode", "Gemini"]) {
    for (const how of ["with", "by"]) {
      for (const bracket of [false, true]) {
        const value = ["Generated", how, bracket ? `[${tool}]` : tool].join(" ");
        for (const text of [value, value.toLowerCase(), value.toUpperCase()])
          assert.deepEqual(check(text), ["--text #1: attribution"]);
      }
    }
  }
});

test("5: explicit input refuses any NUL, including beyond the binary sniff window", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  for (const text of ["\0public", "a".repeat(8193) + "\0"]) {
    writeFileSync(path.join(cwd, "draft"), text);
    const result = cli(cwd, ["--file", "draft"]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "check:public: explicit input contains a NUL byte\n");
    assert.throws(
      () => checkPublic({ cwd, texts: [text] }),
      (error: unknown) =>
        error instanceof PublicCheckError && error.message === "check:public: explicit input contains a NUL byte",
    );
  }
});

function utf16(value: string, bigEndian = false): Buffer {
  const buffer = Buffer.from(value, "utf16le");
  return bigEndian ? buffer.swap16() : buffer;
}

test("5: UTF-16 BOM files receive all generic rules in default and push modes", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "fixturecorp");
  for (const bigEndian of [false, true])
    writeFileSync(
      path.join(cwd, bigEndian ? "be.txt" : "le.txt"),
      utf16(`\ufeff${secret}\n${blockedMail}\nfixturecorp\n${trailer}`, bigEndian),
    );
  const head = commit(cwd, "encoded files");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    for (const file of ["be.txt", "le.txt"])
      for (const [line, rule] of [
        [1, "secret shape"],
        [2, "email address"],
        [3, "private term (file line 1)"],
        [4, "attribution"],
      ])
        assert.ok(hits.includes(`${file}:${line}: ${rule}`));
    assert.equal(hits.length, 8);
  }
});

test("5: binary private terms use UTF-8, latin1 and both UTF-16 alignments and endiannesses", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "café");
  const buffers = [Buffer.from("café"), Buffer.from("café", "latin1")];
  for (const bigEndian of [false, true])
    for (const offset of [0, 1]) buffers.push(Buffer.concat([Buffer.alloc(offset, 1), utf16("CAFÉ", bigEndian)]));
  for (const [i, buffer] of buffers.entries())
    writeFileSync(path.join(cwd, `${i}.woff2`), Buffer.concat([Buffer.from("wOF2"), buffer, Buffer.alloc(2)]));
  const head = commit(cwd, "binary files");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    for (const i of buffers.keys()) assert.ok(hits.includes(`${i}.woff2:1: private term (file line 1)`));
});

test("6: folding strips invisibles before accents, preserves offsets and folds phrases identically", () => {
  const terms = {
    ...empty,
    terms: [
      { value: "café", line: 1 },
      { value: "istanbul", line: 2 },
    ],
  };
  for (const value of ["cafe\u200b\u0301", "CAFÉ", "cafe", "cafe&#x20;public"]) {
    assert.deepEqual(checkText(`safe\n${value}`, "draft", terms, { lines: true }), [
      "draft:2: private term (file line 1)",
    ]);
  }
  assert.deepEqual(checkText("İSTANBUL", "x", terms), ["x: private term (file line 2)"]);
  assert.deepEqual(checkText("cafe\u200b\u0301/public", "x", { ...terms, allowed: ["CAFÉ/public"] }), []);
  assert.deepEqual(checkText("CAFÉ", "cafe\u200b\u0301.txt", terms), ["[redacted].txt: private term (file line 1)"]);
  const quotes = { ...empty, terms: [{ value: `fixture’s “team”`, line: 1 }] };
  assert.equal(checkText(`fixture's "team"`, "x", quotes).length, 1);
  assert.deepEqual(checkText(`fixture’s “team”/public`, "x", { ...quotes, allowed: [`fixture's "team"/public`] }), []);
  const spaced = { ...empty, terms: [{ value: "a  b  c", line: 1 }] };
  assert.equal(checkText("a____b-c", "x", spaced).length, 1);
  assert.deepEqual(checkText("a_____b-c", "x", spaced), []);
  assert.deepEqual(checkText("a     b-c", "x", spaced), ["x: private term (file line 1)"]);
});

for (const term of ["a - b", "a  b  c"]) {
  test(`6: bounded gaps scan one MiB for ${term}`, { timeout: 20_000 }, () => {
    const result = nodeCaptured(directory(), [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict";
      import { checkText } from ${JSON.stringify(script)};
      const term = ${JSON.stringify(term)};
      const text = "a" + "-".repeat(1048576) + "c";
      assert.deepEqual(checkText(text, "x", { terms: [{value: term, line: 1}], allowed: [], notes: [] }), []);
      process.stdout.write("ok");
    `,
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "ok");
  });
}

test("7: pushed author and committer identities only exempt exact configured values", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "fixturecorp");
  git(cwd, "config", "user.name", "fixturecorp");
  git(cwd, "config", "user.email", "fixturecorp@example.com");
  for (let field = 0; field < 4; field++) {
    const fields = ["Fixture", "fixture@example.com", "Fixture", "fixture@example.com"];
    fields[field] = field % 2 ? "foreign-fixturecorp@example.com" : "Foreign fixturecorp";
    const head = identityCommit(cwd, fields);
    const hits = checkPublicPush(cwd, head).hits;
    assert.equal(hits.length, 1);
    assert.match(hits[0] ?? "", /private term/);
    assert.ok(hits.every((hit) => !hit.includes("fixturecorp")));
  }
  assert.deepEqual(
    checkPublicPush(
      cwd,
      identityCommit(cwd, ["fixturecorp", "fixturecorp@example.com", "fixturecorp", "fixturecorp@example.com"]),
    ).hits,
    [],
  );
  assert.equal(
    checkPublicPush(cwd, identityCommit(cwd, ["FIXTURECORP", "fixture@example.com", "Fixture", "fixture@example.com"]))
      .hits.length,
    1,
  );
});

function identityCommit(cwd: string, fields: string[]): string {
  const object = path.join(directory(), "commit");
  writeFileSync(
    object,
    [
      `tree ${git(cwd, "rev-parse", "HEAD^{tree}")}`,
      `parent ${git(cwd, "rev-parse", "HEAD")}`,
      `author ${fields[0]} <${fields[1]}> 1234567890 +0000`,
      `committer ${fields[2]} <${fields[3]}> 1234567890 +0000`,
      "",
      "public",
      "",
    ].join("\n"),
  );
  return git(cwd, "hash-object", "-t", "commit", "-w", object);
}

test("8: advertised destination history overrides an incorrect local tracking ref", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "draft"), secret);
  const hidden = commit(cwd, "public");
  git(cwd, "update-ref", "refs/remotes/origin/main", hidden);
  rmSync(path.join(cwd, "draft"));
  const head = commit(cwd, "remove draft");
  assert.ok(checkPublicPush(cwd, head).hits.includes("draft:1: secret shape"));
});

test("8: unreadable advertised refs refuse with exit 69 and fixed output", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  git(cwd, "remote", "set-url", "--push", "origin", path.join(root, "missing-fixturecorp"));
  const result = cli(cwd, ["--push", "HEAD"], { EMEND_PRIVATE_TERMS: "fixturecorp" });
  assert.equal(result.status, 69);
  assert.equal(result.stderr, "check:public: could not read destination refs\n");
});

test("11: an unborn HEAD is clean but other rev-parse failures refuse", () => {
  const cwd = directory();
  git(cwd, "init", "--quiet", "-b", "main");
  writeFileSync(path.join(cwd, ".gitignore"), "/.private-terms\n");
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  assert.equal(git(cwd, "check-ignore", ".private-terms"), ".private-terms");
  assert.deepEqual(checkPublic({ cwd }).hits, []);
  const result = cli(cwd, [], {
    PATH: gitShim(`
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      process.stderr.write("fixturecorp failure"); process.exit(128);
    }
  `),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "check:public: could not read git data\n");
});

test("12: invalid UTF-8 filenames are read as bytes and displayed with replacement characters", () => {
  const cwd = repo();
  const file = Buffer.concat([Buffer.from(`${cwd}/draft-`), Buffer.from([0xff]), Buffer.from(".txt")]);
  writeFileSync(file, secret);
  assert.deepEqual(checkPublic({ cwd }).hits, ["draft-�.txt:1: secret shape"]);
  commit(cwd, "file");
  assert.deepEqual(checkPublic({ cwd }).hits, ["draft-�.txt:1: secret shape"]);
});

// Each shim delegates to real git, except for the one explicitly injected failure or assertion.
function gitShim(body: string): string {
  const bin = directory();
  const realGit = childEnv.PATH.split(path.delimiter)
    .map((entry) => path.join(entry, "git"))
    .find((file) => existsSync(file));
  assert.ok(realGit);
  const shim = path.join(bin, "git");
  writeFileSync(
    shim,
    `#!${process.execPath}
    const {spawnSync} = require("node:child_process");
    const args = process.argv.slice(2);
    ${body}
    const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: "inherit"});
    process.exit(result.status ?? 1);
  `,
  );
  chmodSync(shim, 0o755);
  return bin + path.delimiter + childEnv.PATH;
}

test("7: every git call pins fsmonitor and output encoding; messages remain UTF-8", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "café");
  const head = commit(cwd, "CAFÉ");
  git(cwd, "config", "i18n.logOutputEncoding", "UTF-16");
  const result = cli(cwd, ["--push", head], {
    PATH: gitShim(`
    for (const pin of ["--no-replace-objects", "core.fsmonitor=false", "submodule.recurse=false", "i18n.logOutputEncoding=UTF-8"])
      if (!args.includes(pin)) process.exit(128);
    if (args.includes("show") && !args.includes("--no-show-signature")) process.exit(128);
  `),
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `commit ${head.slice(0, 7)} message:1:1: private term (file line 1)\n`);
  const marker = path.join(directory(), "ran");
  const hook = path.join(directory(), "monitor");
  writeFileSync(hook, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  chmodSync(hook, 0o755);
  git(cwd, "config", "core.fsmonitor", hook);
  assert.ok(checkPublic({ cwd }).hits.some((hit) => hit.includes("private term")));
  assert.equal(existsSync(marker), false);
});

test("7: non-UTF-8 commit messages are decoded before private matching", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "café");
  git(cwd, "config", "i18n.logOutputEncoding", "ISO-8859-1");
  const object = path.join(directory(), "commit");
  writeFileSync(
    object,
    Buffer.from(
      [
        `tree ${git(cwd, "rev-parse", "HEAD^{tree}")}`,
        `parent ${git(cwd, "rev-parse", "HEAD")}`,
        "author Fixture <fixture@example.com> 1234567890 +0000",
        "committer Fixture <fixture@example.com> 1234567890 +0000",
        "encoding ISO-8859-1",
        "",
        "CAFÉ",
        "",
      ].join("\n"),
      "latin1",
    ),
  );
  const sha = git(cwd, "hash-object", "-t", "commit", "-w", object);
  assert.deepEqual(checkPublicPush(cwd, sha).hits, [`commit ${sha.slice(0, 7)} message:1:1: private term (file line 1)`]);
});

test("8: an advertised commit absent locally cannot exclude outgoing history", () => {
  const cwd = repo();
  const remote = git(cwd, "remote", "get-url", "origin");
  const other = path.join(directory(), "clone");
  git(cwd, "clone", "--quiet", remote, other);
  writeFileSync(path.join(other, "remote.txt"), "public");
  commit(other, "remote change");
  git(other, "push", "--quiet", "origin", "main");
  writeFileSync(path.join(cwd, "draft"), secret);
  const head = commit(cwd, "local change");
  assert.ok(checkPublicPush(cwd, head).hits.includes("draft:1: secret shape"));
});

test("URL passwords exempt exact placeholders and reserved hosts without suppressing other checks", () => {
  const url = (password: string, host = "fixturecorp.dev") => ["https://", "user:", password, "@", host].join("");
  for (const password of [
    "pass",
    "passwd",
    "password",
    "pw",
    "pwd",
    "secret",
    "token",
    "changeme",
    "x",
    "xxxx",
    "*",
    "****",
    "<credential>",
    "$VAR",
    "${VAR}",
    "$FIXTURE_1",
    "${FIXTURE_1}",
  ]) {
    assert.deepEqual(check(url(password)), []);
    assert.deepEqual(check(url(password.toUpperCase())), []);
  }
  for (const host of [
    "example",
    "example.com",
    "example.org",
    "example.net",
    "hub.example.com",
    "hub.example",
    "hub.test",
    "hub.invalid",
    "hub.localhost",
    "localhost",
    "hub.example.test",
  ]) {
    assert.deepEqual(check(url("f7Q9r2L6v8", host)), []);
    assert.deepEqual(check(url("f7Q9r2L6v8", `${host.toUpperCase()}:443/path`)), []);
  }
  for (const password of [
    "f7Q9r2L6v8",
    "pass123",
    "notsecret",
    "tokens",
    "changed",
    "x1",
    "*x",
    "$9VAR",
    "${VAR}extra",
  ])
    assert.deepEqual(check(url(password)), ["--text #1: URL password"]);
  for (const host of ["notexample.com", "example.com.fixturecorp.dev", "localhost.fixturecorp.dev", "exampletest"])
    assert.deepEqual(check(url("f7Q9r2L6v8", host)), ["--text #1: URL password"]);
  assert.deepEqual(check(url(secret, "example.com")), ["--text #1: secret shape"]);
  assert.deepEqual(checkText(url("password"), "x", { ...empty, terms: [{ value: "fixturecorp", line: 1 }] }), [
    "x: private term (file line 1)",
  ]);
});

test("a: destination refs are read through origin and ambiguous push URLs refuse", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const destination = readPushDestination(cwd);
  assert.equal(destination.remote, "origin");
  assert.equal(destination.url, git(cwd, "remote", "get-url", "origin"));
  assert.equal(destination.refs.get("refs/heads/main"), git(cwd, "rev-parse", "main"));
  const result = cli(cwd, ["--push", "HEAD"], {
    PATH: gitShim(`
      const expected = ["ls-remote", "--quiet", "--", "origin"];
      if (args.includes("ls-remote") && JSON.stringify(args.slice(-4)) !== JSON.stringify(expected)) process.exit(128);
    `),
  });
  assert.equal(result.status, 0);
  const url = git(cwd, "remote", "get-url", "origin");
  git(cwd, "config", "--add", "remote.origin.pushurl", url);
  git(cwd, "config", "--add", "remote.origin.pushurl", url);
  assert.throws(
    () => readPushDestination(cwd),
    (error: unknown) => error instanceof PublicCheckError && error.code === 69,
  );
});

test("b: wrapped terms absorb indentation and one comment leader with source offsets", () => {
  const terms = { ...empty, terms: [{ value: "alice example", line: 1 }] };
  for (const gap of [
    "\n        ",
    "\r\n\t\t\t",
    "\t".repeat(8),
    ...["//", "*", "#", ">", "--", ";"].map((leader) => `\n        ${leader}        `),
  ]) {
    const value = `alice${gap}example`;
    assert.deepEqual(checkText(`public\n${value}`, "draft", terms, { lines: true }), [
      "draft:2: private term (file line 1)",
    ]);
    assert.deepEqual(checkText(value, `${value}.txt`, terms), ["[redacted].txt: private term (file line 1)"]);
    assert.deepEqual(checkText(`${value}/public`, "draft", { ...terms, allowed: ["alice example/public"] }), []);
  }
  assert.deepEqual(checkText("alice\n // # example", "draft", terms), []);
});

test("b: Unicode hyphens separate private term words", () => {
  const terms = { ...empty, terms: [{ value: "alice example", line: 1 }] };
  for (const code of [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212])
    assert.deepEqual(checkText(`alice${String.fromCodePoint(code)}example`, "draft", terms), [
      "draft: private term (file line 1)",
    ]);
});

test("b: one MiB of wrapped indentation is collapsed in one pass", { timeout: 20_000 }, () => {
  const result = nodeCaptured(directory(), [
    "--input-type=module",
    "-e",
    `
    import assert from "node:assert/strict";
    import { checkText } from ${JSON.stringify(script)};
    const terms = { terms: [{ value: "alice example", line: 1 }], allowed: [], notes: [] };
    const text = "alice\\n" + " ".repeat(1048576) + "// example";
    assert.deepEqual(checkText(text, "draft", terms, { lines: true }), ["draft:1: private term (file line 1)"]);
    process.stdout.write("ok");
  `,
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok");
});

test("c: foreign identity emails get generic checks with identity-only noreply exceptions", () => {
  const cwd = repo();
  const ownEmail = email("alice-example", "mail.fixture");
  git(cwd, "config", "user.email", ownEmail);
  const defaults = ["Fixture", ownEmail, "Fixture", ownEmail];
  assert.deepEqual(checkPublicPush(cwd, identityCommit(cwd, defaults)).hits, []);
  for (const index of [1, 3]) {
    const fields = [...defaults];
    fields[index] = blockedMail;
    const head = identityCommit(cwd, fields);
    assert.deepEqual(checkPublicPush(cwd, head).hits, [
      `commit ${head.slice(0, 7)} ${index === 1 ? "author" : "committer"} email:1:1: email address`,
    ]);
    for (const address of [email("noreply", "github.com"), email("alice-example", "users.noreply.github.com")]) {
      fields[index] = address;
      assert.deepEqual(checkPublicPush(cwd, identityCommit(cwd, fields)).hits, []);
      assert.deepEqual(check(address), ["--text #1: email address"]);
    }
  }
  writeFileSync(path.join(cwd, ".private-terms"), "alice example");
  const fields = [...defaults];
  fields[1] = email("alice-example", "users.noreply.github.com");
  assert.match(checkPublicPush(cwd, identityCommit(cwd, fields)).hits.join("\n"), /author email:1:1: private term/);
});

function pngChunk(kind: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(kind, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, checksum]);
}

function png(...chunks: Buffer[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8; // one grayscale pixel
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    ...chunks,
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("d: matching PNG and font magic permits binary files but unknown NUL files are reported", () => {
  const cwd = repo();
  const formats: [string, Buffer][] = [
    ["image.png", png()],
    ["font.woff", fontFixture("woff", Buffer.from("public fixture ".repeat(10)))],
    ["font.woff2", fontFixture("woff2", Buffer.from("public fixture ".repeat(10)))],
    ...["ttf", "otf"].flatMap((ext): [string, Buffer][] => [
      [`apple.${ext}`, Buffer.from("true")],
      [`open.${ext}`, Buffer.from("OTTO")],
      [`type.${ext}`, Buffer.from([0, 1, 0, 0])],
    ]),
  ];
  for (const [file, bytes] of formats)
    writeFileSync(path.join(cwd, file), /\.(?:png|woff2?)$/.test(file) ? bytes : Buffer.concat([bytes, Buffer.alloc(8)]));
  writeFileSync(path.join(cwd, "unknown.png"), Buffer.from(`public\0${secret}`));
  const head = commit(cwd, "binary formats");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits, ["unknown.png: binary file of unknown type"]);
});

test("C: NUL-free magic prefixes remain text in explicit, repository and push scans", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const cases = [
    ["true.txt", `true\n${blockedMail}`, "2: email address"],
    ["gif.txt", `GIF89a ${home("alice-example")}`, "1: real home path"],
    ["otto.txt", `OTTO\n${blockedMail}`, "2: email address"],
    ["pdf.txt", `%PDF-1.7\n${blockedMail}`, "2: email address"],
  ] as const;
  for (const [file, text, label] of cases) {
    writeFileSync(path.join(cwd, file), text);
    const result = cli(cwd, ["--file", file]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${file}:${label}\n`);
  }
  const head = commit(cwd, "text drafts");
  const expected = cases.map(([file, , label]) => `${file}:${label}`).sort();
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits.sort(), expected);
});

test("D: NUL-bearing ZIP, gzip and PDF files are unknown binary types", () => {
  const cwd = repo();
  const cases: [string, Buffer][] = [
    ["archive.zip", Buffer.from([0x50, 0x4b, 3, 4, 0])],
    ["empty.zip", Buffer.from([0x50, 0x4b, 5, 6, 0])],
    ["stream.zip", Buffer.from([0x50, 0x4b, 7, 8, 0])],
    ["archive.gz", Buffer.from([0x1f, 0x8b, 8, 0])],
    ["document.pdf", Buffer.from("%PDF-1.7\n\0")],
  ];
  for (const [file, bytes] of cases) writeFileSync(path.join(cwd, file), bytes);
  const head = commit(cwd, "unsupported binary formats");
  const expected = cases.map(([file]) => `${file}: binary file of unknown type`).sort();
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits.sort(), expected);
});

test("d: PNG text chunks run all rules including compressed metadata", () => {
  const cwd = repo();
  const text = [secret, blockedMail, home("alice-example"), generated].join("\n");
  const chunks = [
    pngChunk("tEXt", Buffer.from(`Comment\0${text}`, "latin1")),
    pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(Buffer.from(text))])),
    ...[0, 1].map((compressed) =>
      pngChunk("iTXt", Buffer.concat([
        Buffer.from("Comment\0"),
        Buffer.from([compressed, 0, 0, 0]),
        compressed ? deflateSync(Buffer.from(text)) : Buffer.from(text),
      ])),
    ),
  ];
  for (const [i, chunk] of chunks.entries()) writeFileSync(path.join(cwd, `${i}.png`), png(chunk));
  const head = commit(cwd, "image metadata");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    for (const i of chunks.keys())
      for (const label of ["secret shape", "email address", "real home path", "attribution"])
        assert.ok(hits.includes(`${i}.png: ${label}`));
    assert.equal(hits.length, 16);
    assert.ok(hits.every((hit) => !hit.includes(secret) && !hit.includes(blockedMail)));
  }
});

test("d: PNG metadata failures and bounded inflation report only the file and label", () => {
  const cwd = repo();
  for (const [i, data] of [Buffer.from("broken"), deflateSync(Buffer.alloc(1024 * 1024 + 1, 65))].entries())
    writeFileSync(path.join(cwd, `${i}.png`), png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), data]))));
  writeFileSync(path.join(cwd, "truncated.png"), png().subarray(0, 12));
  const head = commit(cwd, "invalid image metadata");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits.sort(), ["0", "1", "truncated"].map((name) => `${name}.png: invalid PNG text metadata`));
});

test("d: PNG compressed text and translated keywords retain private term checks", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "muller");
  const text = Buffer.from(`metadata\n${"public ".repeat(100)}M\xfcller`, "latin1");
  writeFileSync(
    path.join(cwd, "compressed.png"),
    png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(text)]))),
  );
  writeFileSync(
    path.join(cwd, "translated.png"),
    png(pngChunk("iTXt", Buffer.from("Comment\0\0\0de\0Müller\0public"))),
  );
  const head = commit(cwd, "private image metadata");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    assert.ok(hits.includes("compressed.png: private term (file line 1)"));
    assert.ok(hits.includes("translated.png: private term (file line 1)"));
    assert.ok(hits.every((hit) => !/muller|müller/i.test(hit)));
  }
});

test("E: bare home paths are detected in commands, JSON and prose without confusing generic routes", () => {
  const base = ["/", "home", "/", "alice"].join("");
  const mac = ["/", "Users", "/", "alice"].join("");
  for (const value of ["/users/123", "/HOME/", `prefix${base}/src`])
    assert.deepEqual(check(value), []);
  for (const value of [
    `cd ${base}`,
    `cd ${mac}`,
    JSON.stringify({ home: base }),
    `${mac}.`,
    `${base}/src`,
    `HOME=${base}`,
    `${mac}/`,
    `HOME=${mac}`,
    home("alice.example"),
    ["C:", "Users", "alice", "x"].join("\\"),
  ])
    assert.deepEqual(check(value), ["--text #1: real home path"]);
  for (const name of ["<user>", "$USER", "${HOME}", "~", "someone", "user", "runner", "RUNNER"])
    for (const mac of [false, true]) {
      assert.deepEqual(check(home(name, mac)), []);
      assert.deepEqual(check(home(name, mac).slice(0, -"/file".length)), []);
    }
});

test("g: allow markers require short trailing comments and cannot exempt tokens", () => {
  const scan = (text: string) => checkText(text, "draft", empty, { lineExemptions: true });
  for (const value of [
    `${blockedMail} mentions ${allowMarker} in prose`,
    `${blockedMail} // ${allowMarker} suffix`,
    `${blockedMail} ${allowMarker}`,
  ])
    assert.deepEqual(scan(value), ["draft: email address"]);
  for (const comment of [`// ${allowMarker}`, `# ${allowMarker}`, `/* ${allowMarker} */`, `<!-- ${allowMarker} -->`]) {
    const short = `${blockedMail} ${comment}`;
    assert.deepEqual(scan(short.padStart(300, " ")), []);
    assert.deepEqual(scan(short.padStart(301, " ")), ["draft: email address"]);
    assert.deepEqual(scan(`${secret} ${comment}`), ["draft: secret shape"]);
    const header = ["-----", "BEGIN RSA ", "PRIVATE", " KEY", "-----"].join("");
    assert.deepEqual(scan(`${header} ${comment}`), []);
    assert.deepEqual(scan(`${header} ${secret} ${comment}`), ["draft: secret shape"]);
  }
});

test("private key bodies in quoted strings cannot use the allow marker", () => {
  const header = ["-----", "BEGIN RSA ", "PRIVATE", " KEY", "-----"].join("");
  const footer = header.replace("BEGIN", "END");
  const body = "Ab0+/=".repeat(8);
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = `${JSON.stringify([header, body, body, footer].join(newline))}; // ${allowMarker}`;
    assert.deepEqual(checkText(source, "fixture.ts", empty, { lines: true, lineExemptions: true }), [
      "fixture.ts:1: secret shape",
    ]);
  }
});

test("private key bodies in templates cannot use a marker on the header line", () => {
  const header = ["-----", "BEGIN RSA ", "PRIVATE", " KEY", "-----"].join("");
  const body = "Ab0+/=".repeat(8);
  const source = `const key = \`${header} // ${allowMarker}\n${body}\n${body}\n${header.replace("BEGIN", "END")}\`;`;
  assert.deepEqual(checkText(source, "fixture.ts", empty, { lines: true, lineExemptions: true }), [
    "fixture.ts:1: secret shape",
  ]);
});

test("private key armor headers and blank lines do not exempt a base64 body", () => {
  const header = ["-----", "BEGIN PGP ", "PRIVATE", " KEY BLOCK", "-----"].join("");
  const body = "Ab0+/=".repeat(8);
  const lines = ["Version: Synthetic fixture", "Comment: Synthetic fixture", "", `  ${body}`];
  const sources = [
    `${header} // ${allowMarker}\n${lines.join("\n")}`,
    `${JSON.stringify([header, ...lines].join("\n"))}; // ${allowMarker}`,
  ];
  for (const source of sources)
    assert.deepEqual(checkText(source, "fixture.ts", empty, { lines: true, lineExemptions: true }), [
      "fixture.ts:1: secret shape",
    ]);
});

test("the non-exemptible private key rule requires a literal run of at least 40 base64 characters", () => {
  const header = ["-----", "BEGIN ", "PRIVATE", " KEY", "-----"].join("");
  const scan = (text: string) => checkText(text, "fixture.ts", empty, { lineExemptions: true });
  const body = "Ab0/=".repeat(8);
  assert.deepEqual(scan(`${header} // ${allowMarker}`), []);
  assert.deepEqual(scan(`${header} // ${allowMarker}\n${body.slice(0, 39)}`), []);
  assert.deepEqual(scan(`${header} // ${allowMarker}\n${body.slice(0, 40)}`), ["fixture.ts: secret shape"]);
  const expression = '${"A".repeat(64)}';
  assert.deepEqual(scan(`\`${header}\\n${expression}\\n\`; // ${allowMarker}`), []);
  assert.deepEqual(scan(`${header} // ${allowMarker}\nVersion: ${"Ab0/".repeat(256 * 1024)}`), ["fixture.ts: secret shape"]);
});

test("h: non-NUL Latin-1 files retain term checks alongside generic UTF-8 checks", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "muller");
  writeFileSync(path.join(cwd, "latin.txt"), Buffer.from(`M\xfcller\n${secret}`, "latin1"));
  const head = commit(cwd, "encoded text");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits.sort(), ["latin.txt:1: private term (file line 1)", "latin.txt:2: secret shape"]);
});

test("h: Latin-1 git path bytes are checked and redacted in default and push modes", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "muller");
  const file = Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from("M\xfcller.txt", "latin1")]);
  writeFileSync(file, secret);
  const head = commit(cwd, "encoded path");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits, ["<redacted path>: private term (file line 1) (path)", "<redacted path>:1: secret shape"]);
});

test("B: requireTerms needs the root file even with environment terms", () => {
  const cwd = directory();
  for (const value of ["", " \t\r\n", "# comment\n  # another", "!alice example\n!", "alice example"]) {
    assert.throws(
      () => loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: value }, { root: cwd, requireTerms: true }),
      (error: unknown) =>
        error instanceof PublicCheckError && error.message.startsWith("check:public: private terms list required;"),
    );
  }
  assert.equal(
    loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "# comment\nalice example" }, { root: cwd }).terms.length,
    1,
  );
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  assert.equal(loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "# comment" }, { root: cwd, requireTerms: true }).terms.length, 1);
  const terms = loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "alice example" }, { root: cwd, requireTerms: true });
  assert.deepEqual(checkText("alice-example", "draft", terms), ["draft: private term (env line 1)"]);
  assert.throws(
    () => loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "alice example" }, { root: directory(), requireTerms: true }),
    (error: unknown) =>
      error instanceof PublicCheckError && error.message.startsWith("check:public: private terms list required;"),
  );
});

test("R6.1: contiguous bodies remain visible in flattened, quoted, array and blank-separated layouts", () => {
  const header = ["-----", "BEGIN RSA ", "PRIVATE", " KEY", "-----"].join("");
  const footer = header.replace("BEGIN", "END");
  const body = "Ab0+/=".repeat(32);
  const layouts = [
    `"${header} ${body} ${footer}"; // ${allowMarker}`,
    `"${header}\\n" + // ${allowMarker}\n  "${body}\\n" +\n  "${footer}"`,
    `["${header}", // ${allowMarker}\n  "${body}",\n  "${footer}"]`,
    `\`${header} // ${allowMarker}\n${"\n".repeat(19)}${body}\n${footer}\``,
    `"${header}\\r\\n${"\\r\\n".repeat(19)}${body}\\n${footer}"; // ${allowMarker}`,
  ];
  for (const source of layouts)
    assert.deepEqual(checkText(source, "fixture.ts", empty, { lines: true, lineExemptions: true }), [
      "fixture.ts:1: secret shape",
    ]);
  const scan = (suffix: string) => checkText(`${header} // ${allowMarker}\n${suffix}`, "fixture", empty, { lineExemptions: true });
  assert.deepEqual(scan(""), []);
  assert.deepEqual(scan(`${"#\n".repeat(19)}${body}`), ["fixture: secret shape"]);
  assert.deepEqual(scan(`${"#\n".repeat(20)}${body}`), []);
  assert.deepEqual(scan('${"A".repeat(64)}'), []);
});

test("R6.2: UTF-32 and malformed UTF-16 cannot hide raw terms in any file mode", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "alice example\nmuller");
  const text = `${blockedMail}\n${home("alice-example")}\nalice-example\n`;
  const raw = Buffer.concat([Buffer.from(text), Buffer.from("M\xfcller", "latin1")]);
  const cases: [string, Buffer, boolean][] = [
    ["utf32le.txt", Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), raw]), true],
    ["utf32be.txt", Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), raw]), true],
    ["ascii-bom.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), raw]), false],
    ["nul-le.txt", Buffer.concat([utf16("\ufeffpublic\0"), raw]), true],
    ["nul-be.txt", Buffer.concat([utf16("\ufeffpublic\0", true), raw]), true],
  ];
  for (const [file, bytes] of cases) writeFileSync(path.join(cwd, file), bytes);
  const head = commit(cwd, "encoded files");
  const results = [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits];
  for (const [file, , unknown] of cases) {
    const explicit = cli(cwd, ["--file", file]);
    assert.equal(explicit.status, 1);
    assert.equal(explicit.stdout, "");
    for (const hits of [...results, explicit.stderr.trim().split("\n")]) {
      if (unknown) assert.ok(hits.includes(`${file}: binary file of unknown type`));
      assert.ok(hits.includes(`${file}:3: private term (file line 1)`));
      assert.ok(hits.includes(`${file}:4: private term (file line 2)`));
      assert.ok(hits.every((hit) => !hit.includes(blockedMail) && !hit.includes("alice-example")));
    }
  }
  for (const bigEndian of [false, true]) {
    const encoded = Buffer.alloc((text.length + 1) * 4);
    [...`\ufeff${text}`].forEach((character, index) => {
      if (bigEndian) encoded.writeUInt32BE(character.codePointAt(0) as number, index * 4);
      else encoded.writeUInt32LE(character.codePointAt(0) as number, index * 4);
    });
    const file = bigEndian ? "encoded-be.txt" : "encoded-le.txt";
    writeFileSync(path.join(cwd, file), encoded);
    const encodedHead = commit(cwd, "UTF-32 text");
    for (const hits of [
      checkPublic({ cwd }).hits,
      checkPublicPush(cwd, encodedHead).hits,
      checkPublic({ cwd, files: [file] }).hits,
    ]) assert.ok(hits.includes(`${file}: binary file of unknown type`));
  }
});

test("R6.3: binary images, mismatched extensions and PNG EXIF fail closed", () => {
  const cwd = repo();
  const cases: [string, Buffer, string][] = [
    ["image.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0]), Buffer.from(`<xmp>${blockedMail}</xmp>`)]), "binary file of unknown type"],
    ["image.gif", Buffer.from("GIF89a\0"), "binary file of unknown type"],
    ["image.webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]), "binary file of unknown type"],
    ["image.ico", Buffer.from([0, 0, 1, 0]), "binary file of unknown type"],
    ["font.png", Buffer.from("wOF2\0"), "binary file of unknown type"],
    ["image.txt", png(), "binary file of unknown type"],
    ["metadata.png", png(pngChunk("eXIf", Buffer.from("synthetic metadata"))), "binary metadata"],
  ];
  for (const [file, bytes] of cases) writeFileSync(path.join(cwd, file), bytes);
  const head = commit(cwd, "binary fixtures");
  const expected = cases.map(([file, , label]) => `${file}: ${label}`).sort();
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits])
    assert.deepEqual(hits.sort(), expected);
});

test("R6.4: emails in URL queries, paths, fragments and quotes are checked", () => {
  for (const value of [
    `https://example.com/?email=${blockedMail}`,
    `/user/${blockedMail}/`,
    `https://example.com/#${blockedMail}`,
    `"${blockedMail}"`,
    `\`${blockedMail}\``,
    ...["!", "=", "/", "?", "&", ":", "<"].map((prefix) => `${prefix}${blockedMail}`),
    email("a.b%tag+label-x", "mail.fixture"),
  ]) assert.deepEqual(check(value), ["--text #1: email address"]);
  assert.deepEqual(check(`https://${blockedMail}/`), []);
  assert.deepEqual(check(`https://example.com/?email=${email("person", "example.com")}`), []);
});

test("R6.5: mergetag tagger identities and messages receive the public checks", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "alice example\nprivate note");
  const parent = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "--quiet", "-c", "tagged");
  const side = commit(cwd, "tagged change");
  const object = path.join(directory(), "tag");
  const taggerMail = email("alice-example", "mail.fixture");
  const tag = [
    `object ${side}`, "type commit", "tag fixture-tag",
    `tagger alice-example <${taggerMail}> 1234567890 +0000`,
    "", `private-note\n${home("alice-example")}`, "",
  ].join("\n");
  writeFileSync(object, tag);
  const tagOid = git(cwd, "hash-object", "-t", "tag", "-w", object);
  git(cwd, "update-ref", "refs/tags/fixture-tag", tagOid);
  git(cwd, "switch", "--quiet", "feature");
  git(cwd, "merge", "--no-ff", "--no-verify-signatures", "-m", "public merge", "fixture-tag");
  // A signed annotated-tag merge stores the tag object as this continuation header.
  // Serialize the same header without invoking a signer or using real key material.
  const merge = git(cwd, "cat-file", "commit", "HEAD");
  assert.ok(merge.includes(`parent ${parent}\nparent ${side}\n`));
  const split = merge.indexOf("\n\n");
  writeFileSync(object, `${merge.slice(0, split)}\nmergetag ${tag.trimEnd().replaceAll("\n", "\n ")}\n\npublic merge\n`);
  const head = git(cwd, "hash-object", "-t", "commit", "-w", object);
  git(cwd, "update-ref", "refs/heads/feature", head);
  assert.equal(git(cwd, "show", "-s", "--format=%B", head), "public merge");
  const location = `commit ${head.slice(0, 7)} mergetag`;
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    assert.ok(hits.includes(`${location}:4:8: private term (file line 1)`));
    assert.ok(hits.includes(`${location}:4:23: email address`));
    assert.ok(hits.includes(`${location}:4:23: private term (file line 1)`));
    assert.ok(hits.includes(`${location}:6:1: private term (file line 2)`));
    assert.ok(hits.includes(`${location}:7:1: real home path`));
    assert.ok(hits.every((hit) => !hit.includes(taggerMail) && !hit.includes("alice-example")));
  }
  git(cwd, "config", "user.name", "alice-example");
  git(cwd, "config", "user.email", taggerMail);
  assert.ok(checkPublicPush(cwd, head).hits.every((hit) => !hit.includes("mergetag:4:")));
});

test("R6.7: inherited git location variables cannot redirect a cwd scan", () => {
  const cwd = repo();
  const other = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  writeFileSync(path.join(other, ".private-terms"), "unused-synthetic-term");
  writeFileSync(path.join(cwd, "draft.txt"), blockedMail);
  for (const extra of [
    { GIT_DIR: path.join(other, ".git") },
    Object.fromEntries([
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
    ].map((key) => [key, path.join(other, "missing")])),
  ]) {
    const result = cli(cwd, [], {
      ...extra,
      PATH: gitShim(`
        for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
          "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "EMEND_PRIVATE_TERMS"])
          if (process.env[key] !== undefined) process.exit(128);
        if (!args.includes("submodule.recurse=false")) process.exit(128);
      `),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "draft.txt:1: email address\n");
  }
});

test("R6.8: the shared macOS home directory is a placeholder", () => {
  for (const name of ["Shared", "shared", "SHARED"]) {
    assert.deepEqual(check(home(name, true)), []);
    assert.deepEqual(check(home(name, true).slice(0, -"/file".length)), []);
  }
  assert.deepEqual(check(home("Shared-example", true)), ["--text #1: real home path"]);
});

test("R6.9: push notes name only added marker lines and redact private paths", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "alice example");
  const marked = `public // ${allowMarker}`;
  writeFileSync(path.join(cwd, "existing.txt"), `${marked}\n`);
  writeFileSync(path.join(cwd, "was-binary.txt"), "public\0");
  commit(cwd, "existing marker");
  git(cwd, "push", "--quiet", "origin", "feature");
  writeFileSync(path.join(cwd, "existing.txt"), `inserted\n${marked}\nnew // ${allowMarker}\n`);
  writeFileSync(path.join(cwd, "new.txt"), `${marked}\n${marked}\nmentions ${allowMarker} in prose\n`);
  writeFileSync(path.join(cwd, "alice-example.txt"), `${marked}\n`);
  writeFileSync(path.join(cwd, "was-binary.txt"), `${marked}\n`);
  writeFileSync(path.join(cwd, "encoded.txt"), utf16(`\ufeff${marked}\n`));
  const head = commit(cwd, "new markers");
  const result = checkPublicPush(cwd, head);
  assert.deepEqual(result.notes.sort(), [
    "[redacted].txt:1", "encoded.txt:1", "existing.txt:3", "new.txt:1", "was-binary.txt:1",
  ].map((location) => `note: new check-public allow marker at ${location} in commit ${head.slice(0, 12)}`).sort());
  assert.deepEqual(result.hits, ["<redacted path>: private term (file line 1) (path)"]);
});

test("R7.B: terms files accept UTF-8 BOM and reject other encodings and NUL", () => {
  const cwd = directory();
  const file = path.join(cwd, ".private-terms");
  writeFileSync(file, "\ufeff# synthetic\nalice example\n");
  const terms = loadPrivateTerms(cwd, {}, { root: cwd, requireTerms: true });
  assert.deepEqual(checkText("alice-example", "draft", terms), ["draft: private term (file line 2)"]);
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from("alice\0example"),
    utf16("\ufeffalice example"),
    utf16("\ufeffalice example", true),
    Buffer.from([0xff, 0xfe, 0, 0]),
    Buffer.from([0, 0, 0xfe, 0xff]),
  ]) {
    writeFileSync(file, bytes);
    for (const requireTerms of [false, true])
      assert.throws(
        () => loadPrivateTerms(cwd, {}, { root: cwd, requireTerms }),
        (error: unknown) => error instanceof PublicCheckError && error.message === "check:public: could not read private terms list",
      );
  }
});

test("R7.A: changed invalid UTF-8 bytes do not reuse an approved marker line", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const file = path.join(cwd, "encoded.txt");
  writeFileSync(file, Buffer.from(`\xe9 // ${allowMarker}\n`, "latin1"));
  commit(cwd, "owner marker");
  git(cwd, "push", "--quiet", "origin", "feature");
  writeFileSync(file, Buffer.from(`\xfc // ${allowMarker}\n`, "latin1"));
  const head = commit(cwd, "changed marker");
  const result = checkPublicPush(cwd, head);
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.newMarkers, ["encoded.txt:1"]);
});

test("R7.B: inline comments name only the line and required lists must contain file terms", () => {
  const cwd = directory();
  const file = path.join(cwd, ".private-terms");
  for (const line of ["alice example # annotation", "!alice example\t# annotation"]) {
    writeFileSync(file, `# synthetic\n${line}\n`);
    assert.throws(
      () => loadPrivateTerms(cwd, {}, { root: cwd }),
      (error: unknown) => error instanceof PublicCheckError && error.message === "check:public: inline comment in private terms list at line 2",
    );
  }
  for (const contents of ["", "\ufeff", "# synthetic\n \t\n", "!alice example\n# synthetic\n"]) {
    writeFileSync(file, contents);
    assert.throws(
      () => loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "alice example" }, { root: cwd, requireTerms: true }),
      (error: unknown) => error instanceof PublicCheckError && error.message === "check:public: the private terms list holds no terms",
    );
  }
  rmSync(file);
  assert.throws(
    () => loadPrivateTerms(cwd, {}, { root: cwd, requireTerms: true }),
    (error: unknown) => error instanceof PublicCheckError && error.message ===
      "check:public: private terms list required; ask the owner to create <main>/.private-terms; agents never create, read or edit it",
  );
});

test("R7.C: text hits identify fields and original line-column offsets without content", () => {
  const cwd = directory();
  writeFileSync(path.join(cwd, ".private-terms"), "alice example");
  const text = "public\n  alice\n      example";
  for (const field of ["title", "body", "message", "branch"]) {
    assert.deepEqual(checkPublic({ cwd, root: cwd, texts: [{ field, text }] }).hits, [
      `${field}:2:3: private term (file line 1)`,
    ]);
  }
  const result = cli(cwd, ["--root", cwd, "--text", "public", "--text", text, "--text", `public\n  ${blockedMail}`]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "--text #2:2:3: private term (file line 1)\n--text #3:2:3: email address\n");
  assert.equal(result.stdout, "");
});

test("R7.D: AGE requires at least 50 literal key characters and cannot use a marker", () => {
  const prefix = ["AGE-SECRET-", "KEY-1"].join("");
  const alphabet = "ABCDEF0123456789".repeat(4);
  for (const suffix of ["", ` // ${allowMarker}`]) {
    for (const length of [0, 49, 50, 64])
      assert.deepEqual(
        checkText(`${prefix}${alphabet.slice(0, length)}${suffix}`, "draft", empty, { lineExemptions: true }),
        length < 50 ? [] : ["draft: secret shape"],
      );
    assert.deepEqual(checkText(`${prefix}${'${"Q".repeat(58)}'}${suffix}`, "draft", empty, { lineExemptions: true }), []);
  }
});

test("R7.D: PuTTY and SSH2 bodies reuse the twenty-line scanner; bare literals stay clean", () => {
  const body = "Ab0/=".repeat(12);
  for (const header of [
    ["PuTTY-User-", "Key-File-", "3:"].join(""),
    ["---- BEGIN SSH2 ENCRYPTED ", "PRIVATE KEY ----"].join(""),
  ]) {
    const scan = (text: string) => checkText(text, "draft", empty, { lineExemptions: true });
    for (const suffix of ["", ` // ${allowMarker}`]) {
      assert.deepEqual(scan(`${header}${suffix}`), []);
      assert.deepEqual(scan(`${header}\n${body.slice(0, 39)}${suffix}`), []);
      assert.deepEqual(scan(`${header}\n${body.slice(0, 40)}${suffix}`), ["draft: secret shape"]);
      assert.deepEqual(scan(`"${header}\\n${'${"A".repeat(64)}'}";${suffix}`), []);
    }
    for (const source of [
      `"${header} ${body}"; // ${allowMarker}`,
      `"${header}\\n${body}"; // ${allowMarker}`,
      `"${header}\\n" + // ${allowMarker}\n  "${body}\\n"`,
      `["${header}", // ${allowMarker}\n  "${body}"]`,
      `\`${header} // ${allowMarker}\n${"\n".repeat(19)}${body}\``,
      `${header} // ${allowMarker}\n${"#\n".repeat(19)}${body}`,
    ]) assert.deepEqual(scan(source), ["draft: secret shape"]);
    assert.deepEqual(scan(`${header} // ${allowMarker}\n${"#\n".repeat(20)}${body}`), []);
    assert.deepEqual(scan([
      `JSON.stringify({ key: \`${header}\\nPrivate-Lines: 1\\n${'${"A".repeat(64)}'}\\n\` }),`,
      "  ],",
      '])("synthetic test prose that is unrelated to the preceding value", async () => {});',
    ].join("\n")), []);
  }
});

test("R7.E: mergetag object, type and tag lines receive all rules", () => {
  const cwd = repo();
  const parent = git(cwd, "rev-parse", "HEAD");
  const tree = git(cwd, "rev-parse", "HEAD^{tree}");
  const object = path.join(directory(), "commit");
  // Raw commit fixtures exercise every embedded header, including malformed header values.
  for (const header of ["object", "type", "tag"]) {
    writeFileSync(object, [
      `tree ${tree}`, `parent ${parent}`,
      "author Fixture <fixture@example.com> 1234567890 +0000",
      "committer Fixture <fixture@example.com> 1234567890 +0000",
      `mergetag object ${parent}`, " type commit", " tag public",
      ` ${header} ${blockedMail}`,
      " tagger Fixture <fixture@example.com> 1234567890 +0000", " ", " public", "", "public", "",
    ].join("\n"));
    const head = git(cwd, "hash-object", "-t", "commit", "-w", object);
    for (const hits of [checkPublic({ cwd, commits: `${parent}..${head}` }).hits, checkPublicPush(cwd, head).hits])
      assert.deepEqual(hits, [`commit ${head.slice(0, 7)} mergetag:4:${header.length + 2}: email address`]);
  }
});

test("R7.I: node is an allowed home folder while longer names remain private", () => {
  assert.deepEqual(check(home("node")), []);
  assert.deepEqual(check(home("NODE")), []);
  assert.deepEqual(check(home("node-example")), ["--text #1: real home path"]);
});

test("R8.1: key lookahead crosses every container line and YAML closer", () => {
  const pem = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const putty = ["PuTTY-User-", "Key-File-3:"].join("");
  const body = "Ab0+/=".repeat(32);
  for (const closer of ["],", "}", ")", "]"]) {
    for (const newline of ["\n", "\\n"]) {
      const text = [`"${pem}", // ${allowMarker}`, closer, `"${body}"`].join(newline);
      assert.deepEqual(checkText(text, "fixture", empty, { lineExemptions: true }), ["fixture: secret shape"]);
    }
  }
  const yaml = `key: |\n  ${pem} # ${allowMarker}\n  ]\n  ${body}`;
  assert.deepEqual(checkText(yaml, "fixture", empty, { lineExemptions: true }), ["fixture: secret shape"]);
  assert.deepEqual(checkText(`${putty}\n)\n${body}`, "fixture", empty), ["fixture: secret shape"]);
});

test("R8.2: UTF-16 marker keys do not depend on git byte line numbers", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const file = path.join(cwd, "encoded.txt");
  const approved = `approved // ${allowMarker}`;
  writeFileSync(file, utf16(`\ufeff\u040a\n${approved}\n`));
  commit(cwd, "owner marker");
  git(cwd, "push", "--quiet", "origin", "feature");
  writeFileSync(file, utf16(`\ufeff\u040a\n${approved}\nnew // ${allowMarker}\n`));
  const head = commit(cwd, "new marker");
  const result = checkPublicPush(cwd, head);
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.newMarkers, ["encoded.txt:3"]);
  const output = cli(cwd, ["--push", head], {
    PATH: gitShim('if (args.includes("diff") && args.includes("--unified=0")) process.exit(128);'),
  });
  assert.equal(output.status, 0);
  assert.equal(output.stderr, `note: new check-public allow marker at encoded.txt:3 in commit ${head.slice(0, 12)}\n`);
});

test("R8.2: encoded and NUL-bearing files cannot use marker exemptions", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const marked = `${blockedMail} // ${allowMarker}\n`;
  const cases: [string, Buffer][] = [
    ["le.txt", utf16(`\ufeff${marked}`)],
    ["be.txt", utf16(`\ufeff${marked}`, true)],
    ["nul.txt", Buffer.from(`\0${marked}`)],
    ["utf32.txt", Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), Buffer.from(marked)])],
  ];
  for (const [file, bytes] of cases) writeFileSync(path.join(cwd, file), bytes);
  const head = commit(cwd, "encoded markers");
  for (const hits of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits]) {
    assert.deepEqual(hits.sort(), [
      "be.txt:1: email address", "le.txt:1: email address",
      "nul.txt: binary file of unknown type", "utf32.txt: binary file of unknown type", "utf32.txt:1: email address",
    ]);
  }
  assert.deepEqual(checkPublic({ cwd, root: cwd, files: ["le.txt", "be.txt", "utf32.txt"] }).hits.sort(), [
    "be.txt:1: email address", "le.txt:1: email address", "utf32.txt: binary file of unknown type", "utf32.txt:1: email address",
  ]);
  assert.throws(() => checkPublic({ cwd, root: cwd, files: ["nul.txt"] }),
    (error: unknown) => error instanceof PublicCheckError && error.code === 1 &&
      error.message === "check:public: explicit input contains a NUL byte");
});

test("R8.5: terms reject hidden line separators and recognize comments before normalization", () => {
  const cwd = directory();
  const file = path.join(cwd, ".private-terms");
  for (const separator of ["\r", "\u2028", "\u2029", "\u0085", "\v", "\f"]) {
    for (const prefix of ["alice", "# comment"]) {
      writeFileSync(file, `# synthetic\r\n${prefix}${separator}example\n`);
      assert.throws(() => loadPrivateTerms(cwd, {}, { root: cwd }),
        (error: unknown) => error instanceof PublicCheckError && error.message ===
          "check:public: invalid line separator in private terms list at line 2");
    }
  }
  writeFileSync(file, "# raw comment\r\nalice example\r\n");
  assert.equal(loadPrivateTerms(cwd, {}, { root: cwd }).terms.length, 1);
  writeFileSync(file, "# raw comment\n\u200b # annotation\n");
  assert.throws(() => loadPrivateTerms(cwd, {}, { root: cwd }),
    (error: unknown) => error instanceof PublicCheckError && error.message ===
      "check:public: inline comment in private terms list at line 2");
  writeFileSync(file, "# raw comment\n\u200b#literal\n");
  assert.equal(loadPrivateTerms(cwd, {}, { root: cwd, requireTerms: true }).terms.length, 1);
});

for (const role of ["main", "branch"]) {
  test(`R8.7: marker baseline names a failed ${role} tip fetch`, () => {
    const cwd = repo();
    writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
    const ref = role === "main" ? "main" : "feature";
    const advertised = "b".repeat(40);
    writeFileSync(path.join(cwd, "draft.txt"), `public // ${allowMarker}\n`);
    const head = commit(cwd, "new marker");
    const output = cli(cwd, ["--push", head], {
      PATH: gitShim(`
        if (args.includes("ls-remote")) {
          process.stdout.write(${JSON.stringify(`${advertised}\trefs/heads/${ref}\n`)}); process.exit(0);
        }
        if (args.includes("fetch")) { process.stderr.write("synthetic failure"); process.exit(128); }
      `),
    });
    assert.equal(output.status, 69);
    assert.equal(output.stderr, `check:public: could not fetch origin's ${role} tip for the marker check\n`);
  });
}

test("R8.8: explicit terms roots ignore a git directory in a temporary ancestor", () => {
  const ancestor = directory();
  mkdirSync(path.join(ancestor, ".git"));
  const cwd = path.join(ancestor, "child");
  mkdirSync(cwd);
  const terms = loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "alice example" }, { root: cwd });
  assert.equal(terms.terms.length, 1);
  assert.throws(() => loadPrivateTerms(cwd, {}, { root: cwd, requireTerms: true }),
    (error: unknown) => error instanceof PublicCheckError && error.message.startsWith("check:public: private terms list required;"));
});


test("R8.X: key lookahead never joins nearby prose or identifiers into a body", () => {
  for (const header of [
    ["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""),
    ["PuTTY-User-", "Key-File-3:"].join(""),
    ["---- BEGIN SSH2 ENCRYPTED ", "PRIVATE KEY ----"].join(""),
  ]) {
    for (const following of [
      "ordinary source prose has several separate words and no literal key body",
      "firstSyntheticIdentifier + secondSyntheticIdentifier + thirdSyntheticIdentifier",
      ["firstSyntheticIdentifier", "secondSyntheticIdentifier", "thirdSyntheticIdentifier"].join("\n"),
      ["firstSyntheticIdentifier", "secondSyntheticIdentifier", "thirdSyntheticIdentifier"].join("\\n"),
      'test("ordinary source prose describes a synthetic fixture without literal material", () => {});',
    ]) {
      const source = `${header} // ${allowMarker}\n],\n${following}`;
      assert.deepEqual(checkText(source, "fixture", empty, { lineExemptions: true }), []);
    }
  }
});

const combiningRun = (length: number) => "\u0315".repeat(Math.ceil(length / 2)) + "\u0300".repeat(Math.floor(length / 2));
const compatibilityRun = (length: number) => "\u0301\uff9e".repeat(Math.floor(length / 2)) + (length % 2 ? "\u0301" : "");

test("R8.9: 64k combining-mark runs refuse text before normalization; exactly 32 pass", () => {
  const terms = { ...empty, terms: [{ value: "unused-synthetic-term", line: 1 }] };
  for (const generic of [false, true]) {
    for (const count of [32, 33, 64 * 1024]) {
      const text = `public\na${combiningRun(count)} // ${allowMarker}`;
      assert.deepEqual(checkText(text, "body", terms, { columns: true, lineExemptions: true, generic }),
        count === 32 ? [] : ["body:2:2: combining-mark run"]);
    }
  }
  const astral = String.fromCodePoint(0x1d185);
  assert.deepEqual(checkText(astral.repeat(32), "body", terms), []);
  assert.deepEqual(checkText(astral.repeat(33), "body", terms), ["body: combining-mark run"]);
  assert.deepEqual(checkText(`a${combiningRun(32)}b${combiningRun(32)}`, "body", terms), []);
  assert.deepEqual(checkText(secret, `draft-a${combiningRun(64 * 1024)}.txt`, terms), ["<redacted path>: secret shape"]);
});

for (const [round, makeRun] of [["R8.9", combiningRun], ["R9.11", compatibilityRun]] as const) {
test(`${round}: files, paths and commit messages reject overlong marks with locations only`, () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const short = `a${makeRun(32)}`;
  const long = `a${makeRun(64 * 1024)}`;
  const shortPath = `${short}.txt`;
  const longPath = `a${makeRun(33)}.txt`; // A real filesystem component cannot hold 64k marks.
  writeFileSync(path.join(cwd, shortPath), short);
  writeFileSync(path.join(cwd, longPath), "public");
  writeFileSync(path.join(cwd, "encoded.txt"), `public\n${long}`);
  git(cwd, "add", "-A");
  const message = path.join(directory(), "message");
  writeFileSync(message, `public\n\n${long}\n`);
  git(cwd, "commit", "--quiet", "--file", message);
  const head = git(cwd, "rev-parse", "HEAD");
  const messageHit = `commit ${head.slice(0, 7)} message:3:2: combining-mark run`;
  const expected = ["<redacted path>: combining-mark run (path)", "encoded.txt:2: combining-mark run", messageHit].sort();
  for (const hits of [checkPublic({ cwd, root: cwd }).hits, checkPublicPush(cwd, head, { root: cwd }).hits])
    assert.deepEqual(hits.sort(), expected);
  assert.deepEqual(checkPublic({ cwd, root: cwd, files: ["encoded.txt", shortPath, longPath] }).hits,
    ["encoded.txt:2: combining-mark run", "<redacted path>: combining-mark run (path)"]);
  // The guard must report the rule before a 64k path could fail with a filesystem length error.
  assert.deepEqual(checkPublic({ cwd, root: cwd, files: [`${long}.txt`] }).hits,
    ["<redacted path>: combining-mark run (path)"]);
  assert.deepEqual(checkPublic({ cwd, root: cwd, commits: `${head}^..${head}` }).hits, [messageHit]);
  writeFileSync(message, `${short}\n`);
  git(cwd, "commit", "--quiet", "--allow-empty", "--file", message);
  assert.deepEqual(checkPublic({ cwd, root: cwd, commits: "HEAD^..HEAD" }).hits, []);
});

test(`${round}: terms lists reject overlong combining marks before normalization`, () => {
  const cwd = directory();
  for (const count of [32, 33, 64 * 1024]) {
    writeFileSync(path.join(cwd, ".private-terms"), `# synthetic\na${makeRun(count)}\n`);
    if (count === 32) assert.equal(loadPrivateTerms(cwd, {}, { root: cwd }).terms.length, 1);
    else assert.throws(() => loadPrivateTerms(cwd, {}, { root: cwd }),
      (error: unknown) => error instanceof PublicCheckError && error.message === "private terms list:2: combining-mark run");
  }
});

}


test("R11.A: contiguous pasted bodies use twenty nonblank lines and redact through the last run", () => {
  const header = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const body = "Ab01Cd23".repeat(8);
  const scan = (suffix: string) => checkText(`${header} // ${allowMarker}\n${suffix}`, "fixture", empty, { lineExemptions: true });
  assert.deepEqual(scan(`${"\n".repeat(20)}${body}`), ["fixture: secret shape"]);
  assert.deepEqual(scan(`${"#\n".repeat(19)}${body}`), ["fixture: secret shape"]);
  assert.deepEqual(scan(`${"#\n".repeat(20)}${body}`), []);
  for (const newline of ["\n", "\\n", "\\r\\n"]) {
    const text = `${header} // ${allowMarker}${newline}${body}${newline}ordinary line${newline}${body}`;
    assert.deepEqual(checkText(secret, text, empty), ["[redacted]: secret shape"]);
    // Runs beyond the window are not part of the header's span.
    const outside = `${header} ${body}${newline}${"#".concat(newline).repeat(20)}${body}`;
    const hits = checkText(secret, outside, empty);
    assert.ok(hits[0]?.startsWith("[redacted]"));
    assert.ok(hits[0]?.endsWith(`${body}: secret shape`));
  }
});

test("R9.4: fake UTF BOMs receive generic checks on both raw decodings in every file mode", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const text = `public\n${blockedMail}\n${home("alice-example")}\n${secret}\n`;
  for (const [name, bom] of [
    ["le16", [0xff, 0xfe]], ["be16", [0xfe, 0xff]],
    ["le32", [0xff, 0xfe, 0, 0]], ["be32", [0, 0, 0xfe, 0xff]],
  ] as const) writeFileSync(path.join(cwd, `${name}.txt`), Buffer.concat([Buffer.from(bom), Buffer.from(text)]));
  const head = commit(cwd, "fake encodings");
  for (const mode of [checkPublic({ cwd }).hits, checkPublicPush(cwd, head).hits,
    checkPublic({ cwd, files: ["le16.txt", "be16.txt", "le32.txt", "be32.txt"] }).hits])
    for (const name of ["le16", "be16", "le32", "be32"]) {
      assert.ok(mode.includes(`${name}.txt:2: email address`));
      assert.ok(mode.includes(`${name}.txt:3: real home path`));
      assert.ok(mode.includes(`${name}.txt:4: secret shape`));
    }
});

test("R9.5: hidden controls invalidate an allow marker; CRLF and tabs remain valid", () => {
  for (const control of ["\r", "\u2028", "\u2029", "\u0085", "\v", "\f", "\0", "\x1b", "\u202e", "\u200b"]) {
    assert.deepEqual(checkText(`${blockedMail}${control}const c = 3; // ${allowMarker}`, "fixture", empty, { lineExemptions: true }), ["fixture: email address"]);
  }
  for (const suffix of ["", "\r", "\r\n"]) assert.deepEqual(
    checkText(`${blockedMail}\t// ${allowMarker}${suffix}`, "fixture", empty, { lineExemptions: true }), []);
});

test("R11.B: markers count once per changed commit, path and key", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const first = `first // ${allowMarker}\n`;
  const second = `second // ${allowMarker}\n`;
  writeFileSync(path.join(cwd, "draft.txt"), first.repeat(2));
  const firstCommit = commit(cwd, "first marker");
  writeFileSync(path.join(cwd, "draft.txt"), second.repeat(2));
  const secondCommit = commit(cwd, "second marker");
  writeFileSync(path.join(cwd, "draft.txt"), `${second}public\n${second}`);
  const head = commit(cwd, "move an existing marker");
  const result = checkPublicPush(cwd, head);
  assert.deepEqual(result.newMarkers, ["draft.txt:1", "draft.txt:1", "draft.txt:1"]);
  assert.deepEqual(result.notes, [head, secondCommit, firstCommit].map((sha) => `note: new check-public allow marker at draft.txt:1 in commit ${sha.slice(0, 12)}`));
});

test("R9.8: environment terms reject every hidden line separator before parsing comments", () => {
  const cwd = directory();
  for (const character of ["\r", "\u2028", "\u2029", "\u0085", "\v", "\f"])
    assert.throws(() => loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: `# comment\n# hidden${character}text` }, { root: cwd }),
      (error: unknown) => error instanceof PublicCheckError && error.message ===
        "check:public: invalid line separator in EMEND_PRIVATE_TERMS at line 2");
  assert.equal(loadPrivateTerms(cwd, { EMEND_PRIVATE_TERMS: "# comment\r\nunused-synthetic-term" }, { root: cwd }).terms.length, 1);
});

test("R9.3: the scanner strips all Git config environment overrides", () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, ".private-terms"), "unused-synthetic-term");
  const result = cli(cwd, ["--push", "HEAD"], {
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "synthetic override",
    GIT_CONFIG_PARAMETERS: "'user.email=synthetic@example.com'",
    GIT_CONFIG_GLOBAL: "/nonexistent", GIT_CONFIG_SYSTEM: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1",
    PATH: gitShim(`if (Object.keys(process.env).some((key) => /^GIT_CONFIG_(?:PARAMETERS|COUNT|GLOBAL|SYSTEM|NOSYSTEM|KEY_.*|VALUE_.*)$/.test(key))) process.exit(128);`),
  });
  assert.equal(result.status, 0);
});


test("R9.11: 64k compatibility and mixed mark runs refuse text; exactly 32 code points pass", () => {
  const terms = { ...empty, terms: [{ value: "unused-synthetic-term", line: 1 }] };
  for (const makeRun of [(length: number) => "\uff9e".repeat(length), compatibilityRun]) {
    for (const generic of [false, true]) {
      for (const count of [32, 33, 64 * 1024]) {
        const text = `public\na${makeRun(count)} // ${allowMarker}`;
        assert.deepEqual(checkText(text, "body", terms, { columns: true, lineExemptions: true, generic }),
          count === 32 ? [] : ["body:2:2: combining-mark run"]);
      }
    }
    assert.deepEqual(checkText(secret, `draft-a${makeRun(64 * 1024)}.txt`, terms), ["<redacted path>: secret shape"]);
    assert.deepEqual(checkText(`a${makeRun(32)}\u00e1${makeRun(32)}`, "body", terms), []);
  }
  const astral = String.fromCodePoint(0x1d185);
  assert.deepEqual(checkText(astral.repeat(16) + "\uff9f".repeat(16), "body", terms), []);
  assert.deepEqual(checkText(astral.repeat(17) + "\uff9f".repeat(16), "body", terms), ["body: combining-mark run"]);
  assert.deepEqual(checkText(`public\n\u{1f642}a${compatibilityRun(33)}!${compatibilityRun(33)}`, "body", terms, { columns: true }),
    ["body:2:4: combining-mark run", "body:2:38: combining-mark run"]);
});

test("R9.11: environment terms enforce the compatibility mark bound", () => {
  const cwd = directory();
  for (const count of [32, 33, 64 * 1024]) {
    const env = { EMEND_PRIVATE_TERMS: `# synthetic\na${compatibilityRun(count)}` };
    if (count === 32) assert.equal(loadPrivateTerms(cwd, env, { root: cwd }).terms.length, 1);
    else assert.throws(() => loadPrivateTerms(cwd, env, { root: cwd }),
      (error: unknown) => error instanceof PublicCheckError && error.message === "EMEND_PRIVATE_TERMS:2: combining-mark run");
  }
});


test("R10.B: key spans redact the entire body in a location", () => {
  const header = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const body = "Ab01Cd23".repeat(8);
  assert.deepEqual(checkText(secret, `${header} ${body}.txt`, empty), ["[redacted].txt: secret shape"]);
});

test("R10.B: word boundaries keep prose and test tables out of key bodies", () => {
  const header = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  for (const prose of [
    'test.each(["Synthetic public text 1", "Another Synthetic line 2", "More Synthetic text 3"]);',
    "This section describes version 2 of the key handling implementation",
  ]) assert.deepEqual(checkText(`${header} // ${allowMarker}\n${prose}`, "fixture", empty, { lineExemptions: true }), []);
  const putty = ["PuTTY-User-", "Key-File-3:"].join("");
  assert.deepEqual(checkText(`${putty} This section describes version 2 of the key handling implementation.`, "fixture", empty), []);
});

test("R11.A: short fragments and ordinary code never join into a key body", () => {
  const fragment = "Ab01Cd23".repeat(4);
  for (const header of [["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""), ["PuTTY-User-", "Key-File-3:"].join("")]) {
    for (const expression of [
      `const body = "${fragment}" + "${fragment}";`,
      `call("${fragment}", "${fragment}");`,
      `test.each(["${fragment}", "${fragment}"]);`,
      `["${fragment}",\n"${fragment}"]`,
      `${fragment} ${fragment}`,
      `${fragment}\n${fragment}`,
      `${fragment}\\n${fragment}`,
      ...[30, 34, 39].map((width) => `${fragment.repeat(2).slice(0, width)}\n${fragment.repeat(2).slice(width)}`),
      "See Alpha, Beta, Gamma, Delta, Epsilon, Zeta, Theta, Iota2 for examples.",
      "This section describes version 2 of the key handling implementation",
      'const synthetic = { body: "Ab01".repeat(64) };\nexpect(synthetic.body.length).toBe(256);',
    ]) assert.deepEqual(checkText(`${header} // ${allowMarker}\n${expression}`, "fixture", empty, { lineExemptions: true }), []);
  }
});

test("R11.A: pasted PEM, OpenSSH, PuTTY and escaped JSON bodies are found without joining", () => {
  const pem = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const openssh = ["-----BEGIN OPENSSH ", "PRIVATE KEY-----"].join("");
  const putty = ["PuTTY-User-", "Key-File-3:"].join("");
  const body64 = "Ab01Cd23".repeat(8);
  const body70 = "Ab01Cd23".repeat(9).slice(0, 70);
  for (const source of [
    `${pem} // ${allowMarker}\n${body64}\n${body64}\n${pem.replace("BEGIN", "END")}`,
    `["${openssh}", // ${allowMarker}\n"${body70}",\n"${body70}"]`,
    `${putty} ssh-ed25519\nEncryption: none\nPrivate-Lines: 2\n${body64}\n${body64}`,
    ...["\n", "\r\n"].map((newline) => `${JSON.stringify([pem, body64, body64].join(newline))}; // ${allowMarker}`),
  ]) assert.deepEqual(checkText(source, "fixture", empty, { lineExemptions: true }), ["fixture: secret shape"]);
});

test("R10.B: a multi-megabyte body is scanned without a regex stack", () => {
  const header = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const body = "Ab01Cd23".repeat(512 * 1024);
  assert.deepEqual(checkText(`${header} // ${allowMarker}\n${body}`, "fixture", empty, { lineExemptions: true }), ["fixture: secret shape"]);
  const hits = checkText(secret, `${header} ${body}.txt`, empty);
  assert.equal(hits.length, 1);
  assert.ok(hits[0] === "[redacted].txt: secret shape");
});


test("R11.B: an intermediate scanned commit cannot approve an inherited marker", () => {
  const cwd = repo();
  const marked = `synthetic fixture line // ${allowMarker}`;
  writeFileSync(path.join(cwd, "notes.txt"), `${marked}\nfirst\n`);
  commit(cwd, "other branch marker");
  git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/other");
  writeFileSync(path.join(cwd, "another.txt"), "synthetic fixture\n");
  commit(cwd, "change another file");
  writeFileSync(path.join(cwd, "notes.txt"), `${marked}\nsecond\n`);
  const head = commit(cwd, "edit the same file");
  const result = checkPublicPush(cwd, head, { root: cwd });
  assert.deepEqual(result.newMarkers, ["notes.txt:1"]);
  assert.ok(result.notes.includes(`note: new check-public allow marker at notes.txt:1 in commit ${head.slice(0, 12)}`));
});

test("R10.D: deleting a file or replacing it without markers never reads its old blob", () => {
  for (const remove of [true, false]) {
    const cwd = repo();
    writeFileSync(path.join(cwd, "old.txt"), "old synthetic content\n");
    const parent = commit(cwd, "old file");
    const old = git(cwd, "rev-parse", `${parent}:old.txt`);
    // Exclude the parent from content scanning without adding it to the marker baseline.
    git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/other");
    if (remove) rmSync(path.join(cwd, "old.txt"));
    else writeFileSync(path.join(cwd, "old.txt"), "new synthetic content\n");
    const head = commit(cwd, "change old file");
    const scan = `import {checkPublicPush} from ${JSON.stringify(new URL("./check-public.ts", import.meta.url).href)};
      const result = checkPublicPush(process.cwd(), ${JSON.stringify(head)}, {root:process.cwd()});
      if (result.hits.length || result.newMarkers.length) process.exit(1);`;
    const output = nodeCaptured(cwd, ["--input-type=module", "-e", scan], {
      PATH: gitShim(`if (args.includes("cat-file") && args.includes("blob") && args.includes(${JSON.stringify(old)})) process.exit(128);`),
    });
    assert.equal(output.status, 0);
    assert.equal(output.stderr, "");
  }
});


test("R11.B: marker checks never reread a scanned parent's blob", () => {
  for (const change of ["delete", "plain", "marker"]) {
    const cwd = repo();
    const marked = `synthetic fixture line // ${allowMarker}\n`;
    writeFileSync(path.join(cwd, "notes.txt"), `${marked}first\n`);
    const parent = commit(cwd, "first marker");
    const old = git(cwd, "rev-parse", `${parent}:notes.txt`);
    if (change === "delete") rmSync(path.join(cwd, "notes.txt"));
    else writeFileSync(path.join(cwd, "notes.txt"), change === "marker" ? `${marked}second\n` : "plain fixture\n");
    const head = commit(cwd, "change marker file");
    const log = path.join(directory(), "blob-reads");
    const scan = `import {checkPublicPush} from ${JSON.stringify(new URL("./check-public.ts", import.meta.url).href)};
      const result = checkPublicPush(process.cwd(), ${JSON.stringify(head)}, {root:process.cwd()});
      if (result.hits.length) process.exit(1);
      process.stdout.write(String(result.newMarkers.length));`;
    const output = nodeCaptured(cwd, ["--input-type=module", "-e", scan], {
      PATH: gitShim(`if (args.includes("cat-file") && args.includes("blob") && args.includes(${JSON.stringify(old)}))
        require("node:fs").appendFileSync(${JSON.stringify(log)}, "read\\n");`),
    });
    assert.equal(output.status, 0);
    assert.equal(output.stderr, "");
    assert.equal(output.stdout, change === "marker" ? "2" : "1");
    // One read checks the parent's new content. No additional read is allowed for marker comparison.
    assert.equal(readFileSync(log, "utf8"), "read\n");
  }
});


// Gate-hardening fixtures are assembled so their source remains public.
test("G1: private IPv6 requires a complete address and leaves documentation space public", () => {
  for (const prefix of ["fc00", "fd00", "fd12", "fe80", "febf"])
    assert.ok(check([prefix, "", "1"].join(":")).some((hit) => hit.includes("IPv6")), prefix);
  for (const value of [["2001", "db8", "", "1"].join(":"), "fd00:dead", "fe80:beef", "fec0::1"])
    assert.deepEqual(check(value), []);
});

test("G2: LAN hosts exclude placeholders, local filenames and property access", () => {
  for (const suffix of ["lan", "local", "internal", "home.arpa", "corp"]) {
    assert.ok(check(["fixture-host", suffix].join(".")).some((hit) => hit.includes("host name")), suffix);
    assert.deepEqual(check(["example", suffix].join(".")), []);
  }
  for (const value of [".env.local", "settings.local.json", "vitest.config.local.ts", ["this", "local"].join("."), "window.localStorage", "ERROR_STATUS.internal"])
    assert.deepEqual(check(value), []);
});

test("G3: literal bearer tokens and JWTs hit while synthetic and symbolic values pass", () => {
  const token = ["qT7vM2nX9cR4", "hL8sD3wK6pF1", "aZ5uB0eG_jY-"].join("");
  const jwt = [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from('{"sub":"fixture"}').toString("base64url"), token].join(".");
  for (const value of [`Authorization: Bearer ${token}`, `curl -H "aUtHoRiZaTiOn: bEaReR ${token}"`, jwt])
    assert.ok(check(value).some((hit) => hit.includes("secret shape")));
  for (const value of ["<token>", "$VAR", "${VAR}", "…", "xxx", "REDACTED", "a".repeat(43), "Ab01".repeat(12), '${token}', 'em_${"b".repeat(43)}'])
    assert.deepEqual(check(`Authorization: Bearer ${value}`), []);
});

test("G4: nested home paths hit without treating shared directories and routes as people", () => {
  for (const prefix of [["", "var", "home"], ["", "mnt", "c", "Users"], ["", "System", "Volumes", "Data", "Users"]])
    assert.ok(check([...prefix, "fixture-person", "file"].join("/")).some((hit) => hit.includes("home path")));
  for (const slash of ["\\", "\\\\"])
    assert.ok(check(["C:", "Users", "fixture-person", "file"].join(slash)).some((hit) => hit.includes("home path")));
  for (const value of [["", "Users", "Shared"].join("/"), 'fetch("/users/me")', JSON.stringify(["", "home", "settings"].join("/")), "/root/file"])
    assert.deepEqual(check(value), []);
});

test("G5: gateway defaults and documentation ranges pass with actionable private-address labels", () => {
  for (const parts of [[192,168,0,1], [192,168,1,1], [10,0,0,1], [172,16,0,1], [192,0,2,9], [198,51,100,9], [203,0,113,9]])
    assert.deepEqual(check(ip(...parts)), []);
  assert.match(check(ip(10, 42, 7, 9))[0] ?? "", /192\.0\.2\.x.*2001:db8::/);
});

test("G6: lowercase age keys hit", () => {
  const age = ["age-secret-", "key-1", "abc012".repeat(10)].join("");
  assert.deepEqual(check(age), ["--text #1: secret shape"]);
});

test("G6: coverage of already-fixed PuTTY lookahead across a closing parenthesis", () => {
  const header = ["PuTTY-User-", "Key-File-3:"].join("");
  assert.deepEqual(check(`${header}\n)\n${"Ab0/".repeat(16)}`), ["--text #1: secret shape"]);
});

test("G7: escaped base64 symbols count as single key-body characters", () => {
  const header = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  for (const escaped of ["\\/", "\\u002b", "\\u002B", "&#x2F;", "&#47;", "&sol;", "&#43;", "&#x2B;", "&plus;"]) {
    const body = `Ab01${escaped}`.repeat(8);
    const scan = (value: string) => checkText(value, "fixture", empty, { lineExemptions: true });
    assert.deepEqual(scan(`${header} // ${allowMarker}\n${body}`), ["fixture: secret shape"], escaped);
    assert.deepEqual(scan(`${header} // ${allowMarker}\n${`A${escaped}`.repeat(19)}`), [], escaped);
    assert.deepEqual(scan(`${header} // ${allowMarker}\n${"#\n".repeat(20)}${body}`), []);
  }
});

function fontFixture(kind: "woff" | "woff2", body: Buffer, tag = "cmap"): Buffer {
  let compressed = kind === "woff" ? deflateSync(body) : brotliCompressSync(body);
  if (kind === "woff" && compressed.length >= body.length) compressed = body;
  const header = Buffer.alloc(kind === "woff" ? 64 : 49);
  header.write(kind === "woff" ? "wOFF" : "wOF2");
  header.writeUInt32BE(header.length + compressed.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(body.length + 28, 16);
  if (kind === "woff") {
    header.write(tag, 44);
    header.writeUInt32BE(header.length, 48);
    header.writeUInt32BE(compressed.length, 52);
    header.writeUInt32BE(body.length, 56);
  } else {
    header.writeUInt32BE(compressed.length, 20);
    header[48] = tag === "name" ? 5 : tag === "glyf" ? 0xca : tag === "loca" ? 0xcb : 0; // untransformed table, then UIntBase128 length
    const length: number[] = [body.length & 127];
    for (let n = body.length >>> 7; n; n >>>= 7) length.unshift((n & 127) | 128);
    const directory = Buffer.from(length);
    header.writeUInt32BE(header.length + directory.length + compressed.length, 8);
    return Buffer.concat([header, directory, compressed]);
  }
  return Buffer.concat([header, compressed]);
}

test("G8: binary assets scan printable secrets and decompressed font tables", () => {
  for (const [extension, magic] of [["png", ""], ["woff", "wOFF"], ["woff2", "wOF2"], ["ttf", "true"], ["otf", "OTTO"]]) {
    const bytes = extension === "png" ? png(pngChunk("ruNs", Buffer.from(secret))) : Buffer.concat([Buffer.from(`${magic}\0`), Buffer.from(secret)]);
    assert.ok(checkBuffer(bytes, `asset.${extension}`, empty, false).some((hit) => hit.includes("secret shape")), extension);
  }
  for (const kind of ["woff", "woff2"] as const) {
    const bytes = fontFixture(kind, Buffer.from(`${secret}\n${"public ".repeat(30)}`));
    assert.ok(checkBuffer(bytes, `asset.${kind}`, empty, false).some((hit) => hit.includes("secret shape")), kind);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 255;
    assert.ok(checkBuffer(bytes, `asset.${kind}`, empty, false).some((hit) => hit.includes("invalid")), kind);
  }
});

test("G9: inline image bytes receive file checks including PNG metadata and SVG text", () => {
  const terms: PrivateTerms = { terms: [{value: "synthetic private phrase", line: 1}], allowed: [], notes: [] };
  const bytes = png(pngChunk("tEXt", Buffer.from(`Comment\0synthetic private phrase ${home("fixture-person")}`)), pngChunk("eXIf", Buffer.from("fixture")));
  // Deliberately 18 bytes: a shorter body can count as a documentation header.
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 0]), Buffer.alloc(14)]);
  for (const [mime, extension, content] of [["image/png", "png", bytes], ["image/jpeg", "jpg", jpeg]] as const) {
    const fileHits = checkBuffer(content, `image.${extension}`, terms, false).map((hit) => hit.slice(hit.indexOf(": ") + 2));
    const inlineHits = checkBuffer(Buffer.from(`<img src="data:${mime};base64,${content.toString("base64")}">`), "doc.html", terms, false);
    for (const label of fileHits) assert.ok(inlineHits.some((hit) => hit.endsWith(`: ${label}`)), label);
  }
  const svg = `<svg><text>${home("fixture-person")}</text></svg>`;
  for (const uri of [`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, `data:image/svg+xml,${encodeURIComponent(svg)}`])
    assert.ok(checkBuffer(Buffer.from(uri), "doc.html", empty, false).some((hit) => hit.includes("home path")));
});

test("G10: ASCII NUL bytes reuse identical decoded views", (t) => {
  const bytes = Buffer.from("synthetic public\0content");
  const decoder = t.mock.method(bytes, "toString");
  checkBuffer(bytes, "asset.ttf", { terms: [{value:"absent term", line:1}], allowed:[], notes:[] }, false);
  assert.equal(decoder.mock.calls.filter((call) => call.arguments[0] === "latin1").length, 0);
});

test("G12: advertised fork pull refs cannot approve inherited markers", (t) => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "notes.txt"), `public // ${allowMarker}\n`);
  const fork = commit(cwd, "fork marker");
  writeFileSync(path.join(cwd, "other.txt"), "public\n");
  const head = commit(cwd, "public change");
  const destination = readPushDestination(cwd);
  destination.refs.set("refs/pull/1/head", fork);
  // Regular-file stdin keeps this Git integration test independent of pipe support in sandboxes.
  const execute = childProcess.spawnSync;
  const shim = t.mock.method(childProcess, "spawnSync", (command: string, args: readonly string[], options?: SpawnSyncOptions) => {
    if (!options?.input) return execute(command, args, options);
    const input = path.join(directory(), "stdin");
    writeFileSync(input, options.input);
    const fd = openSync(input, "r");
    try { return execute(command, args, {...options, input: undefined, stdio: [fd, "pipe", "pipe"]}); }
    finally { closeSync(fd); }
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(checkPublicPush(cwd, head, {destination}).newMarkers, ["notes.txt:1"]);
  } finally {
    shim.mock.restore();
    syncBuiltinESMExports();
  }
});


test("G8/R5.12: invalid font declarations invoke neither inflater", (t) => {
  const inflate = t.mock.method(zlib, "inflateSync");
  const brotli = t.mock.method(zlib, "brotliDecompressSync");
  syncBuiltinESMExports();
  try {
  for (const kind of ["woff", "woff2"] as const) {
    const bytes = fontFixture(kind, Buffer.from("public fixture ".repeat(10)));
    bytes.writeUInt32BE(50 * 1024 * 1024 + 1, 16);
    assert.ok(checkBuffer(bytes, `asset.${kind}`, empty, false).some((hit) => hit.includes("invalid compressed font")));
  }
  assert.equal(inflate.mock.callCount(), 0);
  assert.equal(brotli.mock.callCount(), 0);
  } finally {
    inflate.mock.restore(); brotli.mock.restore(); syncBuiltinESMExports();
  }
});

test("G9: inline placeholders remain public and oversized images are refused", () => {
  for (const text of ["data:image/png;base64,AAAA", 'data:image/svg+xml;base64,${image}'])
    assert.deepEqual(checkBuffer(Buffer.from(text), "fixture.html", empty, false), []);
  const oversized = Buffer.from(`data:image/png;base64,${"AAAA".repeat(Math.ceil(25 * 1024 * 1024 / 3) + 1)}`);
  // OP3 charges normalization before the inline image limit is reached.
  assert.deepEqual(checkBuffer(oversized, "fixture.html", empty, false), ["fixture.html: scan expansion budget exceeded"]);
  const svg = Buffer.concat([Buffer.from([255, 254]), Buffer.from(`<svg>${home("fixture-person")}</svg>`, "utf16le")]);
  const inline = Buffer.from(`data:image/svg+xml;base64,${svg.toString("base64")}`);
  assert.ok(checkBuffer(inline, "fixture.html", empty, false).some((hit) => hit.includes("home path")));
});

test("G9: explicit text inputs inspect inline images like files", () => {
  const bytes = png(pngChunk("tEXt", Buffer.from(`Comment\0${home("fixture-person")}`)));
  assert.ok(checkText(`data:image/png;base64,${bytes.toString("base64")}`, "body", empty).some((hit) => hit.includes("home path")));
});

test("R2.2: inline SVG extraction follows the enclosing attribute or CSS syntax", () => {
  const svg = `<svg><text>chart (draft) 'quoted' ${home("fixture-person")}</text></svg>`;
  const percent = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const base64 = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const wrappers = [
    (uri: string) => `<img src="${uri}" alt="public">`,
    (uri: string) => `background: url("${uri}");`,
    (uri: string) => `<img src=${uri}>`,
    (uri: string) => `image: ${uri}\npublic`,
    (uri: string) => `![image](${uri})`,
  ];
  for (const uri of [percent, base64]) {
    for (const wrap of wrappers)
      assert.ok(check(wrap(uri)).some((hit) => hit.includes("home path")), wrap.name);
    const singleQuoted = uri.replaceAll("'", "%27");
    for (const text of [`<img src='${singleQuoted}'>`, `url('${singleQuoted}')`])
      assert.ok(check(text).some((hit) => hit.includes("home path")));
    const unquotedCss = singleQuoted.replaceAll("(", "%28").replaceAll(")", "%29");
    assert.ok(check(`url(${unquotedCss})`).some((hit) => hit.includes("home path")));
  }
});

test("R2.3: punctuation does not turn generic home segments into personal names", () => {
  for (const suffix of [".", ",", ";", ":", "-", "_", ")", '"', "'"]) {
    for (const [prefix, name] of [["users", "me"], ["Users", "Shared"], ["home", "settings"], ["users", "123"], ["home", "<person>"]])
      assert.deepEqual(check(`see ${["", prefix, name].join("/")}${suffix}`), []);
    assert.ok(check(`open ${["", "home", "fixture-person"].join("/")}${suffix}`).some((hit) => hit.includes("home path")));
  }
});

test("R2.5: terminal host dots are accepted without matching filename extensions", () => {
  const name = ["fixture-host", "local"].join(".");
  for (const suffix of [".", ". ", "./", ".:443", '."', ".)", ".\n"])
    assert.ok(check(`https://${name}${suffix}`).some((hit) => hit.includes("LAN host name")));
  assert.ok(check(`The host is ${name}.`).some((hit) => hit.includes("LAN host name")));
  assert.deepEqual(check(`${name}.json`), []);
});

test("R2.6: serialized bearer headers recognize quoted keys and values", () => {
  const token = ["qT7vM2nX9cR4", "hL8sD3wK6pF1", "aZ5uB0eG_jY-"].join("");
  for (const text of [JSON.stringify({Authorization: `Bearer ${token}`}), `Authorization: 'Bearer ${token}'`, `"authorization": "bearer ${token}"`, `'AUTHORIZATION': 'BEARER ${token}'`])
    assert.ok(check(text).some((hit) => hit.includes("secret shape")));
});

test("R2.6: sequential and repeated single-class bearer placeholders remain public", () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  for (const token of [alphabet, alphabet.toUpperCase(), alphabet.repeat(2), "qtmnzkrwfvxbsjdhpylcgaoeui".repeat(2), [...alphabet].reverse().join(""), "x".repeat(40), "1234567890".repeat(4), "<token>", "$VAR", "${VAR}", "…", "xxx", "REDACTED", "Ab01".repeat(12)])
    for (const text of [`Authorization: Bearer ${token}`, `"Authorization": "Bearer ${token}"`])
      assert.deepEqual(check(text), []);
  const letters = "qtmnzkrwfvxbsjdhpylcgaoeui";
  assert.ok(check(`Authorization: Bearer ${letters}`).some((hit) => hit.includes("secret shape")));
});

test("R2.7: LAN rules require host context or a distinctive host label", () => {
  for (const value of [["options", "local"].join("."), ["context", "internal"].join("."), ["process", "env", "local"].join("."), ["word", "local"].join("."), ["this", "local"].join("."), ".env.local", "settings.local.json", "vitest.config.local.ts"])
    assert.deepEqual(check(value), []);
  const name = ["fixture", "local"].join(".");
  for (const value of [`https://${name}/`, `ssh://${name}`, `user@${name}`, `${name}:3636`, `Host: ${name}`, `HostName${" ".repeat(128)}${name}`, `"${name}"`, `'${name}'`, ...["Host", "HostName", "ssh", "ping", "curl"].map((word) => `${word} ${name}`), ["fixture-host", "local"].join("."), ["nas2", "lan"].join(".")])
    assert.ok(check(value).some((hit) => hit.includes("LAN host name")), value.split(":")[0]);
  for (const value of [`"${name} is a property"`, `ghost ${name}`, `scheme://${["example", "local"].join(".")}/`])
    assert.deepEqual(check(value), []);
});

test("R2.8: URL image decoding does not allocate a buffer per escape", (t) => {
  const from = t.mock.method(Buffer, "from");
  const scan = (count: number) => {
    const before = from.mock.callCount();
    assert.deepEqual(check(`data:image/svg+xml,${"a%20".repeat(count)}`), []);
    return from.mock.callCount() - before;
  };
  const small = scan(16);
  const large = scan(4096);
  assert.ok(large <= small + 2);
});

test("R2.2: ambiguous data URIs end at CRLF without swallowing the carriage return", () => {
  const uri = `data:image/png;base64,${png().toString("base64")}`;
  assert.deepEqual(check(`image: ${uri}\r\npublic`), []);
});

test("R2.8/R8.4: URL decoding preserves UTF-8, binary bytes and literal malformed escapes", () => {
  const terms: PrivateTerms = {terms:[{value:"café",line:1}],allowed:[],notes:[]};
  for (const payload of ["caf%C3%A9", "café", "%ff%00"]) {
    const hits = checkText(`data:image/svg+xml,${payload}`, "fixture", terms);
    assert.ok(hits.length > 0);
    if (payload === "%ff%00") assert.ok(hits.some((hit) => hit.includes("binary file of unknown type")));
    else assert.ok(hits.some((hit) => hit.includes("private term")));
  }
  for (const payload of ["caf% c3", "%", "%0", "%g0", "%0g"])
    assert.deepEqual(check(`data:image/svg+xml,${payload}`), []);
});

test("R3.2: MIME parameters cannot hide inline PNG or blocked image bytes", () => {
  const prefix = ["data:", "image/"].join("");
  const bytes = png(pngChunk("tEXt", Buffer.from(`Comment\0${home("fixture-person")}`)));
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 0]), Buffer.alloc(14)]).toString("base64");
  for (const parameters of [";name=fixture_image.png", ";name=fixture%5Fimage.png", ';name="fixture image.png"', ';name="fixture, image.png"', ';name="fixture; image.png"']) {
    assert.ok(check(`<img src='${prefix.toUpperCase()}PNG${parameters};base64,${bytes.toString("base64")}'>`).some((hit) => hit.includes("home path")));
    assert.ok(check(`<img src='${prefix}jpeg${parameters};base64,${jpeg}'>`).length > 0);
  }
  for (const parameters of [";name", ";name=%GG", ";name=", ';name="unterminated', ";base64;name=fixture", ";name=fixture image", ";;base64"])
    assert.ok(check(`${prefix}png${parameters},AAAA`).some((hit) => hit.includes("invalid")), parameters);
});

test("R3.4: srcset descriptors and Markdown titles are outside image payloads", () => {
  const blocked = `data:image/png;base64,${png(pngChunk("tEXt", Buffer.from(`Comment\0${home("fixture-person")}`))).toString("base64")}`;
  for (const wrap of [
    (uri: string) => `<img srcset="${uri} 1x">`,
    (uri: string) => `<img srcset="${uri} 320w, ${uri} 640w">`,
    (uri: string) => `<img srcset="${uri}, ${uri} 2x">`,
    (uri: string) => `![icon](${uri} "Icon")`,
    (uri: string) => `![icon](${uri} 'Icon')`,
  ]) {
    assert.deepEqual(check(wrap(`data:image/png;base64,${png().toString("base64")}`)), []);
    assert.ok(check(wrap(blocked)).some((hit) => hit.includes("home path")));
  }
  const clean = `data:image/png;base64,${png().toString("base64")}`;
  assert.ok(check(`<img srcset="${clean} 1x, ${blocked} 2x">`).some((hit) => hit.includes("home path")));
});

test("R3.5: mixed-form IPv6 candidates include dotted IPv4 tails", () => {
  for (const prefix of [["fd12", "3456", "789a", "1", "2", "3"], ["fe80", "0", "0", "0", "0", "0"]])
    assert.ok(check(`${prefix.join(":")}:192.0.2.1`).some((hit) => hit.includes("IPv6")));
  assert.deepEqual(check("2001:db8::192.0.2.1"), []);
});

function fontWithMetadata(kind: "woff" | "woff2", metadata: Buffer): Buffer {
  const font = fontFixture(kind, Buffer.from("public table ".repeat(20)));
  const compressed = kind === "woff" ? deflateSync(metadata) : brotliCompressSync(metadata);
  const offset = Math.ceil(font.length / 4) * 4;
  const bytes = Buffer.concat([font, Buffer.alloc(offset - font.length), compressed]);
  const field = kind === "woff" ? 24 : 28;
  bytes.writeUInt32BE(bytes.length, 8);
  bytes.writeUInt32BE(offset, field);
  bytes.writeUInt32BE(compressed.length, field + 4);
  bytes.writeUInt32BE(metadata.length, field + 8);
  return bytes;
}

test("R3.6: WOFF and WOFF2 compressed metadata is scanned and validated", () => {
  for (const kind of ["woff", "woff2"] as const) {
    const field = kind === "woff" ? 24 : 28;
    const bytes = fontWithMetadata(kind, Buffer.from(`<metadata>${secret}</metadata>`));
    assert.ok(checkBuffer(bytes, `fixture.${kind}`, empty, false).some((hit) => hit.includes("secret shape")));
    const clean = fontWithMetadata(kind, Buffer.from("<metadata>public</metadata>"));
    assert.deepEqual(checkBuffer(clean, `fixture.${kind}`, empty, false), []);
    for (const corrupt of [
      (copy: Buffer) => copy.fill(255, copy.readUInt32BE(field)),
      (copy: Buffer) => copy.writeUInt32BE(copy.length + 1, field),
      (copy: Buffer) => copy.writeUInt32BE(0, field),
      (copy: Buffer) => copy.writeUInt32BE(1, field),
      (copy: Buffer) => copy.writeUInt32BE(copy.length, field + 4),
      (copy: Buffer) => copy.writeUInt32BE(1, field + 8),
      (copy: Buffer) => copy.writeUInt32BE(50 * 1024 * 1024, field + 8),
    ]) {
      const copy = Buffer.from(clean);
      corrupt(copy);
      assert.ok(checkBuffer(copy, `fixture.${kind}`, empty, false).some((hit) => /invalid compressed font|budget/.test(hit)));
    }
  }
});

test("R3.7: bearer headers accept literal digits and quotes around either value or token", () => {
  const token = ["qT7vM2nX9cR4", "hL8sD3wK6pF1", "aZ5uB0eG_jY-"].join("");
  for (const value of ["48291037560928471635082749", "`Bearer " + token + "`", `bearer "${token}"`, `bearer '${token}'`, "bearer `" + token + "`"])
    assert.ok(check(`Authorization: ${/^\d/.test(value) ? "Bearer " : ""}${value}`).some((hit) => hit.includes("secret shape")));
  for (const value of ["48291037564829103756", "1234567890".repeat(3), "4829103756".repeat(3), "1".repeat(30), "1231234123123412312341231234"])
    assert.deepEqual(check(`Authorization: Bearer ${value}`), []);
});

test("R4.2: private IPv6 addresses survive trailing punctuation and ports", () => {
  const prefix = ["fd7a", "115c", "a1e0"].join(":") + ":";
  for (const value of [prefix, `${prefix}not-an-address`, `${prefix}:53: reachable`, `${prefix}:53:41641`, `${prefix}ab12:4843:cd96:6258:b240:`])
    assert.ok(check(value).some((hit) => hit.includes("IPv6")));
});

function nestedPng(): Buffer {
  const wrap = (text: string) => png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(text)])));
  const uri = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
  const leaf = wrap("a".repeat(1024 * 1024));
  const middle = wrap((`<img src="${uri(leaf)}">\n`).repeat(8));
  return wrap((`<img src="${uri(middle)}">\n`).repeat(20));
}

test("R4.3: nested PNGs and expanded font table and metadata views share a bounded budget", () => {
  assert.ok(checkBuffer(nestedPng(), "nested.png", empty, false).some((hit) => /budget|limit|oversized/.test(hit)));
  const body = Buffer.alloc(16 * 1024 * 1024, 97);
  const terms: PrivateTerms = {terms:[{value:"fixturephrase",line:1}],allowed:[],notes:[]};
  for (const font of [fontFixture("woff2", body), fontWithMetadata("woff2", body)])
    assert.ok(checkBuffer(font, "fixture.woff2", terms, false).some((hit) => /budget|limit|oversized/.test(hit)));
});

test("R4.3: inline nesting stops at depth two and long candidate lists remain public", () => {
  let value = "public";
  const prefix = ["data:", "image/svg+xml;base64,"].join("");
  for (let depth = 0; depth < 3; depth++) value = `<img src="${prefix}${Buffer.from(value).toString("base64")}">`;
  assert.ok(check(value).some((hit) => /depth|oversized|limit/.test(hit)));
  const uri = ["data:", "image/png;base64,AAAA"].join("");
  assert.deepEqual(check((`![](${uri})\n`).repeat(32768)), []);
  assert.deepEqual(check(`<img srcset="${(`${uri} 1x, `).repeat(32768)}">`), []);
});

test("R4.4: a one-MiB JWT-like run is not a credential", () => {
  assert.deepEqual(check("-eyJ".repeat(262144)), []);
});

test("R4.5: decoded SVG allow markers cannot exempt file or text payloads", () => {
  const svg = `${home("fixture-person")} <!-- ${allowMarker} -->`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  assert.ok(checkBuffer(Buffer.from(uri), "fixture.html", empty, false).some((hit) => hit.includes("home path")));
  assert.ok(check(uri).some((hit) => hit.includes("home path")));
});

test("R4.6: seeded random hex and lowercase bearer tokens are literal", () => {
  let state = 0x5eeda11;
  for (const alphabet of ["0123456789abcdef", "abcdefghijklmnopqrstuvwxyz"])
    for (const size of [24, 32, 40])
      for (let sample = 0; sample < 128; sample++) {
        let token = "";
        for (let at = 0; at < size; at++) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          token += alphabet[(state >>> 16) % alphabet.length];
        }
        assert.ok(check(`Authorization: Bearer ${token}`).some((hit) => hit.includes("secret shape")));
        assert.deepEqual(check(`Authorization: Bearer ${token.repeat(2)}${token.slice(0, 7)}`), []);
      }
  for (const token of ["placeholder".repeat(3), "your-token".repeat(3), "REDACTED".repeat(4), "Ab01".repeat(8), "abcdefghijklmnopqrstuvwxyz", "$VARIABLE_PLACEHOLDER_NAME", "${VARIABLE_PLACEHOLDER_NAME}"])
    assert.deepEqual(check(`Authorization: Bearer ${token}`), []);
});

test("R4.7: LAN suffixes and command, assignment and copy contexts identify hosts", () => {
  for (const text of [
    `I deployed to ${["builder", "lan"].join(".")} yesterday`, `open ${["printer", "home", "arpa"].join(".")}`,
    `REDIS_HOST=${["cache", "lan"].join(".")}`, `scp file ${["builder", "lan"].join(".")}:/tmp/x`,
    `rsync -a . ${["nas", "lan"].join(".")}:/srv`, `ssh -p 22 ${["nas", "lan"].join(".")}`,
    `emend serve --host=${["nas", "lan"].join(".")}`, `server: ${["nas", "lan"].join(".")}`,
    ...["ssh -p 22", "rsync -a", "scp", "mosh", "ProxyJump", "server:"].map((word) => `${word} ${["fixture", "internal"].join(".")}`),
    ...["local", "internal"].map((suffix) => `HOST=${["fixture", suffix].join(".")}`),
    ...[":/tmp/x", ":~"].map((after) => `${["fixture", "local"].join(".")}${after}`),
  ]) assert.ok(check(text).some((hit) => hit.includes("LAN host name")));
  for (const parts of [["options", "local"], ["context", "internal"]]) assert.deepEqual(check(parts.join(".")), []);
});

test("R4.8: only an entire interpolation placeholder skips decoding", () => {
  const prefix = ["data:", "image/svg+xml,"].join("");
  assert.deepEqual(check(`${prefix}\${image}`), []);
  assert.ok(check(`${prefix}\${image}${encodeURIComponent(home("fixture-person"))}`).some((hit) => hit.includes("home path")));
});

test("R4.9: JSON-escaped images, inline fonts and XML use the payload scanner", () => {
  const svg = Buffer.from(home("fixture-person")).toString("base64");
  assert.ok(check(JSON.stringify(`data:image/svg+xml;base64,${svg}`).replaceAll("/", "\\/")).some((hit) => hit.includes("home path")));
  for (const kind of ["woff", "woff2", "ttf", "otf"]) {
    const bytes = kind === "woff" || kind === "woff2" ? fontFixture(kind, Buffer.from(secret.repeat(4))) :
      Buffer.concat([Buffer.from(kind === "ttf" ? "true" : "OTTO"), Buffer.alloc(4), Buffer.from(secret)]);
    const prefix = ["data:", `font/${kind};base64,`].join("");
    assert.ok(check(prefix + bytes.toString("base64")).some((hit) => hit.includes("secret shape")));
  }
  assert.ok(check(["data:", "text/xml;base64,", svg].join("")).some((hit) => hit.includes("home path")));
});

test("R4.10: CSS utf8 SVG payloads accept clean raw and encoded XML", () => {
  const prefix = ["data:", "image/svg+xml;utf8,"].join("");
  for (const body of ["<svg>public</svg>", encodeURIComponent("<svg>public</svg>")]) assert.deepEqual(check(`url('${prefix}${body}')`), []);
  assert.ok(check(`url('${prefix}${encodeURIComponent(`<svg>${home("fixture-person")}</svg>`)}')`).some((hit) => hit.includes("home path")));
});

test("R4.12: binary secrets include UTF-16 font names in both byte orders and alignments", () => {
  for (const bigEndian of [false, true]) for (const offset of [0, 1]) {
    const body = Buffer.from(secret, "utf16le");
    if (bigEndian) body.swap16();
    const bytes = Buffer.concat([Buffer.from("true"), Buffer.alloc(4 + offset), body, Buffer.alloc(2)]);
    assert.ok(checkBuffer(bytes, "fixture.ttf", empty, false).some((hit) => hit.includes("secret shape")));
  }
});

test("R4.13: PNG raw EXIF profiles are blocked in either compressed text chunk", () => {
  for (const kind of ["zTXt", "iTXt"]) {
    const bytes = png(pngChunk(kind, Buffer.concat([
      Buffer.from("Raw profile type exif\0"), Buffer.from(kind === "zTXt" ? [0] : [1, 0, 0, 0]), deflateSync("\nexif\n4\n45786966\n"),
    ])));
    assert.ok(checkBuffer(bytes, "fixture.png", empty, false).some((hit) => hit.includes("binary metadata")));
  }
});

test("R4.14: encoded home paths and additional platform roots are checked", () => {
  const user = "fixture-person";
  for (const value of [`?path=${encodeURIComponent(home(user))}`, home(user).replaceAll("/", "&#47;"),
    ["", "usr", "home", user, "file"].join("/"), ["", "export", "home", user, "file"].join("/"),
    ["", "", "wsl.localhost", "FixtureOS", "home", user, "file"].join("\\")])
    assert.ok(check(value).some((hit) => hit.includes("home path")));
});

test("R5.4: option-heavy host contexts are tokenized without backtracking", () => {
  const target = ["fixture", "local"].join(".");
  for (const count of [40, 10000]) {
    assert.deepEqual(check(`ssh ${"-a ".repeat(count)}! ${target}`), []);
    assert.ok(check(`ssh ${"-a ".repeat(count)}${target}`).some((hit) => hit.includes("LAN host")));
  }
});

test("R5.5: JWT claims and signatures beyond the old cap retain complete spans", () => {
  for (const size of [4000, 8192, 65536]) {
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    const claim = Buffer.from(JSON.stringify({ sub: "a".repeat(size) })).toString("base64url");
    const token = `${header}.${claim}.${"Ab01".repeat(size)}`;
    assert.ok(check(token).some((hit) => hit.includes("secret shape")));
    assert.ok(checkTextSpans(`prefix${token}`, empty, true).some((hit) => hit.start === 6 && hit.end === token.length + 6));
  }
});

test("R5.6: HTML, CSS and JSON escapes reveal inline URI syntax and MIME aliases", () => {
  const svg = `<svg><text>${home("fixture-person")}</text></svg>`;
  const payload = Buffer.from(svg).toString("base64");
  const uri = `data:image/svg+xml;base64,${payload}`;
  for (const encoded of [
    uri.replace("/", "&#47;"), uri.replace("/", "&sol;"), uri.replace("data", "d\\61ta"),
    uri.replace("data", "\\64 ata"), uri.replace("data", "\\u0064ata"), uri.replace("/", "\\/"),
    uri.replace(":", "&#x3a;"),
  ]) for (const wrapper of [(text: string) => `<img src="${text}">`, (text: string) => `url("${text}")`])
    assert.ok(check(wrapper(encoded)).some((hit) => hit.includes("home path")), encoded.slice(0, 30));
  for (const mime of ["image/svg", "application/xml"]) {
    assert.ok(check(`data:${mime};base64,${payload}`).some((hit) => hit.includes("home path")));
  }
  for (const mime of ["application/font-woff", "application/x-font-woff", "font/sfnt"]) {
    const bytes = mime === "font/sfnt" ? Buffer.concat([Buffer.from("true\0"), Buffer.from(secret)]) : fontFixture("woff", Buffer.from(secret.repeat(4)));
    assert.ok(check(`data:${mime};base64,${bytes.toString("base64")}`).some((hit) => hit.includes("secret shape")));
  }
  assert.throws(() => checkText(uri.replace("/", "&#47;"), "fixture", empty, { budget: new ScanBudget(8) }), /budget/);
});

function fontNameTable(value: string, platform: number): Buffer {
  const bytes = platform === 1 ? Buffer.from(value, "latin1") : Buffer.from(value, "utf16le").swap16();
  const header = Buffer.alloc(18);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(18, 4);
  header.writeUInt16BE(platform, 6);
  header.writeUInt16BE(platform === 3 ? 1 : 0, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt16BE(bytes.length, 14);
  return Buffer.concat([header, bytes]);
}

test("R5.7: WOFF name records receive generic checks in files and inline payloads", () => {
  for (const kind of ["woff", "woff2"] as const) for (const platform of [0, 1, 3]) {
    for (const value of [home("fixture-person"), blockedMail, "Public Fixture Font"]) {
      const bytes = fontFixture(kind, fontNameTable(value, platform), "name");
      const file = checkBuffer(bytes, `fixture.${kind}`, empty, false);
      const inline = check(`data:font/${kind};base64,${bytes.toString("base64")}`);
      if (value === "Public Fixture Font") { assert.deepEqual(file, []); assert.deepEqual(inline, []); }
      else for (const hits of [file, inline]) assert.ok(hits.some((hit) => /home path|email address/.test(hit)), `${kind} platform ${platform}: ${hits.join(", ")}`);
    }
    const invalid = fontNameTable("Public Fixture Font", platform);
    invalid.writeUInt16BE(65535, 16);
    assert.ok(checkBuffer(fontFixture(kind, invalid, "name"), `fixture.${kind}`, empty, false).some((hit) => hit.includes("invalid")));
  }
});

test("R5.8: POSIX home roots are case-sensitive while Windows roots are not", () => {
  assert.deepEqual(check('router.get("/users/profile", handler)'), []);
  assert.ok(check(home("fixture-person", true)).some((hit) => hit.includes("home path")));
  assert.deepEqual(check(home("fixture-person").replace("home", "HOME")), []);
  for (const root of ["users", "USERS"]) {
    const value = ["C:", root, "fixture-person", "x"].join("\\");
    assert.ok(check(value).some((hit) => hit.includes("home path")));
  }
  // Accepted false positive: the LAN suffix identifies a host in every context.
  assert.ok(check(["config", "lan"].join(".")).some((hit) => hit.includes("LAN host")));
});

test("R5.9: normalization charges expanded bytes and propagates exhaustion", () => {
  const terms: PrivateTerms = { terms: [{ value: "absent", line: 1 }], allowed: [], notes: [] };
  const expanding = "\ufdfa".repeat(64);
  assert.throws(() => checkText(expanding, "fixture", terms, { budget: new ScanBudget(512) }), /budget/);
  assert.deepEqual(checkTextSpans(expanding, terms, false, new ScanBudget(512)), [
    { start: 0, end: expanding.length, label: "scan expansion budget exceeded" },
  ]);
  assert.deepEqual(checkText("\ufdfa".repeat(4), "fixture", terms, { budget: new ScanBudget(512) }), []);
});

test("R5.10: the gate pins lazy-fetch protection on its own Git reads", (t) => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "public.txt"), "public");
  commit(cwd, "public fixture");
  const execute = childProcess.spawnSync;
  const commands = new Set<string>();
  const child = t.mock.method(childProcess, "spawnSync", (cmd: string, args: string[], options: SpawnSyncOptions) => {
    if (cmd === "git") for (const command of ["rev-list", "show", "cat-file"]) if (args.includes(command)) {
      assert.equal(options.env?.GIT_NO_LAZY_FETCH, "1", command);
      commands.add(command);
    }
    return execute(cmd, args, options);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(checkPublic({ cwd, root: cwd, commits: "main..HEAD" }).hits, []);
    assert.deepEqual(commands, new Set(["rev-list", "show", "cat-file"]));
  } finally { child.mock.restore(); syncBuiltinESMExports(); }
});

test("R5.12: valid font inflation is bounded and oversized actual output is refused", (t) => {
  const inflate = t.mock.method(zlib, "inflateSync");
  const brotli = t.mock.method(zlib, "brotliDecompressSync");
  syncBuiltinESMExports();
  try {
    for (const kind of ["woff", "woff2"] as const) {
      const body = Buffer.from("public fixture ".repeat(10));
      const bytes = fontFixture(kind, body);
      const spy = kind === "woff" ? inflate : brotli;
      assert.deepEqual(checkBuffer(bytes, `fixture.${kind}`, empty, false), []);
      assert.equal(spy.mock.callCount(), 1);
      assert.equal(spy.mock.calls[0]?.arguments[1]?.maxOutputLength, body.length);
      // The stream expands beyond its declared table length, even though that declaration is in budget.
      if (kind === "woff") bytes.writeUInt32BE(100, 56);
      else { bytes[49] = 0x81; bytes[50] = 1; }
      assert.ok(checkBuffer(bytes, `fixture.${kind}`, empty, false).some((hit) => hit.includes("invalid")));
      assert.equal(spy.mock.callCount(), 2);
      assert.equal(spy.mock.calls[1]?.arguments[1]?.maxOutputLength, kind === "woff" ? 100 : 129);
    }
  } finally { inflate.mock.restore(); brotli.mock.restore(); syncBuiltinESMExports(); }
});

test("R6.5: repeated host options tokenize once within a single scan budget", () => {
  const unit = `-J ${["fixture", "local"].join(".")} `;
  for (const count of [4000, 40000]) {
    const text = `ssh ${unit.repeat(count)}`;
    // One normalization pass (OP3) plus one command-tokenization pass.
    const hits = checkText(text, "fixture", empty, { budget: new ScanBudget(2 * Buffer.byteLength(text)) });
    assert.equal(hits.length, count);
    assert.ok(hits.every((hit) => hit.endsWith("LAN host name")));
  }
  assert.throws(() => checkText(`ssh ${unit.repeat(10)}`, "fixture", empty, { budget: new ScanBudget(8) }), /budget/);
  const target = ["fixture", "local"].join(".");
  for (const prefix of ["Host:", "Host :", "Host : ", "Host: "])
    assert.ok(check(prefix + target).some((hit) => hit.includes("LAN host")));
  assert.deepEqual(check(`ssh -J fixture\n${target}`), []);
});

test("R6.6: every data URI payload receives generic checks regardless of MIME type", () => {
  const value = home("fixture-person");
  for (const mime of ["text/plain", "application/json", "application/octet-stream", "custom/fixture", "custom/fixture~type", ""]) {
    for (const [parameter, payload] of [[";base64", Buffer.from(value).toString("base64")], ["", encodeURIComponent(value)]]) {
      const uri = `data:${mime}${parameter},${payload}`;
      for (const hits of [check(`<a href="${uri}">public</a>`), checkBuffer(Buffer.from(uri), "fixture.txt", empty, false)])
        assert.ok(hits.some((hit) => hit.includes("home path")));
    }
  }
  const bytes = Buffer.from(`public\0${value}`);
  assert.ok(check(`data:application/octet-stream;base64,${bytes.toString("base64")}`).some((hit) => hit.includes("binary file of unknown type")));
  assert.deepEqual(check('data:text/plain,public%20fixture'), []);
});

function sfntFixture(kind: "ttf" | "otf", table: Buffer): Buffer {
  const header = Buffer.alloc(28);
  if (kind === "otf") header.write("OTTO");
  else header.writeUInt32BE(0x00010000);
  header.writeUInt16BE(1, 4);
  header.write("name", 12);
  header.writeUInt32BE(header.length, 20);
  header.writeUInt32BE(table.length, 24);
  return Buffer.concat([header, table]);
}

test("R6.7: SFNT name records are checked in TTF, OTF and inline fonts", () => {
  for (const kind of ["ttf", "otf"] as const) for (const platform of [0, 1, 3]) {
    for (const value of [home("fixture-person"), "Public Fixture Font"]) {
      const font = sfntFixture(kind, fontNameTable(value, platform));
      const outputs = [checkBuffer(font, `fixture.${kind}`, empty, false), check(`data:font/sfnt;base64,${font.toString("base64")}`)];
      for (const hits of outputs) {
        if (value === "Public Fixture Font") assert.deepEqual(hits, []);
        else assert.ok(hits.some((hit) => hit.includes("home path")));
      }
      font.writeUInt32BE(font.length + 1, 20);
      assert.ok(checkBuffer(font, `fixture.${kind}`, empty, false).some((hit) => hit.includes("invalid SFNT")));
    }
  }
});

test("R6.8: decoded escape views receive generic rules with mapped source spans", () => {
  const value = home("fixture-person");
  const json = `{"path":"${value.replaceAll("/", "\\/")}"}`;
  const spans = checkTextSpans(json, empty).filter((hit) => hit.label === "real home path");
  assert.deepEqual(spans, [{ start: json.indexOf("\\/"), end: json.indexOf("\\/file"), label: "real home path" }]);
  assert.ok(check(json).some((hit) => hit.includes("home path")));
  const mail = blockedMail.replace("@", "&#64;");
  assert.ok(check(mail).some((hit) => hit.includes("email address")));
  const token = ["\\u0067", "hp_", "Ab01".repeat(9)].join("");
  assert.ok(check(token).some((hit) => hit.includes("secret shape")));
});

test("R6.8: decoded generic rules preserve source exemptions only for exemptible shapes", () => {
  const header = ["-----BEGIN ", "PRIVATE KEY-----"].join("").replaceAll("-", String.raw`\u002d`);
  const scan = (text: string) => checkText(text, "fixture.ts", empty, { lineExemptions: true });
  assert.deepEqual(scan(`${header} // ${allowMarker}`), []);
  assert.ok(scan(`${header}\\n${"Ab01".repeat(16)} // ${allowMarker}`).some((hit) => hit.includes("secret shape")));
  const encoded = home("fixture-person").replaceAll("/", "\\/");
  assert.deepEqual(scan(`${encoded} // ${allowMarker}`), []);
  assert.ok(scan(`${encoded} // ${allowMarker.replace("a", "&#97;")}`).some((hit) => hit.includes("home path")));
  const token = ["\\u0067", "hp_", "Ab01".repeat(9)].join("");
  assert.ok(scan(`${token} // ${allowMarker}`).some((hit) => hit.includes("secret shape")));
});

test("R6.9: empty URI regex sources and empty payloads are not invalid assets", () => {
  assert.deepEqual(check(String.raw`const re = /data:image\/png;base64,/;`), []);
  for (const value of ['<img src="data:image/png;base64,">', 'data:text/plain,', 'data:;base64,']) assert.deepEqual(check(value), []);
  assert.deepEqual(check(String.raw`const value = "\u0070ublic";`), []);
  assert.deepEqual(check(["data:", "text/plain;base64,?"].join("")), []);
});

test("R6.10: WSL mount and macOS volume home roots ignore case", () => {
  for (const root of [["", "mnt", "c", "users"], ["", "MNT", "C", "USERS"], ["", "system", "volumes", "data", "users"]]) {
    assert.ok(check([...root, "fixture-person", "x"].join("/")).some((hit) => hit.includes("home path")));
  }
});

test("R6.11: normalization charges the ASCII tail after the last non-ASCII character", () => {
  const terms: PrivateTerms = { terms: [{ value: "q", line: 1 }], allowed: [], notes: [] };
  for (const prefix of ["", "é"]) {
    assert.throws(() => checkText(prefix + "x".repeat(512), "fixture", terms, { generic: false, budget: new ScanBudget(8) }), /budget/);
    assert.deepEqual(checkText(prefix + "x".repeat(6), "fixture", terms, { generic: false, budget: new ScanBudget(8) }), []);
  }
});

test("R7.3: decoded scans retain private terms, source spans and configured allowed phrases", () => {
  const cwd = directory();
  writeFileSync(path.join(cwd, ".private-terms"), "fixture café\n");
  const terms = loadPrivateTerms(cwd, {}, { root: cwd });
  for (const value of ['{"name":"fixture café"}', String.raw`{"name":"fixture caf\u00e9"}`, "fixture caf&#233;"]) {
    writeFileSync(path.join(cwd, "fixture.txt"), value);
    assert.ok(checkPublic({ cwd, root: cwd, files: ["fixture.txt"] }).hits.some((hit) => hit.includes("private term")));
    const spans = checkTextSpans(value, terms);
    assert.deepEqual(spans, [{ start: value.indexOf("fixture"), end: value.endsWith('"}') ? value.length - 2 : value.length, label: "private term (file line 1)" }]);
  }
  assert.ok(checkText(`fixture caf&#233; // ${allowMarker}`, "fixture", terms, { lineExemptions: true }).some((hit) => hit.includes("private term")));
  assert.deepEqual(checkText("fixture caf&#233; public", "fixture", { ...terms, allowed: ["fixture café public"] }), []);
});

test("R7.4: inline font and image signatures select checks regardless of MIME type", () => {
  const value = home("fixture-person");
  const named = fontNameTable(value, 3);
  const assets = [
    sfntFixture("ttf", named), sfntFixture("otf", named),
    fontFixture("woff", named, "name"), fontFixture("woff2", named, "name"),
    png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(value)]))),
    Buffer.from(`<svg><text>${value}</text></svg>`),
  ];
  for (const mime of ["font/ttf", "application/x-font-ttf", "application/x-font-truetype", "application/octet-stream", "text/plain", "image/png", ""]) {
    for (const bytes of assets)
      assert.ok(check(`data:${mime};base64,${bytes.toString("base64")}`).some((hit) => hit.includes("home path")), mime);
    for (const bytes of [Buffer.from([255, 216, 255, 0]), Buffer.from("GIF89a\0"), Buffer.from("RIFFxxxxWEBP\0")])
      assert.ok(check(`data:${mime};base64,${Buffer.concat([bytes, Buffer.alloc(16)]).toString("base64")}`)
        .some((hit) => hit.includes("binary file of unknown type")), mime);
  }
  const encoded = [...sfntFixture("ttf", named)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  assert.ok(check(`data:application/octet-stream,${encoded}`).some((hit) => hit.includes("home path")));
  assert.deepEqual(check(`data:application/octet-stream;base64,${sfntFixture("otf", fontNameTable("Public Fixture Font", 3)).toString("base64")}`), []);
});

test("R7.5: separate, attached, quoted and equals-form option arguments preserve host context", () => {
  const target = ["fixture", "local"].join(".");
  for (const command of [
    "ssh -o StrictHostKeyChecking=no", "ssh -oStrictHostKeyChecking=no", 'ssh -o "StrictHostKeyChecking=no"',
    'curl -H "Accept: application/json"', "curl -H 'Accept: application/json'", 'curl -H"Accept: application/json"',
    'curl --header="Accept: application/json"', 'curl --header "Accept: application/json"',
    'curl -H "Accept: application/json" --compressed', "ssh -p2222", "ssh --",
  ]) {
    const text = `${command} ${target}`;
    assert.ok(check(text).some((hit) => hit.includes("LAN host")), command);
    assert.ok(check(JSON.stringify(text)).some((hit) => hit.includes("LAN host")), command);
  }
  assert.deepEqual(check(`curl -H "Accept: application/json"\n${target}`), []);
});

function repeatedSfnt(entries: number, records: number): Buffer {
  const header = Buffer.alloc(12 + entries * 16);
  header.writeUInt32BE(0x00010000);
  header.writeUInt16BE(entries, 4);
  const table = Buffer.alloc(6 + records * 12);
  table.writeUInt16BE(records, 2);
  table.writeUInt16BE(table.length, 4);
  for (let at = 12; at < header.length; at += 16) {
    header.write("name", at);
    header.writeUInt32BE(header.length, at + 8);
    header.writeUInt32BE(table.length, at + 12);
  }
  return Buffer.concat([header, table]);
}

function sfntBudget(bytes: Buffer, parserBytes: number): ScanBudget {
  // These fixtures contain no bulk: measure the strict whole view without parser visits.
  // A valid one-table directory costs one walk entry; duplicate tags stop at the second.
  const preflight = new ScanBudget(), initial = preflight.remaining;
  checkBuffer(bytes, "fixture.bin", empty, false, false, 0, preflight);
  const walk = 16 * Math.min(2, bytes.readUInt16BE(4));
  const budget = new ScanBudget(initial - preflight.remaining + walk + parserBytes);
  assert.ok(budget.remaining < 32 * bytes.length, "whole-asset views must skip in the parser check");
  return budget;
}

test("R7.6: duplicate SFNT tags and overlapping ranges fail before visiting name records", () => {
  for (const count of [400, 4000]) {
    const bytes = repeatedSfnt(count, count);
    assert.ok(checkBuffer(bytes, "fixture.ttf", empty, false, false, 0, sfntBudget(bytes, 12 + count * 16))
      .some((hit) => hit.includes("invalid SFNT")));
  }
  const overlap = repeatedSfnt(2, 2);
  overlap.write("cmap", 28);
  assert.ok(checkBuffer(overlap, "fixture.ttf", empty, false).some((hit) => hit.includes("invalid SFNT")));
  const duplicate = repeatedSfnt(2, 0);
  const separated = Buffer.concat([duplicate, Buffer.alloc(6)]);
  separated.writeUInt32BE(duplicate.length, 36);
  assert.ok(checkBuffer(separated, "fixture.ttf", empty, false).some((hit) => hit.includes("invalid SFNT")));
  separated.write("cmap", 28);
  assert.deepEqual(checkBuffer(separated, "fixture.ttf", empty, false), []);
});

test("R7.6: empty font name records consume a fixed budget per visit", () => {
  const bytes = repeatedSfnt(1, 400);
  assert.throws(() => checkBuffer(bytes, "fixture.ttf", empty, false, false, 0, sfntBudget(bytes, 28 + 400 * 12 - 1)), /budget/);
  const budget = sfntBudget(bytes, 28 + 400 * 12);
  assert.deepEqual(checkBuffer(bytes, "fixture.ttf", empty, false, false, 0, budget), []);
  assert.equal(budget.remaining, 0);
});

test("R7.7/R8.4/R12.1/R13.1: long malformed base64 is refused while headers and valid bodies keep checks", (t) => {
  const from = t.mock.method(Buffer, "from");
  const allocate = t.mock.method(Buffer, "allocUnsafe");
  assert.deepEqual(check(String.raw`const re = /^data:text\/plain;base64,(.+)$/;`), []);
  for (const payload of ["A".repeat(17), `${"A".repeat(16)}===`])
    assert.ok(check(["data:", "text/plain;base64,", payload].join("")).some((hit) => hit.includes("invalid or oversized inline image")));
  // CX2: these two malformed bodies are under 24 characters and must decode for short secret shapes.
  assert.equal(from.mock.calls.filter((call) => call.arguments[1] === "base64").length, 2);
  assert.equal(allocate.mock.callCount(), 0);
  from.mock.restore();
  allocate.mock.restore();
  for (const payload of ["?", "A", "A=", "AA=", "AA===", "YWJj!", "YWJj\u00a0"])
    assert.deepEqual(check(["data:", "text/plain;base64,", payload].join("")), []);
  for (const payload of ["%", "%0", "%g0", "%0g", "public% c3"])
    assert.deepEqual(check(`data:text/plain,${payload}`), []);
  const value = home("fixture-person");
  const base64 = Buffer.from(value).toString("base64");
  for (const payload of [base64, base64.replaceAll("=", ""), base64.match(/.{1,4}/g)?.join(" \t\r\n\f") ?? ""])
    assert.ok(check(`<a href="data:text/plain;base64,${payload}">`).some((hit) => hit.includes("home path")));
  assert.ok(check(`data:text/plain,${encodeURIComponent(value)}`).some((hit) => hit.includes("home path")));
});

test("round 8.4: data bodies percent-decode valid escapes and retain literal percent signs before base64", () => {
  const terms: PrivateTerms = { terms: [{ value: "fixtureterm", line: 1 }], allowed: [], notes: [] };
  for (const payload of ["%3Csvg%3E%66ixtureterm%3C/svg%3E%", "<svg>%66ixtureterm 100%</svg>"])
    assert.ok(checkText(`<img src="data:image/svg+xml,${payload}">`, "fixture", terms).some((hit) => hit.includes("inline image") && hit.includes("private term")));
  const payload = Buffer.from(home("fixture-person").replace(/file$/, "work")).toString("base64").replaceAll("=", "%3D");
  assert.ok(payload.includes("%3D"));
  assert.ok(check(`data:text/plain;base64,${payload}`).some((hit) => hit.includes("home path")));
});

test("round 8.5: Markdown angle destinations lose their wrapper while quoted SVG keeps its brackets", () => {
  const payload = Buffer.from(home("fixture-person")).toString("base64");
  assert.ok(check(`[note](<data:text/plain;base64,${payload}>)`).some((hit) => hit.includes("home path")));
  const terms: PrivateTerms = { terms: [{ value: "fixtureterm", line: 1 }], allowed: [], notes: [] };
  assert.ok(checkText('<img src="data:image/svg+xml,<svg>fixtureterm</svg>">', "fixture", terms)
    .some((hit) => hit.includes("inline image") && hit.includes("private term")));
});

test("round 8.6: UTF-8 percent escapes participate in private-term matching with source spans", () => {
  const value = "https://example.com/fixture%20caf%C3%A9";
  const terms: PrivateTerms = { terms: [{ value: "fixture café", line: 1 }], allowed: [], notes: [] };
  assert.ok(checkBuffer(Buffer.from(value), "fixture.txt", terms, false).some((hit) => hit.includes("private term")));
  assert.deepEqual(checkTextSpans(value, terms), [{ start: value.indexOf("fixture"), end: value.length, label: "private term (file line 1)" }]);
});

test("round 8.7: decoded unknown binaries receive the same refusal as files", () => {
  const bytes = zlib.gzipSync(Buffer.from("public fixture"));
  const file = checkBuffer(bytes, "fixture.gz", empty, false);
  assert.ok(file.some((hit) => hit.includes("binary file of unknown type")));
  assert.ok(check(`data:application/gzip;base64,${bytes.toString("base64")}`).some((hit) => hit.includes("binary file of unknown type")));
});

test("round 8.8: RGBA pixel bytes are not scanned as text in inline PNGs", () => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 126, 104, 47, 255]), { level: 0 })), pngChunk("IEND", Buffer.alloc(0)),
  ]);
  assert.deepEqual(checkBuffer(bytes, "fixture.png", empty, false), []);
  assert.deepEqual(check(`data:image/png;base64,${bytes.toString("base64")}`), []);
});

test("round 8.8: Hanken Grotesk glyph data is not scanned as text in inline WOFF2", () => {
  const bytes = readFileSync(new URL("../apps/web/src/fonts/hanken-grotesk-latin-wght-normal.woff2", import.meta.url));
  assert.deepEqual(checkBuffer(bytes, "fixture.woff2", empty, false), []);
  assert.deepEqual(check(`data:font/woff2;base64,${bytes.toString("base64")}`), []);
});

test("round 8.9 / 10.6: URI extraction has bounded terminator work for 262144 empty bodies", (t) => {
  const unit = "data:text/plain,\n";
  assert.throws(() => checkText(unit.repeat(16), "fixture", empty, { budget: new ScanBudget(8) }), /budget/);
  const text = unit.repeat(262144);
  const budget = new ScanBudget();
  const limit = 4 * text.length;
  // Also count unindexed lookups, so restoring the old per-URI indexOf searches fails this test.
  const indexOf = String.prototype.indexOf;
  let unindexedWork = 0;
  const search = t.mock.method(String.prototype, "indexOf", function (this: string, needle: string, from = 0) {
    const found = indexOf.call(this, needle, from);
    if (this === text && /^[\r\n"'`)>]$/.test(needle)) {
      unindexedWork += Math.max(0, (found < 0 ? text.length : found + needle.length) - Math.max(0, from));
      // Stop a regressed search deterministically instead of performing quadratic work to completion.
      if (unindexedWork + budget.inlineTerminatorWork > limit) budget.spend(Infinity);
    }
    return found;
  });
  try {
    assert.deepEqual(checkText(text, "fixture", empty, { budget }), []);
    assert.ok(budget.inlineTerminatorWork >= text.length, "the full terminator scan must be counted");
    assert.ok(budget.inlineTerminatorWork + unindexedWork <= limit, "terminator work must stay linear");
  } finally { search.mock.restore(); }
});

test("round 10.4: data URL fragments are stripped before decoding and encoded hashes remain payload", () => {
  const svg = `<svg><text>${home("fixture-person")}</text></svg>`;
  const payload = Buffer.from(svg).toString("base64");
  assert.ok(check(`<img src="data:image/svg+xml;base64,${payload}#icon">`).some((hit) => hit.includes("home path")));
  assert.ok(check(`<img src="data:text/plain,%23${encodeURIComponent(home("fixture-person"))}">`)
    .some((hit) => hit.includes("inline image") && hit.includes("home path")));
  const terms: PrivateTerms = { terms: [{ value: "fixtureterm", line: 1 }], allowed: [], notes: [] };
  assert.ok(!checkText('<img src="data:text/plain,public#fixtureterm">', "fixture", terms)
    .some((hit) => hit.includes("inline image") && hit.includes("private term")));
});

test("round 10.5: Markdown reference destinations exclude angle wrappers and every title delimiter", () => {
  const uri = `data:text/plain;base64,${Buffer.from(home("fixture-person")).toString("base64")}`;
  for (const destination of [`<${uri}>`, uri]) for (const title of ["", ' "title"', " 'title'", " (title)"])
    assert.ok(check(`[note]: ${destination}${title}`).some((hit) => hit.includes("home path")), title);
});

test("round 12.1: base64 bodies end before prose and enclosing punctuation", () => {
  const terms: PrivateTerms = { terms: [{ value: "acmecorp", line: 1 }], allowed: [], notes: [] };
  for (const content of ["acmecorp", home("fixture-person")]) {
    const uri = `data:text/plain;base64,${Buffer.from(content).toString("base64")}`;
    for (const text of [
      `${uri} in the icon.`, `${uri}.`, `${uri}>`, `${uri}]`, `${uri},`, `${uri})`, `${uri}&`,
      `<p>${uri}</p>`, `[${uri}, x]`, `(see ${uri})`, `url=${uri}&next=1`, `<${uri}>`, `[note]:\n  <${uri}>`,
    ]) assert.ok(checkText(text, "fixture", terms).some((hit) => hit.includes("inline image") &&
      hit.includes(content === "acmecorp" ? "private term" : "home path")), text);
    assert.ok(checkText(`data:text/plain;base64,cHVibGlj ${uri}.`, "fixture", terms)
      .some((hit) => hit.includes(content === "acmecorp" ? "private term" : "home path")));
  }
  for (const payload of ["A".repeat(17), `${"A".repeat(16)}===`])
    assert.ok(check(`data:text/plain;base64,${payload}`).some((hit) => hit.includes("invalid or oversized inline image")));
});

for (const [kind, unit, count] of [
  ["malformed", "data:;;", 262144],
  ["valid", "data:text/plain;base64,cHVibGlj ", 65536],
  ["query", "url=data:text/plain;base64,cHVibGlj&", 32768],
  ["srcset", "data:text/plain;base64,cHVibGlj,", 32768],
  ["markdown", "[x](data:text/plain;base64,cHVibGlj,", 32768],
] as const) test(`round 12.2: single-line ${kind} URI searches have deterministic linear work`, (t) => {
  const text = kind === "srcset" ? `<img srcset="${unit.repeat(count)}">` : unit.repeat(count);
  const budget = new ScanBudget();
  const limit = 16 * text.length;
  let unindexedWork = 0;
  let visits = 0;
  Object.defineProperty(budget, "inlineTerminatorWork", {
    get: () => visits,
    set: (value: number) => {
      visits = value;
      if (visits + unindexedWork > limit) budget.spend(Infinity);
    },
  });
  const slice = String.prototype.slice;
  const lastIndexOf = String.prototype.lastIndexOf;
  const charge = (work: number) => {
    unindexedWork += work;
    if (unindexedWork + budget.inlineTerminatorWork > limit) budget.spend(Infinity);
  };
  const slices = t.mock.method(String.prototype, "slice", function (this: string, start?: number, end?: number) {
    const result = slice.call(this, start, end);
    if (this === text) charge(result.length);
    return result;
  });
  const searches = t.mock.method(String.prototype, "lastIndexOf", function (this: string, needle: string, from?: number) {
    const found = lastIndexOf.call(this, needle, from);
    if (/^[\n<>]$/.test(needle)) charge((from ?? this.length) - Math.max(0, found));
    return found;
  });
  const decodes = kind !== "malformed" ? t.mock.method(Buffer, "from") : undefined;
  try {
    assert.deepEqual(checkText(text, "fixture", empty, { budget }), []);
    assert.ok(budget.inlineTerminatorWork >= text.length);
    assert.ok(budget.inlineTerminatorWork + unindexedWork <= limit);
    if (decodes) {
      const calls = decodes.mock.calls.filter((call) => call.arguments[1] === "base64").length;
      assert.ok(calls >= 1 && calls <= count, "at most one decode per identical URI, allowing cached literals");
    }
  } finally { slices.mock.restore(); searches.mock.restore(); decodes?.mock.restore(); }
});

test("round 12.3: unknown MIME subtypes never appear in hit locations", () => {
  const subtype = ["Prod", "DB", "pw", "Hunter2"].join("-");
  const hits = check(`data:font/${subtype};base64,${Buffer.alloc(18).toString("base64")}`);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((hit) => !hit.toLowerCase().includes(subtype.toLowerCase()) && !hit.includes("hunter2")));
});

test("round 12.4: RFC bearer tokens include tildes before and after the minimum length", () => {
  for (const value of ["qT7v~M2nX9cR4hL8sD3wK6pF1", `${"a".repeat(24)}~qT7vM2nX9`])
    assert.ok(check(`Authorization: Bearer ${value}`).some((hit) => hit.includes("secret shape")));
});

test("round 12.5: a million placeholder words cannot overflow the regexp stack", () => {
  assert.ok(check(`Authorization: Bearer ${"token-".repeat(1000000)}`).some((hit) => hit.includes("secret shape")));
});

test("round 13.1: documented data URL headers and placeholders are quiet in Markdown", () => {
  const prefix = png().toString("base64").slice(0, 24);
  for (const value of [
    'Inline images use `data:image/png;base64,<bytes>` URLs.',
    '`data:<mime>;base64,<payload>`',
    "data:image/png;base64, as prefix",
    "- data:image/png;base64, followed by the encoded image",
    "a data:text/plain;base64,x",
    "data:image/png;base64,<BASE64>",
    '<img src="data:image/png;base64,{{ image }}">',
    '<img src="data:image/png;base64,%s">',
    "src=data:image/png;base64,<%= img %>",
    String.raw`assert.match(s, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)`,
    '"data:image/png;base64,iVBOR..."',
    '`data:image/png;base64,...`',
    `data:image/png;base64,${prefix}...`,
    `data:image/png;base64,${prefix}…`,
    'data:image/png;base64,${var}',
    'data:image/png;base64,{b64}',
    "'data:image/png;base64,' + x",
  ]) for (const text of [value, `\`${value}\``, `\`\`\`text\n${value}\n\`\`\``])
    assert.deepEqual(checkBuffer(Buffer.from(text), "f.md", empty, false), [], value);
  for (const body of ["A", "A=", "AA=", "AA===", "?"])
    assert.deepEqual(checkText(`data:image/png;base64,${body}`, "f.md", empty), []);
  for (const body of ["A".repeat(17), `${"A".repeat(16)}===`, `${"A".repeat(17)}!`])
    assert.ok(checkText(`data:image/png;base64,${body}`, "f.md", empty).some((hit) => hit.includes("invalid or oversized inline image")));
});

test("round 13.1: documented prefixes still expose decoded private terms, home paths and secrets", () => {
  const terms: PrivateTerms = { terms: [{ value: "acmecorp", line: 1 }], allowed: [], notes: [] };
  const key = ["AK", "IA", "A".repeat(16)].join("");
  for (const [value, label] of [[home("fixture-person"), "home path"], ["acmecorp", "private term"], [key, "secret shape"]]) {
    // A truncated text chunk retains content checks without exempting malformed image structure.
    const body = Buffer.concat([png().subarray(0, 33), pngChunk("tEXt", Buffer.from(`Comment\0 ${value}`)).subarray(0, -2)]).toString("base64");
    assert.ok(body.length < 128);
    for (const ending of ["...", "…"])
      for (const text of [`data:image/png;base64,${body}${ending}`, `<img src="data:image/png;base64,${body}${ending}">`]) {
        const hits = checkText(text, "f.md", terms);
        assert.ok(hits.some((hit) => hit.includes(label)), ending);
        assert.ok(hits.every((hit) => !hit.includes("invalid") && !hit.includes("unknown type")), ending);
      }
  }
});

const round14Binary = Buffer.from(Array.from({ length: 48 }, (_, index) => index % 16));
const round14Body = round14Binary.toString("base64");
const round14PngBody = Buffer.concat([png().subarray(0, 8), round14Binary]).toString("base64");

for (const [name, ending] of [
  ["newline", "\nnext"], ["space", " next"], ["angle", "<bytes>"], ["brace", "{rest}"],
  ["interpolation", "$rest"], ["format", "%s"], ["bracket", "[rest]"],
]) test(`round 14.1: a complete binary before ${name} is refused`, () => {
  assert.ok(checkText(`see data:application/octet-stream;base64,${round14Body}${ending}`, "f.md", empty)
    .some((hit) => hit.includes("binary file of unknown type")));
});

test("round 14.1: a malformed PNG before prose is refused while a short header stays quiet", () => {
  assert.deepEqual(checkText("data:image/png;base64,iVBOR here", "f.md", empty), []);
  assert.ok(checkText(`x data:image/png;base64,${round14PngBody} y`, "f.md", empty)
    .some((hit) => hit.includes("invalid PNG")));
});

for (const [name, body, refusal] of [
  ["PNG", round14PngBody, "invalid PNG"], ["unknown binary", round14Body, "binary file of unknown type"],
]) test(`round 14.1: wrapping a complete ${name} does not suppress its refusal`, () => {
  for (const whitespace of ["\n ", "%0A%20"]) {
    const wrapped = body.slice(0, 40) + whitespace + body.slice(40);
    assert.ok(checkText(`<img src="data:image/png;base64,${wrapped}">`, "f.md", empty)
      .some((hit) => hit.includes(refusal)), whitespace);
  }
});

for (const ellipsis of ["...", "…"]) test(`round 14.1 / 15.7: ${ellipsis} never exempts unknown binaries of 16 or more data characters`, () => {
  for (const length of [63, 64, 128]) {
    const body = round14Body.repeat(2).slice(0, length);
    for (const payload of [body, body.replace(/./g, (character) => `%${character.charCodeAt(0).toString(16)}`),
      body.slice(0, 40) + "\n " + body.slice(40)]) {
      const hits = checkText(`<img src="data:application/octet-stream;base64,${payload}${ellipsis}">`, "f.md", empty);
      assert.ok(hits.some((hit) => hit.includes("binary file of unknown type")));
    }
  }
  assert.ok(checkText(`x data:application/octet-stream;base64,${round14Body}${round14Body}${ellipsis} y`, "f.md", empty)
    .some((hit) => hit.includes("binary file of unknown type")));
});

test("round 14.1: the short-body cutoff counts normalized data characters", () => {
  for (const length of [15, 16, 17]) {
    const body = "A".repeat(length);
    for (const payload of [body, "%41".repeat(length), body.slice(0, 8) + "\n " + body.slice(8)]) {
      const hits = checkText(`<img src="data:application/octet-stream;base64,${payload}">`, "f.md", empty);
      // OP1: a split 17-character body retains its strict 16-character prefix.
      if (length < 16) assert.deepEqual(hits, []);
      else assert.ok(hits.some((hit) => hit.includes(length === 16 || payload.includes("\n") ? "binary file of unknown type" : "invalid or oversized inline image")));
    }
  }
});

for (const [name, value] of [["two", "acmecor"], ["three", "acmecorp"]])
  test(`round 14.2: a header prefix includes its final ${name}-character group`, () => {
    const terms: PrivateTerms = { terms: [{ value, line: 1 }], allowed: [], notes: [] };
    const body = Buffer.from(value).toString("base64").replace(/=+$/, "");
    assert.ok(checkText(`x data:text/plain;base64,${body}%00 y`, "f.md", terms)
      .some((hit) => hit.includes("inline image") && hit.includes("private term")));
  });

test("round 14.2: the prefix scan joins allowed whitespace after percent decoding", () => {
  const terms: PrivateTerms = { terms: [{ value: "acmeco", line: 1 }], allowed: [], notes: [] };
  const body = Buffer.from("acmeco").toString("base64");
  for (const whitespace of ["\n \t\r\f", "%0A%20%09%0D%0C"]) {
    const wrapped = body.slice(0, 4) + whitespace + body.slice(4);
    assert.ok(checkText(`<img src="data:text/plain;base64,${wrapped}%00">`, "f.md", terms)
      .some((hit) => hit.includes("inline image") && hit.includes("private term")), whitespace);
  }
});

test("round 13.2: chained data URLs report the original location only once per hit", () => {
  const text = "<data:text/plain,".repeat(4) + home("fixture-person") + ">".repeat(4);
  const hits = checkText(text, "f.md", empty);
  assert.ok(hits.some((hit) => hit.includes("home path")));
  assert.ok(hits.every((hit) => hit.startsWith("f.md") && (hit.match(/\(inline image\)/g)?.length ?? 0) <= 1));
});

test("round 13.3: repeated bearer placeholders pin the 4096/4097 literal cutoff", () => {
  const placeholder = "token-".repeat(683);
  assert.deepEqual(checkText(`Authorization: Bearer ${placeholder.slice(0, 4096)}`, "f.md", empty), []);
  assert.ok(checkText(`Authorization: Bearer ${placeholder.slice(0, 4097)}`, "f.md", empty)
    .some((hit) => hit.includes("secret shape")));
});

test("round 15.1: quoted and backtick URL lists scan the next candidate", () => {
  const terms: PrivateTerms = { terms: [{ value: "acmecorp", line: 1 }], allowed: [], notes: [] };
  const next = Buffer.from("acmecorp").toString("base64");
  for (const quote of ['"', "'", "`"]) for (const space of [" ", "\n "]) {
    const text = `${quote}data:text/plain;base64,cHVibGlj${space}data:text/plain;base64,${next}${quote}`;
    assert.ok(checkText(text, "f.md", terms).some((hit) => hit.includes("inline image") && hit.includes("private term")));
  }
});

test("round 15.2: inline unknown binary without NUL is refused while repository files keep their classifier", () => {
  const compressed = Buffer.from("Gw0B+MVjbF37SqZI7BYM/FGx+gE=", "base64");
  for (const bytes of [compressed, Buffer.from([255, ...Buffer.from("public fixture")]),
    ...[1, 7, 8, 11, 14, 27, 31].map((code) => Buffer.from(`public${String.fromCharCode(code)}fixture`))]) {
    assert.ok(!bytes.includes(0));
    assert.deepEqual(checkBuffer(bytes, "f.bin", empty, false), []);
    const body = bytes.toString("base64");
    for (const ending of ["", " ", "...", " [truncated]"])
      assert.ok(checkText(`data:application/octet-stream;base64,${body}${ending}`, "f.md", empty)
        .some((hit) => hit.includes("binary file of unknown type")), ending);
    const percent = [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
    assert.ok(checkText(`data:application/octet-stream,${percent}`, "f.md", empty)
      .some((hit) => hit.includes("binary file of unknown type")));
  }
  for (const value of ["public café", "public\t\n\r\ffixture"])
    assert.deepEqual(check(`data:text/plain;base64,${Buffer.from(value).toString("base64")}`), []);
});

test("round 15.6: spaces between MIME parameters and the base64 marker are accepted", () => {
  for (const parameters of ["; charset=utf-8;base64", ";charset=utf-8; base64", "; charset=utf-8;  base64 "]) {
    assert.deepEqual(check(`data:text/plain${parameters},${Buffer.from("hello world").toString("base64")}`), []);
    assert.ok(check(`data:text/plain${parameters},${Buffer.from(home("fixture-person")).toString("base64")}`)
      .some((hit) => hit.includes("home path")));
  }
});

const round15Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg";
test("round 15.7: the reported truncated PNG examples are quiet", () => {
  for (const text of [
    `data:image/png;base64,${round15Png.slice(0, 20)}\n`,
    `{"url":"data:image/png;base64,${round15Png.slice(0, 30)}"}`,
    `src="data:image/png;base64,${round15Png.slice(0, 40)}"`,
    ...[" ...", " [truncated]", " <truncated>"].map((ending) => `data:image/png;base64,${round15Png.slice(0, 50)}${ending}`),
    `\`data:image/png;base64,${round15Png.slice(0, 88)}...\``,
    String.raw`const re = /^data:image\/png;base64,iVBORw0KGgoAAAANSUhEUg/;`,
  ]) assert.deepEqual(checkText(text, "f.md", empty), [], text);
});

test("round 15.7: known image signatures and truncated structure retain the 128-character limit", () => {
  const webp = Buffer.from("RIFF0000WEBPVP8 0000public fixture", "ascii");
  webp.writeUInt32LE(200, 4); webp.writeUInt32LE(188, 16);
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 224, 0, 100]), Buffer.from("public fixture")]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0, 0, 0, 0, 33, 254, 100]), Buffer.from("public")]);
  for (const bytes of [Buffer.from(round15Png, "base64").subarray(0, 30), jpeg, gif, webp]) {
    const body = bytes.toString("base64");
    assert.ok(body.length >= 16 && body.length < 128);
    assert.deepEqual(check(`data:application/octet-stream;base64,${body}`), []);
  }
  const pngBody = png(pngChunk("tEXt", Buffer.from(`Comment\0${"public ".repeat(100)}`))).toString("base64");
  assert.deepEqual(check(`data:image/png;base64,${pngBody.slice(0, 127)}`), []);
  assert.ok(check(`data:image/png;base64,${pngBody.slice(0, 128)}`).some((hit) => hit.includes("invalid PNG")));
});

for (const marker of ["...", "…", "[...]", "[truncated]", "(truncated)", "<truncated>"])
  test(`round 15.7: ${marker} admits truncated image bodies below 256 characters only`, () => {
    const body = png(pngChunk("tEXt", Buffer.from(`Comment\0${"public ".repeat(100)}`))).toString("base64");
    for (const length of [128, 200, 255, 256]) for (const spaces of ["", "  "]) {
      const hits = check(`data:image/png;base64,${body.slice(0, length)}${spaces}${marker}`);
      if (length < 256) assert.deepEqual(hits, []);
      else assert.ok(hits.some((hit) => hit.includes("invalid PNG")));
    }
    assert.ok(check(`data:application/octet-stream;base64,${round14Body} ${marker}`)
      .some((hit) => hit.includes("binary file of unknown type")));
    const malformed = png(pngChunk("zTXt", Buffer.from("Comment\0bad compressed text")));
    assert.ok(check(`data:image/png;base64,${malformed.toString("base64")} ${marker}`)
      .some((hit) => hit.includes("invalid PNG")));
  });

test("round 15.7: truncated PNGs scan complete chunks and the remaining decoded prefix", () => {
  const terms: PrivateTerms = { terms: [{ value: "acmecorp", line: 1 }], allowed: [], notes: [] };
  const compressed = pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(home("fixture-person"))]));
  const partial = pngChunk("tEXt", Buffer.from("Comment\0acmecorp public padding")).subarray(0, -2);
  const bytes = Buffer.concat([png().subarray(0, 33), compressed, partial]);
  const body = bytes.toString("base64");
  assert.ok(body.length < 256);
  const hits = checkText(`data:image/png;base64,${body} [truncated]`, "f.md", terms);
  assert.ok(hits.some((hit) => hit.includes("home path")));
  assert.ok(hits.some((hit) => hit.includes("private term")));
  assert.ok(hits.every((hit) => !hit.includes("invalid PNG")));
  const invalidChunk = pngChunk("zTXt", Buffer.from("Comment\0bad compressed text"));
  const invalid = Buffer.concat([png().subarray(0, 33), invalidChunk, partial]).toString("base64");
  assert.ok(check(`data:image/png;base64,${invalid} [truncated]`).some((hit) => hit.includes("invalid PNG")));
  const latinTerms: PrivateTerms = { terms: [{ value: "fixture café", line: 1 }], allowed: [], notes: [] };
  for (const [content, label, scanTerms] of [
    [Buffer.from("fixture café padding", "latin1"), "private term", latinTerms],
    [Buffer.from(secret, "utf16le"), "secret shape", empty],
  ] as const) {
    const chunk = pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), content])).subarray(0, -2);
    const encoded = Buffer.concat([png().subarray(0, 33), chunk]).toString("base64");
    const hits = checkText(`data:image/png;base64,${encoded} [truncated]`, "f.md", scanTerms);
    assert.ok(hits.some((hit) => hit.includes(label)));
    assert.ok(hits.every((hit) => !hit.includes("invalid PNG")));
  }
});

const round16Terms: PrivateTerms = { terms: [{ value: "acmecorp", line: 1 }], allowed: [], notes: [] };
const round16Png = png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync("acmecorp public fixture padding")])))
  .toString("base64");
const round16Truncated = png(pngChunk("tEXt", Buffer.from(`Comment\0${"public".repeat(100)}`))).toString("base64").slice(0, 112);
for (const kind of ["prose", "Markdown", "CSS", "YAML", "JS", "Python", "comma", "backslash"])
  test(`round 16.0: ${kind} wrapped PNG bodies retain compressed private-term hits`, () => {
    for (const [body, label] of [[round16Png, "private term"], [round16Truncated, "quiet"]])
      for (const width of [76, 15]) {
        const chunks = [body.slice(0, width), ...body.slice(width).match(/.{1,76}/g) ?? []];
        const plain = chunks.join("\n");
        const text = kind === "prose" ? `see data:image/png;base64,${plain}` :
          kind === "Markdown" ? `![x](data:image/png;base64,${plain})` :
          kind === "CSS" ? `url(data:image/png;base64,${plain})` :
          kind === "YAML" ? `image: data:image/png;base64,${chunks.join("\n  ")}` :
          kind === "backslash" ? `data:image/png;base64,${chunks.join("\\\n  ")}` :
          `"data:image/png;base64,${chunks.join(kind === "JS" ? '" +\n  "' : kind === "comma" ? '",\n  "' : '"\n  "')}"`;
        const hits = checkText(text, "f.md", round16Terms);
        // R18: an invalid join contributes disclosures, never a refusal of its own.
        if (label === "quiet" && kind !== "backslash") assert.deepEqual(hits, [], `${kind} ${width}`);
        else if (label === "quiet") assert.ok(hits.every((hit) => hit.includes("invalid PNG")));
        else assert.ok(hits.some((hit) => hit.includes(label)), `${kind} ${width}`);
        if (label === "private term") assert.ok(!hits.some((hit) => hit.includes("invalid PNG")), `${kind} ${width}`);
      }
    assert.deepEqual(check(`data:image/png;base64,${round15Png.slice(0, 20)}\nnext paragraph`), []);
  });

test("round 16.0: wrapped payload lines are joined with linear work", () => {
  const content = Buffer.from(`${"public ".repeat(65536)}acmecorp`);
  const bytes = png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(content, { level: 0 })])));
  const body = bytes.toString("base64").match(/.{1,76}/g)?.join("\n") ?? "";
  const text = `data:image/png;base64,${body}`;
  const budget = new ScanBudget();
  assert.ok(checkText(text, "f.md", round16Terms, { budget }).some((hit) => hit.includes("private term")));
  assert.ok(budget.inlineTerminatorWork <= 8 * text.length);
  const encoded = (round16Png.slice(76).match(/.{1,76}/g) ?? []).map((line) =>
    [...line].map((character) => `%${character.charCodeAt(0).toString(16)}`).join("")).join("\n");
  assert.ok(checkText(`data:image/png;base64,${round16Png.slice(0, 76)}\n${encoded}`, "f.md", round16Terms)
    .some((hit) => hit.includes("private term")));
});

test("round 16.2: later candidates retain the enclosing quote across a short line wrap", () => {
  for (const quote of ['"', "'", "`"]) {
    const body = Buffer.from("acmecorp").toString("base64");
    const text = `${quote}data:text/plain;base64,cHVibGlj data:text/plain;base64,${body.slice(0, 4)}\n${body.slice(4)}${quote}`;
    assert.ok(checkText(text, "f.md", round16Terms).some((hit) => hit.includes("private term")));
  }
});

test("round 16.2b / 18.3: early-stop readings retain disclosures; R1 governs invalid tails", () => {
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 225, 0, 30]), Buffer.from("Exif\0\0acmecorp public fixture"), Buffer.from([255, 217])]);
  // F6: a valid base64url image no longer needs an invalid label. A real term still counts.
  assert.ok(checkText(`<img src="data:image/jpeg;base64,${jpeg.toString("base64url")}">`, "f.md", round16Terms)
    .some((hit) => hit.includes("private term")));
  for (const stop of ["%01", "%7F", "%E9"])
    assert.ok(check(`data:;base64,${"A".repeat(16)}${stop}AAAA`).some((hit) => hit.includes("invalid")));
  // These first pieces have no usable body (raw binary) or only a short header.
  for (const body of [jpeg.toString("latin1"), ...["-", "_", "é", "\u0001", "\u007f"].map((stop) => `iV${stop}AAAA`)])
    assert.deepEqual(check(`<img src="data:image/jpeg;base64,${body}">`), []);
  for (const stop of ["<", "{", "$", "[", ".", "…", "%s", "?", "!", " ", '"', ")"])
    assert.deepEqual(check(`data:image/png;base64,iV${stop}`), []);
});

test("round 16.2c: MIME type spacing cannot hide image payloads", () => {
  for (const mime of [" image/png", "image/png ", "\timage/png\t", " image/png "])
    assert.ok(checkText(`data:${mime};base64,${round16Png}`, "f.md", round16Terms).some((hit) => hit.includes("private term")));
});

test("round 16.3: attribute discovery counts linear work even with srcset text inside a title", (t) => {
  const text = `<img title="${"srcset=".repeat(32768)}" src="data:text/plain,public">`;
  const budget = new ScanBudget();
  const limit = 12 * text.length;
  let hiddenWork = 0;
  const exec = RegExp.prototype.exec;
  const searches = t.mock.method(RegExp.prototype, "exec", function (this: RegExp, input: string) {
    // Count suffix revisits hidden in the former unanchored srcset attribute regex.
    if (this.source.includes("srcset") && this.source.includes("[^")) {
      for (let at = input.indexOf("srcset="); at >= 0; at = input.indexOf("srcset=", at + 7)) {
        hiddenWork += input.length - at;
        if (hiddenWork + budget.inlineTerminatorWork > limit) budget.spend(Infinity);
      }
    }
    return exec.call(this, input);
  });
  try {
    assert.deepEqual(checkText(text, "f.md", empty, { budget }), []);
    assert.ok(hiddenWork + budget.inlineTerminatorWork <= limit);
  } finally { searches.mock.restore(); }
});

test("round 16.4: BOM-marked UTF-16 text is classified by decoded controls", () => {
  for (const bigEndian of [false, true]) {
    const encode = (value: string) => {
      const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from(value, "utf16le")]);
      return bigEndian ? bytes.swap16() : bytes;
    };
    for (const value of ["public", "public\t\n\r\ffixture"])
      assert.deepEqual(check(`data:text/plain;charset=utf-16;base64,${encode(value).toString("base64")}`), []);
    assert.ok(checkText(`data:text/plain;base64,${encode("acmecorp").toString("base64")}`, "f.md", round16Terms)
      .some((hit) => hit.includes("private term")));
    for (const code of [0, 1, 11, 31, 127])
      assert.ok(check(`data:text/plain;base64,${encode(`public${String.fromCharCode(code)}fixture`).toString("base64")}`)
        .some((hit) => hit.includes("binary file of unknown type")));
  }
});

test("round 16.5: whitespace between MIME parameter tokens is accepted", () => {
  for (const parameters of [";charset=utf-8 ;base64", "; charset = utf-8 ; base64", ';name = "public fixture" ;charset=utf-8\t;base64']) {
    assert.deepEqual(check(`data:text/plain${parameters},${Buffer.from("hello world").toString("base64")}`), []);
    assert.ok(checkText(`data:text/plain${parameters},${Buffer.from("acmecorp").toString("base64")}`, "f.md", round16Terms)
      .some((hit) => hit.includes("private term")));
  }
});

test("round 16.6: DEL is a control in inline bodies while adjacent printable bytes remain text", () => {
  for (const code of [126, 127, 128]) {
    const bytes = Buffer.from(`public${String.fromCharCode(code)}fixture`);
    const hits = check(`data:text/plain;base64,${bytes.toString("base64")}`);
    if (code === 127) assert.ok(hits.some((hit) => hit.includes("binary file of unknown type")));
    else assert.deepEqual(hits, []);
    assert.deepEqual(checkBuffer(bytes, "f.bin", empty, false), []);
  }
});

for (const [type, body] of [
  ["gif", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
  ["webp", "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="],
]) test(`round 16.7: complete ${type} images are known and their text remains scanned`, () => {
  const bytes = Buffer.from(body, "base64");
  assert.deepEqual(check(`data:image/${type};base64,${body}`), []);
  const metadata = Buffer.from("acmecorp");
  let withText: Buffer;
  if (type === "gif") withText = Buffer.concat([bytes.subarray(0, -1), Buffer.from([33, 254, metadata.length]), metadata, Buffer.from([0, 59])]);
  else {
    const chunk = Buffer.alloc(8); chunk.write("XMP "); chunk.writeUInt32LE(metadata.length, 4);
    withText = Buffer.concat([bytes, chunk, metadata]); withText.writeUInt32LE(withText.length - 8, 4);
  }
  assert.ok(checkText(`data:image/${type};base64,${withText.toString("base64")}`, "f.md", round16Terms)
    .some((hit) => hit.includes("private term")));
  if (type === "webp") {
    withText.writeUInt32LE(4, 4);
    assert.ok(check(`data:image/webp;base64,${withText.toString("base64")}`).some((hit) => hit.includes("unknown type")));
  }
});

test("round 16.8: Markdown's base64 fast path does not visit a long suffix", () => {
  const suffix = "x".repeat(262144);
  const scan = (opening: string) => {
    const budget = new ScanBudget();
    assert.deepEqual(checkText(`${opening}data:text/plain;base64,cHVibGlj,${suffix}`, "f.md", empty, { budget }), []);
    return budget.inlineTerminatorWork;
  };
  assert.ok(scan("[x](") - scan("") < 128);
});

test("round 17.1: continuation grammar excludes padding, prose and foreign closers", () => {
  const clean = Buffer.from(round15Png, "base64").toString("base64");
  for (const text of [
    "icon: data:text/plain;base64,SGVsbG8gd29ybGQ=\nconfigurationKeyName: value",
    ["data:", "text/plain;base64,SGVsbG8gd29ybGQ=\nveryLongIdentifierName"].join(""),
    '{"a":"data:image/png;base64,iVBORw0KGgo",\n"veryLongIdentifierNameHere": 1}',
    "Use data:image/png;base64,iVBORw0KGgo\nAbcdefghijklmnopqrstuvwxyz is the alphabet.",
    "Use data:image/png;base64,\nconfigurationManagerImplementation to embed.",
    ["data:", "text/plain;base64,SGVsbG8=\nabcdefghijklmnopqrstuvwxyz0123"].join(""),
    "Example: `data:text/plain;base64,cHVibGlj`\nInternationalization is supported.",
    ...["`", ">", ")", "]", "|", ":"].map((end) => `data:text/plain;base64,cHVibGlj${end}\nInternationalization`),
    ...["That is a 1x1 PNG.", "name: example", "abcdefghijklmnopqrstuvwxyz0123"].map((tail) =>
      `icon: data:image/png;base64,${clean.match(/.{1,40}/g)?.join("\n  ")}\n${tail}`),
    `<img src="data:image/png;base64,${clean.match(/.{1,40}/g)?.join("\n")}"\n  alt="pixel">`,
  ]) assert.deepEqual(check(text), [], text);
  // Round 22.2: an explicit chain with a valid opaque second segment now refuses (corpus C370).
  const chain = ['const a = "data:', 'text/plain;base64,SGVsbG8=" +\n  "veryLongIdentifierNameHere";'].join("");
  assert.deepEqual(check(chain), ["--text #1 (inline image): binary file of unknown type"]);
});

test("round 17.1: leading and trailing operators join PNG metadata and short text tails", () => {
  for (const body of [round16Png, Buffer.from(`${"x".repeat(57)}acmecorp\n`).toString("base64")])
    for (const operator of ["+", ".", "..", "||", "&", "& _", ",", "\\"])
      for (const leading of [false, true])
        for (const quote of ['"', "'"]) {
          const parts = body.match(/.{1,76}/g) ?? [];
          const separator = leading ? `${quote}\n  ${operator} ${quote}` : `${quote} ${operator}\n  ${quote}`;
          const text = `${quote}data:;base64,${parts.join(separator)}${quote};`;
          assert.ok(checkText(text, "f.md", round16Terms).some((hit) => hit.includes("private term")), text);
        }
  const body = Buffer.from(`${"x".repeat(57)}acmecorp\n`).toString("base64");
  for (const [before, after] of [["", ""], ["note: ", ""], ["[n](", ")"], ["url(", ");"]])
    assert.ok(checkText(`${before}data:;base64,${body.slice(0, 76)}\n${body.slice(76)}${after}`, "f.md", round16Terms)
      .some((hit) => hit.includes("private term")));
  assert.ok(checkText(`@"data:;base64,${round16Png.slice(0, 76)}"\n + @"${round16Png.slice(76)}";`, "f.md", round16Terms)
    .some((hit) => hit.includes("private term")));
});

test("round 17.2: unmatched quotes do not enclose later data URIs", () => {
  for (const text of [
    'The 5" screen shows icons.\nUse data:image/png;base64,iVBORw0KGgo for PNG.\nUse data:image/gif;base64,R0lGODlhAQABAIAAAP for GIF files in many docs.',
    'It\'s a 3" icon. See data:text/plain;base64,aGVsbG8= and data:text/plain;base64,d29ybGQ= and then\nsome prose that follows with words and more words.',
    '"data:text/plain;base64,cHVibGlj" +\n "Internationalization\nprose after an unmatched quote',
    '"data:text/plain;base64,cHVibGlj\nInternationalization\nprose before an unmatched quote',
  ]) assert.deepEqual(check(text), []);
  // OP1: a closing quote bounds strictly valid binary even when its alphabet resembles prose.
  const closed = ['"data:', "text/plain;base64,", 'cHVibGlj\nInternationalization\nprose before an unrelated closing quote"'].join("");
  assert.deepEqual(check(closed),
    ["--text #1 (inline image): binary file of unknown type"]);
});

test("round 17.2: a first URL after quoted lead text retains short wrapped payloads", () => {
  for (const body of [Buffer.from("acmecorp").toString("base64"), Buffer.from(`${"x".repeat(57)}acmecorp\n`).toString("base64")]) {
    const width = body.length < 76 ? 4 : 76;
    for (const text of [
      `"inline data:;base64,${body.slice(0, width)}\n${body.slice(width)}"`,
      `"inline data:;base64,${body.slice(0, width)}\n${body.slice(width)}\n"`,
      JSON.stringify({ msg: `inline data:;base64,${body.slice(0, width)}\n${body.slice(width)}` }),
    ]) assert.ok(checkText(text, "f.md", round16Terms).some((hit) => hit.includes("private term")), text);
  }
});

test("round 17.3: typography ends a body without borrowing the following prose", () => {
  for (const ending of ["—", "–", "”", "’", "»", "“", "\u00a0", "→", "（", "，"])
    for (const body of ["iVBORw0KGgo", round15Png, "aGVsbG8gd29ybGQ="])
      assert.deepEqual(check(`Use “data:;base64,${body}${ending} the documented signature.`), []);
  for (const body of ["YOUR_BASE64_HERE", "CONFIGURATIONVALUE_REPLACE_ME", "iV-placeholder-like-text-here", "iVBORw0KGgo-style", "iVBORw0KGgo_truncated_for_brevity", "/9j/4AAQ_REPLACE_ME_WITH_BASE64"])
    assert.deepEqual(check(`data:;base64,${body}`), []);
  const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 225, 0, 29]), Buffer.from("Exif\0\0acmecorp public fixture"), Buffer.from([255, 217])]);
  for (const bytes of [jpeg, Buffer.from("~~~ acmecorp"), Buffer.from("~~~ acmecorp public fixture")]) {
    const body = bytes.toString("base64url");
    assert.match(body, /[-_]/);
    assert.ok(checkText(`data:;base64,${body}`, "f.md", round16Terms).some((hit) => hit.includes("private term")));
  }
  for (const body of [Buffer.from(round16Png, "base64").toString("latin1"), Buffer.from(round16Png, "base64").toString("utf8"),
    `iV-${round16Png.slice(2)}`, ...["\u0085", "\u2028"].map((separator) => round16Png.match(/.{1,76}/g)?.join(separator))])
    assert.deepEqual(check(`"data:;base64,${body}"`), []);
});

test("round 17.4: GIF and WebP require a complete block walk", () => {
  const compressed = deflateSync("acmecorp private fixture padding");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), compressed]);
  webp.writeUInt32LE(webp.length - 8, 4);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0, 0, 0, 0]), compressed, Buffer.from([59])]);
  for (const bytes of [webp, gif])
    assert.ok(checkText(`data:;base64,${bytes.toString("base64")}`, "f.md", round16Terms).some((hit) => hit.includes("unknown type")));
});

test("round 17.4: metadata boundaries cannot split terms or secret shapes", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const webp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
  const riffChunk = (kind: string, bytes: Buffer) => {
    const header = Buffer.alloc(8); header.write(kind); header.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([header, bytes, Buffer.alloc(bytes.length % 2)]);
  };
  for (const [value, label] of [["acmecorp", "private term"], [secret, "secret shape"]]) {
    const data = Buffer.from(`${"x".repeat(251)}${value}`);
    const parts = [data.subarray(0, 255), data.subarray(255)];
    for (const kind of [254, 255]) {
      const app = kind === 255 ? [Buffer.from([11]), Buffer.from("FIXTURE0001")] : [];
      const bytes = Buffer.concat([gif.subarray(0, -1), Buffer.from([33, kind]), ...app,
        ...parts.flatMap((part) => [Buffer.from([part.length]), part]), Buffer.from([0, 59])]);
      assert.ok(checkText(`data:;base64,${bytes.toString("base64")}`, "f.md", round16Terms).some((hit) => hit.includes(label)));
    }
    for (const kind of ["EXIF", "XMP "]) {
      const bytes = Buffer.concat([webp, ...parts.map((part) => riffChunk(kind, part))]);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      assert.ok(checkText(`data:;base64,${bytes.toString("base64")}`, "f.md", round16Terms).some((hit) => hit.includes(label)));
    }
    const segments = parts.map((part) => {
      const header = Buffer.from([255, 254, 0, 0]); header.writeUInt16BE(part.length + 2, 2);
      return Buffer.concat([header, part]);
    });
    for (const scan of [Buffer.alloc(0), Buffer.from([255, 218, 0, 2, 42, 255, 0, 42, 255, 208, 42])]) {
      const bytes = Buffer.concat([Buffer.from([255, 216]), segments[0]!, scan, segments[1]!, Buffer.from([255, 217])]);
      assert.ok(checkText(`data:;base64,${bytes.toString("base64")}`, "f.md", round16Terms).some((hit) => hit.includes(label)));
    }
  }
});

test("round 17.5: MIME discovery counts nullable whitespace partitions", (t) => {
  const text = `data:${" ".repeat(8192)}placeholder`;
  const budget = new ScanBudget();
  let hiddenWork = 0;
  const exec = RegExp.prototype.exec;
  const searches = t.mock.method(RegExp.prototype, "exec", function (this: RegExp, input: string) {
    // With a nullable MIME between two whitespace stars the engine tries every partition.
    if (this.source.includes("data:[ \\t]*(") && this.source.includes(")?[ \\t]*")) {
      const spaces = /data:([ \t]+)/.exec(input)?.[1].length ?? 0;
      hiddenWork += spaces * (spaces + 1) / 2;
    }
    return exec.call(this, input);
  });
  try {
    assert.deepEqual(checkText(text, "f.md", empty, { budget }), []);
    assert.ok(hiddenWork + budget.inlineTerminatorWork <= 12 * text.length);
  } finally { searches.mock.restore(); }
});

test("round 18.1: independent readings retain disclosures despite quote parity and trailing code", () => {
  const parts = round16Png.match(/.{1,60}/g)!;
  for (const before of ['The 5" screen.\n', "A writer's note.\n", "Use ` here.\n"])
    for (const separator of ["\n", "\r\n", "\r", "\\n", "\\r\\n", "\\u000a", "&#10;", "&#xA;"])
      for (const tail of ['" # icon', '", "name": "x"}', '"; // icon']) {
        const text = `${before}"data:;base64,${parts.join(separator)}${tail}`;
        assert.ok(checkText(text, "fixture", round16Terms).some((hit) => hit.includes("private term")), separator);
      }
  for (const whitespace of [" ", "\t", "\f"])
    assert.ok(checkText(`The 5" screen. <img src="data:;base64,YWNt${whitespace}ZWNvcnA=">`, "fixture", round16Terms)
      .some((hit) => hit.includes("private term")));
});

test("round 18.1: invalid joins never overrule R1 and both plus interpretations expose terms", () => {
  for (const text of [
    "data:image/png;base64,iVBORw0KGgo\nThisIsTheNextSentenceWithoutSpaces",
    `${["data", "text/plain;base64,"].join(":")}SGVsbG8\nveryLongIdentifierName`,
    `"${["data", "text/plain;base64,"].join(":")}fn5\n+cHVibGljIGZpeHR1cmU="`,
  ]) assert.deepEqual(check(text), []);
  for (const dataPlus of [true, false]) {
    const body = Buffer.from("~~~acmecorp").toString("base64");
    const text = dataPlus ? `data:;base64,${body.slice(0, 3)}\n${body.slice(3)}` :
      `"data:;base64,${body.slice(0, 4)}"\n+ "${body.slice(4)}"; // last piece`;
    assert.ok(checkText(text, "fixture", round16Terms).some((hit) => hit.includes("private term")));
  }
  const gz = zlib.gzipSync(Buffer.from("synthetic fixture")).toString("base64");
  for (const tail of ["-->", "_v2", "-encoded payload."])
    assert.ok(check(`data:application/gzip;base64,${gz}${tail}`).some((hit) => hit.includes("unknown type")));
  const ansi = Buffer.from("~~~ \x1b[31macmecorp\x1b[0m").toString("base64url");
  assert.ok(checkText(`data:;base64,${ansi}`, "fixture", round16Terms).some((hit) => hit.includes("private term")));
});

test("round 18.1 / 18.3: metadata findings survive a later structural failure, including GIF plain text", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const webp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
  for (const [value, label] of [["acmecorp", "private term"], [secret, "secret shape"]]) {
    const parts = [Buffer.from(`padding ${value.slice(0, 4)}`), Buffer.from(value.slice(4))];
    const bodies: Buffer[] = [png(pngChunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0"), deflateSync(value)])))];
    for (const kind of [1, 254, 255]) {
      const header = kind === 1 ? [Buffer.from([12]), Buffer.alloc(12)] : kind === 255 ?
        [Buffer.from([11]), Buffer.from("FIXTURE0001")] : [];
      bodies.push(Buffer.concat([gif.subarray(0, -1), Buffer.from([33, kind]), ...header,
        ...parts.flatMap((part) => [Buffer.from([part.length]), part]), Buffer.from([0, 59])]));
    }
    for (const kind of ["XMP ", "EXIF"]) {
      const chunks = parts.map((part) => {
        const header = Buffer.alloc(8); header.write(kind); header.writeUInt32LE(part.length, 4);
        return Buffer.concat([header, part, Buffer.alloc(part.length % 2)]);
      });
      const bytes = Buffer.concat([webp, ...chunks]); bytes.writeUInt32LE(bytes.length - 8, 4); bodies.push(bytes);
    }
    bodies.push(Buffer.concat([Buffer.from([255, 216]), ...parts.map((part) => {
      const header = Buffer.from([255, 254, 0, 0]); header.writeUInt16BE(part.length + 2, 2);
      return Buffer.concat([header, part]);
    }), Buffer.from([255, 217])]));
    for (const bytes of bodies)
      for (const tail of [Buffer.alloc(0), Buffer.from([42]), Buffer.from([255, 255, 255, 255])]) {
        const body = Buffer.concat([bytes, tail]).toString("base64");
        // Even an invalid R2 retains its metadata. The arbitrary text after the last quote is intentional.
        const text = `"data:;base64,${body.slice(0, 20)}\n${body.slice(20)}"; // fixture`;
        assert.ok(checkText(text, "fixture", round16Terms).some((hit) => hit.includes(label)), `${bytes.subarray(0, 4).toString("hex")} ${tail.length} ${label}`);
      }
  }
});

for (const kind of ["first", "join", "plus", "url", "whitespace", "bounded", "padded", "tolerant", "mixed"] as const)
  test(`round 18.4: ${kind} readings have bounded passes and decoded bytes`, (t) => {
    let previousWork = 0;
    for (const n of [512, 1024, 2048]) {
      const body = Buffer.from("~~~public fixture ".repeat(n)).toString("base64");
      const padded = Buffer.from(`${"~~~public fixture ".repeat(n)}!`).toString("base64");
      const payload = kind === "join" ? body.match(/.{1,60}/g)!.join('" +\n "') :
        kind === "plus" ? body.match(/.{1,3}/g)!.join("\n+") :
        kind === "url" ? body.replaceAll("+", "-").replaceAll("/", "_") :
        kind === "whitespace" ? body.match(/.{1,4}/g)!.join(" \t") :
        kind === "bounded" ? '" +\n "' + body.match(/.{1,60}/g)!.join('" +\n "') :
        kind === "padded" ? `${padded}\n${padded}` :
        kind === "tolerant" ? `${body.slice(0, 12)}é${body.slice(12)}` : body;
      let text = `"data:;base64,${payload}"`;
      if (kind === "mixed") {
        const plain = Buffer.from("public".repeat(n)).toString("base64");
        const padded = Buffer.from("public!".repeat(n)).toString("base64");
        text = `"${["data", "text/plain;base64,"].join(":")}${plain}\n+${plain}\n.${padded}" +\n"${plain}" +\n"!"`;
      }
      const budget = new ScanBudget();
      let decodedCharacters = 0, decodes = 0;
      const from = Buffer.from;
      const allocations = t.mock.method(Buffer, "from", function (value: never, encoding: never) {
        if (typeof value === "string" && (encoding === "base64" || encoding === "base64url")) {
          decodedCharacters += value.length; decodes++;
        }
        return from(value, encoding);
      });
      try {
        const hits = checkText(text, "fixture", empty, { budget });
        if (kind === "mixed") assert.equal(round22Outcome(hits), "refusal");
        else assert.deepEqual(hits, kind === "plus" ? ["fixture (inline image): binary file of unknown type"] : []);
        assert.ok(decodes <= 6, `constant readings: ${decodes}`);
        assert.ok(decodedCharacters <= 6 * text.length);
        assert.ok(budget.inlineTerminatorWork <= 14 * text.length);
        if (previousWork) assert.ok(budget.inlineTerminatorWork <= previousWork * 2.1);
        previousWork = budget.inlineTerminatorWork;
      } finally { allocations.mock.restore(); }
    }
  });

// Round 18 differential corpus: copied synthetic probe inputs, never imports from /tmp.
// Columns: id, probe provenance, outcome at 318765e, outcome at e848997, expected, packed arguments, entry point.
// Gzip/base64 stores the exact strings (including timing repetitions and control bytes) without
// embedding active URI/credential literals in this publicly scanned source. No files are extracted.
const round18Corpus: readonly (readonly [number, string, string, string, string, string, string])[] = [
  [0, "gate-probe-r16--p0-wrap.ts:prose76#1; gate-r17-sec--r16-p0-wrap.ts:prose76#1; gate-r17-sec--r16-p0-wrap.ts:prose76#2; gate-r17-sec--r16-p0-wrap.ts:prose76#3", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3XKCMBSE3+VcM1Wm1CodLw6I4E+RJI2tVS4Q0pQKQdGK6PjunfRmd+eb2d01ZMkpsfMykaKzV/JlmxxFzzLypbOgTXfmywoRMWT82+NSR0+L4+JK+9c4ZVMd8CNktDvB+milPaIBVYSbDqJ72aif5txfEa5xJQq6yrzwvH03i60iiEGetm0nYq3JmHddvPHHxbzdE+Ze6Oz1eTJvdz76B+KGl0MwiGYbpWdGvPDIklrKj6xrf9QEDY4Rg07+uRsE///OlPInr95NpZTDIRiQVelDmYFxg5OoyyPY6xuck+JXgA1JWoq0qvdgQJErAbZ5jw1IiqJqRAb2OjZAVSehS/E9/gMxgsIiNQEAAA==", "checkText"],
  [1, "gate-probe-r16--p0-wrap.ts:prose76_crlf#2; gate-r17-sec--r16-p0-wrap.ts:prose76_crlf#4; gate-r17-sec--r16-p0-wrap.ts:prose76_crlf#5; gate-r17-sec--r16-p0-wrap.ts:prose76_crlf#6", "quiet", "private", "private", "H4sIAAAAAAAAAx1OzXKCQBh7l+/MVJlSq3Q8fCCCP0WW7dpa5bDCllKXRdGK6Pjune0lySSTTNaQ8RO3i5LnorNX+cuWH0XPMoqls4ib7szPK0TEkLJvj+VaehocF1eav8YpnWqBHyGNuxOsj1baI9qIFWGmg+heNvVG/TTn/oowHVRCxqvMC8/bd1NuFUEMirRtOxFtTUq96+KNPS7m7Z5Q9xLPXp8n83bno38gbng5BINopvf00IhJjyxjS/mRde2PmqDBMWLQKT53g+D/gzON2ZNX76Z5ng+HYEBWpQ9lBsYNTqIuj2Cvb3Dm8leADTwtRVrVezBAFkqAbd4TA7iUVSMysNeJAao6CV1K7skf0gtpqjkBAAA=", "checkText"],
  [2, "gate-probe-r16--p0-wrap.ts:prose76_cr#3; gate-r17-sec--r16-p0-wrap.ts:prose76_cr#7; gate-r17-sec--r16-p0-wrap.ts:prose76_cr#8; gate-r17-sec--r16-p0-wrap.ts:prose76_cr#9", "quiet", "private", "private", "H4sIAAAAAAAAAx2NW2+CQBSE/8t5JlVSapXGhwMieCmyu11bqzyssN1SuShaEY3/vdm+zEy+ZGbWkIqTsLNCKNnZl+plK46yZxnZ0lnQpjvzVYWIGDL+7XGlo6fFcXGl/WucsKkO+BEy2p1gfbSSHtGAloSbDqJ72dQ/zbm/IlzjSuZ0lXrheftu5tuSIAZZ0radiLUmY9518cYfF/N2T5h7obPX58m83fnoH4gbXg7BIJptaj0z4rlHltQq/ci69kdN0OAYMehkn7tB8P/vTCl/8urdVCk1HIIBaZU8FCkYNzjJujiCvb7BWeS/EmwQSSGTqt6DAXlWSrDNe2yAyPOqkSnY69iAsjpJXYrv8R+QEO1HNQEAAA==", "checkText"],
  [3, "gate-probe-r16--p0-wrap.ts:prose64#4; gate-r17-sec--r16-p0-wrap.ts:prose64#10; gate-r17-sec--r16-p0-wrap.ts:prose64#11; gate-r17-sec--r16-p0-wrap.ts:prose64#12", "quiet", "private", "private", "H4sIAAAAAAAAAx2OTXOCMBiE/8t7ZqpMqVU6Hl4RwY+iSRpbqxwipCk1BEUrouN/79DL7nPY3dk1pOIk3CwXSrb2Rr1sxVF2HCtbDua0ak8DVSAiRox/+1w16Dcy8HDV+NcoYZMG8CNitD3G8ugkHYK4MYjUEG4PEL3LT3XurghvcoXUdJX60Xn7buutIYhhltR1a8FqmzH/On/jj/NZvScbw7wLnb4+j2f1LsDgQLzocgh7i2kzM+TaJ0vqmGDhXLvDKqxwhBi2ss9dLyT/FycbQ/mTX+4mSql+HyxIi+QhT8G6wUmW+RHc9Q3OQv9KcEEkuUyKcg8W6MxIcO17bIHQuqhkCu46tsAUJ9mU4nv8Bwbi5wI3AQAA", "checkText"],
  [4, "gate-probe-r16--p0-wrap.ts:prose20#5; gate-r17-sec--r16-p0-wrap.ts:prose20#13; gate-r17-sec--r16-p0-wrap.ts:prose20#14; gate-r17-sec--r16-p0-wrap.ts:prose20#15", "quiet", "private", "private", "H4sIAAAAAAAAAx1Oy26CQBT9l7smVVJqlcbFBRF8FJ2h2FqHBcKUUuGiaEU0/nsz3ZxXck7OBtL4FJt5GWeys6fsZRsfZc/Q8pW14E135mYVIqIfhN+OoDBTxlFg2bhW/CVonARTJfHDD3h3gvXRSAT1mIo4sVC3EO3LT3PuC1qzUMWVLPg6dfzz9l0vBG2JIXp50radZdDqQeBcF4LewsfFvN2zwL7w2evzZN7uXEHoHpjtXw7eYDlTU6OwcASxFTfIXRrX/qjxGhwjeh1B+edu4P3/sKY8fHLq3TQTlGXDIWiQVslDmYJ2g5OsyyOYmxuc4+JXgglxUsqkqvegQZGTBFO/RxrERVE1MgVzE2lA1UmqUnSP/gAKeJoPRQEAAA==", "checkText"],
  [5, "gate-probe-r16--p0-wrap.ts:prose8#6; gate-r17-sec--r16-p0-wrap.ts:prose8#16; gate-r17-sec--r16-p0-wrap.ts:prose8#17; gate-r17-sec--r16-p0-wrap.ts:prose8#18", "quiet", "quiet", "private", "H4sIAAAAAAAAAyWPXVOCUBRF/8t5ZlImMqXx4YgIfqReCMs8PCDciISDoYno+N+bW29r9p41e/YGkugYmVkRpbK15/RpGx1kx9Cy1WDh1e0psZOWiIhzYj/4tIMUkRjRVtmA2MK1og/iUexPFBLj29z32mMkrg5G3BH/hsci0AeKrPNXfeoSr0WghJJY5t46secn4u2rnm9ZKMPN4qZpLYn9Rvd9+7IgfgnuF7NmL4h96+xNnx/HxLNm56DzLYit+fnb7S2nagNxGOQ2sVh5BjtLg/jSHdZujSPVuq3sfdcjdsXfjQmxFzzY1W6SEqdpvw8aJGV8VySgXeEoq+IA5uYKpyj/kWBCFBcyLqs9aJBnLMHUb6EGUZ6XtUzA3IQacHmUSgpv4S9h1uwVYwEAAA==", "checkText"],
  [6, "gate-probe-r16--p0-wrap.ts:prose4#7; gate-r17-sec--r16-p0-wrap.ts:prose4#19; gate-r17-sec--r16-p0-wrap.ts:prose4#20; gate-r17-sec--r16-p0-wrap.ts:prose4#21", "quiet", "quiet", "private", "H4sIAAAAAAAAAzWOXVOCUBiE/8u5ZlImM6Xx4ogoaqlAWOZ6gXAiEhe/Ej/G/96gdffM8+6+s1MRBbvASJZBrEorxk/zYKuqFS0ZN4egm5f7YCfOJCilHICe/2WBfiyvxrr5JmjKyY0/wXbo9a5cmPeBB7rlrgQ320oIVp1b1yXo+HqzYPMAfuf7Gjhx/NufDFSpOwEja7AH5296Cs7pFFc7CcHjsTQCvaPugZ51GoKv/v0QfD6uHNAzDy7Yf3nsFmbRAWVn7YDm4LAG7fqo/7+w5acW6IzdCsjOqAKeaq0ctHPZLjJ2CUw+FnXQ/lve7IGu/2CBm0UvBuO40RCaiLLwbhkJ7Sx2arPcCmN6Fvsg/VHCEEG4VGG2WQlNpAmVMPTLTBNBmma5ioQxnWmC2U4Vpdll9gtS8RkblQEAAA==", "checkText"],
  [7, "gate-probe-r16--p0-wrap.ts:md76#8; gate-r17-sec--r16-p0-wrap.ts:md76#22; gate-r17-sec--r16-p0-wrap.ts:md76#23; gate-r17-sec--r16-p0-wrap.ts:md76#24", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEn6Xnqk1IlZRapfHigAj+FGW3a2uRixW2lAqLohXQ9N2b7c3M5EtmJoSbsIluE37iZlbwVHT2Mn3e8qPoGVq2shak7s7ctERE9Cn7cliqoqPEsnGt/HMc06kK+O5T0p1gdTTiXqAAkQHTLUS72cjv+txfB0zhUuRknTj+efum51sZIHpZ3LadJW11Sp3L4pU9LObtPqB2Q2YvT5N5u3PRPQS23xy8wXK2kWpmxHInWBFDukvj0h/VXo1jRK+TfewG3v+/NSXs0al20zRNh8M70CAp4/siAe0KJ1EVRzDDK5x5/iPABB4XIi6rPWiQZ1KAqf9GGvA8L2uRgBlGGsjyJFQp+o3+AMhY+Sw7AQAA", "checkText"],
  [8, "gate-probe-r16--p0-wrap.ts:md76_crlf#9; gate-r17-sec--r16-p0-wrap.ts:md76_crlf#25; gate-r17-sec--r16-p0-wrap.ts:md76_crlf#26; gate-r17-sec--r16-p0-wrap.ts:md76_crlf#27", "quiet", "private", "private", "H4sIAAAAAAAAAx1OX1OCQBz8LP2eaoZJmciUxocfiOCf0DvCMuThhIvI41A0AZ2+e3O97O7szu5sBDdRE9+m7MTMvGAZ7+xl9rxlR94ztHxlLWjdnblZiYjoB+GXE2ZKOgosG9eKP8dJMFUC3/2AdidYHY2kR5RBJQl1C9FuNtVGftfn/pqEKii5oOvU8c/bN11sJUH08qRtO8ug1YPAuSxew4fFvN2TwG7o7OVpMm93LroHYvvNwRssZ2pPDY1C4ZAVNaS7NC79Ue3VOEb0OvnHbuD9f7CmNHx0qt00y7Lh8A40SMvkvkhBu8KJV8URzOgKZyZ+OJjAkoInZbUHDUQuOZj6b6wBE6KseQpmFGsgyxNXpfg3/gP+TdVJPwEAAA==", "checkText"],
  [9, "gate-probe-r16--p0-wrap.ts:css76#10; gate-r17-sec--r16-p0-wrap.ts:css76#28; gate-r17-sec--r16-p0-wrap.ts:css76#29; gate-r17-sec--r16-p0-wrap.ts:css76#30", "quiet", "private", "private", "H4sIAAAAAAAAAx2NW2+CQBSE/0pzntqEVEmpVYwPB0TwhgLF1ioPC2y3lGVRvCAa/3uzfZmZfMnMbCAmSc6q8iRS/eFU8ceUHImeFYTR1k6wfkwOtKMp2cpY+HV7arMSEdENwh8rZDJaUgwT19K/R0kwkQE/3cBvj7E6aEnHk8AXXqgaiOZlK37rc3fthRKXlPvr1HLP8YfKY+EhOlnSNK1l0KhBYF0X7+HLYtbsvMC8+NP523jW5Dbae890L3unt5xuhZwZhtzyVr4m7KV27Q5rp8YRotPKvvKe8/9vTPzw1aryCWNsMHjqgwJpmTwXKSg3ONKqOIC+ucGZ8BMFHUhS0KSsdqAAzwQFXb1HChDOy5qmoG8iBUR5pLIU3aM/MDjq+EcBAAA=", "checkText"],
  [10, "gate-probe-r16--p0-wrap.ts:css76_q#11; gate-r17-sec--r16-p0-wrap.ts:css76_q#31; gate-r17-sec--r16-p0-wrap.ts:css76_q#32; gate-r17-sec--r16-p0-wrap.ts:css76_q#33", "private", "private", "private", "H4sIAAAAAAAAAx2NW2+CQBSE/0pzntqEVEmpVYwPB0TwUhQotlZ4WGC7pSyL4gXR9L8325eZyZfMzBYSkhasrk4i0+9ONb+PICNHouclYbSzE2yYkAPtaUq+NpZ+053brEJEdIPw2wqZjJYUw8SN9K9JGsxkwA838LtTrA9a2vMk8IUXqgaieYnET3Pub7xQ4opyf5NZ7jl5V3kiPEQnT9u2swpaNQis6/ItfFou2p0XmBd//voyXbSFjfbeM93L3hms5pGQM+OQW97a14S90q79ceM0OEF0OvlnMXD+/42ZHz5bdTFjjI1GETwMQYGsSh/LDJQbHGldHkDf3uBM+ImCDiQtaVrVO1CA54KCrv7GChDOq4ZmoG9jBUR1pLIU/8Z/sg5gNEsBAAA=", "checkText"],
  [11, "gate-probe-r16--p0-wrap.ts:yaml64#12; gate-r17-sec--r16-p0-wrap.ts:yaml64#34; gate-r17-sec--r16-p0-wrap.ts:yaml64#35; gate-r17-sec--r16-p0-wrap.ts:yaml64#36", "quiet", "private", "private", "H4sIAAAAAAAAAx2OTXOCMBiE/4rznpkqU2qVjodXRPCjaEhjay2HCCmlhsSiFdHxv3fSy+4edp/ZDRSpVm4r40fuFiXPRXuv8qctP4iuYxWr4SKuO7Mg14iIEWVfPstN9I0MPVwb/xyndGoCvkU07kywOjhplyB+qFYLMVaE2UNE7/xdn3prwkxTCxmvMz86bV9tuVUEMSzSpmkvaWNT6l8WL+x+MW/2xDCod45nz4+TebMLMPghXnT+CfvLmQGNmPTJKnZUsHQuvVEd1jhGDNvF+64fkv+bU8OI2YNf7aZ5ng8GYEGm07syA+sKR1GVB3A3Vzhx+SvABZ6WItXVHiyQhRLg2rfEAi6lrkUG7iaxQOmjMKPklvwB5dTgZ0MBAAA=", "checkText"],
  [12, "gate-probe-r16--p0-wrap.ts:yaml_block#13; gate-r17-sec--r16-p0-wrap.ts:yaml_block#37; gate-r17-sec--r16-p0-wrap.ts:yaml_block#38; gate-r17-sec--r16-p0-wrap.ts:yaml_block#39", "quiet", "private", "private", "H4sIAAAAAAAAAx2OTXOCMBiE/4rznpkqU2qVjodXRPCjYKDYWsshQppSQ6JoRbT+90562d3D7jO7hiJT0m79fshWK6dHahcl5ay9k/xpQw+saxnFchhGdWfmcYWIGMTJl5twHV0tQwdX2j/HWTzVAd+COOpMsDpYWZcgajJiJEliDhGd83d96q1IopuKiWiVu8Fp82qKjSSIfpE1TXsRN2Ycu5fwJbkP582OaEbsnKPZ8+Nk3mw99PbECc57v7+YadAoES5ZRpb0FtalN6r9GseIfrt43/Z98n9zqhlR8uBW2ynnfDAAA3KV3ZU5GFc4sqo8gL2+womKHwY20Kxkmap2YIAoJAPbvKUGUCFUzXKw16kBUh2ZHqW39A98RFzzSAEAAA==", "checkText"],
  [13, "gate-probe-r16--p0-wrap.ts:js_concat#14; gate-r17-sec--r16-p0-wrap.ts:js_concat#40; gate-r17-sec--r16-p0-wrap.ts:js_concat#41; gate-r17-sec--r16-p0-wrap.ts:js_concat#42", "quiet", "private", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/wqZa0mVlFrFeBgQwY+iQNfWCgeE7ZYKiwIV0fjfm+3Fy8yT9808mS3EBa9qKc2ZNJICSKI60tI8YrRz4Gy4iyraU+V0rS+9pju3WIGI6Pjk2yRMoCmGbuBG7K9J7M8E4Ifje90plpUaByA9BFySAui5ovK4SxQd0Tj/NKf+xiUiLGjmbRLTOe3elWzHXUQ7jdu2s/JbxffNy/JueSNPy0V7cH3j7M1fX6aLdm+hdXQN53y0B6u50I1JZrprT+XWSr30x43d4ATR7twt6ed+YP//o8888myW+xljbDQKYAgyJEX8mCcgX6GmZV6Btr3CKcp+KWgQxTmNi/IAMmQpp6Apt1CGKMuKhiagbUMZeFFTcRTewj9DLnSwYAEAAA==", "checkText"],
  [14, "gate-probe-r16--p0-wrap.ts:js_concat_lead_plus#15; gate-r17-sec--r16-p0-wrap.ts:js_concat_lead_plus#43; gate-r17-sec--r16-p0-wrap.ts:js_concat_lead_plus#44; gate-r17-sec--r16-p0-wrap.ts:js_concat_lead_plus#45", "quiet", "quiet", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/wqZa0mVlFrFeBgQwY+iQNfWCgeE7ZYKiwIV0fjfm+3Fy8yT9808mS3EBa9qKc2ZNJICSKI60tI8YrRz4Gy4iyraU+V0rS+9pju3WIGI6Pjk2yRMoCmGbuBG7K9J7M8E4Ifje90plpUaBxBwSXqQAui5ovK4SxQd0Tj/NKf+xiUiLGjmbRLTOe3elWzHXUQ7jdu2s/JbxffNy/JueSNPy0V7cH3j7M1fX6aLdm+hdXQN53y0B6u50I1JZrprT+XWSr30x43d4ATR7twt6ed+YP//o8888myW+xljbDQKYAgyJEX8mCcgX6GmZV6Btr3CKcp+KWgQxTmNi/IAMmQpp6Apt1CGKMuKhiagbUMZeFFTcRTewj/GgWOTYAEAAA==", "checkText"],
  [15, "gate-probe-r16--p0-wrap.ts:js_concat_single#16; gate-r17-sec--r16-p0-wrap.ts:js_concat_single#46; gate-r17-sec--r16-p0-wrap.ts:js_concat_single#47; gate-r17-sec--r16-p0-wrap.ts:js_concat_single#48", "quiet", "private", "private", "H4sIAAAAAAAAAzWOTW+CQBCG/wqZC4eSKim1FeNhQAQ/ii4UW2s5IGy3VFgUqIjG/95sEy8zT94382Q2EBe8qqU0Z9JQkpOojvQ0jxjt7DkbbKOK9jQlXRkLr+nObFYgIrp+8G0FTKAlhmHiWuyvcexPBeC763vdCZaVFsvS3SeXJLlHROFxEqgGonn6aY7PaxKIsKCZt04s97h9U7MtJ4hOGrdtZ+m3qu9b58XN8Ro8LObtnvjmyZu9PE3m7c5G+0BM93Rw+suZkI2CzCIrT+P2Ujs/jxqnwTGi07k50o9d3/n/xZh6waNV7qaMseFQHoACSRHf5wkoF6hpmVegby5wjLJfCjpEcU7jotyDAlnKKejqNVQgyrKioQnom1ABXtRUHIXX8A8bCAyMWAEAAA==", "checkText"],
  [16, "gate-probe-r16--p0-wrap.ts:js_template#17; gate-r17-sec--r16-p0-wrap.ts:js_template#49; gate-r17-sec--r16-p0-wrap.ts:js_template#50; gate-r17-sec--r16-p0-wrap.ts:js_template#51", "private", "private", "private", "H4sIAAAAAAAAAx2N0W6CQBREf8XcZ1IlpVYxPlwQQW1RoNhaIXGF7Za6LApUROO/N9uXmclJZmYLSSGqupPlrDPu7FJSEz3LCaPdo2CjPaloX1Mika2Npd/0FjYrEBHdIPy2QiajJcUwcSP9a5oEcxnwww383gzLSksi0fck8oUXqgaieflpzoONF0pYUO5vUss9799VvhceopMlbdtdBa0aBNZ1GYm38HH50h69wLz4i9fn2Ut7sNE+eaZ7OTnD1ULOTEJueWtfE/ZKuw4mjdPgFNHpRiL7PAyd/39j7odPVnmYM8bG490IFEiL5CFPQblBTcu8An17gzPhvxR0IElOk6I8ggI8ExR09R4rQDgvGpqCvo0VEEVNZSm+x38upS+CSAEAAA==", "checkText"],
  [17, "gate-probe-r16--p0-wrap.ts:py_implicit#18; gate-r17-sec--r16-p0-wrap.ts:py_implicit#52; gate-r17-sec--r16-p0-wrap.ts:py_implicit#53; gate-r17-sec--r16-p0-wrap.ts:py_implicit#54", "quiet", "private", "private", "H4sIAAAAAAAAA0WO3W6CQBCFX4XMVZuQKim1SuPFgAj+obsUW6tcrLClVFgUrYjGd2+2SePNnJNzZr7MEgYTR+kqdyuhKIqygpgdmJHmLOGNrUhe1mzPW7qazs0prZojJykQET0/+LKDRFpbDtPChdTPfuQPpcF3z6fNAZZ7PVrBP7tFZEUFCTQT0Tp9V8f2ggQyLHhGF7HtHddvWrYWBNFNo7puzPxa8337PL1RXoPH6bjeEt860dHkeTCuNw46O2J5p53bmY0krhdkNplTXTgz/dzuVW6FfUS3caOkH5uO+/ePOaTBk11uhkmSdLty4x5UiIvoIY9BvcCBl/kejOUFjiz74WAAi3IeFeUWVMhSwcHQrqEKLMuKisdgLEMVRHHg8ii8hr+lzdV7YwEAAA==", "checkText"],
  [18, "gate-probe-r16--p0-wrap.ts:py_backslash#19; gate-r17-sec--r16-p0-wrap.ts:py_backslash#55; gate-r17-sec--r16-p0-wrap.ts:py_backslash#56; gate-r17-sec--r16-p0-wrap.ts:py_backslash#57", "quiet", "private", "private", "H4sIAAAAAAAAAx1NzXKCQBh7lZ3vzFSZUqt0PHwggn/oLsXWCgeE7Za6gEUrouO7d7aXJJNMki1MFi4Zkgiy5JSYeZEI3jmU4mWXHHnP0PK1tWRNd+aKChHRD8IvJxRKOgosGzeKP8dpMFUC3/2AdSdYH400AhJFUUkIIRH0qEpZSUPdQrQv3825v6GhMisu2SZz/PPuTZe7kiJ6edq2nVXQ6kHgXJev4eNy3h5oYF/YbPE8mbd7F90favuXH2+wmqmRUSgdumZG6a6Ma3/UeA2OEb1O/rEfeP/f1pSFT069nwohhsMIQIOsSh+KDLQbnHhdHMHc3uCcyF8OJiRpwdOqPoAGMi85mPo91iCRsmp4BuY21qCsTlyV4nv8B5rpgaNIAQAA", "checkText"],
  [19, "gate-probe-r16--p0-wrap.ts:split15#20; gate-r17-sec--r16-p0-wrap.ts:split15#58; gate-r17-sec--r16-p0-wrap.ts:split15#59; gate-r17-sec--r16-p0-wrap.ts:split15#60", "quiet", "private", "private", "H4sIAAAAAAAAAx1NW1OCQBj9L98zkzKRKY0PH4jgJZTd1jLjYYVtI5fF0ER0/O/N9nJuM+ecDeT8yN2i5FJ09lo+bflB9ByrWHkL0nRnoawQET90TNlXwKQxgQHPx7Xhz3FGp0bgW0xJd4L1wcl6iQmITpjtIfrn7+bUXyfMhJVQZJ0H8Wn7aqutThCjImvbzpK2NqXBZfHC7hfzdp9Q/0xmz4+TebsLMfxJ/Pj8Ew2WMzMyYipIVsTR4dK59EdN1OAYMeoU77tB9P/tTQl7COrdVEo5HIIFeZXdlTlYVziKujyAu7nCiatfAS7wrBRZVe/BAlVoAa59Sy3gSlWNyMHdpBbo6ihMKb2lfxJ99pEzAQAA", "checkText"],
  [20, "gate-probe-r16--p0-wrap.ts:split15_crlf#21; gate-r17-sec--r16-p0-wrap.ts:split15_crlf#61; gate-r17-sec--r16-p0-wrap.ts:split15_crlf#62; gate-r17-sec--r16-p0-wrap.ts:split15_crlf#63", "quiet", "private", "private", "H4sIAAAAAAAAAx1Ny3KCMBT9l7tmqkypVTouLojgo0hIY2uVRYSUUkNQtCI6/nsn3ZzXzDlnDRk/cbsoeS46e5W/bPlR9CyjWDqLuOnO/LxCRNzUGxVS9u2xXFtPg+PiSvPXOKVTLfAjpHF3gvXRSntEB7EizHQQ3ctPc+6vCNNhJWS8yrzwvH035VYRxKBI27YT0dak1Lsu3tjjYt7uCXUv8ez1eTJvdz76B+KGl0MwiGZ6ZMSkR5axpfzIuvZHTdDgGDHoFJ+7QfD/7Uxj9uTVu2me58MhGJBV6UOZgXGDk6jLI9jrG5y5/BVgA09LkVb1HgyQhRJgm/fEAC5l1YgM7HVigKpOQpeSe/IHQH0+KjUBAAA=", "checkText"],
  [21, "gate-probe-r16--p0-wrap.ts:html_attr76#22; gate-r17-sec--r16-p0-wrap.ts:html_attr76#64; gate-r17-sec--r16-p0-wrap.ts:html_attr76#65; gate-r17-sec--r16-p0-wrap.ts:html_attr76#66", "private", "private", "private", "H4sIAAAAAAAAAx2NYVOCQBiE/0rzfmZSJjKlbOYFEdRCOTrLhA8nXBcJh4KJ6Pjfm+vL7s4zs7treMoKcVNXyTCClB2YmRVM8M5OiscNq3nP0LKlNSdNd+aKEhHRD+m3Q4WKjhLLxpXyr3ESTlXADz8k3QlWtZH0AgWIDKhuIdqnSP40x/4qoAqXPCer1PGPm3c938gA0cuStu0swlYPQ+c8f6N385d2F4T2icxeHyYv7dZFdx/Y/mnvDRazSKqZEc2dYEkM6S6Mc3/UeA2OEb1O9rkdeP//1pTQe6faToUQw2EEz6BBWia3RQraBQ68Kmow1xc4svyXgwksKXhSVjvQIM8kB1O/xhqwPC8bnoK5jjWQ5YGrUnyN/wCiRu6qQwEAAA==", "checkText"],
  [22, "gate-probe-r16--p0-wrap.ts:html_attr76_crlf#23; gate-r17-sec--r16-p0-wrap.ts:html_attr76_crlf#67; gate-r17-sec--r16-p0-wrap.ts:html_attr76_crlf#68; gate-r17-sec--r16-p0-wrap.ts:html_attr76_crlf#69", "private", "private", "private", "H4sIAAAAAAAAAx1OUVOCQBj8K833zKRMZErZzAciqIVyF5YJD3hcFwmHgono+N+b62V3Z3d2Z9fwlBXipq7YMII0OSRmViSCd3ZSPG6SmvcMLVtac9J0Z64oERF9Gn47oVDSUWDZuFL8NWZ0qgR++JR0J1jVBusFyiAyCHUL0T5FVSR/mmN/FYQqKHlOVqnjHzfver6RAaKXsbbtLGirU+qc52/h3fyl3QXUPpHZ68Pkpd266O4D2z/tvcFipvbU0CjMnWBJDOkujHN/1HgNjhG9Tva5HXj/H6wpCe+dajsVQgyHETyDBmnJbosUtAsceFXUYK4vcEzyXw4mJKzgrKx2oEGeSQ6mfo01SPK8bHgK5jrWQJYHrkrxNf4DtK+0RkcBAAA=", "checkText"],
  [23, "gate-probe-r16--p0-wrap.ts:html_attr76_indent#24; gate-r17-sec--r16-p0-wrap.ts:html_attr76_indent#70; gate-r17-sec--r16-p0-wrap.ts:html_attr76_indent#71; gate-r17-sec--r16-p0-wrap.ts:html_attr76_indent#72", "private", "refusal", "private", "H4sIAAAAAAAAAyWOUVOCUBCF/4qzz0zKRKYUzSyIoBYKhGXCwxVuN/ICCiSg439vbr3snjlnzre7hcc0Y2He61VlrIWQkJqoaUYY7R9y9rAjFR0qUrrWl14zWFisQER0/ODLDJiQphi6gRuxP6exPxcC3x3fG8ywrJR46ArDy91A1hGNVtzq9b6b02jjBiIqKPc2iemcdm8y3+Uuop3GXddf+Z3s++Z5+RrcLp+7g+sbrbd4uZ89d3sLraNrOO3RHq8W/0SBmgTcdNeeklsr5TyaNHaDU0S7n37sx/bfH/rcC+7Mcj9njGlaCKJLeK2F0IbwBBIkRXyTJSBdoKZlVoG6vcCJ8B8KKpA4o3FRHkACnuYUVPkaSUA4LxqagLqNJMiLmopSdI1+ARKWXGtbAQAA", "checkText"],
  [24, "gate-probe-r16--p0-wrap.ts:html_attr_single#25; gate-r17-sec--r16-p0-wrap.ts:html_attr_single#73; gate-r17-sec--r16-p0-wrap.ts:html_attr_single#74; gate-r17-sec--r16-p0-wrap.ts:html_attr_single#75", "private", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX6U5N96QKim1ltYmB0Twp+hC19YqFwjbLXVZFKyIxndvtjczky+ZmRU8Zzm/qcqk30rjQ2xmecxZeyf50yauWNfQsoU1C+rOxOUFIqIf0m+HchUdJZaNS+VfwyQcq4Affhh0RlhWRtIlCgSSUN1CtE9r+VMfe0tCFS6YCJap4x8377rYSILoZUnTtOdho4ehc5690bvZtNmR0D4Fk9eH0bTZuujuie2f9t7jfLKWamZAhUMWgSHduXHuDWqvxiGi184+t4/e/781Dui9U27HnPN+v/UCGqRFcpunoF3gwMq8AnN1gWMsfhmYECc5S4pyBxqITDIw9WukQSxEUbMUzFWkgSwOTJWia/QHYk+eJUEBAAA=", "checkText"],
  [25, "gate-probe-r16--p0-wrap.ts:html_attr_unquoted#26; gate-r17-sec--r16-p0-wrap.ts:html_attr_unquoted#76; gate-r17-sec--r16-p0-wrap.ts:html_attr_unquoted#77; gate-r17-sec--r16-p0-wrap.ts:html_attr_unquoted#78", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX6U516RKSq3S2uSACP6hsF1bq1yssN1SYVGwIhrfvdnezEy+ZGbW8JLm4q4q437CjsxMcyZ4ay/F85ZVvGNo6dKah3V74ooCEdEn9NuhQkVHiWXjSvnXMCZjFfDDJ2F7hGVlxJ1AgVAGVLcQ7fNG/tSn7iqgChc8C1eJ45+273q2lQGil8ZN01qQRifEuczf6MN82uwDYp/DyexpNG12LrqHwPbPB6+3mGykmhnQzAmWoSHdhXHpDmqvxiGi10o/dz3v/98ah/TRKXdjIUS//woaJEV8nyegXeHIy7wCc32FE8t+OZjA4pzHRbkHDbJUcjD1W6QBy7Ki5gmY60gDWRy5KkW36A9Cyiw2PwEAAA==", "checkText"],
  [26, "gate-probe-r16--p0-wrap.ts:json_n_escapes#27; gate-r17-sec--r16-p0-wrap.ts:json_n_escapes#79; gate-r17-sec--r16-p0-wrap.ts:json_n_escapes#80; gate-r17-sec--r16-p0-wrap.ts:json_n_escapes#81", "private", "private", "private", "H4sIAAAAAAAAAx2O3W6CQBSEX6U516RKSq3SeHFABH+KLnRtrcvFCtstFRaLVkTjuzfbm5nJl8xkNnBlkJeSgX3HIONHbucll6KzV/J5yw+iZxn5yllETXfmywoRMYzpl0eljp4Wx8W19s9xGk91wPcwjroTrA9W2iMaRIpQ00F0z4yp7+bUXxOqeSWKaJ154Wn7ZhZbRRCDPG3bzjJuzTj2LotX+rCYt3sSu+do9vI0mbc7H/0f4obnn2CwnDGm9M6IFh5ZRZbyl9alP2qCBseIQSf/2A2C/wfONKKPXr2bSimHQwY3MCCr0vsyA+MKR1GXB7A3Vzjx4leADTwtRVrVezCgyJUA27wlBvCiqBqRgb1JDFDVUehSckv+AC7jRShGAQAA", "checkText"],
  [27, "gate-probe-r16--p0-wrap.ts:json_rn_escapes#28; gate-r17-sec--r16-p0-wrap.ts:json_rn_escapes#82; gate-r17-sec--r16-p0-wrap.ts:json_rn_escapes#83; gate-r17-sec--r16-p0-wrap.ts:json_rn_escapes#84", "private", "private", "private", "H4sIAAAAAAAAAyVO226CQBT8leY8kyoptUrjwwERvBRctmtrXR4QtlsqF0UrovHfm21fZiYzmcms4cohKyQH845DGh9jMytiKTq7Uj5v4oPoGVq2tIKw6c5cWSEi+pR9OUwq6SiwbFwp/hwndKoEvvs07E6wPhhJjygjLAnTLUT7zHnNefndnPorwlRUiTxcpY5/2rzp+aYkiF6WtG1nQVudUucSvLKHYN7uCLXP4ezlaTJvty66e2L75703WMz+F9XUiOUOWYZG6S6MS3/UeA2OEb1O9rEdeH8/rGnIHp16O5VSDoccbqBBWiX3RQraFY6iLg5grq9wivMfASbESSGSqt6BBnlWCjD1W6RBnOdVI1Iw15EGZXUUqhTdol/QKvKKTAEAAA==", "checkText"],
  [28, "gate-probe-r16--p0-wrap.ts:json_n_escapes_ts#29; gate-r17-sec--r16-p0-wrap.ts:json_n_escapes_ts#85; gate-r17-sec--r16-p0-wrap.ts:json_n_escapes_ts#86; gate-r17-sec--r16-p0-wrap.ts:json_n_escapes_ts#87", "private", "private", "private", "H4sIAAAAAAAAAx2O3W6CQBSE3+VckyoptUrjxQER/Cm60LW1LhcI2y11WRStiMZ3b7Y3M5Mvmcls4MagKAUDm0GenlK7KFPBO3slXrbpkfcso1g5i6jpznxRISKGMf32qNDR0+K4uNb+Nc7iqQ74EcZRd4L10cp6RINIEWo6iO6FMfXTnPtrQjWvuIzWuReet++m3CqCGBRZ23aWcWvGsXddvNHHxbzdk9i9RLPX58m83fnoH4gbXg7BYDljTOmdEZUeWUWW8pfWtT9qggbHiEGn+NwNgv8HzjSiT169mwohhkMGdzAgr7KHMgfjBidel0ewNzc4p/KXgw1pVvKsqvdggCwUB9u8JwakUlYNz8HeJAao6sR1Kbknf5BTrY5FAQAA", "checkText"],
  [29, "gate-probe-r16--p0-wrap.ts:shell_backslash#30; gate-r17-sec--r16-p0-wrap.ts:shell_backslash#88; gate-r17-sec--r16-p0-wrap.ts:shell_backslash#89; gate-r17-sec--r16-p0-wrap.ts:shell_backslash#90", "private", "private", "private", "H4sIAAAAAAAAAx1OS3OCQBj7K8538UKrTKlVOh4+EMFH0YVia5XDumwpdVkUH4iO/72zvSSZZJLJCtipFI2HpNFM6JGaWU5T3trJ9HVDD7xjaNnCmgVVe+KmBSKiH0Y/TpQq6SiwbFwq/h6ycKwEfvph0B5heTBYhygjkCTSLUT7sl6v5W917i5JpIKCi2CZOP5586GLjSSIXsbqujUPaz0MnevsPXqaTesdCe1LMHl7GU3rrYvuntj+Ze/15hO1p4YGkXDIIjCkOzeu3UHlVThE9FrZ17bn/X+wxkH07JTbcZqm/X4TNEgK9pgnoN3gyMv8AObqBmcqThxMoCznrCh3oIHIJAdTv8caUCGKiidgrmINZHHkqhTf4z/+8V9gQwEAAA==", "checkText"],
  [30, "gate-probe-r16--p0-wrap.ts:shell_backslash_unq#31; gate-r17-sec--r16-p0-wrap.ts:shell_backslash_unq#91; gate-r17-sec--r16-p0-wrap.ts:shell_backslash_unq#92; gate-r17-sec--r16-p0-wrap.ts:shell_backslash_unq#93", "private", "private", "private", "H4sIAAAAAAAAAx1OzW6CQBh8leY7kyoptUrj4QMR/CnKbtfWKgdctkhdWEUrovHdm+1lZjKTmcwKBN+qhzQ5JXZeJJlo7cvsdZMcRccy8oUzI3V74mcKETGkbOuxTEtPg+PiUvP3kNOxFvgZUtIeYXW0eCfSBikjZjqI7mW9Xpc/9bm7jJgOlJBkmXrhefNhyk0ZIQY5b5rWnDYmpd519s6eZtNmH1H3QiZvL6Nps/PRP0RueDkEvflE7+mhAZNetCBW6c+ta3dQBzUOEYNW/rXrBf8fnDFhz161G2dZ1u+DAanij0UKxg1OoiqOYK9ucE7krwAbEl4Irqo9GCDzUoBt3mMDEilVLVKwV7EBpToJXYrv8R9petxWPgEAAA==", "checkText"],
  [31, "gate-probe-r16--p0-wrap.ts:blank_line_between#32; gate-r17-sec--r16-p0-wrap.ts:blank_line_between#94; gate-r17-sec--r16-p0-wrap.ts:blank_line_between#95; gate-r17-sec--r16-p0-wrap.ts:blank_line_between#96", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx1OzXKCQBh7l+/MVJlSq3Q8fCCCP0V2t2trlQPCdkuFRdGK6Pjune0lySSTTNaQJafEzstEis5eyZdtchQ9y8iXzoI23ZkvK0TEkPFvj0stPQ2OiyvNX+OUTbXAj5DR7gTro5X2iDaoItx0EN3LRm3UT3PurwjXQSUKusq88Lx9N4utIohBnrZtJ2KtyZh3Xbzxx8W83RPmXujs9Xkyb3c++gfihpdDMIhmG6VnRrzwyJJayo+sa3/UBA2OEYNO/rkbBP8PnCnlT169m0oph0MwIKvShzID4wYnUZdHsNc3OCfFrwAbkrQUaVXvwYAiVwJs8x4bkBRF1YgM7HVsgKpOQpfie/wHF9yl4TcBAAA=", "checkText"],
  [32, "gate-probe-r16--p0-wrap.ts:tab_indent#33; gate-r17-sec--r16-p0-wrap.ts:tab_indent#97; gate-r17-sec--r16-p0-wrap.ts:tab_indent#98; gate-r17-sec--r16-p0-wrap.ts:tab_indent#99", "quiet", "private", "private", "H4sIAAAAAAAAAx1OzXKCQBh7l+/MVJlSq3Q8fCCCP0V36dpa5bDCllKXRZGK6Pjune0lySSTTDaQ8prbecEz0Tmo7GXHT6JnGfnKWdCmO/OzEhExjNi3xzItPQ2Oi2vNX+MkmmqBH2FEuxOsTlbSI9qgijDTQXQvW7Wtf5pzf02YDkoh6Tr1wvPu3ZQ7RRCDPGnbzjJqzSjyros39riYtwcSuRc6e32ezNu9j/6RuOHlGAyWM72nh0ZMemRFLeUvrWt/1AQNjhGDTv65HwT/H5wpZU9etZ9mWTYcggFpmTwUKRg3qEVVnMDe3ODM5a8AG3hSiKSsDmCAzJUA27zHBnApy0akYG9iA1RZC12K7/Ef18b7ujkBAAA=", "checkText"],
  [33, "gate-probe-r16--p0-wrap.ts:md_quote#34; gate-r17-sec--r16-p0-wrap.ts:md_quote#100; gate-r17-sec--r16-p0-wrap.ts:md_quote#101; gate-r17-sec--r16-p0-wrap.ts:md_quote#102", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx1O226CQBT8leY8kyoptUqjyQERvBTd3a6ttTwgbLdUWBStiMZ/b7YvM5OZzGTWMLhL42NsZ0UsRWun5PMmPoiOZWRLZ07r9tSXJSJiyPi3x6WWngbHxZXmr1HCJlrge8hoe4zVwUo6RBtUEW46iO75Uw3ufupTd0W4DkqR01XqhafNm5lvFEEMsqRpWgvWmIx5l/krf5jPmh1h7plOX57Gs2bro78nbnjeB73FVO/poSHPPbKklvIX1qU7rIMaR4hBK/vY9oL/D86E8kev2k6klP0+GJCWyX2RgnGFo6iKA9jrK5zi/FeADXFSiKSsdmBAnikBtnmLDIjzvKxFCvY6MkCVR6FL0S36A788v7k7AQAA", "checkText"],
  [34, "gate-probe-r16--p0-wrap.ts:md_list#35; gate-r17-sec--r16-p0-wrap.ts:md_list#103; gate-r17-sec--r16-p0-wrap.ts:md_list#104; gate-r17-sec--r16-p0-wrap.ts:md_list#105", "quiet", "private", "private", "H4sIAAAAAAAAAx1OX1OCQBz8Ks7vmVImMqXx4Qci+Cf0js4y4+GE6yLhUDQRHb97c73s7uzO7uwa7lopP3I7K7gU7Z2Szxt+EF3LyJbOnNadqS9LRMQwYt8ek1p6GhwXV5q/Rkk00QLfw4h2xlgdrKRLtEEVYaaD6J4/Vav1U596K8J0UIqcrlIvPG3ezHyjCGKQJU3TXkSNGUXeZf7KHuazZkci90ynL0/jWbP10d8TNzzvg/5iqvf00JDlHllSS/kL69Ib1kGNI8SgnX1s+8H/B2dC2aNXbSdSysEADEjL5L5IwbjCUVTFAez1FU48/xVgA08KkZTVDgzIMyXANm+xATzPy1qkYK9jA1R5FLoU3+I/7xMKpTsBAAA=", "checkText"],
  [35, "gate-probe-r16--p0-wrap.ts:comment_slash#36; gate-r17-sec--r16-p0-wrap.ts:comment_slash#106; gate-r17-sec--r16-p0-wrap.ts:comment_slash#107; gate-r17-sec--r16-p0-wrap.ts:comment_slash#108", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx1OzW6CQBh8FfOdSZGUWqXx8IEI/hRkt2trLQeE7Za6gKIV0fjuzXqZmcxkJrMGXe9kyTGx8iIRXN+V4mWTHHjP1PKlHZKmO/NEhYgYUPbjMqGkq8B2cKX4e5zSqRL4EVDSnWB9MNNepAxSRsywEZ3zV6nrnd/m1F9FTCUVl2SVucFp827ITRkh+nnatvqCtgal7iV8Y4/hvN1F1DmT2evzZN5uPfT2kROc9/5gMbsPqqURk260JGbpLcxLf9T4DY4RfT3/3A78+wt7StiTW2+nQojhEDTIqvShyEC7wpHXxQGs9RVOifzjYEGSFjyt6h1oIPOSg2XcYg0SKauGZ2CtYw3K6shVKb7F/xBlDwg+AQAA", "checkText"],
  [36, "gate-probe-r16--p0-wrap.ts:comment_hash#37; gate-r17-sec--r16-p0-wrap.ts:comment_hash#109; gate-r17-sec--r16-p0-wrap.ts:comment_hash#110; gate-r17-sec--r16-p0-wrap.ts:comment_hash#111", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx1OzW6CQBh8lebzSqqk1CqNhw9E8Kfo7nZtreWAsKXUZVG0IhrfvdleZiYzmcmsoXWXxsfYzos4E+2dyp438UF0LSNfOnNad6Z+ViIihox/ezzT0tPguLjS/DVK2EQLfA8Z7YyxOlhJl2iDKsJNB9E9f6rW3U996q0I10EpJF2lXnjavJlyowhikCdN016wxmTMu8xf+cN81uwIc890+vI0njVbH/09ccPzPugvpnpPDw259MiSWspfWJfesA5qHCEG7fxj2w/+PzgTyh+9ajvJsmwwAAPSMrkvUjCucBRVcQB7fYVTLH8F2BAnhUjKagcGyFwJsM1bZEAsZVmLFOx1ZIAqj0KXolv0B4C5AoI7AQAA", "checkText"],
  [37, "gate-probe-r16--p0-wrap.ts:comment_star#38; gate-r17-sec--r16-p0-wrap.ts:comment_star#112; gate-r17-sec--r16-p0-wrap.ts:comment_star#113; gate-r17-sec--r16-p0-wrap.ts:comment_star#114", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx2O3W6CQBCFX8XMpSFFUmqVxosBEfwpytK1tZaLFbZb6gKKVkTjuzfrzczJOTnfzBr09lfRardSdmRWljPB9V0hXjbswLumli3tOak7U0+UiIhBRH9cKpR01bAdXKn9PUqiiRL4EUSkM8bqYCbdUBmkCKlhIzrn+5nf+tRbhVQlJZdklbrBafNuyE0RIvpZ0jT6ImqMKHIv8zf6OJ81uzByzmT6+jyeNVsPvX3oBOe9319M70BFGlLphktiFt7CvPSGtV/jCNHXs89t379/YU8IfXKr7UQIMRioog4apGXykKegXeHIq/wA1voKJyb/OFjAkpwnZbUDDWRWcLCMW6wBk7KseQrWOtagKI9cleJb/A8lUAckRwEAAA==", "checkText"],
  [38, "gate-probe-r16--p0-wrap.ts:pct_encoded#39; gate-r17-sec--r16-p0-wrap.ts:pct_encoded#115; gate-r17-sec--r16-p0-wrap.ts:pct_encoded#116; gate-r17-sec--r16-p0-wrap.ts:pct_encoded#117", "quiet", "private", "private", "H4sIAAAAAAAAAx2OW2+CQBSE/8tJfCOtWGqVxocDcvFSlN2urVUeVthSKiyKF0Tjf2+2LzOTL5nJrCDhR25mBU/F406mrxt+EF1DyxbWjNTtiZeWiIgBZT8OS1V0lFg2LpV/uzEdq4CfASXtEVYHI+6GChAZMt1CtC9r+Vufe8uQKVyKnCwTJzhvPvR8I0NEP4ubptVx57TRKXWus3f2NJs2u5DaFzJ5exlNm62H3j60g8ve788na6mGhix3wgUxpDc3rr1h7dfoIvqtjpt9bfv+/wdrTNizU23HaZoOBqBBUsYPRQLaDY6iKg5grm5w5vlJgAk8LkRcVjvQIM+kAFO/RxrwPC9rkYC5ijSQ5VGoUnSP/gCK2+ydOQEAAA==", "checkText"],
  [39, "gate-probe-r16--p0-wrap.ts:space_before_nl#40; gate-r17-sec--r16-p0-wrap.ts:space_before_nl#118; gate-r17-sec--r16-p0-wrap.ts:space_before_nl#119; gate-r17-sec--r16-p0-wrap.ts:space_before_nl#120", "quiet", "private", "private", "H4sIAAAAAAAAAx2O3W6CQBSEX8Wca1IlpVZpvDgggj9FYbu2VrlYYbulLouiFdH47s32ZmbyJTOZNWTsxOy8YIK390q8bNmRdy0jXzrzuO5MfVEiIoaEfntU6OhpcVxcaf8apWSiA36EJO6MsTpaaTfSIFYRNR1E99LaqJ/63FtFVPOSy3iVeeF5+27KrYoQgzxtmvaCNCYh3nX+Rh/ns2YfEfcST1+fx7Nm56N/iNzwcgj6i2lro/TOkEovWsaW8hfWtTesgxpHiEE7/9z1g/8HziSmT161mwghBgMwICvThyID4wYnXhVHsNc3ODP5y8EGlhY8Las9GCBzxcE274kBTMqy5hnY68QAVZ64LiX35A+r3N8ANwEAAA==", "checkText"],
  [40, "gate-probe-r16--p0-wrap.ts:formfeed#41; gate-r17-sec--r16-p0-wrap.ts:formfeed#121; gate-r17-sec--r16-p0-wrap.ts:formfeed#122; gate-r17-sec--r16-p0-wrap.ts:formfeed#123", "quiet", "quiet", "private", "H4sIAAAAAAAAAx2NW2+CQBSE/8t5JlVSapXGhwMieCm6u8XWKg8rrFvqAooXRON/b7YvM5MvmZkVpPzE7SznUrT2hXzb8KPoWEa2cGa0bk98WSIihiz68SKpo6fFcXGpfTtM2FgH/AoZbY+wOlpJh2hACxKZDqJ7XW9/60t3SSKNS6HoMvXCy+bTVJuCIAZZ0jStOWtMxrzb7CN6nk2bPWHulU7eX0fTZuejfyBueD0EvflkvdUzg0h5ZEGtwp9bt+6gDmocIgat7HvXC/7/nTGNXrxqN5ZS9vtgQFomT3kKxh1OosqPYK/ucOHqLMAGnuQiKas9GKCyQoBtPmIDuFJlLVKwV7EBRXkSuhQ/4j9q4O3DNQEAAA==", "checkText"],
  [41, "gate-probe-r16--p0-wrap.ts:ls_u2028#42; gate-r17-sec--r16-p0-wrap.ts:ls_u2028#124; gate-r17-sec--r16-p0-wrap.ts:ls_u2028#125; gate-r17-sec--r16-p0-wrap.ts:ls_u2028#126", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2O3W6CQBSE3+VckyoptUrjxQER/CnC0rW1hosVtlvqAopWRGPi4/hcPkmzvZmZfMlMZgkp2zMzy5ngrU0hXlZsxzuGls2tGanbE1eUiIh+RL8dKlR0lFg2LpR/DZNorAJ++BFpj7DaGUknVIAUIdUtRPt4v95+6kN3EVLFSy7JInX8w+pdl6siRPSypGlaQdToUeScZm/0cTZtNmFkH8nk9Xk0bdYuutvQ9o9brxdM7teb2hlQ6YRzYhRuYJy6g9qrcYjotbLPdc/7f2CNCX1yqvVYCNHvgwZpmTzkKWhn2PMq34G5PMOByV8OJrAk50lZbUADmRUcTP0Sa8CkLGuegrmMNSjKPVel+BL/AVKO8n83AQAA", "checkText"],
  [42, "gate-probe-r16--p0-wrap.ts:nel_u0085#43; gate-r17-sec--r16-p0-wrap.ts:nel_u0085#127; gate-r17-sec--r16-p0-wrap.ts:nel_u0085#128; gate-r17-sec--r16-p0-wrap.ts:nel_u0085#129", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2N226CQBiE3+W/JlVSapXGix9E8FB0d7u21nCxwnZL5aBoRTRe+mI+WbO9mZl8ycysIBEHYae5ULK1LdTLWuxlxzLShTOjdXviqxIRMWT82+NKR0+L4+JS+9cwZmMd8CNktD3Cam/FHaIBLQg3HUT3dL/91MfuknCNS5nRZeKFx/W7ma0LghikcdO05qwxGfPOszf+OJs2W8LcE528Po+mzcZHf0fc8LQLevPJ/aZnBjzzyIJahT+3zt1BHdQ4RAxa6eemF/z/O2PKn7xqM1ZK9ftgQFLGD3kCxgUOssr3YK8ucBTZrwQbRJzLuKy2YECWFhJs8xoZILKsrGUC9ioyoCgPUpeia/QHd72iGDUBAAA=", "checkText"],
  [43, "gate-probe-r16--p0-wrap.ts:html_br#44; gate-r17-sec--r16-p0-wrap.ts:html_br#130; gate-r17-sec--r16-p0-wrap.ts:html_br#131; gate-r17-sec--r16-p0-wrap.ts:html_br#132", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyVObVOCQBj8L89nJmUiU8pmHhDBl8DjwjLjwwEXkcehaCI6/vfm6svuzu7szq4hYwdmFiXLeWcr84eE7XnP0IqlFYRNd+bmFSKiT6MvJ8qVdBRYNq4Uf45TOlUC33wadidY7420R5QRShLpFqJ9ekzqpw/53Rz7KxKpqOIiXGWOf0xedZFIgugVadt2FrTVKXXOwUt0G8zbLaH2KZw930/m7cZFd0ds/7TzBovZ/6KaGkXCIcvQkO7COPdHjdfgGNHrFO+bgff3w5qG0Z1Tb6Z5ng+HoEFWpTdlBtoFDrwu92CuL3Bk4oeDCSwteVrVW9BAFJKDqV9jDZgQVcMzMNexBrI6cFWKr/EvzRoHND0BAAA=", "checkText"],
  [44, "gate-probe-r16--p0-wrap.ts:xml_cdata#45; gate-r17-sec--r16-p0-wrap.ts:xml_cdata#133; gate-r17-sec--r16-p0-wrap.ts:xml_cdata#134; gate-r17-sec--r16-p0-wrap.ts:xml_cdata#135", "quiet", "private", "private", "H4sIAAAAAAAAAx2PUW+CQBCEf0v3mRRJqVWqJgsiqC3KIbYWeTjheqXCoWhFNP735nyZnfmS3c1E0EvpkQ56D5E1xAVGMhlZQTlTd4K/buiBtXUlW5ozUremDi8REb0g/LFDLq0txbRwJef3KAkm0uCnF5DWGKuDnrR9CYjwQ81EtM5r8VufOis/lLhkOVmltnfafGj5RviIbpY0jToPGi0I7MtsET7N3pqdH1hnMn1/Gb81WwedvW95573bnU/XQp4ZhrntL4kunLl+6Qxrt8YRoqtmX9uue/9vTkj4bFfbCee834/jQU+9FwcF0jJ5LFJQrnBkVXEAI7rCieZ/DAygScGSstqBAnkmGBjaLVaA5nlZsxSMKFZAlEcml+Jb/A/HsedLTgEAAA==", "checkText"],
  [45, "gate-probe-r16--p0-wrap.ts:markdown_code#46; gate-r17-sec--r16-p0-wrap.ts:markdown_code#136; gate-r17-sec--r16-p0-wrap.ts:markdown_code#137; gate-r17-sec--r16-p0-wrap.ts:markdown_code#138", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSE3+VckyoptUrjxQER/Cm6u8XWCgkrbCkVFkUrovHdm+3NzORLZmYDcRyHMuUnbuYlz0RnL7OXLT+KnqHlK2tBm+7MzSpERJ8F306QqegosWxcK/8aJ2yqAn74jHYnWB+NpEcUoJIEuoVoX0L505z7axIoXImCrlPHP2/f9WIrCaKXJ23bWbJWZ8y5Lt6Cx8W83RNmX+js9Xkyb3cuugdi+5eDN1jOQqlmRkHhkBU1pLs0rv1R4zU4RvQ6+edu4P3/W1MaPDn1bppl2XAYyjiOQYO0Sh7KFLQbnERdHsHc3ODMi18BJvCkFElV70GDIpcCTP0eacCLompECuYm0kBWJ6FK0T36Ax4ssts/AQAA", "checkText"],
  [46, "gate-probe-r16--p0-wrap.ts:inline_code#47; gate-r17-sec--r16-p0-wrap.ts:inline_code#139; gate-r17-sec--r16-p0-wrap.ts:inline_code#140; gate-r17-sec--r16-p0-wrap.ts:inline_code#141", "private", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSE3+VckyoptUrjxQER/Cm6u11bqyQibLdUWBStiMZ3b7Y3M5MvmZkVbNL4FNtZEUvR2iv5so2PomMZ2cKZ0bo98WWJiBgy/u1xqaOnxXFxqf1rmLCxDvgRMtoeYXW0kg7RgCrCTQfRvazVT33uLgnXuBQ5XaZeeN6+m/lWEcQgS5qmNWeNyZh3nb3xx9m02RPmXujk9Xk0bXY++gfihpdD0JtP1krPDHjukQW1lD+3rt1BHdQ4RAxa2eeuF/z/O2PKn7xqN5ZS9vsbMCAtk4ciBeMGJ1EVR7BXNzjH+a8AG+KkEElZ7cGAPFMCbPMeGRDneVmLFOxVZIAqT0KXonv0B+KcM4k3AQAA", "checkText"],
  [47, "gate-probe-r16--p0-wrap.ts:py_triple#48; gate-r17-sec--r16-p0-wrap.ts:py_triple#142; gate-r17-sec--r16-p0-wrap.ts:py_triple#143; gate-r17-sec--r16-p0-wrap.ts:py_triple#144", "private", "private", "private", "H4sIAAAAAAAAAyWP3W6CQBCFX8XMNamSUqs0XgyI4B8I27W1ysUKW0pdFkUrovHdm21zkjknXzIzOWsYz93WoLUBpZSdmJkXLOPtvcxetuzIu4aWL60gqjtTNysREX1CvxyaqeioYdm4Uv45SshEBXz3SdQZY3U0km6oQCRDqluI9mUjv+tzbxVShUsuolXq+Oftmy62MkT08qRp2gvS6IQ41+CVPgazZh8S+xJN58/jWbNz0T2Etn85eP3FdCPVmSEVTriMDOkujGtvWHs1jhC9dv6x63t//61JRJ+cajfJsmww+O8KGqRl8lCkoN3gxKviCOb6BmcmfjiYwJKCJ2W1Bw1ELjmY+j3WgAlR1jwFcx1rIMsTV0vxPf4FqB+d4UcBAAA=", "checkText"],
  [48, "gate-probe-r16--p0-wrap.ts:rust_concat#49; gate-r17-sec--r16-p0-wrap.ts:rust_concat#145; gate-r17-sec--r16-p0-wrap.ts:rust_concat#146; gate-r17-sec--r16-p0-wrap.ts:rust_concat#147", "quiet", "private", "private", "H4sIAAAAAAAAA02O3W6CQBCFX2U7F02bkCoptYrxYkEE/1Cg2FrlApctpcKuAhXR+O7NmjTxZs7JOTNfZgWEs6JEw6mpovuizFEPEc5IWN49rBlCCK0hCstQTbIwpo0di7ubsKAtRUoW2sytmmMz5hhjbHv+t+HHwhpiaDpeCv0aEG8kDP6wPbc5xHmhkDVI//CWIzqXOb6sYawff6pDe+n4IuQ0dZeRYR8273K6YQ7GVkLqujH3atnzjNPsBvPmP88m9c7x9KM7nr4OJ/XWxObe0e3j3urMx4LX91PDWbgKM+fKqd2vrAoPMLYaN5jkc9uxrh9pI9d/MfLtKI7jXu+68tgFCSJOnrIIpDOUNM8KUFdnOITpLwUVQpJRwvMdSJAmjIIqXwIJwjTlFY1AXQUSMF5ScRRcgj+HHFu9ewEAAA==", "checkText"],
  [49, "gate-probe-r16--p0-wrap.ts:go_concat#50; gate-r17-sec--r16-p0-wrap.ts:go_concat#148; gate-r17-sec--r16-p0-wrap.ts:go_concat#149; gate-r17-sec--r16-p0-wrap.ts:go_concat#150", "quiet", "private", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/wqZa0mVlFql8TAggh9Fga6tFQ4rbLdUPhQRRON/b7YXLzNP3jfzZDZQ01JKMi4NpQBiWlEtyShnnX3OX7f0yHqqnKz0hdd0ZxYvEBEdn/yYhAs0xdANXIv9PY78qQD8dHyvO8HyqEYBSA9BHlQB9FxReblLFB3ROP82dX/tEhEWLPXWsenU2w8l3eYuop1EbdtZ+q3i++Zlcbe8k6fFvN27vnH2Zm8vk3m7s9A6uIZzPtiD5UzoRiQ13ZWn5tZSvfRHjd3gGNHu3C3J125g//+jTz3ybJa7Ked8OAwAZIiL6DGLQb5CxcrsCNrmCjVNTww0oFHGoqLcgwxpkjPQlFsoA03TomExaJtQhryomDgKb+EfjzK/ql0BAAA=", "checkText"],
  [50, "gate-probe-r16--p0-wrap.ts:java_concat#51; gate-probe-r16--p3-join.ts:java_lead_plus#13; gate-probe-r16--p3-join.ts:java_lead_plus#14; gate-r17-sec--r16-p0-wrap.ts:java_concat#151; gate-r17-sec--r16-p0-wrap.ts:java_concat#152; gate-r17-sec--r16-p0-wrap.ts:java_concat#153; gate-r17-sec--r16-p3-join.ts:java_lead_plus#13; gate-r17-sec--r16-p3-join.ts:java_lead_plus#14; gate-r17-sec--v3-p3-join.ts:java_lead_plus#19; gate-r17-sec--v3-p3-join.ts:java_lead_plus#20; gate-r17-sec--v3-p3-join.ts:java_lead_plus#21", "quiet", "quiet", "private", "H4sIAAAAAAAAA02OTW+CQBCG/8pmriVVU2oV42FABD+KwhZbKxwQtlsqLIpURON/b7YnLzNP3jfzZDZAqzIVnKQ5J0MSQBJVkZbmEWetveCDbXRkXVVJV/rCq9szixeIiA71v02fSzTl0A1cy/01julUAn441GtPsDyqcQCBIISQBxJA15WlJ1y/oyMa55/61Fu7vgwLlnnrxHRO2/dOthUuop3GTdNa0qZDqXlZ3Hve/KfFvNm71Dh7s9eXybzZWWgdXMM5H+z+ciaFIz8z3ZWnCmupXnqj2q5xjGi37j3p565v//+kTz3/2Sx3U875cBjAABRIivgxT0C5QsXK/Aja5gqnKPtloEEU5ywuyj0okKWCgda5hQpEWVbULAFtEyogiorJo/AW/gFyjqN5ZwEAAA==", "checkText"],
  [51, "gate-probe-r16--p0-wrap.ts:c_concat#52; gate-r17-sec--r16-p0-wrap.ts:c_concat#154; gate-r17-sec--r16-p0-wrap.ts:c_concat#155; gate-r17-sec--r16-p0-wrap.ts:c_concat#156", "quiet", "private", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/8pmjg2pJaVWMR4WRPCjKFBsrXBYl+1KhUWBimj878324mXmyftmnswGaCGqGtEdKdFDmnM0RBEkpCZ6mhPOOgfBB1tSsa6mpCtj4TdPM5sXGGPsBuHOCrlESw7DxGu5v8c0mErAn27gP01wWWk0gkgghFAEXU9WvvBC1cDYPP80p97aC2VYsMxfJ5Z72n6o2VZ4GDspbdvOMmjVILAui7vlPXxezNuDF5hnf/b2Opm3exvbR890z0env5xJ3SjMLG/la8JeapfeqHEaPMbY6dwt6de+7/z/Y0z98MUq91PO+XAYwQAUSAr6mCegXKFmZV6BvrnCiWS/DHQgNGe0KA+gQJYKBrp6ixUgWVY0LAF9EysgiprJo/gW/wGdR4SuZgEAAA==", "checkText"],
  [52, "gate-probe-r16--p0-wrap.ts:c_backslash_in_string#53; gate-r17-sec--r16-p0-wrap.ts:c_backslash_in_string#157; gate-r17-sec--r16-p0-wrap.ts:c_backslash_in_string#158; gate-r17-sec--r16-p0-wrap.ts:c_backslash_in_string#159", "private", "private", "private", "H4sIAAAAAAAAAx2O3W6CQBSEX8Wcy4bUklKrGC8OiOBPUaDYWuFiXbYrFRYFKqLx3Zvtzcxkkm8yW6CFqOoO3ZOy85DmvDPqRJCQmuhpTjjrHgUf7kjFepqSro2l3zzNbV4gIrpBuLdCLqMlxTBxI/17QoOZDPjpBv7TFMtKo1EUiZ4nS194oWogmpef5tzfeKEsC5b5m8Ryz7sPNdsJD9FJadt2V0GrBoF1XUr+PXxeLtqjF5gXf/72Ol20Bxvtk2e6l5MzWM3l0DjMLG/ta8Jeadf+uHEanCA6XcmnX4eB8//BmPnhi1UeZpzz0SiCISiQFPQxT0C5Qc3KvAJ9e4MzyX4Z6EBozmhRHkGBLBUMdPUeK0CyrGhYAvo2VkAUNZNQfI//AJqPpN1UAQAA", "checkText"],
  [125, "gate-probe-r16--p10-literals.ts:java_text#1; gate-r16--op16.mjs:OP1 java leading +#1; gate-r17-sec--r16-p10-literals.ts:java_text#1", "quiet", "quiet", "private", "H4sIAAAAAAAAA53LMQ6CMBgG0Ks032qjMRITSxyclIXFAYUylPYPkpRC2oImhLsbr+DwxlfhHn3nWhbYmUkYFZWI9Im70arOpY0KdEw43V7JvySkY4yxDZNoDmYqH1n7LPJYFvms3SVk15OXSMFhBr3tDfiCSL4PENWCWdmJIKB0T3rwIzhs5whiv9YcytrhTQaiqjncEOmX6rX+AvXMsv/WAAAA", "checkText"],
  [126, "gate-probe-r16--p10-literals.ts:php_text#2; gate-r16--op16.mjs:OP1 php trailing .#2; gate-r17-sec--r16-p10-literals.ts:php_text#2", "quiet", "quiet", "private", "H4sIAAAAAAAAA53LwQqCMBwH4FcZP4JdhhFJ0KRDp/Li1dJ2mO5PCXMTNy0Q3z16hQ7f8auxCezEuNFRy0ifuB2s7lzW6ECHVND1lf6Ls+ThGGOMN3szVbf8eS+LWJXF3LpzyC/HkWcQML5NegOxINLYB8h6waztRJDQbU+tHwcI2M4R5G5VAtpa/yYDWSsB5yP9klrVFx51erPMAAAA", "checkText"],
  [127, "gate-probe-r16--p10-literals.ts:short_tail_prose#3; gate-probe-r16--p3-join.ts:tail_short_text#41; gate-probe-r16--p3-join.ts:tail_short_text#42; gate-probe-r16--p5-quote.ts:tail76_prose#9; gate-r16--op16.mjs:OP5 short last line#11; gate-r17-sec--r16-p10-literals.ts:short_tail_prose#3; gate-r17-sec--r16-p3-join.ts:tail_short_text#41; gate-r17-sec--r16-p3-join.ts:tail_short_text#42; gate-r17-sec--r16-p5-quote.ts:tail76_prose#25; gate-r17-sec--r16-p5-quote.ts:tail76_prose#26; gate-r17-sec--r16-p5-quote.ts:tail76_prose#27; gate-r17-sec--v3-p3-join.ts:tail_short_text#61; gate-r17-sec--v3-p3-join.ts:tail_short_text#62; gate-r17-sec--v3-p3-join.ts:tail_short_text#63", "quiet", "quiet", "private", "H4sIAAAAAAAAA63LsQrCMBAG4Hf550MRikOc3ASha7Exw5kcWEgupT2rUPru4js4fOPnkdjYmXxsP2Ye9PTgWY4NyeXZ/Mtdb11rfdcuUc9XEFKNu5JAK0ymMsP5FQvnl8CBY5FYpxGEPKjAHbZA4JzrWxKcDwStJr8UtvAF3peM58AAAAA=", "checkText"],
  [128, "gate-probe-r16--p10-literals.ts:short_tail_json_lead#4; gate-probe-r16--p5-quote.ts:tail76_json_lead#8; gate-r17-sec--r16-p10-literals.ts:short_tail_json_lead#4; gate-r17-sec--r16-p5-quote.ts:tail76_json_lead#22; gate-r17-sec--r16-p5-quote.ts:tail76_json_lead#23; gate-r17-sec--r16-p5-quote.ts:tail76_json_lead#24", "quiet", "quiet", "private", "H4sIAAAAAAAAA63OvQrCMBSG4Vsp3xwUoTjEyU0QuhZNMhyTgxbyU5pYhZB7l96Dwzs+8CpUjZCfGrLTmKKfIneOCsnC37KfPU3x9KDMx17w5dX/K63jbRzKfRxWG89XjQYBl+wuOIiKwkvIkKpiJf9mSJANbNMyQ2B7hDw0I0Depw87SGUEYiq8IdPMDzILegXXAAAA", "checkText"],
  [129, "gate-probe-r16--p10-literals.ts:overjoin_prose#5; gate-probe-r16--p3-join.ts:clean_wrapped_then_prose#5; gate-probe-r16--p3-join.ts:clean_wrapped_then_prose#6; gate-r16--op16.mjs:call#12; gate-r17-sec--r16-p10-literals.ts:overjoin_prose#5; gate-r17-sec--r16-p3-join.ts:clean_wrapped_then_prose#5; gate-r17-sec--r16-p3-join.ts:clean_wrapped_then_prose#6; gate-r17-sec--v3-p3-join.ts:clean_wrapped_then_prose#7; gate-r17-sec--v3-p3-join.ts:clean_wrapped_then_prose#8; gate-r17-sec--v3-p3-join.ts:clean_wrapped_then_prose#9", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxWLwW6CQBQAf4W880ZLgo3dxsOjIgQTqygmFjg8YbtuXHYN0NLU+O9mLzNzmQIaGoirlqSY3ox8P1MvXgOmjuFnNr6sY2kRETf7/BLl0mXkEH7gyfm7NKt6n7pc5jraHbPAxNvgf74ckxFXiMlUfV3fkh1iaRDDNMtnUXdNpZSLRWkOFxo81Xvk+X++t93EE2DQ2HrSNsDuMIiu7YEXd/gl/SOAA9WtqG13AwZaGQHcf1QMSGs7igZ4UTEwdhBuqh7VE407CP/dAAAA", "checkText"],
  [130, "gate-probe-r16--p10-literals.ts:overjoin_yaml#6; gate-probe-r16--p3-join.ts:clean_wrapped_yaml_nextkey#7; gate-probe-r16--p3-join.ts:clean_wrapped_yaml_nextkey#8; gate-r17-sec--r16-p10-literals.ts:overjoin_yaml#6; gate-r17-sec--r16-p3-join.ts:clean_wrapped_yaml_nextkey#7; gate-r17-sec--r16-p3-join.ts:clean_wrapped_yaml_nextkey#8; gate-r17-sec--v3-p3-join.ts:clean_wrapped_yaml_nextkey#10; gate-r17-sec--v3-p3-join.ts:clean_wrapped_yaml_nextkey#11; gate-r17-sec--v3-p3-join.ts:clean_wrapped_yaml_nextkey#12", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxWLXUvDQBBF/0qY58UqRNGVPkxs2hBBbUoKmuRh3Izr0v0IaTRi6X8v+3LvuXBuA0YFL5OeJpLGkebF4PXjJx35LhVmn71W8/XzRgdExJdd/Z3XOmIeI3vC99hfrU+StdqVcaxqm2/3Veo3b+n//WouZlwjFgvzcXgotojRRczKqr7Nx0OptV4uW+/JsUz4j9xgufUgoA/qyvUgTjDx6I4gmxP8kv1hkEDKsQrjAAKs8Qzy5twJIGvDzD3IphPgw8Tx1J27C9kn2j7kAAAA", "checkText"],
  [131, "gate-probe-r16--p10-literals.ts:typo_curly#7; gate-probe-r16--p2b-docs.ts:text_curly#13; gate-probe-r16--p2b-docs.ts:text_curly#14; gate-r16--op16.mjs:OP3 curly quotes#8; gate-r17-sec--r16-p10-literals.ts:typo_curly#7; gate-r17-sec--r16-p2b-docs.ts:text_curly#13; gate-r17-sec--r16-p2b-docs.ts:text_curly#14; gate-r17-sec--v3-p2b-docs.ts:text_curly#19; gate-r17-sec--v3-p2b-docs.ts:text_curly#20; gate-r17-sec--v3-p2b-docs.ts:text_curly#21", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLTQrCMBAG0KuEbx0qiohGXHftRhcli2kzaiBNSjr+UQo9iF6uJxHf/lU4Zy+s5unjSMgIv2TRBfJxX1PPm7Wm8tTX5fbqVrt3XR4P8/RVPiq5sbp4Dq6AhktN0TroAcK57WGqAQ8Kd4YBNS03KXfQCD4yzHK0GhRCerKDqaxGTML/ZEf7A5/lHoqQAAAA", "checkText"],
  [132, "gate-probe-r16--p10-literals.ts:typo_emdash#8; gate-probe-r16--p2-docs.ts:emdash#1; gate-probe-r16--p2-docs.ts:emdash#2; gate-r17-sec--r16-p10-literals.ts:typo_emdash#8; gate-r17-sec--r16-p2-docs.ts:emdash#1; gate-r17-sec--r16-p2-docs.ts:emdash#2; gate-r17-sec--v3-p2-docs.ts:emdash#1; gate-r17-sec--v3-p2-docs.ts:emdash#2; gate-r17-sec--v3-p2-docs.ts:emdash#3", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LPQrCMBQA4KuEN4eqIA5x0qWDolLQpWR4Jo8ayE9JXu1QCh7CE3oS0fWDr4WduJxqYZFRXJujKIyZixgdP/6oXMCOFn3stncstFlLd9ufm3F5qLv0eb35QYKiSZasKK6LyEOmCiTYZKpgQU7AlEMB1U7wRD8QKEATyKTcgwTvIoFazVoCep9GsqBaLSEmpl/Ss/4CdwYqAaQAAAA=", "checkText"],
  [133, "gate-probe-r16--p10-literals.ts:typo_dashword#9; gate-probe-r16--p2-docs.ts:dash_suffix#21; gate-probe-r16--p2-docs.ts:dash_suffix#22; gate-r16--op16.mjs:OP3 -style#9; gate-r17-sec--r16-p10-literals.ts:typo_dashword#9; gate-r17-sec--r16-p2-docs.ts:dash_suffix#21; gate-r17-sec--r16-p2-docs.ts:dash_suffix#22; gate-r17-sec--v3-p2-docs.ts:dash_suffix#31; gate-r17-sec--v3-p2-docs.ts:dash_suffix#32; gate-r17-sec--v3-p2-docs.ts:dash_suffix#33", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ3xyrgjjEzcXBQRB0CRmuybUE8lN6o1VK3108+7G4CatAjUzM1PN6KP3hQcL7nY734+U6bc6nvq6kfROrYeRn/LCoWFRjadJBI1Tf5QA9o/GYBcbOeFN6MQzIZ/Z1HKCRYmGY7eI0KKU6cYCxTqPUxv/kFvcDJZcE/I0AAAA=", "checkText"],
  [134, "gate-probe-r16--p10-literals.ts:stray_quote#10; gate-probe-r16--p2-docs.ts:stray_quote2#37; gate-probe-r16--p2-docs.ts:stray_quote2#38; gate-r16--op16.mjs:OP4 stray quote#10; gate-r17-sec--r16-p10-literals.ts:stray_quote#10; gate-r17-sec--r16-p2-docs.ts:stray_quote2#37; gate-r17-sec--r16-p2-docs.ts:stray_quote2#38; gate-r17-sec--v3-p2-docs.ts:stray_quote2#55; gate-r17-sec--v3-p2-docs.ts:stray_quote2#56; gate-r17-sec--v3-p2-docs.ts:stray_quote2#57", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA3XMPQvCMBDG8a9y3OISKr4gGnEujiK41A7X5qSFJFeS0yridxd1dnzg9/wr3OskA8HijNC3Egs4MoMjJat81+ngqY/bhjKvlobKU27K9Q4oun/GzTePpjz8jHYczzFLYBiSZAbtSOEi3suYYey1g1GSy18cJPFvFmjQSVsEh+aJyilktNUTb+SvjBapDdxKGtCg7yOjnb1qg/SpskNb1QajKH9O9at+A1mpny3kAAAA", "checkText"],
  [163, "gate-probe-r16--p12-trunc.ts:wrapped_trunc_marker#1; gate-r17-sec--r16-p12-trunc.ts:wrapped_trunc_marker#1; gate-r17-sec--r16-p12-trunc.ts:wrapped_trunc_marker#2; gate-r17-sec--r16-p12-trunc.ts:wrapped_trunc_marker#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWL3QqCMBhA3+W7HqtAItbVZ/lDQT+KQugullsmzE3UEhLfPXZzzrk5BUgxCta0olarztT7pxjU1iNN7l+TaX2OaouIeEmzd5DVLgMH/4AP51dYpScXx0wH9zzxSmOim/fbHad4whAxppSWBghIW9FWAplhVH07ACtm+Ar9UcBAVK2qbN8BAd0YBWyzcAJCazspCazgBIwdlZv4wv+pUS8nswAAAA==", "checkText"],
  [164, "gate-probe-r16--p12-trunc.ts:wrapped_trunc_marker2#2; gate-r17-sec--r16-p12-trunc.ts:wrapped_trunc_marker2#4; gate-r17-sec--r16-p12-trunc.ts:wrapped_trunc_marker2#5; gate-r17-sec--r16-p12-trunc.ts:wrapped_trunc_marker2#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx2NywrCMBQF/+Wugw8oInEVtbUo+KhUkDbQmFxrIU1KGw0o/rvEzZzZHKaAqqpKo4QTtGlFjePO1IubGHAWkeayPGR+stvUljHG9uf8Eed10DhguWLXsPdEnrdB1rmOT5csKo3ZHKP3fO1TzxLG0sL1TyOFQ8VL8w8CAWXlqFVAPuCwbwegxQdeQj8RKAjZorR9BwR0YxDo9MsJCK2tRwW04ASMdRhO/Mt/4YQLPsUAAAA=", "checkText"],
  [179, "gate-probe-r16--p2-docs.ts:endash#3; gate-probe-r16--p2-docs.ts:endash#4; gate-r17-sec--r16-p2-docs.ts:endash#3; gate-r17-sec--r16-p2-docs.ts:endash#4; gate-r17-sec--v3-p2-docs.ts:endash#4; gate-r17-sec--v3-p2-docs.ts:endash#5; gate-r17-sec--v3-p2-docs.ts:endash#6", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LPQrCMBQA4KuEN4eqIA5x0qWDolLQpWR4Jo8ayE9JXu1QCt7BG3oS0fWDr4WduJxqYZFRXJujKIyZixgdP/6oXMCOFn3stncstFlLd9ufm3F5qLv0eb35QYKiSZasKK6LyEOmCiTYZKpgQU7AlEMB1U7wRD8QKEATyKTcgwTvIoFazVoCep9GsqBaLSEmpl/Ss/4C5VGEkqQAAAA=", "checkText"],
  [180, "gate-probe-r16--p2-docs.ts:curly_dq#5; gate-probe-r16--p2-docs.ts:curly_dq#6; gate-r17-sec--r16-p2-docs.ts:curly_dq#5; gate-r17-sec--r16-p2-docs.ts:curly_dq#6; gate-r17-sec--v3-p2-docs.ts:curly_dq#7; gate-r17-sec--v3-p2-docs.ts:curly_dq#8; gate-r17-sec--v3-p2-docs.ts:curly_dq#9", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LvQrCMBQG0FcJ3xyqgjjEzcXBQeigQ8lw21xrID8ljRYphT6IvlyfRHQ7y6lwTTazWOa3oUzKemp51YV2X1PPu620l8O5HNanYxuX+SMoGJHvLBL3WcTb33U0rwISJjaFN5AjMiffQ1UjnuQeDAVqPDcxdZBwNjDUZtIS5Fwc2EBVWiLEzL+kJ/0Fr2kPA5YAAAA=", "checkText"],
  [181, "gate-probe-r16--p2-docs.ts:curly_sq#7; gate-probe-r16--p2-docs.ts:curly_sq#8; gate-r17-sec--r16-p2-docs.ts:curly_sq#7; gate-r17-sec--r16-p2-docs.ts:curly_sq#8; gate-r17-sec--v3-p2-docs.ts:curly_sq#10; gate-r17-sec--v3-p2-docs.ts:curly_sq#11; gate-r17-sec--v3-p2-docs.ts:curly_sq#12", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LvQrCMBQG0FcJ3xyqgjjEzcXBQeigQ8lw21xrID8ljRYphT6Gvl6fRHQ7y6lwTTazWOa3oUzKemp51YV2X1PPu620l8O5HNanYxuX+SMoGJHvLBL3WcTb33U0rwISJjaFN5AjMiffQ1UjnuQeDAVqPDcxdZBwNjDUZtIS5Fwc2EBVWiLEzL+kJ/0FPn/lXZYAAAA=", "checkText"],
  [182, "gate-probe-r16--p2-docs.ts:guillemet#9; gate-probe-r16--p2-docs.ts:guillemet#10; gate-r17-sec--r16-p2-docs.ts:guillemet#9; gate-r17-sec--r16-p2-docs.ts:guillemet#10; gate-r17-sec--v3-p2-docs.ts:guillemet#13; gate-r17-sec--v3-p2-docs.ts:guillemet#14; gate-r17-sec--v3-p2-docs.ts:guillemet#15", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ3xyqgjjEzcXBQajgEjLcJpcYyE9pUzuUPpGP4NYnE89+NB72NXDoWGwfR5VUSOR512d/7mjk01GG5+Xezvvb1ZftK6bshOMsWh5rAwlXbJMc5ILKQxqh9II3xYmhQDaxLUMPiRgyQx1WI0ExlpkdlDYSuVT+J7OaH+XsweqLAAAA", "checkText"],
  [183, "gate-probe-r16--p2-docs.ts:german_quote#11; gate-probe-r16--p2-docs.ts:german_quote#12; gate-r17-sec--r16-p2-docs.ts:german_quote#11; gate-r17-sec--r16-p2-docs.ts:german_quote#12; gate-r17-sec--v3-p2-docs.ts:german_quote#16; gate-r17-sec--v3-p2-docs.ts:german_quote#17; gate-r17-sec--v3-p2-docs.ts:german_quote#18", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ3xyqgjjEzcXBQajgUjLcJpcayE9pUjuUQh9EfLg+iXj20+BhXgO7lsW2fi0VUi5Qx7s+dueWMp+O0j0v93ra365d2taPGKMVlqOoOZcKEjaZKljIGYWHkKGaGW/yI0OBTGCThh4S3kWGOixagrxPE1uoRkvEVPif9KJ/SW5WSI0AAAA=", "checkText"],
  [184, "gate-probe-r16--p2-docs.ts:nbsp#13; gate-probe-r16--p2-docs.ts:nbsp#14; gate-r17-sec--r16-p2-docs.ts:nbsp#13; gate-r17-sec--r16-p2-docs.ts:nbsp#14; gate-r17-sec--v3-p2-docs.ts:nbsp#19; gate-r17-sec--v3-p2-docs.ts:nbsp#20; gate-r17-sec--v3-p2-docs.ts:nbsp#21", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLMQrCMBQG4KuEfw5VQRzi5tJBUBFxKRlem2cNJE1JYmspvYtn8WTit38Vbk8WfeSHfQtDmZT11PKq79p9TYl3W2nvh/N1XB/LNnw/KVPMSfDAcRKXUynqYKYCEiY0hTeQMzJHn6CqGQO5F0OBGs9NiD0knO0YarNoCXIujGygKi3Rhcz/pBf9A2s8U+WTAAAA", "checkText"],
  [185, "gate-probe-r16--p2-docs.ts:arrow#15; gate-probe-r16--p2-docs.ts:arrow#16; gate-r17-sec--r16-p2-docs.ts:arrow#15; gate-r17-sec--r16-p2-docs.ts:arrow#16; gate-r17-sec--v3-p2-docs.ts:arrow#22; gate-r17-sec--v3-p2-docs.ts:arrow#23; gate-r17-sec--v3-p2-docs.ts:arrow#24", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA4tWSkksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/Pf9Q2SSFRIcDPXUlHKSU/WS83RUmnWqkktSi3WMkqulqpLDGnNFXJSikxOTc1Ob+oQElHKSczL1XJyrA2VkcpMScnvzw1RckqOlZHKS+/JBWkKbY2FgDXp4zYeQAAAA==", "checkText"],
  [186, "gate-probe-r16--p2-docs.ts:cjk_paren#17; gate-probe-r16--p2-docs.ts:cjk_paren#18; gate-r17-sec--r16-p2-docs.ts:cjk_paren#17; gate-r17-sec--r16-p2-docs.ts:cjk_paren#18; gate-r17-sec--v3-p2-docs.ts:cjk_paren#25; gate-r17-sec--v3-p2-docs.ts:cjk_paren#26; gate-r17-sec--v3-p2-docs.ts:cjk_paren#27", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA4tWCvBzV3jcuO5pa8fLBWsfN65XSEksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/Pf7+n4/neTU8n9L7f0/m4cfnjxpmPG5oUglNTFYLcnBWMjC3N9ZR0lFLyk/VyU5R0qpVKUotyi5WsoquVyhJzSlOVrJQSk3NTk/OLCpR0lHIy81KVrAxrY3WUEnNy8stTU5SsomN1lPLyS1JBmmJrYwHM4T7IpAAAAA==", "checkText"],
  [187, "gate-probe-r16--p2-docs.ts:cjk_comma#19; gate-probe-r16--p2-docs.ts:cjk_comma#20; gate-r17-sec--r16-p2-docs.ts:cjk_comma#19; gate-r17-sec--r16-p2-docs.ts:cjk_comma#20; gate-r17-sec--v3-p2-docs.ts:cjk_comma#28; gate-r17-sec--v3-p2-docs.ts:cjk_comma#29; gate-r17-sec--v3-p2-docs.ts:cjk_comma#30", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA4tWCvBzV3g+q+XpnoanS7Y8m7FeISWxJNEqMzcxPVW/IC/dOimxONXMRCczzMk/qNzA2z09//2enqcT+l7OXQRS7enhEqSQnFGal/24oUlJRyklP1kvN0VJp1qpJLUot1jJKrpaqSwxpzRVyUopMTk3NTm/qEBJRyknMy9VycqwNlZHKTEnJ788NUXJKjpWRykvvyQVpCm2NhYAlU0RU5sAAAA=", "checkText"],
  [188, "gate-probe-r16--p2-docs.ts:underscore#23; gate-probe-r16--p2-docs.ts:underscore#24; gate-r17-sec--r16-p2-docs.ts:underscore#23; gate-r17-sec--r16-p2-docs.ts:underscore#24; gate-r17-sec--v3-p2-docs.ts:underscore#34; gate-r17-sec--v3-p2-docs.ts:underscore#35; gate-r17-sec--v3-p2-docs.ts:underscore#36", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ3xyqgjjETVARB6WICCXINbm2gfyUJtqh9N3Fs58Gt46FSTEXikVYKqRcoJYXfWy3L8q8WUt3313qcXk+tul5rfeH00O4LCy/XWQrOh64goRNpgoWckLhIWSoZsKX/IehQCawSUMPCe8iQ61mLUHep5EtVKMlYir8T3rWPxduVMKVAAAA", "checkText"],
  [189, "gate-probe-r16--p2-docs.ts:dash_bullet#25; gate-probe-r16--p2-docs.ts:dash_bullet#26; gate-r17-sec--r16-p2-docs.ts:dash_bullet#25; gate-r17-sec--r16-p2-docs.ts:dash_bullet#26; gate-r17-sec--v3-p2-docs.ts:dash_bullet#37; gate-r17-sec--v3-p2-docs.ts:dash_bullet#38; gate-r17-sec--v3-p2-docs.ts:dash_bullet#39", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4FcJ/xxvIA5xc+kgqDi4hAzH5BADuZQktUPpu4vf/mk46qRCIs+7MfvzmxqfjjK8LvfnvL8OvoiN6B8Wj9sgWvCZ+lQZEq7YbXKQCzrX1KD0gi/FiaFANrEtdYREDJmhDquRoBjLzA5KG4lcOv+TWc0PMr9oU4QAAAA=", "checkText"],
  [190, "gate-probe-r16--p2-docs.ts:ellipsis_ascii#27; gate-probe-r16--p2-docs.ts:ellipsis_ascii#28; gate-r17-sec--r16-p2-docs.ts:ellipsis_ascii#27; gate-r17-sec--r16-p2-docs.ts:ellipsis_ascii#28; gate-r17-sec--v3-p2-docs.ts:ellipsis_ascii#40; gate-r17-sec--v3-p2-docs.ts:ellipsis_ascii#41; gate-r17-sec--v3-p2-docs.ts:ellipsis_ascii#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FeRb1K4RAVxiJuLQwfBwSVkuCaXEMhPSVM7lL67ePZj4LmzjpmDHMcSbh+e5Hqh+L4/X8tpeISqlNrte5uL4y7+AIKvTmUPWtGl5QnarPhymgUa7LK42kYQUiwCfd4sgVOqi3hoYwmldvknu9kfJlbI9n8AAAA=", "checkText"],
  [191, "gate-probe-r16--p2-docs.ts:ellipsis#29; gate-probe-r16--p2-docs.ts:ellipsis#30; gate-r17-sec--r16-p2-docs.ts:ellipsis#29; gate-r17-sec--r16-p2-docs.ts:ellipsis#30; gate-r17-sec--v3-p2-docs.ts:ellipsis#43; gate-r17-sec--v3-p2-docs.ts:ellipsis#44; gate-r17-sec--v3-p2-docs.ts:ellipsis#45", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLOwoCMRQF0K3IrRQefkAsYmdjMYVgYRNSPJNHCOQzZDJOMQy4GhfmSsTTHw3HjVVI7GXXZ39+8iCnI4XH5Xaf9t3Vl+/7s1q3OmbLTdwGBFfsNjnQjCY1DVB6xovjKFBgm8SW2oMQQxaow2IIHGOZxEFpQ8ilyT+ZxfwAWxd7tH8AAAA=", "checkText"],
  [192, "gate-probe-r16--p2-docs.ts:table#31; gate-probe-r16--p2-docs.ts:table#32; gate-r17-sec--r16-p2-docs.ts:table#31; gate-r17-sec--r16-p2-docs.ts:table#32; gate-r17-sec--v3-p2-docs.ts:table#46; gate-r17-sec--v3-p2-docs.ts:table#47; gate-r17-sec--v3-p2-docs.ts:table#48", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4FcJ/xy8gDjEzaWDoOLgEjIcm0MI5FKS1A5N31389k+ji+d9EF1YaqR8JMf7KbnLhyqfT9K/r4/XcrgNLosuqneJ2lxYdEjYPO6ihVzRuMQKpVd8KcwMBRojj7lMkAg+MdRxMxIUQl7YQmkjkXLjfzKb+QGgaxH0hgAAAA==", "checkText"],
  [193, "gate-probe-r16--p2-docs.ts:long_doc_prefix#33; gate-probe-r16--p2-docs.ts:long_doc_prefix#34; gate-r17-sec--r16-p2-docs.ts:long_doc_prefix#33; gate-r17-sec--r16-p2-docs.ts:long_doc_prefix#34; gate-r17-sec--v3-p2-docs.ts:long_doc_prefix#49; gate-r17-sec--v3-p2-docs.ts:long_doc_prefix#50; gate-r17-sec--v3-p2-docs.ts:long_doc_prefix#51", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx2LQQuCMBhA/4p851Ea5WHhYZYJBlaKQYiHpV9T3FyoZSD991iX997l5VDxkdNGcYHLZye2dz6guybN1T8lk30MhWaMsTjN6iATJgMDf8duxo9DmUYm9pkMLtdkvVJxezvXj/3EdvUUMtdGt/1/fpRkm6BvIyGE51nNYHHL+TjWOQ4XQKDS5UJVQGYYsVcD0HyGN5cvBAq8VFjq/gkEZNMhUOdbEOBS6gkroHlBoNMjmqn4Fj8pGE1v0wAAAA==", "checkText"],
  [194, "gate-probe-r16--p2-docs.ts:stray_quote#35; gate-probe-r16--p2-docs.ts:stray_quote#36; gate-r17-sec--r16-p2-docs.ts:stray_quote#35; gate-r17-sec--r16-p2-docs.ts:stray_quote#36; gate-r17-sec--v3-p2-docs.ts:stray_quote#52; gate-r17-sec--v3-p2-docs.ts:stray_quote#53; gate-r17-sec--v3-p2-docs.ts:stray_quote#54", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA2XNywrCMBBA0V8ZZh18gLqIq4hYRPCFuqldxGTaBpKMNNUi4r+Lgiv393BzPNQE4zNCMg1RhFRzl8AZjql3jsdEYHWrpQu6ov41VtOLTjQZCXeabfbdYJVVDCU3sF1n/33lyl+/H/hsM/e12qmZWiqltl+WLRdQOk8JXISg4wMsm88ZBVo2vWBRPLGlJiSU+RPv2t8IJWoTyHBzRYHeRUI5fBUCtffckUWZFwIjt/RBxat4A7RMayLmAAAA", "checkText"],
  [195, "gate-probe-r16--p2-docs.ts:wrapped_doc_then_prose#39; gate-probe-r16--p2-docs.ts:wrapped_doc_then_prose#40; gate-r17-sec--r16-p2-docs.ts:wrapped_doc_then_prose#39; gate-r17-sec--r16-p2-docs.ts:wrapped_doc_then_prose#40; gate-r17-sec--v3-p2-docs.ts:wrapped_doc_then_prose#58; gate-r17-sec--v3-p2-docs.ts:wrapped_doc_then_prose#59; gate-r17-sec--v3-p2-docs.ts:wrapped_doc_then_prose#60", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAyXMOwvCMBiF4b9Svjl4geIQp1SroKDY0oLUDDGJaSCX0lQzSP+7BJfDs5y3A8EmhrVlSi4Hp7ZPFuQmR7otrlVcnY/KE0LIpW76slGJZZri4XbknvQ68PqUsG9MeWurPNMh633M/qEsjmwIgEB4vrAC0BcmOdoAuPvCh5m3BAyMW8n9OAACo50EvJ4pAmaMj1IA7igC5yeZTnSmP4M23FOzAAAA", "checkText"],
  [196, "gate-probe-r16--p2-docs.ts:doc_prefix_nl_word#41; gate-probe-r16--p2-docs.ts:doc_prefix_nl_word#42; gate-r17-er--a1.ts:nl_camel_only#16; gate-r17-er--a1.ts:nl_camel_only#17; gate-r17-er--a1.ts:nl_camel_only#18; gate-r17-er--cx17.ts:F4_letters#22; gate-r17-er--cx17.ts:F4_letters#23; gate-r17-er--cx17.ts:F4_letters#24; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_word#41; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_word#42; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_word#61; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_word#62; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_word#63", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4Hf55+AFxCFuLiKCgi061AzH5NAGcinNqRVK31389q+BIyHtI7W87lN7eFPh/U75x/F2nzaXU5tfqe58OZe64yt/peIknCw/vXR5lKonywUKLttVdFAzhIdYoJsZHwojQ4NsZJuHHgrBJ4beLkaBQsgTO+jGKKQs/E9mMT8ZV9nflAAAAA==", "checkText"],
  [197, "gate-probe-r16--p2-docs.ts:doc_prefix_nl_code#43; gate-probe-r16--p2-docs.ts:doc_prefix_nl_code#44; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_code#43; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_code#44; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_code#64; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_code#65; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_code#66", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLsQrCMBQF0H+5k0KoCuIQNxGkOAgOLjHDM3mEQJJXmmiH0n+Xnv0YeGqkY6bAu6GE84cqn44qvi6P57S/34K8i5NSJXGXJGy4OPHs+zVcqdEWCl5clz3UjMZjrtBmxo/Sl6FBLrOTcYBCioWhD4tVoJRkYg9trEKRxmuyi/0DMtJzgo8AAAA=", "checkText"],
  [198, "gate-probe-r16--p2-docs.ts:doc_prefix_nl_identifier#45; gate-probe-r16--p2-docs.ts:doc_prefix_nl_identifier#46; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_identifier#45; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_identifier#46; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_identifier#67; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_identifier#68; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_identifier#69", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBAA4FcpNwd/QBxSXBzq4KAouNRAz+QIgeSuJKkdSt9d/Pavh8FhRR0SetqO7NsPFjoeVHidb495d714Gd5shUttiK04cs/gGeuUqZN8Z9+FSKU5NfsWFDixm+RALVAppwK6X+CLcSLQgDaRlTyCghiYQO9XowBjlJkc6N4oYKn0T2Y1P+UNmSeaAAAA", "checkText"],
  [199, "gate-probe-r16--p2-docs.ts:doc_prefix_nl_url#47; gate-probe-r16--p2-docs.ts:doc_prefix_nl_url#48; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_url#47; gate-r17-sec--r16-p2-docs.ts:doc_prefix_nl_url#48; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_url#70; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_url#71; gate-r17-sec--v3-p2-docs.ts:doc_prefix_nl_url#72", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLsQrCMBAA0H+5OTYK4hA3FxEHoVIdaoZrcsRAkgtNbMHSfxff/nqwWFH5iI5kTu44YKHDXvjH6dbO2+vZ8Su9a81FSWlposCZxiby14eADY9OUtp0d2nZFPmkQXbtBQRYNk20IBaoNMYCql9gwvAhUIAmkuExg4DgE4HarVoAhsAzWVC9FpC40j/pVf8A9cXUyqIAAAA=", "checkText"],
  [200, "gate-probe-r16--p2-docs.ts:md_list_examples#49; gate-probe-r16--p2-docs.ts:md_list_examples#50; gate-r17-sec--r16-p2-docs.ts:md_list_examples#49; gate-r17-sec--r16-p2-docs.ts:md_list_examples#50; gate-r17-sec--v3-p2-docs.ts:md_list_examples#73; gate-r17-sec--v3-p2-docs.ts:md_list_examples#74; gate-r17-sec--v3-p2-docs.ts:md_list_examples#75", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA13LywqCQBQA0F+Ju56yQIKm1ZVAqoVp0CKdxaS3SZuHqOVC/PdoUVD7c1KYTgrZSV4aqcirrVpfZEtLn5WnIEr6+T5ULrM/qKrpq7xV5fmI8fF+3iUKA4z/sCqvH5vMdRht9A1jDHCLiIfMAoPC5TNTABugo8a0wNMBnlI/CDjI3FDumhoY6NIS8MUoGEitXU8F8FQwsK6jdxKjeAFpY/UazQAAAA==", "checkText"],
  [201, "gate-probe-r16--p2-docs.ts:md_list_examples_nodash#51; gate-probe-r16--p2-docs.ts:md_list_examples_nodash#52; gate-r17-sec--r16-p2-docs.ts:md_list_examples_nodash#51; gate-r17-sec--r16-p2-docs.ts:md_list_examples_nodash#52; gate-r17-sec--v3-p2-docs.ts:md_list_examples_nodash#76; gate-r17-sec--v3-p2-docs.ts:md_list_examples_nodash#77; gate-r17-sec--v3-p2-docs.ts:md_list_examples_nodash#78", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA1XLywqCQBQA0H+56yENImhaXQmkWpgGLVIXk3ObxuYharkQ/z1aFLU/JwcpesG1FYqCxqn1RXS0XDB9ipJsCPex8oX7IXVDXxOs6mCBmB7v512mMML0jyp9/cgsNHGyMTdMMcItIh4KBwykr2ZWAhuhp9Z2wPMRnsI8CDiIylLl2wYYGO0I+HwqGQhj/EASeF4ycL6ndyqn8gVA2BbCxwAAAA==", "checkText"],
  [202, "gate-probe-r16--p2-docs.ts:yaml_two_keys#53; gate-probe-r16--p2-docs.ts:yaml_two_keys#54; gate-r17-sec--r16-p2-docs.ts:yaml_two_keys#53; gate-r17-sec--r16-p2-docs.ts:yaml_two_keys#54; gate-r17-sec--v3-p2-docs.ts:yaml_two_keys#79; gate-r17-sec--v3-p2-docs.ts:yaml_two_keys#80; gate-r17-sec--v3-p2-docs.ts:yaml_two_keys#81", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQqDMBAA4FeRm0N/oHRIp9ahlA5CKS6a4TTXNJBcgolaEN+9uH9fA5GNLDRmlNajoX1kc+kw0fkkbH2rXvPheTehZfpFh4zZBq4+7y9duzBRjW6kB5foyZWYSBZ5GKllEKBDv/MaxAKZBp9ANgtMGwcJ2HvqwxBBgLNMII+rEoDOhZk0yEYJ4JBpS2pVf15G1TmkAAAA", "checkText"],
  [203, "gate-probe-r16--p2-docs.ts:yaml_two_keys_nocolon#55; gate-probe-r16--p2-docs.ts:yaml_two_keys_nocolon#56; gate-r17-sec--r16-p2-docs.ts:yaml_two_keys_nocolon#55; gate-r17-sec--r16-p2-docs.ts:yaml_two_keys_nocolon#56; gate-r17-sec--v3-p2-docs.ts:yaml_two_keys_nocolon#82; gate-r17-sec--v3-p2-docs.ts:yaml_two_keys_nocolon#83; gate-r17-sec--v3-p2-docs.ts:yaml_two_keys_nocolon#84", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Fcp3xz8AXGIky5SFAQRHdoO1+aSFpJ7SxrtUPru4tlPhUG8LRxlsn0kz+tB/OFNI+93pn+ebvdpczl7raUojqK541SKY8nsXprco6NcjlcVXwsMnLar6GBmZE5xhK1mfCl8GBbURm41DTAIvTDsdmkMKASd2MFWjYFo5n9qluYH1Pv1TpgAAAA=", "checkText"],
  [204, "gate-probe-r16--p2-docs.ts:heading_after#57; gate-probe-r16--p2-docs.ts:heading_after#58; gate-r17-sec--r16-p2-docs.ts:heading_after#57; gate-r17-sec--r16-p2-docs.ts:heading_after#58; gate-r17-sec--v3-p2-docs.ts:heading_after#85; gate-r17-sec--v3-p2-docs.ts:heading_after#86; gate-r17-sec--v3-p2-docs.ts:heading_after#87", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Hf55uAPiEPcBOkgWFFwaTNck0sIJDehTa1Q+u7i2U8HR5V0SOR5W8Sf3jTy8aDC69w+5t218bmXXu635hm8UJ0GvnxLJKEaskDBZbtJDmpB5SGN0N2CD8WJoUE2sc1DgUIMwtD71ShQjHlmB90ZBcmV/8ms5gc2hakSiwAAAA==", "checkText"],
  [205, "gate-probe-r16--p2-docs.ts:prefix_then_hex#59; gate-probe-r16--p2-docs.ts:prefix_then_hex#60; gate-r17-sec--r16-p2-docs.ts:prefix_then_hex#59; gate-r17-sec--r16-p2-docs.ts:prefix_then_hex#60; gate-r17-sec--v3-p2-docs.ts:prefix_then_hex#88; gate-r17-sec--v3-p2-docs.ts:prefix_then_hex#89; gate-r17-sec--v3-p2-docs.ts:prefix_then_hex#90", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4FcJ/xw0hXqLWxcHB8HBpWY4Noc2kEtpohVK31389q+FpULaBep5O8b+/KLM+1q6R3O7z+p66dMzHk87VXN9UFZRRYqEy6IMLDIFFi6Kgb+QsKnbBAu5oPAUMnS74EP+zdCgLnCXphES3kWGrlYjQd6nmS10ayRiKvxPZjU/jRQ+zJUAAAA=", "checkText"],
  [206, "gate-probe-r16--p2b-docs.ts:clean_plain#1; gate-probe-r16--p2b-docs.ts:clean_plain#2; gate-r17-sec--r16-p2b-docs.ts:clean_plain#1; gate-r17-sec--r16-p2b-docs.ts:clean_plain#2; gate-r17-sec--v3-p2b-docs.ts:clean_plain#1; gate-r17-sec--v3-p2b-docs.ts:clean_plain#2; gate-r17-sec--v3-p2b-docs.ts:clean_plain#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx2LwYrCMBQAf6W8c9AV6rJGPMS1WirsaiUFLT28TZ6xmDal7VpQ/HeJl5m5TA6yo0Bjj7ys0NC4qc38Dzv6DFmZLX/T4WO7MU4IIX4O8hJJ4zPyWH6Lo/d5rQ6Jj5W00T5Lw3qzC+9fqyEexFqIeFyerrN4/16SVE6j9poYYxaLALsAg8aioouzmtoRMNBOjSoN7AE9tVUHPH/ADe0/AQdUFSnXNsDAljUBnzwLBmitG0gDzwsGtevJT8WzeAEzXUwP2wAAAA==", "checkText"],
  [207, "gate-probe-r16--p2b-docs.ts:clean_emdash#3; gate-probe-r16--p2b-docs.ts:clean_emdash#4; gate-r17-sec--r16-p2b-docs.ts:clean_emdash#3; gate-r17-sec--r16-p2b-docs.ts:clean_emdash#4; gate-r17-sec--v3-p2b-docs.ts:clean_emdash#4; gate-r17-sec--v3-p2b-docs.ts:clean_emdash#5; gate-r17-sec--v3-p2b-docs.ts:clean_emdash#6", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx2LTarCMBgAr1K+dVALfaIRF/FZLRX8qUTwlS7y2s8YTJvSViuK4CE8oSeRuJmZzcTAa3Qy0QiqciGxWxZy9C9q7HtE7SarqO0t5tIwxthyy48+lzZ9i8kv21sfZuk2tDHl2t/sIq+Yr73bYNoGLZsxFnTV32kYbL5LGPEfvzqFUsrx+P18Cce9uk6prqg7QCAzaSfPgNyhwSqvgcZ3uAh9RqAg0hxTU5VAQKsCgbqPhIDQ2rSYAY0TAoVp0E7JI/kASg7UctgAAAA=", "checkText"],
  [208, "gate-probe-r16--p2b-docs.ts:clean_curly#5; gate-probe-r16--p2b-docs.ts:clean_curly#6; gate-r17-sec--r16-p2b-docs.ts:clean_curly#5; gate-r17-sec--r16-p2b-docs.ts:clean_curly#6; gate-r17-sec--v3-p2b-docs.ts:clean_curly#7; gate-r17-sec--v3-p2b-docs.ts:clean_curly#8; gate-r17-sec--v3-p2b-docs.ts:clean_curly#9", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx2L0WrCMBRAf6Xc56ATOnEZPsRZLR3orETQ0oe75C4W06a03QoTwQ/Rn/NLRvZyznk5GciWgsf1prFDXpRoaFhX5vUTWxqHrNjN1mn/9L40TgghVlt5jKTxGXnM3sTe+2uhtomPubTRZpeG1fIj/J3M+7gXCyHiYXE4vcSb/yVJ5XPUnBJjzHT6uN4DbAMMaouKjs5qagbAQDs1KDWwM3TUlC3w7Aw/aL8JOKAqSbmmBga2qAj46JIzQGtdTxp4ljOoXEd+yi/5H2J6YvHhAAAA", "checkText"],
  [209, "gate-probe-r16--p2b-docs.ts:clean_curly_single#7; gate-probe-r16--p2b-docs.ts:clean_curly_single#8; gate-r17-sec--r16-p2b-docs.ts:clean_curly_single#7; gate-r17-sec--r16-p2b-docs.ts:clean_curly_single#8; gate-r17-sec--v3-p2b-docs.ts:clean_curly_single#10; gate-r17-sec--v3-p2b-docs.ts:clean_curly_single#11; gate-r17-sec--v3-p2b-docs.ts:clean_curly_single#12", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx2LzYrCMBgAX6V856ArdEUjHqJWSwV/KhF2Sw+x/TYG00TarAVF8DH09XySJXuZmctkwBsM3o9nKZygqhISu2cjRwfRYD8kaj9Zp+3HciEtY4ytdvwYcekz8phM2Zf3z7zYJT5mXEfbfRqaxSa8DmZt3LI5Y3FXfZ+G8fZ/SVL+GdWnREo5Hr8fr0CZwB0xcNi4DhAobdGpSiA3cFhXDdDsBhehfxEoiKLCwtZnIKCVQaC9e05AaG1bLIFmOQFjHfopv+d/JH9lS9wAAAA=", "checkText"],
  [210, "gate-probe-r16--p2b-docs.ts:clean_cjk#9; gate-probe-r16--p2b-docs.ts:clean_cjk#10; gate-r17-sec--r16-p2b-docs.ts:clean_cjk#9; gate-r17-sec--r16-p2b-docs.ts:clean_cjk#10; gate-r17-sec--v3-p2b-docs.ts:clean_cjk#13; gate-r17-sec--v3-p2b-docs.ts:clean_cjk#14; gate-r17-sec--v3-p2b-docs.ts:clean_cjk#15", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA4tWerJ3//MpKxRSEksSrTJzE9NT9Qvy0q2TEotTzUx0MsOc/IPKDbzd0/MdHR0d/YJDM1xD00FMVxDh5OwYCaLT3JKDvUAMl9Ac18CwIJM89wCTKguXco9yRzdHRw/9zKhsS49AsBavoFBT16Jsr/T0dFvb93t6nuyd82THLoWCnMTk1Iz8nJTUIoWns/c972x/3NCkpKOUkp+sl5uipFOtVJJalFusZBVdrVSWmFOaqmSllJicm5qcX1SgpKOUk5mXqmRlWBuro5SYk5NfnpqiZBUdq6OUl1+SCtIUWxsLAGIU4BvrAAAA", "checkText"],
  [211, "gate-probe-r16--p2b-docs.ts:clean_nbsp#11; gate-probe-r16--p2b-docs.ts:clean_nbsp#12; gate-r17-sec--r16-p2b-docs.ts:clean_nbsp#11; gate-r17-sec--r16-p2b-docs.ts:clean_nbsp#12; gate-r17-sec--v3-p2b-docs.ts:clean_nbsp#16; gate-r17-sec--v3-p2b-docs.ts:clean_nbsp#17; gate-r17-sec--v3-p2b-docs.ts:clean_nbsp#18", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx2L0WrCMBRAf6Xc56AbdGNGfIizWjpwWknBlT7cJXexmDalrRYU/8Vv2ZdJfDnnvJwcZEeBxh55WaGhcVOb6S929B6yMpt/p8PL18o4IYRY7+QhksZn5DH/FHvvv6XaJT4W0kbbLA3r1Sa8fCyGeBBLIeJx+XOcxNvnkqTyLWqPiTFmNvu/Yxdg0FhUdHBWUzsCBtqpUaWBXaGntuqA51c4oz0RcEBVkXJtAwxsWRPw11vBAK11A2ngecGgdj35qbgVD4FWTQjcAAAA", "checkText"],
  [212, "gate-probe-r16--p2b-docs.ts:text_emdash#15; gate-probe-r16--p2b-docs.ts:text_emdash#16; gate-r17-sec--r16-p2b-docs.ts:text_emdash#15; gate-r17-sec--r16-p2b-docs.ts:text_emdash#16; gate-r17-sec--v3-p2b-docs.ts:text_emdash#22; gate-r17-sec--v3-p2b-docs.ts:text_emdash#23; gate-r17-sec--v3-p2b-docs.ts:text_emdash#24", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3NQQqCQBQA0KsMfz0YRURNtHYtRBuZxXf+J4XvjDhTJiJ4CE/oSaIO8Hgl3GtWb5QXK8KEJvEn7TrBxl8rjHw6aswfscrPTzpcxiovbtuy1iwS1BB6oW1ZiV0gjsoJo5cxAw0UXNYS6AkS920EU07wT8AAupZd6DvQII1nMPvZakCRMDCBKa0GHxL/kJ3tF8/rfWqhAAAA", "checkText"],
  [213, "gate-probe-r16--p2c-docs.ts:quoted_spaced_emdash#1; gate-probe-r16--p2c-docs.ts:quoted_spaced_emdash#2; gate-r17-sec--r16-p2c-docs.ts:quoted_spaced_emdash#1; gate-r17-sec--r16-p2c-docs.ts:quoted_spaced_emdash#2; gate-r17-sec--v3-p2c-docs.ts:quoted_spaced_emdash#1; gate-r17-sec--v3-p2c-docs.ts:quoted_spaced_emdash#2; gate-r17-sec--v3-p2c-docs.ts:quoted_spaced_emdash#3", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4Fcp/xy8gDjEzcXBQejgkmY4JocYyKUkqR1KwYfwCX0S8ds/hQGWGkkfyfF2TO70oMrHg/D3862fd9eLy933/enak7vqXaI2FR4AAZvNJlqIBY1LrJBqwYvCxJAgE9nkMkIg+MSQ+1ULUAh5ZguptEDKjf9Jr/oHLgX1ZYYAAAA=", "checkText"],
  [214, "gate-probe-r16--p2c-docs.ts:quoted_words#3; gate-probe-r16--p2c-docs.ts:quoted_words#4; gate-r17-sec--r16-p2c-docs.ts:quoted_words#3; gate-r17-sec--r16-p2c-docs.ts:quoted_words#4; gate-r17-sec--v3-p2c-docs.ts:quoted_words#4; gate-r17-sec--v3-p2c-docs.ts:quoted_words#5; gate-r17-sec--v3-p2c-docs.ts:quoted_words#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Fcp33zxB8Qhbi4ODoKDS5rhmlxCIMktTbRD6buLZz8WIwJ3NqlwlP1U4+XNTc4nSq/r47kc7reoA9cwNB20jgAhqN+VAFrRZS4Nxq74cv4IDNgX8TpPIORUBea4OQLnrIsEGOsIVbv8k9vcD9Avs0d+AAAA", "checkText"],
  [215, "gate-probe-r16--p2c-docs.ts:b64url_jpeg_img#5; gate-probe-r16--p2c-docs.ts:b64url_jpeg_img#6; gate-r17-sec--r16-p2c-docs.ts:b64url_jpeg_img#5; gate-r17-sec--r16-p2c-docs.ts:b64url_jpeg_img#6; gate-r17-sec--v3-p2c-docs.ts:b64url_jpeg_img#7; gate-r17-sec--v3-p2c-docs.ts:b64url_jpeg_img#8; gate-r17-sec--v3-p2c-docs.ts:b64url_jpeg_img#9", "quiet", "refusal", "private", "H4sIAAAAAAAAAxXLTQuCMBwH4K8Sv/MoQhFcL7BjIEJ10DSRuf1ZinPiWwfxu0fP/clxrq3ZjYO6vKHlJHltpaFD05M5VXKkwGdl2JT+XbhH+ukzI0Tl6TlLb+aVxFOWxIvqhIk8s9AzDCJPzVHtz9FSZm9cwaCd2lsNtmKiwY7g+YpFtjOBQypLyg09GNq6I/DjVjDItnVf0uB5wdC5if6p2Iof8hlqBqwAAAA=", "checkText"],
  [216, "gate-probe-r16--p2c-docs.ts:iv_dash#7; gate-probe-r16--p2c-docs.ts:iv_dash#8; gate-r17-sec--r16-p2c-docs.ts:iv_dash#7; gate-r17-sec--r16-p2c-docs.ts:iv_dash#8; gate-r17-sec--v3-p2c-docs.ts:iv_dash#10; gate-r17-sec--v3-p2c-docs.ts:iv_dash#11; gate-r17-sec--v3-p2c-docs.ts:iv_dash#12", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2Nb1OCQBjEv0rzvKaUiUwpm3lABP+E3tFZprxAuC7yAAUT0fG7N9eb3Z3fzO6u4DnNxE1Vxv01JNEhMtMsEry1y8XTJqp4x9DSxa01o3V74ooCEdEP2LfDhIqOEsvGpfKvYRyMVcAPP6DtEZaVEXeIAjQnTLcQ7dNPfewuCVOw4JIuE8c/bt51uckJopfGTdOaB40eBM559sbuZ9NmRwL7RCevj6Nps3XR3RPbP+293nyiRgZMOmRBjdydG+fuoPZqHCJ6rfRz2/P+v60xZQ9OuR0LIfr9NbyABkkR32UJaBc48DKrwFxd4BjJXw4mRHHG46LcgQYyzTmY+jXUIJKyqHkC5irUIC8OXJXCa/gH5yIFWkABAAA=", "checkText"],
  [217, "gate-probe-r16--p2c-docs.ts:latin1_quoted#9; gate-probe-r16--p2c-docs.ts:latin1_quoted#10; gate-r17-sec--r16-p2c-docs.ts:latin1_quoted#9; gate-r17-sec--r16-p2c-docs.ts:latin1_quoted#10; gate-r17-sec--v3-p2c-docs.ts:latin1_quoted#13; gate-r17-sec--v3-p2c-docs.ts:latin1_quoted#14; gate-r17-sec--v3-p2c-docs.ts:latin1_quoted#15", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA3VQy0rDUBD9l1lVuZoE2i4iLlojTdGUGroQkoA3ybW05FHSVIulINKFUUgFV0J/wE3RnQtBuPNj0kQwYrM5M3PmzDBnDDDBpTGVBz7tM2EU9A9sOmb1KuFJt9MyIzMwJ6Io0TyK4h+M2qqib+E3KJXydhbr2/vSZYY1XPCkbMNYbzXzmq8xzfQOvpaoq/2G1iiy/J0vs8zGT5oltf+jlZveeXwU+j4L4iI/5St8FHB5sqerp5hqGqbCblclZxVM8V7YKVob8ifTxtUwt4XP+LD1hUqjN+UrBz9wibf49vuEH03xOgm/eMJfDjORW+JYbB93FL5uXvA7E4CAGzr7vgtkBjGL/DHIxgyuqDdhIAN1fOaE0QgIeIOAgSzNLQLU88Jr5oJsWASCMGabIWtufQOVJZtGLgIAAA==", "checkText"],
  [218, "gate-probe-r16--p2c-docs.ts:utf8_replacement#11; gate-probe-r16--p2c-docs.ts:utf8_replacement#12; gate-r17-sec--r16-p2c-docs.ts:utf8_replacement#11; gate-r17-sec--r16-p2c-docs.ts:utf8_replacement#12; gate-r17-sec--v3-p2c-docs.ts:utf8_replacement#16; gate-r17-sec--v3-p2c-docs.ts:utf8_replacement#17; gate-r17-sec--v3-p2c-docs.ts:utf8_replacement#18", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA3VQy06DQBT9l7uqZrRD0naBcUHFlEZpKunCBEgcYEraMNAAVWPTD/CjJrPp/8wvmIFGR4XNfZx7zn35EEBCamJuGEnpcJenNxGp6GSEpODLxSwogzzYY2yQ1mP8y5Zzx/Y6cGWNXjxq/KS7bqwbOz599ukrbzZtcym4FLzhx+egQzBKLdfS0R8ZjqTgpInG/9WDj9VzfVcwRvNax9/bBkMp+MOV5zxKwV1XAZdLBz0NztUL/cqtGqiGbdsbtRX+ftS2VmpA3FK0E9caUd/W+KbdNryk5w94fr+wpeDTF9URAEFSxNcsAXSAmpasAtM/wCvJ9hRMIDGjcVHuAEG2ySmYxjFEQLKseKMJmH6IIC9qqkThMfwCTavXOkgCAAA=", "checkText"],
  [219, "gate-probe-r16--p3-join.ts:clean_wrapped_alone#1; gate-probe-r16--p3-join.ts:clean_wrapped_alone#2; gate-r17-sec--r16-p3-join.ts:clean_wrapped_alone#1; gate-r17-sec--r16-p3-join.ts:clean_wrapped_alone#2; gate-r17-sec--v3-p3-join.ts:clean_wrapped_alone#1; gate-r17-sec--v3-p3-join.ts:clean_wrapped_alone#2; gate-r17-sec--v3-p3-join.ts:clean_wrapped_alone#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLywqCQBRA/+Wuhx5gURMuruUDgx6KQqmLSadJGmfCLCHx32M255zNyaBiHaN1wwSfvpTY3NibLy1Sp84x6md7X2hExEOcPNxEmHQNnC1ejO+58so4NLlLpHtOI0v5J+u32vVBjx5iMK2vz3VwRswVohNGycJtn6EQwrZzBQQqXU6aCsgAHW+bN9BsgC+THw4UWNnwUrcvICBrxYHOx4IAk1L3vAKaFQSU7riZirH4A6HVZrPLAAAA", "checkText"],
  [220, "gate-probe-r16--p3-join.ts:clean_wrapped_then_blank#3; gate-probe-r16--p3-join.ts:clean_wrapped_then_blank#4; gate-r17-sec--r16-p3-join.ts:clean_wrapped_then_blank#3; gate-r17-sec--r16-p3-join.ts:clean_wrapped_then_blank#4; gate-r17-sec--v3-p3-join.ts:clean_wrapped_then_blank#4; gate-r17-sec--v3-p3-join.ts:clean_wrapped_then_blank#5; gate-r17-sec--v3-p3-join.ts:clean_wrapped_then_blank#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLwW6CQBQAf4W880ZLgo3dxsOjIgQTqygmFjg8YbtuXHYN0NLU+O9mLzNzmQIaGoirlqSY3ox8P1MvXgOmjuFnNr6sY2kRETf7/BLl0mXkEH7gyfm7NKt6n7pc5jraHbPAxNvgf74ckxFXiMlUfV3fkh1iaRDDNMtnUXdNpZSLRWlKc7jQ4KneI8//873tJp4Ag8bWk7YBdodBdG0PvLjDL+kfARyobkVtuxsw0MoI4P6jYkBa21E0wIuKgbGDcFP1qJ4fZfWz3wAAAA==", "checkText"],
  [221, "gate-probe-r16--p3-join.ts:clean_wrapped_attr_nextattr#9; gate-probe-r16--p3-join.ts:clean_wrapped_attr_nextattr#10; gate-r17-sec--r16-p3-join.ts:clean_wrapped_attr_nextattr#9; gate-r17-sec--r16-p3-join.ts:clean_wrapped_attr_nextattr#10; gate-r17-sec--v3-p3-join.ts:clean_wrapped_attr_nextattr#13; gate-r17-sec--v3-p3-join.ts:clean_wrapped_attr_nextattr#14; gate-r17-sec--v3-p3-join.ts:clean_wrapped_attr_nextattr#15", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxWL3UrDMBhAX6V818EpdLJFK3x13UoFdR0duKYXMc2ysPyUtlpx7N1Hbs45N6eGZ21VNPQiYdDykVNtuZKzzqmnbz7Ix5joffpRTvdvG+UREd931SmrVMgsIH3Fr+Ajc2uxK0KuKpNt92XsNp/x/2I15ROuEfOZPpyX+RaROcS0KKt51p8LpVSSMGAuirgZEwad/pOGwQsQaL24sy2QC4yytwPQ+gK/3PxIoMCFlcL3HRAw2kmgD9eGADfGT7IFWjcEnB9lmJprcwMGBurd6AAAAA==", "checkText"],
  [222, "gate-probe-r16--p3-join.ts:clean_wrapped_attr_nextattr_sameline#11; gate-probe-r16--p3-join.ts:clean_wrapped_attr_nextattr_sameline#12; gate-r17-sec--r16-p3-join.ts:clean_wrapped_attr_nextattr_sameline#11; gate-r17-sec--r16-p3-join.ts:clean_wrapped_attr_nextattr_sameline#12; gate-r17-sec--v3-p3-join.ts:clean_wrapped_attr_nextattr_sameline#16; gate-r17-sec--v3-p3-join.ts:clean_wrapped_attr_nextattr_sameline#17; gate-r17-sec--v3-p3-join.ts:clean_wrapped_attr_nextattr_sameline#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLXUvDMBRA/8q4z8EpVNFohVvXrVRQ19GBNn2I6TWG5aO01Ypj/33k5Zzzchp4ME4vxkGlAjo5SW6c1LTsvb7/lCPdJMzss9dqvnze6ICI+LKrv/Nax8wjsid8j/4Sfq12ZcxVbfPtvkr85i35v13NxYxrxGJpPg53xRZReMSsrOrrfDiUWus0FbCQdkoF9OaPrIBHYNAFdeE6YEeYaHAj8OYIv9L+EHCQypEKQw8MrPEE/OrUMpDWhpk64E3LwIeJ4tSe2jMkqkcQ5QAAAA==", "checkText"],
  [223, "gate-probe-r16--p3-join.ts:java_lead_plus_nospace#15; gate-probe-r16--p3-join.ts:java_lead_plus_nospace#16; gate-r17-sec--r16-p3-join.ts:java_lead_plus_nospace#15; gate-r17-sec--r16-p3-join.ts:java_lead_plus_nospace#16; gate-r17-sec--v3-p3-join.ts:java_lead_plus_nospace#22; gate-r17-sec--v3-p3-join.ts:java_lead_plus_nospace#23; gate-r17-sec--v3-p3-join.ts:java_lead_plus_nospace#24", "quiet", "quiet", "private", "H4sIAAAAAAAAA02OTW+CQBCG/wqZa0mVlFrFeBgQwY+CsMXWCgeE7ZYKiyIV0fjfm+3Jy8yT9808mQ2Quso4k7KCSSMphDSuYy0rYkY7e86G2/hIe6qcrXTXb7pzi5WIiA4Jvs2ACTTF0A1ci/01SchMAH44xO9OsTqqSQghlyRJegih54nO516g6IjG+ac59ddeIMKS5v46NZ3T9l3Jt9xDtLOkbTtL0iqEmBf3TvMWPLmLdu8R4+zPX1+mi3ZnoXXwDOd8sAfLufCNg9z0Vr7KraV66Y8bu8EJot2502Sfu4H9/5E+84Nns9rNGGOjUQhDkCEtk8ciBfkKNa2KI2ibK5zi/JeCBnFS0KSs9iBDnnEKmnKLZIjzvGxoCtomkoGXNRVH0S36A4XG5GRkAQAA", "checkText"],
  [224, "gate-probe-r16--p3-join.ts:csharp_lead_plus_at#17; gate-probe-r16--p3-join.ts:csharp_lead_plus_at#18; gate-r17-sec--r16-p3-join.ts:csharp_lead_plus_at#17; gate-r17-sec--r16-p3-join.ts:csharp_lead_plus_at#18; gate-r17-sec--v3-p3-join.ts:csharp_lead_plus_at#25; gate-r17-sec--v3-p3-join.ts:csharp_lead_plus_at#26; gate-r17-sec--v3-p3-join.ts:csharp_lead_plus_at#27", "quiet", "quiet", "private", "H4sIAAAAAAAAA1WOXW+CQBBF/wqZ15IqKbWKMemACH6hC8XWCg8rbLdUPhQtiMb/3mzffJk5uTdzMhuoaCklGZcG0msAMT1RLckoZ619zvtbemQdVU5W+sKt21OLF4iIjud/mz4XaIqhG7gW+2sUeRMB+OF4bnuM5VGNAghySZKkB6HvENG6OfEVHdE4/9RVd018ERYsddex6VTbdyXd5gTRTqKmaS29RvE887K4E735T4tZsyeecXan85fxrNlZaB2I4ZwPdm85Fcahn5pk5aq5tVQv3WFt1zhCtFt3ouRz17P/v9Inrv9slrsJ53wwCKAPMsRF9JjFIF/hxMrsCNrmChVNfxloQKOMRUW5BxnSJGegKbdQBpqmRc1i0DahDHlxYuIovIV/kGLuv2gBAAA=", "checkText"],
  [225, "gate-probe-r16--p3-join.ts:kotlin_trailing_plus#19; gate-probe-r16--p3-join.ts:kotlin_trailing_plus#20; gate-r17-sec--r16-p3-join.ts:kotlin_trailing_plus#19; gate-r17-sec--r16-p3-join.ts:kotlin_trailing_plus#20; gate-r17-sec--v3-p3-join.ts:kotlin_trailing_plus#28; gate-r17-sec--v3-p3-join.ts:kotlin_trailing_plus#29; gate-r17-sec--v3-p3-join.ts:kotlin_trailing_plus#30", "quiet", "private", "private", "H4sIAAAAAAAAA02QW2+CQBCF/8pmXkuqpNQqjQ8DIngpChRbKzwgbLfUZVG8IBr/e7N98mXOyTmZL5NZwSnhJC8Y6ZMIsuSQ6HmRMNraCva6Tva0oyn5wpj5dXtisxIR0Q3CHytk0lpyGCYupX4P02AsDX66gd8eYbXX0gjIQyQIISSCjidLX3ihaiCa59/61F16oQxLyv1lZrmn9YfK18JDdPK0aVrzoFGDwLrM7jnv4dNs2my9wDz7k7eX0bTZ2GjvPNM975zefCKBg5Bb3sLXhD3XLt1B7dQ4RHRa95z8a9Nz/m8yxn74bFWbMWOs348AFMjK9LHIQLnCgVbFHvTVVb7qSEGHJC1oWlZbUIDngoKu3mIFEs7Lmmagr2IFRHmgcim+xX8i6h6bYwEAAA==", "checkText"],
  [226, "gate-probe-r16--p3-join.ts:py_first_empty#21; gate-probe-r16--p3-join.ts:py_first_empty#22; gate-r17-sec--r16-p3-join.ts:py_first_empty#21; gate-r17-sec--r16-p3-join.ts:py_first_empty#22; gate-r17-sec--v3-p3-join.ts:py_first_empty#31; gate-r17-sec--v3-p3-join.ts:py_first_empty#32; gate-r17-sec--v3-p3-join.ts:py_first_empty#33", "quiet", "private", "private", "H4sIAAAAAAAAA02P3W6CQBCFX4XMVZuQKim1lcaLARH8Q1m6tla5QNhuqbAoWhGN795sk8bezJycM/NlZgH9saN0lJulUBRFWUIS7SMjzSPOGhvBn1fRjrV0dQl/eTozJ6RqDh1eICJ6Af20KZfSlsW0cC77Ry8OBlLgmxeQZh/LnR5fKS1fRkT4VDMRreNXdXia+1SaBcvIPLG9w+pVy1bCR3TTuK4b06DWgsA+Ta6UF3o/GdUbP7COZDh+7I/qtYPO1re849ZtT4cS16WZ7c+ILpypfnrqVm6FPUS38e+j93Xb/b3HHBD6YJfrAee805ETt6BCUsR3eQLqGfaszHdgLM5wiLJvBgZEcc7iotyAClkqGBjaJVQhyrKiYgkYi1AFUeyZXAov4Q9OOSYGbQEAAA==", "checkText"],
  [227, "gate-probe-r16--p3-join.ts:js_first_empty_plus#23; gate-probe-r16--p3-join.ts:js_first_empty_plus#24; gate-r17-sec--r16-p3-join.ts:js_first_empty_plus#23; gate-r17-sec--r16-p3-join.ts:js_first_empty_plus#24; gate-r17-sec--v3-p3-join.ts:js_first_empty_plus#34; gate-r17-sec--v3-p3-join.ts:js_first_empty_plus#35; gate-r17-sec--v3-p3-join.ts:js_first_empty_plus#36", "quiet", "private", "private", "H4sIAAAAAAAAA02PT2+CQBDFvwqZa0mVlFrFeBgQwT9FF0pbKxwQtlsqLApURON3b7YXe5n38l7ml5kNxAWvainNmTSSAkiiOtLSPGK0s+dsuI0q2lPlAKS7gEtSAOmrvnSb7txiBSKi4/lfps+ENcXQDVwL/ZzE3kwYfHc8tzvFslLjG6VHROVy4is6onH6bo79NfFFWNDMXSemc9y+KdmWE0Q7jdu2s/JaxfPM8/JGefEflot2Tzzj5M6fn6aLdmehdSCGczrYg9Vc4MZ+ZpJXV+XWSj33x43d4ATR7vz76GM3sP/u0Weu/2iWuxljbDQKYAgyJEV8nycgX6CmZV6BtrnAMcp+KGgQxTmNi3IPMmQpp6Ap11CGKMuKhiagbUIZeFFTsRRew1/BRqWLagEAAA==", "checkText"],
  [228, "gate-probe-r16--p3-join.ts:ruby_backslash#25; gate-probe-r16--p3-join.ts:ruby_backslash#26; gate-r17-sec--r16-p3-join.ts:ruby_backslash#25; gate-r17-sec--r16-p3-join.ts:ruby_backslash#26; gate-r17-sec--v3-p3-join.ts:ruby_backslash#37; gate-r17-sec--v3-p3-join.ts:ruby_backslash#38; gate-r17-sec--v3-p3-join.ts:ruby_backslash#39", "quiet", "private", "private", "H4sIAAAAAAAAA02OTW+CQBCG/wqZM6mSUqs0HgZE8AvdpWtrhQPCllJhUfxANP73ZnvyMvPkfTNPZg2jmaP0lQCS6BgZWRGlvLUT6dsmOvCOrmZLc07r9sRJS0REz2c/Nksl2nKYFq7k/h7G/lgCfno+bY+wOuhxAEoQBEJRAugQ2VFBmGYiWpff+txdESbDkud0ldjeefOh5RtBEN0sbprWwm8037ev8wfNO3ueT5sd8a0LncxeR9Nm66CzJ5Z32bu9xUT6Biy3yZLqwlno1+6gdmscIrqtB032te25/x+ZY8pe7Go7TtO03w8AVEjK+KlIQL3BkVfFAYz1Dc5RfuJgQBQXPC6rHaiQZ4KDod1DFaI8L2uegLEOVRDlkcuj8B7+AZlr0htcAQAA", "checkText"],
  [229, "gate-probe-r16--p3-join.ts:php_dot#27; gate-probe-r16--p3-join.ts:php_dot#28; gate-r17-sec--r16-p3-join.ts:php_dot#27; gate-r17-sec--r16-p3-join.ts:php_dot#28; gate-r17-sec--v3-p3-join.ts:php_dot#40; gate-r17-sec--v3-p3-join.ts:php_dot#41; gate-r17-sec--v3-p3-join.ts:php_dot#42", "quiet", "quiet", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/wqZNOFCVFJqFeNhQAQ/irJ0ba3lgLDdUvkSrYjG/95sL15mnrxv5sls4CHJuDSU5Dg8hnqShZy1y5wPtuGBdTUlWRkLUndmNi8QEV2ffluUC7TEMExci/01jvypAHx3fdKZYHXQIllqfeaSJEly1xMVyT2qGojm+ac+9dYeFWHBUrKOLfe0fVPTbe4hOknUNO2l36i+b10Wd8srfVzMm9LzzTOZvTxP5s3ORnvvme557/SXM6Eb0dTyVkTL7aV26Y1qp8YxotO+W5KPXd/5/8eYEvpkVbsp53w4lAegQFxErSwG5QpHVmUH0DdXOIXpLwMdwihjUVGVoECa5Ax09RYoEKZpUbMY9E2gQF4cmTgKbsEfEt1UElkBAAA=", "checkText"],
  [230, "gate-probe-r16--p3-join.ts:php_dot_lead#29; gate-probe-r16--p3-join.ts:php_dot_lead#30; gate-r17-sec--r16-p3-join.ts:php_dot_lead#29; gate-r17-sec--r16-p3-join.ts:php_dot_lead#30; gate-r17-sec--v3-p3-join.ts:php_dot_lead#43; gate-r17-sec--v3-p3-join.ts:php_dot_lead#44; gate-r17-sec--v3-p3-join.ts:php_dot_lead#45", "quiet", "quiet", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/wqZNOFCVFJqFeNhQAQ/irJ0ba3lgLDdUvkSrYjG/95sL15mnrxv5sls4CHJuDSU5Dg8hnqShZy1y5wPtuGBdTUlWRkLUndmNi8QEV2ffluUC7TEMExci/01jvypAHx3fdKZYHXQIvkzlyRJakly1xMVyT2qGojm+ac+9dYeFWHBUrKOLfe0fVPTbe4hOknUNO2l36i+b10Wd8srfVzMm9LzzTOZvTxP5s3ORnvvme557/SXM6Eb0dTyVkTL7aV26Y1qp8YxotO+W5KPXd/5/8eYEvpkVbsp53w4lAegQFxErSwG5QpHVmUH0DdXOIXpLwMdwihjUVGVoECa5Ax09RYoEKZpUbMY9E2gQF4cmTgKbsEf9Dn9UVkBAAA=", "checkText"],
  [231, "gate-probe-r16--p3-join.ts:lua_dotdot#31; gate-probe-r16--p3-join.ts:lua_dotdot#32; gate-r17-sec--r16-p3-join.ts:lua_dotdot#31; gate-r17-sec--r16-p3-join.ts:lua_dotdot#32; gate-r17-sec--v3-p3-join.ts:lua_dotdot#46; gate-r17-sec--v3-p3-join.ts:lua_dotdot#47; gate-r17-sec--v3-p3-join.ts:lua_dotdot#48", "quiet", "quiet", "private", "H4sIAAAAAAAAA02OTW+CQBCG/wqZM1FJqVUaDwMi+FEUKLZWOKyw3VKXRfED0fjfm+3Jy8yT9808mTXwMiVcyQumDJQYMnIkRl4QRts7wV435EC7upovzXlQd6YOKxERvTD6sSMm0ZbDtHAl9/coDScS8NMLg84Yq4OexqC0WrFQlBi6vuwC4UeaiWhdfutzb+VHMiwpD1aZ7Z03HxrfCB/RzdOmaS/CRgtD+zp/0LxHT/NZs/ND6xJM317Gs2broLP3Le+yd/uLqfQNI277y0AXzkK/9oa1W+MI0W0/aPKvbd/9/8icBNGzXW0njLHBIAZQISvTVpGBeoMjrYoDGOsbnAk/UTCApAVNy2oHKvBcUDC0e6IC4bysaQbGOlFBlEcqj5J78gf4x6zFYgEAAA==", "checkText"],
  [232, "gate-probe-r16--p3-join.ts:sql_concat#33; gate-probe-r16--p3-join.ts:sql_concat#34; gate-r17-sec--r16-p3-join.ts:sql_concat#33; gate-r17-sec--r16-p3-join.ts:sql_concat#34; gate-r17-sec--v3-p3-join.ts:sql_concat#49; gate-r17-sec--v3-p3-join.ts:sql_concat#50; gate-r17-sec--v3-p3-join.ts:sql_concat#51", "quiet", "quiet", "private", "H4sIAAAAAAAAAz2Oy3KCQBBFf4XqDRsqSoUYxXLR4Ag+gsKIiTEsECYTIg/FB+Lj31OThZvuU/dWn+oVUDIh5lyS4/AQ6kkWctbY5ry7DvespSnJwph6VXNs8QIR0aH+D/G5QCKGYeJS7O9BREcC8MOhXnOI5V6LZOl2+8olSW65ovFy11cNRPP8W53aS9cXYcFSbxkT57R+V9N17iLaSVTXjRmtVUrJZfqQzP3n6aTeutQ8e+O31+Gk3lho7VzTOe/szmwsbH0/Je7C03Jrpl3a/cqucIBoNx6S5HPTsf+/MUae/0LKzYhz3uvJXVAgLqKnLAblCgdWZnvQV1c4hemRgQ5hlLGoKLegQJrkDHT1HigQpmlRsRj0VaBAXhyYOAruwR/gU53aVgEAAA==", "checkText"],
  [233, "gate-probe-r16--p3-join.ts:vb_amp#35; gate-probe-r16--p3-join.ts:vb_amp#36; gate-r17-sec--r16-p3-join.ts:vb_amp#35; gate-r17-sec--r16-p3-join.ts:vb_amp#36; gate-r17-sec--v3-p3-join.ts:vb_amp#52; gate-r17-sec--v3-p3-join.ts:vb_amp#53; gate-r17-sec--v3-p3-join.ts:vb_amp#54", "quiet", "quiet", "private", "H4sIAAAAAAAAA02OTW+CQBCG/wqZQ0+kSkqt0ngYEMGPorsUWyukQdhuqQsoWhGN/73ZnrzMPHnfzJNZQZZzpa+EkMaH2MjymLPWtuDP63jPOrqaLcwZrdsTh5eIiJ4ffNsBl2jLYVq4lPtrmPhjCfju+bQ9wmqvJyEod8pnWChKCB0iS1qQQDMRrdNPfewuSSDDkgm6TG3vuH7TxLogiG6WNE1r7jea79vn2a3nNXiYTZst8a0Tnbw8jabNxkFnRyzvtHN784kUDgJhkwXVC2eun7uD2q1xiOi2bj3Zx6bn/v9kjmnwaFebMee83w8BVEjL5D5PQb3AgVX5HozVBY6x+GVgQJzkLCmrLaggsoKBoV0jFWIhypqlYKwiFYrywORRdI3+AAmGe/VfAQAA", "checkText"],
  [234, "gate-probe-r16--p3-join.ts:swift_plus#37; gate-probe-r16--p3-join.ts:swift_plus#38; gate-r17-sec--r16-p3-join.ts:swift_plus#37; gate-r17-sec--r16-p3-join.ts:swift_plus#38; gate-r17-sec--v3-p3-join.ts:swift_plus#55; gate-r17-sec--v3-p3-join.ts:swift_plus#56; gate-r17-sec--v3-p3-join.ts:swift_plus#57", "quiet", "quiet", "private", "H4sIAAAAAAAAA02OTW+CQBCG/8pmriW1pNQqjYcBEfwoCnRtrXBA2G6pCyhSEY3/vdmevMw8ed/Mk1mDYDXJck4GJIQ0rmM9y2POOruCv2ziA+tqSrY05n7zMLV5iYjoBvTbolyiJYdh4krur1ESTCTghxv4D2OsDloSQlgQQsgdCaHrydIvPKoaiObppzn2Vh6VYcmEv0ot97h5V8Wm8BCdLGnbziJo1SCwzvNbzxt9nM/anReYJ3/6+jyetVsb7b1nuqe9019MpXBIheUtfa2wF9q5N2ycBkeITufWk31u+87/T8bEp09WtZ1wzgeDEECBtEzu8xSUC9Ssyg+gry9wjMUvAx3iJGdJWe1AAZEVDHT1GikQC1E2LAV9HSlQlDWTR9E1+gPJHqkMYwEAAA==", "checkText"],
  [235, "gate-probe-r16--p3-join.ts:json_array#39; gate-probe-r16--p3-join.ts:json_array#40; gate-r17-sec--r16-p3-join.ts:json_array#39; gate-r17-sec--r16-p3-join.ts:json_array#40; gate-r17-sec--v3-p3-join.ts:json_array#58; gate-r17-sec--v3-p3-join.ts:json_array#59; gate-r17-sec--v3-p3-join.ts:json_array#60", "quiet", "private", "private", "H4sIAAAAAAAAAzWO3W6CQBBGX6WZ602VlFql8WJABH+Kstu1tcAFwpZSYbFoRTS+e7NNvJk5+b7MyQQQhJDGh9jIyzgTnZ3MnjfxXvR0kq/MBW26MyerEBE9xr9snim01TAtXKv9OU7YVAG+e4x2J1jv9SQEEsq7EHq+Kqj0uWYiWqfv5thf+1yFlSjoOrW94+ZNKzbSR3TzpG07S9ZqjNnnxc3xyh8W83bnM+tEZy9Pk3m7ddD58S3v9OMOljMlG/HC9ldUl85SP/dHjdvgGNHt3Bz5x3bg/v9iTil/tOvtNMuy4TCECAikVXJfpkAucBB1uQcjuMAxLn4FGBAnpUiqegcEilwKMLRrRCAuiqoRKRhBREBWB6GOomv0B6hTz1pPAQAA", "checkText"],
  [236, "gate-probe-r16--p3-join.ts:tail_short_text_yaml#43; gate-probe-r16--p3-join.ts:tail_short_text_yaml#44; gate-r17-sec--r16-p3-join.ts:tail_short_text_yaml#43; gate-r17-sec--r16-p3-join.ts:tail_short_text_yaml#44; gate-r17-sec--v3-p3-join.ts:tail_short_text_yaml#64; gate-r17-sec--v3-p3-join.ts:tail_short_text_yaml#65; gate-r17-sec--v3-p3-join.ts:tail_short_text_yaml#66", "quiet", "quiet", "private", "H4sIAAAAAAAAA63OuwrCQBBG4VdZ/npQhGAxVnaCkDbousW4O2BgLyFZoxDy7qLPYHHKD45FLlXZBKnCVd91O0Tp8+Euk+4b0tOj+Ve3bMyla+u1a2efj2cQQvGbFEALqo5pAtsFs8SngiE+qS/jAELss4J3qyNIjOWlAWwd/da/yK3uAwTK5BfIAAAA", "checkText"],
  [237, "gate-probe-r16--p3-join.ts:tail_short_text_md#45; gate-probe-r16--p3-join.ts:tail_short_text_md#46; gate-r17-sec--r16-p3-join.ts:tail_short_text_md#45; gate-r17-sec--r16-p3-join.ts:tail_short_text_md#46; gate-r17-sec--v3-p3-join.ts:tail_short_text_md#67; gate-r17-sec--v3-p3-join.ts:tail_short_text_md#68; gate-r17-sec--v3-p3-join.ts:tail_short_text_md#69", "quiet", "quiet", "private", "H4sIAAAAAAAAA63LsQrCMBAG4Hf5J4VDEYpDnNwEoWupMcOZHFhIL6U9q1D67uI7OHzj5+E1bBIbO5OP7YfMnZ4ePMmxIrk8q3+5a9vUdmvqOer5ugUhlbjrE2iBydhPcH7BzPklcODYSyzjAELuVOAOayBwzuUtCc4HghaTXwpr+ALgMRXTxQAAAA==", "checkText"],
  [238, "gate-probe-r16--p3-join.ts:tail_short_text_quoted#47; gate-probe-r16--p3-join.ts:tail_short_text_quoted#48; gate-probe-r16--p5-quote.ts:tail76_in_quote_direct#7; gate-r17-sec--r16-p3-join.ts:tail_short_text_quoted#47; gate-r17-sec--r16-p3-join.ts:tail_short_text_quoted#48; gate-r17-sec--r16-p5-quote.ts:tail76_in_quote_direct#19; gate-r17-sec--r16-p5-quote.ts:tail76_in_quote_direct#20; gate-r17-sec--r16-p5-quote.ts:tail76_in_quote_direct#21; gate-r17-sec--v3-p3-join.ts:tail_short_text_quoted#70; gate-r17-sec--v3-p3-join.ts:tail_short_text_quoted#71; gate-r17-sec--v3-p3-join.ts:tail_short_text_quoted#72", "private", "private", "private", "H4sIAAAAAAAAA63LPQrCQBAG0Lt89aAIwWKt7AQhbdDdLSa7Awb2JyRjFELuHryDxSufhUNkZaPy1eOYeCiXnmc5NyS3V/Mvrjy6Vp9du4RyvTuAEGs45AhaoTLlGcauWDi9BQYcsoQ6jSCkoQjMafMETql+JMJYTyhV5Zf85negVxTsxAAAAA==", "checkText"],
  [239, "gate-probe-r16--p3-join.ts:tail_short_text_jsconcat#49; gate-probe-r16--p3-join.ts:tail_short_text_jsconcat#50; gate-r17-sec--r16-p3-join.ts:tail_short_text_jsconcat#49; gate-r17-sec--r16-p3-join.ts:tail_short_text_jsconcat#50; gate-r17-sec--v3-p3-join.ts:tail_short_text_jsconcat#73; gate-r17-sec--v3-p3-join.ts:tail_short_text_jsconcat#74; gate-r17-sec--v3-p3-join.ts:tail_short_text_jsconcat#75", "quiet", "quiet", "private", "H4sIAAAAAAAAA63LsQrCMBQF0F8JdzUoQnGIOLgJQtdSkwzP5IGFNCntsxZK/138B4czHotFXZRDJCEjvMhhSNTl85MmPlWab6/qXxzUzmWlHNqmlkdTzyFf7w7QiCXs+wi9QnjsJxi7Yqb0ZhhQ6DmUcYBG6jLDHDevQSmVD0cY6zVyEf4lv/kv/XIbBdAAAAA=", "checkText"],
  [240, "gate-probe-r16--p4-time.ts:quoted_newlines#1; gate-r17-sec--r16-p4-time.ts:quoted_newlines#1", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTQrCMBRG0b1846AI4iCOXEeTQWwepZCfUqsOSvcu7uNyxmdQUE5b8nNNk52XNt2f6WW3q3uEBgAAAAAAAAAAAAAAAAAAAAAAAAAAAABAaEFyyn081Sy3a7O1vuSHXZ9U3iavNFYb+7rIqczN5C9HdEql9K9l+SE6tb7ZP8Uj/gBOma/V6j4AAA==", "checkText"],
  [241, "gate-probe-r16--p4-time.ts:quoted_newlines#2; gate-r17-sec--r16-p4-time.ts:quoted_newlines#2", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7iJ4jGHqaeIYfVlKvozlXNfX6bw/lXvdbdPhOAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8RaTo52419pHesdTbeI/cvONZhkeNHKUbazffrpFiuEw18ubTpijDML9qH7lpU0zzUn+p/bRfedI3ump9AAA=", "checkText"],
  [242, "gate-probe-r16--p4-time.ts:quoted_newlines#3; gate-r17-sec--r16-p4-time.ts:quoted_newlines#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7mLrGYapp4lj9GUp+TKWc11fp/P+VO51t02H4wQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8CciRT93q7GP9I6l3sZ75OYdzzI8auQo3Vi7+XaNFMNlqpE3nzZFGYb5VfvITZtimpf6S+2n/QLcGg+IavoAAA==", "checkText"],
  [243, "gate-probe-r16--p4-time.ts:quoted_newlines#4; gate-r17-sec--r16-p4-time.ts:quoted_newlines#4", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7uIJvMAw9TRxjL4sJV/Gcq7r63Ten8q97rbpcJwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ohI0c/dauwjvWOpt/EeuXnHswyPGjlKN9Zuvl0jxXCZauTNp01RhmF+1T5y06aY5qX+Uvtpvxvz+0Vq9AEA", "checkText"],
  [244, "gate-probe-r16--p4-time.ts:quoted_nl_spaces#5; gate-r17-sec--r16-p4-time.ts:quoted_nl_spaces#5", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XPQrCQBgG4avIWy+KIBZr5TmSFGv2IwT2JyRRi5C7i6fQYp5+DjCNWsWwBj/mMNhpKsPtERa7Xty9LQcAAAAAAPBzHDoAAAAAAP+glZxi7Y85ym1abc6LfLPpFdLT5BX6bH2dJzmlsZj8ee+cQkr1bVG+6ZxKXe0bdXv3AXXZkceuHwAA", "checkText"],
  [245, "gate-probe-r16--p4-time.ts:quoted_nl_spaces#6; gate-r17-sec--r16-p4-time.ts:quoted_nl_spaces#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XPQrCQBgG4avIWy+KIBZr5TmSFGv2IwT2J8SoRcjdxVOYYp5+DjCNWsWwBD/mMNhpKsPtEZ52vbh7Ww4AAAAAAODvOHQAAAAAAPaAQwcAAAAAYA84dAAAAAAA9qCVnGLtjznKrVpszk/5ZtU7pJfJK/TZ+jpPckpjMfnz1jmFlOrHonzTOZW62C/qtu4L5emcO/I+AAA=", "checkText"],
  [246, "gate-probe-r16--p4-time.ts:quoted_nl_spaces#7; gate-r17-sec--r16-p4-time.ts:quoted_nl_spaces#7", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XO2rDQBRA0a2EVw8OgZBiUmUdkoqJNBiDPsZW4sJ47yGr8BTn9HcBt4s+prKXfFrKsb6e1+Pnd7nWj/f01a8vAAAAwNM5dAAAAGiBQwcAAIAWOHQAAABogUMHAACAFjh0AAAAaIFDBwAAgBY4dAAAAGhBH5Fi2sbDMkW6x14vyzVyd4/fMv/UyFHGpY7b5Rwp5tNaI789hhRlnrdbnSJ3Q4p12+t/NDyGP8qD/Kl6fQAA", "checkText"],
  [247, "gate-probe-r16--p4-time.ts:quoted_nl_spaces#8; gate-r17-sec--r16-p4-time.ts:quoted_nl_spaces#8", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XO07DQBRA0a2gV49ASIjCVKzDdjHYoyiSP1ESSBFl74hV8Ipz+ruA28cQc73W7rjWQ3s5bYePr3pp72/lc9ieAAAAgH/n0AEAACADhw4AAAAZOHQAAADIwKEDAABABg4dAAAAMnDoAAAAkIFDBwAAgAwcOgAAAGTg0AEAACADhw4AAAAZOHQAAADIwKEDAABABg4dAAAAMnDoAAAAkIFDBwAAgAyGiBLzPj2vc5R7XNt5vUTX3+OnLt8tuqjT2qb9fIoSy3Fr0b0+xhJ1WfZbm6PrxxLbfm1/0fgYfwGaE7c+ivoAAA==", "checkText"],
  [248, "gate-probe-r16--p4-time.ts:quoted_nl_15#9; gate-r17-sec--r16-p4-time.ts:quoted_nl_15#9", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniPZYs1+hMD+hBi1CLm7WHoGZ8oHplOvFNfopxJHO851vN7jwy5nd/utrwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8AveSU2nAoSW7Takt5yHebXjE/TV5xKDa0ZZZTnqrJn/bgFHNub0vyXXCqbbXvFPbwAT7a/s6dIQAA", "checkText"],
  [249, "gate-probe-r16--p4-time.ts:quoted_nl_15#10; gate-r17-sec--r16-p4-time.ts:quoted_nl_15#10", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniPZYs1+hMD+hBi1CLm7WHoFmSkfmE69Ulyjn0oc7TjX8XqPD7uc3e23vgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/Cb3klNpwKElu02pLech3m14xP01ecSg2tGWWU56qyZ/24BRzbm9L8l1wqm217xT28AEqMVbA0UIAAA==", "checkText"],
  [250, "gate-probe-r16--p4-time.ts:quoted_nl_15#11; gate-r17-sec--r16-p4-time.ts:quoted_nl_15#11", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LO2rDQBRA0b28enAwBBeTyuuQVIylwRj0Q1biwnjvJmWWEDi3PHCbaGMoe8m3qVzrxzpfvy7lXk+f6fy3dgYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8W2gjUgxLf5iGSM/Y6zbdIzfP+Cnjd40cpZ9qv2xrpBhvc418fHUpyjgujzpEbroU87LX36l7dW9qkEpvOYUAAA==", "checkText"],
  [251, "gate-probe-r16--p4-time.ts:quoted_nl_15#12; gate-r17-sec--r16-p4-time.ts:quoted_nl_15#12", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LO2rDQBRA0b28enAwBBeTyuuQVIylwRj0Q1biwnjvJmVWkObc8sBtoo2h7CXfpnKtH+t8/bqUez19pvPf2hkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8ObUSKYekP0xDpGXvdpnvk5hk/ZfyukaP0U+2XbY0U422ukY+vLkUZx+VRh8hNl2Je9vo7da/uDTSywpEJCgEA", "checkText"],
  [252, "gate-probe-r16--p4-time.ts:prose_join_lines#13; gate-r17-sec--r16-p4-time.ts:prose_join_lines#13", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniNusWY/QmB/QhK1CLm72HoDYaZ8YDqluEY/ljjYcarD9REXu5zd7ad7RRAEQRAEQRAEQRAEQRAEQRAEQRAEQRAE+V+RU2r9oSS5TavNZZHvNr1ifpq8Yl+sb/MkpzxWkz/twSnm3N6W5LvgVNtq3yns4QNPtkRfcSEAAA==", "checkText"],
  [253, "gate-probe-r16--p4-time.ts:prose_join_lines#14; gate-r17-sec--r16-p4-time.ts:prose_join_lines#14", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LParCQBhA0b189aAIYjFWriOmmJcMIuRHNPoKce9i6woszi0P3Cb6spR8Hsupri/Taf9XbnW3TYevjhMhhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEII+U2JFP3crcY+0jOWeh1vkZtnPMpwr5GjdGPt5uslUgznqUbevNoUZRjm/9pHbtoU07zUz9S+2jfCiCkdj0IAAA==", "checkText"],
  [254, "gate-probe-r16--p4-time.ts:prose_join_lines#15; gate-r17-sec--r16-p4-time.ts:prose_join_lines#15", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LParCQBhA0b189aAIYjFWriOmmJcMIuRHNPoKce9ia2t7bnngNtGXpeTzWE51fZlO+79yq7ttOnx1nAghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCG/SKTo52419pGesdTreIvcPONRhnuNHKUbazdfL5FiOE818ubVpijDMP/XPnLTppjmpX6m9tW+AY/qEfe5hAAA", "checkText"],
  [255, "gate-probe-r16--p4-time.ts:prose_join_lines#16; gate-r17-sec--r16-p4-time.ts:prose_join_lines#16", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LParCQBhA0b189aAIYjFWriOmmJcMIuRHNPoKce9i6woszi0P3Cb6spR8Hsupri/Taf9XbnW3TYevjhMhhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQ8jsSKfq5W419pGcs9TreIjfPeJThXiNH6cbazddLpBjOU428ebUpyjDM/7WP3LQppnmpn6l9tW9yIlMIDQkBAA==", "checkText"],
  [256, "gate-probe-r16--p4-time.ts:early_stop_many#17; gate-r17-sec--r16-p4-time.ts:early_stop_many#17", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NPQrCQBgG4bP41qsiiMVaeY6YYs1+hMD+hCRqEXJ38RIWMtMPT6MYluCHHHo7jqW/PsJsl7O77Xc/6F7Q0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dH/Q5dTrN0hR7lVi015lm9WvUJ6mrxCl62r0yinNBSTP22tU0ipvi3KN61TqYt9p3ZrP8uk0aDPHwAA", "checkText"],
  [257, "gate-probe-r16--p4-time.ts:early_stop_many#18; gate-r17-sec--r16-p4-time.ts:early_stop_many#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NPQrCQBgG4bP41qsiiMVaeY6YYs1+hMD+hCRqEXJ3Ee9gNdMPT6MYluCHHHo7jqW/PsJsl7O77Xd/6F7Q0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0X+6nGLtDjnKrVpsyrN8s+oV0tPkFbpsXZ1GOaWhmPxpa51CSvVtUb5pnUpd7Du1W/sB0ztCZE8/AAA=", "checkText"],
  [258, "gate-probe-r16--p4-time.ts:early_stop_many#19; gate-r17-sec--r16-p4-time.ts:early_stop_many#19", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NO4oCQRRA0bXMi0uHATEoI9fRdlB2FyL0R7SdCcS9i5sYDM7NL6eJviwln8dyqt+X6bQ7llvdbtJ+9fUPHSY6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU7/HD1S9HO3HvtIj1jqdbxFbh7xW4Z7jRylG2s3Xy+RYjhPNfLPs01RhmH+q33kpk0xzUt9T+2zfQGDxo/ET34AAA==", "checkText"],
  [259, "gate-probe-r16--p4-time.ts:early_stop_many#20; gate-r17-sec--r16-p4-time.ts:early_stop_many#20", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NO4oCQRRA0bXMi0uHATEoI9fRdlB2FyL0R7SdCcS9i5sYDM7NL6eJviwln8dyqt+X6bQ7llvdbtJ+9fUPHSY6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0Op1Op9PpdDqdTqfT6XQ6nU6n0+l0+qfpkaKfu/XYR3rEUq/jLXLziN8y3GvkKN1Yu/l6iRTDeaqRf55tijIM81/tIzdtimle6ntqn+0L9QVOTk/8AAA=", "checkText"],
  [260, "gate-probe-r16--p4-time.ts:early_stop_one_long#21; gate-r17-sec--r16-p4-time.ts:early_stop_one_long#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMQ6CMBiG4bPwzVVjYhzq5DmgQ6V/CElLCaAOhLsb7/E++9OqU4pb9GOJg13maXi84mr3m3ueGgAAAAAAAAAAAAAA0HSSU6r9uSS5XZstZZVvd31ifpu8Yl+sr8sspzxOJn89glPMuX4tybfBaaqb/VM4wg+A/FK1qx8AAA==", "checkText"],
  [261, "gate-probe-r16--p4-time.ts:early_stop_one_long#22; gate-r17-sec--r16-p4-time.ts:early_stop_one_long#22", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMQ6CMBiG4bP0m6vGxDjUyXNAh0r/EJJCCaAOhLsb7/E++9OoVU5bCsOYervMU/94pdXuN/88OQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAnHOt5JVrdx6z/K7NlnFVaHZ9UnmbglI3WleXWV5lmEzhekSvVEr9WlZootdUN/uneMQf1SZI/+s+AAA=", "checkText"],
  [262, "gate-probe-r16--p4-time.ts:early_stop_one_long#23; gate-r17-sec--r16-p4-time.ts:early_stop_one_long#23", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0LP41aOLIBZj5TliijEZRMiPaHa3EO8ugsd4r39NnKIvS8nXsVzqz226HM7lUfe7dFyvAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL5OESn6uduMfaRnLPU+PiI3z/grw2+NHKUbazffb5FiuE418vbVpijDMP/XPnLTppjmpX5S+2rfaj93Cmt9AAA=", "checkText"],
  [263, "gate-probe-r16--p4-time.ts:early_stop_one_long#24; gate-r17-sec--r16-p4-time.ts:early_stop_one_long#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0LP41aOLIBZj5TliijEZRMiPaHa3EO8utp7hvf41cYq+LCVfx3KpP7fpcjiXR93v0nG9AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4copI0c/dZuwjPWOp9/ERuXnGXxl+a+Qo3Vi7+X6LFMN1qpG3rzZFGYb5v/aRmzbFNC/1k9pX+wYA+5fDa/oAAA==", "checkText"],
  [264, "gate-probe-r16--p4-time.ts:cand_then_spaces_nl#25; gate-r17-sec--r16-p4-time.ts:cand_then_spaces_nl#25", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NOwrCQBRA0b28elBsx6XEFGMyhZCPxKhFyN7FRQgWh1tfThN9WUsux+v5Mv0+GAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgsP/GIkU/d4exj7TFWpfxEbnZ4lWGZ40cpRtrNy/3SDHcphr5tLcpyjDM79pHbtoU07zW79Tu7QeMhqBGyjkAAA==", "checkText"],
  [265, "gate-probe-r16--p4-time.ts:cand_then_spaces_nl#26; gate-r17-sec--r16-p4-time.ts:cand_then_spaces_nl#26", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NOwrCQBRA0b28elBsx6XEFGMyhZCPxKhFyN7F2trucOvLaaIva8nleD1fpv8Hg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaD/RYp+rk7jH2kLda6jI/IzRavMjxr5CjdWLt5uUeK4TbVyKe9TVGGYX7XPnLTppjmtX6ndm8/6dkCqrJzAAA=", "checkText"],
  [266, "gate-probe-r16--p4-time.ts:cand_then_spaces_nl#27; gate-r17-sec--r16-p4-time.ts:cand_then_spaces_nl#27", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NOwrCQBRA0b28elBsx6XEFGMyhZCPxKhFyN7FRQgWh1tfThN9WUsux+v5Mv0+GAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBvs7LFL0c3cY+0hbrHUZH5GbLV5leNbIUbqxdvNyjxTDbaqRT3ubogzD/K595KZNMc1r/U7t3n4AKOz9QhXnAAA=", "checkText"],
  [267, "gate-probe-r16--p4-time.ts:cand_then_spaces_nl#28; gate-r17-sec--r16-p4-time.ts:cand_then_spaces_nl#28", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3NOwrCQBRA0b28elBsx6XEFGMyhZCPxKhFyN7FRQgWh1tfThN9WUsux+v5Mv0+GAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAw2F9hkaKfu8PYR9pircv4iNxs8SrDs0aO0o21m5d7pBhuU4182tsUZRjmd+0jN22KaV7rd2r39gOIAXr0280BAA==", "checkText"],
  [268, "gate-probe-r16--p4-time.ts:header_long_token#29; gate-r17-sec--r16-p4-time.ts:header_long_token#29", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3PPQoCMRRF4b3cOii2cSkhxTN5hZBMZIw/MMzexV1chvv1pzgJ1aZFO9+u34PQEDsNsdMQOw2x0xA7DbHTEDsNsdMQOw2x0xA7DbHTEDsNsdMQOw2x0xA7DbE73BAC6iinXhE2TF/7EzFteFt7OSKsdC9jfSCg3RdHvOw5wFobH6+IKQcsY/o/ynv+AbStYL1VHwAA", "checkText"],
  [269, "gate-probe-r16--p4-time.ts:header_long_token#30; gate-r17-sec--r16-p4-time.ts:header_long_token#30", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3POwrCQBgA4bv89aLYrkcJKdZkCyEPifEBIXcXbzGE+foppom+rCWX8+36PQiH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6A43FCn6uTuNfaQt1rqMz8jNFu8yvGrkKN1Yu3l5RIrhPtXIl71NUYZh/tQ+ctOmmOa1/qN2b38/y30EWz4AAA==", "checkText"],
  [270, "gate-probe-r16--p4-time.ts:header_long_token#31; gate-r17-sec--r16-p4-time.ts:header_long_token#31", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3POwrCQBgA4bv89aLYrkcJW6zJFkIeEuMDgncXbzHIfP0U08VQt5rr8XJ+/wmH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOITqH6Byic4jOIbpIMSz9YRoi7bG1dbpH7vZ41vHRIkftp9Yv6y1SjNe5RT59Soo6jsurDZG7kmJetvaLyqd8AUaUMGo4fQAA", "checkText"],
  [271, "gate-probe-r16--p4-time.ts:header_long_token#32; gate-r17-sec--r16-p4-time.ts:header_long_token#32", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3PO0oDUQBA0b28elBsx6WEFGMyhZCPxPiBkL2LuziEe/pb3M3YL9dlXp7fXn8fREO6hnQN6RrSNaRrSNeQriFdQ7qGdA3pGtI1pGtI15CuIV1DuoZ0Deka0jWka0jXkK4hXUO6hnQN6RrSNaRrSNeQriFdQ7qGdA3pGtI1pGtI15CuIV1DuoZ0Deka0jWka0jXkK4hXUO6hnQN6RrSNaRrSNeQriFdQ7qGdA3pGtI1pGtI15CuIV1DuoZ0Deka0jWka0jXkK4hXUO6hnQN6RrSNaRrSNeQriFdQ7qGdA3pGtI1pGtI15CuIV1DuoZ0Deka0jWka0jXkK4hXUO6hnQN6RrSNaRrSNeQriFdQ7qGdA3pGtI1pGtI15CuIV1DuoZ0Deka0jWka0jXkK4hXUO6hnQN6RrSNaRrSNeQriFdQ7qGdA3pGtI1pGtI15CuIV1DuoZ0Deka0jWka0jXkK4hXUO6hnQN6RrSNaRrSNeQriHdww2NaezPu6fjfky3cV0vx88xb27jezl8rWMey+647s6XjzGNw/tpHfPLfTuN5XA4/6z7MW+20zidr+t/tL1v/wBcTdubIfoAAA==", "checkText"],
  [272, "gate-probe-r16--p4-time.ts:join_after_each_cand#33; gate-r17-sec--r16-p4-time.ts:join_after_each_cand#33", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniNusWY/JLA/IYlahNxdbPUEwkw58HRKcYl+KPFu+7Hez7c42+noLl9d6+9BIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBL5j1JOqfW7kuRWLTaVWb5b9Yz5YfKKfbG+TaOc8lBN/rAFp5hze1mS74JTbYt9UNjCG1UWH0x7IAAA", "checkText"],
  [273, "gate-probe-r16--p4-time.ts:join_after_each_cand#34; gate-r17-sec--r16-p4-time.ts:join_after_each_cand#34", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniNusWY/JLA/IYlahNxdbPUGMlMOPJ1SXKIfSrzbfqz38y3Odjq6y1fX+nuQSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolE/q+UU2r9riS5VYtNZZbvVj1jfpi8Yl+sb9MopzxUkz9swSnm3F6W5LvgVNtiHxS28Aa233S74UAAAA==", "checkText"],
  [274, "gate-probe-r16--p4-time.ts:join_after_each_cand#35; gate-r17-sec--r16-p4-time.ts:join_after_each_cand#35", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPWoCURhA0b189SMihBTPynWMU7zMPGRg/tBJUoh7F9vYuIBzywunib5sJQ9TOdfdOp8P3+Vavz7T8V+n+fWQJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEm+IyNFv3QfUx/pFlu9TNfIzS1+y/hTI0fpptotlzVSjMNcI+/vbYoyjstf7SM3bYp52eoTtff2ATYSWGCtgQAA", "checkText"],
  [275, "gate-probe-r16--p4-time.ts:join_after_each_cand#36; gate-r17-sec--r16-p4-time.ts:join_after_each_cand#36", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPWoCURhA0b189SMihBTPynWMU7zMPGRg/tBJUoh7F9u4AJtzywunib5sJQ9TOdfdOp8P3+Vavz7T8V+n+fWQJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEm+X0aKfuk+pj7SLbZ6ma6Rm1v8lvGnRo7STbVbLmukGIe5Rt7f2xRlHJe/2kdu2hTzstUnau/tA6R9sfULAwEA", "checkText"],
  [276, "gate-probe-r16--p4-time.ts:quote_many_cands#37; gate-r17-sec--r16-p4-time.ts:quote_many_cands#37", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTQrCMBRG0a3INw6KIA7iDtyASM0gNm9QSZvSxh8o3bu4Dbnjw2l0U4o1+mqfuhtz7IbTPc52PLjr5fzYYBiGYRiGYRiGYRiGYRiGYRiGYRiGYdg/2k1ySqXd9kluUbWpn+WbRa+Ynyav2PbWlmmUU+4Gk9+vwSnmXN6W5JvgNJRqvxTW8AUSEnFWfx8AAA==", "checkText"],
  [277, "gate-probe-r16--p4-time.ts:quote_many_cands#38; gate-r17-sec--r16-p4-time.ts:quote_many_cands#38", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTQrCMBRG0a3INw6KIA7iDtyASM0gNm9QSZvSxh8o3bu4Dbnjw2l0U4o1+mqfuhtz7IbTPc52PLjr5fzYYBiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYRiGYf9tN8kplXbbJ7lF1aZ+lm8WvWJ+mrxi21tbplFOuRtMfr8Gp5hzeVuSb4LTUKr9UljDF7qA7xLHPgAA", "checkText"],
  [278, "gate-probe-r16--p4-time.ts:quote_many_cands#39; gate-r17-sec--r16-p4-time.ts:quote_many_cands#39", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LQUrDQBQA0KvIXw+KIC7GG3gBkTSLaTKLyiQp7VSF0rsXryFv/XhD7GIuveRef/vTsZXD+rYv5/r6kj4/3r8eGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGP/03YRKeZtelzmSNfo9bScIw/X+C7tUiNHmZY6badjpGiHtUZ+vo0pSmvbT50jD2OKdev1L4238Q4W6/fGO30AAA==", "checkText"],
  [279, "gate-probe-r16--p4-time.ts:quote_many_cands#40; gate-r17-sec--r16-p4-time.ts:quote_many_cands#40", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LQUrDQBQA0KvIXw+KIC7GG3gBkTSLaTKLyiQp7VSF0rsXryFv/XhD7GIuveRef/vTsZXD+rYv5/r6kj4/3r8eGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMfb/bReRYt6mx2WOdI1eT8s58nCN79IuNXKUaanTdjpGinZYa+Tn25iitLb91DnyMKZYt17/0ngb76ZjGfU/+gAA", "checkText"],
  [280, "gate-probe-r16--p4-time.ts:stray_quote_cands#41; gate-r17-sec--r16-p4-time.ts:stray_quote_cands#41", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LQQ6CMBBA0auQWTcaE3VRb+AFjAEWI50FprQEqpgQ7m68hYu/f6+WUyNV0KK+2Kfsx6h9ujx0tvPR3W/XZ6UpVEuewtwkGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8Fgf8vEScjdbgjiVik2DbP4epW3xpeJF+0G6/I0ipPYJxN/2FonGmNeLIivWycpF/uldmu/M0Z49FEgAAA=", "checkText"],
  [281, "gate-probe-r16--p4-time.ts:stray_quote_cands#42; gate-r17-sec--r16-p4-time.ts:stray_quote_cands#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LQQ6CMBBA0auQWTcaE3VRb+AFjAEWI50FprQEqpgQ7m48hZu/f6+WUyNV0KK+2Kfsx6h9ujx0tvPR3W/XZ6UpVEuewtwkGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYP9l4iTkbjcEcasUm4ZZfL3KW+PLxIt2g3V5GsVJ7JOJP2ytE40xLxbE162TlIv9Uru1X5gLMPl2QAAA", "checkText"],
  [282, "gate-probe-r16--p4-time.ts:stray_quote_cands#43; gate-r17-sec--r16-p4-time.ts:stray_quote_cands#43", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTUrDQBgA0KuEbz1UBHURb+AFRNIsxswsKvkpSbRC6d2lJ/ACb/9eF8/HaErec7vX3/3hPObT/PqZt/rylD7e376aPJfmsqxlO84YhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhmEYhv3LIkVZhsNUIl1jr+u0Rdtd4yeP3zXayMNUh2U9R4rxNNdoH299ijyOy6WWaLs+xbzs9Z76W/8HeZmww5mAAAA=", "checkText"],
  [283, "gate-probe-r16--p4-time.ts:stray_quote_cands#44; gate-r17-sec--r16-p4-time.ts:stray_quote_cands#44", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTUrDQBgA0KuEbz1UBHURb+AFRNIsxswsKvkpSbRC6d2ll3D19u918XyMpuQ9t3v93R/OYz7Nr595qy9P6eP97avJc2kuy1q244xhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZhGIZh/8YiRVmGw1QiXWOv67RF213jJ4/fNdrIw1SHZT1HivE012gfb32KPI7LpZZouz7FvOz1nvpb/weT5rnB3wABAA==", "checkText"],
  [284, "gate-probe-r16--p4-time.ts:srcset_title#45; gate-r17-sec--r16-p4-time.ts:srcset_title#45", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LQQ7CIBAF0KuYvyYat8R6kcICYWJIoDQwVZOmdzeew796qzfjluvzpFmLTA6jxyE6EUIIIYQQQgghhBBCCCGEEEIIIX+Kw2n0ODmkoMGqfPSylpAXs26PkqPDHQapxXNNMDtUeh2w845XKJvAIsQqsfUVBiUvAns9vEEopb0lwc7eYGkqv+QP/wUgpSmruB8AAA==", "checkText"],
  [285, "gate-probe-r16--p4-time.ts:srcset_title#46; gate-r17-sec--r16-p4-time.ts:srcset_title#46", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTQrCMBRG0a3INw6K02DdSNtBTB4SSH9oUxVK9y6uwzs6o9PqlofnqeZarOm0LnG12gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMD/0um0LrHplEINvtqnXuYS8ujm7VFy7HSXU5rieUhyu6otwyrf7nqFspm8QhwsTsssp5JHk78evVMoZXpbkm97p3Gq9kv90X8Bs5j8Lvk+AAA=", "checkText"],
  [286, "gate-probe-r16--p4-time.ts:srcset_title#47; gate-r17-sec--r16-p4-time.ts:srcset_title#47", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LQWqDQBQA0KuEvx5aupXai6gLq0MRRg06aQMhdy89R9/qrV4X78v6dalLLbnt4zymM9cWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwH+nj8t5TG0f81jHpuZ7fb2WcdnS9fZZlqmPj0gx79PLOkd6RM3HekbTPeJ7LLccTYzTmqf9uEaKsmw5mrfnkGIsZf/JczTdkGLba/5Lw3P4BeRmwxB7fQAA", "checkText"],
  [287, "gate-probe-r16--p4-time.ts:srcset_title#48; gate-r17-sec--r16-p4-time.ts:srcset_title#48", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LS2qEQBQAwKsMby0J2UrMRdSFaZsgtB+0JwkMc/eQe9SqVtXH+7J+3epSS+6GuM505doBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADk2g1xu87UDTFPdWpr/q2vR5mWrTnun2VJQ3xEE/OeXtY5mkfUfK5XtP0jvqdyz9HGlNac9vOIJsqy5WjfnmMTUyn7T56j7ccmtr3m/zQ+xz/C57dWePoAAA==", "checkText"],
  [288, "gate-probe-r16--p4-time.ts:attr_many#49; gate-r17-sec--r16-p4-time.ts:attr_many#49", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMQrCMACG0avIPwfFNVgv0naISZBA0pQ2VaH07uI5/IY3vl63VJ4n1z0AAAAAAAAAAAAAAPh76+K7QcE1Z1v8tMucXZrMvD1y8oPuMgrVn0uQ2dXiUlbZftfL5S3KyvkSfV1mGeU0RdnrMRq5nOs7Btl+NJpqi780HuMXluxLebMfAAA=", "checkText"],
  [289, "gate-probe-r16--p4-time.ts:attr_many#50; gate-r17-sec--r16-p4-time.ts:attr_many#50", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMQqDMACG0auUfw4tXUPtRdQhJqEEEiMa24J499J7fMMbX69HKq+L6yYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC7b6rtBwTVnW/y225Jdms2yTzn5QU8ZheqvJcgcanEtm2x/6O3yHmXlfIm+rouMcpqj7P0cjVzO9RODbD8azbXFfxrP8Qdvzdws8z4AAA==", "checkText"],
  [290, "gate-probe-r16--p4-time.ts:attr_many#51; gate-r17-sec--r16-p4-time.ts:attr_many#51", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTUrDQBgA0KvItx4Ut8F6kTSLaTJIYPJDOtVC6d1Fz/EWb/n6+JiXr5d8ugAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8ux7j6RxTbrlr5d7e9prnNe23S53Hc3xGimkbX5cp0iNaOZZrdP0jvnO9legij0sZt2OPFHVeS3TvzyFFrnX7KVN0/ZBi3Vr5S8Nz+AUXNoy9c30AAA==", "checkText"],
  [291, "gate-probe-r16--p4-time.ts:attr_many#52; gate-r17-sec--r16-p4-time.ts:attr_many#52", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTUrDQBgA0KvItx4Ut8F6kTSLaTJIYPJDOtVC6d3FpXd4i7d8fXzMy9dLPl0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP65HuPpHFNuuWvl3t72muc17bdLncdzfEaKaRtflynSI1o5lmt0/SO+c72V6CKPSxm3Y48UdV5LdO/PIUWudfspU3T9kGLdWvlLw3P4Bb1kgDdz+gAA", "checkText"],
  [292, "gate-probe-r16--p4-time.ts:cont_lookahead_spaces#53; gate-r17-sec--r16-p4-time.ts:cont_lookahead_spaces#53", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XPQrCQBiE4avI1IsiiMVa7Tk2W3zufoTA/oQkmiLk7pJDiBbz9C9MOx5JFrFDkV4vY+0fT5n1fjPOOXciIiIiIqK/19VfLyCi7zteeldhkFo8lwSzYdGpzLB+w1vyS2EhsWhs0wiDPFSFve7BQHJuqyZYHwxqW/SIwh4+L8FQKhEQAAA=", "checkText"],
  [293, "gate-probe-r16--p4-time.ts:cont_lookahead_spaces#54; gate-r17-sec--r16-p4-time.ts:cont_lookahead_spaces#54", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XSwrCMBhF4a3IPw6KIA7iKOtoM4hNKIU8Slt1ULp3Ka5BtPR88wt3eirxbnK6S64Npz63t7sbw/WijDHmAAAAAODv1fnXDwB831rpdabgAQAAgC2j4IE9oOABAACA7aPggT34FLwo8aU5Ji9qlikMaRRdzfJ08RFEi2tSaMrQi5LY5SD6vFglLsbyCl50ZZXkMoV1ZBf7BlDHA+yVLwAA", "checkText"],
  [294, "gate-probe-r16--p4-time.ts:cont_lookahead_spaces#55; gate-r17-sec--r16-p4-time.ts:cont_lookahead_spaces#55", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XTUrDUBiF4a3INw6KIA7iKOtIM7gml1LIT2mrDkr3LsU1iF7u88wPnOnbx5QuqT0saZ+fjuv+7T2d8+tL03Vd9wAAAPx7u/WvHwC/717pu1XBAwBAyRQ81EDBAwBA+RQ81EDBAwBA+RQ81EDBAwBA+RQ81EDBAwBA+RQ81EDBAwBA+RQ81OCn4KOJaRsflymaa1zyaTlH21/jM80fOdpI45LH7XSMJubDmqN9vg1NpHnevvIUbT80sW6XfB8Nt+Ebseda5Z1uAAA=", "checkText"],
  [295, "gate-probe-r16--p4-time.ts:cont_lookahead_spaces#56; gate-r17-sec--r16-p4-time.ts:cont_lookahead_spaces#56", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XvUoDURSF0VeRUw+KIBZjNc+RTDFmLiEwPyGJWoS8uwSfQfRw1+o37PbbxDhchvYwD/vydFz2b+/Duby+NF3XdQ8AAMC/t13++gHw++6Vvl0UPAAAZKbgoQYKHgAA8lPwUAMFDwAA+Sl4qIGCBwCA/BQ81EDBAwBAfgoeaqDgAQAgPwUPNVDwAACQn4KHGih4AADIT8FDDRQ8AADkp+ChBgoeAADyU/BQAwUPAAD5KXiogYIHAID8FDzUQMEDAEB+Ch5qoOABACA/BQ81+Cn4aGJcd4/zGM01LuU0n6PdXONzmD5KtDHs5rJbT8doYjosJdrnW9/EME3rVxmj3fRNLOul3Ef9rf8GLWVVLa3sAAA=", "checkText"],
  [296, "gate-probe-r16--p4-time.ts:backslash_nl_raw#57; gate-r17-sec--r16-p4-time.ts:backslash_nl_raw#57", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPQrCMACG4bt8c1AEcYhTztFkiE0ohfyUWnUovbt4Dt/54RnkleIW7VzjlM9Lm+6P+My3q3HOOe99w3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx//dZZT6eKpJZteW1/qUHXa9Y3llWcWx5rGvi4zK3LLs5QhGsZT+yUl2CEatb/mXwhG+9UrPVbEiAAA=", "checkText"],
  [297, "gate-probe-r16--p4-time.ts:backslash_nl_raw#58; gate-r17-sec--r16-p4-time.ts:backslash_nl_raw#58", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXMkKWaTQYT8iEa3EO8uXsH61Y/XRhdj2Uo+z+VUd5fldPwrt/p7SE3TNF3XLZxzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc/69R4pxHX7mMdIztnqdb5HbZzzKdK+RowxzHdbrJVJM56VG3r/6FGWa1v86Rm77FMu61U/qX/0brUaN6jFFAAA=", "checkText"],
  [298, "gate-probe-r16--p4-time.ts:backslash_nl_raw#59; gate-r17-sec--r16-p4-time.ts:backslash_nl_raw#59", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXMkKWaTQYT8iEa3EO8uHkN49eO10cVYtpLPcznV3WU5Hf/Krf4eUtM0Tdd1C+ecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzvn3eaQY1+FnHiM9Y6vX+Ra5fcajTPcaOcow12G9XiLFdF5q5P2rT1Gmaf2vY+S2T7GsW/2k/tW/AUK6HX4xigAA", "checkText"],
  [299, "gate-probe-r16--p4-time.ts:backslash_nl_raw#60; gate-r17-sec--r16-p4-time.ts:backslash_nl_raw#60", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXMkKWaTQYT8iEa3EO8unsLm1Y/XRhdj2Uo+z+VUd5fldPwrt/p7SE3TNF3XLZxzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnn/NseKcZ1+JnHSM/Y6nW+RW6f8SjTvUaOMsx1WK+XSDGdlxp5/+pTlGla/+sYue1TLOtWP6l/9W+45w+EERQBAA==", "checkText"],
  [300, "gate-probe-r16--p4-time.ts:wrap_nl_after_quote#61; gate-r17-sec--r16-p4-time.ts:wrap_nl_after_quote#61", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniPZYs1+hMD+hBi1CLm72HsBYaZ+plOvFNfopxJHO851vN7jwy5nd/tRr77i8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H/7uXU2rDoSS5Tast5SHfbXrF/DR5xaHY0JZZTnmqJn/ag1PMub0tyXfBqbbVvlPYwweJLrQNfyEAAA==", "checkText"],
  [301, "gate-probe-r16--p4-time.ts:wrap_nl_after_quote#62; gate-r17-sec--r16-p4-time.ts:wrap_nl_after_quote#62", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPQrCQBgG4bu89aIIYrFWniPZYs1+hMD+hBi1CLm72HsCmamf6dQrxTX6qcTRjnMdr/f4sMvZ3X7Uq694PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8fj/9nJKbTiUJLdptaU85LtNr5ifJq84FBvaMsspT9XkT3twijm3tyX5LjjVttp3Cnv4AH6mM+rfQgAA", "checkText"],
  [302, "gate-probe-r16--p4-time.ts:wrap_nl_after_quote#63; gate-r17-sec--r16-p4-time.ts:wrap_nl_after_quote#63", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LO27CQBRA0b28ekSEFFFMKtZhuxjsEULyT8YJBWLvKH2yg3Prc5toYyh7ybepXOvHOl+/LuVeT5/p/EdttDPP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8zzP8/x/PlIMS3+YhkjP2Os23SM3z/gp43eNHKWfar9sa6QYb3ONfHx1Kco4Lo86RG66FPOy19+pe3VvdGapvJ+FAAA=", "checkText"],
  [303, "gate-probe-r16--p4-time.ts:wrap_nl_after_quote#64; gate-r17-sec--r16-p4-time.ts:wrap_nl_after_quote#64", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LO2rDQBRA0b28enAwBBeTyuuQVIylwRj0Q1biwnjvJn3adOfW5zbRxlD2km9TudaPdb5+Xcq9nj7T+Y/aaGee53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me53me5/n/9pFiWPrDNER6xl636R65ecZPGb9r5Cj9VPtlWyPFeJtr5OOrS1HGcXnUIXLTpZiXvf5O3at7A5VxqvfvCgEA", "checkText"],
  [304, "gate-probe-r16--p4b-big.ts:262144#1; gate-probe-r16--p4b-big.ts:262144#2; gate-r17-sec--r16-p4b-big.ts:262144#1; gate-r17-sec--r16-p4b-big.ts:262144#2", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMU7DMBiA0bv8swVCQgyuujBxh5DBJB4qOUnVGlqp6t0RB2Dr+IZv/N4Qc+kl93rtz8dWDuvuq5zr22t6v0wfj+pzpdFoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Gu1/bb+PFPM2PS1zpFv0elrOkYdb/JT2XSNHmZY6badjpGiHtUZ+uY8pSmvbpc6RhzHFuvX6N4338RfaGFQArHkFAA==", "checkText"],
  [305, "gate-probe-r16--p4b-big.ts:262144#3; gate-probe-r16--p4b-big.ts:262144#4; gate-r17-sec--r16-p4b-big.ts:262144#3; gate-r17-sec--r16-p4b-big.ts:262144#4", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMU7DMBiA0bv8swVCQgxGXZi4Q5LBJB4qOUnVGopU9e6IA7AxvuEbvzfEGEvpJff63R9PrRy3149yqS/P6e06v/9X40aj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDTa39rhMEakWPb5YV0i3aLX83qJPNziq7TPGjnKvNZ5P58iRTtuNfLTfUpRWtuvdYk8TCm2vdffabpPP0CR3GyweQUA", "checkText"],
  [306, "gate-probe-r16--p4b-big.ts:262144#5; gate-probe-r16--p4b-big.ts:262144#6; gate-r17-sec--r16-p4b-big.ts:262144#5; gate-r17-sec--r16-p4b-big.ts:262144#6", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPWrDMBgA0Lt8s0gplAwqWTr1DsaDamsIyHZIlB8IuXvpMQpveOMbYi695F4f/e3UynH9/CmXuv9IX/fpGwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/rfDIVLM27Rb5kjP6PW8XCIPz7iVdq2Ro0xLnbbzKVK041ojv7/GFKW17V7nyMOYYt16/Uvja/wFrUji6L5VBQA=", "checkText"],
  [307, "gate-probe-r16--p4b-big.ts:524288#7; gate-probe-r16--p4b-big.ts:524288#8; gate-r17-sec--r16-p4b-big.ts:524288#7; gate-r17-sec--r16-p4b-big.ts:524288#8", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMUoDQRiA0bv89aAEgsWIjVXusG4x7k4RmN0NyWiEkLsH7yDYvOIrvzfEXHrJvf7051Mrx/X1s1zqyz69X6fDX/Wx0mg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDTav2tvkWLepqdljnSLXs/LJfJwi+/SvmrkKNNSp+18ihTtuNbIu/uYorS2XesceRhTrFuvv9N4Hx9vnpks7vIKAA==", "checkText"],
  [308, "gate-probe-r16--p4b-big.ts:524288#9; gate-probe-r16--p4b-big.ts:524288#10; gate-r17-sec--r16-p4b-big.ts:524288#9; gate-r17-sec--r16-p4b-big.ts:524288#10", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMUrEQBiA0bv89aAIYjFiY+UdkhRjMsXCJFl2R3dh2buLdxBsXvGV3xtijKX0knu99sdjK4ft9bOc68tzer/MH3/VuNFoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg02r9rb2NEimWfH9Yl0i16Pa3nyMMtvkv7qpGjzGud99MxUrTDViM/3acUpbX9UpfIw5Ri23v9nab79AMJ8gCU8vIKAA==", "checkText"],
  [309, "gate-probe-r16--p4b-big.ts:524288#11; gate-probe-r16--p4b-big.ts:524288#12; gate-r17-sec--r16-p4b-big.ts:524288#11; gate-r17-sec--r16-p4b-big.ts:524288#12", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LMWrDMBQA0Lv8WbQESgeVLp1yB+NBtTUEZDskSlIIuXvoKbK84Y1viLn0knv96+/HVg7r128518+P9HOb9gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvNR3pJi36W2ZI92j19Nyjjzc41rapUaOMi112k7HSNEOa428e4wpSmvbrc6RhzHFuvX6n8bH+ARgru2lEqsKAA==", "checkText"],
  [310, "gate-probe-r16--p4b-big.ts:1048576#13; gate-probe-r16--p4b-big.ts:1048576#14; gate-r17-sec--r16-p4b-big.ts:1048576#13; gate-r17-sec--r16-p4b-big.ts:1048576#14", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMWrDMBiA0bv8s2golA4KWTr1Dq4H1dYQkO2QqE0g5O6ld8j4hm/83hBz6SX3euu7UyvHdf9dLvX9LX1cp89n9bXSaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9Geqx0OkWLeppdljnSPXs/LJfJwj9/SfmrkKNNSp+18ihTtuNbIr48xRWltu9Y58jCmWLde/6fxMf4BSUcK+3blFQA=", "checkText"],
  [311, "gate-probe-r16--p4b-big.ts:1048576#15; gate-probe-r16--p4b-big.ts:1048576#16; gate-r17-sec--r16-p4b-big.ts:1048576#15; gate-r17-sec--r16-p4b-big.ts:1048576#16", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMU7DMBiA0bv8swVCQgxGXZi4Q5LBJB4qOUnVGopU9e6IO3R8wzd+b4gxltJL7vW3P59aOW7vX+VS317Tx3X+fFTjRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Ge6x2OIwRKZZ9flqXSLfo9bxeIg+3+Cntu0aOMq913s+nSNGOW438cp9SlNb2a10iD1OKbe/1f5ru0x87NxcQeuUVAA==", "checkText"],
  [312, "gate-probe-r16--p4b-big.ts:1048576#17; gate-probe-r16--p4b-big.ts:1048576#18; gate-r17-sec--r16-p4b-big.ts:1048576#17; gate-r17-sec--r16-p4b-big.ts:1048576#18", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LPWrDMBgA0Lt8s0gplAwqWTr1DsaDamsIyHZIlB8IuXvpOfqGN74h5tJL7vXR306tHNfPn3Kp+4/0dZ++AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOB/OxwixbxNu2WO9Ixez8sl8vCMW2nXGjnKtNRpO58iRTuuNfL7a0xRWtvudY48jCnWrde/NL7GX1agWMy+VRUA", "checkText"],
  [313, "gate-probe-r16--p4b-big.ts:2097152#19; gate-probe-r16--p4b-big.ts:2097152#20; gate-r17-sec--r16-p4b-big.ts:2097152#19; gate-r17-sec--r16-p4b-big.ts:2097152#20", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMU7DMBiA0bv8swWqVDEYsTD1DiGDSTxUcpKqNRSp6t0r7sDGG77xe0PMpZfc609/PrVyXF8/y6W+7NP7dTr8VR8rjUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go32b7S3SDFv09MyR7pFr+flEnm4xXdpXzVylGmp03Y+RYp2XGvk3X1MUVrbrnWOPIwp1q3X32m8jw88SLuwgsorAA==", "checkText"],
  [314, "gate-probe-r16--p4b-big.ts:2097152#21; gate-probe-r16--p4b-big.ts:2097152#22; gate-r17-sec--r16-p4b-big.ts:2097152#21; gate-r17-sec--r16-p4b-big.ts:2097152#22", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3MMU7DMBiA0bv8swVCQgxGLEzcIclgEg+VnKRqDa1U9e6IO7Dxhm/83hBjLKWX3Ou1Px5bOWyvn+VcX57T+2X++KvGjUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1G+zfa2xiRYtnnh3WJdIteT+s58nCL79K+auQo81rn/XSMFO2w1chP9ylFaW2/1CXyMKXY9l5/p+k+/QAB5hVRhsorAA==", "checkText"],
  [315, "gate-probe-r16--p4b-big.ts:2097152#23; gate-probe-r16--p4b-big.ts:2097152#24; gate-r17-sec--r16-p4b-big.ts:2097152#23; gate-r17-sec--r16-p4b-big.ts:2097152#24", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3LMWrDMBQA0Lv8WbQESgeVLp1yB+NBtTUEZDskSlIIuXvoOfKGN74h5tJL7vWvvx9bOaxfv+VcPz/Sz23aAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8NK+I8W8TW/LHOkevZ6Wc+ThHtfSLjVylGmp03Y6Rop2WGvk3WNMUVrbbnWOPIwp1q3X/zQ+xicbFd/1EqsqAA==", "checkText"],
  [316, "gate-probe-r16--p5-quote.ts:brief_case#1; gate-r17-sec--r16-p5-quote.ts:brief_case#1; gate-r17-sec--r16-p5-quote.ts:brief_case#2; gate-r17-sec--r16-p5-quote.ts:brief_case#3", "quiet", "private", "private", "H4sIAAAAAAAAA3XLsQrCMBQF0F+ROwdFEIeIg5NOHVs0yfCavCHykpQ2VqH038UPcD4cA4tAlXTlT90NQjGfepr4eFD+1sb+Ks/NH793TbX50TWzz5ezBRRC8dsUoBZUHtMEbRbMJC+GBvnEvowDFCRmht6vToFEypsDtHEKuVT+Jbe6L3PJmhyYAAAA", "checkText"],
  [317, "gate-probe-r16--p5-quote.ts:three_cands#2; gate-r17-sec--r16-p5-quote.ts:three_cands#4; gate-r17-sec--r16-p5-quote.ts:three_cands#5; gate-r17-sec--r16-p5-quote.ts:three_cands#6", "quiet", "private", "private", "H4sIAAAAAAAAA53LsQrCMBQF0F+ROwdFEIeIg5NOHVs0yfCavCHykpQ2VqH038VfcD4cA4tAlXTlT90NQjGfepr4eFD+1sb+Ks/Nn37vmmrzo2tmny9nCyiE4rcpQC2oPKYJ2iyYSV4MDfKJfRkHKEjMDL1fnQKJlDcHaOMUcqn8S251X8uzlba4AAAA", "checkText"],
  [318, "gate-probe-r16--p5-quote.ts:backtick#3; gate-r17-sec--r16-p5-quote.ts:backtick#7; gate-r17-sec--r16-p5-quote.ts:backtick#8; gate-r17-sec--r16-p5-quote.ts:backtick#9", "quiet", "private", "private", "H4sIAAAAAAAAA3XLsQrCMBAG4FeRfw6KIA4RByedOlo0BnpNbqhcktKeVSh9d/EBnD8+hyaSklX+6KYX6vKhpZH3OxMu1649y3P1x291pY98r6sp5NOxgUEsYZ0izAzlIY2wbsZE8mJYUEgcytDDQLrMsNvFG5BIeXOEdd4gF+Vf8ov/AuIqSdqWAAAA", "checkText"],
  [319, "gate-probe-r16--p5-quote.ts:lead_text#4; gate-r17-sec--r16-p5-quote.ts:lead_text#10; gate-r17-sec--r16-p5-quote.ts:lead_text#11; gate-r17-sec--r16-p5-quote.ts:lead_text#12", "quiet", "private", "private", "H4sIAAAAAAAAA3XLvQrCMBQG0FeRbw6KIA4RByedOrZomuE2uUMkP6W5VqH03cUHcD4cgx6VeeNJSAt/ZDdGCvk0UOXjQblbG4ZrfP7ze9dInx9dM7t8OfeAgi9umzzUAuEpVWizYKb4YmiQS+zKNEIhhszQ+9UqUIzlzR7aWIVchH/JrvYLypmrN5wAAAA=", "checkText"],
  [320, "gate-probe-r16--p5-quote.ts:lead_text_single#5; gate-r17-sec--r16-p5-quote.ts:lead_text_single#13; gate-r17-sec--r16-p5-quote.ts:lead_text_single#14; gate-r17-sec--r16-p5-quote.ts:lead_text_single#15", "quiet", "quiet", "private", "H4sIAAAAAAAAAxXLTQrCMBAG0KvItx4qgriIuPAC3RabZDEmsyjkpzRjFUrvLn37Z+HQRE6RlY3KT89z4qnc39zkdqXX0Ksr49CvoTwfDiDEGrocQRtUltxg7IaV00dgwCFLqMsMQpqKwFx2T+CU6lcijPWEUlWO5Hf/Bw0jKh98AAAA", "checkText"],
  [321, "gate-probe-r16--p5-quote.ts:tail76_in_quote_lead#6; gate-r17-sec--r16-p5-quote.ts:tail76_in_quote_lead#16; gate-r17-sec--r16-p5-quote.ts:tail76_in_quote_lead#17; gate-r17-sec--r16-p5-quote.ts:tail76_in_quote_lead#18", "quiet", "quiet", "private", "H4sIAAAAAAAAA63OuwrCQBBG4VeRv14UIViMlZ0gpA26u8W4O2BgLyEZoxDy7qLPYHHKD46FQ6kqtImsTCpv3Q2J+3K88ySHxsj50fwrV65dq7eunUM5XRxgEGvY5gizQGXME8gumDk9BQQOWUIdBxikvghov3oDTqm+JIKsN7/1L/Kr/wBUmbBwygAAAA==", "checkText"],
  [322, "gate-probe-r16--p6-mime.ts:sp_before_mime#1; gate-probe-r16--p6-mime.ts:sp_before_mime#2; gate-r17-sec--r16-p6-mime.ts:sp_before_mime#1; gate-r17-sec--r16-p6-mime.ts:sp_before_mime#2; gate-r17-sec--v3-p6-mime.ts:sp_before_mime#1; gate-r17-sec--v3-p6-mime.ts:sp_before_mime#2; gate-r17-sec--v3-p6-mime.ts:sp_before_mime#3", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX6U516RKSq3SeHFABH+K7m7X1houVthuqQtYtCIa373Z3sxMvmRmNpCJo3Dv8kIo2dmX6nkrDrLnWPnKW9CmOwtVhYgYM/4VcGViYMTzcW38c5yyqQn4HjPanWB9cNIeMYCWhNseon/+bk79NeEGVlLTdRbEp+2brbclQYzytG07S9bajAWXxSt/WMzbPWH+mc5enibzdhdi+EP8+PwTDZYzMzLiOiAr6pTh0rn0R03U4Bgx6uQfu0H0/+1NKX8M6t1UKTUcggVZld4XGVhXOMq6OIC7ucJJ6F8JLoi0kGlV78ECnZcSXPuWWCC0rhqZgbtJLCirozSl5Jb8AeqsXycyAQAA", "checkText"],
  [323, "gate-probe-r16--p6-mime.ts:tab_before_mime#3; gate-probe-r16--p6-mime.ts:tab_before_mime#4; gate-r17-sec--r16-p6-mime.ts:tab_before_mime#3; gate-r17-sec--r16-p6-mime.ts:tab_before_mime#4; gate-r17-sec--v3-p6-mime.ts:tab_before_mime#4; gate-r17-sec--v3-p6-mime.ts:tab_before_mime#5; gate-r17-sec--v3-p6-mime.ts:tab_before_mime#6", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3XKCMBSE3+VcM1Wm1CodLw6I4E9RksbWWi4ipCk1gCKK6PjunfRmd+eb2d0NpLzm9led5VyKzr6QL1t+FD3LyFbOgjTdmS9LRMSQsh+PSR09LY6La+3f44ROdcCPkJLuBKujlfQiDUgRMdNBdC+/zbm/jpiGpVBknXrheftuqm0RIQZZ0radJW1NSr3r4o09LubtPqLuhcxenyfzduejf4jc8HIIBsuZHhkx5UUrYhX+0rr2R03Q4Bgx6GSfu0Hw/+1MCXvyqt1USjkcggFpmTzkKRg3qEWVH8He3ODM1UmADTzJRVJWezBAZYUA27zHBnClykakYG9iA4qyFroU3+M/56JHUDMBAAA=", "checkText"],
  [324, "gate-probe-r16--p6-mime.ts:sp_after_mime#5; gate-probe-r16--p6-mime.ts:sp_after_mime#6; gate-r17-sec--r16-p6-mime.ts:sp_after_mime#5; gate-r17-sec--r16-p6-mime.ts:sp_after_mime#6; gate-r17-sec--v3-p6-mime.ts:sp_after_mime#7; gate-r17-sec--v3-p6-mime.ts:sp_after_mime#8; gate-r17-sec--v3-p6-mime.ts:sp_after_mime#9", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX6U516RKSq3SeHFABH+K7m7X1houVthuqQtYtCIa373Z3sxMvmRmNpCJo3DzQijZ2Zfq7nkrDrLnWPnKW9CmOwtVhYgYM/4VcGViYMTzcW38c5yyqQn4HjPanWB9cNIeMYCWhNseon/+bk79NeEGVlLTdRbEp+2brbclQYzytG07S9bajAWXxSt/WMzbPWH+mc5enibzdhdi+EP8+PwTDZYzMzLiOiAr6pTh0rn0R03U4Bgx6uQfu0H0/+1NKX8M6t1UKTUcggVZld4XGVhXOMq6OIC7ucJJ6F8JLoi0kGlV78ECnZcSXPuWWCC0rhqZgbtJLCirozSl5Jb8ATHlP7AyAQAA", "checkText"],
  [325, "gate-probe-r16--p6-mime.ts:sp_around_param#7; gate-probe-r16--p6-mime.ts:sp_around_param#8; gate-r17-sec--r16-p6-mime.ts:sp_around_param#7; gate-r17-sec--r16-p6-mime.ts:sp_around_param#8; gate-r17-sec--v3-p6-mime.ts:sp_around_param#10; gate-r17-sec--v3-p6-mime.ts:sp_around_param#11; gate-r17-sec--v3-p6-mime.ts:sp_around_param#12", "private", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX8Wca1IlpVZpvDgggj8Fd7fYWsPFCtstdQFFK6Lx3ZvtzczkS2ZmAxk/cTsvuBTdfSlfOlt+FH2rY+QrJ6JNb+7LChExZPG3F0sdPS2Oi2vtX5OUzXTAj5DR3hTro5X2iQa0JLHpILqXn+Y8WJNYw0oous688Lx9N9W2JIhBnrZtd8lakzHvGr3Fj9Gi3RPmXuj89Xm6aHc++gfihpdDMFzO9cg4Vh5ZUav0l9Z1MG6CBieIQTf/3A2D/29nRuMnr97NpJSjERiQVelDkYFxg5OoiyPYmxucufoVYANPC5FW9R4MUHkpwDbviQFcqaoRGdibxICyOgldSu7JH/QRFAUzAQAA", "checkText"],
  [326, "gate-probe-r16--p6-mime.ts:sp_charset#9; gate-probe-r16--p6-mime.ts:sp_charset#10; gate-r17-er--a1.ts:sp_charset#1; gate-r17-er--a1.ts:sp_charset#2; gate-r17-er--a1.ts:sp_charset#3; gate-r17-sec--r16-p6-mime.ts:sp_charset#9; gate-r17-sec--r16-p6-mime.ts:sp_charset#10; gate-r17-sec--v3-p6-mime.ts:sp_charset#13; gate-r17-sec--v3-p6-mime.ts:sp_charset#14; gate-r17-sec--v3-p6-mime.ts:sp_charset#15", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FeRb74qikhN6ZzZxSVkuE2uWkib0tz6Q+m7i2c/DpGVjcpH92PibqjDk6ci2sx631abuuUi5xOxvZXWVo94vHxbe21AiDns+ghaoDL1BcYteHGaBQYcegl5GkFI3SAwh9UTOKX8lgjjPGHIKv/kV/8DV8FLe4UAAAA=", "checkText"],
  [327, "gate-probe-r16--p6-mime.ts:prose_types_space#11; gate-probe-r16--p6-mime.ts:prose_types_space#12; gate-r17-sec--r16-p6-mime.ts:prose_types_space#11; gate-r17-sec--r16-p6-mime.ts:prose_types_space#12; gate-r17-sec--v3-p6-mime.ts:prose_types_space#16; gate-r17-sec--v3-p6-mime.ts:prose_types_space#17; gate-r17-sec--v3-p6-mime.ts:prose_types_space#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAz3LPQrDMAwG0KuEbxYJXbX1HMaDkFTj4j9Stx1C7l4KpdtbXsBV1cd0W0ym8JKrJN9GS/TjffjfKd9AsK5rNdCB6Xt9gMOBl5SngyFaXfs+QCi5OfhyRoKU0t9u4BAJrU//pnjGD5DRu3t+AAAA", "checkText"],
  [328, "gate-probe-r16--p6-mime.ts:prose_types_space2#13; gate-probe-r16--p6-mime.ts:prose_types_space2#14; gate-r17-sec--r16-p6-mime.ts:prose_types_space2#13; gate-r17-sec--r16-p6-mime.ts:prose_types_space2#14; gate-r17-sec--v3-p6-mime.ts:prose_types_space2#19; gate-r17-sec--v3-p6-mime.ts:prose_types_space2#20; gate-r17-sec--v3-p6-mime.ts:prose_types_space2#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLPQrDMAwG0KuEbxYNXX2MrsaDsDW4yJKJ1R8IuXvp21/GQ9Z0W7I1Dk4bz6m9cnS3/bncaAv5xj6Vu4HQvN5GA50IOcZCyiferC9BAtch1Y8JgnYTpPtVCKzqH2lIuRDMQ/6pXOUHpveU0HoAAAA=", "checkText"],
  [329, "gate-probe-r16--p6-mime.ts:prose_types_space3#15; gate-probe-r16--p6-mime.ts:prose_types_space3#16; gate-r17-sec--r16-p6-mime.ts:prose_types_space3#15; gate-r17-sec--r16-p6-mime.ts:prose_types_space3#16; gate-r17-sec--v3-p6-mime.ts:prose_types_space3#22; gate-r17-sec--v3-p6-mime.ts:prose_types_space3#23; gate-r17-sec--v3-p6-mime.ts:prose_types_space3#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx3LPQrDMAwG0KuIbxYNXX2DnsF4ELaGgm0ZR/mBkLuXZn8v4tPH5lTEJZDr6UtedybrStMOGjqpfruCUSy/WgFfcJ1tRYgXdqmbIkBy02xzgPHo8L4TQ2q1QwtCTIxurv+U7vQD7rnQxHUAAAA=", "checkText"],
  [330, "gate-probe-r16--p6-mime.ts:yaml_types#17; gate-probe-r16--p6-mime.ts:yaml_types#18; gate-r17-sec--r16-p6-mime.ts:yaml_types#17; gate-r17-sec--r16-p6-mime.ts:yaml_types#18; gate-r17-sec--v3-p6-mime.ts:yaml_types#25; gate-r17-sec--v3-p6-mime.ts:yaml_types#26; gate-r17-sec--v3-p6-mime.ts:yaml_types#27", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyXLOw7CMBAFwKugVy9BtHsVx8Vq/WQF+adgoIhyd4ToppkAc+eY12TT9LJVy7yNluWvx2BeGwSp+1IT5MDkXp/QcOBt5UUozCu97wOCsjVC72cUWCn9wwQNUdD65C/FM34BQjUgrXIAAAA=", "checkText"],
  [331, "gate-probe-r16--p6-mime.ts:prose_types_nospace#19; gate-probe-r16--p6-mime.ts:prose_types_nospace#20; gate-r17-sec--r16-p6-mime.ts:prose_types_nospace#19; gate-r17-sec--r16-p6-mime.ts:prose_types_nospace#20; gate-r17-sec--v3-p6-mime.ts:prose_types_nospace#28; gate-r17-sec--v3-p6-mime.ts:prose_types_nospace#29; gate-r17-sec--v3-p6-mime.ts:prose_types_nospace#30", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyXLOwrDMBAFwKuYVy8xabfLOYSKZfUQDvphK0lhfPcQ0k0zAQ93jsm0JJumW7XMdbQsy5/PwQxB6n6rCXJicq8HNJx4W3kRCvNK7/uAoGyN0PsVBVZK/zBBQxS0PvlL8YpfQXg9tnIAAAA=", "checkText"],
  [332, "gate-probe-r16--p6-mime.ts:sse_field#21; gate-probe-r16--p6-mime.ts:sse_field#22; gate-r17-sec--r16-p6-mime.ts:sse_field#21; gate-r17-sec--r16-p6-mime.ts:sse_field#22; gate-r17-sec--v3-p6-mime.ts:sse_field#31; gate-r17-sec--v3-p6-mime.ts:sse_field#32; gate-r17-sec--v3-p6-mime.ts:sse_field#33", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLQQrCMBAF0KuUv46KO4l4kjSLIRlpYTIJ6aQKpXcX3/4F8M5qfhotk/GsmYz8ZPy1WxNa9ZkW6hvba9j78nALi9RZ4ZBrupYMd8C4lw0+HNhJBsODUuFUe4ODrMrw9zM6kEj9cIYP0UGr8T/FM/4ApU+YI4QAAAA=", "checkText"],
  [333, "gate-probe-r16--p6-mime.ts:sse_json#23; gate-probe-r16--p6-mime.ts:sse_json#24; gate-r17-sec--r16-p6-mime.ts:sse_json#23; gate-r17-sec--r16-p6-mime.ts:sse_json#24; gate-r17-sec--v3-p6-mime.ts:sse_json#34; gate-r17-sec--v3-p6-mime.ts:sse_json#35; gate-r17-sec--v3-p6-mime.ts:sse_json#36", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLPQ7DIAwG0Kugb7ZaZfVVMIMDHirxE6WkTYS4e5TxDc8jaVd2Q9CvzQTsBPpeBeQE5+NlSgUhtfgqCTTQbS9fsB/4aT4MDI3FYts3EPKnGniZgaA5t78lsA+E2ro9KcxwA4CcIX50AAAA", "checkText"],
  [334, "gate-probe-r16--p6-mime.ts:sse_plain_semicolon#25; gate-probe-r16--p6-mime.ts:sse_plain_semicolon#26; gate-r17-sec--r16-p6-mime.ts:sse_plain_semicolon#25; gate-r17-sec--r16-p6-mime.ts:sse_plain_semicolon#26; gate-r17-sec--v3-p6-mime.ts:sse_plain_semicolon#37; gate-r17-sec--v3-p6-mime.ts:sse_plain_semicolon#38; gate-r17-sec--v3-p6-mime.ts:sse_plain_semicolon#39", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLQQqEMAwF0KvIXwfBbeYonS5CE5iBtJFadSHeXXz7l6AyhKefucdnOqO7fhsIGmWuCrowrNcNnC4c4ruBIaVaib6C4P9m4OXOBHGP0xScMqHFsDflOz8UDSb4YwAAAA==", "checkText"],
  [335, "gate-probe-r16--p6-mime.ts:log_line#27; gate-probe-r16--p6-mime.ts:log_line#28; gate-r17-sec--r16-p6-mime.ts:log_line#27; gate-r17-sec--r16-p6-mime.ts:log_line#28; gate-r17-sec--v3-p6-mime.ts:log_line#40; gate-r17-sec--v3-p6-mime.ts:log_line#41; gate-r17-sec--v3-p6-mime.ts:log_line#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ35wodZJI14KLLjqVDJfkioH81CS1Yum7i2c/I86X4SoKv2auTThqpAVNU/CWms9p/1HLsqhHLlHNJXCy2bE7CfukUrn199ugjlJU/+W+O0DCZbuLDnJF4xIr9LjiTWFmaJCNbHOZIBF8YuhuMxIUQl7YQY9GIuXG/2Q28wNDWVlumwAAAA==", "checkText"],
  [336, "gate-probe-r16--p7-gif.ts:gif_term_inside#1; gate-probe-r16--p7-gif.ts:gif_term_inside#2; gate-r17-sec--r16-p7-gif.ts:gif_term_inside#1; gate-r17-sec--r16-p7-gif.ts:gif_term_inside#2; gate-r17-sec--v3-p7-gif.ts:gif_term_inside#1; gate-r17-sec--v3-p7-gif.ts:gif_term_inside#2; gate-r17-sec--v3-p7-gif.ts:gif_term_inside#3", "private+refusal", "private", "private", "H4sIAAAAAAAAA8WOwQqCQBQA/+VdW1oTCdro8FTILpWdNPGwrS+VVjfUEhH/PcSPaGCOA5NAJjspykrmxPPyuX/IlrYOu1n6ePF1gSG6eMKFK+d8CFYqKhwK/m4R2xsd27tBee5wj84Wev3yOT8jevgKXfTbAzDIjFpXGbAROmqqFkQywlfqD4EAqSpSpnkDA13WBGIzpQyk1qanDESSMqhNR3OUTukPvdJdATEBAAA=", "checkText"],
  [337, "gate-probe-r16--p7-gif.ts:gif_term_straddle_255#3; gate-probe-r16--p7-gif.ts:gif_term_straddle_255#4; gate-r17-sec--r16-p7-gif.ts:gif_term_straddle_255#3; gate-r17-sec--r16-p7-gif.ts:gif_term_straddle_255#4; gate-r17-sec--v3-p7-gif.ts:gif_term_straddle_255#4; gate-r17-sec--v3-p7-gif.ts:gif_term_straddle_255#5; gate-r17-sec--v3-p7-gif.ts:gif_term_straddle_255#6", "refusal", "quiet", "private", "H4sIAAAAAAAAA+2RQU+DMBhA/8t3tbEbTBMxHtotDjhMgSWEEQ4t/SzVUsiKI2bZfzfL/oJHX/KO7/RqUGISkemFRqrNx7MUHh9XJF/Y7dvGdixjnCXsxjul9Ce+o2G3wvjfv7Iqd9Nhn3/KMJ2TOLVtmGkZVLoquJfBg0u2u5Msl1a6TKswHVWcW2m4wYJ30vBRlq/uUPCFDJ48W8+3V9dvjK3ZV8bZxr8AATW0970CcoYJj72HqD7DSdhvhAhE22M7HEcgYI1DiJaXhoCwdphRQVQ3BNww4TVqLs0v6MW0LDUCAAA=", "checkText"],
  [338, "gate-probe-r16--p7-gif.ts:brief_gif#5; gate-probe-r16--p7-gif.ts:brief_gif#6; gate-r17-sec--r16-p7-gif.ts:brief_gif#5; gate-r17-sec--r16-p7-gif.ts:brief_gif#6; gate-r17-sec--v3-p7-gif.ts:brief_gif#7; gate-r17-sec--v3-p7-gif.ts:brief_gif#8; gate-r17-sec--v3-p7-gif.ts:brief_gif#9", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAyWLywrCMBQF/+Wsg1HwAXF1g6IFQe02ZBGbay0kjbRVkdJ/F9vZzcAYeNc5VUVXsiyr+/bmWl4vRT4Ph/MuPOhKmjKauEgpv8eVpv2op6lqGj3TOdEGAj4Vs+ghenTcxBbK9Hi78GIouCJykZonBEJVM9RisAIuhPRhD2WsQJ06/k92sD/9lznQnQAAAA==", "checkText"],
  [339, "gate-probe-r16--p7-gif.ts:brief_webp#7; gate-probe-r16--p7-gif.ts:brief_webp#8; gate-r17-sec--r16-p7-gif.ts:brief_webp#7; gate-r17-sec--r16-p7-gif.ts:brief_webp#8; gate-r17-sec--v3-p7-gif.ts:brief_webp#10; gate-r17-sec--v3-p7-gif.ts:brief_webp#11; gate-r17-sec--v3-p7-gif.ts:brief_webp#12", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQqDMBQG0Hf55tAfkA4pDrcgtp2q1FKQDDG5WGliRK0O4rsXl7OdElaPWjZe17yfuerOlR74FIni69L8E4jo8s6Le/ZyFD3pQEQ0bSRksiRPb80juhLFMQRsMDtvIRaM3PsBslwwafdjSGjj2YS+g4BrWoY8rkpAOxdmtpClEmjDyFtSq/oDTmCOGJYAAAA=", "checkText"],
  [340, "gate-probe-r16--p7-gif.ts:utf16_bom#9; gate-probe-r16--p7-gif.ts:utf16_bom#10; gate-r17-sec--r16-p7-gif.ts:utf16_bom#9; gate-r17-sec--r16-p7-gif.ts:utf16_bom#10; gate-r17-sec--v3-p7-gif.ts:utf16_bom#13; gate-r17-sec--v3-p7-gif.ts:utf16_bom#14; gate-r17-sec--v3-p7-gif.ts:utf16_bom#15", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLsQ6CMBQF0H+5c5WQKEMJQ13kBxwI6fBsn0osLaEPMSH8u/Hsp4cnIS38lWIKNMTavWjOLM0ij0NZ1XfKXJ1UUZxX095M97xkc32bbjUNFHxyx9FDbRCexwzdb/hQWBga5EZ2aZ6gEIbI0OVuFSiEtLKH7q1CTML/ZHf7A8LkwfyJAAAA", "checkText"],
  [341, "gate-probe-r16--p7-gif.ts:utf16_term#11; gate-probe-r16--p7-gif.ts:utf16_term#12; gate-r17-sec--r16-p7-gif.ts:utf16_term#11; gate-r17-sec--r16-p7-gif.ts:utf16_term#12; gate-r17-sec--v3-p7-gif.ts:utf16_term#16; gate-r17-sec--v3-p7-gif.ts:utf16_term#17; gate-r17-sec--v3-p7-gif.ts:utf16_term#18", "private+refusal", "private", "private", "H4sIAAAAAAAAAx3LsQ6CMBQF0H+5c5WQKEOJw2MBBwdn0uHRPgOxUAJFNIR/Nzqd6dRwHFlHecdk9NwNuW15miVelvg4pFne8CzZSSXJOVD5pCsVLZU3au6F/7sWH6qIoOCCPfYOakOUqZ+h6w0v9otAg20vNkwjFHw3CHS6GwX2PqzioGujMIQov2R28wW6KiZElQAAAA==", "checkText"],
  [342, "gate-probe-r16--p7-gif.ts:del_byte#13; gate-probe-r16--p7-gif.ts:del_byte#14; gate-r17-sec--r16-p7-gif.ts:del_byte#13; gate-r17-sec--r16-p7-gif.ts:del_byte#14; gate-r17-sec--v3-p7-gif.ts:del_byte#19; gate-r17-sec--v3-p7-gif.ts:del_byte#20; gate-r17-sec--v3-p7-gif.ts:del_byte#21", "quiet", "refusal", "refusal", "H4sIAAAAAAAAAxXLvQrCMBQG0Hf55otSkQ4RZzsLOhgy3CZXiNz80KYqlL67ePZjEbixafJt+6oc82nkWfoj+eEex4u+nodHleHa+XQ7gxCK36UAWtFkSjOMXfFmXQQG7JP4MlUQNGaB6TZHYNXykQBjHSGXJv/kNvcDpfiMKXoAAAA=", "checkText"],
  [343, "gate-probe-r16--p7-gif.ts:call#15; gate-r17-sec--r16-p7-gif.ts:call#15", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+2RsW6DMBQA/+WttUoC7VBLHexEDTCkBSohghh48AC3jkGYBFWIf6+i/ELHnnTjTZcvgJemoRE4xBt9eN/rTkRCikDc+XAc58d/cLzuifx//8osPU6nz/gLvXAO/FBXXtSim7VZIi26zyY4HK+YbjWaqK29cKj9WKOSihLZoZIDpm/mlMgNui9W7Ob7q9s3IXbiO5Jib19hZTCo6rFVDbAFJhrPFni+wLXUFwIOZXWmqh8HYKCVIeDbtWBQat3PVAPPCwamn+gWFStrSm2p+AXs8lOPMQIAAA==", "checkBuffer"],
  [344, "gate-probe-r16--p8-more.ts:srcset_wrapped_q#1; gate-r17-sec--r16-p8-more.ts:srcset_wrapped_q#1; gate-r17-sec--r16-p8-more.ts:srcset_wrapped_q#2; gate-r17-sec--r16-p8-more.ts:srcset_wrapped_q#3", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX8Wca1IlpVZpbXJABH+KAl1bK1wgbLdUWBCogMZ3b7Y3M5MvmZk9PCcZ61VlVNF64kMc1qGaZCGj/YKzp0NY0aEiJVtt7TaDpclyRETbI98GYSIaQjQdd8K/ZpG3EAE/bM8dzLGslGjoCOByh8gaot76/Kc5j3YOETinqbuLDft8eJfTA3cQrSTquv7G62TPMy7rN3K/XnWF4+mtu3x9nK+6o4nmydHt9mSNN0ufi5kpSQ1n6yrc3CiX0bSxGpwhWv3k8zi2/v+1hUsejPK4YIxNJj259eEFJIjz6C6LQbpCTcusAnV/hXOY/lJQIYwyGuVlARKkCaegyrdAgjBN84bGoO4DCXheU1EKbsEf+RYHm0kBAAA=", "checkText"],
  [345, "gate-probe-r16--p8-more.ts:srcset_wrapped_unq#2; gate-r17-sec--r16-p8-more.ts:srcset_wrapped_unq#4; gate-r17-sec--r16-p8-more.ts:srcset_wrapped_unq#5; gate-r17-sec--r16-p8-more.ts:srcset_wrapped_unq#6", "quiet", "private", "private", "H4sIAAAAAAAAAx2NYVOCQBiE/0rzfmZSJjKlbOYFEdRCDzrLlA8I10UehwKJ6Pjfm+vL7s4zs7treMpyflOVScXqYRrXsZnlMWedveSP27hiPUPLltY8aLozlxeIiH5Ivx3KVXSUWDaulH+Nk3CqAn74YdCdYFkZSY8oEEhCdQvRPm3kT3PsrwhVuGAiWKWOf9y+62IrCaKXJW3bWYStHobOef5G7+Yv7Z6E9imYvT5MXtqdi+6B2P7p4A0Ws41UMyMqHLIMDOkujHN/1HgNjhG9Tva5G3j//9Y0oPdOuZtyzofDZ9AgLZLbPAXtAjUr8wrM9QWOsfhlYEKc5Cwpyj1oIDLJwNSvkQaxEEXDUjDXkQayqJkqRdfoDz6RNStCAQAA", "checkText"],
  [346, "gate-probe-r16--p8-more.ts:xml_elem#3; gate-r17-sec--r16-p8-more.ts:xml_elem#7; gate-r17-sec--r16-p8-more.ts:xml_elem#8; gate-r17-sec--r16-p8-more.ts:xml_elem#9", "quiet", "private", "private", "H4sIAAAAAAAAAx2P3W6CQBCFX6WZa1IkpVapNhkQwZ+isMXWKhcrbLfUZVG0IhrfvdnezJzMyflyZgW9vOAva3l3l9EjtfKCcqbvJH/e0ANrm5py8oU9i+rWxOMlImJA4m835kq6atgOLtX+GqZkrAR+BCRqjbA6mGk7VIdIhrFhIzpnxfupT51lGCujZCJaZm5w2rwbYiNDRD9Pm0afk8YgxL3M3uKH2bTZhcQ5R5PXp9G02Xro7UMnOO/97nyieAo0iIUbLiJTenPz0hnUfo1DRF/PP7dd/7+DPY7iR7fajjnn/f5a9nT1OWiQlel9kYF2hSOrigNYqyucqPhlYAFNC5aW1Q40ELlkYBm3RAMqRFmzDKxVooEsj0yFklvyB2f3z5dOAQAA", "checkText"],
  [347, "gate-probe-r16--p8-more.ts:heredoc#4; gate-r17-sec--r16-p8-more.ts:heredoc#10; gate-r17-sec--r16-p8-more.ts:heredoc#11; gate-r17-sec--r16-p8-more.ts:heredoc#12", "quiet", "refusal", "private", "H4sIAAAAAAAAAx1PzW6CQBh8leY7kyoptUr18IEr+FMQKLZWOKzLllJhUaQiGt+9WS8zk0lmJrMBRuuH4ZC4k0gktKZ6VtCUd/Yifd3SI+9pSrYyXL/pzq20RER0gvCHhKmURIJh4lry94QFMynw0wn87hSro8Z6njR84YWqgWieI/HbnPprL5R2yXN/nRDntP1Q863wEO2MtW1nGbRqEJCL+x4+uYt27wXm2Z+/vUwX7c5C6+CZzvlgD5bzSMiacZgTb+Vrwlpql/64sRucINqd7Gs3sO/7xswPn0m1m6VpOhpF4n4WFEhK9lgkoFyh5lVxBH1zhRPN/zjoQFnBWVntQYE8Exx09RYrQPO8bHgC+iZWQJQ1l6H4Fv8DpWkuUkcBAAA=", "checkText"],
  [348, "gate-probe-r16--p8-more.ts:big_wrapped_prose#5; gate-r17-sec--r16-p8-more.ts:big_wrapped_prose#13; gate-r17-sec--r16-p8-more.ts:big_wrapped_prose#14; gate-r17-sec--r16-p8-more.ts:big_wrapped_prose#15", "quiet", "refusal", "refusal", "H4sIAAAAAAAAA+zMwVLaYBQG0Hfp2hlgRKt29YORKBZIYqi0bAIiojRq7Rji0zt5AJ1xfxb33m++O3P+fLsp/hcnm7/FetV6Ktc/FsXL6rC7t5n2xmnVHg7WjyGEMMryuyhfNzFqVq8fZs29PVtmF00I16MsbZ+Hfy/d5WHSFGmZ5J1eCP3dvLyvXo9mSd7Uj6ttOruJRq+LX53tokxCiDfLum5NsrqTZdHb+CrfH1/WT0nW36XDn9/PL+uHQRg8J/3R7jk+ngznZcOc5tsomabdcjDpvh2dVnEVzkKIW5vfD8dxEqoQLtrp9K5dVL2D1fX2w5mXn32/OjQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9Fo7+3MvYrCQBhA0Xf56kGwk3SuaC9rpylCMoU6kyz+FuK7L76E1bn9PTQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go32Da2Wxc9pu/y0LpvDuDv/3rd1tYoUw9TP6hDpFbd8qddo9q94dOWeo4mur7mfLn+RohzHHM383aboSpmeeYhm36YYp1v+TO27/QefJFCLb7BBAA==", "checkText"],
  [349, "gate-probe-r16--p8-more.ts:big_wrapped_quoted#6; gate-r17-sec--r16-p8-more.ts:big_wrapped_quoted#16; gate-r17-sec--r16-p8-more.ts:big_wrapped_quoted#17; gate-r17-sec--r16-p8-more.ts:big_wrapped_quoted#18", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+zMwVLaYBQG0Hdx3RlgSq22qx8MRLFAkoaCsglIEcWotWMIT9/JA7Qz3Z/Fvfeb786c25PlyV3xu/iyeyq2m9ZLuf26Kt42p90Pu1lvklbt0XD7HEII4yy/j/JtE6Nm9fph0dyfg3V21YQwH2dp+zL8euuuT5OmSMsk7/RC6B+W5UP1frZI8qZ+3uzTxV00fl/96OxXZRJCvFvXdWua1Z0si46T7/nHyXX9kmT9Qzr69vnyun4chuFr0h8fXuPz6WhZNsxFvo+SWdoth9Pu8eyiiqswCCFu7W4ez+MkVCFctdPZfbuoep828/1fZ1n+6/u/Q6PRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg02p925l5FYSAMoOi7fPUg2Ek6Fe1l7TRFSKZQZ5LFn91CfHfxJazO7e+h0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBrtG1oti9V5t/y0KdvjuL/8PHZ1vT5GpBimflaHSM+452u9RXN4xl9XHjma6Pqa++n6GynKaczRzF9tiq6U6T8P0RzaFON0z5+pfbVvR4REuHOwQQA=", "checkText"],
  [350, "gate-probe-r16--p8b-ent.ts:attr_entity_nl#1; gate-r17-sec--r16-p8b-ent.ts:attr_entity_nl#1; gate-r17-sec--r16-p8b-ent.ts:attr_entity_nl#2; gate-r17-sec--r16-p8b-ent.ts:attr_entity_nl#3", "private", "private", "private", "H4sIAAAAAAAAAx1O226CQBT8leY06ROpklKrWJscEMEbCltsrfKwLtstlYuCFdH47836MjOZyUxmBa9xKu7KgvXWENED1eOUCt7YZaK7oSVvaUq8MGZ+1RzbIkdEdEnwYwVCSkuCYeJS8veAkZEU+OkSvznEotRYy5OGn3mBaiCap4d7tdn9rY7tpRfIJOeJv4ws97j5UJNN5iE6MavrxpzUKiHWefYePM0m9c4j5skfT1+Gk3pro733TPe0dzrz8W1QLvWDxPIWvpbZc+3c7ldOhQNEpxF/bTvO7YUx8oNnq9iOhBC93hreQIEoZ49pBMoFDrxIS9BXFzjS5I+DDpSlnOXFDhRI4oyDrl5DBWiS5BWPQF+FCmT5gctSeA3/AZGWj0tJAQAA", "checkText"],
  [351, "gate-probe-r16--p8b-ent.ts:attr_entity_hex#2; gate-r17-sec--r16-p8b-ent.ts:attr_entity_hex#4; gate-r17-sec--r16-p8b-ent.ts:attr_entity_hex#5; gate-r17-sec--r16-p8b-ent.ts:attr_entity_hex#6", "private", "private", "private", "H4sIAAAAAAAAAx1O226CQBT8leY06ROpklJbsTY5IIKXokDX1ioPK2y31AUUrIDGf2/Wl5nJTGYyK3hJUn5TFlF/DTE9UD1JKWetXcZ7G1qyjqYkC2PmV+2JzXNERDcgPxbhUloSDBOXkr+HUTCWAj/dwG+PsCi1qONJw888ohqIZn13W2Pvtzo+Lz0ik5wJfxlb7nHzoYpN5iE6SdQ0rXnQqEFgnWbv5GE2bXZeYNb+5O1pNG22Ntp7z3TrvdOdT66DcmlAhOUtfC2z59rpeVA5FQ4RnVbyte061xfG2CePVrEdc877/TW8ggJxHt2nMShnOLAiLUFfneFIxR8DHWiUsigvdqCASDIGunoJFaBC5BWLQV+FCmT5gclSeAn/ARYcM6dJAQAA", "checkText"],
  [352, "gate-probe-r16--p8b-ent.ts:attr_entity_crlf#3; gate-r17-sec--r16-p8b-ent.ts:attr_entity_crlf#7; gate-r17-sec--r16-p8b-ent.ts:attr_entity_crlf#8; gate-r17-sec--r16-p8b-ent.ts:attr_entity_crlf#9", "private", "private", "private", "H4sIAAAAAAAAA0VOzW6CQBh8leYz8USqRGoVa5MPRFAsulBsrXLAZbul8qNgRTS+e7O99DIzmclMZg1PccrvyoIONxCFx1CN05Cz1j7jg21Ysq4ixUtt7lZt2+Q5IqLj+V+Gz4U0BGg6rgR/jqk3FQLfHc9tT7AoFdolwnAz4ssaon5uNuTOoNmQ24Pv6tRbEV/EOUvcVWQ4p+2bnGwzgmjFtK5bC6+WPc+4zF/9znxW74mnn1375XEyq3cmmgeiO+eD1V/Y/6tibuQnBlm6SmYulEtvVFkVjhGtVvyx61t/f7Sp6z8YxW7KOR8ON/AMEkQ5vU8jkK5wZEVagrq+wilMfhioENKU0bzYgwRJnDFQ5VsgQZgkecUiUNeBBFl+ZKIU3IJf09wC0FMBAAA=", "checkText"],
  [353, "gate-probe-r16--p8b-ent.ts:prose_entity_nl#4; gate-r17-sec--r16-p8b-ent.ts:prose_entity_nl#10; gate-r17-sec--r16-p8b-ent.ts:prose_entity_nl#11; gate-r17-sec--r16-p8b-ent.ts:prose_entity_nl#12", "quiet", "private", "private", "H4sIAAAAAAAAAx1OzW6CQBh8l69JT6RKSq1iPHwggj9Fd+naWsNhhe2WuoCiFdH47s16mZnMZCazhpQfuZ3lXIrWrpD9DT+IjmVkS2dO6/bUlyUiYhixH49JLT0Njosrzd+jJJpogZ9hRNtjrA5W0iHaoAVhpoPonh8fzHb/tz51V4TppBSKrlIvPG0+TLUpCGKQJU3TWkSNGUXeZf7OnuezZkci90ynb6/jWbP10d8TNzzvg95ieh/US0OmPLKkVuEvrEt3WAc1jhCDVva17QX3F86Eshev2k6klIMBGJCWyVOegnGFo6jyA9jrK5y4+hNgA09ykZTVDgxQWSHANm+xAVypshYp2OvYgKI8Cl2Kb/E/+9wN2jsBAAA=", "checkText"],
  [354, "gate-probe-r16--p8b-ent.ts:md_br_tag#5; gate-r17-sec--r16-p8b-ent.ts:md_br_tag#13; gate-r17-sec--r16-p8b-ent.ts:md_br_tag#14; gate-r17-sec--r16-p8b-ent.ts:md_br_tag#15", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx1O226CQBT8l/NMiqTUKq1NDojgpSi7XVtreFhgu6VyUbwgGv+9WV9mJjOZyawh5QduZQWXQt+W8iXme9E1tWxpz0nTmXqyQkQMKPt1mVTSVWA7uFL8M0roRAn8CijpjLHem0k3VAYpQ2bYiM75Na71t7/m1FuFTCWVyMkqdYNT/GnkcRki+lnStvqCtgal7mX+wR7ns3YbUudMpu/P41m78dDbhU5w3vn9xfQ+qJaGLHfDJTFLb2FeesPGb3CE6OvZ96bv31/YE8Ke3HozkVIOBqBBWiUPRQraFQ6iLvZgra9w4vlRgAU8KURS1VvQIM9KAZZxizTgeV41IgVrHWlQVgehStEt+gch+CllOwEAAA==", "checkText"],
  [355, "gate-probe-r16--p8b-ent.ts:json_unicode_nl#6; gate-r17-sec--r16-p8b-ent.ts:json_unicode_nl#16; gate-r17-sec--r16-p8b-ent.ts:json_unicode_nl#17; gate-r17-sec--r16-p8b-ent.ts:json_unicode_nl#18", "private", "private", "private", "H4sIAAAAAAAAAy1O226CQBT8leY8kwoptUrjwwERvBRlt9ha4WGF7Za6gMULovHfm236MjOZyUxmDdcYWAzWXQwZOzArL5jgnV0pnjdsz7umli/tOWn0qScqRMSARl9uJJR0FdgOrhR/jlI6UQLfA0r0MdZ7M+2GyiBlGBk2onOO46Ou6+y7OfVWYaSyikuyytzgtHkz5KYMEf08bdvOgrYGpe5l/ho9zGftLqTOmUxfnsazduuh9xM6wfnH7y+m/5NqaxhJN1wSs/QW5qU3bPwGR4h+J//Y9v2/J/aERI9uvZ0IIQaDGG6gQVal90UG2hUOvC72YK2vcGLyyMEClhY8reodaCDzkoNl3BINmJRVwzOw1okGZXXgqpTckl8EpFiwTAEAAA==", "checkText"],
  [356, "gate-probe-r16--p8b-ent.ts:yaml_dq_escaped#7; gate-r17-sec--r16-p8b-ent.ts:yaml_dq_escaped#19; gate-r17-sec--r16-p8b-ent.ts:yaml_dq_escaped#20; gate-r17-sec--r16-p8b-ent.ts:yaml_dq_escaped#21", "private", "private", "private", "H4sIAAAAAAAAAx2O3W6CQBSEX6U516RKSq3SeHFABH+KLnRtrXCxwnZLXRaLVkTjuzfbm5nJl8xkNlCUwr5LIGdHZhclE7yzV+J5yw68ZxnFyllETXfmiwoRMYzpl0eFjp4Wx8W19s9xFk91wPcwjroTrA9W1iMaRIpQ00F0z0mivptTf02o5hWX0Tr3wtP2zZRbRRCDImvbzjJuzTj2LotX+rCYt3sSu+do9vI0mbc7H/0f4obnn2CwnCWJ0jsjKj2yiizlL61Lf9QEDY4Rg07xsRsE/w+caUQfvXo3FUIMhwmAAXmV3Zc5GFc48ro8gL25wonJXw42sKzkWVXvwQBZKA62eUsNYFJWDc/B3qQGqOrIdSm9pX9yBablQAEAAA==", "checkText"],
  [357, "gate-probe-r16--p8b-ent.ts:yaml_dq_fold#8; gate-r17-sec--r16-p8b-ent.ts:yaml_dq_fold#22; gate-r17-sec--r16-p8b-ent.ts:yaml_dq_fold#23; gate-r17-sec--r16-p8b-ent.ts:yaml_dq_fold#24", "private", "private", "private", "H4sIAAAAAAAAAyVO226CQBT8FXOeSZWUWqXx4YAIXorCdm2t8LDCdktdQPGCaPz3ZtuXmclMZjJryHJhtiJI2ZGZWc4Eb+8K8bJhB941tGxpzcO6M3VFiYjoE/rtUKGko8CycaX4a5SQiRL44ZOwM8bqYCTdQBlhEVDdQrQvURQVrdZPfe6tAqqikstwlTr+efOuy00RIHpZ0jTtBWl0Qpzr/I0+zmfNLiD2JZy+Po9nzdZFdx/Y/mXv9RfT/0U1NaTSCZahUbgL49ob1l6NI0SvnX1u+97fD2sS0ien2k6EEINBBKBBWiYPeQraDY68yg9grm9wZvLEwQSW5Dwpqx1oILOCg6nfYw2YlGXNUzDXsQZFeeSqFN/jXzrZMhpGAQAA", "checkText"],
  [358, "gate-probe-r16--p8b-ent.ts:toml_multiline#9; gate-r17-sec--r16-p8b-ent.ts:toml_multiline#25; gate-r17-sec--r16-p8b-ent.ts:toml_multiline#26; gate-r17-sec--r16-p8b-ent.ts:toml_multiline#27", "private", "private", "private", "H4sIAAAAAAAAAyVPXW+CQBD8K2afSZWUWqXxYUEEP4py9Gyt8IBwvVKPQ9GKaPzvzdlMsjuZzU5m1pAXvDVoRXCHzJJjYuZFwll7J/nLJjmwrqHlS2tO6s7U5SUioh/Sb4dyRR01LBtXan+N0nCiCH74IemMsToYaTdQApEB1S1E+xxFkfypT71VQNWhZIKsMsc/bd51sZEBopenTdNehI0ehs5l/kYf57NmF4T2mUxfn8ezZuuiuw9s/7z3+oup8lNGQyqcYEkM6S6MS29YezWOEL12/rnte/cM1oTQJ6faTjjng8F/Y9AgK9OHIgPtCkdWFQcw11c4JeKXgQlJWrC0rHaggcglA1O/xRokQpQ1y8BcxxrI8sjUU3yL/wDGAs5bTQEAAA==", "checkText"],
  [360, "gate-r16--cx16.mjs:2 gif split comment#2", "refusal", "quiet", "private", "H4sIAAAAAAAAA+2L2wqCQBRFfyX289BUWNF0gSNdIegCEWE+jHpSYyZDrYjo36P6hR7bsB7Wgu2hl9q4UuRhf49Il1qlVscs4/TQDXTBLUesa2ayGJqEVuTSjL5bSinv06ZLo4/Ov9Wlj8/cNVEirx2Hp8mfXzEZH4PtZrRrdO4hUXuPAQQOVRtBPFBybgso74GrNheGgg4th1l+hoBJTwxVf/oC2pjsxhGU5wucspLfJ//pvwBjjqSOCQIAAA==", "checkText"],
  [361, "gate-r16--cx16.mjs:3 leading + continuation#3", "quiet", "quiet", "private", "H4sIAAAAAAAAAx1OX2+CMBz8KuT3arPJhmbB8FCwUyG6CIKJwkPFWhnYIu1GhvG7L3APl8sl9+cIuRRKG8WNcmY4qTCMFM5UU3twXmvBZyeq2NRCReJ+he04WHCJMcabKL6SmPeS9OR6eMD0UuukF+tlHe+X4fz0ZurDfjLG2LUE0euuNDcp9EsjI4Wu+LjHHpe7vPF3n4fV37SVQWQGSXRd7YjwO6KWeO1t55h/39+J6pu9siLbJLTEYjPsY47dKBiV+XY44ofxhDSlzzl3nBRmgODyohWgB2jW3BTYxwf80uqHgQ00v7FcNjUgqArBwDafGQJaVbJlZ7CPGQIhNetD2TP7Bx6aLp4vAQAA", "checkText"],
  [362, "gate-r16--cx16.mjs:3b trailing + continuation#4", "quiet", "private", "private", "H4sIAAAAAAAAAyVOzW6CQBh8FfJdJa20SBqMhwW3KgQbQDAROKy4rhTYRdhqivHdG+gcJpNJ5ieBXPBOKkVNGFUWKVeUFE5EEnN0XhvO5kfSUUNXi9j6Cu5Td8UEQghtw+iCIzZIPJBloxHGuZHxILx1E+3XwfL4psnDfjZFyNI5ll5fatsUlMn/Vl98XCObiV3eOrvPw+bXuAs31Nw4vGx2mDs97tbIs/0lYt/Xd9wNzXZZYT8OdL7ajvuIISt0J2Xuj0ecIJrhtnQYY4tFCnNQ4fwiO1AfIGlbd2AmD7iR6oeCCSSvaS7aBlSoCk7B1J6ZCqSqxJ2ewEwyFbiQdAhlz+wPI7MK3y8BAAA=", "checkText"],
  [363, "gate-r16--cx16.mjs:4 spaces 8192#5", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3IsQmAMBBA0VXk6uAAWSWkOLwTi2gkBizE3QWdQviv+z+Jadc4AAAAAAAAAAAAAACA39uLTr7UYt4kyDyuJuGS7m09JKYcREupp9sXW+3+/js/ZoPEB0AgAAA=", "checkText"],
  [364, "gate-r16--cx16.mjs:4 spaces 16384#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3IMQrCMBiA0avIP4ceoFcpHYKJOKSNtAEH8e6CHsLlve37lih55PkCAAAAAAAAAAAAAAAAAAAA/N2j5Wu991bqESlu01YivWLUYztjXtYUubX+rOUXex/1+9/rB3i4+f9AQAAA", "checkText"],
  [365, "gate-r16--cx16.mjs:4 spaces 32768#7", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3IsQnDMBRAwVXMr4UH8CrGhYgUUshWsAUpQnYPJGvcde+tUfLIywQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATM+Wb/XRW6lnpLjPe4n0jlHP/Ypl3VLk1vqrln8cfdTf/2xf4IygyUCAAAA=", "checkText"],
  [366, "gate-r16--cx16.mjs:5 code span then prose#8", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LQQrCMBAF0KuUvw4VQVzEtagXcFMDnTYjRKZJSEYtlt5ddPc2r8NxpikL26b3pGSVZ91koRAPA1Xe78x4vobhJI/+Fi9RuUTSkCJJ+PzRhNrUZ86pKPsWBvd28jALlMtUYbsFL5Inw4LGicdUMgwkRIbdrs6ARNKbPWznDGJS/iW3ui8J+vjpmwAAAA==", "checkText"],
  [367, "gate-r16--er.mjs:call#1", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAyXLvQrCMBQG0Fcp3xwURUSvOHcQBBFcaobb5LYE8lPaVC2l7y7ifDgVnEmRCsuZKcsnrzvPLp5qHmS/U/fyMdTlobXb41SXt/MzmhQb1449Z5fiRaYrB6HixX4UKDSrYKFmZOnDAKpm/IXAJohJfQcF76KANotWYO/TWyyo0goxZfklvegv6YJi/pcAAAA=", "checkText"],
  [368, "gate-r16--er.mjs:call#2", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Hf55qAoIhpxLoIIIrjEDDfNbQnkpySxWkrfXTz7UbBUSVb+1vXgycWTocL7nXg0z2KaQ2+3x8k09/Mrjpyna4r9xXKsrnOcbxQYAt0qWIgZlXMokGrGSP7NkKA2cJvyAAHvIkNuFi1A3qcPW0ilBWKq/E960T89+Jy9jAAAAA==", "checkText"],
  [369, "gate-r16--er.mjs:call#3", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FeRbw5qQRzi5qKiKDi4JBmuzW0I5KeksUVK3108+1GYNUhDaliqJH0kx5s+ucObBt7vhH8dH89pez25rCF00hi5fG85uYvlVH3nudwp8pkLa8hVs0CgW0cLMaNyiQOkmjFS+DAkqI3c5tJDIPjEkM1iBCiEPLGFVEYg5cr/ZBbzA8jwRJKeAAAA", "checkText"],
  [370, "gate-r16--er.mjs:call#4", "quiet", "refusal", "refusal", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ32pQBBFJ6VwFcRFcmgy3za0U8lOSWJXSdxfPflr0MeQiSNRCw1IhVfhTdpOjMVQdZT4e5L155K451Rpio4MQGjOn7zWG58VyKOMwcrqR5zMn1qggMWy9hVxQOPkM1S6Yyb0YCtR77mOaIOHGwFD71UiQc/HNFqo1EiEW/iezmh8UmggUnwAAAA==", "checkText"],
  [371, "gate-r16--er.mjs:call#5", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLuw6CMBQA0F9p7tygJsahTro4OJiY6IIdLvRSin1JC6iEfzee/ZRwS8QUZhTGoaZV9HpfYaLdlpv78XKd1ueTDg9/qGpFjW5N97TOh/jqUx7G6f35MpNYbomhjS1WlAvg0BROAZ8hU+8SiHKGEe1AIABrR3XoI3CwxhOIzSI5oLVhIgWilBx8yPRPcpE/1tR+E58AAAA=", "checkText"],
  [372, "gate-r16--er.mjs:call#6", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LsQrCMBQF0F8pdw4VQRziFzg4OtUMr81tCCQvJU11KP130fXAGfBc2XlpYmOWwNOi4TbKyuvFvHQqOsewVWmx6ENUAus9L4mZ2v7YtdIxj/Q9DOY+e5gdjTWvsMOOt6SNsJApcyp1gUGKStjz4QwkpfKhhx2cgZbGX3KH+wJQEmUPlQAAAA==", "checkText"],
  [373, "gate-r16--er.mjs:call#7", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLSw6CMBQF0L3ccaOixpgaxyzAxAl28KAPrfYnLR8l7N145qeCpkwy85TX0ZLxp5oSH/biUl5TXR7PN091o7m9P8zzZZ0P8d2l3A/j9Pluiu0OAu3KaYgZmTuXIKsZA9meIUGN4yZ0EQLWeIYsFiVA1oaRNWSlBHzI/E9qUT/fRhLtjAAAAA==", "checkText"],
  [374, "gate-r16--er.mjs:call#8", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLzQqCQBQG0Hf51pciEBe3VcFAu0BpIcMgN+cGwvyIThaI7x6d/bHwUoSLfstxCjKm81MWrSvq7o+mv15aU1f9zTQGhNchetCGonNcwHbDKuGtYMgQdcjzBEIYk4JPuyNICPmjHmwdIeWi/+R29wOPL6SJdAAAAA==", "checkText"],
  [375, "gate-r16--er.mjs:call#9", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4Hf554MXEIe4uTg4CA4uIYTT5LQEcilp2iKl7y5++6fhubEKiQc5jnm4dTzJ9ULhc3+919PzMRTb6pwdN/G2L9V2VZbQviD0h+RBG5rUNEHpDQvHWaDALokrdQQhhixQ590QOMayiofShpBLk38yu/kBmBNMYYQAAAA=", "checkText"],
  [376, "gate-r16--er.mjs:call#10", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLTwuCMBgH4O/yO49GMITWacWgoKB/0EHGeNNXUTYVXXUQv3v03J8cJSXSTaSaZTtwvX3RxJkSctNKZczV3+zlZPbWn61/Hh8HvzN3mykIVKtYQsxIPMYJOp/xofBmaFARuejHAQKh6Rh6vTgBCqH/cgmdO4GuT/xPbnE/IxrvjIMAAAA=", "checkText"],
  [377, "gate-r16--er.mjs:call#11", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLOwoCMRQF0K3IrR9+QCxiZ2NhIUxhE1I8k2cI5MckOsUw4CJcoSsRT380HHdWIbGXTc3+eOcmhz2F2+k6TNvL2Zfv+9NEVq2KBeGxTg40o8uYGpSe8eL4FCiwTWLLWEGIIQvUbjEEjrFM4qC0IeTS5Z/MYn5iq57reQAAAA==", "checkText"],
  [378, "gate-r16--er.mjs:call#12", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLSw7CIBQF0L3cMWhMjAPchxPC4AnXlviAhuInabp345kfjyRDXC4y8bjU6XqXlZezyTe7qETOTRO71fykHfwOO7MTBo9DSTAbBntZ4fyGt+iLcJBYGFtfYKC5Eu60BwNRbR8mOB8Mahv8p7CHH60yiAGAAAAA", "checkText"],
  [379, "gate-r16--webp.mjs:call#1", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAxXLTQuCMBgA4N/SeyoYhRghiw6r7JCF6BIR2WHqWwmbipofif89eu5PDIt4EMtMtpLmWr5w02NS7RPZ4G5LvOB69k82Y+wYhZd3NFp9zbnpcGvwuf11H4Hp3sbKG+9Nx7kRjg7nLmOHFRB4rnUGZIIWa90AjSfopPogUJCpxrSsKyCg8gKBGrMgIJUqe8yAxoJAUbb4T2IWP5o7JKiiAAAA", "checkText"],
  [380, "gate-r16--webp.mjs:call#2", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLQQuCMBQA4N/SOxWMQoyQRYchniykXtFh7DD1FcKmoqYu8b+Hh777J2ElR7XOdad5YfWbdgOl9THVLR32TCzCSPy5YGgQ/RiD8YbRN7k//OTs6qu7tD2i93QxYiLEaQMMXlubA5ugo8a2wOUEvTYfAg46s5RVTQ0MTFEScG9WDLQx1UA5cKkYlFVHS1Kz+gGwWFesogAAAA==", "checkText"],
  [381, "gate-r16--webp.mjs:same bytes as octet-stream#3", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAxXL3QqCMBQA4GfpXBWsIoyQRRer7KIfpJZIyC5OeiJhc6LLWtG7R9/9l0Eve6l+gQ451rUuc3SlrcY2d+SGrWsIzfyKLc2m7Jhs16dVJIRYXtLN/eLDZyNlsJPh6ySjd3xOgnjv66M/tJ2Uk9TvpIyFWAyAwW1kCmAfcNSYFnj2gQ71g4AD5oZy29TAQJcVAZ98FQPU2j6pAJ4pBpV19E/qq34oiCBisAAAAA==", "checkText"],
  [382, "gate-r16--webp.mjs:call#4", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAxXLwQqCMBgA4GfpPxWMQoyQRYdVdshCdInI2GHpMmFTUVOX+O7Rd/8YLNjIl5noBC60yOWmLvP9U7Ryt0VBdD2HJ5cQckziyzsxztBQanvUGUPqfv1HZPs3Uwfm3vaUWrHxKPUJOawAwWutM0ATdLLRLWA2QS/URwIGkWqZVk0NCFRRSsDWzBEIpapBZoAZR1BWnfwnPvMf8wivI6EAAAA=", "checkText"],
  [383, "gate-r16--webp.mjs:call#5", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAxXL0QqCMBQA0G/pPhWMQoyQRQ8LJMhCdEnB2MPUW0ibipq6xH+PzvsRsBCjXOaqU7Qw6oWbAdN6n6oWd1uSvPUpLnzG2PERJ+fIekPDuRtwb4y5/w1viRtebB3Za9tz7txtwHnI2GEFBJ5rkwOZoMPGtEDFBL3SHwQKKjOYVU0NBHRRIlBnlgSU1tWAOVAhCZRVh/8kZ/kDaahp5KIAAAA=", "checkText"],
  [384, "gate-r16--webp.mjs:call#6", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAxXLwQqCMBgA4GfpPxWMUoiIhYdF0CGXFNhl7LB06tympUtL8d3D7/4xWLAvX6bCCaysyOUmV9nhKVq526K7Z87RyRTkRo5kRjt68bT76Y7GcUEH7V8HtX/HtAxDT7tHq7QucxL1QbACBNnapoBGcLKxLWA2QifMRwIGkViZ1M0LEBhVScD+xBEIY+pepoAZR1DVTs6JT/wP/uvMLqUAAAA=", "checkText"],
  [394, "gate-r17-er--a1.ts:sp_charset_term#4; gate-r17-er--a1.ts:sp_charset_term#5; gate-r17-er--a1.ts:sp_charset_term#6", "refusal", "private", "private", "H4sIAAAAAAAAAxXLsQrCMBQF0F+RO0dFFJGUDo4uXasNGV6TpxbSpKSvVSj9d/Hsx8CTkBb+yn4I1MXCvSmPLOUkz+1lU7Q08vmk2qOfmvvt9agraepqdvFaQsEnt+s91ALh3I/QZsFMYWJokOvZpTxAIXSRoQ+rVaAQ0oc9tLEKMQn/k13tD8f5jP6JAAAA", "checkText"],
  [395, "gate-r17-er--a1.ts:sp_charset2#7; gate-r17-er--a1.ts:sp_charset2#8; gate-r17-er--a1.ts:sp_charset2#9", "private", "private", "private", "H4sIAAAAAAAAAxXLsQrCMBQF0F+RO0dFFJGUDo4uXasNGV6TpxbSpKSvVSj9d/Hsx8CTkBb+yn4I1MXCvSmPLOUkz+2l2LQ08vmk2qOfmvvt9agraepqdvFaQsEnt+s91ALh3I/QZsFMYWJokOvZpTxAIXSRoQ+rVaAQ0oc9tLEKMQn/k13tD8FILEeJAAAA", "checkText"],
  [396, "gate-r17-er--a1.ts:unpadded_nextline_word#10; gate-r17-er--a1.ts:unpadded_nextline_word#11; gate-r17-er--a1.ts:unpadded_nextline_word#12; gate-r17-er--cx17.ts:F4_ident#25; gate-r17-er--cx17.ts:F4_ident#26; gate-r17-er--cx17.ts:F4_ident#27", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLQQrCMBAF0Lv89aAIIhIPUARxI3QTs5gmowSSSUljVUrvLr79swjc2DT5tO2YOOpp4EkOe7p1/TR0x7vOUr+Xos9zEG3xEaVeOQsIofhNDqAFTWqeYOyCmdNLYMA+iy91BCFFFZjd6gicUnlLgLGOoKXJP7nV/QC+Pwm+hQAAAA==", "checkText"],
  [397, "gate-r17-er--a1.ts:unpadded_alpha#13; gate-r17-er--a1.ts:unpadded_alpha#14; gate-r17-er--a1.ts:unpadded_alpha#15", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx3LvQrCMBQG0FeRbw7+gDjEzUVERBB0qRmuyTUEkpuSpHYofXfR9cDpcK+8cNRIh0SeV734/Ysq77YqPA7X27g+H31+is3yDn4o1EKWCwl5LqfUR04s7Y9QcNkuk4Oa0LikCt1N+FAcGBpkE9tceijEIAy9mY0CxZhHdtCdUZDc+JfMbL4ZJGdvmAAAAA==", "checkText"],
  [398, "gate-r17-er--a1.ts:q_joined_op#19; gate-r17-er--a1.ts:q_joined_op#20; gate-r17-er--a1.ts:q_joined_op#21", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLTQuCMBwH4K8yftdGUUTUpLMFEUTQxe0w3T8Z7EXmMkX87tFzfyqM7MwkjM5aZBrzpnPahqLWPR32/Fm++ro8tmZ3muryIcFWTAbGJAZK0y2G9mooZPu2lO7a04USSRTgMLFZewM+I1PyPUQ1Y9DuQxDQjacmpg4czgaC2C6KQzsXv2QgKsURYqZ/Uov6AWqL2umjAAAA", "checkText"],
  [399, "gate-r17-er--a1.ts:mid_op_comma_list#22; gate-r17-er--a1.ts:mid_op_comma_list#23; gate-r17-er--a1.ts:mid_op_comma_list#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLOwvCMBgF0P9y5w8fIA5xc1FwUBRcaobP5pIW8ihptEPpfxfPfho4rWr6qJ7rIfnDW0fud9I/j9f7tLmcfJZXGnPktXYsN63dgz4y1TMLIXC5XUUHmVFZ4gjTzPhq+BAG2ka2uQwQhD4RZrtYgYaQJzqYxgpSrvwnu9gfFbYrs4sAAAA=", "checkText"],
  [400, "gate-r17-er--a1.ts:colon_before_op#25; gate-r17-er--a1.ts:colon_before_op#26; gate-r17-er--a1.ts:colon_before_op#27", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwrCMBQG4Fcp/+rBC4hD3FwcHAoOLjHDMTmEQG40qR1K31389k/DcWcVEns51OyvH25yOVN43cbncnzcfXnn3RDawEONcwPBFbtPDrSiy5QalF7x5TgLFNgmsWWqIMSQBeq0GQLHWBZxUNoQcunyT2YzP26KhmJ9AAAA", "checkText"],
  [401, "gate-r17-er--a2.ts:word_after#1; gate-r17-er--a2.ts:word_after#2; gate-r17-er--a2.ts:word_after#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx3MuwrCMBQG4Fcp/xy8gDgcNxcHwYqDS8xwTI4hkEtpohVK313we4BP4zrKK3y7UDvHjSkk9rIesj88ucp+p8L92N+mzfnkyyNfSpMKBVfsKjmoGU3GVEF6xofjW0Bgm8SWcYBCDFlA28UocIxlEgfSRiH/G9JmMT/2P45PgQAAAA==", "checkText"],
  [402, "gate-r17-er--a2.ts:word_after2#4; gate-r17-er--a2.ts:word_after2#5; gate-r17-er--a2.ts:word_after2#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwoCMRAF0F+RWw8+QCxiJ4iFhSBok00xJkMI5MUmusKy/y6e/mg8mqwcd1YhsZdNzf744iaHPYXn6XaftteLL0M+fznVKEMGwRW7Tg40o8uYGpSe8eH4FiiwTWLLWEGIIQvUbjEEjrFM4qC0IeTS5Z/MYn6I+lt1fwAAAA==", "checkText"],
  [403, "gate-r17-er--a2.ts:heading_after#7; gate-r17-er--a2.ts:heading_after#8; gate-r17-er--a2.ts:heading_after#9", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwoCMRAF0F+RWw8+QCxiJ4iFhSBok00xJkMI5MUmusKy/y6e/mg8mqwcd1YhsZdNzf744iaHPYXn6XaftteLL0Me8vnLqUYBwRW7Tg40o8uYGpSe8eH4FiiwTWLLWEGIIQvUbjEEjrFM4qC0IeTS5Z/MYn5/cVgsfwAAAA==", "checkText"],
  [404, "gate-r17-er--a2.ts:word_eof#10; gate-r17-er--a2.ts:word_eof#11; gate-r17-er--a2.ts:word_eof#12", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwoCMRAF0F+RWw8+QCzGzsbCQhDWJqYYkyEE8lg20S2W/Xfx9MdgaLrx0oVjlqC7sYTzW5qejhSfl/tj3t+uob7K0CQoCL66bfagBV2n3MBmwVfSR8EQl9XVaQQhxaLgw2oJklKd1YONJZTa9Z/san+364EUewAAAA==", "checkText"],
  [405, "gate-r17-er--a2.ts:num_after#13; gate-r17-er--a2.ts:num_after#14; gate-r17-er--a2.ts:num_after#15", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLoQ7CMBAG4Hf59QUYLIjiMAjEEgSmVBztpWnS9patMLHs3Qmf/ywCNzapcJT9WOPlzbOce0rP6/BYDvdb1FftjqcehKB+VwJoRZOpzDB2xZfzR2DAvojXaQQhpyow3eYInLMuEmCsI1Rt8k9ucz+erV1zdgAAAA==", "checkText"],
  [406, "gate-r17-er--a2.ts:bullet_url_sentence#16; gate-r17-er--a2.ts:bullet_url_sentence#17; gate-r17-er--a2.ts:bullet_url_sentence#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ3xz8AXGIky4ODoKCS81wbS41kOSW9GqG0ncXz3463JWqmhb1bQIpuZhp4PVYhsOLJt7vbHycrre2uZwHeZZjCUbfXEyWyqZJDRMsgvSrHGBnKNc8wXUzvpQ+DAfqM/dSR1ikWBhuu3gLSkkaB7jOWxRR/ie/+B9QCEX4kAAAAA==", "checkText"],
  [407, "gate-r17-er--a2.ts:jsonarr#19; gate-r17-er--a2.ts:jsonarr#20; gate-r17-er--a2.ts:jsonarr#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FeRb774A+IQNxcHB0HEJclwbS4xkOSWNrVD6buLZz8W1iFwY5MKR9n1NZ7fPMrpSOl1uT/m/e0a1YFc3Tg8B53eWcaPaks1OngQgnbbEkALmgxlhLELvpwngQF3RTodehByqgJzWD2Bc9ZZAoz1hKpN/smv/gdfexjejQAAAA==", "checkText"],
  [408, "gate-r17-er--a2.ts:py_list#22; gate-r17-er--a2.ts:py_list#23; gate-r17-er--a2.ts:py_list#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Fcp35Il+APiEHFxcXAQRFxihrS5xECSW5rUCqXvLj370fg150YLZ6tVIVlP2z77U2sLHQ8yvC73x7S7XT0L+c7NSjwHHttI5cNcQ/bCQMJxt0kOckalIRUoPeNr40hQsF2ijoceEjFkgtovRsLGyBM5KG0kMldak1nMHyJaQuaRAAAA", "checkText"],
  [409, "gate-r17-er--a2.ts:yaml_list#25; gate-r17-er--a2.ts:yaml_list#26; gate-r17-er--a2.ts:yaml_list#27", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Fcp35z6A+IQNxcHh4KIS81wm1xiIMktaWqH0ncXz356tI2jSjok8rwfs78MNPH5pMLr2j2Ww/3m5Z3b5llkHiJPH5EasoeCE7tLDmpF5ZIm6H7Fl+LM0CCb2EoZoRBDZujjZhQoRlnYQfdGIUvlfzKb+QEgF9IxhQAAAA==", "checkText"],
  [410, "gate-r17-er--a2.ts:yaml_kv#28; gate-r17-er--a2.ts:yaml_kv#29; gate-r17-er--a2.ts:yaml_kv#30", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Fcp3xz8AXG4bi4ODoKIS8xw21xiIMktbWqF0ncXz34smBrPlSlmDrLtSzi1PMrxYOLzfLvPu+sl6Ks8Bp3aJONbtcYSqPnCwGu3yR5mQZUhjyC74MNpEhC4y9Lp0MMgxSKg/eoMOCWdxYOsMyha5Z/c6n79XAg1hwAAAA==", "checkText"],
  [411, "gate-r17-er--a2.ts:dot_end#31; gate-r17-er--a2.ts:dot_end#32; gate-r17-er--a2.ts:dot_end#33", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLsQrCMBQF0F+RO4eqIA5xc3FwEIq4xAyvySMGkrzSpHYo/Xfx7MegMu88NdIxU+D9WMJloMrnk4qv66NfDvdbkO5dnpPMQ+L6EWmxBCh4cV32UCsaT7lCmxVfSjNDg1xmJ9MIhRQLQx83q0ApycIe2liFIo3/yW72BxIDAoKGAAAA", "checkText"],
  [412, "gate-r17-er--a2.ts:dot_end2#34; gate-r17-er--a2.ts:dot_end2#35; gate-r17-er--a2.ts:dot_end2#36", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLsQrCMBQF0F+RO4eqIA5xc1FxEER0qBmezSMGk7ySpHYo/Xfx7KdFYV5YqqR9JMfLPrndiwpvN8rf95fruDofnDTPdMsyvAKXt0j1yZ3KkbJ9SP5AwUrXRAs1oXKOBbqd8KUwMDSoi9xJ7qEQfGLo9WwUKAQZ2UK3RiFJ5X8ys/kB8IOAOZAAAAA=", "checkText"],
  [413, "gate-r17-er--a2.ts:comma_end#37; gate-r17-er--a2.ts:comma_end#38; gate-r17-er--a2.ts:comma_end#39", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FeRbw7+gDjEzUXFQRDRoWa4bS4xmOSWJLVD6buLZz8NCvPCUiXtIzle9cntWyq82yr/OFxv4/pydKJe6Z5laAOXt0j1yZ3LibJ9Sv5AwUq3jBZqQuUcC3Qz4UthYGhQF7mT3EMh+MTQm9koUAgysoVujEKSyv9kZvMDu8WfX5AAAAA=", "checkText"],
  [414, "gate-r17-er--a2.ts:amp_end#40; gate-r17-er--a2.ts:amp_end#41; gate-r17-er--a2.ts:amp_end#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0Fcp3+AU/AFxiJuLioMgokPNcNtcajDJLUlqh9J3F89+amTmylIh7QJ1vOpjt28o826r3ONwvY3ry7GTavGK9yRD4zm/RYqL3TmfKNmnpA8UrLTLYKEmFE4hQ9cTvuQHhga1gVtJPRS8iwy9mY0CeS8jW+jaKEQp/E9mNj+1xMEUkQAAAA==", "checkText"],
  [415, "gate-r17-er--a2.ts:bs_end#43; gate-r17-er--a2.ts:bs_end#44; gate-r17-er--a2.ts:bs_end#45", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FeRbw7+gDjEzUXFQRDRoc1wbS4xmOSWJLVD6buLZz8NCvPCUiXtIzle9cntX1R4t1X+cbjexvXl6KRt23TPMrwCl7dI9cmdy4myfUr+QMFKt4wWakLlHAt0M+FLYWBoUBe5k9xDIfjE0JvZKFAIMrKFboxCksr/ZGbzA53dadWRAAAA", "checkText"],
  [416, "gate-r17-er--a2.ts:code_fence#46; gate-r17-er--a2.ts:code_fence#47; gate-r17-er--a2.ts:code_fence#48", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx3LvQrCMBQG0Hf55otVEIe4uTg4CA5d0kCuySUE8lPa2A6l7y66n6NhrR2K58YqZg7SjSVc3zzL5Uyxvz1f6/FxD3UofweCr+6QPWhDkynPUHrDwukjUGCXxdVpBCHFIlCn3RA4pbqKh9KGUGqTXzK7+QLt7hWlfAAAAA==", "checkText"],
  [417, "gate-r17-er--a2.ts:code_fence2#49; gate-r17-er--a2.ts:code_fence2#50; gate-r17-er--a2.ts:code_fence2#51", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx3LvQrCMBQG0Hf55uAPiEPcXBwcBCkubaC3zSUGkntLm9qh9N1Fz35qtG3biKdCNmYKvB8kXDqa+Hwy8XV9PJfD/Ra0kWrUuUs8vVVLlNDIP8LAa7/LHmZF4TFPsPWKD6WZYUF95l7HAQYpCsMeN2dAKenCHrZ2BqKFf8lt7gtgkM/bjQAAAA==", "checkText"],
  [418, "gate-r17-er--a2.ts:sentence_quoted#52; gate-r17-er--a2.ts:sentence_quoted#53; gate-r17-er--a2.ts:sentence_quoted#54", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLvQrCMBQG0FcJ33ypCuIQNxcFKYKDS5PhmlxqID+lqRYpfXfx7KfDRVTl4JWB54l1SNzLZsj98clVDnsKj9PtPm+v574YmNyW7PmrZlH1FYYGBF9ckzxowSRjqtDdgg/Ht0CDXRJXxgGEGLJA71ZL4BjLLB66s4RcJvknu9ofDD992I0AAAA=", "checkText"],
  [419, "gate-r17-er--cx17.ts:P1_space#1; gate-r17-er--cx17.ts:P1_space#2; gate-r17-er--cx17.ts:P1_space#3", "private", "private", "private", "H4sIAAAAAAAAAxXLTQrCMBAG0KuUbz0ogriIVvAC3RZNsxiTQQL5KUmsQundxbd/GhcfX10ttp/guLFq8m37ObBP5ydXOR3pPg6te4zDYtOtn3AFwWW7iw60okmJFUqvWDi8BQpso9hcZhCCTwJ12AyBQ8gfcVDaEFJu8k9mMz/vXL1KgQAAAA==", "checkText"],
  [420, "gate-r17-er--cx17.ts:P1_tab#4; gate-r17-er--cx17.ts:P1_tab#5; gate-r17-er--cx17.ts:P1_tab#6", "private", "private", "private", "H4sIAAAAAAAAAxXLTQrCMBAG0KvItw6KIC6iFbxAt6UmWYzJIIX8lGSsQundxbd/BtcpvXat+s4ikJAW/sphjjTly5Man09qHHqx8hj6xed7Z3GDQih+nwLUCuGaGrRZsVB8MzTIJ/alzlCIU2bo4+YUKMby4QBtnEIuwv/kNvcDtRi4c4IAAAA=", "checkText"],
  [421, "gate-r17-er--cx17.ts:P1_space_unq#7; gate-r17-er--cx17.ts:P1_space_unq#8; gate-r17-er--cx17.ts:P1_space_unq#9", "quiet", "quiet", "private", "H4sIAAAAAAAAAxXLsQrCMBAG4FeRfz4UQRxOHHyBrkVDhjO5oXBJSnutQum7i9/+BWRxYdevn0aTod7eMuv1Qs++88Or79ZUH3cQckvHkkEbXKcyg8OGVWxRMCQVTW0aQbChKvi8R4KYtY9mcIiE2lz/Ke7xB4oPCL9zAAAA", "checkText"],
  [422, "gate-r17-er--cx17.ts:P2_inch#10; gate-r17-er--cx17.ts:P2_inch#11; gate-r17-er--cx17.ts:P2_inch#12", "private", "private", "private", "H4sIAAAAAAAAAxXL0QrCIBQG4FcZ/7UsgurCWtAL7CoYpV6YHmqgx6G2grF3j777T+H6omav0RSXibjVfBrjsynZdRreVisrfetmCnbk48MWOuzEbeir5vvQz44vncYZAj65NnqIBZVyLJBqwWzDmyBhXSSX8gSBMDJBblcjYENIH/KQyghwqvRPZjU/gtx3a5MAAAA=", "checkText"],
  [423, "gate-r17-er--cx17.ts:P3_json#13; gate-r17-er--cx17.ts:P3_json#14; gate-r17-er--cx17.ts:P3_json#15", "quiet", "private", "private", "H4sIAAAAAAAAA63OvQ6CMBSG4Vsx39yYmBCH4+QkE6MEOR1Ke4JofwwUHAj3brgHh3d8krfFyghTzyDGEP0Q5eBMNnTpzCTnQkn5LP4Vc2zqKj/qarHx2tvyPnQ3/2IoRnozKI+zbFBwyR6Dg1qRZQwTqF2xGD8LCMYGsWn8QGG/BZ02rWC8T19xoFYrxJRlR3rTP8gBnfzgAAAA", "checkText"],
  [424, "gate-r17-er--cx17.ts:P3_js_comment#16; gate-r17-er--cx17.ts:P3_js_comment#17; gate-r17-er--cx17.ts:P3_js_comment#18", "quiet", "private", "private", "H4sIAAAAAAAAA63LsQrCMBQF0F8JdzVYhOKQ4uCkU0eLNhlek4dG0qS0sQql/y7+g8MZTwub4pQFiYPQcJRJZf7kYgjkY9XRxPtS8vlR/ouG2OgohMa1qfOtqWcbj3d7vvjuFJ4alSgK4W2KkHDJbnsHuSDz2E9Q7YKZwouhQLZnm8YBEsFHhtqtRoJCSG92UK2RiCnzL5nVfAEFusB35wAAAA==", "checkText"],
  [425, "gate-r17-er--cx17.ts:P4_plus#19; gate-r17-er--cx17.ts:P4_plus#20; gate-r17-er--cx17.ts:P4_plus#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLuwrCQBAF0H+5rYMSUIsV68RW0MJ1i8nuCJHZB8n6gJB/F09/LAJXNlW+dVOUh3ToeZL9lh5pd08r312HvtXnqb0V6c6Nj5cjCCH7dQygGVXGOMHYGW/Wl8CAfRSfxwKCDklgmsURWDV/JMBYR0i5yj+5xf0AS5gSpoAAAAA=", "checkText"],
  [496, "gate-r17-er--g1.ts:good_gif#1; gate-r17-er--g1.ts:good_gif#2; gate-r17-er--g1.ts:good_gif#3", "refusal", "quiet", "quiet", "H4sIAAAAAAAAA0WLzQqCQBRG3+VbD/1AtZhwcTUpIZDcyixuzs2EGSfUciG+e0RBZ3PO5pSwPLBuPNeyrJvb/sq97DaqWLljfnB3ulBMGf1JTtv4l+evYqKUiLKkoJTyMYqgYEO18BZqwiCd76HLCS92T4EGV16q0D2g4JpWoNezUWDnwigWujQKbRjkM5nZvAGgtCPkoQAAAA==", "checkText"],
  [497, "gate-r17-er--g1.ts:gif_comment_clean#4; gate-r17-er--g1.ts:gif_comment_clean#5; gate-r17-er--g1.ts:gif_comment_clean#6", "refusal", "quiet", "quiet", "H4sIAAAAAAAAA0WLTQuCQBQA/8u7tvRFdNjo8FxB7RJ6isTD6r5UeuuGmgbifw/p0FxnJgWjey1rq0valPXjlOuOjgeRbDm4+lxhjB5G+EeFK7WvOA8+QxQm7n67MKrx55YWUeEz9tDvziDAuGJtDYgJemptBzKdYND8JpCgC0uFa18ggOuGQO7mTIBmdiMZkGkmoHE9LVM2Z1/hybR7qQAAAA==", "checkText"],
  [498, "gate-r17-er--g1.ts:gif_comment_term#7; gate-r17-er--g1.ts:gif_comment_term#8; gate-r17-er--g1.ts:gif_comment_term#9", "private+refusal", "private", "private", "H4sIAAAAAAAAA0WLuw6CMBRA/+WuNj6icahxuEBEXAwOOpAOLb28bKkBBBPCvxvi4FnPOQlo2UleWpnTKi+zg5It7XfstjbhNTAFxuhhhH/88yKwhVHhp4/CU6Ue90ptLwP6w8/PPaKPz9jDoD0CA+3SpdXARuiosS3wZIRemjcBB5laSl3zAgamrAn4ZhIMpDFuIA08EQxq19E8iUl8AaVTXQKtAAAA", "checkText"],
  [499, "gate-r17-er--g1.ts:gif_comment_split#10; gate-r17-er--g1.ts:gif_comment_split#11; gate-r17-er--g1.ts:gif_comment_split#12", "refusal", "quiet", "private", "H4sIAAAAAAAAA+2QsQ6CMBQA/+WtNqKBONQ4PCARHTSwGCUMhT4BbamBKgPh3w1x8AccveTGWy4FKazgtRYlOWV9Xeeio5XHkoXaHkNVYYw+7vBLEM0ct/Io+vsrz6eDvcTJLXf3PQb95/P0HTHAe+xj2G2AgTTFXEtgA1hqdQc8HeAl1JOAgyg0FaZ9AANVNwR8OWYMhFKmJwk8zRg0xtIUZWP2Bs0qZfj1AQAA", "checkText"],
  [500, "gate-r17-er--g1.ts:gif_garbage_after_trailer#13; gate-r17-er--g1.ts:gif_garbage_after_trailer#14; gate-r17-er--g1.ts:gif_garbage_after_trailer#15", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA0WLzQqCQBRG3+VbD/1QuZhWV5MSAsmtzOLm3EyYcUStFuK7RxR0NudsTgnLI+vGcy3LurntrzxItFXFyh3zg7vThWLK6E9y2sW/PH8VE6VElCUFpZRvuggKNlQLb6EmjNL7Abqc8GT3EGhw5aUKfQcF17QCvZ6NAjsXXmKhS6PQhlE+k5nNG7TEVmmhAAAA", "checkText"],
  [501, "gate-r17-er--g1.ts:gif_deflated#16; gate-r17-er--g1.ts:gif_deflated#17; gate-r17-er--g1.ts:gif_deflated#18", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAxXLQQuCMBgG4P/ynkcmRcE6zYo6BFbWocTD2r5ssLlQM5b438Pn/uTQspXcOFlSVJrn6iEbWszZeWp36ca+xEkkYrQ3KoTomIU4y7a/9HKdpYfghVi7LrnflmDQXk2cBuvRUu0a8LxHJ+2HwCGVI+XrNxisqQg8HgoGaa3/kgbPC4bKtzSmYij+ylSWo5UAAAA=", "checkText"],
  [502, "gate-r17-er--g1.ts:gif_truncated#19; gate-r17-er--g1.ts:gif_truncated#20; gate-r17-er--g1.ts:gif_truncated#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA0WLvQrCMBRG3+Wbgz+gDpEOt1W0IIhdS4Zrc1sDSSNt1aH03UUUPMs5yylheWDtAjcyb1y9vXIvm5UqFv5w3vkbXSilnP5kx3X6y9NXKdGeiPKsoCSBgo3VLFioEYN0oYcuRzzZPwQaXAWpYneHgnetQC8no8Dex5dY6NIotHGQz2Qm8wYC83/3nQAAAA==", "checkText"],
  [503, "gate-r17-er--g1.ts:gif_noct_declared#22; gate-r17-er--g1.ts:gif_noct_declared#23; gate-r17-er--g1.ts:gif_noct_declared#24", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAyXLzQqCQBSG4Xv51kM/UC0mXBxNSggktzKLk3M0YcYJtVyI9x7hu3lWbwnLI+vWcyPbpq3PTx7kdFDFzl3zi3vRg2LKiCi5HWNau6/ERCkRZUlBKeVTFEHBhmrjLdSMUXo/QJczvuw+Ag2uvFShf0PBtZ1A7xejwM6FSSx0aRS6MMp/Mov5AcML0T2ZAAAA", "checkText"],
  [504, "gate-r17-er--g1.ts:gif_octet_stream#25; gate-r17-er--g1.ts:gif_octet_stream#26; gate-r17-er--g1.ts:gif_octet_stream#27", "refusal", "quiet", "quiet", "H4sIAAAAAAAAA0WLvQrCMBRG3+Wb4x+oQ8ThthYtCMWuJcM1vWAhaUob7VD67iIKnuWc5VSoObLmrnON5diEdhVslLgYYi/sD3ceZL9V5dqdi5N70I0SyulPetklv7x+lRBlRJSnJWVUjMcjFOpgl76GmhCl9wN0NeHF7inQYOvFhr6Dgmtagd7MRoGdC6PU0JVRaEOUz2Rm8wYUh34RsAAAAA==", "checkText"],
  [505, "gate-r17-er--g1.ts:gif_nomime#28; gate-r17-er--g1.ts:gif_nomime#29; gate-r17-er--g1.ts:gif_nomime#30", "refusal", "quiet", "quiet", "H4sIAAAAAAAAA0WLsQrCMBgG3+WbgyioQ6TDn1q0IBS7hgwx+cFC0kgb7VD67iIK3nK3nIa32crDzY6834p2HU7NMdzpSopq+lOed+qXl68UUUVEddlSRc1UFBDwya2ih5iReYgjpJ7xsuHJkLAuskvDAwKh6xlysxgBG0Ka2ENqI9CnzJ/JLOYNNpEBapgAAAA=", "checkText"],
  [506, "gate-r17-er--g1.ts:webp_good#31; gate-r17-er--g1.ts:webp_good#32; gate-r17-er--g1.ts:webp_good#33", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLzQqCQBQG0Hf51kMRSItpdY3ojxYKRiKzuDoXE2ccScuF+O7h9sApYHlk3XiuZTtJ2R9KHmQfqax15/SdE1H8SrNb8nQUXSnQClQ/TnGSX47U3qFgQ7XxFmrGKB8/QBczfuy+Ag2uvFTh00PBNZ1A7xajwM6FSSx0YRS6MMqazGL+CDPg+o4AAAA=", "checkText"],
  [507, "gate-r17-er--g1.ts:webp_exif_term#34; gate-r17-er--g1.ts:webp_exif_term#35; gate-r17-er--g1.ts:webp_exif_term#36", "private+refusal", "private", "private", "H4sIAAAAAAAAA03LwQqCQBRA0X9566FQLGhavZEojRYKWiIuxpmHimMTZUmI/x7Wprs8cHPQspe86WRFy4HK27aUD1p7LGnNPm4REcUlTsIoNeid0c4Q4F+zBz8XWJ12IsoOPrbHOK3DuP7yS7sroxpRZ65jMnfzVr7wgIG2atFpYCP0dO8ewPMRXtI8CThI1ZGy9xswMM2VgDtTwUAaYwfSwPOCwdX2NE/FVHwAsq2uB8YAAAA=", "checkText"],
  [508, "gate-r17-er--g1.ts:webp_exif_split#37; gate-r17-er--g1.ts:webp_exif_split#38; gate-r17-er--g1.ts:webp_exif_split#39", "refusal", "quiet", "private", "H4sIAAAAAAAAA03LvQ6CMBRA4Xe5c6MB0aHG4bIobDYBJYSh0Bt+bCkBhIHw7gZdPOOXnBSUHCWvjSxpP1PenXM50Mlj0UtfRZMgov8UUXiPNXoPtIiIAf4l4ioU5eb+pNyjLmq/SlxH//z7N/khnINbeQEGyhY7o4AtMFJvBuDpApPUbwIOsjBU2L4DBrpuCbizZgyk1nYmBTzNGLR2pG3K1uwDOFx4k7oAAAA=", "checkText"],
  [509, "gate-r17-er--g1.ts:webp_xmp_odd_term#40; gate-r17-er--g1.ts:webp_xmp_odd_term#41; gate-r17-er--g1.ts:webp_xmp_odd_term#42", "private+refusal", "private", "private", "H4sIAAAAAAAAA03LTQuCQBSF4f9y10OhWNS0uqaURQsFKxEXo15MHB3xkxD/e1ibzvLhvCGkohM8L0VG65Hi+hCLlrYG8wt58gpERPPp+Rf3LtF4oFrAwb8t7vzcxOxmm25wPmJxfdia65jfy46szSvQNRno+3dijQNZRg8MUpWsyhTYBB01ZQs8nGAQsifgIJKSEtXUwEDmFQHX5oiBkFKNlAIPIwaV6miJojn6ANAtfOPGAAAA", "checkText"],
  [510, "gate-r17-er--g1.ts:webp_unknown_chunk_term#43; gate-r17-er--g1.ts:webp_unknown_chunk_term#44; gate-r17-er--g1.ts:webp_unknown_chunk_term#45", "private+refusal", "private", "private", "H4sIAAAAAAAAA03LzQqCQBRA4Xe566FQJGha3ZHojxYJpSYuxvFi4bURtULEdw9r01l+cBLIdaflvdIFzd+U1atMt7TwxLnkTVAiIqooOO9PF0YvRDvBDv+afPdzhcVxrU7x1sfyEHKtw9uXb7HrcOwue+Or2vTKXqM9g4DcmlmVgxigo6ZqQSYDvDQ/CSRoU5GxTQ0C+P4gkM6YCtDM9k05yCQV8LAdTVM6ph+hioJ4xgAAAA==", "checkText"],
  [511, "gate-r17-er--g1.ts:webp_deflate#46; gate-r17-er--g1.ts:webp_deflate#47; gate-r17-er--g1.ts:webp_deflate#48", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAxXLQQuCMBQA4P/yzqMILGzRYR2KdAWJRiA7PLfHkDYnagqJ/z367l8JBgfktUdL64mq9lBhT7uIFW93yawQQpxeWZE8KPlKGe+lfCbX/La95zoaUytEivHZ2eMRGJigV94Am2GgzvfAyxlGdB8CDqg96dC1wMDVDQHfLIoBOhcmMsBLxaAJA/2TWtQPqQ/bu5YAAAA=", "checkText"],
  [512, "gate-r17-er--g1.ts:webp_firstbad#49; gate-r17-er--g1.ts:webp_firstbad#50; gate-r17-er--g1.ts:webp_firstbad#51", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAxXLsQqDMBQF0H+5c2gplAzplC4FNwNKIWR4Jg+VJkY0rYP478XxDMciUCE1Jur5unE3PzpaWd5F84kvM2it9fNtmqo27VCZvj4teZolBEL2lxQgdhRe0gpld/wofhkK5BP7vMwQiOPEULfDCVCMeeMAZZ3AlAufyR3uD/XLIceGAAAA", "checkText"],
  [513, "gate-r17-er--g1.ts:webp_oddpad_bad#52; gate-r17-er--g1.ts:webp_oddpad_bad#53; gate-r17-er--g1.ts:webp_oddpad_bad#54", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAx3LvQrCMBQG0Hf55qAIxSFO18Uf6GChIoQMt8mlFpOmtNEOpe8uuh44Bp4z6y5yK9tZmuHQ8CT7QtWvcKqeRETHR1Vfb/dAxYXKP1BbnqHgk9tED7UgyxgnaLPgw+Et0GAXxaVxgELoeoHerVaBQ0izeGhjFfqU5Zfsar8N3PjIhgAAAA==", "checkText"],
  [514, "gate-r17-er--g1.ts:gif_xmp_app#55; gate-r17-er--g1.ts:gif_xmp_app#56; gate-r17-er--g1.ts:gif_xmp_app#57", "refusal", "quiet", "private", "H4sIAAAAAAAAA0XLQQuCMBiA4f/ynUdmRNE6fdqyOhQTxEJ2mNtSY7pQK0L87xEdes/Pm4GWvaRVLQvjFdV1ncvOLOYkntrotLElcgxwj//CnRf65TEJA3Y5x2XKfB5E21ueJuwyW70VYveDDJEjYnFgyHEJBLRTk1oDGaA3bd0BzQZ4SvswQEGq2ijX3oGArRoD1B8FAWmtexkNNBMEGteb7yRG8QHmX5MqtQAAAA==", "checkText"],
  [515, "gate-r17-er--g1.ts:gif_pt_text_ext#58; gate-r17-er--g1.ts:gif_pt_text_ext#59; gate-r17-er--g1.ts:gif_pt_text_ext#60", "private", "private", "private", "H4sIAAAAAAAAA0WLvQ6CMBRG3+XOjT/RONQ43AISXQwOOpAOF3pFsKUGUAbCuxvC4Jm+nC8nBUMdydJRwcuifOwzanm3FdeVjS+hfWKCCk/4J4hUOC+FGM0qPlbZ/VZlm3OPQT+/U4cY4CtRGLYHEGB8vnAGxAAdN64FmQ7wJfthkEC549w3bxBgy5pBrkctgKz1PRuQqRZQ+46nSI/6B2HmJ+m1AAAA", "checkText"],
  [516, "gate-r17-er--q1.ts:plain_wrapped#1; gate-r17-er--q1.ts:plain_wrapped#2; gate-r17-er--q1.ts:plain_wrapped#3", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2NW2+CQBSE/0pznkmVlFql8eGACF6Kstu1tcrDCltKXRbFC6Lxvzfbl5nJl8zMCqgQDyk/cjsveCZaO5W9bvhBdCwjXzgzUrcnflYiIoaU/Xgs09HT4ri41P49TOhYB/wMKWmPsDpYSSfSgKiImQ6ie1mr3/rcXUZM41JIsky98Lz5MOVGRYhBnjRNa04bk1LvOntnT7Nps4uoeyGTt5fRtNn66O8jN7zsg958slZ6ZsCkFy2Ipfy5de0O6qDGIWLQyr+2veD/3xkT9uxV23GWZf3+WgmVggFpmTwWKRg3OIqqOIC9usGZy5MAG3hSiKSsdmCAzJUA27zHBnApy1qkYK9iA1R5FLoU3+M/aHT6ID4BAAA=", "checkText"],
  [517, "gate-r17-er--q1.ts:apos_before_after#4; gate-r17-er--q1.ts:apos_before_after#5; gate-r17-er--q1.ts:apos_before_after#6", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2NTW+CQBiE/wp5L16ISkqt0nh4QQQ/isIWWyscELZIhV0FKqLxvzfby8zkSWZmBxPOOrWUcKk+ZFU3YIRSKYnqSMuKKKW9E0tf91FFB6qcbfSV1/QXVsoRER3iH0w/FdEUohu4Ff49jclcBPx0iNefYVmp8cAVwGOur+iIxjVgP81luHV9gTnNvW1iOpf9h5LvmYtoZ3Hb9takVQgxb6t3/2m1bE8uMa7e4u1ltmyPFlpn13CuZ3u0XgRMzEz83HQ3nsqstXobThq7wSmi3cu+jiP7/1+fe/6zWR7naZqOxwGb1Z1KSjijXZAh4XG3SEC+Q03LogJtd4dLlP9S0CCKCxrz8gQy5BmjoCmPUIYoz3lDE9B2oQyM11SUwkf4B7dkOMNVAQAA", "checkText"],
  [518, "gate-r17-er--q1.ts:apos_before_after_far#7; gate-r17-er--q1.ts:apos_before_after_far#8; gate-r17-er--q1.ts:apos_before_after_far#9", "quiet", "private", "private", "H4sIAAAAAAAAAx2NzXKCMACEX4XJxQuDZUqt0vEQEMGfohCxtcIhkjRQMUGgIjq+eye97O58M7u7BxPBe41ChNJkea3FHFGqENxgMz9hRvslZ28HXNOBoeZbaxW2TwuXCQgh9FGUORGT0ZFi2XAn/XuaorkM8NNH4dMMVrWRDgIJQh5EugWhfY35T3sZ7oJIYkGLcEcc/3L40IsDDyD08rTr+mvU6Qg5t9Umel4tuzJA9jVcvL/Olt3Rhe45sP3r2RutFzGXM5OocIJtaHB3bdyGk9Zr4RRCr59/HUfe/781D6MXpzrOGWPjccxjvsmoUuIKswqXmSYJ5ETJm16tEMGpBlRARKqdCFDvoKHVqQbm/g4uuPilwAQ4PdFUVCVQQZFzCkz9kagAF4VoKQHmPlEBFw2VpeSR/AEi3TDHbQEAAA==", "checkText"],
  [519, "gate-r17-er--q1.ts:dq_before_after#10; gate-r17-er--q1.ts:dq_before_after#11; gate-r17-er--q1.ts:dq_before_after#12", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX4Wca6IS0SqNFwdE8KcoILZWuFiXLVJhV9GK1PjuzfZmZvIlM7OD9YEp3RiUnApuxDwlV2LkJclY+8Sz1z25sL6u5htzGdSduZMJREQvjA52lMloSzEt3Er/mtBwJgN+eGHQmWJ10WnflyDgfqSZiNY95t/1bbD1I4kFK4Jtanu3/btW7LmP6Oa0adqrsNHC0P5drqPuctGc/NC6B/O3l+miOTronH3Lu5/d4Woeczkzjgrb3wQ6d1b672BcuzVOEN12/nkcuv//5iyIenZ1nGVZNhrFnPBUIUovBkVw1gIVUkFbZQrqA66sKi9g7B5wI8UPAwMILRkV1QlUKHLOwNCeiQqkKETNUjB2iQpcXJksJc/kD80e7JRUAQAA", "checkText"],
  [520, "gate-r17-er--q1.ts:bt_before_after#13; gate-r17-er--q1.ts:bt_before_after#14; gate-r17-er--q1.ts:bt_before_after#15", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX8Wca6KSUqsYLw6I4E9RoGtrhUSELaUuiwIV0PjuzfZmZvIlM7MHUtLOofF5HFahmmZhQntnnoyPYUkHipRutbVb95dmkiMi2h75NkgioiFE03En/GsWeQsR8MP23P4ci1KJBo4ALneIrCHqjc9/6utw5xCBc8rcXWzY1+O7zI7cQbTSqG17G6+VPc+4rd/I03rVnh1Pb9zl68t81Z5MNC+ObjcXa7RZ+lzMTAkznK2rcHOj3IbT2qpxhmj10s/TyPr/1xYueTaK0yJJksnE5+2hU+WdktIuSBDnUTeLQbpDRYusBHV/h2vIfimoEEYZjfLiDBKwlFNQ5UcgQchYXtMY1H0gAc8rKkrBI/gDtMa1vUkBAAA=", "checkText"],
  [521, "gate-r17-er--q1.ts:apos_same_line_before#16; gate-r17-er--q1.ts:apos_same_line_before#17; gate-r17-er--q1.ts:apos_same_line_before#18", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2NTW+CQBiE/0rzXryQWlJqlcbDCyL4UXSh2FrlsMJ2S10WBSqi8b8328vM5ElmZgOjQnZq8y6lNTWznHLWPUj+sqMV6xlatrIWQfMwc3mBiOiH0bcTcRUdJZaNa+Vf4yScqoAffhg8TLCsjKRHFAgkiXQL0T5v5U9z6q9JpHDBRLBOHf+0e9fFThJEL0vatrsMWz0MncviLXpczNsDCe1zMHt9nszbvYvukdj++egNlrOtVDOjSDhkFRjSXRqX/qjxGhwjet3scz/w/v+taRA9OeV+yjkfDrcyqzsVaJAWyX2egnaFmpV5BebmCicqfhmYQJOcJUV5AA1EJhmY+i3WgApRNCwFcxNrIIuaqVJ8i/8Akl6A+EIBAAA=", "checkText"],
  [522, "gate-r17-er--q1.ts:apos_dq_inside#19; gate-r17-er--q1.ts:apos_dq_inside#20; gate-r17-er--q1.ts:apos_dq_inside#21", "private", "private", "private", "H4sIAAAAAAAAAx2NTW+CQBiE/wp5L72QKim1SuPhBRH8KLpQbK1wWGFLKbAooIjG/95sLzOTJ5mZHdhMqmkaS2nzUEsBxLShWlrQhPUOPHnd05oNVDnd6Cu37S+spEREdDz/x/QTEU0huoFb4d/TyJuLgJ+O5/ZnWNVqNCACuJz4io5oXAL+256HW+ILXLLc3camc95/KPmeE0Q7jbqut/Y6xfPM6+rdf1otuwPxjIu7eHuZLbvMQutIDOdytEfrRcDFzMTPTbJxVW6t1etw0totThHtXvqVjez/f33u+s9mlc2TJBmPA5DKDGSIy+ixiEG+QcOqogZtd4MzzU8MNKBRwaKyOoAMecoZaMo9lIHmedmyGLRdKAMvGyZK4T38A9FTHLZJAQAA", "checkText"],
  [523, "gate-r17-er--q1.ts:apos_then_quoted_js#22; gate-r17-er--q1.ts:apos_then_quoted_js#23; gate-r17-er--q1.ts:apos_then_quoted_js#24", "quiet", "private", "private", "H4sIAAAAAAAAA0VOzW6CQBh8lc138VBSJKVWMR4WRPAPBYqtFQ4rbCkVdhWoiMZ3b7aXXmYmM5nJ7ECWUVZ3qpDFnFU1ImiEQkhITbSsICmVjywd7klFe6qUbfSV13TnVsoxxtjxgy8zSIU0BegG3gr+nMT+TAj87vhed4rLSo17rjA85gaKjrFxCQE9hAyhEL6bc3/rBiLmNPe2iemc929KvmcuxnYWt6289lvF983r6jV4Wi3ao+sbF2++fJku2oOFrZNrOJeTPVjP/1fF3DjITXfjqcxaq9f+uLEbPMHYlrOPw8D++6PPvODZLA+zNE1HoxCGIZNllHDWqUGChMePRQLSDWpaFhVouxucSf5DQQMSFzTm5REkyDNGQVPukQQkz3lDE9B2kQSM11SUonv0C9/9IIdnAQAA", "checkText"],
  [524, "gate-r17-er--q1.ts:tick_enclosing_unq#25; gate-r17-er--q1.ts:tick_enclosing_unq#26; gate-r17-er--q1.ts:tick_enclosing_unq#27", "quiet", "refusal", "private", "H4sIAAAAAAAAAx1P226CQBT8FXOeSZWUWsX4cEAEL0VZiq1VEhC2SIVdRRTQ+O/N+jIzmWRmMhsgF9YKaLTnQavcU9aKwzJU0zxMaPvIksEuPNOuIqUrbUGqzsxMOCKi7Xp7w0uENARoOq4F/44jdyoEftsu6UywOCtR1xEGYY4na4h6vWV/1bW3djxhc5qRdWzY192XnO2Yg2ilUdO0l24ju65xW3x6r4t5c3RcvSazj/fJvDmYaJ4c3a5PVn852zJRM/Iyw1kRhZlL5dYbVVaFY0Srnf4c+tZzX5sS780oDtMkSYbDLXueDWidlgFIEPPoJY9BukNJi/wM6uYO1zC7UFAhjHIa8eIIEmQpo6DKD1+CMMt4RWNQN74EjJdUhPyH/w9/1m+hUgEAAA==", "checkText"],
  [525, "gate-r17-er--q1.ts:md_link_with_paren_text#28; gate-r17-er--q1.ts:md_link_with_paren_text#29; gate-r17-er--q1.ts:md_link_with_paren_text#30", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX6U5V5qQKim1SuPFARH8Q5cttha5WGBLqbAoWhGN795sb2YmXzIzAQTsoRW1w1bCTkzPCpbyzl6krxE78p6mZGtj6dXdmZ2WiIgu9b8tP5XRkmKYuJH+NY7pVAb8cKnXnWB11OIekcATxFcNRPOyFT/1ub8hvsQlz71NYrnn6F3NI0EQnSxums6KNiql1nX55j8t582eUPPizRYvk3mzs9E+ENO9HJzBarYVcmbk5xZZe5qwV9q1P6qdGseITif73A2c/39j6vnPVrWbpmk6HLZBgaSMH4sElBuceFUcQQ9ucGb5LwcdWFzwuKz2oECeCQ66eg8VYHle1jwBPQgVEOWJy1J4D/8A43qgxT4BAAA=", "checkText"],
  [526, "gate-r17-er--q2.ts:js_call_args#1; gate-r17-er--q2.ts:js_call_args#2; gate-r17-er--q2.ts:js_call_args#3", "quiet", "private", "private", "H4sIAAAAAAAAA0XOS2+CQBAA4L9i5tSmpEpKrWI8LIjgoyhQbK1wWGFLqcsuAhXR+N+b7YXLPPNNZgeU43iW4YTcBRDjCqupaLo5S0Z7XJK+IgXQeQhYpxNAutFWbt1bmAlHCCHb878NPxGlIYKmo63IX62YRt5cjNCH7bm9GSpKJeo7YuAyx5c1hPTzT30atGLr+GLNCXW3sWGf9u8y3TMHISuNmqa79hrZ84zLqhVv/tNq2eSOp5/dxevLbNkcTGQeHd0+H63heiHOTXxqtMLZuAoz18plMKmtGk0Rsrrp52Fo/X+mzV3/2SgO86QVSTIeByB1eF6lnJX3I5Ag5tFjFoN0hYoUWQnq7gonTH8JqICjjES8yEECmjICqnwLJcCU8prEoO5CCRiviEDhLfwDnezZcYYBAAA=", "checkText"],
  [527, "gate-r17-er--q2.ts:js_call_args_lead#4; gate-r17-er--q2.ts:js_call_args_lead#5; gate-r17-er--q2.ts:js_call_args_lead#6", "quiet", "quiet", "private", "H4sIAAAAAAAAA0XOS2+CQBAA4L9i5tSmpEpKrWI8LIjgoyhQbK1wWGFLqcsuAhXR+N+b7YXLPPNNZgeU43iW4YTcBRDjCqupaLo5S0Z7XJK+IgUQsE7noRNAutFWbt1bmAlHCCHb878NPxGlIYKmo63IX62YRt5cjNCH7bm9GSpKJeo7YuAyx5c1hPTzT30atGLr+GLNCXW3sWGf9u8y3TMHISuNmqa79hrZ84zLqhVv/tNq2eSOp5/dxevLbNkcTGQeHd0+H63heiHOTXxqtMLZuAoz18plMKmtGk0Rsrrp52Fo/X+mzV3/2SgO86QVSTIeByB1eF6lnJX3I5Ag5tFjFoN0hYoUWQnq7gonTH8JqICjjES8yEECmjICqnwLJcCU8prEoO5CCRiviEDhLfwDbWjH34YBAAA=", "checkText"],
  [528, "gate-r17-er--q2.ts:yaml_comment#7; gate-r17-er--q2.ts:yaml_comment#8; gate-r17-er--q2.ts:yaml_comment#9", "private", "private", "private", "H4sIAAAAAAAAAx2OW3OCQAyF/wqTvjJVptQqHR8CIngpylJsrfKAsN1Sl13FC6Ljf+9sX3JyTr5ksoIik8LS1pCnx9QqypTR1k6w1016oB1TLxb2jNTticckImIQxT9uzFTrqmI7uFT6vRaaNsyisTL4GUSkPcLqYGadUAVEhLFhIzqX3/rcVewyjNVAUk6WuRucNx8G34gQ0S+ypmnNo8aIIvc6U+x7/DSbNrswci5k8vYymjZbD7196ASXvd+bT9ShQcxdxYYLYgpvbl67g9qvcYjot4qvbc///8Mek/jZrbZjpljG+v01aNqDxiWToEMus8cyB/0GR1qVB7BWNzin/ETBgjQraSarHejAC0HBMu6JDinnsqY5WKtEByGPVC0l9+QPw0lXt1cBAAA=", "checkText"],
  [529, "gate-r17-er--q2.ts:prose_after#10; gate-r17-er--q2.ts:prose_after#11; gate-r17-er--q2.ts:prose_after#12", "private", "private", "private", "H4sIAAAAAAAAAx1QzW6CQBh8FfKdiUpKrdJ4WBDBn6KwYmuFA8J2pS67ClRE47s362VmMslMJrOD9YEol4T9ESWCLKkTIy8SSronTt/3SUX6uppvzGXQ9OYOFQgh5OHwYIdUSluCaaGt5J+IT1I8kxJ9eTjoTVFZ6Wnfl0bA/VAzEbKuv81lEPGtH0pbEBZsM9u77D81tuc+Qm6etm13hVsNY/u2jPg6fFku2pOPrWsw/3ibLtqjg5yzb3nXsztczWXNOGR2xP1NoHNnpd8G48Zt0AQht5t/H4fuc4E5C8JXuzzOaMQpHY0iUPJKqQ9EYYKKDqiQibRTZKDeoSZlUYGxu8PzGTAgSQuSivIEKrCcEzC0R6xCwphoSAbGLlaBi5rIUPyI/wGQG56hVgEAAA==", "checkText"],
  [530, "gate-r17-er--q2.ts:json_inline_trailing#13; gate-r17-er--q2.ts:json_inline_trailing#14; gate-r17-er--q2.ts:json_inline_trailing#15", "private", "private", "private", "H4sIAAAAAAAAAyVQTW+CQBT8K807kyoptUrj4YEIfhQFiq31cVhhS6mwKFoBjf+92fYyM5lkJpPZwJUgi0tBoN8RJOzE9KxgKe/sRfq8ZUfe05RsZSz8ujuz0xIR0Q3CLytMpbQkGCauJX8SiXEcTKXGdzfwuxOsjlrc86ThCy9UDUSz+a7PfSKx9kLplzz314nlnrdvar4VHqKTxW3bWQatGgTWZUEkXsOHxbzde4HZ+LOXp8m83dloHzzTbQ7OYDmTPaMwt4iEt/I1YS+1S39UOzWOEZ1O9rEbOH8jjKkfPlrVbpoSiTQdDgmUOwLBCv5/QENwAwWSMr4vElCucOJVcQR9c4Uzy3846MDigsdltQcF8kxw0NVbpADL87LmCeibSAFRnrgMRbfoF7tFaoZhAQAA", "checkText"],
  [531, "gate-r17-er--q2.ts:js_obj#16; gate-r17-er--q2.ts:js_obj#17; gate-r17-er--q2.ts:js_obj#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA0XOTW+CQBAG4L+ymYuHkiqpbZXGw4AIfhQFiq0VDrhQSl1ZBSqg8b832wuXmck7eSazBcqzoiScjMiVFDlViA/pWl06VW9uJBwR0XK9b91LxKiLomq4Ef3LB3LnZ4T4MKHuTET4YblOb4p50adPtgiczPZkFVGrf6rzoBUb2xNrHjNnE+nWefcus11mI5opbZruym1k19Uvy1a8eQ/LRXO0Xa125q/P00WzN9A42ZpVn8zhai7OjT2mt8JeO/3MWPUvg3FlVjhBNLvp535o/n+mzhzvUc/3s6QVSTIa+SCRkJUK6dQdcnsBCSJO7w8RSFco4/xQgLK9wjlkvzEoENJDTHl+BAlYmsWgyLdAgpAxXsURKNtAgoyXsUDBLfgDmi0oDG8BAAA=", "checkText"],
  [532, "gate-r17-er--q2.ts:js_endcomma_nl#19; gate-r17-er--q2.ts:js_endcomma_nl#20; gate-r17-er--q2.ts:js_endcomma_nl#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA0XOTW+CQBAG4L+ymYuHkiqpbZXGw4AIfhRlKbYWOChQSl13FayIxv/ebC9cZibv5JlMALHg5ZEIMiABCSFf6nNadaZWJhARHc//Nv1MjqYsuoEr2b9CIHchJySEUexNZIQfjkc7YyzKbvzkyoBy11d1ROP8U516jVi5vlyLlNFVYjqnzbvKNtxFtPO4rtsLr1Y9z7zMG/HmP8xn9d71jDOdvj6PZ/XWQuvgGs75YPcXU3lu6DOzEe6Sdrm16F56w8qucIRot/PPbd/+/0yfUP/RLLaTrBFZNhiEoISctDYtEr2AAomI73cJKFc4psWuBC24wmnNflPQYB3v0lgUe1CA5TwFTb1FCqwZE1WagBZECnBxTCWKbtEfHqyQBmcBAAA=", "checkText"],
  [533, "gate-r17-er--q2.ts:py_dict#22; gate-r17-er--q2.ts:py_dict#23; gate-r17-er--q2.ts:py_dict#24", "quiet", "private", "private", "H4sIAAAAAAAAAx2Oy3KCQBBFf4XqzWyoKBVilJSLBhF8BAWCiTEsBphMiDwUiYiW/54aNn373j7d1TtIpLF0I5RoEkloTbU0p5z1DgV/ieiJDVQ53egrr+kvLF4iIjp+8GMGXLSmKLqBW6Hf5KuQyDT258Lhh+N7/RlWJzUeuCLwCjdQdETj8tuchx28dQMxKVnmbRPTOUfvShYVLqKdxm3bW/ut4vvmddXBb8HjatkeXN+4eIvX59my3VtoHV3DuRzt0XohLk2CzOxgd+OphbVWr8NJYzc4RbR76ed+ZHev6HMveDKr/Zx3MOfjMZElEhFNUu4gQ1LGD3kC8g1qVuUn0HY3ONPsj4EGNM5ZXFYHkCFLCwaacg9loFlWNiwBbRfKUJQ1E0vhPfwH04HXzl8BAAA=", "checkText"],
  [534, "gate-r17-er--q2.ts:py_dict_clean#25; gate-r17-er--q2.ts:py_dict_clean#26; gate-r17-er--q2.ts:py_dict_clean#27", "quiet", "private", "private", "H4sIAAAAAAAAAx2OT3OCQAzFvwqTCxemypRapeMhIIJ/igJdW2s5rLDdUhdQtCI6fvfOcsnLe/klkw2kylC5qVQ1FTWlJ2pmOeWssy/4y5YeWc/QspW1COvuzOUlIqIfkR+HcNk6slg2rqV+q1+Foo6TaCodfvhR2J1gdTSSXiCDsAiIbiHal9/63G/hdUDkpGQiXKeOf96+62JbBIheljRNZxk1ehQ510ULv5HHxbzZB5F9CWevz5N5s3PRPQS2fzl4g+VMXhoR4bRwsAqNwl0a1/6o9mocI3qd7HM38NpXrGlInpxqN+UtzPlwqN5Bg7RMHvIUtBucWJUfwdzc4EzFHwMTaJKzpKz2oIHICgamfo81oEKUNUvB3MQaFOWJyaX4Hv8D+caEU1cBAAA=", "checkText"],
  [535, "gate-r17-er--q2.ts:closing_then_paren_comma#28; gate-r17-er--q2.ts:closing_then_paren_comma#29; gate-r17-er--q2.ts:closing_then_paren_comma#30", "quiet", "private", "private", "H4sIAAAAAAAAAx2OW2+CQBCF/4qZFzTZVEmpVRofBkTwhi4UW2t5QFi3VC6KVkTjf2+WlzlzznwzmQ3smlIUnAM1TgPO2oeMv22DE+sqJF5pC6fsTE2eIyLarvdjeFy0hiiajmuhO+k7a0ij0J0Ih5+263TGWJyUsEtF4GTUkzVE/fpbXno1vKaemOQscdaRYV+2H3KyzSiiFYdV1V66ley6xm1Rw+/e82JWHairX53p/HU8q/Ymmkeq29ej1V9OxaWhlxg1TFeOkplL5dYbllaJI0SrHX/t+1b9ijZxvBej2E94DXM+GEgt0uDNFhCI8vApjYDc4cyK9ATq5g6XIPljoEIQpizMiwMQSOKMgSo/fAJBkuQli0Dd+ASy/MzEkv/w/wEa08TZVAEAAA==", "checkText"],
  [536, "gate-r17-er--q3.ts:js_clean#1; gate-r17-er--q3.ts:js_clean#2; gate-r17-er--q3.ts:js_clean#3", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L9C5lpSJaVWMR4GRPCjIFBsrXBYYUupsChQEY3/vdleuMxM3skzmR1EBatqgQgTIYCY1ERJc5LQ3pEl4z2p6EAWAxAeAiYIAaQb1Xab/tJICkREy/O/dT/ho86LquGW969OzCJvwSP8sDy3P8eykqOBwwOXOb6kImqXn+Y87MTW8fm6oJm7jXXrvH+Xsj1zEM00atve2mslz9Ovdife/Cd71R4dT7u4y9eX+ao9GGicHM26nMzResnPTf1M74SzcWVmrOXrcNqYDc4QzV76eRiZ/5+pC9d/1svDIulEkkwmAYwDBiLERfSYxyDeoKZlXoGyu8GZZL8UFCBRTqOiPIIIWcooKNI9FIFkWdHQGJRdKAIraspReA//AJ8TOIx+AQAA", "checkText"],
  [537, "gate-r17-er--q3.ts:stray_dq_before_js#4; gate-r17-er--q3.ts:stray_dq_before_js#5; gate-r17-er--q3.ts:stray_dq_before_js#6", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L+ymWuJSqRWMR4WRPCjKCC2VjisyxapuChQEY3/vdleuMxM3skzmR2sDwx1A0AJzXgr4DTjRYkIGqEAIlISNTmRmLXPPB7uScF6ihQAegk4QgEkG23pVp25GWcYY2x7/sHwYzEaomg63or+3YgJ9WYiwp+253amOC8U2nNE4HLHlzWM9dtPde03Yuv4Yp2x1N1Ghn3df8jpnjsYWwmt6/bKq2XPM+7LRqz97nJRnx1Pv7nz97fpoj6a2Lw4un27WIPVXJwb+6nRCGfjKtxcKff+uLIqPMHYaidfx4H1/5k2c/1XIz/O4kbE8WgUwDDgIEGU0dYpAukBJctPBai7B1xJ+stABUJPjGb5GSRIE85AlZ+hBCRNs4pFoO5CCXhWMoHCZ/gHWotSDI0BAAA=", "checkText"],
  [538, "gate-r17-er--q3.ts:stray_dq_before_js_2#7; gate-r17-er--q3.ts:stray_dq_before_js_2#8; gate-r17-er--q3.ts:stray_dq_before_js_2#9", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L9C5lpSJVKrGA8LIvhRFLbYWpfDCltKhUUBRTT+92Z74TIzeSfPZHaAkxvTpB4BwsOcl5VEpbFEIKIV1ZKMxqxz5PFoT0vWV2UC0hPhkkQg2egrr+4urDhHCCEH+z+mH4vRFEU30Fb071ZMQzwXEfp0sNedoaJUw74rAo+7vqIjZFx/68ugFVvXF+ucpd42Mp3L/kNJ99xFyE7CpumscaNgbN5WrXj3e6tlc3SxcfUWb6+zZXOwkHVyDed6sofrhTg38VOzFe7GU7m1Vm+DSW3XaIqQ3Um+DkP7/zN97vkvZnGYx62I4/GYwIhwkCHKw+csAvkOFSuyErTdHS40PTPQgIYZC/PiCDKkCWegKY9ABpqmec0i0HaBDDyvmEDBI/gDHL5g1IkBAAA=", "checkText"],
  [539, "gate-r17-er--q3.ts:stray_sq_before_js#10; gate-r17-er--q3.ts:stray_sq_before_js#11; gate-r17-er--q3.ts:stray_sq_before_js#12", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L9C5tJDSZWU2orxsCCCH0WBYmuFw7psKWXZVaAiGv97Qy9cZibv5JnMDjxBMumOS4VgLORE8LKSsDSWQohxhbU0xwntHXgy2uOSDlQ5BOk+5JIUQrrRV17dX1iJQAghxw++zSBpR7MtuoG2bf/qxJT48zZCH47v9WeoKFUycNvA426g6AgZ55/69NKJrRu0a0GZt41N57R/V9ieuwjZKWma3tpvFN83L6tOvAWPq2VzcH3j7C1en2fLJrOQdXQN53y0h+tFe24SMLMT7sZTubVWLy+T2q7RFCG7l35mQ/v/M33uBU9mkc2TTiTJeBzCKOQgQyzIQx6DfIWKFnkJ2u4KJ8x+KWiASU6JKA4gA0s5BU25RTJgxkRNY9B2kQxcVLRF0S36A341MtqMAQAA", "checkText"],
  [540, "gate-r17-er--q3.ts:stray_bt_before_js#13; gate-r17-er--q3.ts:stray_bt_before_js#14; gate-r17-er--q3.ts:stray_bt_before_js#15", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L+ymWuJSkqtYjwsiOBHVaDYWiEpLltKWRYFKqLxvzfbC5eZyTt5JrMHjFjOKfpEVULSjs9JzssKhWiMfIjCKlSTLIxp98jj0SEsaV+RfEAPPkfIh2SrrZ26tzDjHGOMV673bXixGA1RNB3vRP9qxZS4cxHh95Xr9Ga4KBXSt0XgcNuTNYz1y099HrRiZ3tinVPm7CJjdT68yezAbYythDRNd+M2susa13UrXr3H9bI52q5+cRYvz7Nlk5rYPNn66nKyhpuFODfxmNEKe+so3Nwo18Gktmo8xdjqJh/p0Pr/TJs73pNRpPO4FXE8Hvsw8jlIEOWkk0Ug3aCiRVaCur/BOWS/FFQISUZJXhxBApZwCqp8DyQIGctrGoG6DyTgeUUFCu7BH1H1uwGOAQAA", "checkText"],
  [541, "gate-r17-er--q3.ts:stray_dq_after_js#16; gate-r17-er--q3.ts:stray_dq_after_js#17; gate-r17-er--q3.ts:stray_dq_after_js#18", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L+ymWuJSqRWMR4WRPCjKCC2VjisyxapuChQEY3/vdleuMxM3skzmR3QjBclImiEAohISdTkRGLWPvN4uCcF6ylSAOgl4AgFkGy0pVt15macYYyx7fkHw4/FaIii6Xgr+ncjJtSbiQh/2p7bmeK8UGjPEYHLHV/WMNZvP9W134it44t1xlJ3Gxn2df8hp3vuYGwltK7bK6+WPc+4Lxux9rvLRX12PP3mzt/fpov6aGLz4uj27WINVnNxbuynRiOcjatwc6Xc++PKqvAEY6udfB0H1v9n2sz1X438OIsbEcejUQDDgK8PDHUDQAnNeCvgIEGU0dYpAukBJctPBai7B1xJ+stABUJPjGb5GSRIE85AlZ+hBCRNs4pFoO5CCXhWMoHCZ/gHregUFY0BAAA=", "checkText"],
  [542, "gate-r17-er--q3.ts:two_stray_dq_around#19; gate-r17-er--q3.ts:two_stray_dq_around#20; gate-r17-er--q3.ts:two_stray_dq_around#21", "quiet", "private", "private", "H4sIAAAAAAAAA0XOTW+CQBAG4L+ymWuJlohWMR4WRPGjKCC21uWwwhapsKtARTT+94ZeuMxM3skzmT1sjgx1CKA4ELxFeCB4XiCKRohASAuqximNWPvMo+GB5qynSATQC+EIEYi32sopXxfTSGCMseV6R8OL6tGoi6bjXd2/GzEJ3Hkd4U/LdV5nOMuVoGfXgcNtT9Yw1m8/5bXfiJ3t1WvBEmcXGtb18CEnB25jbMZBVbXXbiW7rnFfNWLjdVbL6my7+s1ZvL/NltVpiqcXW7duF3OwXtTnxl5iNMLeOgqfrpV7f1yaJZ5gbLbjr9PA/P9Mmzte18hO86gRUTQaERgSTnmIugRQKjLWIhwkCEXQSkOQHlCwLM1B3T/gSpNfBirQIGWByM4gQRJzBqr89CWgSSJKFoK69yXgomA18p/+H6+1rJCcAQAA", "checkText"],
  [543, "gate-r17-er--q3.ts:yaml_clean#22; gate-r17-er--q3.ts:yaml_clean#23; gate-r17-er--q3.ts:yaml_clean#24", "private", "private", "private", "H4sIAAAAAAAAAx2O3XKCQAyFX8XJNVNlSq3S8SIggj8FF4qtFS7WZUupsKtoRXR89872Jifn5EsmGyiYFGYngYyeqFlUNOfdvchftvTI+4ZWrKwgbHpzN5eIiH4UfztxrlpHFcvGtdKvRHQ6ExbNlMEPPwp7U6yPBusTFYSCxLqFaF9+mvNAsWsSq4HkZbjOHP+8fdfLrSCIXsHatruMWj2KnGug2Lf4MVi0exLZl3D++jxdtDsX3QOx/cvBGy7n6tA4Lh3FklVoCHdpXAfjxmtwguh1i8/d0Pv/w5qF8ZNT72a5YvN8NEogEaBBJtlDlYF2gxOvqyOYmxucafnLwQTKKs5kvQcNykJwMPV7qgEtS9nwDMxNqoGQJ66W0nv6Bwd+9ORRAQAA", "checkText"],
  [544, "gate-r17-er--q3.ts:stray_dq_before_yaml#25; gate-r17-er--q3.ts:stray_dq_before_yaml#26; gate-r17-er--q3.ts:stray_dq_before_yaml#27", "private", "private", "private", "H4sIAAAAAAAAAx2O3XKCQAyFX4XJNaMyUqt0vAiI4E9RQGytcLHCdqXCrqIV0fHdO9ubnOTkO5lsYbWnSjcGJU8Fb8VciqHEkJELMfKSMNo+cva2I2fa09V8bS6CujNzmEBE9MJob0dMtrYspoUbqd8xV5RxGk7lgJ9eGHQmWJ31tOdLI+B+pJmI1u2nvvYlu/EjuRC0CDaZ7V13H1qx4z6im6dN016GjRaG9n0h2VXUXcybox9at2D2/jqZNwcHnZNvebeTO1jO5KFRVNiS9deBzp2lfu+ParfGMaLbzr8OA/f/D3MaRC92dZgyyTI2HMYQc1AhE2mrzEB9wIVW5RmM7QOupPilYABJS5qK6ggqFDmnYGjPRAVSFKKmGRjbRAUuLlSGkmfyB3W/pxZgAQAA", "checkText"],
  [545, "gate-r17-er--q3.ts:stray_sq_before_yaml#28; gate-r17-er--q3.ts:stray_sq_before_yaml#29; gate-r17-er--q3.ts:stray_sq_before_yaml#30", "private", "private", "private", "H4sIAAAAAAAAAx2OQXOCQAyF/wqTSy9MlSm1SsdDQAS1RVm6tlY4IGwpdVkUqIiO/72zveTlvXzJZAt3o36t1E3HWSjypBSGEkIaN7GRF3HGegeRPe/img10NV+bS9L2F05WIiJ6Af22aSZbWxbTwo3Ur1AoyjQJ5tLghxeQ/gyrWk8GvgyI8KlmIlrnn/Y0lOzGp3JQMk42qe2ddu8a3wkf0c2Truutgk4LAvuylOwbfVi+dAc/sM5k8fo0e+n2DjpH3/LOR3e0WshDE8ptyfprogtnpV+Gk9ZtcYro9vLP/cj9/8OcE/poV/t5JtksG49DCAWokJbJfZGCeoWGVUUNxvYKp5j/MjAgTgqWlNUBVOC5YGBot0iFmPOyZSkY20gFUTZMLkW36A8QvirTXQEAAA==", "checkText"],
  [546, "gate-r17-er--t1.ts:lines#1", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MsU7DMBRA0X95swVCQgxmZWLrwJRmMImHSk5StS4gVf33in/oeIY73jPEXHrJvf7152Mrh/X9u5zr22vafX1+PKL9SiKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpEeJ0WKeZueljnSNXo9LefIwzV+SrvUyFGmpU7b6Rgp2mGtkV9uY4rS2vZb58jDmGLdev2fxtt4B8jYc/rwhAQA", "checkText"],
  [547, "gate-r17-er--t1.ts:lines#2", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MrW7DMBhA0Xf5sLWp0jTg0aGxgqEswEsMKjlJ1Xo/UtV3r/oGA4MHXHjPEHPpJff62x+PrRzWl89yrs9Paf/+9voffawkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolE+psUKeZteljmSJfo9bScIw+X+C7tq0aOMi112k7HSNEOa428u44pSmvbT50jD2OKdev1Po3X8QZnsafZsBESAA==", "checkText"],
  [548, "gate-r17-er--t1.ts:lines#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+zMoQ5AUBQA0H+RbYoJVEkTJMo1L9jszeYFn+8nxBNOPWt1RIm+pLc09xVnHvZ4UtfW8zKNf9iyyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUymr505RmEQhgIAepc/h0LXXEUyiGYoRCPWtoN499JbdHgHeM9kMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTP86RYq5T7dljnTGUfflGXk44z22V40c47TUqe9bpGiPtUa+XyXF2Fr/1DnyUFKs/ag/VK7yBeoOj/+wREgA", "checkText"],
  [549, "gate-r17-er--t1.ts:lines_q#4", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MvUoDQRhA0VeRr3VQBEkxtlZ2Fla7W4y7UwT2JyQTFULePfgOKU9xy3u66GMqreRW/9rzYS779e27nOruNX1+fbzfoz4eHvu1Dx6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xi8+3qRYtrGp2WKdIlWj8spcneJnzKfa+Qo41LH7XiIFPN+rZFfrkOKMs/bb50id0OKdWv1fxquww2GWxZUtuIEAA==", "checkText"],
  [550, "gate-r17-er--t1.ts:lines_q#5", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MMU7DQBRAwaug37ICIaEUpqWio6CyXSz2FpHWdpRsACnK3SPOAOUUr3zTxxBzbrlr5ac9Hmrery+f+VR2z+n94+31Pxri7n5Yh+DxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/F4PB6Px+PxeDwej8fj8Xg8Ho/H4/3FixTzNj0sc6RLtHJcTtH1l/jK9VyiizwtZdqOh0hR92uJ7uk6psi1bt9ljq4fU6xbK7/TeB1vM5TGibaIEwA=", "checkText"],
  [551, "gate-r17-er--t1.ts:lines_q#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+zMoQ5AQAAA0F+xq2yKCVRJEyRXzgg2M5sLPt9PiC+8+pYQw5Zy6vL+5vo+03H1a3r2tqmmeRz+EENRxisGn8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+XxfO3NwgyAMBQB0l39uTLx2FdIDgR5MCiWIeiDsbpzDN8B7Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n8/l8Pp/P5/P5fD6fz+fz+Xw+n8/n+88vUsx9ui1zpDOOui/PyMMZ77G9auQYp6VOfd8iRXusNfL9KinG1vqnzpGHkmLtR/2hcpUvlpXrx7YgTgA=", "checkText"],
  [552, "gate-r17-er--t1.ts:lines_unclosed_q#7", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MsU7DMBRA0X95s0WFhBjclYmNgSnNYBIPlZykak1BqvrviH/oeIY73jPEIebSS+71t+9OrRzX/Ve51NeX9PH5/vaIDiuJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEepwUKeZtelrmSLfo9bxcIg+3uJb2XSNHmZY6bedTpGjHtUZ+vo8pSmvbT50jD2OKdev1fxrv4x8d5PsP8oQEAA==", "checkText"],
  [553, "gate-r17-er--t1.ts:lines_unclosed_q#8", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MsU7DMBRA0X95s0WFhBjclYmNgSnNYBIPlZykak1BqvrviD9gYDzDHe8Z4hBz6SX3+t13p1aO6/6jXOrzU3p7f335jw4riUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikUgkEolEIpFIJBKJRCKRSCQSiUQikf4mRYp5mx6WOdItej0vl8jDLa6lfdbIUaalTtv5FCnaca2RH+9jitLa9lXnyMOYYt16/Z3G+/gDTQw49LIREgA=", "checkText"],
  [554, "gate-r17-er--t1.ts:lines_unclosed_q#9", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+zMIQqAMAAAwL8sCxYxaDXZDCZXJi4IMgQXfL6fMF64eluI4Ug1DTW/tb2vdJZxT0/uu2ZZ5+kPsZhMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPpa2eOURiEoQCA3uXPodA1V5EMohkK0Yi17SDevfQWHd4B3jOZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8lkMplMJpPJZDKZTCaTyWQymUwmk8n0r1OkmPt0W+ZIZxx1X56RhzPeY3vVyDFOS536vkWK9lhr5PtVUoyt9U+dIw8lxdqP+kPlKl+wBwP2skRIAA==", "checkText"],
  [555, "gate-r17-er--t1.ts:many_cands_q#10", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsUrDQBgA4Fcp/3wogjicq5Obg1OS4UxuKFyS0p5aKH138T2++eMbYozrYSm95F6v/fHUynF7/SqX+vKcPj7f3w6cc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnY4xbpFj2+WFdIt2i1/N6iTzc4qe07xo5yrzWeT+fIkU7bjXy031KUVrbf+sSeZhSbHuv/2m6T387fAeZU/QBAA==", "checkText"],
  [556, "gate-r17-er--t1.ts:many_cands_q#11", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMUoDQRQA0KuEXw+KIBZja2VnYbXZYtydIjC7G5KJBkLuLh7C7tWPN8Q+rru59JJ7vfbHYyuH9fWrnOvLc/r4fH/bcc4555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnP+/79dIMW/TwzJHukWvp+UcebjFd2mXGjnKtNRpOx0jRTusNfLTfUxRWtt+6hx5GFOsW69/abyPvyb8R1dT0AcA", "checkText"],
  [557, "gate-r17-er--t1.ts:many_cands_q#12", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMUoDQRQA0KuEXw+KIBZja2VnYbXZYtydIjC7G5KJBkLuLl5DXv14Q+zjuptLL7nXa388tnJYX7/Kub48p4/P97cd55xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOf/vvl8jxbxND8sc6Ra9npZz5OEW36VdauQo01Kn7XSMFO2w1shP9zFFaW37qXPkYUyxbr3+pfE+/gLgCRkyU0AfAA==", "checkText"],
  [558, "gate-r17-er--t1.ts:many_cands_nl#13", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU7DMBRA0X95swVCQgxmZWJjYEoymMRDJSepWlOQqv476lewnOFu5w4xxlJ6yb3+9sdjK4ft9auc68tz+vh8fxu3Me4hCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgyD+TSLHs88O6RLpGr6f1HHm4xqW07xo5yrzWeT8dI0U7bDXy021KUVrbf+oSeZhSbHuv92m6TX/Du32mLyMCAA==", "checkText"],
  [559, "gate-r17-er--t1.ts:many_cands_nl#14", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU7DMBRA0X95swVCQgxmZWJjYEoymMRDJSepWlOQqv476k8wneFu5w4xxlJ6yb3+9sdjK4ft9auc68tz+vh8fxu3Me4hCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgyD+RSLHs88O6RLpGr6f1HHm4xqW07xo5yrzWeT8dI0U7bDXy021KUVrbf+oSeZhSbHuv92m6TX+y8yfCz4sIAA==", "checkText"],
  [560, "gate-r17-er--t1.ts:many_cands_nl#15", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU7DMBRA0X95swVCQgxmZWJjYEoymMRDJSepWlOQqv47qsRnnOFu5w4xxlJ6yb3+9sdjK4ft9auc68tz+vh8fxu3Me4hCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgyD+JFMs+P6xLpGv0elrPkYdrXEr7rpGjzGud99MxUrTDViM/3aYUpbX9py6RhynFtvd6n6bb9Ac63t8/Ty4iAA==", "checkText"],
  [561, "gate-r17-er--t1.ts:many_cands_nl_q#16", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LIU/DQBgA0L9CPssFQkImikXhEKi24mhPLLm2y3YDkmX/fcHjMU88+foYYs4td638tMdDzfv15TOfyu45vX+8vf5liLv7YdU0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0Tfv3FinmbXpY5kiXaOW4nKLrL/GV67lEF3layrQdD5Gi7tcS3dN1TJFr3b7LHF0/pli3Vn7TeB1vNNOtn69bAwA=", "checkText"],
  [562, "gate-r17-er--t1.ts:many_cands_nl_q#17", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsUrDQBgA4FeRf/VQBOkQVyc3B6ckw5ncULgkpb2qUPruxd0XEL7hG78+hphzy10rP+3xUPN+ffnMp7J7Tu8fb69/GeLuflg1TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM07V+0SDFv08MyR7pEK8flFF1/ia9czyW6yNNSpu14iBR1v5bonq5jilzr9l3m6Poxxbq18pvG63gD5sSuvM9tDQA=", "checkText"],
  [563, "gate-r17-er--t1.ts:many_cands_nl_q#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LIU/DQBgA0L9CPssFQkImikXhEKi24mhPLLm2y3YDkmX/fcGj0E88+foYYs4td638tMdDzfv15TOfyu45vX+8vf5liLv7YdU0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM07R8tUszb9LDMkS7RynE5Rddf4ivXc4ku8rSUaTseIkXdryW6p+uYIte6fZc5un5MsW6t/KbxOt4Ai35AAU+2NQA=", "checkText"],
  [564, "gate-r17-er--t1.ts:cands_unmatched_q#19", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU7DMBRA0X95s0WFhBjclYmNgSnNYBIPlZykak1BqvrviJUfYDnD3c4dYi695F6/++7UynHdf5RLfX5Kb++vL387rDAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMw/C/40NEinmbHpY50i16PS+XyMMtrqV91shRpqVO2/kUKdpxrZEf72OK0tr2VefIw5hi3Xr9ncb7+ANqegp7cb8CAA==", "checkText"],
  [565, "gate-r17-er--t1.ts:cands_unmatched_q#20", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU7DMBRA0X95s0WFhBjclYmNgSnNYBIPlZykak1BqvrviJUvYDjD3c4dYi695F6/++7UynHdf5RLfX5Kb++vL387rDAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzD8T/AhIsW8TQ/LHOkWvZ6XS+ThFtfSPmvkKNNSp+18ihTtuNbIj/cxRWlt+6pz5GFMsW69/k7jffwBHU6JLdH8CgA=", "checkText"],
  [566, "gate-r17-er--t1.ts:cands_unmatched_q#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU7DMBRA0X95s0WFhBjclYmNgSnNYBIPlZykak1BqvrviJUvYDjD3c4dYi695F6/++7UynHdf5RLfX5Kb++vL387rDAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzAMwzD8z/EhIsW8TQ/LHOkWvZ6XS+ThFtfSPmvkKNNSp+18ihTtuNbIj/cxRWlt+6pz5GFMsW69/k7jffwBPKGY7FHyKwA=", "checkText"],
  [567, "gate-r17-er--t1.ts:blank_lines#22", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LsQrCMBhF4Xe5c1AEcYirk5uDU5shtv9QSJNSoxZK313cfIjDxxlPo1Z9rNFXW+p+SnHI50d82unobvfr5b82AwAAAAAAAAAAAACANi9y6ku3G3u5VdXm8SnfrHrH9DJ5xW60rsyTnNKQTf6wBaeYUvlYL98Ep1yq/aawhS+XpjwRux8AAA==", "checkText"],
  [568, "gate-r17-er--t1.ts:blank_lines#23", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LsUoDQRRA0X959WAQxGLSWtlZWG22GHenCMzuhmTUQMi/i4XgRxwOt7xDHGIuveRer313auW47j/KpT4/pbf315f/HVYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAP9dIMW/TwzJHukWv5+USebjFV2mfNXKUaanTdj5FinZca+TH+5iitLZ91znyMKZYt15/p/E+/gADXFVze30AAA==", "checkText"],
  [569, "gate-r17-er--t1.ts:blank_lines#24", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LsUoDQRRA0X959WAQxGLSWtlZWG22GHenCMzuhmTUQMi/i52dP3A43PIOcYi59JJ7vfbdqZXjuv8ol/r8lN7eX1/+dlgBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/nONFPM2PSxzpFv0el4ukYdbfJX2WSNHmZY6bedTpGjHtUZ+vI8pSmvbd50jD2OKdev1dxrv4w+Yjmy8e/QBAA==", "checkText"],
  [570, "gate-r17-er--t1.ts:blank_spaces#25", "refusal", "refusal", "quiet", "H4sIAAAAAAAAA+3LMQrCMABG4avIPwdFEIe4Ork5OLUZYpOhkCalRi2U3l3cPILDg++Nr1Gr4Ku3Nc51Nybf59PdP+LxYK63y/m3Nm8AAAAAAAAAAAAAAAAAAAAAAPgDcysZhdJthyCzqMZpeMg2i14+PaOsfDfErkyjjFKfo+x+dUY+pfKOQbZxRrnU+J3c6j5tcrrbXS8AAA==", "checkText"],
  [571, "gate-r17-er--t1.ts:blank_spaces#26", "refusal", "refusal", "quiet", "H4sIAAAAAAAAA+3LsUrDUBiA0VeRf74ogjikayc3B6ckwzW5Q+EmKe2tFkrfXdz6EAfON359DDHnlrtWru3lWPNh3X3nc3l/S59fH/vHhvUJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB5ch4gU8zY9L3OkW7RyWs7R9bf4yfVSoos8LWXaTsdIUQ9rie71PqbItW6/ZY6uH1OsWyv/03gf/wD4ZtR0/bsAAA==", "checkText"],
  [572, "gate-r17-er--t1.ts:blank_spaces#27", "refusal", "refusal", "quiet", "H4sIAAAAAAAAA+3LvUoDQRhA0VeRrx4UQSwmrZWdhdXuFuPuFIH9CclEAyHvLna26Q+cW94u+phKK7nVS3s6zGW/7r7Kqb6+pI/P97f/9esDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAnS59RIppGx+XKdI1Wj0up8jdNb7LfK6Ro4xLHbfjIVLM+7VGfr4NKco8bz91itwNKdat1b9puA2/oW9r633uAgA=", "checkText"],
  [573, "gate-r17-er--t1.ts:spaces_run#28", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3XuwrCQBSE4VcJUy+KIBZra2VnYZXd4rh7isBeQrJeIOTdJZ1vYDMf/OU8wPRwiNLENv20/ZhkKOeHzHo6mtv9evmtIyIiIiIiIqK/c6XbbroDDGINuxxhFjSd8gzbL3hJeiosJGQNdRphkIaisIfVG0hK9a0RtvcGpTbdRn71X7VOj18hEAAA", "checkText"],
  [574, "gate-r17-er--t1.ts:spaces_run#29", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3bvQrCMABF4VcJdw6KIA5xdXJzcGo7xCZDIU1KjT9Q+u7SzYc4H5zxPsJt1Cr46l2N37qfkh/y+eGf8XS0t/v18p8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAY02az3dBbySqUfjcG2UU1zuNTrln09ukV5eT7MfZlnmSVhhzlDmtn5VMqnxjkms4qlxq3Ubd2P5UsiAsBPwAA", "checkText"],
  [575, "gate-r17-er--t1.ts:spaces_run#30", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LvWoCQRhA0VeRrx4SAiHFpLWys7Da3WKyO4WwP6JrEhDfXexCnuEcuOVtoo2hrCWv9Xd9PY3lOH9+lUv9eE/7w277tw0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwD/tvNkfdts2IsWw9C/TEOkWaz1Pl8jNLb7LeK2Ro/RT7ZfzKVKMx7lGfrt3Kco4Lj91iNx0KeZlrc+pu3cPsEO3M4H6AAA=", "checkText"],
  [576, "gate-r17-er--t1.ts:spaces_ops#31", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3ZPQrCQBRF4a3Iax0UQSzG1srOwipO8cy8IjCZCcn4AyF7l3Qu4vBxyruC20jUqr7at+6HpF0+P3Wy09Hd7tfLf5stAAAAAAAAAAAAAAB45PVFFyextLs+ipul2thP4ptZ3ppeJl607a0t4yBOUpdN/GEJTjSl8rEovglOcqm2jsISfss23Ae8HwAA", "checkText"],
  [577, "gate-r17-er--t1.ts:spaces_ops#32", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3dsUoDQRiF0VeRv3VQBLEYWys7C6t1i3F3isDsbkgmKoS8uwQbH+Jw+Mr7DHeIufSSe/3p9/tWduvzZznWp8f09v768r+bWwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA/H+v1BT1SzNt0t8yRztHrYTlGHs7xVdqpRo4yLXXaDvtI0XZrjfxwGVOU1rbvOkcexhTr1ut1NF7GX+S1jK98fQAA", "checkText"],
  [578, "gate-r17-er--t1.ts:spaces_ops#33", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsUoDQRRA0V+R1zooQrBY21TpUqRatxh3pwjM7oZk1EDIv4udlV9wONzy9jHllrtWru35VPNxefvIl/K6SfvDbvu3h0cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACA/70v+8NuGymmdXyap0i3aOU8X6Lrb/GV62eJLvI4l3E9nyJFPS4lupf7kCLXun6XKbp+SLGsrfxOw334AXLXZF189AEA", "checkText"],
  [579, "gate-r17-er--t1.ts:amp#34", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3ZPQrCQBRF4a3IK6wGRRCLsbWys7CKUzwzrwhMZkIy/kDI3iWdizh8nPKu4DYStaqv9q37IWmXz0+d7HR0t/v18t9mCwAAAAAAAAAAAAAAHnl90cVJLO2uj+JmqTb2k/hmlreml4kXbXtryziIk9RlE39YghNNqXwsim+Ck1yqraOwhB92WijavB8AAA==", "checkText"],
  [580, "gate-r17-er--t1.ts:amp#35", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3dsUoDQRiF0VeRv7AaFEEsxtbKzsJq3WLcnSIwuxuSiQoh7y7Bxoc4HL7yPsMdYi695F5/+v2+ld36/FmO9ekxvb2/vvzv5hYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgz8d6fUGPFPM23S1zpHP0eliOkYdzfJV2qpGjTEudtsM+UrTdWiM/XMYUpbXtu86RhzHFuvV6HY2X8RdWNbZtfH0AAA==", "checkText"],
  [581, "gate-r17-er--t1.ts:amp#36", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsUoDQRRA0V+RV1gNihAs1jZVuhSp1i3G3SkCs7shGTUQ8u9iZ+UXHA63vH1MueWulWt7PtV8XN4+8qW8btL+sNv+7eERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4H/vy/6w20aKaR2f5inSLVo5z5fo+lt85fpZoos8zmVcz6dIUY9Lie7lPqTIta7fZYquH1Isayu/03AffgDyaPL0fPQBAA==", "checkText"],
  [582, "gate-r17-er--t1.ts:dotdot#37", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3ZvQrCMBiF4Xs5c6gI4hBXJzcHp5ohNt9QSNPSxh8ovXdx8yLeB97xXMFplWKNvtqn7qYc+3J6xMWOB3e9Xc7/NQAAAAAAAAAAAAAAoLmX34supzR2zZDkVlWbh0W+XfWK+Wnyit1g3ThPcsp9Mfn9FpxizuPbknwbnMpY7TcKW/gCA8MxH7wfAAA=", "checkText"],
  [583, "gate-r17-er--t1.ts:dotdot#38", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3dO2rDQBiF0b389eAQCCnGbap0KVIpKibSFIaRZOzJA4z3Hgwusohz4CvvGu4Qc+kl9/rbH46tHNb9ZznX56f09v768r8dAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwN3HentBjxTzNu2WOdIlej0t58jDJb5L+6qRo0xLnbbTMVK0w1ojP17HFKW17afOkYcxxbr1ehuN1/EPsuCocXx9AAA=", "checkText"],
  [584, "gate-r17-er--t1.ts:dotdot#39", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsWoCQRRA0X959WAIhBST1srOwmqzxWR3CmF2V3RjAuK/Bzu7/MA5cMvbxVjWktf6u76cWjnOH1/lUt/f0v6w2z63AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPjH57w/7LaRYlyGzTRGusVaz9MlcneLa2nfNXKUYarDcj5Finaca+TXe5+itLb81DFy16eYl7U+pv7e/wGky0pUfPQBAA==", "checkText"],
  [585, "gate-r17-er--t1.ts:closers#40", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3ZvQrCMABF4Xe5mxAUQRzS1cnNwanNEJsMhTQpNf5A6btLNx/i8HHG+wS3Vafgq7c1futhSn7IzcM/4/lkbvfr5b9OuwYAAAAAAAAAAAAAAHR5+9FlFEq/H4PMohrn8SnbLnr79Iqy8v0Y+zJPMkpDjrLH1Rn5lMonBtnWGeVS4zZyq/sBB+85qcAfAAA=", "checkText"],
  [586, "gate-r17-er--t1.ts:closers#41", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3dO2rDQBiF0b38XWBICAQX4zZVuhSpJBUTaQqDHsaePMB478akySIOh6+8a7hd9DGVVnKrv+3pOJfDuv8s57p7Se8fb6//6+NhDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPCnX+8/6JFi2sbHZYp0iVZPyzlyd4nvMn/VyFHGpY7b6Rgp5sNaIz9fhxRlnrefOkXuhhTr1up9NFyHG8KOwGyAfQAA", "checkText"],
  [587, "gate-r17-er--t1.ts:closers#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LvWoCQRhA0Xf5usCQEAgpxtbKzsJqd4vJ7hTC/oiuSUB8d7FLlSc4HG55m2hjKGvJa/1d305jOc6br3Kpnx9pf9ht/9bGywYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgf+28P+y2kWJY+tdpiHSLtZ6nS+TmFt9lvNbIUfqp9sv5FCnG41wjv9+7FGUcl586RG66FPOy1ufU3bsHrd1LZID0AQA=", "checkText"],
  [588, "gate-r17-er--t1.ts:pct#43", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3OS2rDMBRA0b08yEy0GEwH6lJcD1Rbg4Bsh0T9QMjeS1eRyYEzvXCnWEsvudff/npp5by/f5ZbfRvTaRwAAAAAAAAAAAAAAODpPvanLwAAAAAAAAAAAAAAwGkcIsV6LC/bGukevV63W+TpHt+lfdXIUZatLsf1Einaea+Rh8ecorR2/NQ18jSn2I9e/6P5Mf8B5vaOwiheAAA=", "checkText"],
  [589, "gate-r17-er--t1.ts:pct#44", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3OMWrDMBiA0bv80E20BEIH9SiuB8XWEJDtkKhJIOTupUuv0A4P3vrBN8Rcesm93vvbqZXj+nEol/q+Ty/7HQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8+lz/fAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAfyVSzNv0usyRHtHreblEHh5xLe2rRo4yLXXazqdI0Y5rjbx7jilKa9utzpGHMcW69foTjc/xG3PCRNtodwEA", "checkText"],
  [590, "gate-r17-er--t1.ts:pct#45", "refusal", "refusal", "refusal", "H4sIAAAAAAAAA+3OMWrDMBiA0bv80E20BEIH9SiuB8XWEJDtkKhJIOTupUfoVAoP3vrBN8Rcesm93vvbqZXj+nEol/q+Ty/7HQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwK98rn++AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/DuRYt6m12WO9Ihez8sl8vCIa2lfNXKUaanTdj5FinZca+Tdc0xRWttudY48jCnWrdefaHyO3/BG/Iho3AUA", "checkText"],
  [591, "gate-r17-er--t1.ts:dash_tail#46", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LvQrCMBhG4Xt556gI4hAnwcnNwakEic03FNKm1PgDpfcubl7E4eGMp1GKNfpqn7oZc+yGwz0+bL9zl+v59N/qeAMAAAAAAAAAAAAAAHJKpV33SW5Wtal/yDezXjE/TV6x7a0t0yin3A0mv12CU8y5vC3JN8FpKNV+U1jCF1VDlyi3HwAA", "checkText"],
  [592, "gate-r17-er--t1.ts:dash_tail#47", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LsUoDQRRA0X959agIYjFWgpWdhdWyhHF3isDsbkhGDYT8u4iNH3E43PIOMZdecq/nfndoZb8+fZRTfXxIb++vL/+7ed4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/IkU8zbdLnOkS/R6XE6Rh0t8lfZZI0eZljptx0OkaPu1Rr6/jilKa9t3nSMPY4p16/V3Gq/jD9g07I53fQAA", "checkText"],
  [593, "gate-r17-er--t1.ts:dash_tail#48", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LsUoDQRRA0X959agIYjFWgpWdhdWyhHF3isDsbkhGDYT8u9hZ+QWHwy3vEHPpJfd67neHVvbr00c51ceH9Pb++vK3m+cdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwP8ixbxNt8sc6RK9HpdT5OESX6V91shRpqVO2/EQKdp+rZHvr2OK0tr2XefIw5hi3Xr9ncbr+AONEnZOd/QBAA==", "checkText"],
  [594, "gate-r17-er--t1.ts:dash_cands#49", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3MPUvEQBiF0b8ibz0qgliMlWBlZ2EVgozJFAuTZNkdP2DZ/y52lnY2h8tT3jPEXHrJvX71630ru/X+rRzr3W16fnl6/N3lw+vfdgEEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIPDfwUgxb9PVMkc6Ra+H5Rh5OMVHae81cpRpqdN22EeKtltr5JvzmKK0tn3WOfIwpli3Xn9O43n8BjrNsvHv8QQA", "checkText"],
  [595, "gate-r17-er--t1.ts:dash_cands#50", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3MPUvEQBiF0b8ibz0qgliMlWBlZ2EVgozJFAuTZNkdP2DZ/y52lvYeLk95zxBz6SX3+tWv963s1vu3cqx3t+n55enxd5cPr3/bBRAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKB/xCMFPM2XS1zpFP0eliOkYdTfJT2XiNHmZY6bYd9pGi7tUa+OY8pSmvbZ50jD2OKdev15zSex2+bGZeWz8YTAA==", "checkText"],
  [596, "gate-r17-er--t1.ts:dash_cands#51", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+zMsQpAUABA0V+RmSwyMCmTzWAy6IlBScobfL7V6ANOt7ueKV1DDHXcnlhcR9jPZgn3VpXZMPbd97yd/5UAgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUDg284cnDAIQwEA3eWfQ6HXrCI5iOZQiEasbQ/i7qVjFN4A7wmFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFAqFQqFQKBQKhUKhUCgUCoVCoVAoFP5pGCnmPt2WOdIZR92XZ+ThjPfYXjVyjNNSp75vkaI91hr5fpUUY2v9U+fIQ0mx9qP+ULnKF8IS7qhPGk8A", "checkText"],
  [597, "gate-r17-er--t1.ts:nonascii_tail#52", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LvwnCQBiH4V1+9aEIYnG2VnYWViHFmfuKwCUXkvMPhIBDuIRzuImTiHu8PPVTKYYSfLFHWQ8ptP3+Eibbbd3pfDx8n6/PGwAAAAAAAAAAAAAAyCnmZtVFuVnFxm6Sr2bdQrqavELTWZPHQU6p7U1+s9ROIaV8tyhf1U59LvZP9VL/AD1JCnCtHwAA", "checkText"],
  [598, "gate-r17-er--t1.ts:nonascii_tail#53", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsUkEQRQA0F5+PCiCGIypkZmB0bLBuDvBwezucTd6wnFgETZhHXZiJSK28XjxG2IuveRe3/v1vpXdev9SjvXuNj09Pz78fHx+fwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8ixTzNl0tc6Rz9HpYjpGHc7yV9lojR5mWOm2HfaRou7VGvrmMKUpr26nOkYcxxbr1+pfGy/gLKI1xUm19AAA=", "checkText"],
  [599, "gate-r17-er--t1.ts:nonascii_tail#54", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsUkEQRQA0F5+PCiCGIypkZmB0bLBuDvBwezucTd6wnFgETZhHXZiJWIDVvB48RtiLr3kXt/79b6V3Xr/Uo717jY9PT8+/Hx8fn8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/C9SzNt0tcyRztHrYTlGHs7xVtprjRxlWuq0HfaRou3WGvnmMqYorW2nOkcexhTr1utfGi/jL1VYTTFt9AEA", "checkText"],
  [600, "gate-r17-er--t1.ts:nonascii_cands#55", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MMUoDQRiA0avIXw+KIBZja2VnYbVsMdmdIjC7G5I1CiHgIXIJz+FNPIl4Azubx1d/r4uxrCWv9X292bWynR825VDv79Lzy9Pj98fl6/NvXWEwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYzL8zkWJchutpjHSKte6nQ+TuFMfSXmvkKMNUh2W/ixRtO9fIt+c+RWlteatj5K5PMS9r/Z36c/8DQNAz5a9VBAA=", "checkText"],
  [601, "gate-r17-er--t1.ts:nonascii_cands#56", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3MMUoDQRiA0avIXw+KIBZja2VnYbVsMdmdIjC7G5I1CiHgIXIJz+FNPIl4A2t5fPX3uhjLWvJa39ebXSvb+WFTDvX+Lj2/PD1+f1y+Pv/WFQaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwG8y+ZSDEuw/U0RjrFWvfTIXJ3imNprzVylGGqw7LfRYq2nWvk23OforS2vNUxctenmJe1/k79uf8BgQRoyc9VEQA=", "checkText"],
  [602, "gate-r17-er--t1.ts:nonascii_cands#57", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+zMsQ1FUAAAwFVELdGIglalU/xK9YRCIiLxCuUfwhLmsIlJrGCAy/XXp2OIoYrTEfNtCfNaD2GfyiLrfm3z/M/7+ibRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDRvO3NwgyAMBQB0l39uTLx2FdIDgR5MCiWIeiDsbpzABd4A72k0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaDQajUaj0Wg0Go1Go9FoNBqNRqPRaP42kWLu022ZI51x1H15Rh7OeI/tVSPHOC116vsWKdpjrZHvV0kxttY/dY48lBRrP+oPlat8AZlhrgtPVkUA", "checkText"],
  [603, "gate-r17-er--t1.ts:nonascii_cands_nospace#58", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LsU3DQBQA0F1+fQIhIYqjpaKjoDIuDvuKSGc7So6AFEViCJZgDjZhEsQer39viLn0knv96Nf7Vnbr/Ws51rvb9PT8+PD7+fXz/bISBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBEEQBBEp5m26WuZI5+j1sBwjD+c4lfZWI0eZljpth32kaLu1Rr65jClKa9t7nSMPY4p16/U/jZfxDwjPOCiPEwIA", "checkText"],
  [604, "gate-r17-er--t1.ts:nonascii_cands_nospace#59", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LvUkEQRgA0F6+eFAEMRhTIzMDo3WDcXeCg9nd4278gePAImzCOuzESsQmjF7+3hBz6SX3+t4v963s1tvncqw31+nh8f7u5+Pz++tpJQiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiC+B8RKeZtuljmSKfo9bAcIw+neC3tpUaOMi112g77SNF2a418dR5TlNa2tzpHHsYU69brXxrP4y+Q4NpTT00IAA==", "checkText"],
  [605, "gate-r17-er--t1.ts:nonascii_cands_nospace#60", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LvUkEQRgA0F6+eFAEMRhTIzMDo3WDcXeCg9nd4278gePAImzCOuzESsQ6fPl7Q8yll9zre7/ct7Jbb5/Lsd5cp4fH+7ufj8/vr6eVIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiC+M8iUszbdLHMkU7R62E5Rh5O8VraS40cZVrqtB32kaLt1hr56jymKK1tb3WOPIwp1q3XvzSex1+ttR9+TzQhAA==", "checkText"],
  [606, "gate-r17-er--t1.ts:tail_dash_cands2#61", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LMU7DMBiA0bv8s6FCQgzmHixpBpN4iOQkVWvaSlXvjtg5wvvm9w0xl15yr/d+OLWybJ/f5VI/3tPy9VL+6cjzPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPM/zPB+RYt6n13WO9Ihez+sl8vCIa2k/NXKUaa3Tfj5FirZsNfLbc0xRWttvdY48jCm2vde/aXyOv2ydZWpP7gIA", "checkText"],
  [607, "gate-r17-er--t1.ts:tail_dash_cands2#62", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LMU7DMBiA0bv8swEhIQZzD5Y0g5t4iOQkVWugUtW7o+4cgOF98/uGmEsvuddrfzm1smwfx3Kp729p+Xwqf3TgeZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7neZ7/dz5SzPv0vM6RbtHreb1EHm7xXdpXjRxlWuu0n0+Roi1bjfx6H1OU1vafOkcexhTb3utjGu/jL0X4FQ9PuAsA", "checkText"],
  [608, "gate-r17-er--t1.ts:tail_dash_cands2#63", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LMU7DMBiA0bv8swEhIQZzD5Y0g5t4iOQkVWugUtW7o+6cAL1vft8Qc+kl93rtL6dWlu3jWC71/S0tn0/ljw48z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8z/M8/698pJj36XmdI92i1/N6iTzc4ru0rxo5yrTWaT+fIkVbthr59T6mKK3tP3WOPIwptr3XxzTex1/aWlZET+AuAA==", "checkText"],
  [609, "gate-r17-er--t1.ts:data_spaces#64", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LMQrDMBAEwK+ErQ+D2/uKUHFIVwQky8iyHRD+e8gr0uz0E5BtmL6IiIiIiIiI6O8+EOSWlpohE8N7PaBh4rJyOhSWqqfWdwjKe3Po+kSBldJuz9AQBVsb/kvxiV+H5Abt9Q8AAA==", "checkText"],
  [610, "gate-r17-er--t1.ts:data_spaces#65", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LSwqDMBQAwKvIW4dCt7mKZBE0i4KaYu0HpHcvvcfMfsaY61HzAAAAAAAAAAAAAAAAAAAAAMMwfCLF3KfLOkc642j7+og8nvGqy7NFjjqtber7PVIst61Fvn5Liros/d3myGNJsfWj/VP5lh/gb0E/1T4AAA==", "checkText"],
  [611, "gate-r17-er--t1.ts:data_spaces#66", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPQrCMBgA0KvINwfBNVcpHUKTQUhbqfUHincXV8/w3v6GqGUv+QQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8OcdKeo6neca6Yi9bfM98nDEs/RHixxlmtu0brdI0a9Li3z5jClK7+ur1cjDmGJZ9/ZL42f8AmQDJSlV+gAA", "checkText"],
  [612, "gate-r17-er--t1.ts:data_tabs_mime#67", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOw4CIRRG4a2YvyYaW7aCFFe4hQkMZsRHMpm9G1dhc85Xn6Rq0+JlAgAAAAAAAAAAAAAAO10PRERERERERPT3Pgqqoxx7Vdg0fe0PxbTpZe3pirLSvYz1rqB2W1zxvOcga228vSqmHLSM6b8p7/kL6GTXxjgvAAA=", "checkText"],
  [613, "gate-r17-er--t1.ts:data_tabs_mime#68", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBRA0a2EVw+K7WwlphiTKYR8JMYPBPcu4jbOPfVtYyhbyecNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4K8cL40kSZIkSZIkSZIkSZIkSZIkSZIkSZIkSU3TvCPFsPSHaYi0x1bX6R653eNZxkeNHKWfar+st0gxXuca+fTpUpRxXF51iNx2KeZlq7+p+3Rf6PW2M9i7AAA=", "checkText"],
  [614, "gate-r17-er--t1.ts:data_tabs_mime#69", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBRA0a3IqwfFdrYSU4zJFEI+EuMHgnsXWwtXcO6pbxN9WUs+rQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/lcN5J0mSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmSJEmS9NMrUvRztx/7SFusdRlvkZstHmW418hRurF283KNFMNlqpGP7zZFGYb5WfvITZtimtf6ndp3+wHaaWVFWO4CAA==", "checkText"],
  [615, "gate-r17-er--t1.ts:srcset_many#70", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LvUrDUBgA0FcJ33xRCuIQfyYntw5OaYZrcpFAfkoStVD67uJ7nPlwmngepq9qW7ut7C+n6POe671c9vvzmIf56TNv5fEhHT/e36rDJVWcc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnp3iNFP3S3U19pGvsZZ22qJtr/OTxu0QduZtKt6znSDEOc4n6cGtT5HFcfksfddOmmJe9/Kf21v4B5dTvAWD0AQA=", "checkText"],
  [616, "gate-r17-er--t1.ts:srcset_many#71", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3Lu0rEQBQA0F8Jtx6UBbGIj8rKzsIqm2JMBgnksSRRF5b9d/Ej7E59OE08DtNnta3dVvanY/R5z/VezvvtaczD/PCRt3J/l97eX1+qwzlVnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc8455//tx3iOFP3S3Ux9pEvsZZ22qJtLfOfxq0QduZtKt6ynSDEOc4n6cG1T5HFcfkofddOmmJe9/KX22v4CSuPIiWDQBwA=", "checkText"],
  [617, "gate-r17-er--t1.ts:srcset_many#72", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3Lu0rEQBQA0F8Jtx6UBbGIj8rKzsIqm2JMBgnksSRRF5b9d/E35NSH08TjMH1W29ptZX86Rp/3XO/lvN+exjzMDx95K/d36e399aU6nFPFOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnnHPOOeecc84555xzzv+3H+M5UvRLdzP1kS6xl3Xaom4u8Z3HrxJ15G4q3bKeIsU4zCXqw7VNkcdx+Sl91E2bYl728pfaa/sLjlu78WBAHwA=", "checkText"],
  [618, "gate-r17-sec--q1-pairing.ts:rust_static_then_char#1; gate-r17-sec--q1-pairing.ts:rust_static_then_char#2; gate-r17-sec--q1-pairing.ts:rust_static_then_char#3", "quiet", "private", "private", "H4sIAAAAAAAAA1WQ0U7CQBBFf2WcB9GkikREKMFkwdoCUmhrVaQ8LNulVspuaSulEv7dFGOiLzM3M3dOJneGSwEpj8/O4eIO2DtNYA+VdgUOnmBSpBmYZKSpcFpJM5qFDNIsgQ54GMlAetj2RPy5gB9nf6SrcPpjYFIwmp2ceQIAwEOfZlQN1zTg1VgE7QVNeaOuhM/dsZ1fDfVAEkKI6bjvmhuUUitLt0emZV8+MGdQCvJqOvZVnyRpnXmo/MIbVrmzheXWuoT0dh/5tjm13HIoeWRPfc3cLl5q0UJYhBghK4rqxClqjqN9jf9gntzr8WMRW05vZw9Ht/3HYqUTfWP1zN3GaE2GJe/ejTTr2a4LfVL/at7nRk4eCDGqfzDh26plHD/qDmz3RktWgyAIOp2j5bztiaWAzf+8d8e8UUFfssu1j8oeM56sU1Rne9zS6JOjipStOZNJjApGoeCo1g5zBWkUyZz7qM7mCgqZ8fJofph/AwqbNqnZAQAA", "checkText"],
  [619, "gate-r17-sec--q1-pairing.ts:rust_static_only_before#4; gate-r17-sec--q1-pairing.ts:rust_static_only_before#5; gate-r17-sec--q1-pairing.ts:rust_static_only_before#6", "quiet", "private", "private", "H4sIAAAAAAAAA02Q3W6CQBCFX2U7F9UmpGpqbcXaZFUE/1Cg2FrxYl1WSsVdBSqi8d2btWnizczJzJkvkzMHKniSIhOPNBXdFpKUpCFFSRqjJvIgEoHwoOHx7c8S/Tl7I11Ft38GKjgl6U3R4wgh5IFPUqKGGxKw0pYHjSVJWK2qhNPW2M7KAz0QGGNsOu6X5gZSarK02ngm+6pLnb4U+MN07HIPx0mVeqD8w2uW3NnccistjNuH72z/PLNcORQssme+Zu6X75VoyS2MjZDmeWni5BXH0Y7jK8yb+zAe5lvLaR/sweipN8zXOtZ3Vts87Iz6ZCB5HTfSrKld5fqkenzuZEaGuxgbpStM+LmuG5ePWn3bfdTidT8IgmbzYrlreHzF0eqlQF6LB5krkZHeodPZ46CAL+j9xgflBCmLNwmo8xPsSfTDQAVCN4yKeAsKRCFnoFbOCwVIFImM+aDOFwpwkTJ5tDgvfgH3TT7RwAEAAA==", "checkText"],
  [620, "gate-r17-sec--q1-pairing.ts:rust_lifetime_struct#7; gate-r17-sec--q1-pairing.ts:rust_lifetime_struct#8; gate-r17-sec--q1-pairing.ts:rust_lifetime_struct#9", "quiet", "private", "private", "H4sIAAAAAAAAA02Q3W6CQBCFX2U7F9ompGpqrWI1WRXBf4Fia8U067KlVFgQUETjuzdr2qQ3MydnZr6czAqSNN7TFC08lj0XSRudEScBk1GhSFCSxuhi82i/QTTkSYoGE1VGBWG3hENJenNrc4QQssEhKZG9gLisFHG3uSEJq1Ulb9GZGVl5pLohxhhPTetLsVwhFVE6XbwU/bNPzaEQ+G1qGuUBjpMqtUH6g9d0MTO4blU6GHeP39mhvtQtYYbMN5aOMj1sXiv+husYax7N89LczCumqZxm/zAv1sNsnEe62T0ao8nTYJxvVazu9O70uNMa85Hg9Sxf0RdGlavz6qney7QM9zHWSv8w3vu2oV0TdYaG9ajE26Hruq3WdeWuaXMviPzfl3600flic5DACel94IB0hpTFQQLy6gwH4u8ZyEBowGgYRyCB73EGcuWyloD4fpgxB+TVWgIepkwcrS/rH1TCale2AQAA", "checkText"],
  [621, "gate-r17-sec--q1-pairing.ts:inch_mark_prose#10; gate-r17-sec--q1-pairing.ts:inch_mark_prose#11; gate-r17-sec--q1-pairing.ts:inch_mark_prose#12", "quiet", "private", "private", "H4sIAAAAAAAAAx1PzW6CQBh8FfKdiUqkVmk8LIjgT1VAbK3LYYUtUpddBCqi8d2b7WVmMsnMZA6wPVFF62NQGClqUShVXFLKq5OoDcwxT0hNjCwnKe0WPH07kooOdDXbmWu/6S2cVCCE0CoIT3aYSmlLMC20l/w9jYO5FOhzFfi9GSorPR540vC5F2omQtYN85/mOtx7obQFZf4+sVfX44fGjtxDyM3itu1uglYLAvu+3ob99bItvMC6+Yv319myPTvIuXjW6nZxR5sF5rJmEjLb2/k6dzb6fThp3AZNEXK72dd55P7vm3M/fLHL8zxN0/FYPp3VSlYpGKqcMIahgzmokIi4kyegPqCmZV6BcXjAlbBfCgaQOKexKAtQgWWcgqE9IxUIY6KhCRiHSAUuaipD0TP6A1tkPO5qAQAA", "checkText"],
  [622, "gate-r17-sec--q1-pairing.ts:apostrophe_90s#13; gate-r17-sec--q1-pairing.ts:apostrophe_90s#14; gate-r17-sec--q1-pairing.ts:apostrophe_90s#15", "quiet", "private", "private", "H4sIAAAAAAAAAx2QQW+CQBCF/8pmL1yISkqt0nhYEEFtUUBsrXBYYAtbYFHYimj87832MvPlJfMm7x2hjpMCUAZ4ToA0HbWgIyBtSAdoUrMWxD3IMUsHIQtZijnWaIUzMjyx7DXGLRmrMt3rG68bra2sRgghxw9yM8gEmmLoBjqI/b1I/JUA9On43miJmlZNxq4QPOYGio6QcQ3ZT3eZHNxAyDUpvUNqOpf4Qylj5iJk06Tvh1u/V3zfvG12wdPmrT+5vnH11u8vy7e+sJB1dg3neran23XIhM08KE1376nM2qq3ybyzO7RAyB7Sr2Jq///XV17wbDbFKsuy2Uwk3eWYSy2gXAa0ZRIHlAOJ01K0xAYhgzJM62RQpVC+Q06aqoXa8Q4vuPwlUIM4qUhSNycow5IyAjXlEckQl2XdkRRqx0iGrOZEHEWP6A+7h/DDhAEAAA==", "checkText"],
  [623, "gate-r17-sec--q1-pairing.ts:js_comment_inch#16; gate-r17-sec--q1-pairing.ts:js_comment_inch#17; gate-r17-sec--q1-pairing.ts:js_comment_inch#18", "quiet", "private", "private", "H4sIAAAAAAAAA0WOTW+CQBCG/8pmriUiLbWK8bAgih9FgWJrhcMKW7oVFgQqovG/N9uLl5kn75t5MjuQZTRhdYUIUh4DQDGripS0nYBHOa9qxLIEjVAAMamJxjKSULngyXBPKtpTJbbRV27TXUyTHGOMbc//Nv1EoCmGbuCt2F+TyJsLwB+253ZnuKzUKAD0EHCEAug5onK54ys6xsb5pzn1t44vwpym7jY27dP+XUn33MHYYlHbymuvVTzPvKzuljf/abVsC8czzu7i9WW2bA9TPD06hn0+WoP1QujGfmo6G1fl07V66Y8bq8ETjC35bmGfh4H1/48+d/1nszzMkyQZjQIYBhwkiPOok8UgXaGmZVaBtrvCiaS/FDQgUUajvCxAgpRxCppyCyUgaZo3NAZtF0rA85qKo/AW/gGCPQiVewEAAA==", "checkText"],
  [624, "gate-r17-sec--q1-pairing.ts:js_comment_inch_after#19; gate-r17-sec--q1-pairing.ts:js_comment_inch_after#20; gate-r17-sec--q1-pairing.ts:js_comment_inch_after#21", "quiet", "private", "private", "H4sIAAAAAAAAA0WQ3W6CQBCFX2UztyUiLbWK8WJBFH+KAsXWChcLbCl1WRCoSI3v3mDTeDNzMifz5eTsQBTRJKlKRJB07wGKkjJnpOl4PMx4WaEkjdEIeRCRiihJSmIq5jweBqSkPVlINurKrruLaZxhjLHpuJ+6G7dSb4eq4W27PyahM28FfjMduzvDRSmHHqA7jyPkQc9qLZtbrqRirJ2+6mN/a7ntMaPM3ka6eQxeJRZwC2MjCZtGXDuN5Dj6z+pGeXEfVssmtxztZC+en2bLZj/F04OlmaeDMVgvWtzYZbq1sWU+Xcs//XFt1HiCsSHeKMn7fmBc86hz233Ui/08juPRyIPhfyWMBJT9lZJxejVAgCgLO2kEwhkqWqQlKLszHAn7pqAACVMaZkUOArCEU1Ckiy8AYSyraQTKzheAZxVtn/yL/wt8kq7BlAEAAA==", "checkText"],
  [625, "gate-r17-sec--q1-pairing.ts:json_escaped_quote#22; gate-r17-sec--q1-pairing.ts:json_escaped_quote#23; gate-r17-sec--q1-pairing.ts:json_escaped_quote#24", "private", "private", "private", "H4sIAAAAAAAAAx2Q3W6CQBCFX8XMNamSolUaLwZE8Kco0LW1LhcrbLdUWBStiMZ3b9abmS9nciYnZwM3CrI8cQomBdbqUkqhlSWlpKBRyArxOKTsxMysYIK391K8btmR9wwtW1mLsO7MXFEiIvoR+XGIUOioYdm4Vvt7nERTBfjpR2FngtXRSHqBEkIZEN1CtC+Uyt/63F8HROklz8N16vjn7Yeeb2WA6GVJ07SXUaNHkXNdvJPnxbzZB5F9CWdvL5N5s3PRPQS2fzl4g+WMUqn+jEjuBKvQkO7SuPZHtVfjGNFrZ1+7gfdIYE1D0nWq3VQIMRxSuIMGaZk8FSloNzjxqjiCubnBmeV/HExgScGTstqDBnkmOZj6PdaA5XlZ8xTMTaw96lSm+B7/A9eAVMZfAQAA", "checkText"],
  [626, "gate-r17-sec--q1-pairing.ts:md_inline_code_quote#25; gate-r17-sec--q1-pairing.ts:md_inline_code_quote#26; gate-r17-sec--q1-pairing.ts:md_inline_code_quote#27", "quiet", "private", "private", "H4sIAAAAAAAAAx2N0W6CQBREf8XcZ6KSUqs0PlwQQW1R2K6tFRJxWZEKi4IV0fjvzfZlZnKSmVkDrXhrE8CmtSvKVirYnlftQAQijs6RnuZRwjtHkbxuo4r3NCVdGnO/7s7spEBEdAndWzSR0ZJimLiSvhszMpUBv1zidydYVhrreRL4wqOqgWheA/FTX/orj0pc8MxfxZZ72X6q2VZ4iE7KmqazII1KiHWbf9Cn+Vtz9Ih59WfvL5O35mCjffJM93pyBotZIOTMiGaWt/Q1YS+0W39UOzWOEZ1O+n0YOP//xtSnz1Z5mCZJMhwGAhSIC9bOY1DucOZlXoG+vsMlyn456BCxnLOiPIICWSo46OojVCDKsqLmMejrUAFRnLkshY/wD02DpXtPAQAA", "checkText"],
  [627, "gate-r17-sec--q1-pairing.ts:python_char#28; gate-r17-sec--q1-pairing.ts:python_char#29; gate-r17-sec--q1-pairing.ts:python_char#30", "quiet", "private", "private", "H4sIAAAAAAAAA0WOS2+CQBCA/8pmLrYJqZJSqzQcFkTwhSxbbK1wQNhSKiyKVkTjf2+2PXiZ+TKPb2YF1HSRhloBtAJOkIYEQMBHMwtp6C7gCCEUQBIdIjUropS1tzx9WUd71lWkbKHPvbozsdISY4wd6n+ZfirQFEE38FLkz2FMxwLwu0O9zghXeyUWR/7dXSJaHie+rGNsnL7rY29JfFEsWe4tE9M5rt/kfM0JxnYWN03bpY1MqXme3yyv/uN82mwJNU7eZPY8mjYbC1s7Yjinnd13J0I38HOTLDyFW65y7g1qu8ZDjO32zZJ9bPr23z/62POfzGozTtNU08TEfcBBgqSMH4oEpAscWFXsQV1d4BjlPwxUiOKCxWW1BQnyjDNQ5WsoQZTnZc0SUFehBLw8MLEUXsNfd+0Tg3wBAAA=", "checkText"],
  [628, "gate-r17-sec--q1-pairing.ts:shell_heredoc_quote#31; gate-r17-sec--q1-pairing.ts:shell_heredoc_quote#32; gate-r17-sec--q1-pairing.ts:shell_heredoc_quote#33", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2N226CQBiEX4X8N70hHlK0lmqTBTl4KAgUW+tysbJbpMKuAhXR+O4NvZmZfMnMbCEmlTQeG64pvUqkk1PMZ9VDKQ0wSHVKGeaUVERNc5Kw7pEnLztSsqEip2vN9evewkoEQgg5Qbg3wqSNRiuajjatf5txMG8D+nQCvzdDRanEQ68FPvfCvoaQfsH8pz6PNl7YYsEyf0MN57z76Gc77iFkp3HTdFdB0w8C4+q+h4/usjl6gX7xF29Ps2VzsJB18nTncrKfVwvM25lpmBne2le4tVKuo2lt18hEyO6mX4dn+/9fm/vhwCgO8yRJJhPMDdfEnMV7IWGggjMMmIMMVMSdnIJ8g4oVeQnq9gZnkv0yUIHEOYtFcQQZspQzUPv3SAaSZaJmFNRtJAMXFWtL0T36A2UfEbpsAQAA", "checkText"],
  [629, "gate-r17-sec--q10-style.ts:html_style_url#1; gate-r17-sec--q10-style.ts:html_style_url#2; gate-r17-sec--q10-style.ts:html_style_url#3", "quiet", "private", "private", "H4sIAAAAAAAAAx1N3VKCQBh9Fee7qhkKmciU1JkFEVJTgbBMuFhgI2JZFBBEx3dv1pvzN3PO2cEwSupOWbWUjDwIcJjGRX5k0UOS4ZgonWNB7yJcYeXmxT2LXwNckp4sJBt1ZTfduRHnCCG0dNxf3Y251DmoGtpy/pmGzowL9LV07O4bKko57Fk8sJnlSipC2sljf03d31ouj3NC7W2kL+vgU6IBsxAyk7BtxbXTSo6jn1cf7tNq0e4tRzvZ8/eXt0WbGsg4WNrydDAH67nH+MzEpbq1sWVmrOVzf9KYDZoiZIrJdzowb//qzHaf9SKdxXE8Gt17MB6KUVKPQYAoDx+zCIQLVKTISlB2F6gxPRJQAIcZCfNiDwLQhBFQpKsvAKY0b0gEys4XgOUV4SX/6v8DWTLVe2IBAAA=", "checkText"],
  [630, "gate-r17-sec--q10-style.ts:html_style_url_sq#4; gate-r17-sec--q10-style.ts:html_style_url_sq#5; gate-r17-sec--q10-style.ts:html_style_url_sq#6", "quiet", "private", "private", "H4sIAAAAAAAAAx2NX2+CMADEv4rpi1vChmTMKVOTggj+GQoMN6c8FNoxRikICKLxuy/dy93ll9zdHoxwXHfKqqVk3A1QmERFdmJY6ZwKeodRhZQ4RRERcxa9BqgkfVmIt+raaXpLI8oghNByvR/di3jUuaga3HH/noXuggf4ablObw6LUg77NgcOsz1JhVA7H9hvUw92tsdxRqizw7pVBx8SDZgNoRmHbStu3FZyXf2yfvee1qs2t13t7CzfXuarNjGgcbQ163w0h5vlgfGZqUd1e+vIzNjIl8G0MRs4g9AU469kaP7/qwvHe9aLZBFF0Xh832HZQ0FygqruZCTiuJ4AAeAsfEwxEK6gIkVaAmV/BTWiJwIUgMKUhFmRAwHQmBGgSDdfAIjSrCEYKHtfACyrCC/5N/8Pn9vo4WQBAAA=", "checkText"],
  [631, "gate-r17-sec--q10-style.ts:svg_style_attr#7; gate-r17-sec--q10-style.ts:svg_style_attr#8; gate-r17-sec--q10-style.ts:svg_style_attr#9", "quiet", "private", "private", "H4sIAAAAAAAAAx2N3W6CQBSEX8WcqzYhRVJqFWuTAyL4hwLF1goXCCulLosCimh892Z7MzP5kpnZwFtBoqpVVg0lAx92KaVK61TQhzisQiXNwoSIB5b0t2FJOrKQrtSFU7enRpIjIlqu96N7CY86F1XDNffdKHInPOCX5TrtMRalHHVsDhxme5KKqF189lufu2vb4zgn1FnHunXefkp0y2xEM42aRly6jeS6+nXx4T0vZs3BdrWLM52/jmfN3kDjaGvW5Wj2llOf8ZmhR3V75cjMWMrX7rA2axwhmmL6ve+Z///qxPFe9GI/SZJkMHjs+yC+gwBxHj1lMQg3qEiRlaBsbnAO6YmAAmGUkSgvDiAATRkBRboHAoSU5jWJQdkEArC8IrwU3IM/z18fY1MBAAA=", "checkText"],
  [632, "gate-r17-sec--q10-style.ts:react_style#10; gate-r17-sec--q10-style.ts:react_style#11; gate-r17-sec--q10-style.ts:react_style#12", "quiet", "private", "private", "H4sIAAAAAAAAAx2N206DQBiEX4X8V5oQKRGrRWuyUAo9SAtItRYuOKyILEsLFEoJ727Wm5nJl8zMAV7itOGquiN42vdcGERZUhZnGi/yIMEy58G5JDdxUAdyyohwpMlzGFR4LPHpTtnY7WilJwVCCJmO+6O5CYsaE0VFe+bf88hZsoA+TcceLVBZSdHYYsCmlisqCKkXj/62zdPechkuMLH3sWY24YdIQmohZKRR1wlbpxMdR7tu3t37zbo7Wo56sVdvj4t1l+lIP1mqeTkZk+3Ko2xm5hLN2tkS1bfS9WnWGi2aI2QI6Vc2Mf7/laXtPmhltkySZDq99YAbBk54BR7iIrrLY+B7qHGZVyAfemgCcsYgQxDlOCrKI/BAUopBFgefh4CQosUxyAefB1rUmJX8wf8DZI3jrGMBAAA=", "checkText"],
  [633, "gate-r17-sec--q2-falseref.ts:md_wrap_last_word#1; gate-r17-sec--q2-falseref.ts:md_wrap_last_word#2; gate-r17-sec--q2-falseref.ts:md_wrap_last_word#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLTwuCMBxAv4r8zsMKosM6zaigoCAxCN3h57amtD/iNAnxu8cu773LK4EltZe/JIyiSTAkEgekrUWtVp3T+xqD2m1J+8zuj2l9PWvPGGO3vGiOhY55jMgO7BX9Pon8UrnJ95+QVg4ISC9SK4HMMKjeBqDlDF80owIKKKwSvu+AgGmdArpZOAE0xk9KAi05AecHFSe+8D8sRDm0qgAAAA==", "checkText"],
  [634, "gate-r17-sec--q2-falseref.ts:md_wrap_last_word2#4; gate-r17-sec--q2-falseref.ts:md_wrap_last_word2#5; gate-r17-sec--q2-falseref.ts:md_wrap_last_word2#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLQQuCMBhA/4p852EF0WGdZlRQUJEYhHr42j7naG6iKwPxv4eX997l5XDDPlCEUdtRZX6RNW+KFAbkpkFNi9bp7Qt72qyZeSTX+7A8H7UXQohLmtX7TM+5n5HsxHN2dZDpqXA1dRQXDhgoL+NGARshUNf0wPMRvmg/BBxQNiR91wIDaxwBX00lA7TWD6SA5yUD5wPNUzmVf3cz4k+uAAAA", "checkText"],
  [635, "gate-r17-sec--q2-falseref.ts:md_wrap_last_word_comma#7; gate-r17-sec--q2-falseref.ts:md_wrap_last_word_comma#8; gate-r17-sec--q2-falseref.ts:md_wrap_last_word_comma#9", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWMywrCMBBFfyXMOlQFcRFXUVRQULFUkNrF2EzbYB4ljVYQ/12yuedszi3hjEMkhqwP1OgPM/pJTGFEoS22NOldu3zgQIs519fV6TJOD7vWSynlMS+6TdEm3aRZreUtsdnW+f7uYkeOM+sDsdEHNbDGG+NH1lGg7O6Ag/J1ZhXwL0QKdgBRfuGN5kUgAGtLtQ89cDDaEYjZr+KA6YEUiLLi4HykFFW/6g8Krd0ExgAAAA==", "checkText"],
  [636, "gate-r17-sec--q2-falseref.ts:ts_args#10; gate-r17-sec--q2-falseref.ts:ts_args#11; gate-r17-sec--q2-falseref.ts:ts_args#12", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyWMTQuCQBiE/0rMSWHpA6LDdlrDgoKCxCDUw7a+maC7sq4ZRP89ti4zzxyeyUCvjpQLOml7CnI9meQopZO8bmVFs05X65vsabVk9SU6ncf5YVcZIYQ4JukjTiuPsY9oI66+71uV7HOw/1XvbK3cb4bh1JmIAmcHCte5BkNp1LQtwd5wZNsePHvjKZuBwCFVS8rYDgxNrQl88SkYZNOYkUrwrGDQxpGXik/xBeoAYNrIAAAA", "checkText"],
  [637, "gate-r17-sec--q2-falseref.ts:ts_array_words#13; gate-r17-sec--q2-falseref.ts:ts_array_words#14; gate-r17-sec--q2-falseref.ts:ts_array_words#15", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAz2MPQvCMBiE/0q4OfgB4pDiEKUKCgqWCtJmiMlrLLRJMVWH4n+XKrjcPTfcU8AEHztmdKTIFqwoPWMlrO60qBrtaNx6l1x0pPmMV6fl4fia7DYuSCnlPstvae4GTIdYruR56OvaZNsS/Kf6Wv6r9e7LKik9OGwwo8aC9+jo3kSIosdT1w+CgDYNmXBvwVFXniCmb8Wh6zq8yEIUisOHjoaTeqsPzT6Zm8kAAAA=", "checkText"],
  [638, "gate-r17-sec--q2-falseref.ts:ts_array_gif#16; gate-r17-sec--q2-falseref.ts:ts_array_gif#17; gate-r17-sec--q2-falseref.ts:ts_array_gif#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyXLuwrCMBQG4FcJ/xy8gDikOEQEcfKyNhmOybEGcpGm1qH47qKO3/C1cCXXQTiqXMVGtCYLYeBpIBUSdTzvwq25UuX1Sl4WcX/cxbs+660+aK1PBvIfQh4pBv+zbUyGhC9uljzkhIH7VKHaCSPFJ0OBXGJX+gckYsgMtXxbCYqxvNhDtVYil4G/yb7tB29ugmKlAAAA", "checkText"],
  [639, "gate-r17-sec--q2-falseref.ts:py_list#19; gate-r17-sec--q2-falseref.ts:py_list#20; gate-r17-sec--q2-falseref.ts:py_list#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAzWMywrCMBREfyXMOvgAcRFxkUoVFVRaFKXN4prGWkwTaatdSP9dKriZOQycSXCIwuX6HMZszpLUMcZYiowaEkVJuRk+XT67Um2mE16cgn3Ujrar3Esp5S4+3sNj3mPYR7CQl75vSx1vUvD/2Y2svZJ+/CaVOnBkXg/KDPyDxlRlDZF88Cb7MhAgXRrtqyc4bOEMxLhTHGStb00GkSgO5xvTS6pTXxUztEfAAAAA", "checkText"],
  [640, "gate-r17-sec--q2-falseref.ts:json_list#22; gate-r17-sec--q2-falseref.ts:json_list#23; gate-r17-sec--q2-falseref.ts:json_list#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyWMywrCMBQFf6WcdfAB4iKuUlFBQcFSQZosYnuNhTxKW61Q+u8S3JyZzZwCowR9tWssdRI8KaRPEolK95rXThuaN95sHrqj9YrVt/RyHRangwlCCHHO8tcuN1F3cdKtuEc+92V2lGD/Kx88SUivJunBUIVy5iqwET21rgMvRny0fRM4dOmoDG0DBlt7Al9OikFbGwaqwAvF4ENPMVKT+gEE36iLvAAAAA==", "checkText"],
  [641, "gate-r17-sec--q2-falseref.ts:yaml_list_q#25; gate-r17-sec--q2-falseref.ts:yaml_list_q#26; gate-r17-sec--q2-falseref.ts:yaml_list_q#27", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAzWMTQuCQBiE/4rMefuC6LCd1rCgoCAxCN3Dpm+bsB+iloH432MPXWaeOTyTg77KNoY6XrgomkUFKtUrXluladE4vX2ojjZrVt/iy3VYng7aCyHEOc1eSaYDJiHinbiHfu7L9Fjg/+W8o7DAUPlybiuwET21tgPPR3yUeRM4VGmp9G0DBlM7Al9NkkEZ4weqwHPJ4HxPQZKT/AEy2ynjtAAAAA==", "checkText"],
  [642, "gate-r17-sec--q2-falseref.ts:shell_cont#28; gate-r17-sec--q2-falseref.ts:shell_cont#29; gate-r17-sec--q2-falseref.ts:shell_cont#30", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLyQrCMBQAfyW8c+oC4iGeolRBQcFSQZoe0uTZFrKUpsuh9N8ll5m5TAFo0WnSjZVpQ0OSRMtBkgjWWlnjtnP1qZIBjwfafs6v97x73GrPOefPLG/SvI6ZRpwv/Bv9u6rsToQQjpAJ+8oHFA4oaK82VgNdYMDeBmDFApM0IwIDqSwq33dAwbQOge3XkoI0xs+ogRUlBecHjFO5ln9nCxeItgAAAA==", "checkText"],
  [643, "gate-r17-sec--q2-falseref.ts:css_two_props#31; gate-r17-sec--q2-falseref.ts:css_two_props#32; gate-r17-sec--q2-falseref.ts:css_two_props#33", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLvQrCMBgAX6V8k0KoCuIQpyhVUFCwVJA2w9ckxmJ+StraofTdJcvdLVdCismU1Ci+OvjBSZoMwSwk9kgbi1qtWqf3NXZqtyXN83B/jOvrWXvGGLvlxScrdMws4nBkr+j3SeSXZeXmygEB6UVqJZAJehVsB7Sc4IdmUEABhVXChxYImMYpoJuZE0Bj/Kgk0JITcL5XceIz/wONTBITrAAAAA==", "checkText"],
  [644, "gate-r17-sec--q2-falseref.ts:md_table_cont#34; gate-r17-sec--q2-falseref.ts:md_table_cont#35; gate-r17-sec--q2-falseref.ts:md_table_cont#36", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLywrCMBAAf6XsOfgA8RBPqVRBQcFaQdoe1mSNhTxKG+2h7b9LLjNzmRKmRGFA3ljUtGyd3r2wp+2GNY/0ehtW56P2QghxyYtPVuiYWUS6F8/o90Hmp8rdfUCTTJUDBsrLhVXARgjU2R54OcIPzZeAA0pL0nctMDCNI+DruWaAxviBFPCyZuB8oDjVc/0HBC/sYZ4AAAA=", "checkText"],
  [645, "gate-r17-sec--q2-falseref.ts:sql#37; gate-r17-sec--q2-falseref.ts:sql#38; gate-r17-sec--q2-falseref.ts:sql#39", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLvQqDMBgAXyV8i0voD5QOcYqihf4JWgtFHVKNNmAS0VgL6ruXLHe3XAZJcA38B3IqZhgRkjV826nGfbOBHw9YPL0onnaXU6MppfSepJ8gbWwGFp5PX9Z1WCZnJ1cILQsaxroWv1yFcXRDxs0VYKh0uZEV4BkM7+UAJJvhy9qRAwFWSl7qvgMMrVAcyH4tMLC21ROvgGQFBqUNt1OxFn/EMzTCsgAAAA==", "checkText"],
  [646, "gate-r17-sec--q2-falseref.ts:java_args#40; gate-r17-sec--q2-falseref.ts:java_args#41; gate-r17-sec--q2-falseref.ts:java_args#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLzYrCMBRGX6V8qxaCjjC4iKsoVVAYwT+Qpos76bUG2qQkURfiu0s355zNqUAxckinO6V8oBA512gokbQ9tTwdXLv4p8jzX2Evy/3h9bPbtF4ppf6O53t5bscsRyxX6jr6tjbHrYbQLsuyTCOmYE3SKIqJjafw4LxYaAeBxptJ30C8kTj0EbJ640ndgyFBpmfjwwCBzjqGnH1qAeo6/+IGsqoFnE88TvWn/gIHAqY1xQAAAA==", "checkText"],
  [647, "gate-r17-sec--q2-falseref.ts:go_struct#43; gate-r17-sec--q2-falseref.ts:go_struct#44; gate-r17-sec--q2-falseref.ts:go_struct#45", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyWMQYvCMBSE/0qZc1hdEA8RD3FRwYUVFAVpcnimz1i2TSSJeij971K9zHxz+KbEg2JhKXEq5kVpUo61d532OmtUlEnWLTke3bybnSnxdCLq42K7e45/1y4opdTf/nBdHtyAyyEWP+o09GVl9xsN8bk6x/DP/j177SFQBfvVVhAdMsc2QZYdHtTcGRJkW7Yh3iDQ1J4hv3sjQE0TnlxBlkbAh8yDZHrzAiR37d/DAAAA", "checkText"],
  [648, "gate-r17-sec--q2-falseref.ts:rust_vec#46; gate-r17-sec--q2-falseref.ts:rust_vec#47; gate-r17-sec--q2-falseref.ts:rust_vec#48", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAzWMPQvCMBiE/0q8OfgB4hBxSKUKCiqWCtJmiOlrLKRJqbUO0v8uFVzunhuey+CoZR1bsY7MKMs9Y4zlKHSrRVlpS5Pa2+VNP2kx5+UlOp7f0/3WBimlPCTpI07tgPEQ0Vpeh75vTLLLwf9nJ29/Sy1zD44imHFVgH/QUlM9IbIPOu1eBAFtKjKhqcHhSk8Qs15xaOfCmwqITHH40NIgqV59AR3C+ja9AAAA", "checkText"],
  [649, "gate-r17-sec--q2-falseref.ts:html_attr_next#49; gate-r17-sec--q2-falseref.ts:html_attr_next#50; gate-r17-sec--q2-falseref.ts:html_attr_next#51", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLywqCQABFf0XueugB0WLKYAwLKgoSg3BcTOM0CfMQtVyI/x5zF+eczS2wra2OulbGHJXoBa2t0GreOL15iU6tV6R+JLf7sDgftWeMsWuWf9Jch0wDkj17Br8PMjtxcBeFCdPHHBevPceOOxBUXs5sBTKiV63tQIsRP2G+ChRCWiV924DA1E6BLqeSQBjjB1WBFiWB870Kp3Iq/xqPKP+0AAAA", "checkText"],
  [650, "gate-r17-sec--q2-falseref.ts:html_text_next#52; gate-r17-sec--q2-falseref.ts:html_text_next#53; gate-r17-sec--q2-falseref.ts:html_text_next#54", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx2MywrCMBQF/+Wug1UQFzEUUqmCioKlgrRZxOQaC3nRVrso/XepmzOzmVMBU0FjqmUvaeOkwSR6s33KDjdr0tyz621Yng4mcM75pSjfeWlmzefJdvwx87VXxZEl/6Pas5iegwksiWntgYAOauE0kBF6bF0HtBrhK+0HgYJUDlVoIxCwjUegq0kQkNaGATXQShDwocc5EpP4AWxj5IqtAAAA", "checkText"],
  [651, "gate-r17-sec--q2-falseref.ts:md_codeblock_word#55; gate-r17-sec--q2-falseref.ts:md_codeblock_word#56; gate-r17-sec--q2-falseref.ts:md_codeblock_word#57", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAx2MywrCMBBF/2XWwQeIi7hKtQoKFSwVpA10TMZYyKO01S5K/13i5p6zObeEuq4rr3FA3jg0tGy92T2xp+2GNffkehtXl5MJQgiR5cU7LUzUNE6yF4/I11Hl58qn2aHy/zdgoINaOA1sgoE61wMvJ/ii/RBwQOVIha4FBrbxBHw9SwZobRhJAy8lAx8GipGc5Q8DSaX5ogAAAA==", "checkText"],
  [652, "gate-r17-sec--q2-falseref.ts:md_two_line_def#58; gate-r17-sec--q2-falseref.ts:md_two_line_def#59; gate-r17-sec--q2-falseref.ts:md_two_line_def#60", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLyQrCMBQA/+WdgwuIh3hKpQoKCtYK0ubwmjzTQBbpYg+l/y65zMxlKtA4ILceDa2/wRwa7Gm/Y/aV3R/T5no2UQghbkXZ5qVJmSdkR/FO/pxUcanDsx19E9C6OgADHdXKa2AzDNT5Hng1ww/dSMABlScVuy8wcDYQ8O0iGaBzcSINvJIMQhwoTXKRfxoEA4yeAAAA", "checkText"],
  [653, "gate-r17-sec--q2-falseref.ts:log#61; gate-r17-sec--q2-falseref.ts:log#62; gate-r17-sec--q2-falseref.ts:log#63", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxWLuwrCMBRAf6XcOfgAcYhTqq2o0IKlgrQZYnKNhTxKG+1Q+u+S5ZyznAYuRV4m2odEiSBoZ4XGde/04SVG3O9I90jL+7S5nbVnjLGiqj9ZrWNmEemRPaPfuayurTuVRdY6IKC8XFkFZIaAgx2BNjP8hPkiUBDSovRDDwRM5xDoduEEhDF+QgW04QScDxgnvvA/AV8zPaIAAAA=", "checkText"],
  [654, "gate-r17-sec--q3-multiline.ts:py_docstring#1; gate-r17-sec--q3-multiline.ts:py_docstring#2; gate-r17-sec--q3-multiline.ts:py_docstring#3", "quiet", "refusal", "private", "H4sIAAAAAAAAAzVQ226CQBD9FTIvfSEqKbVK48OCCF4KAq6tFR5W2CJ1WRSoiMZ/b9akmWTOJTlzktnC2DWkkRTCY7hNSypllVTvqZTlJKVayBNSE+0hukeevu1IRfuqnK111296cystEELICfDexKmgpli6gTYCvydxMBMEfTqB35uislLjvicMn3tY0REyLiH/ac6DjYeFXVDmbxLTOe8+FLbjHkJ2Frdtdxm0ShCYV3eFn91Fe/QC4+LP31+ni/ZgIevkGc7lZA+X85CLM2PMTG/tq9xaqtfBuLEbNEHI7mZfh6H96NdnPn4xy8MsTdPRKOSrPamfKokw1gn5/0NAhqSIO3kC8g1qWuYVaNsbnAn7paABiXMaF+URZGAZp6Ap90gGwljR0AS0bSQDL2oqQtE9+gNuSX2vbgEAAA==", "checkText"],
  [655, "gate-r17-sec--q3-multiline.ts:py_docstring_md#4; gate-r17-sec--q3-multiline.ts:py_docstring_md#5; gate-r17-sec--q3-multiline.ts:py_docstring_md#6", "quiet", "private", "private", "H4sIAAAAAAAAAzWP3W6CQBCFX8XOVZuQKiltlcaLARH8KQgUWwtcIGy31HVX0YpofPdmTZqTzDn5kpnJiWHgma1+K4Gr+E3MBBXpbZHtM71cZ5S0N5y+LLMdedKUcm54Qd2Z2FQgIrph9G1FVEZLDsPEhfSvYR6OZcAPNww6I6x2Wv7kSxBwP1INRPOY8J/60F34kcSCsGBRWO5h+a6yJfcRnTJvmvYsbNQwtE7eW/TgTZuNH5rHYPL6PJo2KxvtrW+6x63Tm00SLs8MImb580Dj9kw7dQe1U+MQ0WmXn6uec/1vjIPo0apWY0ppv3+X8P/ioEAh8vt1AcoZ9qRa70CPz3DI2C8BHbJ8TXJRbUABVnICunpJFcgYEzUpQI9TBbjYE7mUXtI/U4yL3lYBAAA=", "checkText"],
  [656, "gate-r17-sec--q3-multiline.ts:js_template_md#7; gate-r17-sec--q3-multiline.ts:js_template_md#8; gate-r17-sec--q3-multiline.ts:js_template_md#9", "quiet", "private", "private", "H4sIAAAAAAAAAx2N226CQBiEX8XuVZuQKim1ivHiBxE8FAWKrQUSEbZb6rKLQEU0vnuzvZmZfMnMBCjhrKo7edoZd3YhuwsoJzy6T+M6VrM8JrhbMDLaxxXuK1K20VZu01uYhAMA2J7/bfhEREOIpsNW+Nc08eYiwIftub0ZlJWS9B0BXOb4sgagn0P205wGW8cXmGPqblPDPu3fZbpnDoCVJW3bXXut7HnGZfXmP62WbeF4+tldvL7Mlu3BBPPo6Pb5aA3Xi5CJmYlPDWfjKsxcK5fBpLEamAJY3ezzMLT+/7W56z8b5WFOCBmPH0K2G4UMSSjlyWOeIumKalzmFVKDKzrF9BcjFcVJjhNeFkhCNGMYqfItklBMKW9witQgkhDjNRal6Bb9AWv7kulSAQAA", "checkText"],
  [657, "gate-r17-sec--q3-multiline.ts:js_template_prose#10; gate-r17-sec--q3-multiline.ts:js_template_prose#11; gate-r17-sec--q3-multiline.ts:js_template_prose#12", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2N226CQBiEX4XsNfGQUqsYL34QwUNR2GJrhUSEdaUuuwpUROO7N9ubmcmXzMwWJYKXlZKnykjZhRwToqRxFetZHlPSPnM63Mcl6WlqtjaWft2Z21QAALg4OFoBldGSYpiwkX6YJHgmA3y52O9MoSi1pOdJ4HMv6BoA5i3kP/W1v/ECiQVh/ia13Ov+s8v23ANwsqRp2ivcdDG27suP4GW5aM4eNm/+/P1tumhONtgXz3RvF2ewmodczowDZnlrX+P2Srv3x7VTwwTAaWffp4Hz/2/M/ODVKk4zSuloFPKDKJTqSBQmqGiFfDcMOVJRKpJWniL1gSpS5CXStw90jdkvQTqKk5wkojgjFbGME6R3n5GKYsZETVKkbyMVcVERWYqe0R/hIcG9XAEAAA==", "checkText"],
  [658, "gate-r17-sec--q3-multiline.ts:json_md_string#13; gate-r17-sec--q3-multiline.ts:json_md_string#14; gate-r17-sec--q3-multiline.ts:json_md_string#15", "quiet", "private", "private", "H4sIAAAAAAAAAyVPX2+CMBz8LPs9bQlRyZibLD4URPDPUGC4OcpDga5jllbRiWj87ku3l7vLJXe5S+CCIZNFi8HEMJdMmhgLjMVNwiWT6W1BDsQsK8JodyvYc0b2tG9o5cpahE1v5jKJEEJ+FH85MVPSUWDZaK34c5xHUyXQux+FvQmq90beD5QRiiDWLYTsE8biuzk+rYNY+ZLycF04/jF703kmAoS8Mm/b7jJq9ShyzovX+H4xb7dBZJ/C2cvjZN5uXOTuAts/7bzBcoaxUD2jmDvBKjSEuzTOT6PGa9AYIa9bfmwG3t8CaxrGD069mTLGhsO7/9uOKDoYrqBBIfNOVYB2gQOtqz2YyQWOhP9QMIHkFc1lvQUNeCkomPo11YBwLhtagJmkGgh5oCqUXtNflpyLyGQBAAA=", "checkText"],
  [659, "gate-r17-sec--q3-multiline.ts:ipynb_md_cell#16; gate-r17-sec--q3-multiline.ts:ipynb_md_cell#17; gate-r17-sec--q3-multiline.ts:ipynb_md_cell#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAzWOW0+DQBCFf4vzpAmxbcRqMX1YKIVepAWkWllitsuKyHIp0AJt+t/NanyZOTkn883x4YyBMs4/6q5gGBQMKSmTMG8yDBKGKj+UVPg+hiu/Da5DUhMlTknEekUWPe1IxYayFG/UldP0F0aUI4SQ5XpfuhcJqYuhamgr9ueUunMh0JvlOv0ZKiuZDm1hOJntDVSEtBbjv9ffzfFxa3sizBl3tqFuHXevA77LbITMmHZdb+12A9fVT6sX72617Arb1Vpn8fwwW3aJgYy9rVnt3hytF/9MAZt4XLc3jpwZa/n0OGnMBk0RMnvxezIyf7uoc8e718tkHkXReHyDIbiABGFOb9MQpDPUrEwrUPwzHAk/MFCA0JTRvCxAAh5nDJTBJZCAcJ43LATFDyTI8pqJo+AS/ABRx1XTdQEAAA==", "checkText"],
  [660, "gate-r17-sec--q3-multiline.ts:yaml_dq_multiline#19; gate-r17-sec--q3-multiline.ts:yaml_dq_multiline#20; gate-r17-sec--q3-multiline.ts:yaml_dq_multiline#21", "quiet", "refusal", "private", "H4sIAAAAAAAAAx2OzXKCQBCEX8WaMxWlQoyS8jAggj9BgWBihAPCZrMRdhGIiJbvntpcZrq6q7+ZPWSkTitWNkxwvRfBSlChR7zXy5Im0VmRUNIvOX05JDUZagrbGmu/HSxtKhAR3SD8tkIqpSWHYeJO7q9ZGiykwA838AdzrGotHXrS8LkXqgaieZFXftrzaOeFMhAk93eZ5Z4P72p+4B6iw9Ku62+CTg0C67p+Cx/Xq670AvPiL1+f56vuaKN98kz3cnLGm6XkSdA0zC1v62vc3mjX0bR1WpwhOn32eRw7/z8YCz98sqrjglI6mcge4VkEEQcFMpE+FBkoN2hIVdSg729wTvJfAjokaUFSUZWgQM44AV29xwokeS5akoG+jxXgoiGyFN/jPzQRyShcAQAA", "checkText"],
  [661, "gate-r17-sec--q3-multiline.ts:toml_ml#22; gate-r17-sec--q3-multiline.ts:toml_ml#23; gate-r17-sec--q3-multiline.ts:toml_ml#24", "quiet", "private", "private", "H4sIAAAAAAAAAzVQXW+CQBD8K2afSZWUWqXxYUEEP4oe17O1wsMJV0qFQ9GKaPzvzZk0m+xOJpnZzKwhKePWoBXCfWTCj9zMCp6K9k6mLxt+EF1Dy5bWPKg7UzctERF9yr4dliroqGXZuFL3axTTiQL44dOgM8bqYMRdoohAEqZbiPY5lD/1qbciTNGlyINV4vinzbuebyRB9LK4adoL2uiUOpf5G3ucz5odofY5mL4+j2fN1kV3T2z/vPf6i2kolc2Q5Q5ZBoZ0F8alN6y9GkeIXjv73Pa9+39rErAnp9pO0jQdDEL5nxc0VcBDkYB2haOoigOY6yuceP4rwAQeFyIuqx1okGdSgKnfIg14npe1SMBcRxrI8iiUKLpFf1EHydNNAQAA", "checkText"],
  [662, "gate-r17-sec--q3-multiline.ts:toml_ml_md#25; gate-r17-sec--q3-multiline.ts:toml_ml_md#26; gate-r17-sec--q3-multiline.ts:toml_ml_md#27", "quiet", "private", "private", "H4sIAAAAAAAAAzVQXW+CQBD8K3af2oRUSalVGh8WRPALPejZWuAB4UqpcChaAY3/vTmTZpPdySQzmxkP4iJqDVo+3IbfeXVwH4fHUE3zMGHtHU9eN+GBdRUpXWkLp+pMzaRARLRd+m3QREBDLE3Htbhfo8idCIAftut0xlgelKhLBOFwQmUNUa99/lOdemtCBV2wzFnHhn3avMvZhhNEK42apr10G9l1jfPijT4tZs2OuHrtTOcv41mzNdHcE92u91Z/OfW5sBnSzCArR+HmUjn3hpVV4QjRaqef2751+69NHPpslNtJkiSDwYPP/1ODJGp4zGOQLnBkZX4A1bvAKcx+GagQRjmLinIHEmQpZ6DK10CCMMuKisWgeoEEvDgyIQquwR9L7L/EUwEAAA==", "checkText"],
  [663, "gate-r17-sec--q3-multiline.ts:html_pre_quote#28; gate-r17-sec--q3-multiline.ts:html_pre_quote#29; gate-r17-sec--q3-multiline.ts:html_pre_quote#30", "quiet", "private", "private", "H4sIAAAAAAAAAx2N226CQBiEX8X816RISq1SMFkQxUNRoNhalwuELaUsuwhUQOO7N/RmZvIlM3MEtSjJoE5rSjQMlCccwxSzOKxDJc3DhIgFS15OYUVGspDu9a3bDNeLhCOEkO3536af9NHsRTfQofeveeSt+oA+bM8dLlFZydHI6YHLHF/SETJazH6ay/jg+D3mhLqH2LQvp3eJnpiDkJVGXSfuvE7yPPO6ffMft5uucDyjddevz8tNly3Q4uwYdnu2Jrs1Zv3MzKems3dlttjJ1/GssRo0R8gS089sYv3/6yvXfzLLbJUkiaZhpopFSaaYqcUgomFVaRhaDFOeqWIxBQFiHj3kMQg3qEmZV6Acb3AJ6S8BBcIoJxEvCxCApoyAIt0DAUJKeUNiUI6BAIzXpC8F9+AP9mclvGoBAAA=", "checkText"],
  [664, "gate-r17-sec--q3-multiline.ts:md_in_heredoc_sq#31; gate-r17-sec--q3-multiline.ts:md_in_heredoc_sq#32; gate-r17-sec--q3-multiline.ts:md_in_heredoc_sq#33", "quiet", "private", "private", "H4sIAAAAAAAAAx2NX2+CMADEv4rri1tCVDLmlOmSggX8BwLDzQEPFbqOWVpFJqLxuy/s5e7yS+4uBAkuW68tD8HJEnXytDUatZFjtCN+FzJBRXyf4hKrWY4p6e45fdniI+krUrbWHK/qzU0qIITQ9oNvFNAmokY0HW4a/zISf9YE+GH7Xm8Ki6OS9N0GeNwNZA1C/Rzxn+o02LhBgwVh3iZF9mn7LrMtdyG0sqSuuyu/ln0fXZy34NFZ1HvX18/efPk8XdQ7E5oHV7fPB2u4mke8mZkEDLlrT+HmSrkMJpVVQQNCq5t97obW/78284InVOxmlNLx+CHiyDEiDiSQiqSTp0C6gpIU+RGo4RWcMPslQAU4yUkiij2QAMs4Aap8iyWAGRMVSYEaxhLgoiRNKb7Ff83xv7peAQAA", "checkText"],
  [690, "gate-r17-sec--q5-b64url.ts:b64url_gzip_term#1; gate-r17-sec--q5-b64url.ts:b64url_gzip_term#2; gate-r17-sec--q5-b64url.ts:b64url_gzip_term#3", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLTQ+CIBgA4P/ynulrs2Z0IldZy272MceBhCkTwYSscP731qHn/mTAmWOYNY2SOXPS6EnhZbO6MysWAYoDuyd/oe381Lq0KhNfzU5eho90Ux6OqU58pC6fdXiOy7S+vguylLvRfHuLCCGAgJt8XHNAPTjR1hZw1kPH1FMABpbXIjdtAwiU1ALwbKAImFLmJTjgjCLQxolfogP9AtXOz3qvAAAA", "checkText"],
  [691, "gate-r17-sec--q5-b64url.ts:std_gzip_term#4; gate-r17-sec--q5-b64url.ts:std_gzip_term#5; gate-r17-sec--q5-b64url.ts:std_gzip_term#6; gate-r17-sec--q5b-stdtail.ts:gz_plain#1; gate-r17-sec--q5b-stdtail.ts:gz_plain#2; gate-r17-sec--q5b-stdtail.ts:gz_plain#3", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLwQrCIBgA4Hf5z1INRgw72ShWzKCDFQwPtkmTObVpixx79+jQd/8qaEQQWDinVS2Csmb5iMpt7sLLdYqK1B/IX+bHuPKBdS2NXXKKKnuyXXssmaEx19fPNrsUZsgJZWXc3yg5EwIIGlsv+gbQBEEOvQdcTTAK/ZKAQdS9rO3gAIFWRgJOZo5AaG3fsgFccQTGBvlLfOZfDzzcZ6wAAAA=", "checkText"],
  [692, "gate-r17-sec--q5-b64url.ts:b64url_ansi_text_term#7; gate-r17-sec--q5-b64url.ts:b64url_ansi_text_term#8; gate-r17-sec--q5-b64url.ts:b64url_ansi_text_term#9", "private+refusal", "refusal", "private+refusal", "H4sIAAAAAAAAA8XLwQqCMBgA4Hf5z7OQLGKdkkA8JHaIlSIxt79hzE10Wiq+e/QUffcvB8kdpw4/bt1oXplDyTvcBaTcyD67xerOEpexZBDmqCK/m87MHzN2KdkUujjaDjK6qvQVePFp/0jH0HuaQP3rAgFpxaqWQGZw2NYd0HyGgesegQIXNQrbNkBAVwaB+ktBgGtt3yiB5gUBYx3+UrEUXysACXUaAQAA", "checkText"],
  [693, "gate-r17-sec--q5-b64url.ts:long_prefix_trunc_word#10; gate-r17-sec--q5-b64url.ts:long_prefix_trunc_word#11; gate-r17-sec--q5-b64url.ts:long_prefix_trunc_word#12", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxWLywrCMBQF/+Wsgw8QF3EVpQoKCpYKUoLE5BoLeZQ2tYvSf5dsZmYzNYxKijdeWVq2we7eqqfthjWP/e0+ri4nG4UQ4lpW36KyOYuM/UE8sz9HXZ5fqRuCVokMGEzUC2/AJiTqfA9eT/gpNxA4lPakY9eCwTWBwNezZFDOxZEMeC0ZQkyUJznLP5Vuea6bAAAA", "checkText"],
  [694, "gate-r17-sec--q5-b64url.ts:long_prefix_example#13; gate-r17-sec--q5-b64url.ts:long_prefix_example#14; gate-r17-sec--q5-b64url.ts:long_prefix_example#15", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLOwvCMBSG4f/yzfEG4hCnFIKDV5SKEDIcm0Ms5FLaaofS/y5dXp7lNXDUk6wjeV41ye/f1PFuK+pncb0P6+PBZ6WUujzKjy79TD2nWOiXOt9OGgIuV8voIEb03MYO0oz4UfgyJKiKXOW2gUCoE0NuJitAIeSBHaSxAin3PE92sn/4g4GhjQAAAA==", "checkText"],
  [695, "gate-r17-sec--q5-b64url.ts:jpeg_replace#16; gate-r17-sec--q5-b64url.ts:jpeg_replace#17; gate-r17-sec--q5-b64url.ts:jpeg_replace#18", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAxXLQQuCMBgG4P/ynkcjkKB1+qwdioLUWzJkuQ/RNidqdRD/e/TcnxLOzla1wTYsu4Gbw9NOvEuE3HcyIcqK1+OSN5RSpqmg9Ex0qnJ9v9JRVzcNARfrTXAQC2YewwRVLvhY/2Yo2DpwHccBAr7tGWq7GgHrffyygyqNQB9n/iezmh9IHGBYjAAAAA==", "checkText"],
  [696, "gate-r17-sec--q5-b64url.ts:html_comment_clean#19; gate-r17-sec--q5-b64url.ts:html_comment_clean#20; gate-r17-sec--q5-b64url.ts:html_comment_clean#21", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx2LWwuCMBhA/0p9z7MLWNS6wExLDLooBiU+LF1rtDkxSyj877FezjkvJ4F517I6Oa0pFopy1i8LPrvSJxvbSJycfdgMthuuCSFkF8V3L+YmPQNnRc7Gt3UWBSbcWHrHU2gXm4P9mbiN35A1IX5fXB5T//hfgjAeedUj4JwvFpa1BAS5znoqB/SFmlXqCTj5wpvKFwMMNFMs01UJCKQoGOBhmyKgUuqG5YCTFEGha2amtE1/CDWWJ80AAAA=", "checkText"],
  [697, "gate-r17-sec--q5-b64url.ts:std_png_then_dash_word#22; gate-r17-sec--q5-b64url.ts:std_png_then_dash_word#23; gate-r17-sec--q5-b64url.ts:std_png_then_dash_word#24", "quiet", "refusal", "quiet", "H4sIAAAAAAAAAx2LTwuCMBxAv8vvvLLAohYeZv7DoFJRKPGwdC1xOlFLSPzusS7vvctLoaADxWVNOdPahh8etGdbHZWJeQnH1cnlkhBCzlH8smOu0lYwj+Sm/HTyyFdhxcIOklBv3Kv+3VmjNxKHEE8r79XeC/6LH8Ybu6t8zrlhLITkEhAUMl/WBaAJBtbVPeB0gg8VbwYYaF6zXHYtIBBlwwCv5wwBFUKOrACcZggaOTA1ZXP2A3GRZIDKAAAA", "checkText"],
  [698, "gate-r17-sec--q5b-stdtail.ts:gz_html_comment#4; gate-r17-sec--q5b-stdtail.ts:gz_html_comment#5; gate-r17-sec--q5b-stdtail.ts:gz_html_comment#6", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLwQqCMBgA4Fep/zwrQUJWBEsKCw06WIHssHTkcG7mltHEd48Offcvh/XU8yYlswyztpWiYFZoNX840a7uzPBlgOLAHMhfaHq3MDarq9TV/smJ8JntqmOSqdRF8vrZhpdYdRFJs8Ttbyk5E+J5G0BQ6mLWlIAGsLxrDOB8gJ7JFwcMrGh4obsWEEihOGB/pAiYlPrNS8A5RaC05b9ER/oFbUktcLQAAAA=", "checkText"],
  [699, "gate-r17-sec--q5b-stdtail.ts:gz_underscore#7; gate-r17-sec--q5b-stdtail.ts:gz_underscore#8; gate-r17-sec--q5b-stdtail.ts:gz_underscore#9", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLwQqCMBgA4Hf5z6MyJGSdlhQWLuhgBTJizZHDuZlbRhPfPTr03b8SKu455l2nleBeWTN/BNWt79zJVYyy2O3JX+KGsHC+aGoamugYVPIstvUhLwwNqb58Nsk5M31KaJGH3ZWSEyG3YQkIKitmbQVoBC/71gEuRxi4fknAwEUrhe07QKCVkYCjiSHgWtu3rACXDIGxXv4Sm9gXrHWdSK8AAAA=", "checkText"],
  [700, "gate-r17-sec--q5b-stdtail.ts:gz_dash_word#10; gate-r17-sec--q5b-stdtail.ts:gz_dash_word#11; gate-r17-sec--q5b-stdtail.ts:gz_dash_word#12", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLSwrCMBAA0KvIrOMPREpcxaKoWEGkKpQuxmTQYJrEJipGvLu48O1fBTuijsKIHL03WmLUzvbPSfvJCQONR2wxCkvxl4VHGoRYXi9Fug43SWe3cnZZrUtbpNwcXtNsv7BtLopynebHQmyF6JKVTpHqeHwZh6oHDJSTvUYBe0OktgnAqzc80NwJOKBsSLrWAwOjLQEffmoGaIx7kgJe1Qysi/RL9af+Ajg0yhfBAAAA", "checkText"],
  [701, "gate-r17-sec--q5b-stdtail.ts:pdf_html_comment#13; gate-r17-sec--q5b-stdtail.ts:pdf_html_comment#14; gate-r17-sec--q5b-stdtail.ts:pdf_html_comment#15", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzXLTQuCMByA8a9S//MsBYtaGcwQypegDl3Ew9oWzKZbul5Q/O5R0HP98eSwHjvOiFNLMTVGSUat1PXU8OvqQlsx91F8DqOTdN9peUxikZbdMkt2frsn/1ybdTfv0MnFnRDisVkUbn8QBI6zAQRcs0nFAfVgRVO1gPMenlQ9BGCgrBJMNwYQKFkLwN5QIKBK6ZfggPMCQa2t+E7FUHwAxW/ukq8AAAA=", "checkText"],
  [702, "gate-r17-sec--q5c-text.ts:text_pad2_comment#1; gate-r17-sec--q5c-text.ts:text_pad2_comment#2; gate-r17-sec--q5c-text.ts:text_pad2_comment#3", "private", "refusal", "private", "H4sIAAAAAAAAAxXLywqCQBQG4Fepfz3ThSJoyqBlG6GVpcziOHMQYS6iowXiu0ff/qtwXUu5spRIJf6mbeeoDZeaBj4dRX2wY/l6NO8iT2WRTybcm9qfd+Uzy6S8QcBGs/EWYkbi3g9Q1YyJ3MhQIOPZxL6DgGsDQ+0XLUDOxQ9bqEoLhJj4n/Sif/GuqHWKAAAA", "checkText"],
  [703, "gate-r17-sec--q5c-text.ts:text_pad1_comment#4; gate-r17-sec--q5c-text.ts:text_pad1_comment#5; gate-r17-sec--q5c-text.ts:text_pad1_comment#6", "private", "refusal", "private", "H4sIAAAAAAAAAxXLywqCQBQG4Fepfz3ThSJoukDLFrnVlFkcZw4izEV0tEB89+jbfxWuaylXlhKpxN+07Ry14VLTwKejqA92LItn886zVObZZMKjqf15Vxavm5R3CNhoNt5CzEjc+wGqmjGRGxkKZDyb2HcQcG1gqP2iBci5+GELVWmBEBP/k170Dz4aMqCKAAAA", "checkText"],
  [704, "gate-r17-sec--q5c-text.ts:text_nopad_comment#7; gate-r17-sec--q5c-text.ts:text_nopad_comment#8; gate-r17-sec--q5c-text.ts:text_nopad_comment#9", "private", "refusal", "private", "H4sIAAAAAAAAAxXLQQuCMBgG4L9S73krouiwUujYxaul7PBt+xjC3ESnBeJ/j5770+K+l3LnKJPK/M3HIVAXb4Ymvl6EObu5eT39u65yU1eLjQ9vfFFIWULAJXvoHcSKzGM/QbUrFgozQ4FszzaNAwRCFxnqtGkBCiF92EG1WiCmzP+kN/0DrkGp4IYAAAA=", "checkText"],
  [705, "gate-r17-sec--q5c-text.ts:text_nopad_dash_word#10; gate-r17-sec--q5c-text.ts:text_nopad_dash_word#11; gate-r17-sec--q5c-text.ts:text_nopad_dash_word#12", "private", "refusal", "private", "H4sIAAAAAAAAAxXLvQrCMBQG0Hf55qiI4hDp4OjStdqQ4Sb3Egr5KW1ahdJ3F89+DJgq6SrfehojDfnuaJbbVbkLL/3rGd5dW/uuXX1+BBea5iDZFxaGAhd/TAy1ocqUZmizYaW4CDTIJ/FlGqEQhyzQ590qUIzlIwxtrEIuVf7J7vYHGS3rJoYAAAA=", "checkText"],
  [706, "gate-r17-sec--q5c-text.ts:text_pad_underscore#13; gate-r17-sec--q5c-text.ts:text_pad_underscore#14; gate-r17-sec--q5c-text.ts:text_pad_underscore#15", "private", "refusal", "private", "H4sIAAAAAAAAAxXLuwrCMBQG4Hf55+AdwUgHR5eCUzUhyGlyKIVcSptGofTdxW//NBxlkpm/eTt46uO1pYnPJ9Ee3aye9+7V1Fk1dbHx1rXhslOPqnqXAwRcspvgIBZkHsMEqRcU8jNDgmxgm8YBAr6PDLlfjQB5nz7sILURiCnzP5nV/AAdzCrWhQAAAA==", "checkText"],
  [707, "gate-r17-sec--q5c-text.ts:svg_comment#16; gate-r17-sec--q5c-text.ts:svg_comment#17; gate-r17-sec--q5c-text.ts:svg_comment#18", "private", "refusal", "private", "H4sIAAAAAAAAAyXLXYuCQBQA0L9S99WxzI+FpljYCuohF4mWzcSH652hjJkm1EYt+u/L0vs5GcyHrjsQ2CAvNZ7kuLYnp9NqVmAtP0KWbL79Y78Ii9/uTg+vxM3Oo5Wx20AEoo+CuI8sabLx5auNl9OH0FQml87Dw64+7qNz6k9U6k97WrVWrJVXrH+c5O0c1/0EBsLQSAtgT2hkpWvg2RMsqrsEDkhakqluwECVVwl88soZoFKmlQJ4ljO4mkb+p/yV/wGgAqEKzQAAAA==", "checkText"],
  [708, "gate-r17-sec--q6-gifwebp.ts:gif_clean#1; gate-r17-sec--q6-gifwebp.ts:gif_clean#2; gate-r17-sec--q6-gifwebp.ts:gif_clean#3", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAyWLsQrCMBgGn8VvUghGQRwiDn8tiJPWNWSIzW8tJo201Sql7y6lNx0HpzHTXzN3trWqDLZgWZT33c02vN2I68ofz6l/UEYJnWjiIqX8dZOPnehAzyyhtNkvIOBivgwOokfLdWigdI+P9W+Ggs0D57F+QcCXFUOtByNgvY8dOyhtBKrY8jiZwfwBLN7qsZsAAAA=", "checkText"],
  [709, "gate-r17-sec--q6-gifwebp.ts:gif_comment_straddle#4; gate-r17-sec--q6-gifwebp.ts:gif_comment_straddle#5; gate-r17-sec--q6-gifwebp.ts:gif_comment_straddle#6", "refusal", "quiet", "private", "H4sIAAAAAAAAA+2QwQqCQBQAv6V3KlraQumw4eFZkkZUeomSPaz6UmPVSMsi/PeIfqFjA3Ocy4TQCx+yn6hGibxQKfE0P80iVdPUZMFYL7cLnaGPNnr4Zcc5f7pDbmQmuX9/5WG/aY6+PkfGqvXcIFP7Ftff4zaig4jePEAHt61lDYBBUsWjIgH2goauRQ0ifMFd6RuBABUXFFfXCzDQeUkgJp1koLSuWkpAhJJBWTX0iWQn3/3lHoEDAgAA", "checkText"],
  [710, "gate-r17-sec--q6-gifwebp.ts:gif_app_straddle#7; gate-r17-sec--q6-gifwebp.ts:gif_app_straddle#8; gate-r17-sec--q6-gifwebp.ts:gif_app_straddle#9", "refusal", "quiet", "private", "H4sIAAAAAAAAA+2RwQ7BQBQAv8U7kWxshTisOLxSWhG0QUOzh9U+WtmqtKVE/LtIf8HRJHOc0wTQCB6yGalSiSRVJ+Kn5Dg4qIL6PeYZeroc6xhdNNHBmhXn/GnzkbHduZuOu7a25maCD96Ne2T//ZU7f1HuXX0+dGeVY3ux8iuc1wdMRAsRnZGHFi6r4bAFDKIsbKcRsBeUlKcFiOAFd6VvBAJUmFKY5VdgoJMLgei8JQOldVZRBCKQDC5ZSd9IvuUHFGnGdhMCAAA=", "checkText"],
  [711, "gate-r17-sec--q6-gifwebp.ts:gif_plaintext_straddle#10; gate-r17-sec--q6-gifwebp.ts:gif_plaintext_straddle#11; gate-r17-sec--q6-gifwebp.ts:gif_plaintext_straddle#12", "refusal", "quiet", "private", "H4sIAAAAAAAAA+2RwQqCQBRFv6W3KhjSQoImWrzRstqkQYjILCZ9mTVmpGUi/XuEv9CyC2dxF2dzbwS96CX7iaoUz3KVkpFmx9lBlTSx2M7U7tbRJ/RR4Bq7eIZhNAvhdG2NmKKNqUBvatHq9OdXuMvzIdhvwvG0iW1hhoEu0a671b9/INp48QU65XwADJIiHuYJsBYquucl8KiFp9IPAg4qziku7jdgoLMrAR+9JQOldVFTAjySDK5FRV9JvuUHBpGV2hMCAAA=", "checkText"],
  [712, "gate-r17-sec--q6-gifwebp.ts:gif_unknown_label_deflate#13; gate-r17-sec--q6-gifwebp.ts:gif_unknown_label_deflate#14; gate-r17-sec--q6-gifwebp.ts:gif_unknown_label_deflate#15", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAyWLQQuCMBhAf0vfqWBkQkQsPHzaCqEyhS6NHZYuk6YrtSzF/x7hu773OIz4R4wTWUua5TJVVppdVxdZqcWcRDO9Ddb6hiG66OPA0bKs78ZjrN63d/vQZsvniaXxOQrNX++GykVkiOh7ETIMGseZAIHExNM8AdJBrcq8Aso7eEv9UkBBxrmKTfkAAjorFFC7FwSk1qZRCVAuCBSmVv9J9OIHI7y1TbcAAAA=", "checkText"],
  [713, "gate-r17-sec--q6-gifwebp.ts:gif_trailing_byte#16; gate-r17-sec--q6-gifwebp.ts:gif_trailing_byte#17; gate-r17-sec--q6-gifwebp.ts:gif_trailing_byte#18", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAyWLsQrCMBgGn8VvUghGQRzi9NeCOGldQ4bY/LbFpJG2WqX03aX0puPgNBb6a5bOdlZVwRYsi+pxuNuW9ztx2/jTJfUlZZTQmWauUspfP/vUiY70zBJKW1pBwMV8HRzEgI6b0ELpAR/r3wwFmwfOY/OCgK9qhtqORsB6H3t2UNoI1LHjaTKj+QPBkEGTmwAAAA==", "checkText"],
  [714, "gate-r17-sec--q6-gifwebp.ts:gif_no_image_trailer_only#19; gate-r17-sec--q6-gifwebp.ts:gif_no_image_trailer_only#20; gate-r17-sec--q6-gifwebp.ts:gif_no_image_trailer_only#21", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAyXLywoCIRQG4GfpXxVIFkQLo4URRKsuW3Fx0tMk6BijXWiYd4/o238GI/O2Y0+VVEjUsGzCdXWhwsuFOM/i7rCNN33SG73Xf0cp5aesJxDw2U2Th+hRuUsFyvR4UnwwFMgldrm7QyCGlqHmgxWgGPOLPZSxAm2u/Et2sF8MO3wAhwAAAA==", "checkText"],
  [715, "gate-r17-sec--q6-gifwebp.ts:gif_subblock_overflow#22; gate-r17-sec--q6-gifwebp.ts:gif_subblock_overflow#23; gate-r17-sec--q6-gifwebp.ts:gif_subblock_overflow#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAyXLuwrCMBQG4GfxnxSDURCHiENErE5eNgkZjs2xBpJG2nqpxXcX8ds/g5552b6jhpSPVLAs/GV+pppnU3Ech2y3Cld90Eu91X97KWW7GbbZ2p/e9WIAAZfyUXQQHRquYg1lOjwo3BkKlEfOU3WDQPAlQ00+VoBCSE92UMYKlKnhX7If+wUVgoaIjwAAAA==", "checkText"],
  [716, "gate-r17-sec--q6-gifwebp.ts:webp_clean#25; gate-r17-sec--q6-gifwebp.ts:webp_clean#26; gate-r17-sec--q6-gifwebp.ts:webp_clean#27", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLQQuCMBQA4N/SOxWMIhgdFh5eIFanlIxg7DC3R402J2oaiP89vHy3T8JK/tTa6l4LF/SLdiNVzbHSHR04Kz8+K94REU/PorzmD4/8jhwRcVhI0eRpkV3cjZ8Rk2QDDGw022CBTdBTGzoQcoJB+y+BAG0Cmdg2wMC7mkDsZ8VAex9HsiCkYlDHnpakZvUHpcEKnJwAAAA=", "checkText"],
  [717, "gate-r17-sec--q6-gifwebp.ts:webp_bad_size#28; gate-r17-sec--q6-gifwebp.ts:webp_bad_size#29; gate-r17-sec--q6-gifwebp.ts:webp_bad_size#30", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAxXLQQuCMBTA8c/SOxWMIhgd1ukFYnVKyQjGDs/tUdLmRE0D8buHlz/8Dn8NK/0za0c9qSrQi3cjl82xpI4PUhQfn+bvERFPz7y4Zg+P8o4SEXFYkqDNkjy9VDd5XrwBAS7abXAgJui5DR0oPcFA/suggGxgG9sGBPiqZlD72Qgg7+PIDpQ2AurY8zKZ2fwBUR7LlZwAAAA=", "checkText"],
  [718, "gate-r17-sec--q6-gifwebp.ts:webp_first_not_vp8#31; gate-r17-sec--q6-gifwebp.ts:webp_first_not_vp8#32; gate-r17-sec--q6-gifwebp.ts:webp_first_not_vp8#33", "refusal", "quiet", "refusal", "H4sIAAAAAAAAAzWLQQuCMBhAf0vfqWAUgXRYePgisTpEWoti7DC3j5CmEzUNxP8eHnqHx7s8CTP5VXOrW83zQr9o1VNWbTPd0CZg4u3iNH8i4u6RilNyFee9wAT/3B0GNwym7CZFaJIojY/5JTgghuECGFhvloUFNkBLddEAlwN02n0IOGhTkPF1BQxcXhLw9agYaOd8Txa4VAxK39I0qVH9ACCKGDasAAAA", "checkText"],
  [719, "gate-r17-sec--q6-gifwebp.ts:webp_odd_pad_nonzero#34; gate-r17-sec--q6-gifwebp.ts:webp_odd_pad_nonzero#35; gate-r17-sec--q6-gifwebp.ts:webp_odd_pad_nonzero#36", "refusal", "quiet", "refusal", "H4sIAAAAAAAAA02LSwuCQBSFf0t3VTAUgbSYcHED6QFCSvZAZjGOF7NmHFHTQPzvMbvO4iy+850UZulXzHPZSV4aWdBqoKzeZrKljceSt97HrwIRd/c4OUVXjd4NLSJiiH+56VqGkUO758OEB+dd0HNT7ypAFQXx/lievQOi7y+AQW7V0uTARuioMS3wdIRe6g8BB6kMKdvUwECXFQFfT4KB1NoOlANPBYPKduROYhI/wgalV8QAAAA=", "checkText"],
  [720, "gate-r17-sec--q6-gifwebp.ts:webp_exif_term#37; gate-r17-sec--q6-gifwebp.ts:webp_exif_term#38; gate-r17-sec--q6-gifwebp.ts:webp_exif_term#39", "private+refusal", "private", "private", "H4sIAAAAAAAAA02LywrCMBBFv8VZKQTFUgUjLqZSqoKg1aqlZBGToZamxketivjvkp13cTgcuBm0spdoa1lLXlQyp96TjpfxUd5p6LOkNFFc5ogYHOJksd4Z9PdoERGX+DfXt+g7bRxCVOswjubFyp9huEs3Sbp1fZOUV5wGjfYGRhXBKfX6JvVGb4U46QADbVW30sA+UNOtugPPPtBI8yDgIFVFyt4uwMAUZwLe/woG0hj7JA08EwzOtiZ3El/xA3whBjDYAAAA", "checkText"],
  [721, "gate-r17-sec--q6-gifwebp.ts:webp_xmp_split_two#40; gate-r17-sec--q6-gifwebp.ts:webp_xmp_split_two#41; gate-r17-sec--q6-gifwebp.ts:webp_xmp_split_two#42", "refusal", "quiet", "private", "H4sIAAAAAAAAA03LzQqCQBQF4GfproqGIpKIaXUT06IkJfuTWUzjxaTRiTINoneP2XUWh8MHJ4VO+hbdTNaSF6XMadjS5T67yCdNHJbctB/fWkScH+NkFe01Ogc0iIgb/Iv1HTp2NrY8VJEX+8ti6wS4uIaJi4H1bZD3T4ewPkfz026PuWvRDxtV4XQ9zvs9YJAZNSgzYB+o6VE+gacfaKR+EXCQqiRlHndgoIuKgI++goHU2rSUAU8Fg8rUZE/iK37KqHp33AAAAA==", "checkText"],
  [722, "gate-r17-sec--q6-gifwebp.ts:webp_exif_gps#43; gate-r17-sec--q6-gifwebp.ts:webp_exif_gps#44; gate-r17-sec--q6-gifwebp.ts:webp_exif_gps#45", "refusal", "quiet", "quiet", "H4sIAAAAAAAAA12NX0vDQBDEP4v7pHD4B4IPJz5MakhTELzUtGq4h2uyhNBLrraxFUq/e9kWirgPvx0GZqakq/LXXtducLrtXMN3O16snhZuw4+RKpY+zfsGQPyRFxMz84jmCADwij8n/jsikVtBgsokeZq1b9EYyexzWnwl4k+L5TcgfYgxmmexfABpc6kaARlig5d/I/cnGkE45wXmvAbg+YYU1aG67WpSexp43W1Il3vaOv/DpMlVHVdhvSJFvu2Z9MPBKnLehx3XpEurqA8DS8ge7BHPpt29GAEAAA==", "checkText"],
  [723, "gate-r17-sec--q6-gifwebp.ts:webp_unknown_chunk_deflate#46; gate-r17-sec--q6-gifwebp.ts:webp_unknown_chunk_deflate#47; gate-r17-sec--q6-gifwebp.ts:webp_unknown_chunk_deflate#48", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLzQqCQBRA4WfprgqGfkhaTLi4RpoRlKYVyCwmvYg1OlKmlvju4eYsPjgRjKJWjBNZSZ7lMqVZQ/dyfZdvWhksfCrHf7iIaN38cO9dFBoBGoiI9ZAtxt7Wd9zsZOzQLuVVaW/w8/x3DMLl8fAtvbPVKnuTIqJpToBBouNpngDroKJX/gYedVBL9SHgIOOcYv0qgYHKCgK+6AUDqZRuKAEeCQaFrmiYRC/+t7jJTrwAAAA=", "checkText"],
  [724, "gate-r17-sec--q6-gifwebp.ts:webp_vp8l_payload_deflate#49; gate-r17-sec--q6-gifwebp.ts:webp_vp8l_payload_deflate#50; gate-r17-sec--q6-gifwebp.ts:webp_vp8l_payload_deflate#51", "refusal", "quiet", "quiet", "H4sIAAAAAAAAAxXLQQuCMBQA4N/SOxWMIrAO6/S8WFlB4iIYO8ztUdLmRE0D8b+Hx+/wSVjIn1pa3Wleev2izUBFfSh0S/uIiY9LsveAiPEzE+f7w2GUxzj7kl93t9xEferi0zERIkXEFTCwway9BTZCR41vgcsReu2+BBy08WRCUwMDV1YEfDspBtq5MJAFLhWDKnQ0JzWpP9bQQw6cAAAA", "checkText"],
  [725, "gate-r17-sec--q6-gifwebp.ts:png_exif_for_contrast#52; gate-r17-sec--q6-gifwebp.ts:png_exif_for_contrast#53; gate-r17-sec--q6-gifwebp.ts:png_exif_for_contrast#54", "quiet", "quiet", "quiet", "H4sIAAAAAAAAAxXLMQqAMAwF0Lv8OQiuuUrJENoMQtpIrTqU3l18+0sAoUTeagFNDOv1AqeJR/02MDRXy9FPEPxoBt6XENQ9XivgJIQWw/4kSz6p4O9KTwAAAA==", "checkText"],
  [726, "gate-r17-sec--q6b-pngexif.ts:png_exif#1; gate-r17-sec--q6b-pngexif.ts:png_exif#2; gate-r17-sec--q6b-pngexif.ts:png_exif#3", "refusal", "refusal", "refusal", "H4sIAAAAAAAAAzWMy07DMBREv4W7osLqA6EKmdVNlBQFQR9ugtLIC9d2TMCOqzYllar+O7JaZjFzFjNTwV114vdKdII2Thg92rXmZSsOevpEmiKar/rx28x4RMQPln8luQmYBItiLEPWqWRZgJkrSva5yRjzGOO1l5UmufUF/uv9MT3J59vnKipeG1mOvhf9AmvEHLF+yNx6rK4XNl3/sOPSxfEACCgvh04BOUOn9+4AtDrDr7BHDRSEdFr6/Q4I2KbVQCcXTkBY63utgFacQOs7HUb8wv8A21fJmPsAAAA=", "checkText"],
  [727, "gate-r17-sec--q7-time.ts:many_urls_nl#1", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7uI5nHqYJvqylHwZy7mur9N5fyr3utumw3ECAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH8BkaKfu9XYR3rHUm/jPXLzjmcZHjVylG6s3Xy7RorhMtXIm0+bogzD/Kp95KZNMc1L/aX2034B7xVZom+hBwA=", "checkText"],
  [728, "gate-r17-sec--q7-time.ts:many_urls_nl#2", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7uI1ZOphmujLUvJlLOe6vk7n/anc626bDscJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8PcQKfq5W419pHcs9TbeIzfveJbhUSNH6cbazbdrpBguU428+bQpyjDMr9pHbtoU07zUX2o/7RdtVlovj0IPAA==", "checkText"],
  [729, "gate-r17-sec--q7-time.ts:many_urls_nl#3", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7uI1ZOphmujLUvJlLOe6vk7n/anc626bDscJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/C5Gin7vV2Ed6x1Jv4z1y845nGR41cpRurN18u0aK4TLVyJtPm6IMw/yqfeSmTTHNS/2l9tN+ATsV3qfPhB4A", "checkText"],
  [730, "gate-r17-sec--q7-time.ts:many_urls_nl#4", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwrCQBQAwLu8elEEsVgrzxFTrMkiQj6iUQvx7uI1ZOphmujLUvJlLOe6vk7n/anc626bDscJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/A5Gin7vV2Ed6x1Jv4z1y845nGR41cpRurN18u0aK4TLVyJtPm6IMw/yqfeSmTTHNS/2l9tN+AVdA+8xPCT0A", "checkText"],
  [731, "gate-r17-sec--q7-time.ts:one_url_many_lines#5", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXPEFGMyiJAf0exaSO4uXsATvOZ1r42hrCVfp3Kpu9t8OZ7Lo/4eUtM0zWkmSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZIkSZLkdyPFsPQ/0xDpFWu9T4/I7Sv+y/hXI0fpp9ov91ukGK9zjbzfuhRlHJdnHSK3XYp5WesndVv3BjHnpAMr1QEA", "checkText"],
  [732, "gate-r17-sec--q7-time.ts:one_url_many_lines#6", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXPEFGMyiJAf0exaSO4unsH2Na97bQxlLfk6lUvd3ebL8Vwe9feQmqZpTjNJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiT5jZFiWPqfaYj0irXep0fk9hX/ZfyrkaP0U+2X+y1SjNe5Rt5vXYoyjsuzDpHbLsW8rPWTuq17A1FoQLDrqQMA", "checkText"],
  [733, "gate-r17-sec--q7-time.ts:one_url_many_lines#7", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXPEFGMyiJAf0exaSO4unsLmNa97bQxlLfk6lUvd3ebL8Vwe9feQmqZpTjNJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJfstIMSz9zzREesVa79MjcvuK/zL+1chR+qn2y/0WKcbrXCPvty5FGcflWYfIbZdiXtb6Sd3WvQEBQJIea1MHAA==", "checkText"],
  [734, "gate-r17-sec--q7-time.ts:one_url_many_lines#8", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjlXPEFGMyiJAf0exaSO4unsPXvO61MZS15OtULnV3my/Hc3nU30NqmqY5zSRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkt9mpBiW/mcaIr1irffpEbl9xX8Z/2rkKP1U++V+ixTjda6R91uXoozj8qxD5LZLMS9r/aRu697OlW8Qa6YOAA==", "checkText"],
  [735, "gate-r17-sec--q7-time.ts:quoted_blank_lines#9", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjFa+RpJhNBhHyI5rdLcS7i4W3eLz6tdHFWLaSL3M51911OR9/yr1+H1LTNE23AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH6cuIsW4Dl/zGOkRW73N98jtI/7K9FsjRxnmOqy3a6SYLkuNvH/2Kco0rf91jNz2KZZ1q+/UP/sX8cL/Pa6cAAA=", "checkText"],
  [736, "gate-r17-sec--q7-time.ts:quoted_blank_lines#10", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjFa+RpJhNBhHyI5rdLcS7i7VXeLz6tdHFWLaSL3M51911OR9/yr1+H1LTNE23AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAp1MXkWJch695jPSIrd7me+T2EX9l+q2RowxzHdbbNVJMl6VG3j/7FGWa1v86Rm77FMu61Xfqn/0LvptX4+44AQA=", "checkText"],
  [737, "gate-r17-sec--q7-time.ts:quoted_blank_lines#11", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjFa+RpJhNBhHyI5rdLcS7izfwAI9Xvza6GMtW8mUu57q7LufjT7nX70NqmqbpFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAz5y6iBTjOnzNY6RHbPU23yO3j/gr02+NHGWY67DerpFiuiw18v7ZpyjTtP7XMXLbp1jWrb5T/+xf9nWMLm5xAgA=", "checkText"],
  [738, "gate-r17-sec--q7-time.ts:quoted_blank_lines#12", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bAiyBZjFa+RpJhNBhHyI5rdLcS7i3ewfLz6tdHFWLaSL3M51911OR9/yr1+H1LTNE23AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHzWqYtIMa7D1zxGesRWb/M9cvuIvzL91shRhrkO6+0aKabLUiPvn32KMk3rfx0jt32KZd3qO/XP/gW7GFHXbuIEAA==", "checkText"],
  [739, "gate-r17-sec--q7-time.ts:quoted_ff_lines#13", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO27CQBQAwLu8ehWEhFIslbmG7WJjbxCSPwgMKRB3j9LmDFNMOW10MZat5MtcznV3Xc7Hr3Kvn4fUNE3TLd03AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8d+oiUozr8DGPkV6x1dt8j9y+4lmmR40cZZjrsN6ukWK6LDXy/t2nKNO0/tQxctunWNat/qX+3f8CVwnjRe44AQA=", "checkText"],
  [740, "gate-r17-sec--q7-time.ts:quoted_ff_lines#14", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO27CQBQAwLu8ehWEhFIslbmG7WJjbxCSPwgMKRB3j3KDHGCKKaeNLsaylXyZy7nursv5+FXu9fOQmqZpuqX7BgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4j1MXkWJch495jPSKrd7me+T2Fc8yPWrkKMNch/V2jRTTZamR9+8+RZmm9aeOkds+xbJu9S/17/4XdKjzLW5xAgA=", "checkText"],
  [741, "gate-r17-sec--q7-time.ts:quoted_ff_lines#15", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO27CQBQAwLu8ehWEhFIslbmG7WJjbxCSPwgMKRB3j3KHlFNMOW10MZat5MtcznV3Xc7Hr3Kvn4fUNE3TLd03AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwH86dREpxnX4mMdIr9jqbb5Hbl/xLNOjRo4yzHVYb9dIMV2WGnn/7lOUaVp/6hi57VMs61b/Uv/ufwElb7DDbuIEAA==", "checkText"],
  [742, "gate-r17-sec--q7-time.ts:quoted_ff_lines#16", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO27CQBQAwLu8ehWEhFIslbmG7WJjbxCSPwgMKRB3j3KLFFNMOW10MZat5MtcznV3Xc7Hr3Kvn4fUNE3TLd03AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMB/duoiUozr8DGPkV6x1dt8j9y+4lmmR40cZZjrsN6ukWK6LDXy/t2nKNO0/tQxctunWNat/qX+3f8CxddZTG7ECQA=", "checkText"],
  [743, "gate-r17-sec--q7-time.ts:nonascii_tail#17", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPUoDQRgA0Lt89eAPSIqxs7GwECzSLFuMu8OysD8hWU0RcqCcw4uJhbd4vPo10Zet5HEuQ70/LMPzZznV3VMa9y/vH+eHt9dh/bkBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/IkW/dndzH+kSWz3Op8jNJb7L9FUjR+nm2q3HQ6SYxqVGfry2Kco0refaR27aFMu61b/UXttf/qMiHLCcAAA=", "checkText"],
  [744, "gate-r17-sec--q7-time.ts:nonascii_tail#18", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPUoDQRgA0Lt89eAPSIqxs7GwECzSLFuMu8OysD8hWU0RcqCcw4uJtVd4vPo10Zet5HEuQ70/LMPzZznV3VMa9y/vH+eHt9dh/bkBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMB/kaJfu7u5j3SJrR7nU+TmEt9l+qqRo3Rz7dbjIVJM41IjP17bFGWa1nPtIzdtimXd6l9qr+0v7x0TuvA4AQA=", "checkText"],
  [745, "gate-r17-sec--q7-time.ts:nonascii_tail#19", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPUoDQRgA0Lt89eAPSIqxs7GwECzSLFuMu8OysD8hWU0RcqCcw4uJN/AAj1e/JvqylTzOZaj3h2V4/iynuntK4/7l/eP88PY6rD83AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAID/iRT92t3NfaRLbPU4nyI3l/gu01eNHKWba7ceD5FiGpca+fHapijTtJ5rH7lpUyzrVv9Se21/Adwd27JwcQIA", "checkText"],
  [746, "gate-r17-sec--q7-time.ts:nonascii_tail#20", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPUoDQRgA0Lt89eAPSIqxs7GwECzSLFuMu8OysD8hWU0RcqCcw4uJd7B8vPo10Zet5HEuQ70/LMPzZznV3VMa9y/vH+eHt9dh/bkBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/K9I0a/d3dxHusRWj/MpcnOJ7zJ91chRurl26/EQKaZxqZEfr22KMk3rufaRmzbFsm71L7XX9hdRLsjocOIEAA==", "checkText"],
  [747, "gate-r17-sec--q7-time.ts:nonascii_tail_rep#21", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3OPUrEUBhA0a3IVz/8AbGInY2FhTCFTUjxTB4hkOQNM9EphlmQ63Bj4iosPNz6wmljyFtupiWP5Wa/jo/v+Vge7tP09vS6O92+PI/1++tvuyIkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT8n8JIMdT+ehkinWMrh+UYTXuOzzx/lGgi90vp62EfKeZpLdHcXboUeZ7rqQzRtF2KtW7ld+ou3Q+KbGCD334AAA==", "checkText"],
  [748, "gate-r17-sec--q7-time.ts:nonascii_tail_rep#22", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3OPUrEUBhA0a3IVz/8AbGInY2FhTCFTUjxTB4hkOQNM9EphlmQ63Bj4iq0ONz6wmljyFtupiWP5Wa/jo/v+Vge7tP09vS6O92+PI/1++tvuyIkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT8P8JIMdT+ehkinWMrh+UYTXuOzzx/lGgi90vp62EfKeZpLdHcXboUeZ7rqQzRtF2KtW7ld+ou3Q/fV1epb/0AAA==", "checkText"],
  [749, "gate-r17-sec--q7-time.ts:nonascii_tail_rep#23", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3OPUrEUBhA0a3IVz/8AbGInY2FhTCFTUjxTB4hkOQNM9EphlmQ63Bj4ipEONz6wmljyFtupiWP5Wa/jo/v+Vge7tP09vS6O92+PI/1++tvuyIkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJPyPwkgx1P56GSKdYyuH5RhNe47PPH+UaCL3S+nrYR8p5mkt0dxduhR5nuupDNG0XYq1buV36i7dD/yBHriP+gEA", "checkText"],
  [750, "gate-r17-sec--q7-time.ts:nonascii_tail_rep#24", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3OPUrEUBhA0a3IVz/8AbGInY2FhTCFTUjxTB4hkOQNM9EphlmQ63BjIi7C5nDrC6eNIW+5mZY8lpv9Oj6+52N5uE/T29Pr7nT78jzW76//7YqQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQ8E8YKYbaXy9DpHNs5bAco2nP8ZnnjxJN5H4pfT3sI8U8rSWau0uXIs9zPZUhmrZLsdat/E7dpfsBM5Sxv8/0AwA=", "checkText"],
  [751, "gate-r17-sec--q7-time.ts:dash_tail#25", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bgiyBaz97AJKcZkkEB+RKMWkruLt9ji8erXRF/WkoepXOr+Ol/+zuVef49pOO0KAAAAAAAAAAAAAAAAAAAAAAAAAP9BpOiX7mfqI71jrbfpHrl5x7OMjxo5SjfVbrldI8U4zDXyYWtTlHFcXrWP3LQp5mWt39Ru7QdNCGwsh04AAA==", "checkText"],
  [752, "gate-r17-sec--q7-time.ts:dash_tail#26", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bgiyBaz97AJKcZkkEB+RKMWkruLxd7i8erXRF/WkoepXOr+Ol/+zuVef49pOO0KAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwL1L0S/cz9ZHesdbbdI/cvONZxkeNHKWbarfcrpFiHOYa+bC1Kco4Lq/aR27aFPOy1m9qt/YDlv62BaecAAA=", "checkText"],
  [753, "gate-r17-sec--q7-time.ts:dash_tail#27", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bgiyBaz97AJKcZkkEB+RKMWkruL9V7h8erXRF/WkoepXOr+Ol/+zuVef49pOO0KAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8Fyn6pfuZ+kjvWOttukdu3vEs46NGjtJNtVtu10gxDnONfNjaFGUcl1ftIzdtinlZ6ze1W/sB8woVR+c4AQA=", "checkText"],
  [754, "gate-r17-sec--q7-time.ts:dash_tail#28", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0Lt89bgiyBaz97AJKcZkkEB+RKMWkruLN9gDPF79mujLWvIwlUvdX+fL37nc6+8xDaddAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4n0jRL93P1Ed6x1pv0z1y845nGR81cpRuqt1yu0aKcZhr5MPWpijjuLxqH7lpU8zLWr+p3doPpNkHL2dxAgA=", "checkText"],
  [755, "gate-r17-sec--q7-time.ts:dash_tail_rep#29", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3MPYrCUBhA0a0MX/0cGRgsnvuwCSmeyUMC+RGNWoh7l1nDNBaHW9/TRF/WkoepnOr2PJ/2x3Ktu980HDblf32BwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWDwZ8KRol+676mP9Iy1XqZr5OYZ9zLeauQo3VS75XKOFOMw18g/rzZFGcflUfvITZtiXtb6N7Wv9g31WRQK1k0AAA==", "checkText"],
  [756, "gate-r17-sec--q7-time.ts:dash_tail_rep#30", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3MPYrCUBhA0a0MX/0cGRgsnvuwCSmeyUMC+RGNWoh7l9nBgO3h1vc00Ze15GEqp7o9z6f9sVzr7jcNh035rC8wGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8Fg8P/hSNEv3ffUR3rGWi/TNXLzjHsZbzVylG6q3XI5R4pxmGvkn1eboozj8qh95KZNMS9r/ZvaV/sGm3kWCwSbAAA=", "checkText"],
  [757, "gate-r17-sec--q7-time.ts:dash_tail_rep#31", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3MPYrCUBhA0a0MX/0cGRgsnvuwCSmeyUMC+RGNWoh7l1nDYHe49T1N9GUteZjKqW7P82l/LNe6+03DYVP+1xcYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBj8CThS9Ev3PfWRnrHWy3SN3DzjXsZbjRylm2q3XM6RYhzmGvnn1aYo47g8ah+5aVPMy1r/pvbVvgEazlkrYDUBAA==", "checkText"],
  [758, "gate-r17-sec--q7-time.ts:dash_tail_rep#32", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3MPYrCUBhA0a0MX/0cGRgsnvuwCSmeyUMC+RGNWoh7l1nDlB5ufU8TfVlLHqZyqtvzfNofy7XuftNw2JT/9QUGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBYDAYDAaDwWAwGAwGg8FgMBgMBoPBHw9Hin7pvqc+0jPWepmukZtn3Mt4q5GjdFPtlss5UozDXCP/vNoUZRyXR+0jN22KeVnr39S+2jcsgb9QcWoCAA==", "checkText"],
  [759, "gate-r17-sec--q7-time.ts:stray_quote_urls#33", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBQAwLu8xs2SYAguNpXOoahYS4sx6GNsOS6E7m5yh5RTD9PGYShrydepXOrnbb58n8ujnr5S0zTNz8wYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wx9t92iBTD0n9MQ6Qt1nqfHpHbLX7L+KyRo/RT7Zf7LVKM17lGPu5dijKOy6sOkdsuxbys9S91e/cG6Z2K1l1RAAA=", "checkText"],
  [760, "gate-r17-sec--q7-time.ts:stray_quote_urls#34", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBQAwLu8xs2SYAguNpXOoahYS4sx6GNsOS6E7m5yjMDUw7RxGMpa8nUql/p5my/f5/Kop6/UNE3zMzPGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4z9ZztEimHpP6Yh0hZrvU+PyO0Wv2V81shR+qn2y/0WKcbrXCMf9y5FGcflVYfIbZdiXtb6l7q9ewMNu7WMaaIAAA==", "checkText"],
  [761, "gate-r17-sec--q7-time.ts:stray_quote_urls#35", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBQAwLu8xs2SYAguNpXOoahYS4sx6GNsOS6E7m5yijRTD9PGYShrydepXOrnbb58n8ujnr5S0zTNz8wYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxv7HDpFiWPqPaYi0xVrv0yNyu8VvGZ81cpR+qv1yv0WK8TrXyMe9S1HGcXnVIXLbpZiXtf6lbu/epE7miWVEAQA=", "checkText"],
  [762, "gate-r17-sec--q7-time.ts:stray_quote_urls#36", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBQAwLu8xs2SYAguNpXOoahYS4sx6GNsOS6E7m5CrjH1MG0chrKWfJ3KpX7e5sv3uTzq6Ss1TdP8zIwxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGGGOMsX87RIph6T+mIdIWa71Pj8jtFr9lfNbIUfqp9sv9FinG61wjH/cuRRnH5VWHyG2XYl7W+pe6vXsDzBkpdXmIAgA=", "checkText"],
  [763, "gate-r17-sec--q7-time.ts:js_concat_lines#37", "quiet", "quiet", "refusal", "H4sIAAAAAAAAA+3LO2rDQBQAwKuI12ZJCIQU60rnkFRspMUY9DG24hTGdw8+hmHKKaaLPqayl3xayrF+nNfj4adc6/dXatu27aN569em6YOIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIjoVdXHIVJM2/i+TJHusdfLco3c3eNW5t8aOcq41HG7nCPFfFpr5M/HkKLM8/ZXp8jdkGLd9vpMw2P4B2XwA9D0YwAA", "checkText"],
  [764, "gate-r17-sec--q7-time.ts:js_concat_lines#38", "quiet", "quiet", "refusal", "H4sIAAAAAAAAA+3LO2rDQBQAwKuI12ZJCIQU60rnkFRspMUY9DG24hTGdw8+hLspp5gu+pjKXvJpKcf6cV6Ph59yrd9fqW3bto/mrV+bpg8iIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiInqt+jhEimkb35cp0j32elmukbt73Mr8WyNHGZc6bpdzpJhPa438+RhSlHne/uoUuRtSrNten2l4DP9AZfkyYMcAAA==", "checkText"],
  [765, "gate-r17-sec--q7-time.ts:js_concat_lines#39", "quiet", "quiet", "refusal", "H4sIAAAAAAAAA+3LO2rDQBQAwKuI12ZJCIQU60rnkFRspMUY9DG24hTGdw8+hmHKKaaLPqayl3xayrF+nNfj4adc6/dXatu27aN569em6YOIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI6JXUxyFSTNv4vkyR7rHXy3KN3N3jVubfGjnKuNRxu5wjxXxaa+TPx5CizPP2V6fI3ZBi3fb6TMNj+Ad26hivOI4BAA==", "checkText"],
  [766, "gate-r17-sec--q7-time.ts:js_concat_lines#40", "quiet", "quiet", "refusal", "H4sIAAAAAAAAA+3LO2rDQBQAwKuI12ZJCIQU60rnkFRspMUY9DG24hTGdw8+hLspp5gu+pjKXvJpKcf6cV6Ph59yrd9fqW3bto/mrV+bpg8iIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIieoX6OESKaRvflynSPfZ6Wa6Ru3vcyvxbI0cZlzpul3OkmE9rjfz5GFKUed7+6hS5G1Ks216faXgM/6wU0IX2GwMA", "checkText"],
  [767, "gate-r17-sec--q7-time.ts:closers#41", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0b18s8LDIhQHr6OsI83gNXmIkB/RWAvBvYu7cHDO4M5uG0NZSz5N5Vg/z/Px+7dc6+ErNU3T/MyvfgAAAAAAAAAAAAAAAAAAAAAAAADwFv4jxbD0u2mItMVaL9M1crvFXxlvNXKUfqr9cjlHivE018j7R5eijONyr0PktksxL2t9Td2jewLrMC1hkE4AAA==", "checkText"],
  [768, "gate-r17-sec--q7-time.ts:closers#42", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0b18s8LDIhQHr6OsI83gNXmIkB/RWAvBvYsTV3HO4M5uG0NZSz5N5Vg/z/Px+7dc6+ErNU3T/MyvfgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG//kWJY+t00RNpirZfpGrnd4q+Mtxo5Sj/VfrmcI8V4mmvk/aNLUcZxudchctulmJe1vqbu0T0BI2Lyo7CcAAA=", "checkText"],
  [769, "gate-r17-sec--q7-time.ts:closers#43", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0b18s8LDIhQHr6OsI83gNXmIkB/RWAvBvYtzl3DO4M5uG0NZSz5N5Vg/z/Px+7dc6+ErNU3T/MyvfgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwBv/kWJY+t00RNpirZfpGrnd4q+Mtxo5Sj/VfrmcI8V4mmvk/aNLUcZxudchctulmJe1vqbu0T0BknlpOPA4AQA=", "checkText"],
  [770, "gate-r17-sec--q7-time.ts:closers#44", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0b18s8LDIhQHr6OsI83gNXmIkB/RWAvBvYs7cAHnDO7stjGUteTTVI718zwfv3/LtR6+UtM0zc/86gcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwJv+I8Ww9LtpiLTFWi/TNXK7xV8ZbzVylH6q/XI5R4rxNNfI+0eXoozjcq9D5LZLMS9rfU3do3sC5iJxfXBxAgA=", "checkText"],
  [771, "gate-r17-sec--q7-time.ts:closers_sp#45", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0a2Ub1Z4tAji4HWUdaQZPJOHCPkRja0g7l3chYPDgTu7bQxlLfk4lUP9Ps2Hn3251N02NU3T/M6vfn4AAAAAAAAAAAAAAAAAAAAAAAAA8A5ukWJY+q9piHSPtZ6nS+T2Hn9lvNbIUfqp9sv5FCnG41wjbx5dijKOy38dIrddinlZ62vqHt0T9WuFr5BOAAA=", "checkText"],
  [772, "gate-r17-sec--q7-time.ts:closers_sp#46", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0a2Ub1Z4tAji4HWUdaQZPJOHCPkRja0g7l0cuIvDgTu7bQxlLfk4lUP9Ps2Hn3251N02NU3T/M6vfn4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABvt0gxLP3XNES6x1rP0yVye4+/Ml5r5Cj9VPvlfIoU43GukTePLkUZx+W/DpHbLsW8rPU1dY/uCfhw+5SwnAAA", "checkText"],
  [773, "gate-r17-sec--q7-time.ts:closers_sp#47", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0a2Ub1Z4tAji4HWUdaQZPJOHCPkRja0g7l0cu4XDgTu7bQxlLfk4lUP9Ps2Hn3251N02NU3T/M6vfn4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMC7W6QYlv5rGiLdY63n6RK5vcdfGa81cpR+qv1yPkWK8TjXyJtHl6KM4/Jfh8htl2Je1vqaukf3BEIDFtrwOAEA", "checkText"],
  [774, "gate-r17-sec--q7-time.ts:closers_sp#48", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCUBhA0a2Ub1Z4tAji4HWUdaQZPJOHCPkRja0g7l3cgQs4HLiz28ZQ1pKPUznU79N8+NmXS91tU9M0ze/86ucHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMB7bpFiWPqvaYh0j7Wep0vk9h5/ZbzWyFH6qfbL+RQpxuNcI28eXYoyjst/HSK3XYp5Wetr6h7dE+Hg1HBwcQIA", "checkText"],
  [775, "gate-r17-sec--q7-time.ts:ops_lead#49", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0KssX7uDsiAWY5VzxBRjMoiQH9HsbiHeXbyFxePVr42hrCVfpnKu2+t8PpzKve53qWma5jh/fwEAAAAAAAAAAAAAAAAAAAAAAADwCSLFsPSbaYj0iLXepnvk9hF/ZfytkaP0U+2X2zVSjJe5Rv55dinKOC7/dYjcdinmZa3v1D27FyXxXISLTgAA", "checkText"],
  [776, "gate-r17-sec--q7-time.ts:ops_lead#50", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0KssX7uDsiAWY5VzxBRjMoiQH9HsbiHeXSy8xePVr42hrCVfpnKu2+t8PpzKve53qWma5jh/fwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+RYlj6zTREesRab9M9cvuIvzL+1shR+qn2y+0aKcbLXCP/PLsUZRyX/zpEbrsU87LWd+qe3QtX2PN/q5wAAA==", "checkText"],
  [777, "gate-r17-sec--q7-time.ts:ops_lead#51", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0KssX7uDsiAWY5VzxBRjMoiQH9HsbiHeXay9wuPVr42hrCVfpnKu2+t8PpzKve53qWma5jh/fwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwKdIMSz9ZhoiPWKtt+keuX3EXxl/a+Qo/VT75XaNFONlrpF/nl2KMo7Lfx0it12KeVnrO3XP7gXnMv7x6zgBAA==", "checkText"],
  [778, "gate-r17-sec--q7-time.ts:ops_lead#52", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPYrCQBgA0KssX7uDsiAWY5VzxBRjMoiQH9HsbiHeXbyBB3i8+rUxlLXky1TOdXudz4dTudf9LjVN0xzn7y8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgM9EimHpN9MQ6RFrvU33yO0j/sr4WyNH6afaL7drpBgvc4388+xSlHFc/usQue1SzMta36l7di9nSyApa3ECAA==", "checkText"],
  [779, "gate-r17-sec--q7-time.ts:amp_space#53", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3cPWoCURhA0a3IV1g9EoRg8VLNOiaDvMw8RJgf0dEU4t6Du7A4p79buG0MZS35NJVj/TzPx+/fcq37r9Q0TbPZbgAAAAAAAAAAAAAAAAAAAAAAAAB4C4ef+TWKixTD0n9MQ6RHrPUyXSO3j7iX8VYjR+mn2i+Xc6QYT3ONvHt2Kco4Ln91iNx2KeZlra+oe3b/fzM9uZJOAAA=", "checkText"],
  [780, "gate-r17-sec--q7-time.ts:amp_space#54", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPWoCQRgA0KvIV6QaIoGQYlLNOdZFJruDCPsjuomFePeQJqd4r39djHWr+TzXU9tfltPnV721j/dUSim7lx0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPDveFhKKSVSjOvwOo+RHrG163yL3D3ip07fLXLUYW7Der1Eium8tMhvzz5Fnab13sbIXZ9iWbf2l/pn/wu3CADgspwAAA==", "checkText"],
  [781, "gate-r17-sec--q7-time.ts:amp_space#55", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LPWoCQRgA0KvIV6QaIoGQYlLNOdZFJruDCPsjuomFePeQPkd4r39djHWr+TzXU9tfltPnV721j/dUSim7lx0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPzjeFhKKSVSjOvwOo+RHrG163yL3D3ip07fLXLUYW7Der1Eium8tMhvzz5Fnab13sbIXZ9iWbf2l/pn/wvdsuKy8jgBAA==", "checkText"],
  [782, "gate-r17-sec--q7-time.ts:amp_space#56", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LTWrCQBgA0KvIt+hqqBRKF9PVnCMGmSaDCPkRTetCvHvpDXqA9/avi7FuNZ/nemr7y3L6/Kq39vGeSill97IDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPin42EppZRIMa7D6zxGesTWrvMtcveInzp9t8hRh7kN6/USKabz0iK/PfsUdZrWexsjd32KZd3aX+qf/S+zDqpkcnECAA==", "checkText"],
  [783, "gate-r17-sec--q7-time.ts:long_piece_fail#57", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3PS4rCQBhF4a3IPy4UQXpQju46YgbVSSFCUhFNP0Dcu7iMK+fMz+DrYixryZe5nOvu2s7H73KvX4ckSaemD2nzf2o4cbqFUzgNwymchuEUTsNwCqdhOIXTMJzCaRhO4TQMp3AahlM4DcMpnIbhFE7DcAqnYTiF0zCcwmkYTuE0DKdwGoZTOA3DKZyG4RROw3AKp2E4hdMwnMJpGE7hNAyncBqGUzgNwymchuEUTsNw6uOckWJchu08RnrEWm/zPXL3iN8y/dTIUYa5DsvtGimmS6uR988+RZmm5a+Okbs+RVvW+p76Z/8CladQISdPAAA=", "checkText"],
  [784, "gate-r17-sec--q7-time.ts:long_piece_fail#58", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3PS2oCURgG0a2Ef9wkBEIGnVGtQx107IsI/RA1DxD3HrKMT6rmNTibGofr0B/n4dBeTsvh43O4tPe3DmC78CA9/W4XnTrT0onOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD04nOwHSiMzCd6AxMJzoD08nDOaurcd0/z2N1t7q283ypfnOr72H6atXXsJ/bfj2fqqvpuLTqX++7roZpWn/aWP1m19WyXtv/tLvv/gC0N6QJ/50AAA==", "checkText"],
  [785, "gate-r17-sec--q7-time.ts:long_piece_fail#59", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3PTWqUCQBF0a3INy4UQXpQju46YgbVSSFCUhFN/4C4d3EZT86d38G5Ox4vr5fzl+fL5+u7r7fPH/++fL/+9eFU9enWH9Kb/z/dODnX4oxzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH4+yPcx6n4/Hl4e3z43H6cbxevz1/P853P45/L0//XI/zcXl4vj68fPt6nI6nL7frcX7/8/50XJ6eXv67Ph7nu/vTcXt5vf6e7n/e/wI46aq0rzsBAA==", "checkText"],
  [786, "gate-r17-sec--q7-time.ts:long_piece_fail#60", "quiet", "refusal", "quiet", "H4sIAAAAAAAAA+3PTWqUCQBF0a3INy4UQXpQju46YgbVSSFCUhFN/4C4d3EZT86d38G5Ox4vr5fzl+fL5+u7r7fPH/++fL/+9eFU9enWH9Kb/z/dODnX4oxzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+OMczDOOAfjjHMwzjgH44xzMM44B+Psj3Mep+Px5eHt8+Nx+nG8Xr89fz/Odz+Ofy9P/1yP83F5eL4+vHz7epyOpy+363F+//P+dFyenl7+uz4e57v703F7eb3+nu5/3v8CSLjjqg93AgA=", "checkText"],
  [787, "gate-r17-sec--q7-time.ts:srcset_like#61", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LOwqDQBhF4a3IrYcEIaSYPMB1qMVEf0RwNDjmAeLeg7tIcZpTfafUtY9dluYm2XKr1IYl+D6Gzo7Psbs8QrLzyRVFUVTj3iz/ugwEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAgEAgEAoFAIBAIBAKBQCAQCAQCgUAg0N+hSnc5tVNziK3cqsXmmOTLVe8wvExeoYnWTPNTTkM/mny+1U5hGKaPtfJl7TROi+1TvdU/QTm8iaRIAAA=", "checkText"],
  [788, "gate-r17-sec--q7-time.ts:srcset_like#62", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBRA0a2YVw8JhpBC+YDWYamYSIMQ6GMsOQkY7z14DylPc6tzT/E+zsNhu3Rb2T+a6POeq3HOQ3k+L8PbV97K60uq67pulkcPx990gCAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiDoX1ATn5GiX7unuY90i71c5i2q0y2+83QtUUXu5tKtl3OkmMalRHW8tynyNK0/pY/q1KZY1r08pvbe/gHY/wUe6JAAAA==", "checkText"],
  [789, "gate-r17-sec--q7-time.ts:srcset_like#63", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBRA0a2YVw8JhpBC+YDWYamYSIMQ6GMsOQkY7z14GYHT3OrcU7yP83DYLt1W9o8m+rznapzzUJ7Py/D2lbfy+pLquq6b5dHD8TcdIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIAiCIOifoSY+I0W/dk9zH+kWe7nMW1SnW3zn6VqiitzNpVsv50gxjUuJ6nhvU+RpWn9KH9WpTbGse3lM7b39A+I8egNwIQEA", "checkText"],
  [790, "gate-r17-sec--q7-time.ts:srcset_like#64", "quiet", "quiet", "quiet", "H4sIAAAAAAAAA+3LO2rDQBRA0a2YVw8JhpBC+YDWYamYSIMQ6GMsOQkY7z14FWlOc6tzT/E+zsNhu3Rb2T+a6POeq3HOQ3k+L8PbV97K60uq67pulkcPx990gCAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgiAIgv4dNfEZKfq1e5r7SLfYy2Xeojrd4jtP1xJV5G4u3Xo5R4ppXEpUx3ubIk/T+lP6qE5timXdy2Nq7+0f1wm74YBCAgA=", "checkText"],
];

for (const [id, source, r15, r16, expected, packed, method] of round18Corpus)
  test(`round 18 corpus C${id}: ${source}`, () => {
    const args = JSON.parse(zlib.gunzipSync(Buffer.from(packed, "base64")).toString("utf8"));
    for (const scanTerms of [248, 249, 250, 251].includes(id) ? [empty, round16Terms] : [args[2]]) {
      const hits: string[] = method === "checkBuffer" ?
        checkBuffer(Buffer.from(args[0].buffer, "base64"), args[1], scanTerms, args[3]) :
        checkText(args[0], args[1], scanTerms, args[3]);
      const outcome = [...new Set(hits.map((hit) => hit.includes("private term") ? "private" :
        hit.includes("secret shape") ? "secret" : "refusal"))].sort().join("+") || "quiet";
      assert.equal(outcome, expected, `r15=${r15}, r16=${r16}; ${hits.join("; ")}`);
      // These PNGs contain 3 MiB of non-bulk tEXt, which must now be scanned strictly.
      if (id === 348 || id === 349) assert.deepEqual(hits, ["doc.md: scan expansion budget exceeded"]);
      for (const label of ["private", "secret"])
        if (r15.includes(label) || r16.includes(label)) assert.ok(outcome.includes(label), `lost earlier ${label}`);
    }
  });

// Round 19 witnesses extend the differential corpus with readable, synthetic inputs.
const round19Gzip = zlib.gzipSync(Buffer.from("owner details ".repeat(40))).toString("base64");
const round19Prefix = ["data", "text/plain;base64,"].join(":");
const round19Closed = `"${round19Prefix}cHVibGljIGZpeHR1c\nmUgZG9j"`;
const round19Longest = `<img srcset="${["data", "image/png;base64,"].join(":")}${Buffer.from("public   ").toString("base64")} ${Buffer.from(home("fixture-person")).toString("base64")}">`;
const round19R3 = `${round19Prefix}${Buffer.from("~~~acmecorp").toString("base64url")}`;
const round19Witnesses: readonly (readonly [string, string, string])[] = [
  ...[8, 12, 15].map((width): [string, string, string] => [
    `MS1 gzip width ${width}`, `"${["data", "application/gzip;base64,"].join(":")}${round19Gzip.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n")}"`, "refusal",
  ]),
  ["CX1 continuation space", `"${round19Prefix}cHVibGlj\nIGFj bWVjb3Jw"`, "private"],
  ["CX1 continuation tab", `"${round19Prefix}cHVibGlj\nIGFj\tbWVjb3Jw"`, "private"],
  ["CX1 first-line space", `"${round19Prefix}cHVi bGlj\nIGFjbWVjb3Jw"`, "private"],
  ["CX2 prose after quote", `${round19Closed}\nNext paragraph`, "quiet"],
  ["CX2 same-line prose", `${round19Closed} and more\nNext paragraph`, "quiet"],
  ["CX2 encoded string after quote", `${round19Closed}\n"YWNtZWNvcnA="`, "private"],
  ["ER1 srcset space", `<img srcset="${round19Prefix}YWNt ZWNvcnA= 1x">`, "private"],
  ["ER1 srcset tab", `<img srcset="${round19Prefix}YWNt\tZWNvcnA=">`, "private"],
  ["ER1 quoted punctuation", `<img src="${round19Prefix}YWNt!ZWNvcnA=">`, "private"],
  ["ER2 longest complete reading", round19Longest, "refusal"],
  ["ER2 base64url-only reading", round19R3, "private"],
  ["MS2 15-character split binary", `<img src="${["data", "application/octet-stream;base64,"].join(":")}${"A".repeat(8)}\n ${"A".repeat(7)}">`, "quiet"],
];
for (const [index, [name, body, expected]] of round19Witnesses.entries())
  test(`round 19 corpus N${index}: ${name}`, () => {
    for (const scanTerms of name.startsWith("MS") ? [empty, round16Terms] : [round16Terms]) {
      const hits = checkText(body, "fixture.md", scanTerms);
      const outcome = [...new Set(hits.map((hit) => hit.includes("private term") ? "private" :
        hit.includes("secret shape") ? "secret" : "refusal"))].sort().join("+") || "quiet";
      assert.equal(outcome, expected, hits.join("; "));
      if (name.startsWith("MS1")) assert.ok(hits.some((hit) => hit.includes("binary file of unknown type")));
      if (name.startsWith("ER2 longest")) assert.ok(hits.some((hit) => hit.includes("home path")));
    }
  });

test("round 19 CX1: multiline R4 has linear work and retains the last whitespace-split term", () => {
  let previous = 0;
  for (const length of [512, 1024, 2048]) {
    const encoded = Buffer.from(`${"public ".repeat(length)}acmecorp`).toString("base64");
    const body = `"${round19Prefix}${encoded.slice(0, 8)}\n${encoded.slice(8).match(/.{1,4}/g)!.join(" \t")}"`;
    const budget = new ScanBudget();
    assert.ok(checkText(body, "fixture.md", round16Terms, { budget }).some((hit) => hit.includes("private term")));
    assert.ok(budget.inlineTerminatorWork <= 14 * body.length);
    if (previous) assert.ok(budget.inlineTerminatorWork <= 2.1 * previous);
    previous = budget.inlineTerminatorWork;
  }
});

const round20BinaryPrefix = ["data", "application/octet-stream;base64,"].join(":");
const round20Template = `\`${round19Prefix}cHVibGlj\nIEFLSUFB\``;
const round20TokenTail = '"QUFBQUFBQUFBQUFBQUFB"';
function round20WrappedPng(value: string): string {
  for (let padding = 0; padding < 3; padding++) {
    const bytes = png(
      pngChunk("tEXt", Buffer.from(`Comment\0${"public ".repeat(32)}${" ".repeat(padding)}`)),
      pngChunk("zTXt", Buffer.concat([Buffer.from("Owner\0\0"), deflateSync(value)])),
    );
    // No '=' terminator: the closing quote must stop the join before any bare-text suffix.
    if (bytes.length % 3 === 0)
      return `"${["data", "image/png;base64,"].join(":")}${bytes.toString("base64").match(/.{1,132}/g)!.join("\n")}"`;
  }
  throw new Error("fixture alignment");
}
const round20CleanPng = round20WrappedPng("public fixture");
const round20TermPng = round20WrappedPng("acmecorp");
// name, body, exact outcome categories, run with both empty and synthetic term lists
const round20Witnesses: readonly (readonly [string, string, string, boolean])[] = [
  ["CX1 trailing operator", `${round20Template} +\n${round20TokenTail}`, "secret", false],
  ["CX1 leading operator", `${round20Template}\n+ ${round20TokenTail}`, "secret", false],
  ["CX1 adjacent literal", `${round20Template}\n${round20TokenTail}`, "secret", false],
  ["CX2 JSON sibling", `{\n  "sample": "${round20BinaryPrefix}AAECAwQF",\n  "settings": {}\n}`, "quiet", true],
  ...[15, 16, 17].map((length): [string, string, string, boolean] => [
    `CX3 split ${length}`, `<img src="${round20BinaryPrefix}${"A".repeat(8)}\n ${"A".repeat(length - 8)}">`, length >= 16 ? "refusal" : "quiet", true,
  ]),
  ["handoff invalid padding", `"${round20BinaryPrefix}${"A".repeat(8)}\n${"A".repeat(13)}==="`, "refusal", true],
  ["handoff non-alphabet suffix", `"${round20BinaryPrefix}${"A".repeat(8)}\n${"A".repeat(8)}!"`, "refusal", true],
  ["ER1 clean PNG before prose", `${round20CleanPng}\nNext paragraph`, "quiet", false],
  ["ER1 PNG term before prose", `${round20TermPng}\nNext paragraph`, "private", false],
  ["ER1 bare encoded text after PNG", `${round20CleanPng}\nYWNtZWNvcnA=`, "private", false],
  ["ER1 different closing quote", `\`${round19Prefix}cHVibGlj\nIGZp\` +\n"eHR1cmUg"\nYWNtZWNvcnA=`, "private", false],
  ["ER-open apostrophe prefix", `The '${["data", "image/png;base64,"].join(":")}iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ\nstring is a prefix, people say it's fine.\nMore text here across lines and more words ' done\n`, "quiet", false],
];
for (const [index, [name, body, expected, bothTerms]] of round20Witnesses.entries())
  test(`round 20 corpus P${index}: ${name}`, () => {
    for (const scanTerms of bothTerms ? [empty, round16Terms] : [round16Terms]) {
      const hits = checkText(body, "fixture.md", scanTerms);
      const outcome = [...new Set(hits.map((hit) => hit.includes("private term") ? "private" :
        hit.includes("secret shape") ? "secret" : "refusal"))].sort().join("+") || "quiet";
      assert.equal(outcome, expected, `${scanTerms.terms.length} terms: ${hits.join("; ")}`);
      if (name === "CX3 split 16") assert.ok(hits.some((hit) => hit.includes("binary file of unknown type")));
    }
  });

const round21SecretTail = "IEFLSUFBQUFBQUFBQUFBQUFBQUFB";
const round21BoundarySecret = Buffer.from(`  ${["em", "_", "A".repeat(43)].join("")}`).toString("base64");
const round21Large = Buffer.from("public fixture ".repeat(300000)).toString("base64");
const round21Witnesses: readonly (readonly [string, string, string, boolean])[] = [
  ...['"', "'"].map((quote): [string, string, string, boolean] => [
    `ER-F1 unquoted ${quote}`, `see ${round19Prefix}cHVibGlj${quote}\n${round21SecretTail}\n`, "secret", false,
  ]),
  ["ER-F1 mismatched quote", `const a = "${round19Prefix}cHVibGlj'\n${round21SecretTail}\n`, "secret", false],
  ["MS3 bare secret after closing quote", `const a = "${round19Prefix}cHVibGlj"\n${round21SecretTail}\n`, "secret", false],
  ["ER-F2 strict binary across closing quote", `"${round20BinaryPrefix}AAECAwQF" +\n"BgcICQoL"`, "refusal", true],
  ["CX1 secret ends at piece boundary", `"${round19Prefix}${round21BoundarySecret.slice(0, 8)}\n+ ${round21BoundarySecret.slice(8)}\n"QUFB"`, "secret", false],
  ["CX1 secret straddles piece boundary", `"${round19Prefix}cHVibGlj\n${round21SecretTail.slice(0, 8)}\n${round21SecretTail.slice(8)}"`, "secret", false],
  ["CX2 equivalent wrapped readings", `const sample = \`${round19Prefix}${round21Large.match(/.{1,76}/g)!.join("\n")}\`;`, "quiet", true],
  ...[16000, 32000, 64000].map((length): [string, string, string, boolean] => [
    `CX3 padding ${length}`, `"${round20BinaryPrefix}AAAAAAAA\n${"=".repeat(length)}!"`, "quiet", true,
  ]),
  ["CX4 later different quote", `${round20Template} +\n"QUFBQUFB" +\n"QUFBQUFBQUFB"`, "secret", false],
];
for (const [index, [name, body, expected, bothTerms]] of round21Witnesses.entries())
  test(`round 21 corpus Q${index}: ${name}`, () => {
    for (const scanTerms of bothTerms ? [empty, round16Terms] : [round16Terms]) {
      const hits = checkText(body, "fixture.md", scanTerms);
      const outcome = [...new Set(hits.map((hit) => hit.includes("private term") ? "private" :
        hit.includes("secret shape") ? "secret" : "refusal"))].sort().join("+") || "quiet";
      assert.equal(outcome, expected, `${scanTerms.terms.length} terms: ${hits.join("; ")}`);
    }
  });

test("round 21 CX3: trailing-padding work scales linearly", (t) => {
  const timings: number[] = [];
  for (const length of [16000, 32000, 64000]) {
    const body = `"${round20BinaryPrefix}AAAAAAAA\n${"=".repeat(length)}!"`;
    checkText(body, "fixture.md", empty); // Warm the scanner before measuring.
    const samples: number[] = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      assert.deepEqual(checkText(body, "fixture.md", empty), []);
      samples.push(performance.now() - start);
    }
    timings.push(samples.sort((a, b) => a - b)[1]!);
  }
  t.diagnostic(`padding 16000/32000/64000: ${timings.map((ms) => ms.toFixed(2)).join(" / ")} ms (median of 3)`);
  assert.ok(timings[2]! <= timings[0]! * 8 + 100, "4x input must stay within a generous linear bound");
});

test("round 21.1: hit-only joins do no work without a quote stop and resume only its suffix", () => {
  let suffixWork: number | undefined;
  for (const n of [512, 1024, 2048]) {
    const body = Buffer.from("public ".repeat(3 * n)).toString("base64");
    for (const separator of ["\n+", '" +\n "']) {
      const text = `"${round19Prefix}${body.match(/.{1,3}/g)!.join(separator)}"`;
      const budget = new ScanBudget();
      assert.deepEqual(checkText(text, "fixture.md", empty, { budget }),
        separator === "\n+" ? ["fixture.md (inline image): binary file of unknown type"] : []);
      assert.equal(budget.inlineHitOnlyWork, 0, "R2 reached the end without stopping at its quote");
    }
    const text = `"${round19Prefix}${body.match(/.{1,60}/g)!.join("\n")}"\n${round21SecretTail}\n`;
    const budget = new ScanBudget();
    assert.ok(checkText(text, "fixture.md", empty, { budget }).some((hit) => hit.includes("secret shape")));
    assert.ok(budget.inlineHitOnlyWork > 0 && budget.inlineHitOnlyWork < 256,
      `only the suffix is scanned: ${budget.inlineHitOnlyWork}`);
    suffixWork ??= budget.inlineHitOnlyWork;
    assert.equal(budget.inlineHitOnlyWork, suffixWork, "a longer prefix must not add continuation work");
  }
});

// Round 22: exact synthetic review witnesses, stored without active URI or credential literals.
// probe, name, outcome without/with terms, gzip body, entry point, location
const round22Corpus: readonly (readonly [string, string, string, string, string, string, string])[] = [
  ["p1-damaged","md_eacute_at8","quiet","private","H4sIAAAAAAAC/x2MSw6CMABEz+JOowlgwBCNixZBPgG0WIwYFwWxfAJCIArcyHN4MamzmHmLl5lcu9v0TlqyTgtCY64q6SYkTbwSF6kPXfTmre9nT59gjOPhRMWUocoKKuDC9qFFnsnA0it81tEuXAptcJb4URFLu3kNfNPiPLGHXHCGVK6xShvsZW6vyBWksM5BFpGEO/X/b8FEqoZjs8vmNgdkKAN4BJATi+CAeCYAD/susiTlYhjb2Q/kOWJlwgAAAA==","checkText","doc.md"],
  ["p1-damaged","md_eacute_at12","quiet","private","H4sIAAAAAAAC/x2MSw6CMBRF1+JMownFoCEaB6+I8gmgrYWAcVAVyycqBKLCjlyHG1Oc3HMGJ7e3fx36Z17zWXrlIpaKm5gfeRVPlVHqY488kb0Wd/i8AcClLNGZ+Bno3WANwo6X1YlandhGwQKDLI9juY6CCfolys2pHi2qapYnTpvLbpuqJdNFxWjmNZpaYIHLHLITT6Rd8/+WLaKvWGy9sqEjgYpVwFvAknKNNgR1AVDme8SeaKFpLgZfbyNI5cIAAAA=","checkText","doc.md"],
  ["p1-damaged","md_eacute_at40","quiet","private","H4sIAAAAAAAC/x2MSw6CMABEz+JOowlgwBCNixZBPgG0WIwYFwWxfAJCIArcyHN4MamzmHmLl5lcu9v0TlqyTgtCY64q6SYkTbwSF6kPXfTmrT19gjGOhxMVU4YqK6iAC9vH96NFnsnQ0it81tEuXAptcJb4URJLu3kNfNPiPLGHXHCGVK6xShvsZW6vyBWksM5BFpGEO/X/d8FEqoZjs8vmNgdkKAN4BJATi+CAeCYAD/susiTlYhjb2Q/cHxdHwgAAAA==","checkText","doc.md"],
  ["p1-damaged","md_eacute_at100","quiet","private","H4sIAAAAAAAC/x2MSw6CMABEz+JOowlgwBCNixZBPgG0WIwYFwWxfAJCIArcyHN4MamzmHmLl5lcu9v0TlqyTgtCY64q6SYkTbwSF6kPXfTmrT19gjGOhxMVU4YqK6iAC9uHFnkmA0uv8FlHu3AptMFZ4kdFLO3mNfBNi/PEHnLBGVK5xiptsJe5vSJX3w+ksM5BFpGEO/X/d8FEqoZjs8vmNgdkKAN4BJATi+CAeCYAD/susiTlYhjb2Q9+R7TewgAAAA==","checkText","doc.md"],
  ["p1-damaged","md_ctl_at12","quiet","private","H4sIAAAAAAAC/x2MywqCQBhG6VHaFQVqaEjR4h/TvGDW2CQaLUaz8YJljJT69GWb75zF4Rtf2uvkRhu6yivKUqF+sHVMebqU5/kZefgjOjv2hBEA7H2S6YT9DPRhkAbhwLuR+PYgjlmTwMTbeCE1UaCIv0R+uPzdi7whZeb2pbTvc/VFdMaJX3idptaIoVcJRUIz4dT9vyUb6wZJ7baYuQKoSAV0BCTIVXTA4hCAT84edhQttKzN9As8VQobwQAAAA==","checkText","doc.md"],
  ["p1-damaged","md_bang_at12","quiet","private","H4sIAAAAAAAC/x2Myw6CMBQFv4WdRpOCQUM0Lm6xyiOIthaCxkVBLI+oGIgiX6+4OTOLyVFO7XlwEY2Y5zchU1Td5SIWdTrTx3mAffpW3Y18gAIAW8YzwuXPgPSDTYh6XtcJc3pxrYqHFl3FE605hlP1l+h3r351at3wMvO6Utt2ufHkRNacFf7HNCos8bOEIhEZOnz+35pDyZqnTluMPAQGNgDvASP9dtxRtQ+A8cCn7tSMbHs5/AL9Y56swQAAAA==","checkText","doc.md"],
  ["p1-damaged","md_star_at12","quiet","private","H4sIAAAAAAAC/x2MywqCQBhGn6VdN1BDQ4oW/5jmBbPGJtFoMZqNFyxjpNSnL9t85ywO3+jSXsc32tBVXlGWCvWDrWPK06U8z8/Iwx/R2bEnTAFg75NMJ+xnoA+DNAgH3o3EtwdxzJoEJt7GC6mJAkX8JfLD5e9e5A0pM7cvpX2fqy+iM078wus0tUYMvUooEpoJp+7/LdlYN0hqt8XMFUBFKqAjIEGuogMWhwB8cvawo2ihZW0mX1FVDurBAAAA","checkText","doc.md"],
  ["p1-damaged","md_tilde_at40","quiet","private","H4sIAAAAAAAC/x2MywqCQABFv6VdUaCGhhQtZkzzgVpjo2i0GM3GB5qiVLro23O6i3vP4nBn189tfic92eYVoSnX1HQXky7diKvchy5689aRPsEUx8OZiilDlRVUQMj28dUSz2Rk6Q0OdHSI10IfBRI/OWJtd6+R73pcZvZYCs6Yyy1WaYe9wh0UuYEUtiUoEpJxl+F/LphI1XBqfoqlzQEZygCeAeTEKjohngnAw76LLEkJDWO/+AEYdE8vwQAAAA==","checkText","doc.md"],
  ["p1-damaged","bare_eacute_at12","quiet","private","H4sIAAAAAAAC/x2MSw6CMBRFF6QJYMAQjYNXBPkE0GIhMCuI5RMQAlFhR67DjUmd3HMGJ/dGR7orG8pyoWvZPqVDvpXXZYh8/BKdE3vA9wMAXkAKnbDFQOeDNIg570YW2FwcsyORiY/pRhqTSBGXRG7d4TmLw0jqwp1ryZtLtSc6G0hQ+ZOmdoihvoYqo4Vwnf7fko11g+T2u1q5AqhIBXQBJMhNcsYiDyAgoY8dRYst6/ADeRTk4rwAAAA=","checkText","doc.md"],
  ["p1-damaged","html_unq_eacute_at12","quiet","private","H4sIAAAAAAAC/x2MSQ6CMBhGr+JeE8CAaZySv1gHCKLFSmBXEcsQECxx4Eaew4spbr73Fi/fNC1ET96i2Zk3fJwWXMRKVYrJict4pA/SI3bpQ7VX4gqfNwBsPZYQJn4GpBtsQtDxsow8qxN7XTF/TRenodaEvqH+Er105L1VZcPyxGlzbdumqGZESOZl7stEFRa4ziGLeKIcXv9vzaJkyWLrmfUdBRBGgPeAFb0Id1TtAvDY0aW2YQabzWz+BaaxLlzGAAAA","checkText","doc.md"],
  ["p1-damaged","q_eacute_at12","quiet","private","H4sIAAAAAAAC/x2MSw6CMBRFt2KcagIYMETF5BXxA0G0WAzMCmL5BERL/LAj1+HGtE7uOYOTO8sr1uO3xOifaEsneUVZKjU1m8aUp2N1mAfIww/ZWbELfN4AsPVJZhH2M7DEIBNCwfMy8W0hzrohxzVexCOljY6a/EvU2uX3TuYtKTO3K5Vtl+tXYjFO/MJ7mXqDGLqWUCQ0kw6v/7diY2tJUvtZDFwJdKQD2gOS1CraYVkE4JPAw45mhpuN0Z9/AaN2bsnIAAAA","checkText","doc.md"],
  ["p1-damaged","ls2028_bare","quiet","private","H4sIAAAAAAAC/x2MSw6CMABED6QJxYAhGhctFvkE0GIhsCuI5RMQAvHDyuN4Lk8idRYzb/EyFzayTdkwnktdy7cpG/K1sixD5JMHcA78Bud4AS0w5QKxKKTDWOzVyAJbgGN2NDLJPl3JYxKpYFaU1h3uExjG7/tD68KdatmbSq2nmA80qPyXrnWIo76GVcYK6fz638s2wQbN7We1cCWoIQ2iE0SS0iRHAoQA57uAhj5xVD22rN0PfH8jrcAAAAA=","checkText","doc.md"],
  ["p1-damaged","ps2029_bare","quiet","private","H4sIAAAAAAAC/x2MSw6CMABED6QJxYAhGhctFvkE0GIhsCuI5RMQAvHDyut4LU8idRYzb/EyFzayTdkwnktdy7cpG/K1sixD5JMHcA78Bud4AS0w5QKxKKTDWOzVyAJbgGN2NDLJPl3JYxKpYFaU1h3uExjG7/tD68KdatmbSq2nmA80qPyXrnWIo76GVcYK6fz638s2wQbN7We1cCWoIQ2iE0SS0iRHAoQA57uAhj5xVD22rN0PyIWvYMAAAAA=","checkText","doc.md"],
  ["p1-damaged","nel_bare","quiet","private","H4sIAAAAAAAC/x2MSw6CMABED6RJwYAhGhctgnwCaLEQ2BXE8gkIgaiw52KcTOosZt7iZR50oIeipiwDbcOOCe2zvbQtAuThj2Bf2AuucX2Sa4Rx1HghFUZ8n3rqWxxsoyWhgc/JThziUBZWRWqc/j0J/bDMpMqdqRLdqVA6orGe+KU3qkqLGOoqWKY0B/fx/y5aWNNJZn3LjQOgghSIbhABqY6vWOACXGafBB62ZTUyzdMPiVrjVr4AAAA=","checkText","doc.md"],
  ["p1-damaged","ls2028_md","quiet","private","H4sIAAAAAAAC/1OMrojVSEksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/PdwQCv+DQDNfQdBDTFUQ4OTtGgug0t+RgLxDD26MgNNwjyCXJyLAkKtzUAKjEJM+3uKzKoLjkUcOK0OwM36psQ7+qTIvCUNf04tDgLP9KZ4sCp3SnwmzHrOTEDP2QSrDxhl5Brm6hqV4VWdq++o4WThaOToGOTvomuVEBQQYgBY5A44JDw/yDvE2dIz09bTUBj2uNusYAAAA=","checkText","doc.md"],
  ["p1-damaged","ls2028_q","quiet","private","H4sIAAAAAAAC/x2MSw6CMABEr2LcalIwYIiKSYv4gQBaLEZ3BbF8AoIlflh5HM/lSaTOYuYtXmaWFqzHb5HeP9OGTtKCshhUJZuGlMdjZZgGyMMPyV6xK+zi+iQxCRNoikIGPIq9LCPfEmCvK3JY40U4kpvTQZU6RSkdfm8l3nzfH5InTpvLbptqNTEZJ37mvQytQgzVOcwimoD9638vW9hckth6ZgMHQA1pEO0gAkpx2mJJCLC780ngYVs1jpuN3p//ALtDm/zMAAAA","checkText","doc.md"],
  ["p1-damaged","nbsp_md","quiet","private","H4sIAAAAAAAC/x2MSw6CMABEz+JOo0nBgGk0LloE+QTRYiFqXFTF8gmIgahwGs7CybTOYuYtXmZw+pyHN1azeZIzHoGy4IsLq6KZMkkC7JG35Kz5A/2y8WmsUy5QF4U1dBB7N66+LcAxSxqaZHWZyvUxVKWfohRu9Wqlqu47msVum8mbNoFPqvOK+qnXaLDEHD8zlF5ZDPbN/122iW7QyP6kYxcgiCHCO4SBkh+3RBIC6jufBh5xVO1gWcvRF0WND2jEAAAA","checkText","doc.md"],
  ["p1-damaged","zwsp_md","quiet","private","H4sIAAAAAAAC/1OMrojVSEksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/PdwQCv+DQDNfQdBDTFUQ4OTtGgug0t+RgLxDD26MgNNwjyCXJyLAkKtzUAKjEJM+3uKzKoLjkUUN3aHaGb1W2oV9VpkVhqGt6cWhwln+ls0WBU7pTYbZjVnJihn5IJdh4Q68gV7fQVK+KLG1ffUcLJwtHp0BHJ32T3KiAIAOQAkegccGhYf5B3qbOkZ6etpoACXy3wMYAAAA=","checkText","doc.md"],
  ["p1-damaged","text_md_eacute_at12","quiet","private","H4sIAAAAAAAC/xXLTQqCQBwF8LO0KwrU1LCixX/8VlIbmRGNFk6ZKZhBhtaNOkcXy9m891u8NzkOp+kl7/JN1eRlITzu5Zblz2KlLCqKQtyLvl228PsCQBCTm0nKUWDyQDqkvK/WOfY4HBlbiYMNtpS6LFFFsNcya+jbta2aJbRmstePFl0naJmMP6+IGW3Pn5KHTYsU3lDP9wJoSAN0ACQoTRZhkQ8gJjTEvqqnrrub/QEwEzCYtgAAAA==","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz","quiet","quiet","H4sIAAAAAAAC/0tJLEm0SiwoyMlMTizJzM/TT6/KLLBOSixONTPR4fIwKfZ0hAGL4rIqg+KS0OwM36psQ7+qTIvCUNf04tDgLP9KZ4sC03RPR3dPswD/oHSQag+n8mQUzIUuQCK2BQCk6HDEqwAAAA==","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_clean","quiet","quiet","H4sIAAAAAAAC/0tJLEm0SiwoyMlMTizJzM/TT6/KLLBOSixONTPR4fIwKfZ0hIHKMs/g5Crf0Mr0/JDkIq8QtyjPSrPyfO9gQ++w4AyvouCsDMd0R5/CDMsc93SQBltbZP1clBqArJ+LWAMARQhWw+AAAAA=","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_q","refusal","refusal","H4sIAAAAAAAC/1NKSSxJtEosKMjJTE4syczP00+vyiywTkosTjUz0eHyMCn2dIQBi+KyKoPiktDsDN+qbEO/qkyLwlDX9OLQ4Cz/SmeLAtN0T0d3T7MA/6B0kGoPp/JkFMyFLkAitlUCAGa6HXetAAAA","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_q_ind","refusal","refusal","H4sIAAAAAAAC/6tQsFVQSkksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9HhUgACD5NiT0cYsCguqzIoLgnNzvCtyjb0q8q0KAx1TS8ODc7yr3S2KDBN93R09zQL8A9KB6n2cCpPRsFgA9EFScS2SgB7fUXuuQAAAA==","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_yaml","quiet","quiet","H4sIAAAAAAAC/0vKyU+yUqjhUlBISSxJtEosKMjJTE4syczP00+vyiywTkosTjUz0QHKe5gUezrCgEVxWZVBcUlodoZvVbahX1WmRWGoa3pxaHCWf6WzRYFpuqeju6dZgH9QOki1h1N5MgoGGocuRCK2BQA/bpN5uQAAAA==","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_md","quiet","quiet","H4sIAAAAAAAC/1OMrojVSEksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9Hh8jAp9nSEAYvisiqD4pLQ7AzfqmxDv6pMi8JQ1/Ti0OAs/0pniwLTdE9Hd0+zAP+gdJBqD6fyZBTMhS5AIrbVBADjBhQPsQAAAA==","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_tmpl","refusal","refusal","H4sIAAAAAAAC/0vOzysuUUhSsFVISEksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9Hh8jAp9nSEAYvisiqD4pLQ7AzfqmxDv6pMi8JQ1/Ti0OAs/0pniwLTdE9Hd0+zAP+gdJBqD6fyZBTMhS5AIrZNsAYAY1BfMLgAAAA=","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_py3","refusal","refusal","H4sIAAAAAAAC/0tSsFVQUlJKSSxJtEosKMjJTE4syczP00+vyiywTkosTjUz0eHyMCn2dIQBi+KyKoPiktDsDN+qbEO/qkyLwlDX9OLQ4Cz/SmeLAtN0T0d3T7MA/6B0kGoPp/JkFMyFLkAituUCOhcA/ytx2rYAAAA=","checkText","doc.md"],
  ["p2-emptyfirst","nl_gz_bs","refusal","refusal","H4sIAAAAAAAC/6tQsFVQSkksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9GJ4fIwKfZ0hAGL4rIqg+KS0OwM36psQ7+qTIvCUNf04tDgLP9KZ4sC03RPR3dPswD/oHSQag+n8mQUHMOFLkIitlUCAAOvpj6zAAAA","checkText","doc.md"],
  ["p2-emptyfirst","sp_nl_gz","quiet","quiet","H4sIAAAAAAAC/0tJLEm0SiwoyMlMTizJzM/TT6/KLLBOSixONTPRUeDyMCn2dIQBi+KyKoPiktDsDN+qbEO/qkyLwlDX9OLQ4Cz/SmeLAtN0T0d3T7MA/6B0kGoPp/JkFMyFLkAitgUA3a50iqwAAAA=","checkText","doc.md"],
  ["p2-emptyfirst","nl_png_term","quiet","private","H4sIAAAAAAAC/x2MSw6CMABE91xFE8CAaTQuWgT5BNBiIbAriOUTEFKiwumlzmLmLV7mQSd6qDvKSnno2TGnvNxrW6mOUYg/indhL7gmiEhlEibQFIUMmIp9WkXkCvDsgSQ2Puc7dcoSXVkVrff5e1H4JJG28pdWDZYajMRknERNOBtgQAyNLWwKWsn3+X+uuti0SOl+m40vQ4AARDeIZK3LrlgRApQiEofY043UcU4/1J0KYb0AAAA=","checkText","doc.md"],
  ["p2-emptyfirst","nl_png_term_q","quiet","private","H4sIAAAAAAAC/x2MSw6CMABE9xyDrSaAAUM0LloE+QTQ1kJgVxDLJyAEosLppc5i5i1eRnzQiR6qlrJC6jt2zOhY7NWtUEUwRB/Zu7AXWBNgUpqEcTR5QQMkfJ9Wjl0Ont2T2EbnbKdMaazJq6J2/vhe5HESSFP6S6MES6UPxGQjwXU4G3oPGRwaUOe0lO7z/1xxkWmRwv3WG18COtQBvAEoqW16RTIXgIBJFCJPMxLHOYk/7RxBir8AAAA=","checkText","doc.md"],
  ["p2-emptyfirst","nl_text","secret","private+secret","H4sIAAAAAAAC/0tJLEm0KkmtKNEvyEnMzLNOSixONTPR4Yo0siyNys3J83QvyUkNdnIKNshxCg1LcQvNCYoKC80JCHV1CwlyjfIIdnbKSMoNTE8yTimNivBMjwz3K4kK9ytLznNMT3QPq4wKtLUFACthQSJkAAAA","checkText","doc.md"],
  ["p2-emptyfirst","nl_text_q","secret","private+secret","H4sIAAAAAAAC/1NKSSxJtCpJrSjRL8hJzMyzTkosTjUz0eGKNLIsjcrNyfN0L8lJDXZyCjbIcQoNS3ELzQmKCgvNCQh1dQsJco3yCHZ2ykjKDUxPMk4pjYrwTI8M9yuJCvcrS85zTE90D6uMCrS1VQIAP89uB2YAAAA=","checkText","doc.md"],
  ["p2-emptyfirst","short_gz_unq","quiet","quiet","H4sIAAAAAAAC/0tJLEm0SiwoyMlMTizJzM/TT6/KLLBOSixONTPR8TAp9uRyhAGL4rIqg+KS0OwM36psQ7+qTIvCUNf04tDgLP9KZ4sC03RPR3dPswD/oHSQag+n8mQMzIVNkEhsCwBru/CFqwAAAA==","checkText","doc.md"],
  ["p2-emptyfirst","short_gz_q","refusal","refusal","H4sIAAAAAAAC/1NKSSxJtEosKMjJTE4syczP00+vyiywTkosTjUz0fEwKfbkcoQBi+KyKoPiktDsDN+qbEO/qkyLwlDX9OLQ4Cz/SmeLAtN0T0d3T7MA/6B0kGoPp/JkDMyFTZBIbKsEABTlh3ytAAAA","checkText","doc.md"],
  ["p3-mixed","sfx_one","refusal","refusal","H4sIAAAAAAAC/y2KSQ6CMAAAP6RRNtdwQEREWWQRhFsLWGsoJbYq5fUa4xxnpgIcrEDXNbgEHNN2Qkte8zHjjxqQNQSsnqkjR1ivnDRPV/GpiT1UyikrsNTU+0jkmT8FmdY69kGCJGJFwlBp7zRoL2+FuSFQ7hlUquHbm69TTJKq4BIiz6BX/EbGn60Qk1MspDi2hiA5K4ErujA2++jozR1XtMRARn6nC83+7br+Afnj8Vi5AAAA","checkText","doc.md"],
  ["p3-mixed","sfx_w76","quiet","quiet","H4sIAAAAAAAC/y2KXROBQAAA3/0WhrryOR6SJEoqot7uKudM1zXu0PXrNcY+7m4OBZzDui5JBgVh1ZBlohADLp4FpAsEeTHW+o603gktXy44MJN4OFNjnhKlLLahTC6HEbzolWPvFERDnp44zuyNjuzZPTVXFKkNRyBvu152DvRMGmvwGmDPYDfywcaftZTDYySVKLJa/3QGvivrIDKbcO9NHFdW1MBG8mBT3f7ty+UX5RDIKLoAAAA=","checkText","doc.md"],
  ["p3-mixed","sfx_w76_q","refusal","refusal","H4sIAAAAAAAC/y2KTROBQABA736GM0Mqn+OQJFGiEnXbXVlrdtvGLtp+PWO843uvfQESTEFVUYKAJLzscSQL2RXyUQA2g0AUQ6PjKeeVMfr09R23SYDRIBU50WixjlR22vXBySw9d6NBFok8ERi5KxO6k1tuLxgc1ALql+bb6dfpLZulBjgfcGDxK3lj689Sqd4+VlocO02YHPXQV9UhtutoG4w8X5XMwlZ252PT/e3zefsDn+aALrwAAAA=","checkText","doc.md"],
  ["p3-mixed","sfx_w76_md","quiet","quiet","H4sIAAAAAAAC/y2K2xKBQABA3/2FN2aYpHIdDwmJLrq4lPGwm6w1bdvYRevrGeM8nnPqx+rUOAMORqAsc5wCjmkh0ZRnvM34PQNkDAHLemrLEvNnTPKHrbjUwA5KuzuWYDnPloGI924H7LXCMlcyJAFLIoZSc6FBc3hNjCmB3YpB5fz+9vzrlJpBdio4+MjR6QW/kP5nJoS0CYUchvO3F20VzxalHxpVsHb6li0KoiM9vtGBZv72yaT5AQOdCjnAAAAA","checkText","doc.md"],
  ["p3-mixed","poly_one","refusal","refusal","H4sIAAAAAAAC/zWNSw6CMABED6QJLooBXbVQPqXyLwnsKmKpIBgxkHB6LYlvMfM2k7nxDz/JJxeN9hrE+cqn5gj2skBRuhwCV4zwR5ixFjOhFKtAFixV3506I0ps1uOkSMHgxmA17MVboAOhp8mqM71km5CU6fjdESHaHbXgn5hSw6S0IH5+0cO8BnPQI586eFwnMQdNaUEko8fabYdf2kDZGq4AAAA=","checkText","doc.md"],
  ["p3-mixed","poly_w76","quiet","quiet","H4sIAAAAAAAC/zWNSw6CMABE915FE1wUA7pqoXxK5V8S3FXEUkEwYiDh9FoS32LmbSZz4x9+lE8uau3Vi9OVj/UB7GSBonTeB64Y4I8wYw1mQilWgSxYqr47VUaU2KzDSZGC3o3BYtizN0MHQk+Tl9bceMm6ISnT8bslQjRbasE/MaWGSWlB/Pysh3kFpqBDPnXwsIxiCurSgkhGj6VdH7+I28mqrwAAAA==","checkText","doc.md"],
  ["p3-mixed","poly_w76_q","refusal","refusal","H4sIAAAAAAAC/zWNyQ6CMABE736F4aoJHooBt6RAWUplhwRviFgqmwEDCV+vkPgOM+8ymROr6brvsjP3SD/pgdUpzfl3Q4/3tM/3YMti2fHHnaXTFv6wg6hAEZ0VzSErMJn7qWUBnkWNKuTFPmh0F0yiOhoj1CA0eHYrpZXhLRvsRwLqSkxpsSEK/OMSIkqExNgMr4IdZmCwKtkkGmqnng5WnihQZs5rKpdH7vIFP7lScbsAAAA=","checkText","doc.md"],
  ["p3-mixed","poly_w64_q","refusal","refusal","H4sIAAAAAAAC/zWNyQ6CMABE73yF4aoJHooBt6RAWSuylQRviFgqmwEDCV+vkPgOM+8ymSOr6arvshP/SD/pntUpzYV3Qw/3tM93YMNi5RqMW8egLfzhhqRAhM6K5lBUmMz91LPQnkUjFfLjADSGByZJGzlzhDqEpsBupWz6y8YOiIi60qa0WGMV/vEwlmSMY9uKLqIbZWBwKsXisI7aqaeDkycqVNj1NZXLJX/+AqysA5a8AAAA","checkText","doc.md"],
  ["p3-mixed","broken_one","refusal","refusal","H4sIAAAAAAAC/xWK2Q6CMBREf8ikjSIBjQ8XpGwVWWvwrWyFiEACQsLXC/MwZ3IyBZ/4pflyUaKhE9eMj6UsHRqmPcMFu6boYYsXJbWRiH0ae2k6pDsrkkcO+Agh3BoBC6XO9KVVuS/WAgTAQs37o1rB9tRrmZEaB0d1yl7sV2yqdFZKFZVS5tjx4+zFuTS7rWZTYvTrKGY3SIEPYJ/MvsJKf/sDP29ht6oAAAA=","checkText","doc.md"],
  ["p3-mixed","broken_w76","quiet","quiet","H4sIAAAAAAAC/xWKyw6CMBRE936LSRutBDQuLsi7orxqcFdehYhAAkLC1wuzmDM5mZyP/Fx/uShQ34pLyodCIvuaqY9gxq4pOljjhXGlx2Kb+laqBsnG0shCB54IIdzoPgtIaz7JIt9mawYDwEL1+6PsLH+9apXEjAr7B2VMX+yXr6pwFkplhVLm2NH95EUZmdxGtamhd8sgJtdPgPdgH82uxHJ3/QMojd7tqwAAAA==","checkText","doc.md"],
  ["p3-mixed","broken_w76_q","refusal","refusal","H4sIAAAAAAAC/xWKyQ6CMABE736F4WxSokhAxaQge0XWGryVrRDZIigJXy/MYd7kZS5VQ7fDJ5WYjIzkVDWE5qBv6TkhQ85zuwrLD39ibZ12cIkTRKUa0XWqa8kKjFcWWhpY0AUAsLXqYZ9rdZebhdtkTFCD0ADV6y1uDG+5KiWPtZL19uKYPPE3W1RuzQgJIkLYMsP70QlT7mfXsok0tZsH+rO9GJIemge9K1ihk5jrH6VkOie3AAAA","checkText","doc.md"],
  ["p4-opening","lead_sp_spaces","secret","private+secret","H4sIAAAAAAAC/7PJzE1XKC5KtlVSSEksSbQqSa0o0S/ISczMs05KLE41M9FJ9cgwAWEFqjM83S2Nk3LDKoEMt6yk8LAshSRjr3JP95IchdRgJ6dggxwnhdCwFLfQnKAohbDQnIBQV7cQhSDXKI9gZ6cchaTcQFslOwCOUPm/wQAAAA==","checkText","doc.md"],
  ["p4-opening","lead_sp_wrap_blank","quiet","private","H4sIAAAAAAAC/x2MSw6CMABE95zCsNWEYtAQf0mLIEIALVaCu4pYPgHREhVOL3UWM2/xMqu8YiP+Stby6EZbusgrylKlqdnySnk61yb5GQX4A9wde8AhfkgykzCBpihkwFjs3UpCR4BrNySy8fY6VdtLNAODotUef/eAt5JEyszrS9Xvc/1JTMZJWASdoTeIoWcJi4Rmyqn7v6sONi2SOt9i7ClQRzpER4gUrbocMBAClKSQnAPszox4v1/Lmx+wdb1MywAAAA==","checkText","doc.md"],
  ["p4-opening","lead_sp_wrap","quiet","private","H4sIAAAAAAAC/x2MyQ6CMABE734F8aoJYNAQFZMWQZYAWqwGbgWxLAHBEhe+XuocZt7hZbZFTQX2TLWpcCM9WRc1oZnYNnSTEJatlHlxgQF6S+6BPsAYP8S5gSlHgxfUQcT3bqahw8G1Wny10D5ZyH18XUqjojQeew0S6ye4yr2hkv2hUDtsUIbDMvjqagsp7CpQpiQXz9//uewgw8SZ8ylnnghUqAJ4AlBU6viIJC6ASYgvAXKXemTb2nT3A+0ROX7JAAAA","checkText","doc.md"],
  ["p4-opening","lead_sp_nl_gz","refusal","refusal","H4sIAAAAAAAC/7PJzE1XKC5KtlVSSEksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9Hh8jAp9nSEAYvisiqD4pLQ7AzfqmxDv6pMi8JQ1/Ti0OAs/0pniwLTdE9Hd0+zAP+gdJBqL+fAbBTMhS6ADSvZAQDJ+KqFnAAAAA==","checkText","doc.md"],
  ["p4-opening","lead_sp_gz_w76","refusal","refusal","H4sIAAAAAAAC/7PJzE1XKC5KtlVSSEksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9HxMCn2dIQBi+KyKoPiktDsDN+qbEO/qkyLwlDX9OLQ4Cz/SmeLAtN0T0d3T7MA/6B0kGov58BsFMyFLoANK9kBAMQ4p0abAAAA","checkText","doc.md"],
  ["p4-opening","style_spaces","secret","private+secret","H4sIAAAAAAAC/7NJySxTKC6pzEm1VUpKTM5OL8ovzUuxKi3K0UhJLEm0KkmtKNEvyEnMzLNOSixONTPRSfXIMAFhBaozPN0tjZNywyqBDLespPCwLIUkY69yT/eSHIXUYCenYIMcJ4XQsBS30JygKIWw0JyAUFe3EIUg1yiPYGenHIWk3EBbTSU7G32gl+wAgV2u69gAAAA=","checkText","doc.md"],
  ["p4-opening","style_blank","quiet","private","H4sIAAAAAAAC/x2PyQ6CMABE73yF8aTRpGDQELekRVwgiBar0VtZLIsiWlDh66XOYeYdJpPMNIjfLV5Ut3DW9qifstejzIJx+bp1AlrQcXynLAR5xiYe5eFI7cdH5OCPbK3YAzbauiQyCBNoCEM6PIu8Ln3XFGCtc3Ja44U3UIrLaSg3FTWz+buWeSFJJI3sOlW2daw9icE4cROn0rUcMfRMYeLTCByq/7piYmNJQvOb9GwANaRBtIcIqPfLDsuiACXJJUcHW0P9vNnMuu35FDTn5j/Q/tdf4gAAAA==","checkText","doc.md"],
  ["p4-opening","style_wrap_indent","quiet","private","H4sIAAAAAAAC/x1Pyw6CMAC7+xXGk0aTgUFDfCUb4gOC6HAavY2H46GIDlT4ehk9tD00bTrzo0+b5+U9mHdc6iXs/SxSf1K8712f5nQSPSgLQJayqUt5MFYGrXaN6IRs/JXMNXvCGjuHhDphwuqCkAYvQm8rzzGEMTcZOW/w0h3K+fU8kuqIklr8U0k8bwpJElpVIu+qSH0RnXHixHapqRli6JXA2KMhOJbNgGxgfUUC4xf3LQBVpEJ0gAgoj+seSyIAm0KHnGxsjrTLdjvvdRYzUP9c/AERfZap7QAAAA==","checkText","doc.md"],
  ["p4-opening","css_q_spaces","secret","private+secret","H4sIAAAAAAAC/0tUqFZISkzOTi/KL81LsVIoLcrRUFBKSSxJtCpJrSjRL8hJzMyzTkosTjUz0Un1yDABYQWqMzzdLY2TcsMqgQy3rKTwsCyFJGOvck/3khyF1GAnp2CDHCeF0LAUt9CcoCiFsNCcgFBXtxCFINcoj2BnpxyFpNxAWyUFTYVaAOezmC3PAAAA","checkText","doc.md"],
  ["p4-opening","json_sp","secret","private+secret","H4sIAAAAAAAC/6tWUMpMzs9TslJQUkhJLEm0KkmtKNEvyEnMzLNOSixONTPRSfXIMAFhBaozPN0tjZNywyqBDLespPCwLIUkY69yT/eSHIXUYCenYIMcJ4XQsBS30JygKIWw0JyAUFe3EIUg1yiPYGenHIWk3EBbJYVaAJGnwWTDAAAA","checkText","doc.md"],
  ["p4-opening","py_paren_spaces","secret","private+secret","H4sIAAAAAAAC/6tQsFXQUFJISSxJtCpJrSjRL8hJzMyzTkosTjUz0Un1yDABYQWqMzzdLY2TcsMqgQy3rKTwsCyFJGOvck/3khyF1GAnp2CDHCeF0LAUt9CcoCiFsNCcgFBXtxCFINcoj2BnpxyFpNxAWyVNAFBpOp29AAAA","checkText","doc.md"],
  ["p4-opening","tab_lead","secret","private+secret","H4sIAAAAAAAC/7PJzE1XKC5KtlXiTEksSbQqSa0o0S/ISczMs05KLE41M9FJ9cgwAWEFqjM83S2Nk3LDKoEMt6yk8LAshSRjr3JP95IchdRgJ6dggxwnhdCwFLfQnKAohbDQnIBQV7cQhSDXKI9gZ6cchaTcQFslOwCVJzm9wQAAAA==","checkText","doc.md"],
  ["p4-opening","nl_lead","secret","private+secret","H4sIAAAAAAAC/7PJzE1XKC5KtlXiSkksSbQqSa0o0S/ISczMs05KLE41M9FJ9cgwAWEFqjM83S2Nk3LDKoEMt6yk8LAshSRjr3JP95IchdRgJ6dggxwnhdCwFLfQnKAohbDQnIBQV7cQhSDXKI9gZ6cchaTcQFslOwAtV5FbwQAAAA==","checkText","doc.md"],
  ["p5-termdep","png17","quiet","quiet","H4sIAAAAAAAC/0tJLEm0ysxNTE/VL8hLt05KLE41M9HJDHPyDyo38HZPz3cEAr9gADhHAdMnAAAA","checkText","doc.md"],
  ["p5-termdep","png21","quiet","quiet","H4sIAAAAAAAC/0tJLEm0ysxNTE/VL8hLt05KLE41M9HJDHPyDyo38HZPz3cEAr/g0AzXUAALXddLKwAAAA==","checkText","doc.md"],
  ["p5-termdep","png17_md","quiet","quiet","H4sIAAAAAAAC/1OMzslPz4/VSEksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/PdwQCv2BNAKo5/cEwAAAA","checkText","doc.md"],
  ["p5-termdep","png17_q","quiet","quiet","H4sIAAAAAAAC/7PJzE1XKC5KtlVKSSxJtMrMTUxP1S/IS7dOSixONTPRyQxz8g8qN/B2T893BAK/YCU7AOc7BZIzAAAA","checkText","doc.md"],
  ["p5-termdep","jpg17","quiet","quiet","H4sIAAAAAAAC/0tJLEm0ysxNTE/VzypITbdOSixONTPR0bfM0jdxdAwMzo7yCkp3dHIEAPJCv5YoAAAA","checkText","doc.md"],
  ["p5-termdep","gif17","quiet","quiet","H4sIAAAAAAAC/0tJLEm0ysxNTE/VT89Ms05KLE41M9EJMshx93fJyXAMdHRy9HR0dAQAnmWxlycAAAA=","checkText","doc.md"],
  ["p5-termdep","png20_pad","refusal","refusal","H4sIAAAAAAAC/0tJLEm0ysxNTE/VL8hLt05KLE41M9HJDHPyDyo38HZPz3cEAltHRwCIgUvVKAAAAA==","checkText","doc.md"],
  ["p5-termdep","octet17","refusal","refusal","H4sIAAAAAAAC/0tJLEm0SiwoyMlMTizJzM/Tz08uSS3RLS4pSk3MtU5KLE41M9FxRAcAUNSWbjYAAAA=","checkText","doc.md"],
  ["p7-padding","pad_nl_term","quiet","private","H4sIAAAAAAAC/0tJLEm0KkmtKNEvyEnMzLNOSixONTPRSfYIy0xyz8nydI8qSPUIMkzODbXlSjJOKY2K8EyPDPcriQr3K0vOc0xPdA+rjAq0tQUAeEQ6TkgAAAA=","checkText","doc.md"],
  ["p7-padding","pad_nl_term_q","quiet","private","H4sIAAAAAAAC/1NKSSxJtCpJrSjRL8hJzMyzTkosTjUz0Un2CMtMcs/J8nSPKkj1CDJMzg215UoyTimNivBMjwz3K4kK9ytLznNMT3QPq4wKtLVVAgDktQ4LSgAAAA==","checkText","doc.md"],
  ["p7-padding","pad_nl_secret_q","secret","secret","H4sIAAAAAAAC/7PJzE1XKC5KtlVKSSxJtCpJrSjRL8hJzMyzTkosTjUz0Un2CMtMcs/J8nSPKkj1CDJMzg215Uo0CjP1dHXzCQ51CwozCAsOc8sJCw61DAwM83MNyk7xVLIDAIRjQoJYAAAA","checkText","doc.md"],
  ["p7-padding","pad_nl_secret_md","secret","secret","H4sIAAAAAAAC/1OMrojVSEksSbQqSa0o0S/ISczMs05KLE41M9FJ9gjLTHLPyfJ0jypI9QgyTM4NteVKNAoz9XR18wkOdQsKMwgLDnPLCQsOtQwMDPNzDcpO8dQEAPTkaQtSAAAA","checkText","doc.md"],
  ["p7-padding","pad_one_term_q","quiet","private","H4sIAAAAAAAC/1NKSSxJtCpJrSjRL8hJzMyzTkosTjUz0Un2CMtMcs/J8nSPKkj1CDJMzg21TTJOKY2K8EyPDPcriQr3K0vOc0xPdA+rjAq0tVUCAEWDSmJJAAAA","checkText","doc.md"],
  ["p7-padding","pad_nl_gz_q","refusal","refusal","H4sIAAAAAAAC/1NKSSxJtEosKMjJTE4syczP089PLkkt0S0uKUpNzLVOSixONTPRSfYIy0xyz8nydI8qSPUIMkzODbXl8jAp9nSEAYvisiqD4pLQ7AzfqmxDv6pMi8JQ1/Ti0OAs/0pniwLTdE9Hd0+zAP+gdJBqWyUAkB+x93gAAAA=","checkText","doc.md"],
  ["p7-padding","pad_sp_secret_q","secret","secret","H4sIAAAAAAAC/7PJzE1XKC5KtlVKSSxJtCpJrSjRL8hJzMyzTkosTjUz0Un2CMtMcs/J8nSPKkj1CDJMzg21VUg0CjP1dHXzCQ51CwozCAsOc8sJCw61DAwM83MNyk7xVLIDAMZjvpNYAAAA","checkText","doc.md"],
  ["p7-padding","pad_nl_secret_yaml","secret","secret","H4sIAAAAAAAC/0vKyU+yUqjhUlBISSxJtCpJrSjRL8hJzMyzTkosTjUz0Un2CMtMcs/J8nSPKkj1CDJMzg21BapONAoz9XR18wkOdQsKMwgLDnPLCQsOtQwMDPNzDcpO8QQAJRJQE1gAAAA=","checkText","doc.md"],
  ["p8-concat","py_gz","refusal","refusal","H4sIAAAAAAAC//N09vdTsFXQ4FIAAqWUxJJEq8SCgpzM5MSSzPw8/fSqzALrpMTiVDMTHSWIGg+TYk9HGLAoLqsyKC4Jzc7wrco29KvKtCgMdU0vDg3O8q90tigwTfd0dPc0C/APSgep9oIa4RyY7UUqVuLSBABPyp/NrAAAAA==","checkText","doc.ts"],
  ["p8-concat","js_gz","refusal","refusal","H4sIAAAAAAAC/0vOzysuUchMzs9TsFVQSkksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9FRUtDmUlBQ8jAp9nSEAYvisiqD4pLQ7AzfqmxDv6pMi8JQ1/Ti0OAs/0pniwLTdE9Hd0+zAP+gdJBqL6gRzoHZXqRiJWsA5V36P6sAAAA=","checkText","doc.ts"],
  ["p8-concat","jslead_gz","refusal","refusal","H4sIAAAAAAAC/0vOzysuUchMzs9TsFVQSkksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9FR4lJQ0FZQ8jAp9nSEAYvisiqD4pLQ7AzfqmxDv6pMi8JQ1/Ti0OAs/0pniwLTdE9Hd0+zAP+gdJBqL6gRzoHZXqRiJWsABZZ55asAAAA=","checkText","doc.ts"],
  ["p8-concat","c_gz","refusal","refusal","H4sIAAAAAAAC/ysuSSzJTFZIzs8rLlFIzkgsUtDKBHIUbLkUFJRSEksSrRILCnIyk4Gq8vP006syC6yTEotTzUx0lEAqPEyKPR1hwKK4rMqguCQ0O8O3KtvQryrTojDUNb04NDjLv9LZosA03dPR3dMswD8oHaTaC2yAc2C2F6lYyRoABNfLe7YAAAA=","checkText","doc.ts"],
  ["p8-concat","first_gz","refusal","refusal","H4sIAAAAAAAC/0vOzysuUchMzs9TsFVQSkksSbRKLCjIyUxOLMnMz9NPr8ossE5KLE41M9HxMCn2dIQBi+KyKoPiktDsDN+qbEO/qkyLwlDX9OLQ4Cz/SmeLAtN0T0d3T7MA/6B0kGovJQVtLgUFJefAbC9SsZI1AJ06uyCkAAAA","checkText","doc.ts"],
  ["p8-concat","py_poly","refusal","refusal","H4sIAAAAAAAC/zWNTQuCQBiE7/4K8VQU2EFDiw6rrp+b3wp2M7N10zQyFPz1qdlzmHdgeGcM2bHpE72i6BHmln7SA3mmOGdfNT5e0zbfc1vmF5JYcvx+Z2m4ASN2EBUwwpOFk0gySKZ7V7PAnIwSVdCLfa7WXG6pGASl13ugAqCz5FKKujd/mn7Ew3dpYlxskAz+uAgJIkKxaYRn3l4qwozrrEoykAqbocWdlScykIjzGMp5nqHWX+o/hUDUAAAA","checkText","doc.ts"],
  ["p8-concat","js_poly","refusal","refusal","H4sIAAAAAAAC/zWNzQ5DQACE732KjasmeqCh0sNi/W79k+hNVdeW0pSQePqW6BxmvsvMFF3bD4AWXQvOgLnnQ36ir5yU3Lsl8i3vyyO/ZwC7A4ChqeKF08ExSAd/cqOkQglZEC2mqDBb8qEXkb2AljQoSEO+NXx+m5hFbTInqENocvRaS2awNu0wEdCntgmpWKzCv3yMRQnj1Lbii+BuE3HBj06jWFhH3dyT0SkzFSrUe871es/IX20vbJjTAAAA","checkText","doc.ts"],
  ["p8-concat","first_poly","refusal","refusal","H4sIAAAAAAAC/zWNvQ6CMACEd5+iYcUEBzAgcShQfiv/kOCGiKWC1IiBhKdXiN5w9y13V7F+eANasR4cAXct3+WBPkpSC8+eqJdyqPfiluZaEE87zyIMfuUnWYMysiBaTNNhseTNrBJ3ASPrUJTHYm+FIgf4DQDcLBuTPUETQlug51axo7XpxpmEXq1LSMNjHf4VYiwrGOeuk54k/zeRVuLodZqDTcTmgYxeXehQo8F9btd7Tv0AUpDuTcwAAAA=","checkText","doc.ts"],
  ["p10-ordinary","regex","quiet","quiet","H4sIAAAAAAAC/0vOzysuUShKVbBV0I9LSSxJtMrMTUxPjdHXKMhLr8kqSE3XtE5KLE41M9HRtwYA1Aa9By0AAAA=","checkText","doc.md"],
  ["p10-ordinary","starts","quiet","quiet","H4sIAAAAAAAC/8tMU9AoLcrRKy5JLCopDs8sydBQSkksSbRS0tRUKEotKS3KswYAdMNrjyQAAAA=","checkText","doc.md"],
  ["p10-ordinary","btoa","quiet","quiet","H4sIAAAAAAAC/8vMTdcrLkpWsFVQSkksSbTKzE1MT9UvyEu3TkosTjUz0VFS0FZIKslP1EjKzEssqtS0BgDi17WXMgAAAA==","checkText","doc.md"],
  ["p10-ordinary","btoa_nl","quiet","quiet","H4sIAAAAAAAC/8vMTdcrLkpWsFVQSkksSbTKzE1MT9UvyEu3TkosTjUz0VFS0OZSUEgqyU/USMrMSyyq1LQGAJik0V40AAAA","checkText","doc.md"],
  ["p10-ordinary","py_prefix","quiet","quiet","H4sIAAAAAAAC/ysoSk3LrFCwVVBKSSxJtMrMTUxP1S/IS7dOSixONTPRUeJKzUvOT0lNASqBCOklmZlAxDRAWjT1UlLBHE0A7foc4ksAAAA=","checkText","doc.md"],
  ["p10-ordinary","py_prefix2","quiet","quiet","H4sIAAAAAAAC/wsIcnXzjFCwVVBKSSxJtMrMTUxP1S/IS7dOSixONTPRUeJy9XP2d3F1iQ929A3wcY0Pc/QJdY33c/R1BWrKyU9M0dAEADLTHhtEAAAA","checkText","doc.md"],
  ["p10-ordinary","tmpl","quiet","quiet","H4sIAAAAAAAC/0vOzysuUSguSlawVUhISSxJtMrMTUxP1S/IS7dOSixONTPRUalOMjOpTbAGAE2ghKErAAAA","checkText","doc.md"],
  ["p10-ordinary","tmpl_nl","quiet","quiet","H4sIAAAAAAAC/0vOzysuUSguSlawVUhISSxJtMrMTUxP1S/IS7dOSixONTPR4VKpTjIzqU2wBgDoZMQZLAAAAA==","checkText","doc.md"],
  ["p10-ordinary","md_placeholder","quiet","quiet","H4sIAAAAAAAC/wstTlVISEksSbTKzE1MT9UvyEu3TkosTjUz0bEpSKzMyU9MsUtQCA3yKdYDAFedUm0rAAAA","checkText","doc.md"],
  ["p10-ordinary","md_trunc_dots","quiet","quiet","H4sIAAAAAAAC/3OtSMwtyEm1UkhQSkksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/PdwQCv+DQDNfQdEdHPT09pQQAMhRggD4AAAA=","checkText","doc.md"],
  ["p10-ordinary","md_trunc_q17","quiet","quiet","H4sIAAAAAAAC/7PJzE1XKC5KtlVKSSxJtMrMTUxP1S/IS7dOSixONTPRyQxz8g8qN/B2T893BAK/YCU7AOc7BZIzAAAA","checkText","doc.md"],
  ["p10-ordinary","json_list","quiet","quiet","H4sIAAAAAAAC/4tWSkksSbTKzE1MT9UvyEu3TkosTjUz0VHS4VJQygxz8g8qN/B2T893BAK/4NAM19B0ENMVRDgpxQIAsageoj8AAAA=","checkText","doc.md"],
  ["p10-ordinary","json_obj","quiet","quiet","H4sIAAAAAAAC/6tWykzOz1OyUlBKSSxJtMrMTUxP1S/IS7dOSixONTPRyQxz8g8qN/B2T89X0uECqkotTi7KLCjJhGgKycgs9ix2zMsvyUgt8snPSw8uKcrMS/dP80ktKUktKlaqBQAh57ouYQAAAA==","checkText","doc.md"],
  ["p10-ordinary","svg_utf8","quiet","quiet","H4sIAAAAAAAC/0vOzysuUahQsFVQT0ksSbTKzE1MT9UvLkvXrsjNsS4tSbPQsQHyFIC8vGJbpYySkgIrff3y8nK9cmO9/KJ0fSMDAwOQeiV9O3VrAEWrlqtOAAAA","checkText","doc.md"],
  ["p10-ordinary","css_pct","quiet","quiet","H4sIAAAAAAAC/0usTkpMzk4vyi/NS7EqLcrRUEpJLEm0ysxNTE/VLy5L167IzbFOzkgsKk4tsS0tSdO10FE1dgZKqBoZAKXyilWNXVSNjDJKSgpUjR1VjdyAqLy8XK/cWC+/CKjIzcjAwABIgXUYgeSNXZU0awHCTomedwAAAA==","checkText","doc.md"],
  ["p10-ordinary","clean_q_wrap","quiet","quiet","H4sIAAAAAAAC/7PJzE1XKC5KtlVKSSxJtMrMTUxP1S/IS7dOSixONTPRyQxz8g8qN/B2T893BAK/4NAM19B0ENMVRDg5O0aC6DS35GAvEMMlNMc1MCzIJM89wKTKwqXco9zRzdHRQz8zKtuSyyMQrMcrKNTUtSjbKz093dZWyQ4AQNKaS4MAAAA=","checkText","doc.md"],
  ["p10-ordinary","clean_py","quiet","quiet","H4sIAAAAAAAC//N09vdTsFXQ4FIAAqWUxJJEq8zcxPRU/YK8dOukxOJUMxMdJYhkZpiTf1C5gbd7er4jEPgFh2a4hqaDmK4gwsnZMRJEp7klB3uBGC6hOa6BYUEmee4BJlAjqixcyj3KHd0cHT30M6OyLT0CwTq9gkJNXYuyvdLT021tlbg0Abrl0mqVAAAA","checkText","doc.md"],
  ["p10-ordinary","clean_js","quiet","quiet","H4sIAAAAAAAC/0vOzysuUchMzs9TsFVQSkksSbTKzE1MT9UvyEu3TkosTjUz0VFS0OZSUFDKDHPyDyo38HZPz3cEAr/g0AzX0HQQ0xVEODk7RoLoNLfkYC8QwyU0xzUwLMgkzz3ABGpElYVLuUe5o5ujo4d+ZlS2pUcgWKdXUKipa1G2V3p6uq2tkjUAChFvg5QAAAA=","checkText","doc.md"],
  ["p10-ordinary","sh_heredoc","quiet","quiet","H4sIAAAAAAAC/0tOLFGwsXH1d1OwU6jQyyjJzeGyycxNVyguSrZVSkksSbTKzE1MT9UvyEu3TkosTjUz0VHRgDAUdMsNFHLy0/P1gJKaSnZcQFMAlaN/F08AAAA=","checkText","doc.md"],
  ["p10-ordinary","go_const","quiet","quiet","H4sIAAAAAAAC/0vOzysuUSgoSk3LrFCwVVBKSSxJtMrMTUxP1S/IS7dOSixONTPRUeJKBqsrLk2DqnNMSk5JTUvPyMzKzsnNyy8oLCouKS0rr6iscnRydlECAEUC/UJXAAAA","checkText","doc.md"],
  ["p10-ordinary","csv","refusal","refusal","H4sIAAAAAAAC/8tLzE3VKS3K5MrJT8/XUUpJLEm0ysxNTE/VL8hLt05KLE41M9HJDHPyDyo38HZPz1fiSkssy0zOz0NRW6ELEoIpd3R0dHJ0dHV0BZIg2tPRKR/EdEsHEs4gwjEQRHg6wuRhINARB1ACAAS/OpKoAAAA","checkText","doc.md"],
  ["p10-ordinary","apostrophe_prose","quiet","quiet","H4sIAAAAAAAC/wvJSFVQT0ksSbTKzE1MT9UvyEu3TkosTjUz0ckMc/IPKjfwdk/PV1coKEpNy6xQyE0syi5WSFQI8HPXU/AsUS9WSM7Pzc3P0wMAGE4otkgAAAA=","checkText","doc.md"],
  ["p11-pdf","pdf_one","refusal","refusal","H4sIAAAAAAAC/x3P3VaCMAAA4AeycwShkrriR3BsQ7bh+LkbYDSYQEGCPn2d3uD7ajGLNzGOSlZilkO/HeuP91JMlxfzKeTOgUptRS2B4QW1DwtDzOwFBJYUzbCPXfuWBPynMOgAvFwHrhWIdNWKDDRIK6Y8o4oGvC13VAHP3Lh9pFVX/lmS0eyPGJ5rx8A6WSIfAMbxEulgcV595nvEZesJMQVRJQcuFUD7YYZ+hO5yJawzoqTbnpDbEk6+wTk7YHtDc4aXUZVX+qiPocpTDRbpc1fuwi+3p/c8VdOfC8be0iA9vJUGaf4vPmji1oQh436i5fAXvNsWFBABAAA=","checkText","fixtures.ts"],
  ["p11-pdf","pdf_py","refusal","refusal","H4sIAAAAAAAC/y2PTXOCMABE7/0Vjqd27IwgtNV2elAwGJKgSTB83IJYGoxAqxX019dp3fPbN7sAxuGazXvvvfu73jX9XB7lq2warTbyqOpq2OQfb5k8bJ/tx/4/4ovZnCmjwyVF/haXlwlBhE9b6E2ULOrxypmeQk/8pBaroZuY0Jl4MuqMNIYFNtLDTZPETDNPlNmIaejaA6cKjM1efGa0sasFQet8ZhGTtgGAkAvSBiZsZy+AA5c6vFvim4ZrhDeqFkpDPK6PCAT4rDrKd1YQ7oZL7JRU0G+4judkOmAJJ22jsz275AtfJ5GBbpo0etplI//Lqdg5ifThOhat3LbApn/KLFr8HQSwWJU28rkAoZFcqw+/fW17lUABAAA=","checkText","fixtures.ts"],
  ["p11-pdf","pdf_js","refusal","refusal","H4sIAAAAAAAC/y3PTXKCMABA4X1PwbC1M4LQVut0oSAYkqBJNAg7/qTBCFRQ0NO30/EC37yXD0196ZS0rtpOOYqhu15y5UtRs7iLP+OmkSKNO1FX4yY7zpO4zd/NV1UZvSiK6vHligptQCWBXo7KxwxDzBY9cGciLurp1lrcdi6/RgatgR3qwJq5cTBo0QEUSIvaJxMeqKQuL5MJlcA2R1bla+mZfyekMas1hvtsaWCd9L4DAOO493XQLz8c5tjEYsMGPRkmIUpFzYUEaFp30PHRXQyEnQx/dxpvkFUSTi5gf1jhxYiGDPeNTM70ka09GQYafDJR8HZKJt6PVdF7GMj2LxZu7b5AundLDFL8Dzqg2JYm9Bh3dloI1fkvKYlyxEYBAAA=","checkText","fixtures.ts"],
  ["p11-pdf","pdf_q_nl","refusal","refusal","H4sIAAAAAAAC/yWQQXKCMAAA77yi49XOCEJbaa0zCoIhCZpEg3BLwFIwAq1U0Ne3Ti973t1pLctD2j5kohXvgztfRdOoIhVtUVejJvt4k+J8eLYetYAvlrTQe1QSGBxQebMxxGzeAd8uRF5PNs78svX5T2LSGrixARzbF1GvJ3uQIz05x3uqqM9LOaZKA641dKpQT0/8U5LGqlYY7rKFiQ3ShR4AjOMuNEC3ePGY5xKH9WvEFERpUfNCATSpW+iF6Fr0hGlHM9weR2vklISTb7DbL/F8SGOGu0bJE71lq0DFkQ6T6Okox8GXU9FrHKnznxncuF2OjOAiTZLfazTggXxTWjBg3NvqMRzMpqP/SbNf8cKScS0BAAA=","checkText","fixtures.ts"],
  ["p11-pdf","pdf_q_w76","refusal","refusal","H4sIAAAAAAAC/yWQQXKCMAAA776i49XOCEJbba0zCoIhCZpEg3BLwNJgBFqpoK9vnV72vLvTShaHtHnIRCPe+3e+irrWKhWNqsphnX28SXE+PNuPAV8sqTI6VBAYHFBxm2CI2bwF/kSJvBpvnPll6/OfxKIVcGMTOBNfRJ2R7EGOjOQc76mmPi/kiOoecO2BU4ZGeuKfktR2ucJwly0sbJI29ABgHLehCdrFi8c8lzisWyOmIUpVxZUGaFw10AvRVXWE9Y5WuD0O18gpCCffYLdf4vmAxgy3tZYnestWgY4jAybR01GOgi+npNc40uc/M7hx2xyZwUVaJL/X9IAH8k1hw4Bxb2vEsD+bDv8fzX4BtONzBCwBAAA=","checkText","fixtures.ts"],
  ["p11-pdf","zip_one","refusal","refusal","H4sIAAAAAAAC/0tJLEm0SiwoyMlMTizJzM/Tr8ossE5KLE41M9EJdS12cXIKdAQCT0cwcIksyi+pAnOcTECkF4hIyrU0iIrwLU3xyDCorNQPCK40DA52rfIPCTX296ksCKz0LS8KDjb2DraoCKr0LS4DsnMd0x1tAUaU5Rh8AAAA","checkText","fixtures.ts"],
  ["p11-pdf","zip_py","refusal","refusal","H4sIAAAAAAAC/3PzjAgJDXJVsFXQ4FIAAqWUxJJEq8SCgpzM5MSSzPw8/arMAuukxOJUMxMdJYiSUNdiFyenQEcg8HQEA5fIovySKjDHyQREeoGIpFxLg6gI39IUjwyDykr9gOBKw+Bg1yp/qDEhocb+PpUFgZW+5UXBwcbewRYVQZW+xWVAdq5juqOtEpcmAFxh6KyeAAAA","checkText","fixtures.ts"],
  ["p11-pdf","zip_js","refusal","refusal","H4sIAAAAAAAC/0utKMgvKlFIzs8rLlFIy6woKS1KVbBVUEpJLEm0SiwoyMlMTizJzM/Tr8ossE5KLE41M9FRUtDmUlBQCnUtdnFyCnQEAk9HMHCJLMovqQJznExApBeISMq1NIiK8C1N8cgwqKzUDwiuNAwOdq3yhxoTEmrs71NZEFjpW14UHGzsHWxREVTpW1wGZOc6pjvaKlkDAKfqrfKkAAAA","checkText","fixtures.ts"],
  ["p12-buffer","pdf_py_buffer","refusal","refusal","H4sIAAAAAAAC/y2PTXOCMABE7/4Kp6d27IwgtNV2elAwGJKgSTB83IJYGoxAqxX019dp3fPbN7sAxuGazfvv/fte/5q7XB7lq2warTbyqOpq2OQfb5k8bJ/tx7t/xBezOVNGh0uK/C0uLxOCCJ+20JsoWdTjlTM9hZ74SS1WQzcxoTPxZNQZaQwLbKSHmyaJmWaeKLMR09C1B04VGJu9+MxoY1cLgtb5zCImbQMAIRekDUzYzl4ABy51eLfENw3XCG9ULZSGeFwfEQjwWXWU76wg3A2X2CmpoN9wHc/JdMASTtpGZ3t2yRe+TiID3TRp9LTLRv6XU7FzEunDdSxauW2BTf+UWbT4OwhgsSpt5HMBQiO5Vh96v39w9hxBAQAA","checkBuffer","tests/fixtures.py"],
  ["q2","js_call_args","quiet","private","H4sIAAAAAAAC/y2Oy26DMBBF9/0KxKpVIxFUmiaNsjDE4ZUAtuu0dGcedSkUSIgC5OuLK89i5t6Zo6upGpa5v4zn92rGLuy1EFpra75OWJcvjJmqPN4piloczRD3c9/mDZgqIPQbUi4kFM20QCzml8R3KfGEBx8BwXMXnDsjXSCxwDWiugmANfz016XEY0TFrckrHGcwuCbvepXUE+8U6ThqERl1QuAtlPgbfQr3Y4uINWD/8OLux9IG9glZwXByVpEvsra0ghJHR2zUdmTcltve6cFuitWKz3Ll/D9kepg+w3PpcYlzvtmoM6VpL0VTdw/rPy+2TzEjAQAA","checkText","doc.md"],
  ["q2","js_call_args_lead","quiet","private","H4sIAAAAAAAC/y2Oy26DMBBF9/0KxKpVIxFUmiaNsjDE4ZUAtuu0dGcedSkUSIgC5OuLK89i5t6Zo6upGpa5v4zn92rGLuy1EFpra75OWJcvjJl6pyiPiloczRD3c9/mDZgqIPQbUi4kFM20QCzml8R3KfGEBx8BwXMXnDsjXSCxwDWiugmANfz016XEY0TFrckrHGcwuCbvepXUE+8U6ThqERl1QuAtlPgbfQr3Y4uINWD/8OLux9IG9glZwXByVpEvsra0ghJHR2zUdmTcltve6cFuitWKz3Ll/D9kepg+w3PpcYlzvtmoM6VpL0VTdw/rP3NbIgAjAQAA","checkText","doc.md"],
  ["q2","yaml_comment","quiet","private","H4sIAAAAAAAC/x2OTXOCMBiE7/0VGb12BhmpVTseAkYQLJCksaU3QJqm0MSvEeKvb9I9vLuz88zOK2oll2B0KK/lUvyWvHGOkr9U5aWZeY9i72eknyQhV9AopewbMW4jsscPYGH96wGATU1jm+FHSslkC88Xr55hWxCJmetDGAw//W1u0AIz26umI8UBpbfq3e0qadhI1Fo7OdUupeieGfSNTbOdPmIaDCR5fd7udBvC8ISDdDhFizyxO2vWIYPiPfFkmHv3+bqPergxc474bBfR/xN+TNgTOrcxNyjnq9UIgDHoFFd/GDMLYAEBAAA=","checkText","doc.md"],
  ["q2","prose_after","quiet","private","H4sIAAAAAAAC/x2PQXOCMBCF7/kVjOdOkSm12o6HgBEECyQxtvQGmMYUCioKxF9f0j28ffPNztt5uyM3uqy6cWNyyK7Zq/zNBDdPtXjLs5bP7Ae5d2LST0NPNHCciLIjYkJbpMVxYar3N1gXNNAOfkaUTDfw0trFDGtAaswsB0J3+Om7OUgx07ThFUkPKOryD6vK6/HSl4VSZkKVRSm6x2DHnuKtOmHqDiR8f9lsVelB74zdaDj7iyTUKStWIYD3xK69xL7PV73fw/UYZcqvcuH/v3cCwp7RpQwEEGK5nBiyNa5j7aoRzeMfov7tnwABAAA=","checkText","doc.md"],
  ["q2","json_inline_trailing","quiet","private","H4sIAAAAAAAC/x2PX2+CMBTFv4rpswmSMacuPhSsIDig7erGwgsg6xh48c8iVLPvPrr7cO7JLzcn99xRVbSAFiO0z36yRXXIZGkcQT7n2aWcWuNqZ0esmwSubPEwIRdfREhtiRbbwYnenymsC+5ri99DziYbfL5YxZRqwIAK08bY6b+76yyFhAqN27JhyZ6E1/zNbHIYTr2qUMqIuTI5J7cohVfxEG3VkXKnZ8HL02arahe7J+qE/cmbx4GOWYmGpEB3zAI3tm6zVed1eD2EGdVHPff+P7B9Jh7JufZlClIul2g8QpAdSt27R79/n0LBggUBAAA=","checkText","doc.md"],
  ["q2","js_obj","quiet","quiet","H4sIAAAAAAAC/y2OT0+DQBDF736KCZceNGmJqP0TDgvdQqECu+tW6a1ddUUIWGgKW+N3l22Yw5uZN7+8jKjK5gQV2PALTS3mYGRbJ6btJPRkhfqKGP/CXOoRa3FclOr+acDtDYCxEizQO3qLGJ2sUd1Y4pFog5aEmw5CbvfdnqcDnhKub9VHQdN3HJ0Pr2ZxKHvez4RS44QpkzF8iQf8hd/HG/VDmNvR8PlpvVG5h7wjcaPu6M+SUGcteYEHnGypVXqJdZkuW79Fqz52nO3ymX99yAkof8B1HsgBl9K2jTvYF6c5jLoR/C3+AW/HFAYPAQAA","checkText","doc.md"],
  ["q2","js_endcomma_nl","quiet","quiet","H4sIAAAAAAAC/y2OT2+CQBDF736KCRcPbaKktJUYDgusIFhgd7u01HiB6pZCoP6JsH562YY5vJl588vLFG1zvkALFmxBK1M7pt089ESLhooY/8FcqBErsR2UqX7Q4GECoK0KFqgdfUaMztfodDaKF6IM2hCu2wg5/W93XYx4Rri6tfuaZt84uuYfep03A++XhZSzhEmdMXyLR/ydP8Ub+UeY09Pw7XW9kZWHvCNxov7om0moslxe4xEnKTUaLzFuC7fzO7QaYmflV2X6/w/ZAeXP+FQFYsSFsCztcQLTfAq75R2PoXXzBgEAAA==","checkText","doc.md"],
  ["q2","py_dict","quiet","private","H4sIAAAAAAAC/x2PTVODMBCG7/6K3HLpDGXE2o/hEGgKhQokMVW88WVEkH45hdTxv8u6h913d595Z7dENvrBGV4iXGbf2bL+ylRlHDu1yrNLNbMm9d6JeT8NPXUgY0RCflCpQFJIjktSqO/4DuFNIQJoyGsk+HRLzhermDEY8I5J0yHEHT776xzYlElYHKqWpyWNrvmL2ebdCPt1obWRCG0KQW8xsM/yPt7pIxPuwMOnx+1ONx7xTsyNhpO/SEIwWsuWAsv23Oq8xLrN173fk81oaNRvzcL/v8MJuHyg5yZQwCpl23iCcD6+b/7+AQAY2pwLAQAA","checkText","doc.md"],
  ["q2","py_dict_clean","quiet","private","H4sIAAAAAAAC/x2OTVODMBCG7/4Kbrk4Q5libetwCDSFQgWSmCrewocRQfrlFFLH/y7bPby7++4z72xpOMYvkmhpoFL+yGX9LVVlHjr1lMtzNbPv652bsH4S+WqPx4q5+CRCwUhAXA9n0D/QnYHWBQ9hwW8xZ5MNPp3tYkbBYB0VlouxN3z1lzmwGRVw2Fcty0oSX/JXq827EQ7qQmsz5drinFwTYF/ENNnqA+XewKLnx81WNz72j9SLh2OwSCMIWomWAEt3zO781L7OV33Q4/UYaNbvzSK4/eGGTDyQUxMqYJVyHPT3D26G+wMDAQAA","checkText","doc.md"],
  ["q2","closing_then_paren_comma","quiet","private","H4sIAAAAAAAC/x2Oza6CMBCF9/cp3KGJCRLRq964KFhBUKDtrYo7QKwI4m+E+vQyzuLMzJkvJ3NoK/voGU2ycyRS9VqKvzh6pEO9m60Nn1Y91xIX1JTH+BFzASMGMUwUQj8oPy1lnjAHFrT1GO0t0P2hJ0MCBi0J1wyEzPpUvUbAhoTD4ZIWNNxj7xVvtCIuG9jOEinVgEmNMfz2gf3nfX8pr4SZNXVXv4ulzC1k3Yjp1Td7HLgQNOMFBpasqV5agf4ezSq7QvMmUM12+dj+/mE4lA/wPXcEsEJMp0qn2xLtzgeluaPHAAEAAA==","checkText","doc.md"],
];
const round22Outcome = (hits: string[]) => [...new Set(hits.map((hit) => hit.includes("private term") ? "private" :
  hit.includes("secret shape") ? "secret" : "refusal"))].sort().join("+") || "quiet";
for (const [item, probes] of [
  ["OP1 bounded bodies", ["p2-emptyfirst", "p3-mixed", "p8-concat", "p11-pdf", "p12-buffer"]],
  ["OP1 ordinary documentation", ["p10-ordinary", "q2"]],
  ["OP2 opening whitespace", ["p4-opening"]],
  ["OP3 padded segments", ["p7-padding"]],
  ["OP4 tolerant bodies", ["p1-damaged"]],
  ["OP5 term-independent truncation", ["p5-termdep"]],
] as const)
  test(`round 22 ${item}: every review witness`, () => {
    for (const [probe, name, off, on, packed, method, file] of round22Corpus) {
      if (!(probes as readonly string[]).includes(probe)) continue;
      const body = zlib.gunzipSync(Buffer.from(packed, "base64")).toString("utf8");
      for (const [terms, expected] of [[empty, off], [round16Terms, on]] as const) {
        const hits = method === "checkBuffer" ? checkBuffer(Buffer.from(body), file, terms, true, true) : checkText(body, file, terms);
        assert.equal(round22Outcome(hits), expected, `${probe}/${name}, ${terms.terms.length} terms: ${hits.join("; ")}`);
      }
    }
  });

test("round 22 OP1: only explicit bounded chains refuse, retaining their longest valid prefix", () => {
  for (const terms of [empty, round16Terms]) {
    for (const separator of [" +\n", " .\n", " ..\n", " &\n", "\n"]) {
      const body = `"${round20BinaryPrefix}AAECAwQF"${separator}"BgcICQoL"${separator}"!"`;
      assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), "refusal", separator);
    }
    for (const body of [
      `["${round20BinaryPrefix}AAECAwQF",\n "BgcICQoL"]`,
      `icon: "${round20BinaryPrefix}AAECAwQF"\nsettings: "BgcICQoL"`,
    ]) assert.deepEqual(checkText(body, "fixture.md", terms), []);
    assert.equal(round22Outcome(checkText(`"${round20BinaryPrefix}AAAAAAAA\n AAAAAAAAA"`, "fixture.md", terms)), "refusal");
  }
});

test("round 22 OP3: scan both concatenated padded bytes and individual segments", () => {
  const token = ["em", "_", "A".repeat(43)].join("");
  for (const parts of [["x", " " + token, "BBBB"], [" key " + token.slice(0, 5), token.slice(5)]]) {
    assert.ok(parts[0]!.length % 3, "the first segment must be padded");
    const body = `"${round19Prefix}${parts.map((part) => Buffer.from(part).toString("base64")).join("\n")}"`;
    assert.ok(checkText(body, "fixture.md", empty).some((hit) => hit.includes("secret shape")));
  }
});

// Round 22.2: synthetic gz.ts / seg.ts witnesses, with active data URIs built at runtime.
const round22cTerm = ["acme", "corp"].join("");
const round22cPublic = Buffer.from("public fixture").toString("base64");
const round22cGzip = zlib.gzipSync(Buffer.from(`owner ${round22cTerm} at shots\n`)).toString("base64");
const round22cCleanGzip = zlib.gzipSync(Buffer.from("plain public fixture text\n")).toString("base64");
const round22cImagePrefix = ["data", "image/png;base64,"].join(":");
const round22cGzipPrefix = ["data", "application/gzip;base64,"].join(":");
const round22cPng = (() => {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
})();
const round22cWitnesses: readonly (readonly [string, string, string])[] = [
  ["one_gz_oct_q", `"${round20BinaryPrefix}${round22cGzip}"`, "refusal"],
  ["one_gz_gzip_q", `"${round22cGzipPrefix}${round22cGzip}"`, "refusal"],
  ["one_gz_oct", `${round20BinaryPrefix}${round22cGzip}`, "refusal"],
  ["pad_nl_gz_q", `"${round20BinaryPrefix}${round22cPublic}\n${round22cGzip}"`, "refusal"],
  ["pad_nl_gzip_q", `"${round22cGzipPrefix}${round22cPublic}\n${round22cGzip}"`, "refusal"],
  ["pad_nl_gz_unq (known limit: speculative unquoted join)", `${round20BinaryPrefix}${round22cPublic}\n${round22cGzip}`, "quiet"],
  ["pad_nl_gzc_q", `"${round20BinaryPrefix}${round22cPublic}\n${round22cCleanGzip}"`, "refusal"],
  ["pad_nl_text_q", `"${round19Prefix}${round22cPublic}\n${round22cGzip}"`, "refusal"],
  ["chain_gz_js", `const icon = "${round20BinaryPrefix}${round22cPublic}" +\n  "${round22cGzip}";`, "refusal"],
  ["chain_gz_adj", `static const char *icon =\n  "${round20BinaryPrefix}${round22cPublic}"\n  "${round22cGzip}";`, "refusal"],
  ["png_then_gz_q", `"${round22cImagePrefix}${round22cPng}\n${round22cGzip}"`, "refusal"],
  ["png_then_gz_html", `<img src="${round22cImagePrefix}${round22cPng}\n${round22cCleanGzip}">`, "refusal"],
  ["sp_gz_q", `"${round20BinaryPrefix}${round22cPublic} ${round22cGzip}"`, "refusal"],
  ["ctl_two_text_q", `"${round19Prefix}${round22cPublic}\n${Buffer.from("second public fixture line").toString("base64")}"`, "quiet"],
  ["ctl_json_list", `["${round19Prefix}${round22cPublic}", "${round22cGzip}"]`, "quiet"],
  ["ctl_yaml_list", `icons:\n  - "${round19Prefix}${round22cPublic}"\n  - "${round22cGzip}"`, "quiet"],
  ["ctl_dots_q", `"${round19Prefix}${round22cPublic}\n...more"`, "quiet"],
  ["ctl_prose_pad_q", `He said "${round19Prefix}aGk=\nInternationalization\nprose before an unrelated closing quote"`, "refusal"],
  ["ctl_two_uris_py", `ICONS = """\n${round22cImagePrefix}${round22cPng}\n${round19Prefix}${round22cPublic}\n"""`, "quiet"],
  ["md_quote_prose", `He said "${round19Prefix}aGVsbG8\nand then some prose about Internationalization\nuntil the next quote" ends.`, "quiet"],
  ["md_quote_prose2", `Use "${round19Prefix}cHVibGlj" for small icons.\nThe "quoted" word is fine.`, "quiet"],
];

test("round 22.2: bounded padded witnesses refuse opaque segments and preserve documentation controls", () => {
  for (const [name, body, expected] of round22cWitnesses)
    for (const terms of [empty, round16Terms])
      assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), expected, `${name}, ${terms.terms.length} terms`);
});

test("round 22.2 / 22.3: bounded prefixes and interior segments cannot retain single-line exemptions", () => {
  for (const terms of [empty, round16Terms]) {
    for (const [tail, expected] of [
      ["A".repeat(15), "refusal"], ["A".repeat(16), "refusal"], ["A".repeat(17), "refusal"],
      ["A".repeat(16) + "===", "refusal"], ["A".repeat(15) + "=", "refusal"],
      ["A".repeat(14) + "=", "refusal"], ["A".repeat(14) + "==", "refusal"],
      [round22cGzip + "!", "refusal"], [round22cGzip + "_", "refusal"],
      ["_" + "A".repeat(15), "quiet"],
      // Known limit: a padding-only line between the public first line and the body
      // keeps the body quiet, as on main and on 44aead6.
      [round22cGzip + "A", "refusal"], ["=\n" + round22cGzip, "quiet"],
      ["iVBORw0KGgoAAAANSUhEU", "refusal"], ["AAAA", "quiet"],
    ]) {
      const body = `"${round22cImagePrefix}${round22cPublic}\n${tail}"`;
      assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), expected, `${tail.length}: ${expected}`);
    }
    for (const first of ["aGk==", "aGk===", "A=", "="])
      assert.equal(round22Outcome(checkText(`"${round20BinaryPrefix}${first}\n${round22cGzip}"`, "fixture.md", terms)), "refusal");
    for (const operator of ["+", ".", "..", "&", ""])
      assert.equal(round22Outcome(checkText(`"${round20BinaryPrefix}${round22cPublic}" ${operator}\n"${round22cGzip}"`, "fixture.md", terms)), "refusal", operator);
  }
});

test("round 22.2: padded segment judgments reuse decoded bytes within the unchanged work bounds", (t) => {
  for (const malformed of [false, true]) {
    let previousWork = 0;
    for (const count of [512, 1024, 2048]) {
      // Short binary headers, truncated PNGs and bad padding exercise all prefix-check paths.
      const body = `"${round22cImagePrefix}${round22cPublic}\n${Array.from({ length: count }, (_, index) =>
        malformed ? "AA===" : index % 2 ? "iVBORw0KGgo=" : "AA==").join("\n")}"`;
      const budget = new ScanBudget();
      let decodes = 0, decodedCharacters = 0;
      const from = Buffer.from;
      const allocations = t.mock.method(Buffer, "from", function (value: never, encoding: never) {
        if (typeof value === "string" && (encoding === "base64" || encoding === "base64url")) {
          decodes++; decodedCharacters += value.length;
        }
        return from(value, encoding);
      });
      try {
        assert.equal(round22Outcome(checkText(body, "fixture.md", empty, { budget })), malformed ? "quiet" : "refusal");
        assert.ok(decodes <= 6, `constant readings: ${decodes}`);
        assert.ok(decodedCharacters <= 6 * body.length);
        assert.ok(budget.inlineTerminatorWork <= 14 * body.length);
        if (previousWork) assert.ok(budget.inlineTerminatorWork <= previousWork * 2.1);
        previousWork = budget.inlineTerminatorWork;
      } finally { allocations.mock.restore(); }
    }
  }
});

const round23Terms: PrivateTerms = { terms: [{ value: "synthetic-unrelated", line: 1 }], allowed: [], notes: [] };
const round23B64 = (value: string | Buffer) => Buffer.from(value).toString("base64");
const round23Token = ["em", "_", "A".repeat(43)].join("");
const round23Short = ["xo", "xb-", "a"].join("");
const round23ShortBody = round23B64("hello " + round23Short) + "A";
const round23Witnesses: readonly (readonly [string, string, string])[] = [
  ["CX1 padded boundary", `"${round19Prefix}${["  " + round23Token.slice(0, 5), round23Token.slice(5), "BBBB"].map(round23B64).join("\n")}"`, "secret"],
  ["CX1 padded end without line break", `"${round19Prefix}${round23B64("  " + round23Token.slice(0, 5))}\n${round23B64(round23Token.slice(5))}${round23B64("BBBB")}"`, "secret"],
  ["CX2 short malformed secret", `"${round19Prefix}${round23ShortBody.slice(0, 8)}\n${round23ShortBody.slice(8)}"`, "secret"],
  ["CX2 short malformed first line", `${round19Prefix}${round23ShortBody}`, "refusal+secret"],
  ["CX3 segmented literal prefix", `"${round19Prefix}${round22cPublic}" + "${round23B64(Buffer.alloc(30, 128))}" + "!"`, "refusal"],
  ["CX4 incomplete first line", `"${round19Prefix}${round22cPublic.slice(0, 17)}\n${round22cPublic.slice(17)}\n${round23B64("second public fixture line")}"`, "quiet"],
];
for (const [name, body, expected] of round23Witnesses)
  test(`round 22.3 ${name}`, () => {
    for (const terms of [empty, round23Terms]) assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), expected);
  });

test("round 22.3 CX2: malformed terms remain visible", () => {
  const termBody = `"${round19Prefix}${round23B64("hello " + round22cTerm).replace(/=+$/, "")}AA"`;
  assert.deepEqual(checkText(termBody, "fixture.md", empty).filter((hit) => hit.includes("private term")), []);
  assert.ok(checkText(termBody, "fixture.md", round16Terms).some((hit) => hit.includes("private term")));
});

test("round 22.3 OP3: byte-view and normalization budgets ignore term-list presence", () => {
  const expanding = Buffer.concat([Buffer.from("\ufdfa".repeat(128), "utf16le").swap16(), Buffer.from("%41\0")]);
  for (const terms of [empty, round23Terms]) {
    const skipped = new ScanBudget(4096);
    assert.deepEqual(checkBuffer(Buffer.alloc(1024), "fixture.bin", terms, true, true, 0, skipped), ["fixture.bin: binary file of unknown type"]);
    assert.equal(skipped.remaining, 4096);
    assert.throws(() => checkBuffer(expanding, "fixture.bin", terms, true, true, 0, new ScanBudget(32 * expanding.length)), /budget/);
  }
  const bytes = Buffer.from("plain public fixture text line\n".repeat(Math.ceil(3600 * 1024 / 31))).subarray(0, 3600 * 1024);
  const half = Math.floor(bytes.length / 2);
  const text = `x = "${round19Prefix}\n${round23B64(bytes.subarray(0, half - 1))}\n${round23B64(bytes.subarray(half))}";`;
  for (const terms of [empty, round23Terms]) assert.throws(() => checkText(text, "fixture.md", terms, { budget: new ScanBudget() }), /budget/);
});

test("round 22.3 ER1: every separate segment inspection spends a fixed shared budget", () => {
  for (const terms of [empty, round23Terms]) {
    const chain = (count: number) => `(\n"${round22cImagePrefix}AA==\\"\n${'"AAAA=="\n'.repeat(count)})`;
    assert.deepEqual(checkText(chain(2048), "fixture.md", terms), []);
    assert.throws(() => checkText(chain(20000), "fixture.md", terms, { budget: new ScanBudget() }), /budget/);
    const quoted = (count: number) => `"${round22cImagePrefix}AA==\n${"AAAA==\n".repeat(count)}"`;
    assert.throws(() => checkText(quoted(20000), "fixture.md", terms, { budget: new ScanBudget() }), /budget/);
  }
});

const round23Gzip = (() => {
  let state = 17;
  const bytes = Buffer.from(Array.from({ length: 3000 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 24;
  }));
  return zlib.gzipSync(bytes);
})();
const round23Mod1 = (() => {
  let body = round23B64(round23Gzip).replace(/=+$/, "");
  while (body.length % 4 !== 1) body += "A";
  return body;
})();
const round23Wrapped = round23Mod1.match(/.{1,76}/g)!.join("\n");
const round23Opaque = round23B64(Buffer.concat([Buffer.from(round22cGzip, "base64"), Buffer.alloc(200, 0x9c)]));
const round23Prefixes: readonly (readonly [string, string])[] = [
  ["mod1_oneline_q", `x = "${round20BinaryPrefix}${round23Mod1}";`],
  ["mod1_nl_q", `x = "${round20BinaryPrefix}\n${round23Mod1}";`],
  ["mod1_nl_wrapped_q", `x = "${round20BinaryPrefix}\n${round23Wrapped}\n";`],
  ["mod1_html_wrapped", `<img src="${round22cImagePrefix}\n${round23Wrapped}">`],
  ["mod1_clean_first_q", `x = "${round20BinaryPrefix}QUJD\n${round23Wrapped}";`],
  ["mod1_firstline76_q", `x = "${round20BinaryPrefix}${round23Wrapped}";`],
  ...["A=", "aGk==", "aGk===", "="].map((first): [string, string] => [
    `malformed first ${first}`, `x = "${round20BinaryPrefix}${first}\n${round23Opaque}";`,
  ]),
  ["mid_star", `x = "${round20BinaryPrefix}\n${round23Opaque.slice(0, 40)}*${round23Opaque.slice(40)}";`],
  ["mid_bang_nl", `x = "${round20BinaryPrefix}\n${round23Opaque.slice(0, 40)}\n!\n${round23Opaque.slice(40)}";`],
];
test("round 22.3 OP1: damaged bounded bodies retain a strictly valid prefix without absorbing prose", () => {
  for (const terms of [empty, round23Terms]) {
    for (const [name, body] of round23Prefixes) assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), "refusal", name);
    for (const [name, body, expected] of round22cWitnesses.filter(([name]) => name.startsWith("md_quote_prose") || name === "ctl_dots_q"))
      assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), expected, name);
  }
});

const round23Chunks = (bytes: Buffer, width: number) => Array.from({ length: Math.ceil(bytes.length / width) }, (_, i) =>
  round23B64(bytes.subarray(i * width, (i + 1) * width)));
const round23SegmentBytes = Buffer.concat([Buffer.from(round22cGzip, "base64"), Buffer.alloc(40, 0x9c)]);
const round23S8 = round23Chunks(round23SegmentBytes, 8);
const round23Jpeg = round23Chunks(Buffer.concat([Buffer.from(round22cGzip, "base64"), Buffer.alloc(300, 0x9c)]), 83)
  .map((part) => round23B64(Buffer.concat([Buffer.from([255, 216, 255, 224, 255, 255]), Buffer.from(part, "base64")])));
const round23SegmentWitnesses: readonly (readonly [string, string])[] = [
  ["oneline_q", `x = "${round20BinaryPrefix}${round23S8.join("")}";`],
  ["firstseg_q_nl", `x = "${round20BinaryPrefix}${round23S8.join("\n")}\n";`],
  ["firstseg_q_one2", `x = "${round20BinaryPrefix}${round23S8[0]}\n${round23S8.slice(1).join("")}";`],
  ["empty_q_line2", `x = "${round20BinaryPrefix}\n${round23S8.join("")}";`],
  ["empty_q_ind", `x = "${round20BinaryPrefix}\n    ${round23S8.join("")}\n";`],
  ["chain_plus", `x = "${round20BinaryPrefix}${round23S8[0]}"\n + "${round23S8.slice(1).join("")}";`],
  ["chain_dot", `x = "${round20BinaryPrefix}${round23S8[0]}"\n . "${round23S8.slice(1).join("")}";`],
  ["chain_adj_py", `x = ("${round20BinaryPrefix}${round23S8[0]}"\n "${round23S8.slice(1).join("")}")`],
  ["chain_each", `x = "${round20BinaryPrefix}"\n${round23S8.map((part) => ` + "${part}"`).join("\n")};`],
  ["img_png_q", `<img src="${round22cImagePrefix}\n${round23S8.join("")}">`],
  ["text_q", `x = "${round19Prefix}\n${round23S8.join("")}";`],
  ["jpeg_oneline_all", `x = "${round20BinaryPrefix}${round23Jpeg.join("")}";`],
  ["jpeg_q_nl", `x = "${round20BinaryPrefix}${round23Jpeg.join("\n")}\n";`],
  ["jpeg_q_empty", `x = "${round20BinaryPrefix}\n${round23Jpeg.join("")}";`],
  ["jpeg_img_empty", `<img src="${round20BinaryPrefix}\n${round23Jpeg.join("\n")}">`],
  ["accepted next literal", `"${round22cImagePrefix}iVBORw0KGgo=" + "next"`],
];
test("round 22.3 OP2: only a first segment equal to the first line keeps header and truncation exemptions", () => {
  for (const terms of [empty, round23Terms]) {
    for (const [name, body] of round23SegmentWitnesses) assert.equal(round22Outcome(checkText(body, "fixture.md", terms)), "refusal", name);
    assert.deepEqual(checkText(`"${round20BinaryPrefix}${round23Jpeg[0]}"`, "fixture.md", terms), []);
  }
});

test("round 22.3 CX5: mixed bounded readings keep six decodes and the unchanged work bounds", (t) => {
  for (const terms of [empty, round23Terms]) {
    let previousWork = 0;
    for (const n of [512, 1024, 2048]) {
      const plain = round23B64("public".repeat(n)), padded = round23B64("public!".repeat(n));
      const body = `"${round19Prefix}${plain}\n+${plain}\n.${padded}" +\n"${plain}" +\n"!"`;
      const budget = new ScanBudget();
      let decodes = 0, decodedCharacters = 0;
      const from = Buffer.from;
      const allocations = t.mock.method(Buffer, "from", function (value: never, encoding: never) {
        if (typeof value === "string" && (encoding === "base64" || encoding === "base64url")) { decodes++; decodedCharacters += value.length; }
        return from(value, encoding);
      });
      try {
        assert.equal(round22Outcome(checkText(body, "fixture.md", terms, { budget })), "refusal");
        assert.ok(decodes <= 6, `constant readings: ${decodes}`);
        assert.ok(decodedCharacters <= 6 * body.length);
        assert.ok(budget.inlineTerminatorWork <= 14 * body.length);
        if (previousWork) assert.ok(budget.inlineTerminatorWork <= previousWork * 2.1);
        previousWork = budget.inlineTerminatorWork;
      } finally { allocations.mock.restore(); }
    }
  }
});

const finalTerm = ["acme", "corp"].join("");
const finalTerms: PrivateTerms = { terms: [{ value: finalTerm, line: 1 }], allowed: [], notes: [] };

test("final B: percent decoding never hides literal private terms", () => {
  for (const text of [`100%${finalTerm}`, `x %${finalTerm} y`, `%${finalTerm.slice(0, 2).toUpperCase()}${finalTerm.slice(2)}`]) {
    for (const generic of [false, true])
      assert.deepEqual(checkText(text, "fixture", finalTerms, { generic }), ["fixture: private term (file line 1)"]);
    const start = text.toLowerCase().indexOf(finalTerm);
    assert.deepEqual(checkTextSpans(text, finalTerms), [{ start, end: start + finalTerm.length, label: "private term (file line 1)" }]);
  }
});

test("final B: literal and decoded views keep allowed phrases and original offsets", () => {
  const terms = { ...finalTerms, allowed: [finalTerm + "/public"] };
  for (const text of [`100%${finalTerm}/public`, `%61${finalTerm.slice(1)}/public`])
    assert.deepEqual(checkText(text, "fixture", terms), []);
  const text = `100%${finalTerm}/public\n%61${finalTerm.slice(1)}/private\nx %${finalTerm.toUpperCase()} y`;
  assert.deepEqual(checkText(text, "fixture", terms, { columns: true }), [
    "fixture:2:1: private term (file line 1)", "fixture:3:4: private term (file line 1)",
  ]);
  const exact = `100%${finalTerm}`;
  assert.deepEqual(checkText(exact, "fixture", { ...finalTerms, allowed: [exact] }), []);
  assert.deepEqual(checkText(finalTerm + "/public", "fixture", { ...finalTerms, allowed: [`%61${finalTerm.slice(1)}/public`] }), []);
  // A partial allowed match inside one expanded Unicode character never covers a longer term.
  assert.deepEqual(checkText("%20\ufb03", "fixture", { ...empty, terms: [{ value: "ff", line: 1 }], allowed: ["f"] }),
    ["fixture: private term (file line 1)"]);
});

for (const space of ["%20", "&nbsp;"])
  test(`last 1: allowed phrases cover source spans across ${space} views`, () => {
    const terms = { ...finalTerms, allowed: [finalTerm + " public"] };
    const allowed = `${finalTerm}${space}public`;
    for (const generic of [false, true]) assert.deepEqual(checkText(allowed, "fixture", terms, { generic }), []);
    assert.deepEqual(checkTextSpans(allowed, terms), []);
    for (const text of [allowed + " " + finalTerm, finalTerm + " " + allowed]) {
      const start = text.startsWith(allowed) ? allowed.length + 1 : 0;
      for (const generic of [false, true])
        assert.deepEqual(checkText(text, "fixture", terms, { generic, columns: true }),
          [`fixture:1:${start + 1}: private term (file line 1)`]);
      assert.deepEqual(checkTextSpans(text, terms), [{ start, end: start + finalTerm.length, label: "private term (file line 1)" }]);
    }
  });

test("final B: all normalized views reserve the shared budget without terms too", () => {
  const text = `100%${finalTerm}`;
  for (const terms of [empty, finalTerms])
    assert.throws(() => checkText(text, "fixture", terms, { budget: new ScanBudget(Buffer.byteLength(text)) }), /budget/);
});

test("final D: tailnet IPv6 retains main's boundary after letters and underscores", () => {
  const address = ["fd7a", "115c", "a1e0", "", "53"].join(":");
  for (const text of [`addr_${address}`, `ip${address}`, `IP${address.toUpperCase()}`])
    assert.deepEqual(check(text), ["--text #1: private or tailnet IPv6 address (use 192.0.2.x or 2001:db8:: for documentation)"]);
  for (const prefix of ["a", "0", ":"]) assert.deepEqual(check(prefix + address), []);
  for (const prefix of ["addr_", "ip"]) for (const group of ["fc00", "fd12", "fe80"])
    assert.deepEqual(check(prefix + [group, "", "53"].join(":")), []);
});

test("final E: encoded line breaks never hide literal comment-leader terms", () => {
  for (const [text, value] of [
    ["see https://chat.fixture.test/?msg=hello%0A#zorb-ops", "#zorb-ops"],
    ["args%0A--zorb-flag", "--zorb-flag"],
  ]) {
    const terms = { ...empty, terms: [{ value, line: 1 }] };
    for (const generic of [false, true])
      assert.deepEqual(checkText(text, "fixture", terms, { generic }), ["fixture: private term (file line 1)"]);
    assert.deepEqual(checkTextSpans(text, terms), [{ start: text.indexOf(value), end: text.length, label: "private term (file line 1)" }]);
  }
});

test("final E: main-compatible normalization preserves leaders beside encoded spaces", () => {
  for (const newline of ["%0A", "%0D", "%E2%80%A8"]) for (const leader of ["#", "--", "//", "*", ">", ";"])
    for (const space of ["%20", "&nbsp;"]) {
      const value = `${leader}zorb ops`;
      const terms = { ...empty, terms: [{ value, line: 1 }] };
      const text = `args${newline}${leader}zorb${space}ops`;
      for (const generic of [false, true])
        assert.deepEqual(checkText(text, "fixture", terms, { generic }), ["fixture: private term (file line 1)"]);
      assert.deepEqual(checkTextSpans(text, terms), [{ start: 4 + newline.length, end: text.length, label: "private term (file line 1)" }]);
      assert.deepEqual(checkText(text + "/public", "fixture", { ...terms, allowed: [value + "/public"] }), []);
    }
});

test("final E: the main-compatible view shares the normalization budget", () => {
  const text = "args%0A#zorb%20ops";
  assert.throws(() => checkText(text, "fixture", empty,
    { generic: false, budget: new ScanBudget(2 * Buffer.byteLength(text)) }), /budget/);
});

const finalGlyph = Buffer.from(Array.from({ length: 40 }, () => [0, 3]).flat());
for (const kind of ["woff", "woff2"] as const)
  test(`final C: binary ${kind} glyph tables stay public as files and inline fonts`, () => {
    const bytes = fontFixture(kind, finalGlyph);
    for (const terms of [empty, finalTerms]) {
      assert.deepEqual(checkBuffer(bytes, `fixture.${kind}`, terms, false), []);
      assert.deepEqual(checkText(`${["data", `font/${kind};base64,`].join(":")}${bytes.toString("base64")}`, "fixture", terms), []);
    }
  });

test("last 2: PNG and non-font byte views retain combining-mark refusals", () => {
  const bytes = png(pngChunk("ruNs", finalGlyph));
  for (const terms of [empty, finalTerms]) {
    assert.deepEqual(checkBuffer(bytes, "fixture.png", terms, false), [
      "fixture.png:1: combining-mark run", "fixture.png:2: combining-mark run",
    ]);
    for (const file of ["fixture.bin", "fixture.woff"])
      assert.ok(checkBuffer(bytes, file, terms, false).some((hit) => hit.includes("combining-mark run")));
    assert.ok(checkBuffer(finalGlyph, "fixture.bin", terms, false).some((hit) => hit.includes("combining-mark run")));
    for (const mime of ["image/png", "font/woff"])
      assert.ok(checkText(`${["data", mime + ";base64,"].join(":")}${bytes.toString("base64")}`, "fixture", terms)
        .some((hit) => hit.includes("combining-mark run")));
  }
});

test("last 2: uncompressed font bodies retain glyph exemptions", () => {
  for (const kind of ["ttf", "otf"] as const) {
    const bytes = sfntFixture(kind, finalGlyph);
    bytes.write("glyf", 12);
    for (const terms of [empty, finalTerms]) {
      assert.deepEqual(checkBuffer(bytes, `fixture.${kind}`, terms, false), []);
      assert.deepEqual(checkText(`${["data", `font/${kind};base64,`].join(":")}${bytes.toString("base64")}`, "fixture", terms), []);
    }
  }
});

test("final C: private terms and secrets survive combining runs in binary font views", () => {
  const table = Buffer.concat([finalGlyph, Buffer.from(` ${finalTerm} ${secret}`, "utf16le")]);
  for (const kind of ["woff", "woff2"] as const) {
    const bytes = fontFixture(kind, table);
    for (const terms of [empty, finalTerms]) for (const hits of [
      checkBuffer(bytes, `fixture.${kind}`, terms, false),
      checkText(`${["data", `font/${kind};base64,`].join(":")}${bytes.toString("base64")}`, "fixture", terms),
    ]) {
      assert.ok(hits.some((hit) => hit.includes("secret shape")));
      assert.equal(hits.some((hit) => hit.includes("private term")), terms.terms.length > 0);
      assert.ok(hits.every((hit) => /private term|secret shape/.test(hit)));
    }
  }
});

test("final C: font names and metadata retain text-shape refusals", () => {
  const text = finalGlyph.toString("utf16le");
  for (const kind of ["woff", "woff2"] as const) {
    const named = fontFixture(kind, fontNameTable(text, 3), "name");
    const font = fontFixture(kind, Buffer.from("public glyph table"));
    const metadata = Buffer.from(`<metadata><text>${text}</text></metadata>`);
    const compressed = kind === "woff" ? deflateSync(metadata) : brotliCompressSync(metadata);
    const offset = Math.ceil(font.length / 4) * 4;
    const withMetadata = Buffer.concat([font, Buffer.alloc(offset - font.length), compressed]);
    const field = kind === "woff" ? 24 : 28;
    withMetadata.writeUInt32BE(withMetadata.length, 8);
    withMetadata.writeUInt32BE(offset, field);
    withMetadata.writeUInt32BE(compressed.length, field + 4);
    withMetadata.writeUInt32BE(metadata.length, field + 8);
    for (const bytes of [named, withMetadata]) for (const terms of [empty, finalTerms]) for (const hits of [
      checkBuffer(bytes, `fixture.${kind}`, terms, false),
      checkText(`${["data", `font/${kind};base64,`].join(":")}${bytes.toString("base64")}`, "fixture", terms),
    ]) assert.ok(hits.some((hit) => hit.includes("combining-mark run")));
  }
});

const assetTerm = "synthetic-private-term";
const assetTerms: PrivateTerms = { terms: [{ value: assetTerm, line: 1 }], allowed: [], notes: [] };

function seededAssetBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = 0x12345678;
  for (let at = 0; at < length; at++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes[at] = state & 255;
  }
  return bytes;
}

function rgbPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13), stride = 1 + width * 3;
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // RGB, eight bits per channel
  const rows = seededAssetBytes(stride * height);
  for (let at = 0; at < rows.length; at += stride) rows[at] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 1 })), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

let largePng: Buffer | undefined, largeInlinePng: Buffer | undefined, largeGlyphs: Buffer | undefined;
function fontChecksum(bytes: Buffer): number {
  let sum = 0;
  for (let at = 0; at < bytes.length; at += 4) {
    let word = 0;
    for (let i = 0; i < 4; i++) word = word * 256 + (bytes[at + i] ?? 0);
    sum = (sum + word) >>> 0;
  }
  return sum;
}

function largeTtf(name: Buffer, post = Buffer.alloc(32)): Buffer {
  if (!largeGlyphs) { largeGlyphs = seededAssetBytes(3 * 1024 * 1024); largeGlyphs.fill(0, 0, 12); }
  const head = Buffer.alloc(54), hhea = Buffer.alloc(36), hmtx = Buffer.alloc(4), loca = Buffer.alloc(8);
  const maxp = Buffer.alloc(32), os2 = Buffer.alloc(96), cmap = Buffer.alloc(44);
  head.writeUInt32BE(0x00010000); head.writeUInt32BE(0x00010000, 4); head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18); head.writeUInt16BE(8, 46); head.writeInt16BE(2, 48); head.writeInt16BE(1, 50);
  hhea.writeUInt32BE(0x00010000); hhea.writeInt16BE(800, 4); hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(1000, 10); hhea.writeInt16BE(1, 18); hhea.writeUInt16BE(1, 34);
  hmtx.writeUInt16BE(1000); loca.writeUInt32BE(12, 4);
  maxp.writeUInt32BE(0x00010000); maxp.writeUInt16BE(1, 4); maxp.writeUInt16BE(2, 14);
  os2.writeUInt16BE(4); os2.writeInt16BE(500, 2); os2.writeUInt16BE(400, 4); os2.writeUInt16BE(5, 6);
  os2.write("TEST", 58); os2.writeUInt16BE(64, 62); os2.writeUInt16BE(32, 64); os2.writeUInt16BE(32, 66);
  os2.writeInt16BE(800, 68); os2.writeInt16BE(-200, 70); os2.writeUInt16BE(800, 74); os2.writeUInt16BE(200, 76);
  os2.writeInt16BE(500, 86); os2.writeInt16BE(700, 88); os2.writeUInt16BE(32, 92); os2.writeUInt16BE(1, 94);
  cmap.writeUInt16BE(1, 2); cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(1, 6); cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(4, 12); cmap.writeUInt16BE(32, 14); cmap.writeUInt16BE(4, 18);
  cmap.writeUInt16BE(4, 20); cmap.writeUInt16BE(1, 22);
  cmap.writeUInt16BE(32, 26); cmap.writeUInt16BE(0xffff, 28);
  cmap.writeUInt16BE(32, 32); cmap.writeUInt16BE(0xffff, 34); cmap.writeInt16BE(-32, 36); cmap.writeInt16BE(1, 38);
  post.writeUInt32BE(0x00030000); post.writeInt16BE(-75, 8); post.writeUInt16BE(50, 10);
  const tables: [string, Buffer][] = [
    ["OS/2", os2], ["cmap", cmap], ["glyf", largeGlyphs], ["head", head], ["hhea", hhea],
    ["hmtx", hmtx], ["loca", loca], ["maxp", maxp], ["name", name], ["post", post],
  ];
  const directory = Buffer.alloc(12 + tables.length * 16), parts: Buffer[] = [directory];
  directory.writeUInt32BE(0x00010000); directory.writeUInt16BE(tables.length, 4);
  directory.writeUInt16BE(128, 6); directory.writeUInt16BE(3, 8); directory.writeUInt16BE(32, 10);
  let offset = directory.length, headOffset = 0;
  for (const [i, [tag, table]] of tables.entries()) {
    const at = 12 + i * 16, padding = Buffer.alloc((4 - table.length % 4) % 4);
    directory.write(tag, at); directory.writeUInt32BE(fontChecksum(table), at + 4);
    directory.writeUInt32BE(offset, at + 8); directory.writeUInt32BE(table.length, at + 12);
    if (tag === "head") headOffset = offset;
    parts.push(table, padding); offset += table.length + padding.length;
  }
  const bytes = Buffer.concat(parts);
  bytes.writeUInt32BE((0xb1b0afba - fontChecksum(bytes)) >>> 0, headOffset + 8);
  return bytes;
}

const largeAssetFixtures = new Map<string, Buffer>();
function largeAssetFixture(kind: "PNG" | "TTF" | "inline PNG", value?: string): Buffer {
  const key = `${kind}:${value ?? ""}`, cached = largeAssetFixtures.get(key);
  if (cached) return cached;
  let bytes: Buffer;
  if (kind === "TTF") {
    bytes = largeTtf(fontNameTable(value ?? "Public Fixture Font", 3));
  } else {
    bytes = kind === "PNG" ? largePng ??= rgbPng(1100, 1100) : largeInlinePng ??= rgbPng(900, 900);
    if (value) bytes = Buffer.concat([bytes.subarray(0, 33), pngChunk("tEXt", Buffer.from(`Comment\0${value}`)), bytes.subarray(33)]);
    if (kind === "inline PNG") bytes = Buffer.from(`<html><body><img src="data:image/png;base64,${bytes.toString("base64")}"></body></html>`);
  }
  largeAssetFixtures.set(key, bytes);
  return bytes;
}

for (const [kind, file] of [["PNG", "fixture.png"], ["TTF", "fixture.ttf"], ["inline PNG", "fixture.html"]] as const) {
  for (const terms of [empty, assetTerms]) {
    const label = terms === empty ? "without terms" : "with terms";
    test(`issue 35: large ${kind} passes ${label}`, () => {
      assert.deepEqual(checkBuffer(largeAssetFixture(kind), file, terms, false, true), []);
    });
    test(`issue 35: large ${kind} metadata secret is refused ${label}`, () => {
      const hits = checkBuffer(largeAssetFixture(kind, secret), file, terms, false, true);
      assert.ok(hits.some((hit) => hit.includes("secret shape")), hits.join("\n"));
      assert.ok(hits.every((hit) => hit.includes("secret shape")), hits.join("\n"));
    });
  }
  test(`issue 35: large ${kind} metadata private term is refused`, () => {
    const hits = checkBuffer(largeAssetFixture(kind, assetTerm), file, assetTerms, false, true);
    assert.ok(hits.some((hit) => hit.includes("private term")), hits.join("\n"));
    assert.ok(hits.every((hit) => hit.includes("private term")), hits.join("\n"));
  });
}

test("issue 35: small PNG private ancillary bytes retain raw term checks", () => {
  const bytes = png(pngChunk("prVt", Buffer.from(assetTerm)));
  assert.ok(checkBuffer(bytes, "fixture.png", assetTerms, false, true).some((hit) => hit.includes("private term")));
});

test("issue 35: whole-asset raw views start at exactly 32 budget bytes per input byte", () => {
  const bytes = png(pngChunk("IDAT", Buffer.from(assetTerm))), cost = 32 * bytes.length;
  // Fallback chunks and printable binary runs still spend budget when whole views skip.
  const preflight = new ScanBudget(cost - 2);
  assert.deepEqual(checkBuffer(bytes, "fixture.png", assetTerms, false, true, 0, preflight), []);
  const skipped = new ScanBudget(cost - 1);
  assert.deepEqual(checkBuffer(bytes, "fixture.png", assetTerms, false, true, 0, skipped), []);
  assert.equal(skipped.remaining, preflight.remaining + 1);
  const fits = new ScanBudget(cost);
  assert.ok(checkBuffer(bytes, "fixture.png", assetTerms, false, true, 0, fits).some((hit) => hit.includes("private term")));
  assert.ok(fits.remaining < cost);
});

for (const kind of ["woff", "woff2"] as const) {
  test(`issue 35: ${kind} table views skip while binary secrets remain checked`, () => {
    const body = seededAssetBytes(64 * 1024);
    for (const value of ["Public Fixture Font", secret]) {
      const table = Buffer.concat([body, Buffer.from(`\0${value}\0`)]), bytes = fontFixture(kind, table, "glyf");
      for (const terms of [empty, assetTerms]) {
        const hits = checkBuffer(bytes, `fixture.${kind}`, terms, false, true, 0, new ScanBudget((kind === "woff2" ? 3 : 2) * table.length));
        if (value === secret) assert.deepEqual(hits, [`fixture.${kind}: secret shape`]);
        else assert.deepEqual(hits, []);
      }
    }
  });

  test(`issue 35: ${kind} metadata raw views remain strict below the asset estimate`, () => {
    const table = seededAssetBytes(256), font = fontFixture(kind, table, "glyf");
    // UTF-16BE needs the raw views: metadata's UTF-8 text check cannot find this term.
    const metadata = Buffer.concat([Buffer.from(assetTerm, "utf16le").swap16(), Buffer.alloc(512)]);
    const compressed = kind === "woff" ? deflateSync(metadata) : brotliCompressSync(metadata);
    const offset = Math.ceil(font.length / 4) * 4;
    const bytes = Buffer.concat([font, Buffer.alloc(offset - font.length), compressed]), field = kind === "woff" ? 24 : 28;
    bytes.writeUInt32BE(bytes.length, 8); bytes.writeUInt32BE(offset, field);
    bytes.writeUInt32BE(compressed.length, field + 4); bytes.writeUInt32BE(metadata.length, field + 8);
    const allowance = 31 * metadata.length;
    const hits = checkBuffer(bytes, `fixture.${kind}`, assetTerms, false, true, 0, new ScanBudget(table.length + metadata.length + allowance));
    assert.ok(hits.some((hit) => hit.includes("private term")), hits.join("\n"));
    for (const terms of [empty, assetTerms])
      assert.throws(() => checkBuffer(bytes, `fixture.${kind}`, terms, false, true, 0, new ScanBudget(table.length + metadata.length)), /budget/);
  });
}

let assetBudgetFixture: { bytes: Buffer; spend: number } | undefined;
function rawBudgetFixture(): { bytes: Buffer; spend: number } {
  if (!assetBudgetFixture) {
    // Strict name views keep both scans present even under the measured (not estimated) allowance.
    const bytes = fontFixture("woff", Buffer.concat([fontNameTable("Public Fixture Font", 3), seededAssetBytes(64 * 1024)]), "name");
    const budget = new ScanBudget(), initial = budget.remaining;
    assert.deepEqual(checkBuffer(bytes, "fixture.woff", empty, false, true, 0, budget), []);
    assetBudgetFixture = { bytes, spend: initial - budget.remaining };
  }
  return assetBudgetFixture;
}

test("issue 35 round 1: measure the raw-view budget baseline", () => {
  const { bytes, spend } = rawBudgetFixture();
  assert.ok(spend >= 32 * bytes.length, "the measured allowance must retain whole views");
});

const assetEscapeTerms: PrivateTerms = { terms: [{ value: "synthetic%20unrelated%20phrase", line: 1 }], allowed: [], notes: [] };
const assetAllowedTerms: PrivateTerms = { ...assetTerms, allowed: ["a&nbsp;b"] };
for (const [label, terms] of [["no terms", empty], ["plain term", assetTerms], ["escaped term", assetEscapeTerms], ["escaped allowance", assetAllowedTerms]] as const)
  test(`issue 35 round 1: raw-view cost is independent of ${label}`, () => {
    const { bytes, spend } = rawBudgetFixture(), slack = 2048;
    assert.ok(spend + slack >= 32 * bytes.length, "whole views must fit, so skipping cannot mask extra readings");
    const budget = new ScanBudget(spend + slack);
    assert.deepEqual(checkBuffer(bytes, "fixture.woff", terms, false, true, 0, budget), []);
    assert.ok(budget.remaining <= slack, "both raw scans must still run");
  });

test("issue 35 round 1: text-file escape readings still follow configuration", () => {
  const bytes = Buffer.from("public text ".repeat(256)), spends: number[] = [];
  for (const terms of [empty, assetEscapeTerms, assetAllowedTerms]) {
    const budget = new ScanBudget(), initial = budget.remaining;
    assert.deepEqual(checkBuffer(bytes, "fixture.txt", terms, false, true, 0, budget), []);
    spends.push(initial - budget.remaining);
  }
  for (const spend of spends.slice(1)) assert.ok(spend > 2 * (spends[0] ?? 0));
});

let fontBombBody: Buffer | undefined;
const fontBombs = new Map<string, Buffer>();
for (const kind of ["woff", "woff2"] as const) {
  test(`issue 35 round 1: ${kind} high-ratio tables retain strict views`, () => {
    if (!fontBombBody) {
      fontBombBody = Buffer.alloc(8 * 1024 * 1024);
      fontBombBody.write(assetTerm, fontBombBody.length / 2);
    }
    let bytes = fontBombs.get(kind);
    if (!bytes) { bytes = fontFixture(kind, fontBombBody, "glyf"); fontBombs.set(kind, bytes); }
    // DEFLATE needs roughly 8 KiB for this body; Brotli fits in a few hundred bytes.
    assert.ok(bytes.length < (kind === "woff" ? 16 * 1024 : 256));
    for (const terms of [empty, assetTerms]) {
      const hits = checkBuffer(bytes, `fixture.${kind}`, terms, false, true);
      assert.ok(hits.some((hit) => /budget|limit|oversized|private term/.test(hit)), hits.join("\n"));
    }
  });

  test(`issue 35 round 1: ${kind} name storage stays strict below its estimate`, () => {
    const table = Buffer.concat([fontNameTable("Public Fixture Font", 3), seededAssetBytes(512), Buffer.from(`\0${assetTerm}\0`)]);
    const bytes = fontFixture(kind, table, "name"), allowance = Math.min(31 * table.length, 32 * bytes.length - 1);
    for (const terms of [empty, assetTerms]) {
      const hits = checkBuffer(bytes, `fixture.${kind}`, terms, false, true, 0, new ScanBudget(allowance));
      if (terms === empty) assert.deepEqual(hits, []);
      else assert.ok(hits.some((hit) => hit.includes("private term")), hits.join("\n"));
      assert.throws(() => checkBuffer(bytes, `fixture.${kind}`, terms, false, true, 0, new ScanBudget(table.length + 1)), /budget/);
    }
  });
}

for (const encoding of ["sPLT", "prVt", "UTF-16LE", "UTF-16BE"] as const)
  test(`issue 35 round 1: large PNG fallback finds ${encoding} metadata`, () => {
    const base = largeAssetFixture("PNG");
    const chunk = encoding === "sPLT" ? pngChunk("sPLT", Buffer.concat([Buffer.from(`${assetTerm}\0`), Buffer.from([8, 0, 0, 0, 255, 0, 1])])) :
      encoding === "prVt" ? pngChunk("prVt", Buffer.from(assetTerm)) :
      pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), encoding === "UTF-16LE" ? Buffer.from(assetTerm, "utf16le") : Buffer.from(assetTerm, "utf16le").swap16()]));
    const bytes = Buffer.concat([base.subarray(0, 33), chunk, base.subarray(33)]);
    assert.deepEqual(checkBuffer(bytes, "fixture.png", empty, false, true), []);
    const hits = checkBuffer(bytes, "fixture.png", assetTerms, false, true);
    assert.ok(hits.some((hit) => hit.includes("private term")), hits.join("\n"));
    assert.ok(hits.every((hit) => hit.includes("private term")), hits.join("\n"));
  });

for (const location of ["language tag", "unreferenced storage", "ASCII Unicode record", "post table"] as const)
  test(`issue 35 round 1: large TTF fallback finds ${location}`, () => {
    let name = fontNameTable("Public Fixture Font", 3), post = Buffer.alloc(32);
    if (location === "language tag") {
      const value = Buffer.from(assetTerm, "utf16le").swap16(), tags = Buffer.alloc(6);
      name.writeUInt16BE(1); name.writeUInt16BE(24, 4);
      tags.writeUInt16BE(1); tags.writeUInt16BE(value.length, 2); tags.writeUInt16BE(name.length - 18, 4);
      name = Buffer.concat([name.subarray(0, 18), tags, name.subarray(18), value]);
    } else if (location === "unreferenced storage") name = Buffer.concat([name, Buffer.from(assetTerm)]);
    else if (location === "ASCII Unicode record") {
      name = fontNameTable(assetTerm, 1); name.writeUInt16BE(3, 6); name.writeUInt16BE(1, 8);
    } else post = Buffer.concat([post, Buffer.from(assetTerm)]);
    const bytes = largeTtf(name, post);
    assert.deepEqual(checkBuffer(bytes, "fixture.ttf", empty, false, true), []);
    const hits = checkBuffer(bytes, "fixture.ttf", assetTerms, false, true);
    assert.ok(hits.some((hit) => hit.includes("private term")), hits.join("\n"));
    assert.ok(hits.every((hit) => hit.includes("private term")), hits.join("\n"));
  });

test("issue 35 round 1: PNG fallback batches many small chunks once", (t) => {
  const base = largeAssetFixture("PNG"), chunks = Array.from({ length: 2048 }, () => pngChunk("prVt", Buffer.alloc(8, 1)));
  chunks.push(pngChunk("prVt", Buffer.from(assetTerm)));
  const bytes = Buffer.concat([base.subarray(0, 33), ...chunks, base.subarray(33)]);
  const decode = t.mock.method(TextDecoder.prototype, "decode");
  const hits = checkBuffer(bytes, "fixture.png", assetTerms, false, true);
  assert.ok(hits.some((hit) => hit.includes("private term")), hits.join("\n"));
  assert.equal(decode.mock.callCount(), 2, "one joined buffer has two UTF-16BE alignments");
});

test("issue 35 round 1: malformed PNG and SFNT retain strict views and parser refusals", () => {
  const image = png(pngChunk("prVt", Buffer.from(assetTerm))).subarray(0, -3);
  const font = sfntFixture("ttf", fontNameTable(assetTerm, 3));
  font.writeUInt32BE(font.length, 20);
  for (const [bytes, file, label] of [[image, "fixture.png", "invalid PNG text metadata"], [font, "fixture.ttf", "invalid SFNT font data"]] as const) {
    const hits = checkBuffer(bytes, file, assetTerms, false, true, 0, new ScanBudget(28 * bytes.length));
    assert.deepEqual(hits.filter((hit) => !hit.includes("private term")), [`${file}: ${label}`]);
    assert.ok(hits.some((hit) => hit.includes("private term")));
  }
});


function assetFontTables(bytes: Buffer): [string, Buffer][] {
  return Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => {
    const at = 12 + i * 16, offset = bytes.readUInt32BE(at + 8), length = bytes.readUInt32BE(at + 12);
    return [bytes.toString("ascii", at, at + 4), bytes.subarray(offset, offset + length)];
  });
}

function assetSfnt(tables: [string, Buffer][], gap = Buffer.alloc(0), otf = false): Buffer {
  const sorted = tables.map(([tag, data]): [string, Buffer] => [tag, tag === "head" ? Buffer.from(data) : data])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const directory = Buffer.alloc(12 + sorted.length * 16), parts: Buffer[] = [directory];
  const power = 2 ** Math.floor(Math.log2(sorted.length));
  if (otf) directory.write("OTTO"); else directory.writeUInt32BE(0x00010000);
  directory.writeUInt16BE(sorted.length, 4); directory.writeUInt16BE(power * 16, 6);
  directory.writeUInt16BE(Math.log2(power), 8); directory.writeUInt16BE((sorted.length - power) * 16, 10);
  let offset = directory.length, headOffset = 0;
  for (const [i, [tag, data]] of sorted.entries()) {
    const at = 12 + i * 16, padding = Buffer.alloc((4 - data.length % 4) % 4);
    if (tag === "head") { data.writeUInt32BE(0, 8); headOffset = offset; }
    directory.write(tag, at); directory.writeUInt32BE(fontChecksum(data), at + 4);
    directory.writeUInt32BE(offset, at + 8); directory.writeUInt32BE(data.length, at + 12);
    parts.push(data, padding); offset += data.length + padding.length;
    if (!i) { parts.push(gap); offset += gap.length; }
  }
  const bytes = Buffer.concat(parts);
  if (headOffset) bytes.writeUInt32BE((0xb1b0afba - fontChecksum(bytes)) >>> 0, headOffset + 8);
  return bytes;
}

function assetCompressedFont(kind: "woff" | "woff2", tables: [string, Buffer][], options: { gap?: Buffer; privateData?: Buffer; compressed?: Buffer } = {}): Buffer {
  const header = Buffer.alloc(kind === "woff" ? 44 + tables.length * 20 : 48), parts: Buffer[] = [header];
  header.write(kind === "woff" ? "wOFF" : "wOF2"); header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(12 + tables.length * 16 + tables.reduce((sum, [, data]) => sum + Math.ceil(data.length / 4) * 4, 0), 16);
  let offset = header.length;
  if (kind === "woff") {
    for (const [i, [tag, data]] of tables.entries()) {
      let compressed = options.compressed ?? deflateSync(data, { level: 1 });
      if (compressed.length >= data.length) compressed = data;
      const at = 44 + i * 20, padding = Buffer.alloc((4 - compressed.length % 4) % 4);
      header.write(tag, at); header.writeUInt32BE(offset, at + 4); header.writeUInt32BE(compressed.length, at + 8);
      header.writeUInt32BE(data.length, at + 12); header.writeUInt32BE(fontChecksum(data), at + 16);
      parts.push(compressed, padding); offset += compressed.length + padding.length;
      if (!i && options.gap) { parts.push(options.gap); offset += options.gap.length; }
    }
  } else {
    for (const [tag, data] of tables) {
      const length = [data.length & 127];
      for (let n = data.length >>> 7; n; n >>>= 7) length.unshift((n & 127) | 128);
      const entry = Buffer.concat([Buffer.from([tag === "glyf" || tag === "loca" ? 0xff : 0x3f]), Buffer.from(tag), Buffer.from(length)]);
      parts.push(entry); offset += entry.length;
    }
    const compressed = brotliCompressSync(Buffer.concat(tables.map(([, data]) => data)), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    header.writeUInt32BE(compressed.length, 20); parts.push(compressed); offset += compressed.length;
  }
  if (options.privateData) {
    const padding = Buffer.alloc((4 - offset % 4) % 4), field = kind === "woff" ? 36 : 40;
    offset += padding.length; header.writeUInt32BE(offset, field); header.writeUInt32BE(options.privateData.length, field + 4);
    parts.push(padding, options.privateData); offset += options.privateData.length;
  }
  header.writeUInt32BE(offset, 8);
  return Buffer.concat(parts);
}

const checkOneFonts = new Map<string, Buffer>();
function checkOneFont(kind: "woff" | "woff2"): Buffer {
  let bytes = checkOneFonts.get(kind);
  if (!bytes) { bytes = assetCompressedFont(kind, assetFontTables(largeAssetFixture("TTF"))); checkOneFonts.set(kind, bytes); }
  return bytes;
}

function assertAssetRefused(bytes: Buffer, file: string): void {
  const hits = checkBuffer(bytes, file, assetTerms, false, true);
  assert.ok(hits.some((hit) => /private term|scan expansion budget exceeded/.test(hit)), hits.join("\n"));
}

for (const variant of ["IDAT after IEND", "large sPLT", "large iCCP", "large UTF-16 tEXt"] as const)
  test(`issue 35 check 1: PNG retains ${variant}`, () => {
    const base = largeAssetFixture("PNG");
    let chunk: Buffer;
    if (variant === "IDAT after IEND") {
      assertAssetRefused(Buffer.concat([base, pngChunk("IDAT", Buffer.from(assetTerm))]), "fixture.png");
      return;
    }
    if (variant === "large sPLT") chunk = pngChunk("sPLT", Buffer.concat([Buffer.from(`${assetTerm}\0`), Buffer.from([8]), Buffer.alloc(6 * Math.floor(2 * 1024 * 1024 / 6))]));
    else if (variant === "large iCCP") {
      const profile = Buffer.alloc(1700 * 1024);
      profile.writeUInt32BE(profile.length); profile.write("acsp", 36);
      chunk = pngChunk("iCCP", Buffer.concat([Buffer.from(`${assetTerm}\0\0`), deflateSync(profile, { level: 0 })]));
    } else {
      const text = Buffer.alloc(2 * 1024 * 1024); text.write(assetTerm, 0, "utf16le");
      chunk = pngChunk("tEXt", Buffer.concat([Buffer.from("Comment\0"), text]));
    }
    assertAssetRefused(Buffer.concat([base.subarray(0, 33), chunk, base.subarray(33)]), "fixture.png");
  });

for (const variant of ["large custom table", "table-less tail", "inter-table gap", "CFF names"] as const)
  test(`issue 35 check 1: SFNT retains ${variant}`, () => {
    const tables = assetFontTables(largeAssetFixture("TTF"));
    let bytes: Buffer, file = "fixture.ttf";
    if (variant === "large custom table") {
      const data = Buffer.alloc(1700 * 1024); data.write(assetTerm);
      bytes = assetSfnt([...tables, ["priv", data]]);
    } else if (variant === "table-less tail") {
      bytes = Buffer.alloc(12 + 2 * 1024 * 1024); bytes.writeUInt32BE(0x00010000); bytes.write(assetTerm, 1024);
    } else if (variant === "inter-table gap") {
      const gap = Buffer.alloc(32); gap.write(assetTerm);
      bytes = assetSfnt(tables, gap);
    } else {
      const cff = Buffer.from(tables.find(([tag]) => tag === "glyf")?.[1] as Buffer);
      cff.fill(0, 0, 64 * 1024); Buffer.from([1, 0, 4, 4, 0, 1, 1, 1, assetTerm.length + 1]).copy(cff);
      cff.write(assetTerm, 9);
      bytes = assetSfnt([["CFF ", cff], ["name", fontNameTable("Public Fixture Font", 3)]], Buffer.alloc(0), true);
      file = "fixture.otf";
    }
    assertAssetRefused(bytes, file);
  });

test("issue 35 check 1: WOFF2 retains a small meta table beside bulk data", () => {
  const bytes = assetCompressedFont("woff2", [["glyf", seededAssetBytes(2 * 1024 * 1024)], ["meta", Buffer.from(assetTerm)]]);
  assertAssetRefused(bytes, "fixture.woff2");
});

for (const kind of ["woff", "woff2"] as const) {
  test(`issue 35 check 1: ${kind} retains its private data block`, () => {
    const privateData = Buffer.from(`\0${assetTerm}\0`);
    const bytes = assetCompressedFont(kind, [["glyf", seededAssetBytes(2 * 1024 * 1024)]], { privateData });
    assertAssetRefused(bytes, `fixture.${kind}`);
  });
  for (const terms of [empty, assetTerms])
    test(`issue 35 check 1: realistic large ${kind} passes ${terms === empty ? "without" : "with"} terms`, () => {
      assert.deepEqual(checkBuffer(checkOneFont(kind), `fixture.${kind}`, terms, false, true), []);
    });
}

test("issue 35 check 1: a 6.4x WOFF bulk table keeps strict views", () => {
  const body = Buffer.alloc(2 * 1024 * 1024), stored = 320 * 1024;
  body.fill(65, 0, stored); body.write(assetTerm, body.length / 2);
  // Stored DEFLATE blocks keep the compressed fixture ASCII-heavy and its raw scan fast.
  const parts: Buffer[] = [Buffer.from([0x78, 0x9c])];
  for (let at = 0; at < stored; ) {
    const length = Math.min(65535, stored - at), header = Buffer.alloc(5);
    header.writeUInt16LE(length, 1); header.writeUInt16LE(65535 - length, 3);
    parts.push(header, body.subarray(at, at + length)); at += length;
  }
  parts.push(zlib.deflateRawSync(body.subarray(stored)));
  let a = 1, b = 0;
  for (const byte of body) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((b * 65536 + a) >>> 0); parts.push(checksum);
  const compressed = Buffer.concat(parts), ratio = body.length / compressed.length;
  assert.ok(ratio > 6.2 && ratio < 6.5);
  assert.deepEqual(zlib.inflateSync(compressed), body);
  assertAssetRefused(assetCompressedFont("woff", [["glyf", body]], { compressed }), "fixture.woff");
});

let dilutionNoise: Buffer | undefined;
for (const size of [8, 2])
  test(`issue 35 check 1: WOFF2 cannot dilute a ${size} MiB zero table`, () => {
    dilutionNoise ??= seededAssetBytes(Math.floor(1.3 * 1024 * 1024));
    const glyphs = Buffer.alloc(size * 1024 * 1024); glyphs.write(assetTerm, glyphs.length / 2);
    // Zero private padding forces the whole-file fallback without adding random scan work.
    const bytes = assetCompressedFont("woff2", [["glyf", glyphs], ["gvar", dilutionNoise]], { privateData: Buffer.alloc(512 * 1024) });
    if (size === 2) assert.ok((glyphs.length + dilutionNoise.length) / bytes.readUInt32BE(20) < 4, "the stream-wide ratio would hide this bomb");
    assertAssetRefused(bytes, "fixture.woff2");
  });

test("issue 35 check 1: WOFF retains bytes between tables", () => {
  const gap = Buffer.alloc(32); gap.write(assetTerm);
  const bytes = assetCompressedFont("woff", assetFontTables(largeAssetFixture("TTF")), { gap });
  assertAssetRefused(bytes, "fixture.woff");
});

test("issue 35 check 1: a 100000-chunk PNG charges every visited chunk", () => {
  const base = largeAssetFixture("PNG"), count = 100000, chunk = pngChunk("prVt", Buffer.alloc(0));
  const bytes = Buffer.concat([base.subarray(0, 33), ...Array<Buffer>(count).fill(chunk), base.subarray(33)]);
  const budget = new ScanBudget((count + 3) * 12), spend = budget.spend.bind(budget);
  let visited = 0;
  budget.spend = (length) => { if (length === 12) visited++; spend(length); };
  assert.throws(() => checkBuffer(bytes, "fixture.png", assetTerms, false, true, 0, budget), /budget/);
  assert.equal(visited, count + 3);
  assert.equal(budget.remaining, 0);
});
