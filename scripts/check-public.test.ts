import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { crc32, deflateSync } from "node:zlib";
import {
  checkPublic,
  checkPublicPush,
  checkText,
  loadPrivateTerms,
  type PrivateTerms,
  PublicCheckError,
  readPushDestination,
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

test("IPv4 rules cover all private ranges, edges, and only the three exact exceptions", () => {
  for (const parts of [
    [10, 0, 0, 0],
    [10, 255, 255, 255],
    [172, 16, 0, 0],
    [172, 31, 255, 255],
    [192, 168, 0, 0],
    [100, 64, 0, 0],
    [100, 127, 255, 255],
  ]) {
    assert.deepEqual(check(ip(...parts)), ["--text #1: private or tailnet IPv4 address"]);
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
  assert.deepEqual(check(`https://fixture@${ip(10, 20, 30, 40)}/path`), ["--text #1: private or tailnet IPv4 address"]);
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
    [ip(10, 20, 30, 40), "private or tailnet IPv4 address"],
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
      "latin1.woff2:2: private term (file line 1)",
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
  assert.deepEqual(check(`${ip(10, 20, 30, 40)}.`), ["--text #1: private or tailnet IPv4 address"]);
  for (const suffix of ["::1", ":0:0:0:0:1", "::/48"]) {
    assert.deepEqual(check(["fd7a", "115c", "a1e0"].join(":") + suffix), ["--text #1: tailnet IPv6 address"]);
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
    ["font.woff", Buffer.from("wOFF")],
    ["font.woff2", Buffer.from("wOF2")],
    ...["ttf", "otf"].flatMap((ext): [string, Buffer][] => [
      [`apple.${ext}`, Buffer.from("true")],
      [`open.${ext}`, Buffer.from("OTTO")],
      [`type.${ext}`, Buffer.from([0, 1, 0, 0])],
    ]),
  ];
  for (const [file, bytes] of formats)
    writeFileSync(path.join(cwd, file), file.endsWith(".png") ? bytes : Buffer.concat([bytes, Buffer.alloc(2)]));
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

test("E: bare home paths are detected in commands, JSON and prose with case-sensitive prefixes", () => {
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
