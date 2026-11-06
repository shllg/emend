import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import {
  agentName,
  closeWorkspace,
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
import { reserveTask } from "./tasks.ts";
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
import { cleanup, safetyGuard, setup, terminal } from "./worktree.ts";

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

const BRIEF = [
  "---",
  "id: NNN",
  "title: Add thing",
  "status: open",
  "---",
  "",
  "# NNN — Add thing",
  "",
  "Do it.",
  "",
].join("\n");

function writeBrief(main: string, name = "add-thing.md", text = BRIEF): void {
  mkdirSync(join(main, ".wt", "spawn"), { recursive: true });
  writeFileSync(join(main, ".wt", "spawn", name), text);
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

/** The arguments of a spawn call whose brief is the fixture's .wt/spawn/add-thing.md. */
function spawnArgs(main: string): string[] {
  return ["spawn", "--brief-file", join(main, ".wt", "spawn", "add-thing.md"), "--slug", "add-thing"];
}

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
      installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing", [{ ...processInfo([20]), times: 2 }]));
      await spawn(repo, { brief: BRIEF, slug: "add-thing", mode: "github" }, clock);
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
      installFake(
        env,
        "herdr",
        herdrRules("wt-emend-task-001-add-thing", [
          processInfo([20]),
          { match: ["agent", "start"], code: 1, stderr: failWith("agent_pane_busy") },
        ]),
      );
      await assert.rejects(spawn(repo, { brief: BRIEF, slug: "add-thing", mode: "github" }, clock), (e: unknown) => {
        assert.ok(e instanceof WtError);
        assert.equal(e.code, 1);
        assert.match(e.message, /agent_pane_busy/);
        assert.match(e.message, /no agent was started/);
        assert.match(e.message, /task number 001 stays reserved/);
        assert.match(e.message, /cleanup emend-task-001-add-thing/);
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
      gitIn(fx.main, "branch", "emend-99999999999999999999-x");
      gitIn(fx.origin, "branch", "emend-99999999999999999998-x", "main");
      installFake(env, "gh", issueRules([readyIssue(42)]));
      const expected = issueSnapshot(pickIssue(repo, 42));
      installFake(env, "herdr", herdrRules("wt-emend-42-fix-the-review-pane"));
      const result = await runWt(
        join(fx.main, "bin/wt"),
        ["spawn", "--issue", "42", "--mode", mode, "--model", "opus", "--effort", "high"],
        { cwd: fx.main, env: { HERDR_ENV: "1" } },
      );
      assert.equal(result.code, 0, result.stderr);
      const url = "https://example.invalid/test/issues/42";
      assert.equal(result.stdout.split("\n")[0], `Issue: #42 ${url}`);
      assert.equal(result.stdout.split("\n")[1], "Branch: emend-42-fix-the-review-pane");
      assert.doesNotMatch(result.stdout, /Task:/);
      const path = join(repo.worktreesDir, "emend-42-fix-the-review-pane");
      const metadata = JSON.parse(readFileSync(join(path, ".wt/worktree.json"), "utf8"));
      assert.equal(metadata.issue, 42);
      assert.equal(metadata.task, null);
      assert.equal(metadata.mode, mode);
      assert.equal(readFileSync(join(path, ".wt/brief.md"), "utf8"), `${url}\n`);
      assert.equal(
        readFileSync(join(path, ".wt/issue.md"), "utf8"),
        `# Fix the review pane\n${url}\nThe issue body as its owner wrote it, in Markdown.\n\nApproved task.\n`,
      );
      const snapshot = JSON.parse(readFileSync(join(path, ".wt/issue.json"), "utf8"));
      assert.deepEqual({ ...snapshot, fetchedAt: expected.fetchedAt }, expected);
      assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
      for (const name of ["issue.md", "issue.json"])
        assert.equal(statSync(join(path, ".wt", name)).mode & 0o777, 0o600);
      assert.ok(fakeCalls(env, "gh").filter((c) => c.includes("number=42")).length >= 3);
      assert.ok(fakeCalls(env, "gh").every((c) => !c.some((a) => /comments/.test(a))));
      assert.equal(existsSync(join(path, "tasks")), false);
      assert.deepEqual(readRegistry(repo).reservations, {});
      assert.equal(readRegistry(repo).worktrees["emend-42-fix-the-review-pane"]?.issue, 42);
      const calls = fakeCalls(env, "herdr");
      assert.deepEqual(calls.find((c) => c[1] === "start")?.slice(-4), ["--model", "opus", "--effort", "high"]);
      assert.equal(calls.find((c) => c[1] === "prompt")?.[3], spawnPrompt("#42", mode));
      const listed = await runWt(join(fx.main, "bin/wt"), ["list"], { cwd: fx.main });
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /emend-42-fix-the-review-pane\s+#42\s/);
      const json = await runWt(join(fx.main, "bin/wt"), ["list", "--json"], { cwd: fx.main });
      assert.equal(JSON.parse(json.stdout)[0].issue, 42);
    }));
}

