import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import {
  addFinding,
  approveFindings,
  claimFindings,
  type FindingInput,
  findingsDir,
  listFindings,
  releaseFindings,
  showFinding,
} from "./findings.ts";
import {
  agentName,
  closeWorkspace,
  fixerAgentName,
  HerdrError,
  herdrCall,
  herdrLocatedAgents,
  notify,
  parseAgents,
  spawn,
  spawnPrompt,
  waitForShell,
} from "./herdr.ts";
import { issueSnapshot, pickIssue } from "./issues.ts";
import { readRegistry } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  type FakeRule,
  type Fixture,
  fakeCalls,
  fakeClock,
  fakeGithubOrigin,
  githubPage,
  gitIn,
  installFake,
  issueEdits,
  issueEvent,
  issueRules,
  makeFixture,
  makeTestEnv,
  readyIssue,
  runWt,
  setFakeRules,
  type TestEnv,
} from "./test-support.ts";
import { WtError } from "./validate.ts";
import { cleanup, safetyGuard, setBeforeWorktreeAddHookForTests, setup, terminal } from "./worktree.ts";

async function scenario(
  o: { withBin?: boolean },
  fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>,
): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env, o);
    fakeGithubOrigin(env, fx);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

async function toolScenario(fn: (env: TestEnv) => Promise<void>): Promise<void> {
  const env = makeTestEnv({ ports: false });
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

/** Runs `fn` with HERDR_ENV=1 in this process, then restores it. */
async function inHerdr<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = saved;
  }
}

function captureStdout(fn: () => void): string {
  const write = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write;
  }
  return out;
}

const BRANCH = "recense-42-fix-review-pane";
const AGENT = "wt-recense-42-fix-review-pane";

/** The gh fake for one ready issue 42, the issue every spawn test below uses. */
function readyIssueGh(env: TestEnv): void {
  installFake(env, "gh", issueRules([readyIssue(42)]));
}

const json = (result: Record<string, unknown>) => JSON.stringify({ result });
const failWith = (code: string, message = "refused") => JSON.stringify({ error: { code, message } });

function herdrRules(agent: string, extra: FakeRule[] = []): FakeRule[] {
  return [
    ...extra,
    { match: ["agent", "list"], stdout: json({ type: "agent_list", agents: [] }) },
    {
      match: ["worktree", "open"],
      stdout: json({
        type: "worktree_opened",
        already_open: false,
        workspace: { workspace_id: "w9", label: "task-ws" },
        root_pane: { pane_id: "w9:p1" },
      }),
    },
    {
      match: ["pane", "process-info"],
      stdout: json({ process_info: { pane_id: "w9:p1", shell_pid: 10, foreground_processes: [{ pid: 10 }] } }),
    },
    {
      match: ["agent", "start"],
      stdout: json({
        type: "agent_started",
        agent: { pane_id: "w9:p1", name: agent, agent_status: "idle", interactive_ready: true },
      }),
    },
    {
      match: ["agent", "prompt"],
      stdout: json({ type: "agent_prompted", agent: { pane_id: "w9:p1", name: agent, agent_status: "working" } }),
    },
  ];
}

const SPAWN_ARGS = ["spawn", "--issue", "42"];

const FIXER_BRANCH = "recense-fix-20260103-readme-md";
const FIXER_AGENT = "wt-fix-20260103-readme-md";
const fixerClock = () => ({ ...fakeClock(), date: () => new Date("2026-01-02T19:15:00-05:00") });

function recordFinding(repo: Repo, overrides: Partial<FindingInput> = {}): string {
  return addFinding(repo, {
    title: "Keep the selection",
    detail: "The selection is lost when the view changes.",
    path: "README.md",
    line: 1,
    kind: "bug",
    severity: "medium",
    size: "small",
    source: { kind: "groom", pass: "first" },
    ...overrides,
  }).id;
}

test("bin/findings spawn claims, snapshots and prompts", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      const first = recordFinding(repo, { rule: "selection" });
      const second = recordFinding(repo, { kind: "docs" });
      const ids = [second, first];
      approveFindings(repo, ids, "P0");
      const expected = ids.map((id) => {
        const { title, detail, path, line, kind, rule, severity, size, commit, createdAt } = showFinding(repo, id);
        return { id, title, detail, path, line, kind, rule, severity, size, commit, createdAt };
      });
      installFake(env, "herdr", herdrRules(FIXER_AGENT));
      const r = await spawn(repo, { findings: [...ids, second], slug: "readme-md", mode: "github" }, fixerClock());
      assert.equal(r.branch, FIXER_BRANCH);
      assert.equal(r.agent, FIXER_AGENT);
      assert.deepEqual(r.findings, ids);
      assert.equal(r.issue, undefined);
      const wt = join(r.path, ".wt");
      assert.deepEqual(JSON.parse(readFileSync(join(wt, "worktree.json"), "utf8")), {
        branch: FIXER_BRANCH,
        port: r.port,
        recenseHome: r.recenseHome,
        mode: "github",
        findings: ids,
      });
      assert.deepEqual(readRegistry(repo).worktrees[FIXER_BRANCH]?.findings, ids);
      assert.equal(
        readFileSync(join(wt, "bundle.json"), "utf8"),
        `${JSON.stringify({ version: 1, findings: expected }, null, 2)}\n`,
      );
      assert.equal(statSync(join(wt, "bundle.json")).mode & 0o777, 0o600);
      assert.equal(readFileSync(join(wt, "brief.md"), "utf8"), ".wt/bundle.json\n");
      for (const id of ids) {
        const finding = showFinding(repo, id);
        assert.equal(finding.state, "claimed");
        assert.equal(finding.claim?.branch, FIXER_BRANCH);
        assert.equal(finding.claim?.worktree, r.path);
      }
      const prompts = fakeCalls(env, "herdr").filter((call) => call[1] === "prompt");
      assert.equal(prompts.length, 1);
      assert.equal(
        prompts[0]?.[3],
        "/loop /e-work .wt/bundle.json Closing answer from /e-spawn: Open a ready PR and finalize it.",
      );
    }),
  ));

test("bin/findings spawn labels the hc terminal and prints the selected ids", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    const ids = [recordFinding(repo), recordFinding(repo, { kind: "docs" })];
    approveFindings(repo, ids, "P2");
    installFake(env, "claude", []);
    installFake(env, "hc", [
      { match: ["ls", "--json"], stdout: JSON.stringify({ terminals: [] }) },
      { match: ["run"], stdout: JSON.stringify({ address: "t2", state: "live" }) },
      { match: ["get", "t2"], stdout: JSON.stringify({ address: "t2", status: { state: "working" } }) },
    ]);
    const args = ["spawn", ids.join(","), "--slug", "readme-md", "--model", "opus", "--effort", "high"];
    const r = await runWt(join(fx.main, "bin/findings"), args, {
      cwd: fx.main,
      env: { HC_TERMINAL_ID: "t1" },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], `Findings: ${ids.join(", ")}`);
    assert.doesNotMatch(r.stdout, /^Issue:/m);
    const launch = fakeCalls(env, "hc").find((call) => call[0] === "run");
    assert.ok(launch);
    assert.ok(launch.includes(`recense.findings=${ids.join(",")}`));
    assert.ok(!launch.some((arg) => arg.startsWith("recense.issue=")));
    assert.deepEqual(launch.slice(-5, -1), ["--model", "opus", "--effort", "high"]);
    assert.equal(launch.at(-1), spawnPrompt(".wt/bundle.json", "github"));
  }));

