// pnpm perf: sealed browser measurements; timings are observations, never a gate.
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { cpus, homedir, loadavg, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createSealedLifecycle } from "./screenshots/sealed.ts";
import { canonicalPath, currentProtectedStateDirs } from "./screenshots/safety.ts";
import {
  assertOutputFolder, assertPrivateAncestors, assertRefFolder, assertWorkspaceRoot,
  cacheHome, refParent, removeStaleRefExports, writeRefMarker,
} from "./perf/guards.ts";
import { LAPTOP, measureJourneys } from "./perf/journeys.ts";
import { distribution, REPETITIONS } from "./perf/metrics.ts";
import { type PerfRun, writeReport } from "./perf/report.ts";
import { FIXED_DATE, IDENTITY, publishedId, publishPub, SEED, seed } from "./perf/seed.ts";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const USAGE =
  "Usage: node scripts/perf.ts [--ref <REF>] [--out <dir>] [--chromium <path>] [--keep] [--no-build]";
export function parseArgs(argv: string[], root = checkout) {
  const options = {
    keep: false,
    noBuild: false,
    out: join(root, ".wt/perf"),
    ref: undefined as string | undefined,
    chromium: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--keep") options.keep = true;
    else if (flag === "--no-build") options.noBuild = true;
    else if (["--ref", "--out", "--chromium"].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      const value = argv[++i];
      if (flag === "--ref") options.ref = value;
      else if (flag === "--out") options.out = resolve(value);
      else options.chromium = resolve(value);
    } else throw new Error(USAGE);
  }
  return options;
}
// Only executable lookup reads the parent's PATH; build children use the harness's Node first.
export function pnpmExecutable(): string {
  for (const path of (process.env.PATH ?? "").split(":")) {
    if (!path.startsWith("/")) continue;
    const candidate = join(path, "pnpm");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  throw new Error("pnpm not found");
}
/** Only install/build may reuse the parent's Corepack cache; every other child stays sealed. */
export function buildEnvironment(
  sealed: Readonly<Record<string, string>>,
  pnpm: string,
  parent: Record<string, string | undefined> = process.env,
  node = process.execPath,
  parentHome = homedir(),
): Record<string, string> {
  return {
    ...sealed,
    PATH: `${dirname(node)}${delimiter}${dirname(pnpm)}${delimiter}${sealed.PATH}`,
    COREPACK_HOME: parent.COREPACK_HOME || join(cacheHome(parent, parentHome), "node", "corepack"),
    COREPACK_ENABLE_NETWORK: "0",
    pnpm_config_pm_on_fail: "ignore",
    pnpm_config_verify_deps_before_run: "false",
    pnpm_config_offline: "true",
  };
}

export function resolveCommit(ref: string | undefined, git: (...args: string[]) => string): string {
  const sha = git("rev-parse", "--verify", "--end-of-options", `${ref ?? "HEAD"}^{commit}`);
  if (ref) {
    const onMain = ["refs/heads/main", "refs/remotes/origin/main"].some((base) => {
      try {
        git("show-ref", "--verify", "--quiet", base);
        git("merge-base", "--is-ancestor", sha, base);
        return true;
      } catch {
        return false;
      }
    });
    if (!onMain) throw new Error("--ref must name a commit on main");
  }
  return sha;
}

export function localPnpmStore(modules: string): string {
  let store: unknown;
  try {
    const parsed: unknown = JSON.parse(modules);
    if (parsed && typeof parsed === "object" && "storeDir" in parsed) store = parsed.storeDir;
  } catch {
    // Earlier pnpm releases used YAML for this file.
  }
  if (typeof store === "string" && isAbsolute(store)) return store;
  store = /^storeDir:[\t ]*(.+)$/m.exec(modules)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  if (typeof store === "string" && isAbsolute(store)) return store;
  throw new Error("Could not find the local pnpm store");
}

interface FailurePaths {
  sealedRoot?: string;
  refFolder?: string;
  checkout?: string;
  homes?: string[];
}
export function redactFailure(error: unknown, paths: FailurePaths = {}, diagnostics = false): string {
  let text = error instanceof Error ? error.message : String(error);
  const replacements: [string, string][] = [
    [paths.sealedRoot ?? "", "<sealed>"],
    [paths.refFolder ?? "", "<ref>"],
    [paths.checkout ?? checkout, "<checkout>"],
    ...(paths.homes ?? [homedir(), userInfo().homedir]).map((home): [string, string] => [home, "~"]),
  ];
  for (const [path, replacement] of replacements.sort(([a], [b]) => b.length - a.length))
    if (path) text = text.replaceAll(path, replacement);
  text = text.replace(/emp_[A-Za-z0-9_-]*/g, "<redacted>").replace(/\r\n?/g, "\n");
  return diagnostics ? text.split("\n").slice(-20).join("\n") : text.split("\n")[0].slice(0, 240);
}

export function runExitCode(
  ref: string | undefined,
  skipped: readonly { step: string; reason: string }[],
  sealFailure: boolean,
  fatalFailure: boolean,
): 0 | 1 {
  return sealFailure || fatalFailure || (!ref && skipped.length > 0) ? 1 : 0;
}

/** Print bounded diagnostics before the caller records its one-line skip reason. */
export function checkBuildResult(
  result: { code: number | null; stdout: string; stderr: string },
  reason: string,
  paths: FailurePaths,
  write: (text: string) => void = console.error,
): void {
  if (result.code === 0) return;
  // The shared runner captures the streams separately: combine stdout, then stderr.
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .map((stream) => stream.replace(/\r\n?/g, "\n").replace(/\n$/, ""))
    .join("\n");
  if (output) write(redactFailure(output, paths, true));
  throw new Error(redactFailure(reason, paths));
}

// A frozen install compares the lockfile's pnpmfileChecksum with the loaded pnpmfile.
// The ref is a main ancestor whose build scripts run anyway.
export const OFFLINE_INSTALL = [
  "install",
  "--frozen-lockfile",
  "--frozen-store",
  "--offline",
  "--ignore-scripts",
  "--package-import-method=copy",
];

export async function exportMainCommit({ sealed, env, sealedRoot, sha, keep, protectedDirs, failurePaths, git }: {
  sealed: ReturnType<typeof createSealedLifecycle>;
  env: Record<string, string>;
  sealedRoot: string;
  sha: string;
  keep: boolean;
  protectedDirs: string[];
  failurePaths: FailurePaths;
  git: (cwd: string, ...args: string[]) => string;
}): Promise<string> {
  // Ref exports use the private cache so Node cannot load modules from shared temporary parents.
  const parent = refParent();
  if (!process.getuid) throw new Error("--ref needs a POSIX system");
  const uid = process.getuid();
  // Guard the folders before creation as well as after canonicalisation.
  assertRefFolder(join(parent, "ref-candidate"), checkout, parent, protectedDirs, canonicalPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = canonicalPath(parent);
  assertPrivateAncestors(canonicalParent, uid);
  assertRefFolder(join(canonicalParent, "ref-candidate"), checkout, canonicalParent, protectedDirs, canonicalPath);
  removeStaleRefExports(canonicalParent, { uid });
  let source = mkdtempSync(join(canonicalParent, "ref-"));
  sealed.addRoot(source);
  writeRefMarker(source, keep);
  failurePaths.refFolder = source;
  source = canonicalPath(source);
  assertPrivateAncestors(source, uid);
  assertRefFolder(source, checkout, canonicalParent, protectedDirs, canonicalPath);
  const archive = join(sealedRoot, "ref.tar");
  git(checkout, "archive", "--format=tar", "--output", archive, sha);
  const extracted = await sealed.run("tar", ["-xf", archive, "-C", source], {
    cwd: sealedRoot,
    env,
    group: true,
  });
  if (extracted.code !== 0) throw new Error(`Ref export exited with code ${extracted.code}`);
  assertWorkspaceRoot(source);
  // Reuse only the package store path, never the parent's pnpm config or credentials.
  const modules = join(checkout, "node_modules/.modules.yaml");
  const store = localPnpmStore(existsSync(modules) ? readFileSync(modules, "utf8") : "");
  const pnpm = pnpmExecutable();
  const install = await sealed.run(
    pnpm,
    [...OFFLINE_INSTALL, "--store-dir", store],
    {
      cwd: source,
      env: buildEnvironment(env, pnpm),
      group: true,
      timeoutMs: 600_000,
    },
  );
  checkBuildResult(
    install,
    `Offline ref install exited with code ${install.code}; dependencies may be absent from the local store`,
    failurePaths,
  );
  return source;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sealed = createSealedLifecycle("perf");
  sealed.setKeep(options.keep);
  let run: PerfRun | undefined;
  let failure: Error | undefined;
  let sealFailure = false;
  let checkSeal = () => {};
  let sealStatus: () => NonNullable<PerfRun["seal"]> = () => ({
    vanishedRequests: 0, vanishedTargets: 0,
    vanishedRequestsByKind: { gone: 0, "invalid-interception": 0 }, vanishedRequestEvents: [],
  });
  const failurePaths: FailurePaths = {};
  try {
    const protectedDirs = currentProtectedStateDirs();
    assertOutputFolder(options.out, protectedDirs, canonicalPath, "perf output");
    const { sealedRoot, env } = sealed.createRoot(options.out, IDENTITY);
    failurePaths.sealedRoot = sealedRoot;
    const git = (cwd: string, ...args: string[]) =>
      sealed.git(cwd, { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE }, ...args);
    const sha = resolveCommit(options.ref, (...args) => git(checkout, ...args));
    const [subject, date] = git(checkout, "show", "-s", "--format=%s%n%cI", sha).split("\n");
    run = {
      schemaVersion: 1,
      // Exclude untracked files: the sealed git config omits the user's global excludes.
      commit: { sha, subject, date, dirty: options.ref ? false : !!git(checkout, "status", "--porcelain", "--untracked-files=no") },
      date: new Date().toISOString(),
      ...(options.ref ? { ref: options.ref } : {}),
      node: process.version,
      chromium: null,
      seal: sealStatus(),
      cpus: cpus().length,
      loadStart: loadavg(),
      loadEnd: [],
      seed: SEED,
      seededReviews: 0,
      repetitions: REPETITIONS,
      measurements: [],
      publish: null,
      skipped: [],
    };
    const skip = (step: string, error: unknown) => {
      checkSeal();
      run?.skipped.push({ step, reason: redactFailure(error, failurePaths) });
    };
    let source = checkout;
    try {
      if (options.ref) {
        source = await exportMainCommit({
          sealed, env, sealedRoot, sha, keep: options.keep, protectedDirs, failurePaths, git,
        });
      }
      if (options.ref || !options.noBuild) {
        console.log("- building the measured checkout");
        const pnpm = pnpmExecutable();
        const build = await sealed.run(pnpm, ["build"], {
          cwd: source,
          env: buildEnvironment(env, pnpm),
          group: true,
          timeoutMs: 600_000,
        });
        checkBuildResult(build, `Build exited with code ${build.code}`, failurePaths);
      }
    } catch (error) {
      skip("run/build", error);
      throw error;
    }
    const entry = join(source, "apps/emend/dist/emend.mjs");
    if (!existsSync(entry)) throw new Error("The CLI is not built; run pnpm build first");
    const server = await sealed.startServer(entry, sealedRoot, env, "00000000-0000-4000-8000-000000000175", true);
    const { browser, desktop } = await sealed.signIn(entry, sealedRoot, env, server, options.chromium, LAPTOP, true);
    checkSeal = () => {
      try {
        browser.check();
      } catch (error) {
        sealFailure = true;
        throw error;
      }
    };
    sealStatus = () => ({
      vanishedRequests: browser.vanishedRequests, vanishedTargets: browser.vanishedTargets,
      vanishedRequestsByKind: browser.vanishedRequestsByKind, vanishedRequestEvents: browser.vanishedRequestEvents,
    });
    run.chromium = String((await browser.send("Browser.getVersion")).product);
    console.log("- seeding synthetic reviews and documents");
    const seeded = await seed({ root: sealedRoot, cli: server.cli, git, page: desktop, skip });
    run.seededReviews = new Set(seeded.reviewIds).size;
    if (new Set(seeded.reviewIds).size !== SEED.inboxReviews)
      skip("seed/count", new Error(`Created ${new Set(seeded.reviewIds).size} of ${SEED.inboxReviews} inbox items`));
    // Keep sign-in cookies in the default context, but stop its inbox polling during measurements.
    await desktop.send("Page.navigate", { url: "about:blank" });
    run.measurements = await measureJourneys(browser, seeded, join(source, "apps/emend/dist/web"), skip);
    console.log("- timing publication after browser journeys");
    const publishTimes: number[] = [];
    for (let repeat = 0; repeat < REPETITIONS; repeat++) {
      try {
        const start = performance.now();
        const output = await publishPub(server.cli, seeded.pubFolder, true);
        const elapsed = performance.now() - start;
        publishedId(output);
        publishTimes.push(elapsed);
      } catch (error) {
        skip(`cli/publish/${repeat + 1}`, error);
      }
    }
    if (publishTimes.length) run.publish = { samples: publishTimes, stats: distribution(publishTimes) };
    checkSeal();
    await browser.close();
  } catch (error) {
    failure = new Error(redactFailure(error, failurePaths));
    if (run && !run.skipped.some((skip) => skip.step === "run/build"))
      run.skipped.push({
        step: "run",
        reason: failure.message,
      });
  } finally {
    try {
      if (run) {
        run.seal = sealStatus();
        run.loadEnd = loadavg();
        const states = currentProtectedStateDirs();
        assertOutputFolder(options.out, states, canonicalPath, "perf output");
        mkdirSync(options.out, { recursive: true });
        assertOutputFolder(options.out, states, canonicalPath, "perf output");
        console.log(`Wrote performance run: ${writeReport(options.out, run)}`);
      }
    } catch (error) {
      failure = new Error(redactFailure(error, failurePaths));
    }
    // Current-checkout runs exit 1 when any step failed, after writing the JSON and report.
    // --ref step incompatibilities stay skipped and exit 0; failures before the journeys
    // (build, install, server, sign-in) and fatal failures exit 1. A broken seal always exits 1.
    if (runExitCode(options.ref, run?.skipped ?? [], sealFailure, !!failure)) {
      if (!options.ref && run?.skipped.length) console.error(`perf: ${run.skipped.length} steps failed`);
      failure ??= new Error(sealFailure ? "The browser seal failed" : "Required performance steps failed");
    }
    sealed.finish(failure);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error: Error) => {
    console.error(`perf: ${redactFailure(error)}`);
    process.exitCode = 1;
  });
}