test("spawn --issue rejects other sources and invalid numbers before any external call", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    installFake(env, "gh", issueRules([readyIssue(42)]));
    installFake(env, "herdr", herdrRules("unused"));
    const args = [
      ["--issue", "42", "--brief", BRIEF],
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
    assert.deepEqual(readRegistry(repo).reservations, {});
    assert.deepEqual(readRegistry(repo).worktrees, {});
  }));

test("spawn --issue preflight refuses blocked, untrusted, taken and not-ready work without creating anything", () =>
  scenario({ withBin: true }, async ({ env, fx, repo }) => {
    gitIn(fx.main, "branch", "emend-3-existing-other-title");
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
    assert.deepEqual(readRegistry(repo).reservations, {});
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(existsSync(repo.worktreesDir), false);
    assert.equal(gitIn(fx.main, "branch", "--format=%(refname:short)").split("\n").length, 2);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
  }));

test("issue spawn reports a stalled prompt once, leaves the worktree and reserves no task", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(async () => {
      installFake(env, "gh", issueRules([readyIssue(42, { title: "你好" })]));
      installFake(
        env,
        "herdr",
        herdrRules("wt-emend-42-issue", [
          { match: ["agent", "prompt"], code: 1, stderr: failWith("agent_prompt_stalled") },
        ]),
      );
      await assert.rejects(spawn(repo, { issue: 42, mode: "github" }, fakeClock()), (e: unknown) => {
        assert.ok(e instanceof WtError);
        assert.equal(e.code, 124);
        assert.match(e.message, /Do not resend the prompt/);
        assert.match(e.message, /cleanup emend-42-issue/);
        assert.doesNotMatch(e.message, /stays reserved/);
        return true;
      });
      assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "prompt").length, 1);
      assert.deepEqual(readRegistry(repo).reservations, {});
      assert.ok(readRegistry(repo).worktrees["emend-42-issue"]);
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

test("the prompt names the task file and the closing answer", () => {
  assert.equal(
    spawnPrompt("tasks/014-add-thing.md", "github"),
    "/loop /e-work tasks/014-add-thing.md Closing answer from /e-spawn: Open a ready PR and finalize it.",
  );
  assert.equal(
    spawnPrompt("tasks/014-add-thing.md", "local"),
    "/loop /e-work tasks/014-add-thing.md Closing answer from /e-spawn: Land locally after an emend review.",
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
// Reservation

test("reserveTask records the branch built from the reserved number", () =>
  scenario({}, ({ repo }) => {
    const n = reserveTask(repo, "add-thing", (num) => `${num}-add-thing`);
    assert.equal(n, "001");
    assert.equal(readRegistry(repo).reservations["001"]?.branch, "001-add-thing");
    assert.equal(reserveTask(repo, "other-thing", "feat-other"), "002");
    assert.equal(readRegistry(repo).reservations["002"]?.branch, "feat-other");
  }));

// ---------------------------------------------------------------------------------------------
// spawn

test("brief spawn uses a task namespace distinct from issue branches", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    mkdirSync(join(fx.main, "tasks"));
    writeFileSync(join(fx.main, "tasks", "013-prior.md"), "---\nid: 013\ntitle: Prior\nstatus: open\n---\n");
    writeBrief(fx.main);
    installFake(env, "herdr", herdrRules("wt-emend-task-014-add-thing"));

    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 0, r.stderr);

    const wtPath = join(fx.main, ".claude", "worktrees", "emend-task-014-add-thing");
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines[0], "Task: tasks/014-add-thing.md");
    assert.equal(lines[1], "Branch: emend-task-014-add-thing");
    assert.match(lines[2] as string, /^Port: 36\d\d$/);
    assert.equal(lines[3], `Worktree: ${wtPath}`);
    assert.equal(
      lines.at(-1),
      "Claude agent wt-emend-task-014-add-thing is working on emend-task-014-add-thing in herdr workspace task-ws (w9).",
    );

    const prompt =
      "/loop /e-work tasks/014-add-thing.md Closing answer from /e-spawn: Open a ready PR and finalize it.";
    assert.deepEqual(fakeCalls(env, "herdr"), [
      ["agent", "list"],
      ["worktree", "open", "--cwd", fx.main, "--path", wtPath, "--no-focus"],
      ["pane", "process-info", "--pane", "w9:p1"],
      [
        "agent",
        "start",
        "wt-emend-task-014-add-thing",
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
        "emend-task-014-add-thing",
      ],
      [
        "agent",
        "prompt",
        "wt-emend-task-014-add-thing",
        prompt,
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        "60000",
      ],
    ]);

    const task = readFileSync(join(wtPath, "tasks", "014-add-thing.md"), "utf8");
    assert.match(task, /^id: 014$/m);
    assert.match(task, /^# 014 — Add thing$/m);
    assert.equal(task.includes("NNN"), false);
    assert.equal(readFileSync(join(wtPath, ".wt", "brief.md"), "utf8"), task);
    assert.equal(readRegistry(repo).reservations["014"]?.branch, "emend-task-014-add-thing");
    assert.equal(readRegistry(repo).worktrees["emend-task-014-add-thing"]?.task, "014");
  }));

test("spawn passes model and effort to the agent only", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    writeBrief(fx.main);
    installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing"));
    const r = await runWt(
      join(fx.main, "bin", "wt"),
      [...spawnArgs(fx.main), "--mode", "local", "--model", "opus", "--effort", "high"],
      {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      },
    );
    assert.equal(r.code, 0, r.stderr);
    const calls = fakeCalls(env, "herdr");
    assert.deepEqual(calls.find((c) => c[1] === "start")?.slice(-4), ["--model", "opus", "--effort", "high"]);
    assert.match(calls.find((c) => c[1] === "prompt")?.[3] as string, /Land locally after an emend review\.$/);
  }));