test("bin/findings spawn refuses an unapproved finding before creating anything", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    const approved = recordFinding(repo);
    approveFindings(repo, [approved], "P1");
    const untriaged = recordFinding(repo, { rule: "untriaged" });
    const before = listFindings(repo);
    installFake(env, "herdr", herdrRules(FIXER_AGENT));
    const result = await runWt(
      join(fx.main, "bin/findings"),
      ["spawn", `${approved},${untriaged}`, "--slug", "readme"],
      {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      },
    );
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes(`Finding ${untriaged} is not approved for fixing. Run /e-triage first.`));
    assert.deepEqual(listFindings(repo), before);
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.equal(gitIn(fx.main, "branch", "--list", "recense-*"), "");
    assert.deepEqual(fakeCalls(env, "herdr"), []);
  }));

test("bin/findings spawn refuses invalid requests before setup", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    const open = recordFinding(repo);
    const security = recordFinding(repo, { kind: "security" });
    const large = recordFinding(repo, { size: "large", rule: "large" });
    approveFindings(repo, [open], "P1");
    const before = listFindings(repo);
    installFake(env, "herdr", herdrRules("unused"));
    const flags = [open, "--slug", "readme-md"];
    for (const args of [
      [...flags, "--issue", "42"],
      [...flags, "--mode", "local"],
      ["--slug", "readme"],
      [open],
      [open, open, "--slug", "readme"],
      ...["", `${open},`, `,${open}`, "bad", `${open},f-000000000000`, `${open},${security}`, `${open},${large}`].map(
        (ids) => [ids, "--slug", "readme"],
      ),
      ...["", "UPPER", "double--dash", "a".repeat(64)].map((slug) => [open, "--slug", slug]),
    ]) {
      const r = await runWt(join(fx.main, "bin/findings"), ["spawn", ...args], {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /Nothing was created\./);
    }
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.equal(gitIn(fx.main, "branch", "--list", "recense-*"), "");
    assert.deepEqual(listFindings(repo), before);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
  }));

test("bin/findings spawn refuses a non-GitHub origin before setup or claims", () =>
  scenario({}, ({ env, fx, repo }) =>
    inHerdr(async () => {
      const id = recordFinding(repo);
      approveFindings(repo, [id], "P1");
      const before = showFinding(repo, id);
      gitIn(fx.main, "remote", "set-url", "origin", fx.main);
      installFake(env, "herdr", herdrRules(FIXER_AGENT));
      await assert.rejects(spawn(repo, { findings: [id], slug: "readme-md", mode: "github" }, fixerClock()), {
        code: 2,
        message: /origin must identify a github\.com repository.*Nothing was created\./,
      });
      assert.deepEqual(showFinding(repo, id), before);
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.equal(existsSync(repo.worktreesDir), false);
      assert.equal(gitIn(fx.main, "branch", "--list", FIXER_BRANCH), "");
      assert.deepEqual(fakeCalls(env, "herdr"), []);
    }),
  ));

test("bin/findings spawn refuses a taken finding or branch", () =>
  scenario({}, ({ env, fx, repo }) =>
    inHerdr(async () => {
      const id = recordFinding(repo);
      approveFindings(repo, [id], "P1");
      const start = () => spawn(repo, { findings: [id], slug: "readme-md", mode: "github" }, fixerClock());
      installFake(env, "herdr", herdrRules(FIXER_AGENT));
      const pending = start();
      // The first read saw an open finding. Claim it while spawn is waiting for its port probes.
      claimFindings(repo, [id], { branch: "other-worker", worktree: fx.main });
      const before = showFinding(repo, id);
      const taken = (e: unknown) =>
        e instanceof WtError && e.code === 3 && /already claimed or resolved.*Nothing was created/.test(e.message);
      await assert.rejects(pending, taken);
      await assert.rejects(start, taken);
      assert.deepEqual(showFinding(repo, id), before);
      assert.equal(gitIn(fx.main, "branch", "--list", FIXER_BRANCH), "");
      releaseFindings(repo, [id]);
      gitIn(fx.main, "branch", FIXER_BRANCH);
      await assert.rejects(
        start,
        (e) => e instanceof WtError && e.code === 3 && /branch already exists.*Nothing was created/.test(e.message),
      );
      assert.equal(showFinding(repo, id).state, "open");
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.equal(existsSync(repo.worktreesDir), false);
      assert.ok(!fakeCalls(env, "herdr").some((call) => call[0] === "worktree"));
    }),
  ));

test("fixer setup refuses a live origin branch and accepts a stale tracking ref", () =>
  scenario({}, ({ fx, repo }) => {
    const id = recordFinding(repo);
    approveFindings(repo, [id], "P1");
    const finding = showFinding(repo, id);
    const start = () => setup(repo, { branch: FIXER_BRANCH, findings: [finding] });
    const remoteHead = `refs/heads/${FIXER_BRANCH}`;
    gitIn(fx.origin, "update-ref", remoteHead, "refs/heads/main");
    assert.throws(start, { code: 3, message: "The branch already exists. Nothing was created." });
    assert.deepEqual(readRegistry(repo).worktrees, {});

    gitIn(fx.origin, "update-ref", "-d", remoteHead);
    gitIn(fx.main, "update-ref", `refs/remotes/origin/${FIXER_BRANCH}`, "HEAD");
    const wt = start();
    assert.equal(gitIn(wt.path, "symbolic-ref", "--short", "HEAD"), FIXER_BRANCH);
    assert.deepEqual(readRegistry(repo).worktrees[FIXER_BRANCH]?.findings, [finding.id]);
  }));

test("bin/findings spawn reports a refused claim without a release command", () =>
  scenario({}, ({ env, fx, repo }) =>
    inHerdr(async () => {
      const id = recordFinding(repo);
      const ids = [id, recordFinding(repo, { kind: "docs" })];
      approveFindings(repo, ids, "P1");
      installFake(env, "herdr", herdrRules(FIXER_AGENT));
      setBeforeWorktreeAddHookForTests(() => claimFindings(repo, [id], { branch: "other-worker", worktree: fx.main }));
      try {
        await assert.rejects(spawn(repo, { findings: ids, slug: "readme-md", mode: "github" }, fixerClock()), (e) => {
          assert.ok(e instanceof WtError);
          const findings = join(repo.mainRoot, "bin/findings");
          assert.match(e.message, /findings were not claimed by this run/);
          for (const id of ids) assert.ok(e.message.includes(`Check each with: ${findings} show ${id}`));
          assert.match(e.message, /Optional teardown:/);
          assert.doesNotMatch(e.message, /findings release|stay claimed|failed write/);
          return true;
        });
      } finally {
        setBeforeWorktreeAddHookForTests(null);
      }
      assert.equal(showFinding(repo, id).claim?.branch, "other-worker");
      assert.ok(readRegistry(repo).worktrees[FIXER_BRANCH]);
      assert.equal(existsSync(join(repo.worktreesDir, FIXER_BRANCH, ".wt/brief.md")), false);
      assert.deepEqual(fakeCalls(env, "herdr"), [["agent", "list"]]);
    }),
  ));

