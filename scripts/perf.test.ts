import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { inflateSync, gzipSync } from "node:zlib";
import { buildSeedPlan, SEED } from "./perf/seed.ts";
import { assertOutputFolder, assertRefFolder } from "./perf/guards.ts";
import { childEnvironment, chromiumArgs } from "./screenshots/safety.ts";
import { isReportRun, type PerfRun, renderReport, writeReport } from "./perf/report.ts";
import { distribution, NetworkMeasurement, REPETITIONS, routePattern } from "./perf/metrics.ts";
import { buildEnvironment, checkBuildResult, localPnpmStore, OFFLINE_INSTALL, parseArgs, redactFailure, resolveCommit, runExitCode } from "./perf.ts";
import { LAPTOP, sample, sampleMetrics } from "./perf/journeys.ts";
import type { Page } from "./screenshots/browser.ts";

test("seed plan is identical and has every declared size, including the two special reviews", () => {
  const plan = buildSeedPlan();
  assert.deepEqual(plan, buildSeedPlan());
  assert.equal(plan.reviews.length + 2, SEED.inboxReviews);
  assert.equal(plan.files.length, SEED.largeReviewFiles);
  assert.equal(plan.largeManifest.files.length, SEED.largeReviewFiles);
  assert.equal(
    plan.files.reduce((n, f) => n + f.before.trimEnd().split("\n").length + f.after.trimEnd().split("\n").length, 0),
    SEED.largeReviewDiffLines,
  );
  for (const file of plan.files)
    assert(
      !file.before
        .split("\n")
        .filter(Boolean)
        .some((line) => file.after.split("\n").includes(line)),
      "every old line changes",
    );
  assert.equal(plan.docs.length, SEED.pubDocs);
  assert.equal(plan.images.length, SEED.pubImages);
  assert.equal(
    plan.docs.reduce((n, doc) => n + (doc.text.match(/!\[/g)?.length ?? 0), 0),
    SEED.pubImages,
  );
  assert.equal(
    plan.docs.reduce((n, doc) => n + (doc.text.match(/```mermaid/g)?.length ?? 0), 0),
    SEED.pubMermaid,
  );
  assert.equal(plan.reviews.filter((r) => r.commented).length, SEED.commentedReviews);
  assert.equal(plan.reviews.filter((r) => r.replied).length, SEED.repliedReviews);
  assert.equal(new Set(plan.reviews.map((r) => r.key)).size, plan.reviews.length);
  for (const image of plan.images) {
    assert.equal(image.bytes.readUInt32BE(16), 16);
    assert.equal(image.bytes.readUInt32BE(20), 16);
    const offset = 8 + 25;
    assert.equal(image.bytes.toString("ascii", offset + 4, offset + 8), "IDAT");
    assert.equal(
      inflateSync(image.bytes.subarray(offset + 8, offset + 8 + image.bytes.readUInt32BE(offset))).length,
      16 * 49,
    );
  }
  const source = readFileSync(new URL("./perf/seed.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Math\.random|Date\.now|new Date/);
});

test("output protects real state; ref exports also reject the checkout and non-temp paths", () => {
  const identity = (path: string) => path;
  const states = ["/state/emend"];
  for (const path of ["/state", "/state/emend", "/state/emend/perf"])
    assert.throws(() => assertOutputFolder(path, states, identity), /overlaps/);
  assert.doesNotThrow(() => assertOutputFolder("/checkout/.wt/perf", states, identity));
  for (const path of ["/tmp/checkout", "/tmp/checkout/ref", "/tmp", "/state/emend", "/outside/ref"])
    assert.throws(() => assertRefFolder(path, "/tmp/checkout", "/tmp", states, identity));
  assert.doesNotThrow(() => assertRefFolder("/tmp/ref", "/tmp/checkout", "/tmp", states, identity));
  assert.throws(() =>
    assertRefFolder("/tmp/ref", "/tmp/checkout", "/tmp", states, (path) =>
      path === "/tmp/ref" ? "/state/emend/ref" : path,
    ),
  );
});

test("perf uses the shared sealed lifecycle, environment and headless browser, including ref builds", () => {
  const env = childEnvironment("/tmp/synthetic-perf", "linux");
  assert.equal(env.EMEND_HOME, "/tmp/synthetic-perf/emend");
  assert.equal(env.HOME, "/tmp/synthetic-perf/home");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert(!("NODE_OPTIONS" in env));
  const args = chromiumArgs("/tmp/synthetic-perf/chromium", "linux");
  assert(args.includes("--headless=new"));
  assert(args.includes("--remote-debugging-pipe"));
  assert(!args.some((arg) => /no-sandbox|remote-debugging-port/.test(arg)));
  const main = readFileSync(new URL("./perf.ts", import.meta.url), "utf8");
  const shared = readFileSync(new URL("./screenshots/sealed.ts", import.meta.url), "utf8");
  const browser = readFileSync(new URL("./screenshots/browser.ts", import.meta.url), "utf8");
  assert(main.includes('createSealedLifecycle("perf")'));
  assert(main.includes("sealed.startServer("));
  assert(main.includes("sealed.signIn("));
  assert(shared.includes("childEnvironment(sealedRoot, process.platform)"));
  assert(shared.includes("assertProfileUsed(join(sealedRoot"));
  assert(browser.includes("chromiumArgs(options.profile, options.platform)"));
  assert(browser.includes("const sessionId = await this.sealedSession(created.targetId)"));
  assert(OFFLINE_INSTALL.includes("--offline"));
  assert(OFFLINE_INSTALL.includes("--frozen-lockfile"));
  assert(OFFLINE_INSTALL.includes("--frozen-store"));
  assert(OFFLINE_INSTALL.includes("--ignore-scripts"));
  assert(!OFFLINE_INSTALL.includes("--ignore-pnpmfile"));
  assert(OFFLINE_INSTALL.includes("--package-import-method=copy"));
  assert.deepEqual(LAPTOP, { width: 1440, height: 900, scale: 2, mobile: false });
});

test("the ref install loads the pnpmfile whose checksum the frozen lockfile records", () => {
  const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  assert.match(lockfile, /^pnpmfileChecksum: /m);
  assert(OFFLINE_INSTALL.includes("--frozen-lockfile"));
  assert(!OFFLINE_INSTALL.includes("--ignore-pnpmfile"));
});

test("build children use Node then pnpm on PATH and reuse only the parent Corepack cache", () => {
  const sealed = Object.freeze(childEnvironment("/tmp/synthetic-perf", "linux"));
  const parent = {
    COREPACK_HOME: "/synthetic/corepack",
    XDG_CACHE_HOME: "/synthetic/cache",
    HOME: "/synthetic/parent-home",
    PATH: "/synthetic/parent-bin",
    NODE_OPTIONS: "--trace-warnings",
    EMEND_HOME: "/synthetic/parent-state",
    COREPACK_ENABLE_NETWORK: "1",
    pnpm_config_pm_on_fail: "download",
    pnpm_config_verify_deps_before_run: "install",
    pnpm_config_offline: "false",
    npm_config_registry: "https://example.invalid",
  };
  const variants = [
    { parent, expected: "/synthetic/corepack" },
    { parent: { ...parent, COREPACK_HOME: undefined }, expected: "/synthetic/cache/node/corepack" },
    { parent: { ...parent, COREPACK_HOME: undefined, XDG_CACHE_HOME: undefined }, expected: "/synthetic/account/.cache/node/corepack" },
  ];
  for (const variant of variants) {
    assert.deepEqual(buildEnvironment(sealed, "/synthetic/pnpm/bin/pnpm", variant.parent, "/synthetic/node/bin/node", "/synthetic/account"), {
      ...sealed,
      PATH: "/synthetic/node/bin:/synthetic/pnpm/bin:/usr/bin:/bin",
      COREPACK_HOME: variant.expected,
      COREPACK_ENABLE_NETWORK: "0",
      pnpm_config_pm_on_fail: "ignore",
      pnpm_config_verify_deps_before_run: "false",
      pnpm_config_offline: "true",
    });
  }
  assert.deepEqual(sealed, childEnvironment("/tmp/synthetic-perf", "linux"), "other children keep the plain environment");
});

test("build failures print the last 20 combined output lines with paths and pairing secrets redacted", () => {
  const sealedRoot = "/tmp/synthetic-perf";
  const refFolder = "/tmp/synthetic-ref";
  const output: string[] = [];
  const reason = "Offline ref install exited with code 1; dependencies may be absent from the local store";
  const stdout = Array.from({ length: 24 }, (_, i) => `stdout ${i + 1}`).join("\n") + "\n";
  const stderr = [
    `failed in ${sealedRoot}/tmp and ${refFolder}/apps`,
    `paths repeated: ${sealedRoot} ${refFolder}`,
    `pairing emp_${"x".repeat(43)} and emp_abc-123_def`,
    "bare prefix emp_",
  ].join("\r\n") + "\r\n";
  assert.throws(() => checkBuildResult({ code: 1, stdout, stderr }, reason, { sealedRoot, refFolder }, (text) => {
    output.push(text);
  }), (error: Error) => {
    assert.equal(output.length, 1, "diagnostics are written before the error reaches the skip recorder");
    assert.equal(error.message, reason, "the recorded reason contains no child output");
    assert(!error.message.includes("\n"));
    return true;
  });
  const lines = output[0].split("\n");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "stdout 9");
  assert.equal(lines[15], "stdout 24");
  assert.deepEqual(lines.slice(16), [
    "failed in <sealed>/tmp and <ref>/apps",
    "paths repeated: <sealed> <ref>",
    "pairing <redacted> and <redacted>",
    "bare prefix <redacted>",
  ]);
  assert(!output[0].includes(sealedRoot) && !output[0].includes(refFolder));
  assert(!output[0].includes("emp_"));
});

test("successful builds stay silent; empty and signalled failures keep their one-line reason", () => {
  const output: string[] = [];
  const write = (text: string) => output.push(text);
  const paths = { sealedRoot: "/tmp/synthetic-perf" };
  checkBuildResult({ code: 0, stdout: "success", stderr: "warning" }, "unused", paths, write);
  assert.deepEqual(output, []);
  assert.throws(() => checkBuildResult({ code: 1, stdout: "", stderr: "" }, "Build exited with code 1", paths, write), { message: "Build exited with code 1" });
  assert.deepEqual(output, []);
  assert.throws(() => checkBuildResult({ code: null, stdout: "unfinished", stderr: "stopped" }, "Build exited with code null", paths, write), { message: "Build exited with code null" });
  assert.deepEqual(output, ["unfinished\nstopped"]);
});

test("ref resolution permits main ancestry and refuses branch-only commits before export", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-main-ref-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = childEnvironment(root, process.platform);
  const calls: string[][] = [];
  const git = (...args: string[]) => {
    calls.push(args);
    return execFileSync("git", ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
      "-c", "commit.gpgsign=false", ...args], { cwd: repo, env, encoding: "utf8", stdio: "pipe" }).trim();
  };
  git("init", "--quiet", "--initial-branch=main", "--template=");
  git("commit", "--allow-empty", "-qm", "test: main fixture");
  const first = resolveCommit("main", git);
  git("commit", "--allow-empty", "-qm", "test: later main fixture");
  assert.equal(resolveCommit(first, git), first);
  const main = resolveCommit("main", git);
  const accepted = join(root, "accepted.tar");
  git("archive", "--format=tar", "--output", accepted, main);
  assert(existsSync(accepted));
  git("checkout", "-qb", "other");
  git("commit", "--allow-empty", "-qm", "test: other fixture");
  const refused = join(root, "refused.tar");
  calls.length = 0;
  assert.throws(() => {
    const sha = resolveCommit("other", git);
    git("archive", "--format=tar", "--output", refused, sha);
  }, { message: "--ref must name a commit on main" });
  assert(!existsSync(refused));
  assert(!calls.some(([command]) => command === "archive"));
  assert.deepEqual(calls[0], ["rev-parse", "--verify", "--end-of-options", "other^{commit}"]);
  assert(!calls.slice(1).flat().some((arg) => arg.includes("other")));
  git("update-ref", "refs/remotes/origin/main", main);
  git("branch", "-D", "main");
  assert.equal(resolveCommit(main, git), main, "origin/main alone is sufficient");
  assert.throws(() => resolveCommit("other", git), /--ref must name a commit on main/);
  git("update-ref", "-d", "refs/remotes/origin/main");
  assert.throws(() => resolveCommit(main, git), /--ref must name a commit on main/);
});

test("local store discovery accepts pnpm JSON and legacy YAML and refuses missing or relative paths", () => {
  assert.equal(localPnpmStore('{"storeDir":"/synthetic/store","layoutVersion":5}'), "/synthetic/store");
  for (const value of ["/synthetic/store", "'/synthetic/store'", '"/synthetic/store"'])
    assert.equal(localPnpmStore(`layoutVersion: 5\nstoreDir: ${value}\n`), "/synthetic/store");
  for (const contents of ["", "{}", "null", '{"storeDir":42}', '{"storeDir":"relative"}', "storeDir: relative", "storeDir:\nlayoutVersion: 5"])
    assert.throws(() => localPnpmStore(contents), { message: "Could not find the local pnpm store" });
});

test("one redaction covers overlapping roots, both home folders and tokens in reasons and diagnostics", () => {
  const paths = {
    sealedRoot: "/synthetic/account/project/sealed",
    refFolder: "/synthetic/account/project/ref",
    checkout: "/synthetic/account/project",
    homes: ["/synthetic/account", "/synthetic/system-account"],
  };
  const reason = [paths.sealedRoot, paths.refFolder, paths.checkout, ...paths.homes, "emp_secret-123_token"].join(" ");
  const expected = "<sealed> <ref> <checkout> ~ ~ <redacted>";
  assert.equal(redactFailure(new Error(`${reason}\r\nsecond line`), paths), expected);
  assert.equal(redactFailure(`${reason} ${"x".repeat(300)}`, paths).length, 240);
  const printed: string[] = [];
  assert.throws(() => checkBuildResult({ code: 1, stdout: reason, stderr: reason }, reason, paths,
    (message) => printed.push(message)), { message: expected });
  assert.deepEqual(printed, [`${expected}\n${expected}`]);
  for (const privateText of [paths.sealedRoot, paths.refFolder, paths.checkout, ...paths.homes, "emp_"])
    assert(!printed[0].includes(privateText));
});

test("current steps fail the run; historical skips succeed only without seal or fatal failures", () => {
  for (const ref of [undefined, "main~1"]) {
    for (const skipped of [[], [{ step: "laptop/review/warm/3", reason: "Unavailable" }]]) {
      for (const sealFailure of [false, true]) {
        for (const fatalFailure of [false, true]) {
          assert.equal(runExitCode(ref, skipped, sealFailure, fatalFailure),
            sealFailure || fatalFailure || (!ref && skipped.length > 0) ? 1 : 0);
        }
      }
    }
  }
});

function run(): PerfRun {
  return {
    schemaVersion: 1,
    commit: { sha: "a".repeat(40), subject: '<script>alert("x")</script>', date: "2026-10-26T12:00:00Z", dirty: false },
    date: "2026-11-17T12:00:00Z",
    node: "v26.0.0",
    chromium: "synthetic",
    seal: {
      vanishedRequests: 0, vanishedTargets: 0,
      vanishedRequestsByKind: { gone: 0, "invalid-interception": 0 }, vanishedRequestEvents: [],
    },
    cpus: 2,
    loadStart: [3, 1, 1],
    loadEnd: [1, 1, 1],
    seed: SEED,
    seededReviews: 300,
    repetitions: REPETITIONS,
    measurements: [],
    publish: { samples: [2, 3, 4], stats: distribution([2, 3, 4]) },
    skipped: [{ step: "pub", reason: 'Missing route <img src="https://example.invalid/x"> & unavailable' }],
  };
}
test("report escapes text, stays self-contained, marks busy runs and skipped reasons, and orders history", (t) => {
  const current = run(),
    previous = run();
  previous.date = "2026-11-16T12:00:00Z";
  previous.commit = { ...previous.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  previous.publish = { samples: [1], stats: distribution([1]) };
  const html = renderReport([current, previous], current);
  assert.doesNotMatch(html, /<script|(?:src|href)\s*=\s*["']https?:\/\//i);
  assert(html.includes("&lt;script&gt;"));
  assert(html.includes("&lt;img src=&quot;"));
  assert(html.includes("BUSY"));
  assert(html.includes("Missing route"));
  assert(html.includes("&amp; unavailable"));
  assert(html.includes("200%"));
  assert(html.includes("<svg"));
  assert(html.indexOf("<code>bbbb") < html.indexOf("<code>aaaa"));
  const out = mkdtempSync(join(tmpdir(), "emend-report-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeReport(out, previous);
  const json = writeReport(out, current);
  assert.deepEqual(JSON.parse(readFileSync(json, "utf8")), current);
  assert(readFileSync(join(out, "report.html"), "utf8").includes("<code>bbbb"));
});

test("prototype-named metrics use fallback labels and survive writing the report", (t) => {
  const names = ["constructor", "__proto__", "toString"];
  const values = Object.fromEntries(names.map((name, index) => [name, [index + 10]]));
  const current = run();
  current.measurements = [
    reportMeasurement("inbox", "laptop", "cold", values),
    reportMeasurement("inbox", "phone", "warm", values),
  ];
  const saved: unknown = JSON.parse(JSON.stringify(current));
  assert(isReportRun(saved));
  assert(Object.hasOwn(saved.measurements[0].metrics, "__proto__"));
  const out = mkdtempSync(join(tmpdir(), "emend-metric-names-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const notes: string[] = [];
  const json = writeReport(out, saved, (note) => notes.push(note));
  assert.deepEqual(notes, []);
  assert.deepEqual(JSON.parse(readFileSync(json, "utf8")), saved);
  for (const html of [renderReport([saved], saved), readFileSync(join(out, "report.html"), "utf8")]) {
    for (const [index, name] of names.entries()) {
      const rows = [...html.matchAll(new RegExp(`<tr data-metric="${name}">([\\s\\S]*?)</tr>`, "g"))];
      assert.equal(rows.length, 3, `${name}: current, cold history and warm history`);
      for (const row of rows) assert(row[1].includes(`<th scope="row">${name}</th>`));
      assert(rows[0][1].includes(`<strong>${index + 10}</strong>`));
      assert(rows[1][1].includes(`Laptop: ${index + 10}`));
      assert(rows[2][1].includes(`Phone: ${index + 10}`));
    }
  }
});

test("report cells and history use only own metric values", () => {
  const previous = run(), current = run();
  previous.commit = { ...previous.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  previous.measurements = [reportMeasurement("inbox", "laptop", "cold", {
    timeMs: [1], constructor: [2], ["__proto__"]: [3], toString: [4],
    "api GET /api/v1/reviews median": [5],
  })];
  const inherited = Object.fromEntries(Object.keys(previous.measurements[0].metrics)
    .map((key) => [key, distribution([987654])]));
  current.measurements = [{ ...previous.measurements[0], metrics: Object.create(inherited) }];
  const html = renderReport([previous, current], current);
  assert(!html.includes("987,654"), "inherited values must not reach cells, history or charts");
  const row = html.match(/<tr data-metric="constructor">([\s\S]*?)<\/tr>/)?.[1];
  assert(row);
  assert.equal((row.match(/No measurement/g) ?? []).length, 4);
});

test("history tables retain warm-only and API metrics from older runs for both viewports", () => {
  const current = run(), previous = run();
  previous.commit = { ...previous.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  previous.measurements = [{
    journey: "review", viewport: "laptop", temperature: "warm", readiness: "Synthetic content", samples: [],
    metrics: {
      "js.loaded.raw": distribution([123]),
      "warm-only": distribution([456]),
      "api GET /api/v1/old-route median": distribution([7]),
      "api GET /api/v1/old-route max": distribution([9]),
      "api GET /api/v1/old-route count": distribution([2]),
    },
  }];
  current.measurements = [{
    journey: "review", viewport: "phone", temperature: "warm", readiness: "Synthetic content", samples: [],
    metrics: { "js.loaded.raw": distribution([321]) },
  }];
  const html = renderReport([current, previous], current);
  const review = html.match(/<section id="review">([\s\S]*?)<\/section>/)?.[1];
  const history = review?.match(/<details><summary>History · warm<\/summary>([\s\S]*?)<\/details>/)?.[1];
  assert(history);
  assert.match(history, /title="2026-10-25T12:00:00Z">bbbbbbbb/);
  assert(history.indexOf(">bbbbbbbb") < history.indexOf(">aaaaaaaa"));
  for (const key of Object.keys(previous.measurements[0].metrics)) assert(history.includes(`data-metric="${key}"`));
  const row = history.match(/<tr data-metric="js.loaded.raw">([\s\S]*?)<\/tr>/)?.[1];
  assert(row?.includes("Laptop: 123") && row.includes("Phone: 321"));
  assert(row.includes("Phone: —") && row.includes("Laptop: —"));
  assert(review?.includes("History · cold"));
});

test("skipped steps retain every full name and reason, including journeys with the same viewport", () => {
  const current = run();
  current.skipped = [
    { step: "laptop/review/warm/3", reason: "Review route missing" },
    { step: "laptop/pub/warm/2", reason: "Document switch unavailable" },
    { step: "laptop/pub/warm/3", reason: "Different document error" },
  ];
  const html = renderReport([current], current);
  const skipped = html.slice(html.indexOf('<section id="skipped">'));
  for (const { step, reason } of current.skipped) {
    assert(skipped.includes(`<strong>${step}</strong> — ${reason}`));
  }
  assert.match(html, /class="run-status busy">clean · BUSY · 3 skipped/);
});

test("stray and truncated JSON files are omitted with one-line notes and valid history survives", (t) => {
  const out = mkdtempSync(join(tmpdir(), "emend-stray-report-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const previous = run(), current = run();
  previous.commit = { ...previous.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  writeReport(out, previous);
  writeFileSync(join(out, "truncated.json"), '{"schemaVersion":');
  writeFileSync(join(out, "foreign.json"), '{"name":"synthetic"}');
  const notes: string[] = [];
  writeReport(out, current, (note) => notes.push(note));
  assert.equal(notes.length, 2);
  assert(notes.every((note) => !/[\r\n]/.test(note)));
  assert(notes.some((note) => note.includes('"truncated.json"')));
  assert(notes.some((note) => note.includes('"foreign.json"')));
  const html = readFileSync(join(out, "report.html"), "utf8");
  assert(html.includes("<code>bbbbbbbbbbbb</code>") && html.includes("<code>aaaaaaaaaaaa</code>"));
  assert.equal(readFileSync(join(out, "truncated.json"), "utf8"), '{"schemaVersion":');
  assert.equal(readFileSync(join(out, "foreign.json"), "utf8"), '{"name":"synthetic"}');
});

test("saved run validation checks nested metrics, skipped reasons, load and optional seal fields", () => {
  const valid = run();
  valid.measurements = [{
    journey: "inbox", viewport: "laptop", temperature: "cold", readiness: "Synthetic content", samples: [],
    metrics: { timeMs: distribution([1, 2, 3]) },
  }];
  assert(isReportRun(valid));
  const measurement = valid.measurements[0];
  for (const invalid of [
    null, [], { ...valid, schemaVersion: 2 }, { ...valid, commit: { ...valid.commit, sha: 4 } },
    { ...valid, commit: { ...valid.commit, date: "invalid" } }, { ...valid, date: null },
    { ...valid, loadStart: ["1"] }, { ...valid, loadEnd: null }, { ...valid, cpus: "2" },
    { ...valid, measurements: {} }, { ...valid, measurements: [null] },
    { ...valid, measurements: [{ ...measurement, journey: "unknown" }] },
    { ...valid, measurements: [{ ...measurement, viewport: [] }] },
    { ...valid, measurements: [{ ...measurement, temperature: "hot" }] },
    { ...valid, measurements: [{ ...measurement, metrics: { timeMs: { median: "1" } } }] },
    { ...valid, skipped: [{ step: "run", reason: null }] },
    { ...valid, publish: { stats: null } }, { ...valid, seal: { vanishedRequests: "0" } },
  ]) assert(!isReportRun(invalid));
});

test("run JSON preserves seal counts and the run list distinguishes zero from historical missing counts", (t) => {
  const out = mkdtempSync(join(tmpdir(), "emend-seal-report-test-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const historical = run(), requestsOnly = run(), zero = run(), current = run();
  historical.commit = { ...historical.commit, sha: "d".repeat(40), date: "2026-10-23T12:00:00Z" };
  delete historical.seal;
  requestsOnly.commit = { ...requestsOnly.commit, sha: "c".repeat(40), date: "2026-10-24T12:00:00Z" };
  requestsOnly.seal = { vanishedRequests: 1 };
  zero.commit = { ...zero.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  current.seal = {
    vanishedRequests: 2, vanishedTargets: 3,
    vanishedRequestsByKind: { gone: 1, "invalid-interception": 1 },
    vanishedRequestEvents: [
      { kind: "gone", resourceType: "Fetch", path: "/api/v1/reviews", attached: false },
      { kind: "invalid-interception", resourceType: "Script", path: "/assets/app.js", attached: true },
    ],
  };
  writeReport(out, historical);
  writeReport(out, requestsOnly);
  const zeroPath = writeReport(out, zero);
  const currentPath = writeReport(out, current);
  assert.deepEqual(JSON.parse(readFileSync(zeroPath, "utf8")).seal, {
    vanishedRequests: 0, vanishedTargets: 0,
    vanishedRequestsByKind: { gone: 0, "invalid-interception": 0 }, vanishedRequestEvents: [],
  });
  assert.deepEqual(JSON.parse(readFileSync(currentPath, "utf8")).seal, current.seal);
  const html = readFileSync(join(out, "report.html"), "utf8");
  const list = html.match(/<ol class="run-list">([\s\S]*?)<\/ol>/)?.[1];
  assert(list);
  const rows = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]);
  assert.equal(rows.length, 4);
  assert(rows[0].includes("dddddddddddd") && rows[0].includes("vanished requests not recorded") && rows[0].includes("vanished targets not recorded"));
  assert(rows[1].includes("cccccccccccc") && rows[1].includes("1 vanished requests tolerated") && rows[1].includes("vanished targets not recorded"));
  assert(rows[2].includes("bbbbbbbbbbbb") && rows[2].includes("0 vanished requests tolerated") && rows[2].includes("0 vanished targets tolerated"));
  assert(rows[3].includes("aaaaaaaaaaaa") && rows[3].includes("2 vanished requests tolerated") && rows[3].includes("3 vanished targets tolerated"));
  assert(rows[0].includes("request kinds not recorded") && rows[1].includes("request kinds not recorded"));
  assert(rows[2].includes("gone: 0") && rows[2].includes("invalid-interception: 0"));
  assert(rows[3].includes("gone: 1") && rows[3].includes("invalid-interception: 1"));
});

test("report kind totals cover all tolerated requests after the diagnostic list fills", () => {
  const current = run();
  current.seal = {
    vanishedRequests: 61, vanishedTargets: 0,
    vanishedRequestsByKind: { gone: 6, "invalid-interception": 55 },
    vanishedRequestEvents: Array.from({ length: 50 }, (_, i) => ({
      kind: "invalid-interception", resourceType: "Script", path: `/assets/${i}.js`, attached: true,
    })),
  };
  const html = renderReport([current], current);
  const list = html.match(/<ol class="run-list">([\s\S]*?)<\/ol>/)?.[1];
  assert(list?.includes("61 vanished requests tolerated"));
  assert(list?.includes("gone: 6") && list.includes("invalid-interception: 55"));
  assert(html.includes("first 50 diagnostic entries"));
});

test("route patterns group IDs, revisions and hashes without erasing route versions or query secrets", () => {
  assert.equal(
    routePattern("/api/v1/reviews/00000000-0000-4000-8000-000000000175/revisions/2?token=ignored"),
    "/api/v1/reviews/:id/revisions/:revision",
  );
  assert.equal(routePattern(`/api/v1/blobs/${"a".repeat(64)}`), "/api/v1/blobs/:hash");
  assert.equal(routePattern("/api/v1/capabilities"), "/api/v1/capabilities");
});

test("byte counts use disk gzip, warm responses transfer no bytes, API timings use headers minus send", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-metrics-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "assets"));
  const js = "export const synthetic = 1;";
  writeFileSync(join(root, "assets/app.js"), js);
  const origin = "http://127.0.0.1:43210";
  for (const cache of ["network", "disk", "memory", "worker", "prefetch", "304", "revalidated"]) {
    const metrics = new NetworkMeasurement(root, origin);
    metrics.event({ method: "Network.requestWillBeSent", requestId: "1", request: { method: "GET", url: `${origin}/assets/app.js` } }, "page", "page");
    if (cache === "memory") metrics.event({ method: "Network.requestServedFromCache", requestId: "1" }, "page", "page");
    metrics.event(
      {
        method: "Network.responseReceived",
        requestId: "1",
        response: {
          url: `${origin}/assets/app.js`,
          status: cache === "304" ? 304 : 200,
          fromDiskCache: cache === "disk",
          fromServiceWorker: cache === "worker",
          fromPrefetchCache: cache === "prefetch",
          encodedDataLength: 999999,
        },
      },
      "page",
      "page",
    );
    if (cache === "revalidated")
      metrics.event({ method: "Network.responseReceivedExtraInfo", requestId: "1", statusCode: 304 }, "page", "page");
    metrics.event({ method: "Network.requestWillBeSent", requestId: "2", request: { method: "POST", url: `${origin}/api/v1/reviews` } }, "page", "page");
    metrics.event(
      {
        method: "Network.responseReceived",
        requestId: "2",
        response: { url: `${origin}/api/v1/reviews`, status: 200, timing: { sendStart: 2, receiveHeadersEnd: 9 } },
      },
      "page",
      "page",
    );
    const result = metrics.finish();
    assert.equal(result.js.loaded.raw, Buffer.byteLength(js));
    assert.equal(result.js.loaded.gzip, gzipSync(js, { level: 9 }).length);
    assert.equal(result.js.transferred.raw, cache === "network" ? Buffer.byteLength(js) : 0);
    assert.equal(result.js.transferred.gzip, cache === "network" ? gzipSync(js, { level: 9 }).length : 0);
    assert.deepEqual(result.network, { files: cache === "network" ? 1 : 0, ...result.js.transferred });
    assert.deepEqual(result.sw, { files: 0, raw: 0, gzip: 0 });
    assert.deepEqual(result.api, [{ route: "POST /api/v1/reviews", count: 1, median: 7, max: 7 }]);
  }
});

test("argument parsing rejects unknown or incomplete flags", () => {
  assert.equal(parseArgs([], "/checkout").out, "/checkout/.wt/perf");
  assert.equal(parseArgs(["--ref", "HEAD~1", "--no-build", "--keep"]).ref, "HEAD~1");
  for (const args of [["--unknown"], ["--ref"], ["--out", "--keep"]]) assert.throws(() => parseArgs(args), /Usage:/);
  assert.deepEqual(distribution([5, 1, 3]), { count: 3, median: 3, min: 1, max: 5, spread: 4 });
});

test("CDP fields are narrowed before recording requests, response sizes and API timings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-cdp-fields-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const measurement = new NetworkMeasurement(root, origin);
  for (const request of [undefined, null, "invalid", { url: 1, method: "GET" }, { url: origin, method: 1 }])
    measurement.event({ method: "Network.requestWillBeSent", requestId: "invalid", request }, "page", "page");
  measurement.event({ method: "Network.requestWillBeSent", requestId: 1 }, "page", "page");
  const url = `${origin}/api/v1/reviews`;
  const timing = { sendStart: 2, receiveHeadersEnd: 9 };
  const responses = [
    null, "invalid", { url: 1, status: 200, timing }, { url, status: "200", timing },
    { url, status: 200, fromDiskCache: "false", timing },
    { url, status: 200, timing: "invalid" },
    { url, status: 200, timing: { sendStart: "2", receiveHeadersEnd: 9 } },
    { url, status: 200, timing: { sendStart: 2, receiveHeadersEnd: "9" } },
    { url, status: 200, timing: { sendStart: 2, receiveHeadersEnd: Infinity } },
    { url, status: 200, timing },
  ];
  for (const [index, response] of responses.entries()) {
    const requestId = String(index);
    measurement.event({ method: "Network.requestWillBeSent", requestId, request: { url, method: "GET" } }, "page", "page");
    measurement.event({ method: "Network.responseReceived", requestId, response }, "page", "page");
  }
  const result = measurement.finish();
  assert.deepEqual(result.api, [{ route: "GET /api/v1/reviews", count: 1, median: 7, max: 7 }]);
  assert.deepEqual(result.network, { files: 0, raw: 0, gzip: 0 });
});

test("seeding uses distinct publish keys, reviewer APIs and CLI replies; extra publishes are not part of the seed", async (t) => {
  const { seed } = await import("./perf/seed.ts");
  const root = mkdtempSync(join(tmpdir(), "emend-seed-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keys = new Set<string>();
  const gitCalls: { cwd: string; args: string[] }[] = [];
  const committed = new Set<string>();
  let publishes = 0,
    replies = 0,
    actions = 0;
  const result = await seed({
    root,
    git: (cwd, ...args) => {
      gitCalls.push({ cwd, args });
      if (args[0] === "commit") committed.add(cwd);
      return "a".repeat(40);
    },
    page: {
      eval: async () => {
        actions++;
        return { status: 200, text: JSON.stringify({ commentId: "synthetic-comment" }) };
      },
    } as unknown as import("./screenshots/browser.ts").Page,
    cli: async (args, cwd) => {
      assert(committed.has(cwd), "every repo-aware CLI call starts in its own committed fixture repo");
      if (args[0] === "reply") {
        replies++;
        return "{}";
      }
      publishes++;
      if (args.includes("--manifest")) {
        assert(args.includes("--key"), "otherwise code publishes on the same branch update one review");
        const key = args[args.indexOf("--key") + 1];
        assert(!keys.has(key));
        keys.add(key);
      } else assert.equal(cwd, args[1], "publication starts in the pub repo, not the sealed root");
      return JSON.stringify({ reviewId: `synthetic-${publishes}` });
    },
    skip: (step, error) => assert.fail(`${step}: ${error}`),
  });
  assert.equal(new Set(result.reviewIds).size, SEED.inboxReviews);
  assert.equal(publishes, SEED.inboxReviews);
  assert.equal(replies, SEED.repliedReviews);
  assert(actions > SEED.commentedReviews);
  assert.deepEqual(gitCalls.filter((call) => call.cwd === result.pubFolder).map((call) => call.args), [
    ["init", "-q"], ["add", "."], ["commit", "-qm", "docs: synthetic handbook"],
  ]);
});

test("seed and timed publication share the pub repository working folder", async () => {
  const { publishPub, PUB_TITLE } = await import("./perf/seed.ts");
  const folder = "/tmp/synthetic-perf/handbook";
  for (const fresh of [false, true]) {
    let calls = 0;
    const output = await publishPub(async (args, cwd) => {
      calls++;
      assert.equal(cwd, folder);
      assert.deepEqual(args, ["publish", folder, "--title", PUB_TITLE, ...(fresh ? ["--new"] : []), "--json"]);
      return "synthetic output";
    }, folder, fresh);
    assert.equal(calls, 1);
    assert.equal(output, "synthetic output");
  }
});

function assetResponse(
  measurement: NetworkMeasurement,
  session: string,
  sessionType: string | undefined,
  id: string,
  response: Record<string, unknown>,
) {
  measurement.event(
    { method: "Network.requestWillBeSent", requestId: id, request: { method: "GET", url: response.url } },
    session,
    sessionType,
  );
  // The session type is captured at request time, even if the target detaches before its response.
  measurement.event({ method: "Network.responseReceived", requestId: id, response }, session, undefined);
}

test("page figures count documents only and dedicated worker scripts have separate figures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-loaded-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const assets = { js: "export const synthetic = 1;", css: "body { color: blue; }" };
  for (const [kind, bytes] of Object.entries(assets)) writeFileSync(join(root, `app.${kind}`), bytes);
  for (const type of ["page", "iframe", "worker", "service_worker", "shared_worker", undefined]) {
    const measurement = new NetworkMeasurement(root, origin);
    for (const kind of ["js", "css"] as const)
      assetResponse(measurement, "session", type, kind, { url: `${origin}/app.${kind}`, status: 200 });
    const result = measurement.finish();
    const loaded = type === "page" || type === "iframe";
    for (const kind of ["js", "css"] as const) {
      const expected = loaded
        ? { raw: Buffer.byteLength(assets[kind]), gzip: gzipSync(assets[kind], { level: 9 }).length }
        : { raw: 0, gzip: 0 };
      assert.deepEqual(result[kind], { loaded: expected, transferred: expected }, `${type}: ${kind}`);
    }
    const worker = type === "worker"
      ? { raw: Buffer.byteLength(assets.js), gzip: gzipSync(assets.js, { level: 9 }).length }
      : { raw: 0, gzip: 0 };
    assert.deepEqual(result.worker, { loaded: worker, transferred: worker }, `${type}: worker scripts`);
    assert.deepEqual(result.network, {
      files: 2,
      raw: Object.values(assets).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
      gzip: Object.values(assets).reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).length, 0),
    }, `${type}: network total`);
    assert.deepEqual(result.sw, loaded || type === "worker"
      ? { files: 0, raw: 0, gzip: 0 }
      : result.network, `${type}: service worker only`);
    const metrics = sampleMetrics({ timeMs: 0, longTasks: { count: 0, totalMs: 0 }, traffic: result });
    for (const source of ["loaded", "transferred"] as const)
      for (const unit of ["raw", "gzip"] as const)
        assert.equal(metrics[`worker.${source}.${unit}`], result.worker[source][unit]);
    for (const field of ["files", "raw", "gzip"] as const)
      assert.equal(metrics[`network.${field}`], result.network[field]);
  }
});

test("service worker network fetches count once only for assets also requested by the page", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-worker-transfer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const assets = { js: "export const synthetic = 1;", css: "body { color: blue; }" };
  for (const [kind, bytes] of Object.entries(assets)) {
    writeFileSync(join(root, `app.${kind}`), bytes);
    writeFileSync(join(root, `unused.${kind}`), `${bytes}\n`);
  }
  for (const workerFirst of [true, false]) {
    for (const duplicateId of [true, false]) {
      const measurement = new NetworkMeasurement(root, origin);
      const sessions = workerFirst ? ["service_worker", "page"] : ["page", "service_worker"];
      for (const kind of ["js", "css"] as const) {
        assetResponse(measurement, "sw", "service_worker", `unused-${kind}`, { url: `${origin}/unused.${kind}`, status: 200 });
        for (const type of sessions) {
          assetResponse(measurement, type, type, duplicateId ? kind : `${type}-${kind}`, {
            url: `${origin}/app.${kind}`, status: 200, fromServiceWorker: type === "page",
          });
        }
      }
      const result = measurement.finish();
      for (const kind of ["js", "css"] as const) {
        const size = { raw: Buffer.byteLength(assets[kind]), gzip: gzipSync(assets[kind], { level: 9 }).length };
        assert.deepEqual(result[kind], { loaded: size, transferred: size });
      }
      const fetched = Object.values(assets).flatMap((bytes) => [bytes, `${bytes}\n`]);
      assert.deepEqual(result.network, {
        files: 4,
        raw: fetched.reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
        gzip: fetched.reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).length, 0),
      });
      const unused = Object.values(assets).map((bytes) => `${bytes}\n`);
      assert.deepEqual(result.sw, {
        files: 2,
        raw: unused.reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
        gzip: unused.reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).length, 0),
      });
    }
  }
});

test("page and service worker precache races leave byte figures unchanged in every order and outcome", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-precache-race-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const bytes = "export const synthetic = 1;";
  writeFileSync(join(root, "app.js"), bytes);
  const size = { raw: Buffer.byteLength(bytes), gzip: gzipSync(bytes, { level: 9 }).length };
  const orders = [["page", "service_worker"], ["service_worker", "page"]];
  for (const requests of orders) {
    for (const responses of orders) {
      for (const winner of ["page", "service_worker"]) {
        const measurement = new NetworkMeasurement(root, origin);
        for (const type of requests) measurement.event({
          method: "Network.requestWillBeSent", requestId: "asset",
          request: { method: "GET", url: `${origin}/app.js` },
        }, type, type);
        for (const type of responses) measurement.event({
          method: "Network.responseReceived", requestId: "asset",
          response: { url: `${origin}/app.js`, status: 200, fromDiskCache: type !== winner },
        }, type, undefined);
        const result = measurement.finish();
        const label = `requests ${requests}, responses ${responses}, network ${winner}`;
        assert.deepEqual(result.js, { loaded: size, transferred: size }, label);
        assert.deepEqual(result.network, { files: 1, ...size }, label);
        assert.deepEqual(result.sw, { files: 0, raw: 0, gzip: 0 }, label);
        assert.deepEqual(result.worker, { loaded: { raw: 0, gzip: 0 }, transferred: { raw: 0, gzip: 0 } }, label);
      }
    }
  }
});

test("page-tree requests without responses keep files out of service worker only figures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-request-only-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const bytes = "export const syntheticWorker = 1;";
  writeFileSync(join(root, "worker.js"), bytes);
  const empty = { loaded: { raw: 0, gzip: 0 }, transferred: { raw: 0, gzip: 0 } };
  for (const type of ["page", "iframe", "worker"]) {
    for (const swFirst of [true, false]) {
      const measurement = new NetworkMeasurement(root, origin);
      const requested = () => measurement.event({
        method: "Network.requestWillBeSent", requestId: "main-script",
        request: { method: "GET", url: `${origin}/worker.js?version=1` },
      }, "document-or-worker", type);
      const fetched = () => assetResponse(measurement, "sw", "service_worker", "precache", {
        url: `${origin}/worker.js`, status: 200,
      });
      for (const event of swFirst ? [fetched, requested] : [requested, fetched]) event();
      const result = measurement.finish();
      assert.deepEqual(result.network, { files: 1, raw: Buffer.byteLength(bytes), gzip: gzipSync(bytes, { level: 9 }).length });
      assert.deepEqual(result.sw, { files: 0, raw: 0, gzip: 0 }, type);
      assert.deepEqual(result.js, empty, "a main script request without a response is not loaded");
      assert.deepEqual(result.worker, empty);
    }
  }
});

test("service worker navigation pass-through counts the folder index once in network and never in sw", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-navigation-transfer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const bytes = "<!doctype html><title>Synthetic</title>";
  writeFileSync(join(root, "index.html"), bytes);
  for (const swPath of ["/", "/index.html"]) {
    for (const sessions of [["page", "service_worker"], ["service_worker", "page"]]) {
      const measurement = new NetworkMeasurement(root, origin);
      for (const type of sessions) assetResponse(measurement, type, type, "navigation", {
        url: `${origin}${type === "page" ? "/" : swPath}`, status: 200, fromServiceWorker: type === "page",
      });
      const result = measurement.finish();
      assert.deepEqual(result.network, { files: 1, raw: Buffer.byteLength(bytes), gzip: gzipSync(bytes, { level: 9 }).length });
      assert.deepEqual(result.sw, { files: 0, raw: 0, gzip: 0 });
    }
  }
});

test("dedicated worker scripts transfer once across sessions and shared document assets stay in page figures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-worker-scripts-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const bytes = "export const syntheticHighlighter = 1;";
  writeFileSync(join(root, "highlight.js"), bytes);
  const size = { raw: Buffer.byteLength(bytes), gzip: gzipSync(bytes, { level: 9 }).length };
  const zero = { raw: 0, gzip: 0 };
  for (const document of [undefined, "page", "iframe"]) {
    for (const mode of ["network", "disk", "memory", "worker", "prefetch", "304", "revalidated"]) {
      for (const swFetch of [false, true]) {
        for (const workerFirst of [false, true]) {
          const measurement = new NetworkMeasurement(root, origin);
          const worker = () => {
            // Two dedicated workers request the same highlighter script.
            for (const session of ["worker-one", "worker-two"]) {
              assetResponse(measurement, session, "worker", "script", {
                url: `${origin}/highlight.js`, status: mode === "304" ? 304 : 200,
                fromDiskCache: mode === "disk", fromServiceWorker: mode === "worker", fromPrefetchCache: mode === "prefetch",
              });
              if (mode === "memory")
                measurement.event({ method: "Network.requestServedFromCache", requestId: "script" }, session, "worker");
              if (mode === "revalidated")
                measurement.event({ method: "Network.responseReceivedExtraInfo", requestId: "script", statusCode: 304 }, session, "worker");
            }
          };
          const other = () => {
            if (document) assetResponse(measurement, "document", document, "script", {
              url: `${origin}/highlight.js`, status: 200, fromDiskCache: true,
            });
            if (swFetch) assetResponse(measurement, "sw", "service_worker", "script", {
              url: `${origin}/highlight.js`, status: 200,
            });
          };
          for (const event of workerFirst ? [worker, other] : [other, worker]) event();
          const result = measurement.finish();
          const network = mode === "network" || swFetch;
          const expected = { loaded: size, transferred: network ? size : zero };
          const empty = { loaded: zero, transferred: zero };
          assert.deepEqual(result.js, document ? expected : empty);
          assert.deepEqual(result.worker, document ? empty : expected);
          assert.deepEqual(result.network, { files: network ? 1 : 0, ...(network ? size : zero) });
          assert.deepEqual(result.sw, { files: 0, ...zero });
        }
      }
    }
  }
});

test("network accounting counts repeated page fetches and duplicate worker events once per file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-transfer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const js = "export const synthetic = 1;";
  writeFileSync(join(root, "app.js"), js);
  const origin = "http://127.0.0.1:43210";
  const measurement = new NetworkMeasurement(root, origin);
  for (const [id, session, status] of [
    ["1", "page", 200],
    ["2", "page", 200],
    ["2", "worker", 200],
    ["3", "page", 304],
  ] as const) {
    assetResponse(measurement, session, session, id, { url: `${origin}/app.js`, status: 200 });
    measurement.event({ method: "Network.responseReceivedExtraInfo", requestId: id, statusCode: status }, session, session);
  }
  const result = measurement.finish();
  assert.equal(result.js.loaded.raw, Buffer.byteLength(js));
  assert.deepEqual(result.js.transferred, result.js.loaded);
  assert.equal(result.js.transferred.gzip, gzipSync(js, { level: 9 }).length);
  assert.deepEqual(result.network, { files: 1, ...result.js.loaded });
  assert.deepEqual(result.sw, { files: 0, raw: 0, gzip: 0 });
  assert.deepEqual(result.worker, { loaded: { raw: 0, gzip: 0 }, transferred: { raw: 0, gzip: 0 } });
});

test("asset paths stay inside the measured build, including worker-only requests and symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-asset-guard-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(root, "outside.js"), "export const synthetic = 1;");
  symlinkSync(join(root, "outside.js"), join(dist, "escape.js"));
  const origin = "http://127.0.0.1:43210";
  for (const type of ["page", "iframe", "worker", "service_worker"]) {
    for (const path of ["/%2e%2e%2foutside.js", "/escape.js"]) {
      const measurement = new NetworkMeasurement(dist, origin);
      assetResponse(measurement, "session", type, "asset", { url: `${origin}${path}`, status: 200 });
      assert.throws(() => measurement.finish(), /Asset leaves the measured web build/);
    }
  }
});

test("service worker fetches include every build file type once and resolve folder indexes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-sw-files-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "empty"));
  const files = {
    "app.js": "export const synthetic = 1;",
    "style.css": "body { color: blue; }",
    "index.html": "<!doctype html><title>Synthetic</title>",
    "docs/index.html": "<!doctype html><title>Synthetic docs</title>",
    "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32]),
    "manifest.webmanifest": '{"name":"Synthetic"}',
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, name), bytes);
  const measurement = new NetworkMeasurement(root, origin);
  // Repeat fetches in one session and duplicate CDP reports in another both count once.
  for (const session of ["sw-one", "sw-two"]) {
    for (const repeat of [1, 2]) {
      for (const name of Object.keys(files))
        assetResponse(measurement, session, "service_worker", `${repeat}-${name}`, {
          url: `${origin}/${name}?cache=${repeat}`, status: 200, encodedDataLength: 999999,
        });
    }
  }
  for (const path of ["/", "/docs", "/docs/", "/empty/", "/missing.js", "/missing.json", "/api/v1/reviews"]) {
    assetResponse(measurement, "sw-one", "service_worker", path, { url: `${origin}${path}`, status: 200 });
  }
  const result = measurement.finish();
  const empty = { loaded: { raw: 0, gzip: 0 }, transferred: { raw: 0, gzip: 0 } };
  assert.deepEqual(result.js, empty);
  assert.deepEqual(result.css, empty);
  assert.deepEqual(result.worker, empty);
  assert.deepEqual(result.sw, {
    files: Object.keys(files).length,
    raw: Object.values(files).reduce((sum, bytes) => sum + Buffer.byteLength(bytes), 0),
    gzip: Object.values(files).reduce((sum, bytes) => sum + gzipSync(bytes, { level: 9 }).length, 0),
  });
  assert.deepEqual(result.network, result.sw);
});

test("network and service worker figures exclude cache responses, 304s and unsuccessful fetches", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-sw-cache-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const bytes = "<!doctype html><title>Synthetic</title>";
  writeFileSync(join(root, "index.html"), bytes);
  for (const mode of ["network", "disk", "memory", "worker", "prefetch", "304", "revalidated", "error"]) {
    const measurement = new NetworkMeasurement(root, origin);
    assetResponse(measurement, "sw", "service_worker", "asset", {
      url: `${origin}/`, status: mode === "304" ? 304 : mode === "error" ? 500 : 200,
      fromDiskCache: mode === "disk", fromServiceWorker: mode === "worker", fromPrefetchCache: mode === "prefetch",
    });
    if (mode === "memory")
      measurement.event({ method: "Network.requestServedFromCache", requestId: "asset" }, "sw", "service_worker");
    if (mode === "revalidated")
      measurement.event({ method: "Network.responseReceivedExtraInfo", requestId: "asset", statusCode: 304 }, "sw", "service_worker");
    const result = measurement.finish();
    assert.deepEqual(result.sw, mode === "network"
      ? { files: 1, raw: Buffer.byteLength(bytes), gzip: gzipSync(bytes, { level: 9 }).length }
      : { files: 0, raw: 0, gzip: 0 }, mode);
    assert.deepEqual(result.network, result.sw, mode);
  }
});

test("service worker file and folder paths cannot escape the measured build", (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-sw-guard-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dist = join(root, "dist");
  mkdirSync(dist);
  mkdirSync(join(dist, "docs"));
  writeFileSync(join(root, "outside.html"), "<title>Synthetic</title>");
  symlinkSync(join(root, "outside.html"), join(dist, "docs/index.html"));
  symlinkSync(root, join(dist, "escape"));
  const origin = "http://127.0.0.1:43210";
  for (const path of ["/%2e%2e%2foutside.html", "/%2e%2e%2fmissing.png", "/escape/outside.html", "/escape/", "/docs/"]) {
    const measurement = new NetworkMeasurement(dist, origin);
    assetResponse(measurement, "sw", "service_worker", "asset", { url: `${origin}${path}`, status: 200 });
    assert.throws(() => measurement.finish(), /Asset leaves the measured web build/, path);
  }
});

test("file preparation settles the loaded review after file readiness and before opening Files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-file-prepare-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const steps: string[] = [];
  const frames: (() => void)[] = [];
  let selected: string | undefined = "000";
  let now = 10;
  const pane = { scrollTop: 0, scrollBy: (_x: number, y: number) => { pane.scrollTop += y; } };
  const file = {
    getBoundingClientRect: () => ({ height: 100 }), hasAttribute: () => false,
    querySelectorAll: () => [{ shadowRoot: { querySelector: () => ({}) } }],
    closest: () => pane,
  };
  const globals = {
    window: { __perfReady: null, __perfStart: 0, __perfTasks: [], __perfObserver: { takeRecords: () => [] } },
    navigator: {}, performance: { now: () => now++ },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    document: {
      querySelector: (selector: string) => {
        if (selector.startsWith("[data-diff-file]")) return selector.includes(`module-${selected}.ts`) ? file : null;
        if (selector.includes("Open diff for src/module-001.ts")) return {
          click: () => { steps.push("open second file"); selected = "001"; },
        };
        assert(selector.includes('-files"') && selector.includes("tab=files"), selector);
        return { click: () => { steps.push("Files tab click"); selected = undefined; } };
      },
    },
  };
  const page = {
    browser: {
      origin: "http://127.0.0.1:43210",
      on: () => { steps.push("recording started"); return () => { steps.push("recording stopped"); }; },
      check: () => undefined,
    },
    goto: async () => { steps.push("open review"); },
    waitFor: async (expression: string, what: string) => {
      assert(runInNewContext(expression, globals), what);
      steps.push(what);
    },
    eval: async (expression: string) => {
      const result = await runInNewContext(expression, globals);
      for (let count = 0; frames.length; count++) {
        assert(count < 10, "file readiness must settle after selecting and scrolling");
        frames.shift()?.();
      }
      return structuredClone(result);
    },
    settle: async (what: string, timeout?: number) => {
      steps.push(what);
      if (what === "the loaded review") assert.equal(timeout, 45_000);
    },
  } as unknown as Page;
  await sample(page, "file", "cold", { largeId: "synthetic-review", pubFolder: root, reviewIds: [] }, root);
  assert.deepEqual(steps, [
    "open review", "the first file", "the loaded review", "the Files tab", "Files tab click",
    "the second file in Files", "the journey setup", "recording started", "open second file",
    "the journey readiness condition", "the measured journey", "recording stopped",
  ]);
});

test("cold samples record through worker activation and a second settle without extending timings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "emend-sw-sample-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:43210";
  const bytes = "synthetic build content";
  for (const name of ["install.txt", "settled.txt"]) writeFileSync(join(root, name), bytes);
  for (const temperature of ["cold", "warm"] as const) {
    for (const presence of ["no API", "no registration", "registered"]) {
      const steps: string[] = [];
      let listener: ((event: Record<string, unknown>, session: string) => void) | undefined;
      const registration: { active: { state: string } | null } = { active: null };
      const globals = {
        window: {
          __perfReady: null as number | null, __perfStart: 0, __perfTasks: [],
          __perfObserver: { takeRecords: () => [{ startTime: 5, duration: 60 }, { startTime: 100, duration: 80 }] },
        },
        navigator: presence === "no API" ? {} : {
          serviceWorker: { getRegistrations: async () => presence === "registered" ? [registration] : [] },
        },
      };
      const fetched = (name: string) => {
        assert(listener, "traffic recording must remain active through activation and settle");
        listener({ method: "Network.requestWillBeSent", requestId: name, request: { method: "GET", url: `${origin}/${name}` } }, "sw");
        listener({ method: "Network.responseReceived", requestId: name, response: { url: `${origin}/${name}`, status: 200 } }, "sw");
      };
      const page = {
        browser: {
          origin,
          sessionType: () => "service_worker",
          on: (handler: typeof listener) => {
            listener = handler;
            return () => { steps.push("recording stopped"); listener = undefined; };
          },
          check: () => undefined,
        },
        send: async () => ({ identifier: "synthetic-script" }),
        eval: async (expression: string) => structuredClone(await runInNewContext(expression, globals)),
        goto: async () => { globals.window.__perfReady = 25; },
        waitFor: async (expression: string, what: string) => {
          steps.push(what);
          if (what === "service worker activation") {
            assert.equal(runInNewContext(expression, globals), false, "install is not activation");
            registration.active = { state: "activating" };
            assert.equal(runInNewContext(expression, globals), false, "an activating worker is not ready");
            fetched("install.txt");
            registration.active.state = "activated";
            // Later activity must not move the timing boundary already captured by the journey.
            globals.window.__perfReady = 1_000;
          }
          assert.equal(runInNewContext(expression, globals), true);
        },
        settle: async (what: string) => {
          steps.push(what);
          if (what === "the activated service worker") fetched("settled.txt");
        },
      } as unknown as Page;
      const result = await sample(page, "inbox", temperature, { pubFolder: root, reviewIds: [] }, root);
      const waits = temperature === "cold" && presence === "registered";
      assert.deepEqual(steps, ["the journey readiness condition", "the measured journey",
        ...(waits ? ["service worker activation", "the activated service worker"] : []), "recording stopped"]);
      assert.equal(listener, undefined);
      assert.equal(result.timeMs, 25);
      assert.deepEqual(result.longTasks, { count: 1, totalMs: 60 });
      assert.deepEqual(result.traffic.sw, waits
        ? { files: 2, raw: Buffer.byteLength(bytes) * 2, gzip: gzipSync(bytes, { level: 9 }).length * 2 }
        : { files: 0, raw: 0, gzip: 0 });
      assert.deepEqual(result.traffic.network, result.traffic.sw);
      const metrics = sampleMetrics(result);
      assert.equal(metrics["sw.files"], result.traffic.sw.files);
      assert.equal(metrics["sw.raw"], result.traffic.sw.raw);
      assert.equal(metrics["sw.gzip"], result.traffic.sw.gzip);
      assert.equal(metrics["network.files"], result.traffic.network.files);
      assert.equal(metrics["network.raw"], result.traffic.network.raw);
      assert.equal(metrics["network.gzip"], result.traffic.network.gzip);
    }
  }
});

function reportMeasurement(
  journey: PerfRun["measurements"][number]["journey"],
  viewport: "laptop" | "phone",
  temperature: "cold" | "warm",
  values: Record<string, number[]>,
): PerfRun["measurements"][number] {
  return {
    journey, viewport, temperature, readiness: "Synthetic content is visible", samples: [],
    metrics: Object.fromEntries(Object.entries(values).map(([key, samples]) => [key, distribution(samples)])),
  };
}

test("report charts scale a large range inside the view box, share axes and preserve gaps", () => {
  const laptop = [1_000_000, 2_000_000, undefined, 6_000_000, 7_000_000];
  const phone = [9_000_000, 8_000_000, undefined, 4_000_000, 3_000_000];
  const runs = laptop.map((value, index) => {
    const item = run();
    item.commit = { ...item.commit, sha: String.fromCharCode(97 + index).repeat(40), date: `2026-10-${21 + index}T12:00:00Z` };
    item.publish = null;
    if (value !== undefined) item.measurements.push(reportMeasurement("inbox", "laptop", "cold", { timeMs: [value] }));
    if (phone[index] !== undefined) item.measurements.push(reportMeasurement("inbox", "phone", "cold", { timeMs: [phone[index] as number] }));
    return item;
  });
  const html = renderReport([...runs].reverse(), runs[4]);
  const charts = [...html.matchAll(/<svg\b[^>]*viewBox="0 0 ([\d.]+) ([\d.]+)"[^>]*>([\s\S]*?)<\/svg>/g)];
  assert.equal(charts.length, 1, "only the populated headline metric gets a chart");
  const [, width, height, svg] = charts[0];
  const points = [...svg.matchAll(/<circle cx="([^"]+)" cy="([^"]+)"/g)];
  assert.equal(points.length, 8);
  for (const [, x, y] of points) {
    assert(Number.isFinite(Number(x)) && Number.isFinite(Number(y)));
    assert(Number(x) >= 0 && Number(x) <= Number(width), `x=${x} outside ${width}`);
    assert(Number(y) >= 0 && Number(y) <= Number(height), `y=${y} outside ${height}`);
  }
  assert.equal(Math.min(...points.map((p) => Number(p[2]))), 18);
  assert.equal(Math.max(...points.map((p) => Number(p[2]))), 108);
  for (const name of ["laptop", "phone"]) {
    const line = svg.match(new RegExp(`<g class="${name}">([\\s\\S]*?)</g>`));
    assert(line, name);
    assert.equal((line[1].match(/<line /g) ?? []).length, 2, `${name} must not connect across the missing run`);
  }
  assert(svg.includes("1,000,000") && svg.includes("9,000,000"), "axis labels show the shared range");
  assert(svg.includes("cccccccc") && svg.includes("2026-10-23"), "missing runs retain their x-axis labels");
  assert(html.includes("Laptop cold</span>") && html.includes("Phone cold</span>"), "both lines have legends");

  const constant = run();
  constant.publish = null;
  constant.measurements = [reportMeasurement("inbox", "laptop", "cold", { timeMs: [0] })];
  const flat = renderReport([constant], constant);
  assert.doesNotMatch(flat, /NaN|Infinity/);
  assert(flat.includes('cy="63"'), "a constant series sits at the middle of the plot");
});

test("report groups metrics by journey, orders headlines before raw bytes and separates API routes", () => {
  const current = run(), previous = run(), later = run();
  previous.commit = { ...previous.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  later.commit = { ...later.commit, sha: "c".repeat(40), date: "2026-10-27T12:00:00Z" };
  previous.measurements = [reportMeasurement("inbox", "laptop", "cold", { timeMs: [80, 100, 120] })];
  current.measurements = [
    reportMeasurement("inbox", "laptop", "cold", {
      "js.loaded.raw": [2000], "css.transferred.gzip": [100], "api GET /api/v1/reviews median": [4, 6, 8],
      "api GET /api/v1/reviews count": [3], "api GET /api/v1/reviews max": [20], timeMs: [120, 140, 160],
      "longTasks.count": [1], "longTasks.totalMs": [60], "js.loaded.gzip": [1000],
      "js.transferred.gzip": [500], "css.loaded.gzip": [200], "sw.gzip": [300], "sw.raw": [700], "sw.files": [4],
      "worker.loaded.gzip": [80], "worker.transferred.gzip": [40], "worker.loaded.raw": [160], "worker.transferred.raw": [90],
      "network.gzip": [940], "network.raw": [2400], "network.files": [9],
    }),
    reportMeasurement("inbox", "laptop", "warm", { timeMs: [70] }),
    reportMeasurement("inbox", "phone", "cold", { timeMs: [210] }),
    reportMeasurement("inbox", "phone", "warm", { timeMs: [110] }),
    reportMeasurement("pub", "phone", "cold", { timeMs: [200], openMs: [150], switchMs: [50] }),
  ];
  const html = renderReport([later, current, previous], current);
  assert.deepEqual([...html.matchAll(/<section id="([^"]+)"/g)].map((match) => match[1]),
    ["inbox", "review", "file", "composer", "pub", "cli-publish", "skipped"]);
  const inbox = html.match(/<section id="inbox">([\s\S]*?)<\/section>/)?.[1];
  assert(inbox);
  const currentTable = inbox.match(/<table class="">([\s\S]*?)<\/table>/)?.[1];
  assert(currentTable);
  assert.deepEqual([...currentTable.matchAll(/data-metric="([^"]+)"/g)].map((match) => match[1]), [
    "timeMs", "longTasks.count", "longTasks.totalMs", "js.loaded.gzip", "js.transferred.gzip",
    "css.loaded.gzip", "css.transferred.gzip", "worker.loaded.gzip", "worker.transferred.gzip", "network.gzip", "sw.gzip",
    "js.loaded.raw", "js.transferred.raw", "css.loaded.raw", "css.transferred.raw", "worker.loaded.raw", "worker.transferred.raw",
    "network.raw", "network.files", "sw.raw", "sw.files",
  ]);
  const headings = [...inbox.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headings.slice(0, 5), ["Metric", "Laptop cold", "Laptop warm", "Phone cold", "Phone warm"]);
  const row = inbox.match(/<tr data-metric="timeMs">([\s\S]*?)<\/tr>/)?.[1];
  assert(row);
  assert.deepEqual([...row.matchAll(/<strong>([^<]+)<\/strong>/g)].map((match) => match[1]), ["140", "70", "210", "110"]);
  assert(row.includes("Spread 40") && row.includes("Δ +40 (+40%)"), "delta uses the preceding commit, not the last input run");
  assert(inbox.includes('<table class="api-table">'));
  assert(inbox.includes("<code>GET /api/v1/reviews</code>"));
  assert(!currentTable.includes("api GET /api/v1/reviews count") && !currentTable.includes("api GET /api/v1/reviews max"));
  assert(inbox.includes("api GET /api/v1/reviews count") && inbox.includes("api GET /api/v1/reviews max"), "history includes every API figure");
  assert.equal((inbox.match(/<svg /g) ?? []).length, 11, "only the eleven headline metrics get charts");
  const newFigures = [
    ["worker.loaded.gzip", "Worker scripts loaded · gzip", "80"],
    ["worker.transferred.gzip", "Worker scripts transferred · gzip", "40"],
    ["worker.loaded.raw", "Worker scripts loaded · raw", "160"],
    ["worker.transferred.raw", "Worker scripts transferred · raw", "90"],
    ["network.gzip", "Network total · gzip", "940"], ["network.raw", "Network total · raw", "2,400"],
    ["network.files", "Network total", "9"],
    ["sw.gzip", "Service worker only · gzip", "300"], ["sw.raw", "Service worker only · raw", "700"],
    ["sw.files", "Service worker only", "4"],
  ];
  for (const [metric, label, value] of newFigures) {
    const row = inbox.match(new RegExp(`<tr data-metric="${metric.replaceAll(".", "\\.")}">([\\s\\S]*?)</tr>`))?.[1];
    assert(row?.includes(label) && row.includes(`<strong>${value}</strong>`), metric);
    assert(row.includes("Δ — (no previous measurement)"), "absent historical figures have no delta");
  }
  for (const journey of ["inbox", "review", "file", "composer", "pub"]) {
    const section = html.match(new RegExp(`<section id="${journey}">([\\s\\S]*?)</section>`))?.[1];
    for (const [metric] of newFigures) assert(section?.includes(`data-metric="${metric}"`), `${journey}: ${metric} row`);
  }
  const pub = html.match(/<section id="pub">([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.deepEqual([...pub.matchAll(/data-metric="([^"]+)"/g)].slice(0, 3).map((match) => match[1]), ["timeMs", "openMs", "switchMs"]);
  assert(html.includes("prefers-color-scheme:dark"));
  assert(html.includes("JS and CSS files requested by the page and its frames, each counted once"));
  assert(html.includes("Chromium reports its request without a response"));
  assert(html.includes("whichever fetch reached the network first"));
  assert(html.includes("HTTP cache hits, 304 responses and service worker responses do not count as network fetches"));
  assert(html.includes("Folder paths use index.html; paths without a build file are omitted"));
  assert(html.includes("this wait is outside all timings"));
});

test("historical runs show absent worker and network figures as missing, without zero values or charts", () => {
  const historical = run();
  historical.publish = null;
  historical.measurements = [reportMeasurement("inbox", "laptop", "cold", { "js.loaded.gzip": [100] })];
  const html = renderReport([historical], historical);
  for (const metric of [
    "worker.loaded.gzip", "worker.transferred.gzip", "worker.loaded.raw", "worker.transferred.raw",
    "network.gzip", "network.raw", "network.files",
  ]) {
    const rows = [...html.matchAll(new RegExp(`<tr data-metric="${metric.replaceAll(".", "\\.")}">([\\s\\S]*?)</tr>`, "g"))];
    assert.equal(rows.length, 5, metric);
    for (const [, row] of rows) {
      assert.equal((row.match(/<td class="missing">—<small>No measurement<\/small><\/td>/g) ?? []).length, 4, metric);
      assert(!row.includes("<strong>0</strong>") && !row.includes("Δ"), metric);
    }
  }
  assert.equal((html.match(/<svg /g) ?? []).length, 1, "only the historical JS figure has a chart");
});

test("report preserves all skipped steps and escaped reasons even when many share a prefix", () => {
  const current = run(), previous = run();
  previous.commit = { ...previous.commit, sha: "b".repeat(40), date: "2026-10-25T12:00:00Z" };
  previous.skipped = [{ step: "seed/large", reason: "Previous seed failure" }];
  current.skipped = Array.from({ length: 300 }, (_, index) => ({
    step: `seed/review-${String(index).padStart(3, "0")}`,
    reason: index === 0 ? "First <missing route> & unsupported" : "Repeated seed failure",
  }));
  current.skipped.push({ step: "laptop/inbox/cold/1", reason: "First readiness failure" },
    { step: "laptop/inbox/cold/2", reason: "Repeated readiness failure" });
  const html = renderReport([current, previous], current);
  const skipped = html.match(/<section id="skipped">([\s\S]*?)<\/section>/)?.[1];
  assert(skipped);
  assert.equal((skipped.match(/<li>/g) ?? []).length, 303, "every step from both runs is retained");
  assert(skipped.includes("seed/review-299") && skipped.includes("seed/large"));
  assert(skipped.includes("laptop/inbox/cold/1") && skipped.includes("laptop/inbox/cold/2"));
  assert(skipped.includes("First &lt;missing route&gt; &amp; unsupported"));
  assert(skipped.includes("Previous seed failure"));
  assert(skipped.includes("Repeated seed failure") && skipped.includes("review-001"));
  assert(skipped.includes("First readiness failure") && skipped.includes("Repeated readiness failure"));
  assert(html.includes("302 skipped"), "the run list retains the total skip count");
});