test("spawn refuses a malformed model or effort without echoing it", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    writeBrief(fx.main);
    installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing"));
    for (const extra of [
      ["--model", "Bad Model!"],
      ["--effort", "extreme-secret"],
    ]) {
      const r = await runWt(join(fx.main, "bin", "wt"), [...spawnArgs(fx.main), ...extra], {
        cwd: fx.main,
        env: { HERDR_ENV: "1" },
      });
      assert.equal(r.code, 2);
      assert.equal(/Bad Model|extreme-secret/.test(r.stdout + r.stderr), false);
      assert.match(r.stderr, /Nothing was created\./);
    }
    assert.deepEqual(readRegistry(repo).reservations, {});
  }));

test("spawn outside herdr creates nothing", () =>
  scenario({ withBin: true }, async ({ fx, repo }) => {
    writeBrief(fx.main);
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main });
    assert.equal(r.code, 69);
    assert.match(r.stdout + r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).reservations, {});
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.equal(gitIn(fx.main, "branch", "--list", "emend-task-001-*"), "");
    assert.equal(existsSync(join(fx.main, ".claude", "worktrees")), false);
  }));

test("spawn outside herdr: herdr unreachable creates nothing", () =>
  scenario({ withBin: true }, async ({ fx, repo }) => {
    writeBrief(fx.main);
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 69);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).reservations, {});
  }));