test("bin/findings spawn scopes the release command to its worktree after an uncertain claim failure", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      const id = recordFinding(repo);
      approveFindings(repo, [id], "P1");
      installFake(env, "herdr", herdrRules(FIXER_AGENT));
      setBeforeWorktreeAddHookForTests(() => rmSync(join(findingsDir(repo), `${id}.json`)));
      try {
        await assert.rejects(spawn(repo, { findings: [id], slug: "readme-md", mode: "github" }, fixerClock()), (e) => {
          assert.ok(e instanceof WtError);
          assert.match(e.message, /Unknown finding\./);
          const findings = join(repo.mainRoot, "bin/findings");
          assert.ok(e.message.includes(`Check each with: ${findings} show ${id}`));
          const release = `cd ${join(repo.worktreesDir, FIXER_BRANCH)} && ${findings} release ${id}`;
          assert.ok(e.message.includes(`Release any claimed by ${FIXER_BRANCH} with: ${release}`));
          return true;
        });
      } finally {
        setBeforeWorktreeAddHookForTests(null);
      }
    }),
  ));

test("bin/findings spawn keeps claims after a workspace failure", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      const ids = [recordFinding(repo), recordFinding(repo, { kind: "docs" })];
      approveFindings(repo, ids, "P1");
      installFake(env, "herdr", herdrRules(FIXER_AGENT, [{ match: ["worktree", "open"], code: 1 }]));
      await assert.rejects(spawn(repo, { findings: ids, slug: "readme-md", mode: "github" }, fixerClock()), (e) => {
        assert.ok(e instanceof WtError);
        const path = join(repo.worktreesDir, FIXER_BRANCH);
        const release = `cd ${path} && ${repo.mainRoot}/bin/findings release ${ids.join(" ")}`;
        const notice = `Findings ${ids.join(", ")} stay claimed by ${FIXER_BRANCH}. Release them before any teardown with: ${release}`;
        const releaseIndex = e.message.indexOf(notice);
        assert.ok(releaseIndex >= 0 && releaseIndex < e.message.indexOf("Optional teardown:"));
        return true;
      });
      for (const id of ids) {
        const finding = showFinding(repo, id);
        assert.equal(finding.state, "claimed");
        assert.equal(finding.claim?.branch, FIXER_BRANCH);
      }
    }),
  ));

function processInfo(pids: number[], shell = 10): FakeRule {
  return {
    match: ["pane", "process-info", "--pane", "w9:p1"],
    stdout: json({
      process_info: {
        pane_id: "w9:p1",
        shell_pid: shell,
        foreground_process_group_id: 10,
        foreground_processes: pids.map((pid) => ({ pid, name: pid === shell ? "zsh" : "startup", argv: [], cwd: "/" })),
      },
    }),
  };
}

test("pane wait requires exactly the shell in the foreground, and sleeps only between polls", () =>
  toolScenario(async (env) => {
    const clock = fakeClock();
    installFake(env, "herdr", [
      { ...processInfo([20]), times: 1 },
      { ...processInfo([10, 20]), times: 1 },
      { ...processInfo([]), times: 1 },
      { ...processInfo([0], 0), times: 1 },
      { match: ["pane", "process-info"], stdout: json({ process_info: {} }), times: 1 },
      { match: ["pane", "process-info"], stdout: "not json", times: 1 },
      processInfo([10]),
    ]);
    await waitForShell("w9:p1", clock);
    assert.deepEqual(clock.sleeps, Array(6).fill(250));
    assert.equal(clock.now(), 1500);
    assert.deepEqual(fakeCalls(env, "herdr"), Array(7).fill(["pane", "process-info", "--pane", "w9:p1"]));
  }));

for (const [name, reply] of [
  ["busy", processInfo([20])],
  ["unavailable", { match: ["pane", "process-info"], code: 1, stderr: "Synthetic pane details" }],
] satisfies [string, FakeRule][]) {
  test(`pane wait prints one fixed timeout line and continues when ${name}`, () =>
    toolScenario(async (env) => {
      const clock = fakeClock();
      installFake(env, "herdr", [reply]);
      const lines: string[] = [];
      const stderr = mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
      try {
        await waitForShell("w9:p1", clock);
      } finally {
        stderr.mock.restore();
      }
      assert.equal(clock.now(), 30_000);
      assert.deepEqual(clock.sleeps, Array(120).fill(250));
      assert.equal(fakeCalls(env, "herdr").length, 120);
      assert.deepEqual(lines, ["Timed out waiting for the pane shell; continuing to agent start.\n"]);
    }));
}

test("spawn waits for the pane shell before agent start", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      const clock = fakeClock();
      readyIssueGh(env);
      installFake(env, "herdr", herdrRules(AGENT, [{ ...processInfo([20]), times: 2 }]));
      await spawn(repo, { issue: 42, mode: "github" }, clock);
      assert.deepEqual(clock.sleeps, [250, 250]);
      const steps = fakeCalls(env, "herdr").map((c) => c.slice(0, 2).join(" "));
      assert.deepEqual(steps, [
        "agent list",
        "worktree open",
        "pane process-info",
        "pane process-info",
        "pane process-info",
        "agent start",
        "agent prompt",
      ]);
    }),
  ));

test("spawn still tries agent start after the pane wait expires and preserves its failure report", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      const clock = fakeClock();
      readyIssueGh(env);
      installFake(
        env,
        "herdr",
        herdrRules(AGENT, [
          processInfo([20]),
          { match: ["agent", "start"], code: 1, stderr: failWith("agent_pane_busy") },
        ]),
      );
      await assert.rejects(spawn(repo, { issue: 42, mode: "github" }, clock), (e: unknown) => {
        assert.ok(e instanceof WtError);
        assert.equal(e.code, 1);
        assert.match(e.message, /agent_pane_busy/);
        assert.match(e.message, /no agent was started/);
        assert.match(e.message, /cleanup recense-42-fix-review-pane/);
        return true;
      });
      assert.equal(clock.now(), 30_000);
      const calls = fakeCalls(env, "herdr");
      assert.equal(calls.filter((c) => c[1] === "process-info").length, 120);
      assert.equal(calls.filter((c) => c[1] === "start").length, 1);
      assert.equal(calls.filter((c) => c[1] === "prompt").length, 0);
    }),
  ));

for (const mode of ["github"] as const) {
  test(`spawn --issue in ${mode} mode ignores oversized branch claims, writes only issue metadata and passes the issue prompt`, () =>
    scenario({ withBin: true }, async ({ env, fx, repo }) => {
      gitIn(fx.main, "branch", "recense-99999999999999999999-x");
      gitIn(fx.origin, "branch", "recense-99999999999999999998-x", "main");
      installFake(env, "gh", issueRules([readyIssue(42)]));
      const expected = issueSnapshot(pickIssue(repo, 42));
      installFake(env, "herdr", herdrRules("wt-recense-42-fix-review-pane"));
      const result = await runWt(
        join(fx.main, "bin/wt"),
        ["spawn", "--issue", "42", "--mode", mode, "--model", "opus", "--effort", "high"],
        { cwd: fx.main, env: { HERDR_ENV: "1" } },
      );
      assert.equal(result.code, 0, result.stderr);
      const url = "https://example.invalid/test/issues/42";
      assert.equal(result.stdout.split("\n")[0], `Issue: #42 ${url}`);
      assert.equal(result.stdout.split("\n")[1], "Branch: recense-42-fix-review-pane");
      assert.doesNotMatch(result.stdout, /Task:/);
      const path = join(repo.worktreesDir, "recense-42-fix-review-pane");
      const metadata = JSON.parse(readFileSync(join(path, ".wt/worktree.json"), "utf8"));
      assert.equal(metadata.issue, 42);
      assert.equal(Object.hasOwn(metadata, "task"), false);
      assert.equal(metadata.mode, mode);
      assert.equal(readFileSync(join(path, ".wt/brief.md"), "utf8"), `${url}\n`);
      assert.equal(
        readFileSync(join(path, ".wt/issue.md"), "utf8"),
        `# Fix review pane\n${url}\nThe issue body as its owner wrote it, in Markdown.\n\nApproved task.\n`,
      );
      const snapshot = JSON.parse(readFileSync(join(path, ".wt/issue.json"), "utf8"));
      assert.deepEqual({ ...snapshot, fetchedAt: expected.fetchedAt }, expected);
      assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
      for (const name of ["issue.md", "issue.json"])
        assert.equal(statSync(join(path, ".wt", name)).mode & 0o777, 0o600);
      assert.ok(fakeCalls(env, "gh").filter((c) => c.includes("number=42")).length >= 3);
      assert.ok(fakeCalls(env, "gh").every((c) => !c.some((a) => /comments/.test(a))));
      assert.equal(existsSync(join(path, "tasks")), false);
      assert.equal(readRegistry(repo).worktrees["recense-42-fix-review-pane"]?.issue, 42);
      const calls = fakeCalls(env, "herdr");
      assert.deepEqual(calls.find((c) => c[1] === "start")?.slice(-4), ["--model", "opus", "--effort", "high"]);
      assert.equal(calls.find((c) => c[1] === "prompt")?.[3], spawnPrompt("#42", mode));
      const listed = await runWt(join(fx.main, "bin/wt"), ["list"], { cwd: fx.main });
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /recense-42-fix-review-pane\s+#42\s/);
      const json = await runWt(join(fx.main, "bin/wt"), ["list", "--json"], { cwd: fx.main });
      assert.equal(JSON.parse(json.stdout)[0].issue, 42);
    }));
}

test("spawn --issue rejects other sources and invalid numbers before any external call", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    installFake(env, "gh", issueRules([readyIssue(42)]));
    installFake(env, "herdr", herdrRules("unused"));
    const args = [
      ["--issue", "42", "--brief", "text"],
      ["--issue", "42", "--brief-file", "/missing"],
      ["--issue", "42", "--slug", "add-thing"],
      ...["0", "042", "-1", "wat", "42;echo"].map((n) => [`--issue=${n}`]),
    ];
    for (const flags of args) {
      const r = await runWt(join(fx.main, "bin/wt"), ["spawn", ...flags], { cwd: fx.main, env: { HERDR_ENV: "1" } });
      assert.equal(r.code, 2, r.stderr);
    }
    assert.deepEqual(fakeCalls(env, "gh"), []);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
    assert.deepEqual(readRegistry(repo).worktrees, {});
  }));

test("spawn --issue preflight refuses blocked, untrusted, taken and not-ready work without creating anything", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    gitIn(fx.main, "branch", "recense-3-existing-other-title");
    installFake(
      env,
      "gh",
      issueRules([
        readyIssue(1, { blockedBy: { nodes: [{ number: 90, state: "OPEN" }], pageInfo: { hasNextPage: false } } }),
        readyIssue(2, { timelineItems: { nodes: [issueEvent("outsider")], pageInfo: { hasPreviousPage: false } } }),
        readyIssue(3),
      ]),
    );
    installFake(env, "herdr", herdrRules("unused"));
    for (const [n, code, reason] of [
      [1, 2, /blocked by #90/],
      [2, 2, /untrusted/],
      [3, 3, /taken/],
      [4, 2, /not open and ready/],
    ] as const) {
      const r = await runWt(join(fx.main, "bin/wt"), ["spawn", "--issue", String(n)], {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      });
      assert.equal(r.code, code, r.stderr);
      assert.match(r.stderr, reason);
      assert.match(r.stderr, /Nothing was created/);
    }
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.equal(gitIn(fx.main, "branch", "--format=%(refname:short)").split("\n").length, 2);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
  }));

test("issue spawn reports a stalled prompt once, and leaves the worktree", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      installFake(env, "gh", issueRules([readyIssue(42, { title: "你好" })]));
      installFake(
        env,
        "herdr",
        herdrRules("wt-recense-42-issue", [
          { match: ["agent", "prompt"], code: 1, stderr: failWith("agent_prompt_stalled") },
        ]),
      );
      await assert.rejects(spawn(repo, { issue: 42, mode: "github" }, fakeClock()), (e: unknown) => {
        assert.ok(e instanceof WtError);
        assert.equal(e.code, 124);
        assert.match(e.message, /Do not resend the prompt/);
        assert.match(e.message, /cleanup recense-42-issue/);
        return true;
      });
      assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "prompt").length, 1);
      assert.ok(readRegistry(repo).worktrees["recense-42-issue"]);
    }),
  ));

// ---------------------------------------------------------------------------------------------
// Pure helpers

test("agent name from a slashed branch", () => {
  assert.equal(agentName("fix/Inbox_x"), "wt-fix-inbox_x");
  assert.equal(agentName("014-add-thing"), "wt-014-add-thing");
  assert.equal(agentName("a".repeat(60)).length, 32);
  assert.equal(agentName("feat//x..y"), "wt-feat-x-y");
});