test("spawn refuses to run from a linked worktree", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    writeBrief(fx.main);
    installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing"));
    const other = setup(repo, { branch: "other-work" });
    // the main checkout's copy, called by its absolute path from inside the linked worktree
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: other.path, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Run spawn from the main checkout\./);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).reservations, {});
  }));

test("spawn: an existing agent name releases the reservation", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    writeBrief(fx.main);
    installFake(env, "herdr", [
      {
        match: ["agent", "list"],
        stdout: json({ type: "agent_list", agents: [{ name: "wt-emend-task-001-add-thing" }] }),
      },
    ]);
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).reservations, {});
    assert.equal(fakeCalls(env, "herdr").length, 1);
  }));

test("spawn: an existing branch on origin releases the reservation", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    writeBrief(fx.main);
    installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing"));
    gitIn(fx.main, "push", "--quiet", "origin", "main:refs/heads/emend-task-001-add-thing");
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 3);
    assert.match(r.stderr, /Nothing was created\./);
    assert.deepEqual(readRegistry(repo).reservations, {});
  }));

test("spawn: prompt stalled is not resent", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    writeBrief(fx.main);
    installFake(
      env,
      "herdr",
      herdrRules("wt-emend-task-001-add-thing", [
        { match: ["agent", "prompt"], stderr: failWith("agent_prompt_stalled", "no activity"), code: 1 },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 124);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "prompt").length, 1);
    assert.match(r.stderr, /Do not resend the prompt/);
    const wtPath = join(fx.main, ".claude", "worktrees", "emend-task-001-add-thing");
    assert.ok(r.stderr.includes(wtPath));
    assert.ok(r.stderr.includes(`${fx.main}/bin/wt cleanup emend-task-001-add-thing`));
    // nothing was cleaned up or released
    assert.ok(existsSync(wtPath));
    assert.equal(readRegistry(repo).reservations["001"]?.branch, "emend-task-001-add-thing");
  }));

test("spawn: start refused reports the worktree", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    writeBrief(fx.main);
    installFake(
      env,
      "herdr",
      herdrRules("wt-emend-task-001-add-thing", [
        { match: ["agent", "start"], stderr: failWith("agent_name_taken", "taken"), code: 1 },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 1);
    const wtPath = join(fx.main, ".claude", "worktrees", "emend-task-001-add-thing");
    assert.ok(r.stderr.includes(wtPath));
    assert.match(r.stderr, /bin\/wt cleanup emend-task-001-add-thing/);
    assert.match(r.stderr, /no agent was started/);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "prompt").length, 0);
    assert.ok(existsSync(wtPath));
    assert.ok(readRegistry(repo).worktrees["emend-task-001-add-thing"]);
  }));

test("spawn: a blocked agent is reported as waiting", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    writeBrief(fx.main);
    installFake(
      env,
      "herdr",
      herdrRules("wt-emend-task-001-add-thing", [
        {
          match: ["agent", "prompt"],
          stdout: json({ type: "agent_prompted", agent: { agent_status: "blocked" } }),
        },
      ]),
    );
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout.trimEnd().split("\n").at(-1),
      "Claude agent wt-emend-task-001-add-thing started and is waiting for an answer in herdr workspace task-ws (w9).",
    );
  }));