test("fixer agent names keep short slugs and distinguish long slugs on the same day", () => {
  const prefix = "wt-fix-20260103-";
  const name = (slug: string) => fixerAgentName(`recense-fix-20260103-${slug}`);
  assert.equal(name("packages-core"), `${prefix}packages-core`);
  assert.equal(name("abcdefghijklmnop"), `${prefix}abcdefghijklmnop`);
  const slugs = ["packages-contract", "packages-contracts", "abcdefghijklmnopq"];
  for (const slug of slugs) {
    const hash = createHash("sha256").update(`recense-fix-20260103-${slug}`).digest("hex").slice(0, 6);
    const shortened = slug.startsWith("packages-") ? "packages" : "abcdefghi";
    assert.equal(name(slug), `${prefix}${shortened}-${hash}`);
  }
  const names = ["packages-core", ...slugs].map(name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
});

test("the prompt names the issue and the closing answer", () => {
  assert.equal(
    spawnPrompt("#14", "github"),
    "/loop /e-work #14 Closing answer from /e-spawn: Open a ready PR and finalize it.",
  );
  assert.equal(
    spawnPrompt("#14", "local"),
    "/loop /e-work #14 Closing answer from /e-spawn: Land locally after a recense review.",
  );
});

test("parseAgents reads the herdr agent list", () => {
  const agents = parseAgents({
    result: { type: "agent_list", agents: [{ name: "a", pane_id: "w1:p1", agent_status: "Working", cwd: "/x" }] },
  });
  assert.deepEqual(agents, [{ name: "a", status: "working", cwd: "/x", paneId: "w1:p1", workspaceId: null }]);
  assert.equal(parseAgents({ result: { type: "other" } }), null);
});

// ---------------------------------------------------------------------------------------------
// herdrCall

test("herdrCall maps error codes to exit codes", () =>
  scenario({}, ({ env }) => {
    const call = (rules: FakeRule[]) => {
      installFake(env, "herdr", rules);
      return herdrCall(["agent", "list"], "agent_list");
    };
    const codeOf = (rules: FakeRule[]): number => {
      try {
        call(rules);
      } catch (e) {
        assert.ok(e instanceof WtError);
        return e.code;
      }
      return 0;
    };
    assert.equal(codeOf([{ stderr: failWith("timeout"), code: 1 }]), 124);
    assert.equal(codeOf([{ stderr: failWith("agent_prompt_stalled"), code: 1 }]), 124);
    for (const c of ["server_not_running", "server_unavailable", "server_binary_stale"]) {
      assert.equal(codeOf([{ stderr: failWith(c), code: 1 }]), 69, c);
    }
    assert.equal(codeOf([{ stderr: failWith("agent_name_taken"), code: 1 }]), 1);
    assert.equal(codeOf([{ stderr: "boom", code: 3 }]), 1);
    assert.equal(codeOf([{ stdout: "not json" }]), 1);
    assert.equal(codeOf([{ stdout: json({ type: "pane_list" }) }]), 1);
    assert.deepEqual(call([{ stdout: json({ type: "agent_list", agents: [] }) }]), { type: "agent_list", agents: [] });
    try {
      call([{ stderr: failWith("agent_blocked", "waits"), code: 1 }]);
      assert.fail("expected an error");
    } catch (e) {
      assert.ok(e instanceof HerdrError);
      assert.equal(e.herdrCode, "agent_blocked");
    }
  }));

test("herdrCall without herdr exits 69", () =>
  scenario({}, () => {
    assert.throws(
      () => herdrCall(["agent", "list"], null),
      (e: unknown) => e instanceof WtError && e.code === 69,
    );
  }));

// ---------------------------------------------------------------------------------------------
// spawn

test("issue spawn makes these herdr calls and writes the issue URL as the brief", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));

    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 0, r.stderr);

    const wtPath = join(fx.main, ".claude", "worktrees", "recense-42-fix-review-pane");
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines[0], "Issue: #42 https://example.invalid/test/issues/42");
    assert.equal(lines[1], "Branch: recense-42-fix-review-pane");
    assert.match(lines[2] as string, /^Port: 36\d\d$/);
    assert.equal(lines[3], `Worktree: ${wtPath}`);
    assert.equal(
      lines.at(-1),
      "Claude agent wt-recense-42-fix-review-pane is working on recense-42-fix-review-pane in herdr workspace task-ws (w9).",
    );

    const prompt = "/loop /e-work #42 Closing answer from /e-spawn: Open a ready PR and finalize it.";
    assert.deepEqual(fakeCalls(env, "herdr"), [
      ["agent", "list"],
      ["worktree", "open", "--cwd", fx.main, "--path", wtPath, "--no-focus"],
      ["pane", "process-info", "--pane", "w9:p1"],
      [
        "agent",
        "start",
        AGENT,
        "--kind",
        "claude",
        "--pane",
        "w9:p1",
        "--timeout",
        "120000",
        "--",
        "--permission-mode",
        "auto",
        "--name",
        "recense-42-fix-review-pane",
      ],
      ["agent", "prompt", AGENT, prompt, "--wait", "--until", "working", "--until", "blocked", "--timeout", "60000"],
    ]);

    assert.equal(readFileSync(join(wtPath, ".wt", "brief.md"), "utf8"), "https://example.invalid/test/issues/42\n");
    assert.equal(existsSync(join(wtPath, "tasks")), false);
    assert.equal(readRegistry(repo).worktrees[BRANCH]?.issue, 42);
  }));

test("herdr spawn ignores a failed hc listing during its name collision check", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      readyIssueGh(env);
      installFake(env, "herdr", herdrRules(AGENT));
      installFake(env, "hc", [{ code: 124 }]);
      const result = await spawn(repo, { issue: 42, mode: "github" }, fakeClock());
      assert.equal(result.state, "working");
      assert.deepEqual(fakeCalls(env, "hc"), [["ls", "--json"]]);
      assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "start").length, 1);
    }),
  ));

test("spawn passes model and effort to the agent only", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));
    const r = await runWt(join(fx.main, "bin", "wt"), [...SPAWN_ARGS, "--model", "opus", "--effort", "high"], {
      cwd: fx.main,
      env: { HERDR_ENV: "1" },
    });
    assert.equal(r.code, 0, r.stderr);
    const calls = fakeCalls(env, "herdr");
    assert.deepEqual(calls.find((c) => c[1] === "start")?.slice(-4), ["--model", "opus", "--effort", "high"]);
    assert.match(calls.find((c) => c[1] === "prompt")?.[3] as string, /Open a ready PR and finalize it\.$/);
  }));

test("spawn refuses a malformed model or effort without echoing it", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));
    for (const extra of [
      ["--model", "Bad Model!"],
      ["--effort", "extreme-secret"],
    ]) {
      const r = await runWt(join(fx.main, "bin", "wt"), [...SPAWN_ARGS, ...extra], {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      });
      assert.equal(r.code, 2);
      assert.equal(/Bad Model|extreme-secret/.test(r.stdout + r.stderr), false);
      assert.match(r.stderr, /Nothing was created\./);
      assert.deepEqual(readRegistry(repo).worktrees, {});
    }
  }));

test("spawn outside herdr creates nothing", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    readyIssueGh(env);
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main });
    assert.equal(r.code, 69);
    assert.match(r.stdout + r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(gitIn(fx.main, "branch", "--list", "recense-42-*"), "");
    assert.equal(existsSync(join(fx.main, ".claude", "worktrees")), false);
  }));

test("spawn outside herdr: herdr unreachable creates nothing", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    readyIssueGh(env);
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 69);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).worktrees, {});
  }));

test("spawn refuses to run from a linked worktree", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));
    const other = setup(repo, { branch: "other-work" });
    // the main checkout's copy, called by its absolute path from inside the linked worktree
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: other.path, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Run spawn from the main checkout\./);
    assert.match(r.stderr, /Nothing was created\./);
  }));

test("spawn: an existing agent name creates nothing", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", [
      {
        match: ["agent", "list"],
        stdout: json({ type: "agent_list", agents: [{ name: AGENT }] }),
      },
    ]);
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(fakeCalls(env, "herdr").length, 1);
  }));

test("spawn: an existing branch on origin creates nothing", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));
    gitIn(fx.main, "push", "--quiet", "origin", "main:refs/heads/recense-42-fix-review-pane");
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).worktrees, {});
  }));

test("spawn: prompt stalled is not resent", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(
      env,
      "herdr",
      herdrRules(AGENT, [
        { match: ["agent", "prompt"], stderr: failWith("agent_prompt_stalled", "no activity"), code: 1 },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 124);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "prompt").length, 1);
    assert.match(r.stderr, /Do not resend the prompt/);
    const wtPath = join(fx.main, ".claude", "worktrees", BRANCH);
    assert.ok(r.stderr.includes(wtPath));
    assert.ok(r.stderr.includes(`${fx.main}/bin/wt cleanup recense-42-fix-review-pane`));
    // nothing was cleaned up
    assert.ok(existsSync(wtPath));
    assert.ok(readRegistry(repo).worktrees[BRANCH]);
  }));

test("spawn: start refused reports the worktree", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(
      env,
      "herdr",
      herdrRules(AGENT, [{ match: ["agent", "start"], stderr: failWith("agent_name_taken", "taken"), code: 1 }]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 1);
    const wtPath = join(fx.main, ".claude", "worktrees", BRANCH);
    assert.ok(r.stderr.includes(wtPath));
    assert.match(r.stderr, /bin\/wt cleanup recense-42-fix-review-pane/);
    assert.match(r.stderr, /no agent was started/);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "prompt").length, 0);
    assert.ok(existsSync(wtPath));
    assert.ok(readRegistry(repo).worktrees[BRANCH]);
  }));

test("spawn: a blocked agent is reported as waiting", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    readyIssueGh(env);
    installFake(
      env,
      "herdr",
      herdrRules(AGENT, [
        {
          match: ["agent", "prompt"],
          stdout: json({ type: "agent_prompted", agent: { agent_status: "blocked" } }),
        },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout.trimEnd().split("\n").at(-1),
      "Claude agent wt-recense-42-fix-review-pane started and is waiting for an answer in herdr workspace task-ws (w9).",
    );
  }));

test("spawn: an already open workspace starts no agent", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    readyIssueGh(env);
    installFake(
      env,
      "herdr",
      herdrRules(AGENT, [
        {
          match: ["worktree", "open"],
          stdout: json({
            type: "worktree_opened",
            already_open: true,
            workspace: { workspace_id: "w3", label: "old" },
            root_pane: { pane_id: "w3:p1" },
          }),
        },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 3);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "start").length, 0);
    assert.match(r.stderr, /bin\/wt cleanup recense-42-fix-review-pane/);
  }));

test("spawn without --issue refuses and creates nothing", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));
    const wt = join(fx.main, "bin", "wt");
    const opts = { cwd: fx.main, env: { HERDR_ENV: "1" } };
    const file = join(fx.main, "brief.md");
    writeFileSync(file, "# Plain\n");
    for (const [args, message] of [
      [["spawn"], /becomes an issue first.*Nothing was created/],
      [["spawn", "--mode", "github"], /becomes an issue first.*Nothing was created/],
      // the removed task-spawn options are unknown flags now
      [["spawn", "--brief", "# Plain\n", "--slug", "add-thing"], /Unknown option/],
      [["spawn", "--brief-file", file, "--slug", "add-thing"], /Unknown option/],
    ] as const) {
      const r = await runWt(wt, [...args], opts);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.stderr, message);
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.equal(existsSync(join(fx.main, ".claude", "worktrees")), false);
    }
    assert.equal(gitIn(fx.main, "branch", "--list", "recense-*"), "");
    assert.deepEqual(fakeCalls(env, "herdr"), []);
    assert.deepEqual(fakeCalls(env, "gh"), []);
  }));

test("spawn in-process without an issue refuses and says a description becomes an issue first", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      installFake(env, "herdr", herdrRules(AGENT));
      await assert.rejects(
        spawn(repo, { mode: "github" } as unknown as Parameters<typeof spawn>[1], fakeClock()),
        (e: unknown) => e instanceof WtError && e.code === 2 && /becomes an issue first/.test(e.message),
      );
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.deepEqual(fakeCalls(env, "herdr"), []);
    }),
  ));

test("spawn --issue refuses --mode local before any external call", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    readyIssueGh(env);
    installFake(env, "herdr", herdrRules(AGENT));
    const r = await runWt(join(fx.main, "bin", "wt"), [...SPAWN_ARGS, "--mode", "local"], {
      cwd: fx.main,
      env: { HERDR_ENV: "1" },
    });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /github mode/);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.deepEqual(fakeCalls(env, "herdr"), []);
    assert.deepEqual(fakeCalls(env, "gh"), []);
  }));

// ---------------------------------------------------------------------------------------------
// notify

test("notify without herdr is silent", () =>
  scenario({ withBin: true }, async ({ fx }) => {
    const r = await runWt(join(fx.main, "bin", "wt"), ["notify", "question"], { cwd: fx.main });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    const inEnv = await runWt(join(fx.main, "bin", "wt"), ["notify", "blocked"], {
      cwd: fx.main,
      env: { HERDR_ENV: "1" },
    });
    assert.equal(inEnv.code, 0);
    assert.equal(inEnv.stdout + inEnv.stderr, "");
  }));

test("notify shows the branch title and body", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    installFake(env, "herdr", [{ match: ["notification", "show"], stdout: "{}" }]);
    const wt = join(fx.main, "bin", "wt");
    const opts = { cwd: fx.main, env: { HERDR_ENV: "1" } };
    for (const kind of ["question", "review-ready", "merged", "blocked"]) {
      const r = await runWt(wt, ["notify", kind], opts);
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(fakeCalls(env, "herdr"), [
      ["notification", "show", "main: your answer is needed", "--body", "A question waits in this session"],
      ["notification", "show", "main: review ready", "--body", "The recense review waits for you"],
      ["notification", "show", "main: merged", "--body", "The change is merged; this workspace closes"],
      ["notification", "show", "main: blocked", "--body", "This session stopped and needs you"],
    ]);
    const bad = await runWt(wt, ["notify", "secret-kind"], opts);
    assert.equal(bad.code, 2);
    assert.equal(bad.stderr.includes("secret-kind"), false);
  }));

test("notify survives a herdr failure", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      installFake(env, "herdr", [{ stderr: failWith("server_not_running"), code: 1 }]);
      notify(repo, "question");
      assert.equal(fakeCalls(env, "herdr").length, 1);
    }),
  ));

// ---------------------------------------------------------------------------------------------
// closeWorkspace

function workspaces(path: string) {
  return json({
    type: "workspace_list",
    workspaces: [
      { workspace_id: "w1", label: "main", worktree: { is_linked_worktree: false, checkout_path: path } },
      { workspace_id: "w2", label: "task", worktree: { is_linked_worktree: true, checkout_path: path } },
      { workspace_id: "w3", label: "other", worktree: { is_linked_worktree: true, checkout_path: `${path}-x` } },
    ],
  });
}

test("close picks exactly one workspace", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const path = join(repo.worktreesDir, "feat-a");
      installFake(env, "herdr", [
        { match: ["workspace", "list"], stdout: workspaces(path) },
        { match: ["notification", "show"], stdout: "{}" },
        { match: ["workspace", "close"], stdout: json({ type: "ok" }) },
      ]);
      const out = captureStdout(() => closeWorkspace(repo, path, "feat-a"));
      assert.match(out, /Closing herdr workspace task \(w2\)/);
      const calls = fakeCalls(env, "herdr");
      assert.deepEqual(calls[0], ["workspace", "list"]);
      assert.deepEqual(calls[1], [
        "notification",
        "show",
        "feat-a: merged",
        "--body",
        "The change is merged; this workspace closes",
      ]);
      assert.deepEqual(calls[2], ["workspace", "close", "w2"]);
      assert.equal(calls.length, 3);
    }),
  ));

test("close with no matching workspace closes nothing", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const path = join(repo.worktreesDir, "feat-a");
      installFake(env, "herdr", [
        { match: ["workspace", "list"], stdout: workspaces(join(repo.worktreesDir, "elsewhere")) },
      ]);
      const out = captureStdout(() => closeWorkspace(repo, path, "feat-a"));
      assert.match(out, /none was closed/);
      assert.deepEqual(fakeCalls(env, "herdr"), [["workspace", "list"]]);
    }),
  ));