test("spawn: an already open workspace starts no agent", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    writeBrief(fx.main);
    installFake(
      env,
      "herdr",
      herdrRules("wt-emend-task-001-add-thing", [
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
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
    assert.equal(r.code, 3);
    assert.equal(fakeCalls(env, "herdr").filter((c) => c[1] === "start").length, 0);
    assert.match(r.stderr, /bin\/wt cleanup emend-task-001-add-thing/);
  }));

test("brief input is checked before anything is created", () =>
  scenario({ withBin: true }, async ({ fx, env, repo }) => {
    installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing"));
    const wt = join(fx.main, "bin", "wt");
    const opts = { cwd: fx.main, env: { HERDR_ENV: "1" } };
    const assertNothing = (r: { code: number | null; stderr: string; stdout: string }) => {
      assert.equal(r.code, 2);
      assert.deepEqual(readRegistry(repo).reservations, {});
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.equal(existsSync(join(fx.main, ".claude", "worktrees")), false);
      assert.equal(r.stdout + r.stderr === "", false);
    };
    const file = join(fx.main, "brief.md");
    writeFileSync(file, BRIEF);

    // both forms, neither form
    assertNothing(await runWt(wt, ["spawn", "--brief", BRIEF, "--brief-file", file, "--slug", "add-thing"], opts));
    assertNothing(await runWt(wt, ["spawn", "--slug", "add-thing"], opts));

    // a brief without the id placeholder
    assertNothing(await runWt(wt, ["spawn", "--brief", "# Plain\n", "--slug", "add-thing"], opts));

    // a missing file
    assertNothing(await runWt(wt, ["spawn", "--brief-file", join(fx.main, "none.md"), "--slug", "add-thing"], opts));
    assert.equal(fakeCalls(env, "herdr").length, 0);
  }));

test("spawn takes the brief as text", () =>
  scenario({ withBin: true }, async ({ fx, env }) => {
    installFake(env, "herdr", herdrRules("wt-emend-task-001-add-thing"));
    const r = await runWt(join(fx.main, "bin", "wt"), ["spawn", `--brief=${BRIEF}`, "--slug", "add-thing"], {
      cwd: fx.main,
      env: { HERDR_ENV: "1" },
    });
    assert.equal(r.code, 0, r.stderr);
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
      ["notification", "show", "main: review ready", "--body", "The emend review waits for you"],
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
      installFake(env, "herdr", [{ match: ["workspace"], stdout: json({ type: "workspace_list", workspaces: [] }) }]);
      captureStdout(() => cleanup(repo, { target: "feat-a", closeWorkspace: false, discard: false }));
      assert.equal(fakeCalls(env, "herdr").filter((c) => c[0] === "workspace").length, 0);
    }),
  ));

test("cleanup --discard --close-workspace closes the workspace without the merged notification", () =>
  scenario({}, ({ env, repo }) =>
    inHerdr(() => {
      const r = setup(repo, { branch: "feat-a" });
      installFake(env, "herdr", [
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
    // HERDR_PANE_ID: from the main checkout no pane is skipped; from the linked worktree itself only the pane
    // whose location lies inside that worktree is
    const saved = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "w5:p2";
    try {
      setFakeRules(env, "herdr", rules([{ name: "me", pane_id: "w5:p2", agent_status: "working" }], [["w5", r.path]]));
      assert.deepEqual(safetyGuard(repo, "loc-a"), { ok: false, failed: "agent-active" }, "main skips no pane");
      const fromWorktree = resolveRepo(r.path);
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
    writeBrief(fx.main);
    installFake(
      env,
      "herdr",
      herdrRules("wt-emend-task-001-add-thing", [
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
    const r = await runWt(join(fx.main, "bin", "wt"), spawnArgs(fx.main), { cwd: fx.main, env: { HERDR_ENV: "1" } });
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
      installFake(env, "herdr", herdrRules("wt-emend-42-fix-the-review-pane"));
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
      installFake(env, "herdr", herdrRules("wt-emend-42-fix-the-review-pane"));
      const result = await spawn(repo, { issue: 42, mode: "github" }, fakeClock());
      assert.equal(
        readFileSync(join(result.path, ".wt/issue.md"), "utf8"),
        `# Fix the review pane\nhttps://example.invalid/test/issues/42\nThe issue body as its owner wrote it, in Markdown.\n\n${body}`,
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
      installFake(env, "herdr", herdrRules("wt-emend-42-issue"));
      const result = await spawn(repo, { issue: 42, mode: "github" }, fakeClock());
      assert.equal(result.branch, "emend-42-issue");
      const markdown = readFileSync(join(result.path, ".wt/issue.md"), "utf8");
      assert.ok(markdown.startsWith("# Issue 42\nThe title is left out because the owner did not write it.\n"));
      assert.ok(!markdown.includes(title));
      assert.ok(markdown.endsWith("Approved task.\n"));
    }),
  ));