test("close with several matching workspaces closes nothing", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const path = join(repo.worktreesDir, "feat-a");
      const entry = (id: string) => ({
        workspace_id: id,
        label: id,
        worktree: { is_linked_worktree: true, checkout_path: path },
      });
      installFake(env, "herdr", [
        {
          match: ["workspace", "list"],
          stdout: json({ type: "workspace_list", workspaces: [entry("w1"), entry("w2")] }),
        },
      ]);
      const out = captureStdout(() => closeWorkspace(repo, path));
      assert.match(out, /Several/);
      assert.deepEqual(fakeCalls(env, "herdr"), [["workspace", "list"]]);
    }),
  ));

test("cleanup --close-workspace closes last", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const r = setup(repo, { branch: "feat-a" });
      installFake(env, "herdr", [
        { match: ["agent", "list"], stdout: json({ type: "agent_list", agents: [] }) },
        { match: ["workspace", "list"], stdout: workspaces(r.path) },
        { match: ["notification", "show"], stdout: "{}" },
        { match: ["workspace", "close"], stdout: json({ type: "ok" }) },
      ]);
      captureStdout(() => cleanup(repo, { target: "feat-a", closeWorkspace: true, discard: false }));
      assert.equal(existsSync(r.path), false);
      assert.equal(readRegistry(repo).worktrees["feat-a"], undefined);
      const calls = fakeCalls(env, "herdr").filter((c) => c[0] !== "agent");
      assert.deepEqual(
        calls.map((c) => c.slice(0, 2).join(" ")),
        ["workspace list", "notification show", "workspace close"],
      );
      assert.deepEqual(calls[2], ["workspace", "close", "w2"]);
    }),
  ));

test("cleanup without --close-workspace never calls workspace commands", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      setup(repo, { branch: "feat-a" });
      installFake(env, "herdr", [
        { match: ["agent", "list"], stdout: json({ type: "agent_list", agents: [] }) },
        { match: ["workspace"], stdout: json({ type: "workspace_list", workspaces: [] }) },
      ]);
      captureStdout(() => cleanup(repo, { target: "feat-a", closeWorkspace: false, discard: false }));
      assert.equal(fakeCalls(env, "herdr").filter((c) => c[0] === "workspace").length, 0);
    }),
  ));

test("cleanup --discard --close-workspace closes the workspace without the merged notification", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const r = setup(repo, { branch: "feat-a" });
      installFake(env, "herdr", [
        { match: ["agent", "list"], stdout: json({ type: "agent_list", agents: [] }) },
        { match: ["workspace", "list"], stdout: workspaces(r.path) },
        { match: ["notification", "show"], stdout: "{}" },
        { match: ["workspace", "close"], stdout: json({ type: "ok" }) },
      ]);
      const realIsTTY = terminal.isTTY;
      const realRead = terminal.readLine;
      terminal.isTTY = () => true;
      terminal.readLine = () => "feat-a";
      try {
        captureStdout(() => cleanup(repo, { target: "feat-a", closeWorkspace: true, discard: true }));
      } finally {
        terminal.isTTY = realIsTTY;
        terminal.readLine = realRead;
      }
      assert.equal(existsSync(r.path), false);
      const calls = fakeCalls(env, "herdr").filter((c) => c[0] !== "agent");
      assert.deepEqual(
        calls.map((c) => c.slice(0, 2).join(" ")),
        ["workspace list", "workspace close"],
      );
    }),
  ));

// ---------------------------------------------------------------------------------------------
// Where an agent works

const agentsReply = (agents: Array<Record<string, unknown>>) => json({ type: "agent_list", agents });
const workspaceReply = (entries: Array<[string, string]>) =>
  json({
    type: "workspace_list",
    workspaces: entries.map(([id, path]) => ({
      workspace_id: id,
      label: id,
      worktree: { is_linked_worktree: true, checkout_path: path },
    })),
  });

test("an agent is located by its cwd, its workspace id or its pane's workspace", () =>
  scenario({}, ({ env }) => {
    installFake(env, "herdr", [
      {
        match: ["agent", "list"],
        stdout: agentsReply([
          { name: "a", pane_id: "w1:p1", agent_status: "working", cwd: "/work/a" },
          { name: "b", pane_id: "w2:p1", agent_status: "working", workspace_id: "w2" },
          { name: "c", pane_id: "w3:p4", agent_status: "working" },
          { name: "d", pane_id: "w9:p1", agent_status: "working" },
          { name: "e", agent_status: "working" },
        ]),
      },
      {
        match: ["workspace", "list"],
        stdout: workspaceReply([
          ["w2", "/work/b"],
          ["w3", "/work/c"],
        ]),
      },
    ]);
    const located = herdrLocatedAgents();
    assert.deepEqual(
      located?.map((a) => [a.name, a.location]),
      [
        ["a", "/work/a"],
        ["b", "/work/b"],
        ["c", "/work/c"],
        ["d", null],
        ["e", null],
      ],
    );
  }));

test("an agent without a determinable location fails the guard closed, naming the agent", () =>
  scenario({}, ({ env, repo }) => {
    const r = setup(repo, { branch: "loc-a" });
    const rules = (agents: Array<Record<string, unknown>>, ws: Array<[string, string]> = []): FakeRule[] => [
      { match: ["agent", "list"], stdout: agentsReply(agents) },
      { match: ["workspace", "list"], stdout: workspaceReply(ws) },
    ];
    // unknown location and active: refused, and the agent is named
    installFake(env, "herdr", rules([{ name: "mystery", pane_id: "w5:p1", agent_status: "working" }]));
    assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: false, failed: "agent-unknown", detail: "mystery" });
    assert.throws(
      () => cleanup(repo, { target: "loc-a", closeWorkspace: false, discard: false }),
      (e: unknown) => e instanceof WtError && /"agent-unknown" \(mystery\) failed/.test(e.message),
    );
    assert.equal(existsSync(r.path), true);
    // located through its workspace inside the worktree: agent-active
    setFakeRules(env, "herdr", rules([{ name: "m", pane_id: "w5:p1", agent_status: "working" }], [["w5", r.path]]));
    assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: false, failed: "agent-active" });
    // located elsewhere: fine
    setFakeRules(
      env,
      "herdr",
      rules([{ name: "m", pane_id: "w5:p1", agent_status: "working" }], [["w5", "/elsewhere"]]),
    );
    assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: true });
    // The caller's pane inside its linked worktree is exempt even when working/blocked;
    // the main checkout skips no pane.
    const saved = process.env.HERDR_PANE_ID;
    const savedBackend = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w5:p2";
    try {
      setFakeRules(env, "herdr", rules([{ name: "me", pane_id: "w5:p2", agent_status: "working" }], [["w5", r.path]]));
      assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: false, failed: "agent-active" }, "main skips no pane");
      const fromWorktree = resolveRepo(r.path);
      for (const status of ["working", "blocked"]) {
        setFakeRules(env, "herdr", rules([{ name: "me", pane_id: "w5:p2", agent_status: status }], [["w5", r.path]]));
        assert.deepEqual(safetyGuard(fromWorktree, "loc-a"), { ok: true }, `own ${status} pane is exempt`);
        assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: false, failed: "agent-active" }, `main: ${status}`);
      }
      setFakeRules(env, "herdr", rules([{ name: "me", pane_id: "w5:p2", agent_status: "unknown" }], [["w5", r.path]]));
      assert.deepEqual(safetyGuard(fromWorktree, "loc-a"), { ok: true }, "its own pane inside it is skipped");
      // the same pane id located outside the caller's worktree is not skipped
      setFakeRules(env, "herdr", rules([{ name: "me", pane_id: "w5:p2", agent_status: "working" }]));
      assert.deepEqual(safetyGuard(fromWorktree, "loc-a"), { ok: false, failed: "agent-unknown", detail: "me" });
      // another pane inside the worktree is not skipped
      setFakeRules(env, "herdr", rules([{ name: "x", pane_id: "w5:p9", agent_status: "working" }], [["w5", r.path]]));
      assert.deepEqual(safetyGuard(fromWorktree, "loc-a"), { ok: false, failed: "agent-active" });
    } finally {
      if (saved === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = saved;
      if (savedBackend === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = savedBackend;
    }
    setFakeRules(env, "herdr", rules([{ name: "idle-one", pane_id: "w6:p1", agent_status: "idle" }]));
    assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: true });
  }));

test("parseAgents leaves no control character in a name or status", () => {
  const agents = parseAgents({
    agents: [{ name: "a\u0085b\u001b[31m", pane_id: "w1:p1", agent_status: "wor\u009bking\u007f" }],
  });
  assert.equal(agents?.[0]?.name, "a?b?[31m");
  assert.equal(agents?.[0]?.status, "wor?king?");
});

// ---------------------------------------------------------------------------------------------
// Which herdr runs

test("HERDR_BIN_PATH is used when absolute, otherwise herdr comes from PATH", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      installFake(env, "herdr", [{ match: ["notification", "show"], stdout: "{}" }]);
      const saved = process.env.HERDR_BIN_PATH;
      const other = join(env.root, "other", "herdr");
      mkdirSync(dirname(other), { recursive: true });
      writeFileSync(other, `#!/bin/sh\necho x > ${join(env.root, "OTHER-RAN")}\necho '{}'\n`);
      chmodSync(other, 0o755);
      try {
        process.env.HERDR_BIN_PATH = "other/herdr";
        notify(repo, "question", "feat-a");
        assert.equal(existsSync(join(env.root, "OTHER-RAN")), false, "a relative path is ignored");
        assert.equal(fakeCalls(env, "herdr").length, 1);
        process.env.HERDR_BIN_PATH = other;
        notify(repo, "question", "feat-a");
        assert.equal(existsSync(join(env.root, "OTHER-RAN")), true);
        assert.equal(fakeCalls(env, "herdr").length, 1);
      } finally {
        if (saved === undefined) delete process.env.HERDR_BIN_PATH;
        else process.env.HERDR_BIN_PATH = saved;
      }
    }),
  ));

// ---------------------------------------------------------------------------------------------
// Values that go into herdr's argv

test("notify titles with 'session' when the branch name is one bin/wt refuses", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      installFake(env, "herdr", [{ match: ["notification", "show"], stdout: "{}" }]);
      notify(repo, "question", "--body=x");
      const call = fakeCalls(env, "herdr")[0];
      assert.ok(call?.[2]?.startsWith("session: "), call?.[2] ?? "");
    }),
  ));

test("a workspace id that reads as an option is never passed to workspace close", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const path = join(repo.worktreesDir, "feat-a");
      installFake(env, "herdr", [
        {
          match: ["workspace", "list"],
          stdout: json({
            type: "workspace_list",
            workspaces: [
              { workspace_id: "--force", label: "bad", worktree: { is_linked_worktree: true, checkout_path: path } },
            ],
          }),
        },
      ]);
      const out = captureStdout(() => closeWorkspace(repo, path, "feat-a"));
      assert.match(out, /none was closed/);
      assert.deepEqual(fakeCalls(env, "herdr"), [["workspace", "list"]]);
    }),
  ));

test("spawn treats a pane id that reads as an option as a malformed reply", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    readyIssueGh(env);
    installFake(
      env,
      "herdr",
      herdrRules(AGENT, [
        {
          match: ["worktree", "open"],
          stdout: json({
            type: "worktree_opened",
            already_open: false,
            workspace: { workspace_id: "w9", label: "task-ws" },
            root_pane: { pane_id: "--cwd" },
          }),
        },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), SPAWN_ARGS, { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 1);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "start").length, 0);
  }));

test("spawn refreshes the single issue immediately before setup and refuses a changed trust decision", () =>
  scenario({}, async ({ env, repo }) =>
    inHerdr(async () => {
      const untrusted = readyIssue(42, {
        timelineItems: { nodes: [issueEvent("outsider")], pageInfo: { hasPreviousPage: false } },
      });
      installFake(env, "gh", [
        { match: ["number=42"], stdout: githubPage({ issue: readyIssue(42) }), times: 1 },
        ...issueRules([untrusted]),
      ]);
      installFake(env, "herdr", herdrRules("wt-recense-42-fix-review-pane"));
      await assert.rejects(
        spawn(repo, { issue: 42, mode: "github" }, fakeClock()),
        (e: unknown) => e instanceof WtError && e.code === 2 && /untrusted/.test(e.message),
      );
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.equal(existsSync(repo.worktreesDir), false);
      assert.ok(!fakeCalls(env, "herdr").some((c) => c[0] === "worktree"));
    }),
  ));

test("spawn snapshots the refreshed owner-edited body", () =>
  scenario({}, async ({ env, repo }) =>
    inHerdr(async () => {
      const editedAt = "2026-01-03T00:00:00Z";
      const body = "Revised by owner.\n\nExact trailing spaces  ";
      installFake(env, "gh", [
        { match: ["number=42"], stdout: githubPage({ issue: readyIssue(42) }), times: 1 },
        ...issueRules([
          readyIssue(42, {
            body,
            lastEditedAt: editedAt,
            timelineItems: {
              nodes: [issueEvent("owner", "LabeledEvent", "2026-01-04T00:00:00Z")],
              pageInfo: { hasPreviousPage: false },
            },
            userContentEdits: issueEdits([{ editedAt, editor: { login: "OWNER" } }]),
          }),
        ]),
      ]);
      installFake(env, "herdr", herdrRules("wt-recense-42-fix-review-pane"));
      const result = await spawn(repo, { issue: 42, mode: "github" }, fakeClock());
      assert.equal(
        readFileSync(join(result.path, ".wt/issue.md"), "utf8"),
        `# Fix review pane\nhttps://example.invalid/test/issues/42\nThe issue body as its owner wrote it, in Markdown.\n\n${body}`,
      );
      assert.equal(fakeCalls(env, "gh").filter((c) => c.includes("number=42")).length, 2);
    }),
  ));

test("spawn omits a stranger's title from the snapshot and branch name", () =>
  scenario({}, async ({ env, repo }) =>
    inHerdr(async () => {
      const title = "Stranger supplied synthetic title";
      installFake(
        env,
        "gh",
        issueRules([
          readyIssue(42, {
            title,
            author: { login: "outsider" },
            userContentEdits: issueEdits(
              [{ editedAt: "2026-01-01T00:00:00Z", editor: { login: "owner" } }],
              false,
              "outsider",
            ),
          }),
        ]),
      );
      installFake(env, "herdr", herdrRules("wt-recense-42-issue"));
      const result = await spawn(repo, { issue: 42, mode: "github" }, fakeClock());
      assert.equal(result.branch, "recense-42-issue");
      const markdown = readFileSync(join(result.path, ".wt/issue.md"), "utf8");
      assert.ok(markdown.startsWith("# Issue 42\nThe title is left out because the owner did not write it.\n"));
      assert.ok(!markdown.includes(title));
      assert.ok(markdown.endsWith("Approved task.\n"));
    }),
  ));
