import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { mock, test } from "node:test";
import {
  agentInventory,
  agentName,
  closeWorkspace,
  commands,
  detectedBackend,
  hcCall,
  locatedAgents,
  notify,
  spawn,
  spawnPrompt,
} from "./herdr.ts";
import { readRegistry, registryPath, withRegistry } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  type FakeRule,
  type Fixture,
  fakeCalls,
  fakeClock,
  fakeGithubOrigin,
  installFake,
  issueRules,
  makeFixture,
  makeTestEnv,
  readyIssue,
  runWt,
  setFakeRules,
  type TestEnv,
} from "./test-support.ts";
import { WtError } from "./validate.ts";
import { cleanup, list, safetyGuard, setup } from "./worktree.ts";

async function toolsOnly(fn: (env: TestEnv) => void | Promise<void>): Promise<void> {
  const env = makeTestEnv({ ports: false });
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

async function scenario(
  fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>,
  withBin = false,
): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env, { withBin });
    fakeGithubOrigin(env, fx);
    installFake(env, "claude", []);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

function capture(fn: () => void): string {
  let out = "";
  const write = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    write.mock.restore();
  }
  return out;
}

const failure = (code: number, pattern?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof WtError);
  assert.equal(e.code, code);
  if (pattern) assert.match(e.message, pattern);
  return true;
};
const json = JSON.stringify;
const brief = "---\nid: NNN\ntitle: Thing\nstatus: open\n---\n# NNN — Thing\nDo it.\n";
const options = { brief, slug: "add-thing", mode: "github" as const };
const branch = "emend-task-001-add-thing";
const name = agentName(branch);
const herdrList = (agents: Record<string, unknown>[] = []): FakeRule => ({
  match: ["agent", "list"],
  stdout: json({ result: { type: "agent_list", agents } }),
});
const hcList = (terminals: Record<string, unknown>[] = []): FakeRule => ({
  match: ["ls", "--json"],
  stdout: json({ hidden_finished: 4, terminals }),
});
const terminal = (extra: Record<string, unknown> = {}) => ({
  address: "t2",
  name: "worker",
  state: "live",
  status: "working",
  cwd: "/launch",
  ...extra,
});
const get = (extra: Record<string, unknown> = {}, address = "t2"): FakeRule => ({
  match: ["get", address, "--json"],
  stdout: json({
    address,
    name: "worker",
    state: "live",
    status: { state: "working" },
    foreground: { cwd: "/live" },
    ...extra,
  }),
});
const launchRules = (state = "working", extra: FakeRule[] = []): FakeRule[] => [
  ...extra,
  hcList(),
  { match: ["run"], stdout: json({ address: "t1m", name, labels: null, state: "live" }) },
  get({ name, status: { state } }, "t1m"),
];
const command = async (repo: Repo, sub: string, args: string[]) => {
  const fn = commands[sub];
  assert.ok(fn);
  return fn({ repo, args });
};

function issueWorker(env: TestEnv, repo: Repo, issue = 42) {
  installFake(env, "gh", issueRules([readyIssue(issue)]));
  return setup(repo, { branch: `emend-${issue}-worker-tree`, issue });
}

test("backend detection ignores unsafe hc ids and the test environment scrubs both backends", () =>
  toolsOnly(() => {
    for (const key of ["HC_TERMINAL_ID", "HC_BIN_PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_BIN_PATH"])
      assert.equal(process.env[key], undefined);
    assert.equal(detectedBackend(), null);
    process.env.HERDR_ENV = "1";
    assert.equal(detectedBackend(), "herdr");
    process.env.HC_TERMINAL_ID = "t1k";
    assert.equal(detectedBackend(), "both");
    delete process.env.HERDR_ENV;
    assert.equal(detectedBackend(), "hc");
    for (const id of ["", "t", "--help", "t2\n", "t2;echo", "other/t2", "t_2", "T2"]) {
      process.env.HC_TERMINAL_ID = id;
      assert.equal(detectedBackend(), null, id);
      process.env.HERDR_ENV = "1";
      assert.equal(detectedBackend(), "herdr", id);
      delete process.env.HERDR_ENV;
    }
  }));

test("hcCall maps exits, sanitises JSON errors and requires one JSON object", () =>
  toolsOnly((env) => {
    assert.throws(() => hcCall(["ls", "--json"]), failure(69, /^herdr desktop \(hc\) is unavailable\.$/));
    for (const [reply, code, message] of [
      [{ code: 127 }, 69, /unavailable/],
      [{ code: 124 }, 124, /outcome unconfirmed/],
      [
        { code: 5, stderr: json({ error: { kind: "unavailable", message: "bad\u001b\u0085", hint: "private hint" } }) },
        1,
        /bad\?\?/,
      ],
      [{ code: 2, stderr: "bad\u001b\n" }, 1, /bad\?\?/],
      ...["not JSON", "[]", "null", "{}\n{}"].map((stdout) => [{ stdout }, 1, /valid JSON object/] as const),
    ] as [FakeRule, number, RegExp][]) {
      installFake(env, "hc", [reply]);
      assert.throws(() => hcCall(["ls", "--json"]), failure(code, message));
    }
    installFake(env, "hc", [{ stdout: "{}" }]);
    assert.deepEqual(hcCall(["ls", "--json"]), {});
  }));

test("hc uses absolute HC_BIN_PATH, ignores a relative override and always runs at /", () =>
  toolsOnly((env) => {
    installFake(env, "hc", [{ stdout: '{"from":"path"}' }]);
    installFake(env, "other-hc", [{ stdout: '{"from":"absolute"}' }]);
    process.env.HC_BIN_PATH = "relative/hc";
    assert.deepEqual(hcCall(["ls", "--json"]), { from: "path" });
    process.env.HC_BIN_PATH = join(env.fakeBin, "other-hc");
    assert.deepEqual(hcCall(["ls", "--json"]), { from: "absolute" });
    writeFileSync(
      process.env.HC_BIN_PATH,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({cwd:process.cwd()}));\n`,
    );
    assert.deepEqual(hcCall(["ls", "--json"]), { cwd: "/" });
  }));

test("union lists herdr only, hc only, both and neither regardless of caller environment", () =>
  toolsOnly((env) => {
    assert.equal(locatedAgents(), null);
    installFake(env, "herdr", [herdrList([{ name: "old", agent_status: "working", cwd: "/old" }])]);
    assert.deepEqual(
      locatedAgents()?.map((a) => [a.backend, a.name, a.address, a.location]),
      [["herdr", "old", null, "/old"]],
    );
    installFake(env, "hc", [
      hcList([terminal(), terminal({ address: "t3", status: null })]),
      get(),
      get(
        { name: null, status: null, pid: 3, argv: ["/bin/zsh"], foreground: { pid: 3, name: "zsh", cwd: "/shell" } },
        "t3",
      ),
    ]);
    assert.deepEqual(
      locatedAgents()?.map((a) => a.backend),
      ["herdr", "hc", "hc"],
    );
    setFakeRules(env, "herdr", [{ code: 1 }]);
    const hc = locatedAgents();
    assert.deepEqual(
      hc?.map((a) => [a.backend, a.name, a.address, a.location]),
      [
        ["hc", "worker", "t2", "/live"],
        ["hc", "worker", "t3", "/shell"],
      ],
    );
    assert.equal(hc?.[1]?.idleShell, true);
    assert.ok(fakeCalls(env, "hc").some((c) => c[0] === "get" && c[1] === "t3"));
    setFakeRules(env, "hc", [{ code: 1 }]);
    assert.equal(locatedAgents(), null);
    setFakeRules(env, "hc", [hcList()]);
    assert.deepEqual(locatedAgents(), []);
  }));

test("hc skips other-machine terminals even at registered folders but retains their name shadows", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = setup(repo, { branch: "worker-tree" });
    const remote = terminal({ address: "devbox/t10", name: "remote-worker", cwd: wt.path });
    const localGet = get({ cwd: wt.path, foreground: { cwd: wt.path } });
    installFake(env, "hc", [hcList([terminal({ cwd: wt.path }), remote]), localGet]);
    const inventory = agentInventory();
    assert.deepEqual(inventory.unavailable, []);
    assert.deepEqual(
      inventory.agents.map((a) => [a.address, a.location]),
      [["t2", wt.path]],
    );
    const listed = await runWt(join(fx.main, "bin/wt"), ["agents", "--json"], { cwd: fx.main });
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(
      JSON.parse(listed.stdout).map((a: { address: string }) => a.address),
      ["t2"],
    );
    await assert.rejects(command(repo, "agent", ["read", "devbox/t10"]), failure(2, /No agent matches/));
    const before = fakeCalls(env, "hc").length;
    setFakeRules(env, "hc", [hcList([terminal(), { ...remote, name: "t2" }]), localGet]);
    await assert.rejects(command(repo, "agent", ["read", "t2"]), failure(2, /shadowed/));
    assert.ok(
      !fakeCalls(env, "hc")
        .slice(before)
        .some((c) => ["get", "read", "send"].includes(c[0] ?? "")),
    );
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "get" && c[1] === "devbox/t10"));
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "read" || c[0] === "send"));
  }, true));

test("hc retains separate live and launch folders, sanitises labels, and failed gets stay unknown", () =>
  toolsOnly((env) => {
    installFake(env, "hc", [
      hcList([terminal({ name: "n\u001b", address: "t2" }), terminal({ address: "t4", name: null })]),
      get({
        name: "n\u0085",
        cwd: "/launch",
        foreground: null,
        status: { state: "WORKING" },
        labels: { good: "yes", bad: "a\u001b\n", number: 3 },
      }),
      { match: ["get", "t4"], code: 1 },
    ]);
    const agents = locatedAgents();
    assert.equal(agents?.length, 2);
    assert.deepEqual(agents?.[0]?.labels, { good: "yes", bad: "a??" });
    assert.equal(agents?.[0]?.name, "n?");
    assert.equal(agents?.[0]?.status, "working");
    assert.ok(agents?.every((a) => a.location === null));
    assert.equal(agents?.[0]?.launchCwd, "/launch");
    assert.equal(agents?.[1]?.launchCwd, null);
    assert.equal(agents?.[1]?.status, "unknown");
    assert.equal(agents?.[1]?.name, null);
    assert.ok(!fakeCalls(env, "hc").some((c) => c.includes("--help")));
    setFakeRules(env, "hc", [hcList([terminal()]), get({ address: "t9" })]);
    assert.equal(locatedAgents()?.[0]?.location, null);
    setFakeRules(env, "hc", [hcList([terminal({ address: "--help" })])]);
    assert.deepEqual(agentInventory().unavailable, ["herdr desktop (hc)"]);
    assert.ok(!fakeCalls(env, "hc").some((c) => c.includes("--help")));
  }));

test("hc participates in list and the removal guard, including only the located caller exemption", () =>
  scenario(({ env, repo }) => {
    const wt = setup(repo, { branch: "worker-tree" });
    const use = (status: string, location: string | null, address = "t2") =>
      setFakeRules(env, "hc", [
        hcList([terminal({ address })]),
        get({ foreground: location === null ? null : { cwd: location }, status: { state: status } }, address),
      ]);
    installFake(env, "hc", []);
    use("working", wt.path);
    assert.equal(list(repo)[0]?.agent, "working");
    assert.deepEqual(safetyGuard(repo, "worker-tree"), { ok: false, failed: "agent-active" });
    use("working", null);
    assert.deepEqual(safetyGuard(repo, "worker-tree"), { ok: false, failed: "agent-unknown", detail: "worker" });
    for (const status of ["idle", "done"]) {
      use(status, null);
      assert.deepEqual(safetyGuard(repo, "worker-tree"), { ok: true });
    }
    process.env.HC_TERMINAL_ID = "t2";
    use("working", wt.path);
    assert.deepEqual(safetyGuard(repo, "worker-tree"), { ok: false, failed: "agent-active" });
    const linked = resolveRepo(wt.path);
    for (const status of ["working", "blocked"]) {
      use(status, wt.path);
      assert.deepEqual(safetyGuard(linked, "worker-tree"), { ok: true }, `own ${status} terminal is exempt`);
      assert.deepEqual(safetyGuard(repo, "worker-tree"), { ok: false, failed: "agent-active" }, `main: ${status}`);
    }
    use("unknown", wt.path);
    assert.deepEqual(safetyGuard(linked, "worker-tree"), { ok: true });
    use("working", null);
    assert.deepEqual(safetyGuard(linked, "worker-tree"), { ok: false, failed: "agent-unknown", detail: "worker" });
    use("working", wt.path, "t3");
    assert.deepEqual(safetyGuard(linked, "worker-tree"), { ok: false, failed: "agent-active" });
    use("working", `${wt.path}-other`);
    assert.deepEqual(safetyGuard(linked, "worker-tree"), { ok: true });
  }));

for (const state of ["working", "blocked"] as const)
  test(`hc spawn launches once with the exact argv and confirms ${state} even when herdr fails`, () =>
    scenario(async ({ env, repo }) => {
      process.env.HC_TERMINAL_ID = "t1k";
      installFake(env, "herdr", [{ code: 1 }]);
      installFake(
        env,
        "hc",
        launchRules(state, [
          hcList([terminal({ address: "devbox/t10", name: "remote-worker" })]),
          { ...get({ status: { state: "idle" } }, "t1m"), times: 1 },
        ]),
      );
      const clock = fakeClock();
      const result = await spawn(repo, { ...options, model: "opus", effort: "high" }, clock);
      assert.equal(result.state, state);
      assert.equal(result.workspaceId, "t1m");
      assert.equal(result.workspaceLabel, name);
      assert.equal(readRegistry(repo).worktrees[branch]?.hcAddress, "t1m");
      assert.deepEqual(clock.sleeps, [500]);
      assert.deepEqual(fakeCalls(env, "hc"), [
        ["ls", "--json"],
        [
          "run",
          "--bg",
          "--json",
          "--name",
          name,
          "--cwd",
          result.path,
          "--outlive-parent",
          "--no-notify",
          "--label",
          "emend.loop=t1k",
          "--label",
          `emend.branch=${branch}`,
          "--",
          join(env.fakeBin, "claude"),
          "--permission-mode",
          "auto",
          "--name",
          branch,
          "--model",
          "opus",
          "--effort",
          "high",
          spawnPrompt(result.taskFile, "github"),
        ],
        ["get", "t1m", "--json"],
        ["get", "t1m", "--json"],
      ]);
      assert.match(readFileSync(join(result.path, result.taskFile), "utf8"), /id: 001/);
    }));

test("hc issue spawn adds the issue label and fixed initial issue prompt", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    installFake(env, "gh", issueRules([readyIssue(42)]));
    installFake(env, "hc", launchRules());
    const result = await spawn(repo, { issue: 42, mode: "github" }, fakeClock());
    const call = fakeCalls(env, "hc").find((c) => c[0] === "run");
    assert.deepEqual(call, [
      "run",
      "--bg",
      "--json",
      "--name",
      result.agent,
      "--cwd",
      result.path,
      "--outlive-parent",
      "--no-notify",
      "--label",
      "emend.loop=t2",
      "--label",
      `emend.branch=${result.branch}`,
      "--label",
      "emend.issue=42",
      "--",
      join(env.fakeBin, "claude"),
      "--permission-mode",
      "auto",
      "--name",
      result.branch,
      spawnPrompt("#42", "github"),
    ]);
    assert.equal(readFileSync(join(result.path, ".wt/brief.md"), "utf8"), "https://example.invalid/test/issues/42\n");
  }));

test("hc spawn deadline is 124, preserves setup, polls every 500ms and never relaunches or sends", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    installFake(env, "hc", launchRules("idle"));
    const clock = fakeClock();
    await assert.rejects(spawn(repo, options, clock), (e) => {
      failure(124, /outcome unconfirmed/)(e);
      assert.ok(e instanceof WtError);
      assert.match(e.message, /hc read t1m/);
      assert.match(e.message, /Do not resend/);
      assert.match(e.message, /task number 001 stays reserved/);
      assert.match(e.message, /This does not end the herdr workspace or terminal/);
      return true;
    });
    assert.equal(clock.now(), 90_000);
    assert.deepEqual(clock.sleeps, Array(180).fill(500));
    const calls = fakeCalls(env, "hc");
    assert.equal(calls.filter((c) => c[0] === "get").length, 180);
    assert.equal(calls.filter((c) => c[0] === "run").length, 1);
    assert.ok(calls.every((c) => ["ls", "get", "run"].includes(c[0] ?? "")));
    assert.ok(readRegistry(repo).worktrees[branch]);
    assert.equal(readRegistry(repo).worktrees[branch]?.hcAddress, "t1m");
    assert.ok(existsSync(join(repo.worktreesDir, branch)));
  }));

for (const state of ["exited", "finished"])
  test(`hc spawn reports ${state} without retrying`, () =>
    scenario(async ({ env, repo }) => {
      process.env.HC_TERMINAL_ID = "t2";
      installFake(env, "hc", launchRules("working", [get({ state, exit_code: 0 }, "t1m")]));
      await assert.rejects(spawn(repo, options, fakeClock()), failure(1, /exited before work was confirmed/));
      assert.equal(fakeCalls(env, "hc").filter((c) => c[0] === "run").length, 1);
      assert.ok(readRegistry(repo).worktrees[branch]);
    }));

test("hc spawn rejects an unsafe returned address without using it or launching again", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    installFake(env, "hc", launchRules("working", [{ match: ["run"], stdout: json({ address: "--help" }) }]));
    await assert.rejects(spawn(repo, options, fakeClock()), failure(1, /Invalid herdr desktop terminal response/));
    assert.deepEqual(
      fakeCalls(env, "hc").map((c) => c[0]),
      ["ls", "run"],
    );
  }));

test("spawn preflight refuses both backends and unavailable hc before creating anything", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    process.env.HERDR_ENV = "1";
    installFake(env, "hc", launchRules());
    installFake(env, "herdr", [herdrList()]);
    await assert.rejects(
      spawn(repo, options, fakeClock()),
      failure(2, /^Both herdr and herdr desktop are detected; run spawn from one of them\. Nothing was created\.$/),
    );
    assert.deepEqual(fakeCalls(env, "hc"), []);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
    delete process.env.HERDR_ENV;
    for (const reply of [{ code: 1 }, { stdout: "{}" }, { stdout: "not JSON" }]) {
      setFakeRules(env, "hc", [reply]);
      await assert.rejects(spawn(repo, options, fakeClock()), failure(69, /Nothing was created/));
    }
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.deepEqual(readRegistry(repo).reservations, {});
  }));

for (const caller of ["hc", "herdr"])
  test(`${caller} spawn checks the other backend for name collisions`, () =>
    scenario(async ({ env, repo }) => {
      if (caller === "hc") process.env.HC_TERMINAL_ID = "t2";
      else process.env.HERDR_ENV = "1";
      installFake(env, "herdr", [herdrList(caller === "hc" ? [{ name, cwd: "/somewhere" }] : [])]);
      installFake(env, "hc", caller === "hc" ? launchRules() : [hcList([terminal({ name })]), get({ name })]);
      await assert.rejects(spawn(repo, options, fakeClock()), failure(3, /name already exists/));
      assert.deepEqual(readRegistry(repo).reservations, {});
      assert.deepEqual(readRegistry(repo).worktrees, {});
      assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "run"));
    }));

test("hc notify is silent; both still uses the existing herdr notification", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    installFake(env, "hc", []);
    installFake(env, "herdr", [{ match: ["notification", "show"], stdout: "{}" }]);
    assert.equal(await capture(() => notify(repo, "question")), "");
    assert.deepEqual(fakeCalls(env, "hc"), []);
    assert.deepEqual(fakeCalls(env, "herdr"), []);
    process.env.HERDR_ENV = "1";
    notify(repo, "question");
    assert.equal(fakeCalls(env, "herdr").length, 1);
  }));

test("hc close uses only the registry-owned address and checks every ownership field", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    const wt = setup(repo, { branch: "worker-tree" });
    const details = { cwd: wt.path, labels: { "emend.branch": "worker-tree" }, foreground: { cwd: "/elsewhere" } };
    const rules = (extra: Record<string, unknown> = {}): FakeRule[] => [
      hcList([terminal(), terminal({ address: "t3" })]),
      get({ ...details, ...extra }),
      get(details, "t3"),
      { match: ["kill"], stdout: "{}" },
    ];
    installFake(env, "hc", rules());
    assert.match(await capture(() => closeWorkspace(repo, wt.path, "worker-tree")), /No recorded.*none was closed/);
    assert.deepEqual(fakeCalls(env, "hc"), [], "labels alone never authorize a kill");
    withRegistry(repo, (r) => {
      assert.ok(r.worktrees["worker-tree"]);
      r.worktrees["worker-tree"].hcAddress = "t2";
    });
    assert.match(
      await capture(() => closeWorkspace(repo, wt.path, "worker-tree")),
      /Closing herdr desktop terminal worker \(t2\)/,
    );
    assert.deepEqual(fakeCalls(env, "hc"), [
      ["ls", "--json"],
      ["get", "t2", "--json"],
      ["kill", "t2"],
    ]);
    for (const mismatch of [
      { labels: {} },
      { labels: { "emend.branch": "another-branch" } },
      { cwd: `${wt.path}-other` },
      { state: "finished" },
      { address: "t3" },
    ]) {
      installFake(env, "hc", rules(mismatch));
      assert.match(
        await capture(() => closeWorkspace(repo, wt.path, "worker-tree")),
        /none was closed|No terminal was closed/,
      );
      assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "kill"));
    }
    installFake(env, "hc", [hcList([terminal()]), { match: ["get"], code: 1 }]);
    assert.match(await capture(() => closeWorkspace(repo, wt.path, "worker-tree")), /No terminal was closed/);
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "kill"));
    process.env.HERDR_ENV = "1";
    installFake(env, "hc", rules());
    assert.match(await capture(() => closeWorkspace(repo, wt.path, "worker-tree")), /Both herdr and herdr desktop/);
    assert.deepEqual(fakeCalls(env, "hc"), []);
  }));

test("hc close refuses a recorded address shadowed by any live terminal name", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    const wt = setup(repo, { branch: "worker-tree" });
    withRegistry(repo, (r) => {
      assert.ok(r.worktrees["worker-tree"]);
      r.worktrees["worker-tree"].hcAddress = "t2";
    });
    installFake(env, "hc", [hcList([terminal(), terminal({ address: "t3", name: "t2", status: null })])]);
    assert.match(await capture(() => closeWorkspace(repo, wt.path, "worker-tree")), /shadowed/);
    assert.deepEqual(fakeCalls(env, "hc"), [["ls", "--json"]]);
  }));

test("hc cleanup closes the matching terminal only after removing its worktree", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    const wt = setup(repo, { branch: "worker-tree" });
    installFake(env, "hc", [
      hcList([terminal()]),
      get({
        cwd: wt.path,
        foreground: { cwd: wt.path },
        status: { state: "idle" },
        labels: { "emend.branch": "worker-tree" },
      }),
      { match: ["kill"], stdout: "{}" },
    ]);
    withRegistry(repo, (r) => {
      assert.ok(r.worktrees["worker-tree"]);
      r.worktrees["worker-tree"].hcAddress = "t2";
    });
    await capture(() => cleanup(repo, { target: "worker-tree", closeWorkspace: true, discard: false }));
    assert.equal(existsSync(wt.path), false);
    assert.equal(readRegistry(repo).worktrees["worker-tree"], undefined);
    assert.deepEqual(fakeCalls(env, "hc").at(-1), ["kill", "t2"]);
  }));

test("agents CLI lists the union as JSON or sanitised text and returns 69 if neither answers", () =>
  scenario(async ({ env, fx, repo }) => {
    const wt = join(fx.main, "bin/wt");
    const run = (args: string[]) => runWt(wt, args, { cwd: fx.main });
    assert.equal((await run(["agents", "--json"])).code, 69);
    const worker = setup(repo, { branch: "worker-tree" });
    const folder = join(worker.path, "café\u0085\n");
    const launchFolder = join(worker.path, "départ\u007f\t");
    mkdirSync(folder);
    mkdirSync(launchFolder);
    installFake(env, "hc", [
      hcList([terminal()]),
      get({ name: "worker\u001b", cwd: launchFolder, foreground: { cwd: folder } }),
    ]);
    installFake(env, "herdr", [herdrList([{ name: "old", agent_status: "idle", cwd: worker.path, pane_id: "w1:p1" }])]);
    const result = await run(["agents", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      {
        backend: "herdr",
        name: "old",
        address: null,
        pane: "w1:p1",
        status: "idle",
        location: worker.path,
        launchCwd: null,
      },
      {
        backend: "hc",
        name: "worker?",
        address: "t2",
        pane: null,
        status: "working",
        location: join(worker.path, "café"),
        launchCwd: join(worker.path, "départ"),
      },
    ]);
    const text = await run(["agents"]);
    assert.equal(text.code, 0, text.stderr);
    assert.equal(
      text.stdout,
      `herdr\told\tw1:p1\tidle\t${worker.path}\nhc\tworker?\tt2\tworking\t${worker.path}/caf?\n`,
    );
    const help = await run(["help"]);
    assert.match(help.stdout, /agent read <target>/);
    assert.match(help.stdout, /agent prompt <target>/);
  }, true));

test("agent read resolves herdr names and hc addresses, removes terminal sequences and preserves text", () =>
  scenario(async ({ env, fx, repo }) => {
    const worker = setup(repo, { branch: "worker-tree" });
    const screen =
      "\u001b[31mred\u001b[0m\u009b32mgreen\u009b0m\n\tü\r\b\u0085\u007f\u0000" +
      "\u001b]0;title\u0007\u009dhidden\u009c\u001bPpayload\u001b\\end\u001b]unfinished";
    installFake(env, "hc", [
      hcList([
        terminal({ cwd: worker.path }),
        terminal({ address: "devbox/t10", name: "remote-worker", cwd: worker.path }),
      ]),
      get({ foreground: { cwd: worker.path } }),
      { match: ["read"], stdout: screen },
    ]);
    installFake(env, "herdr", [
      herdrList([{ name: "old", cwd: worker.path }]),
      { match: ["agent", "read"], stdout: screen },
    ]);
    // Keep CLI output separate from the test reporter's own stdout, including across awaits.
    const read = (target: string, extra: string[] = []) =>
      runWt(join(fx.main, "bin/wt"), ["agent", "read", target, ...extra], { cwd: fx.main });
    for (const target of ["t2", "old"]) {
      const result = await read(target);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "redgreen\n\tüend");
    }
    assert.deepEqual(
      fakeCalls(env, "hc").filter((c) => c[0] === "read"),
      [["read", "--lines", "80", "t2"]],
    );
    assert.deepEqual(
      fakeCalls(env, "herdr").find((c) => c[1] === "read"),
      ["agent", "read", "old", "--source", "recent", "--lines", "80"],
    );
    for (const lines of ["1", "400"]) {
      const result = await read("t2", ["--lines", lines]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "redgreen\n\tüend");
      assert.deepEqual(fakeCalls(env, "hc").at(-1), ["read", "--lines", lines, "t2"]);
    }
    for (const lines of ["0", "401", "1.5", "-1", "NaN", "80x", ""]) {
      const result = await read("t2", [`--lines=${lines}`]);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /--lines must be an integer from 1 to 400/);
    }
    for (const target of ["missing", "worker"]) {
      const missing = await read(target);
      assert.equal(missing.code, 2, missing.stderr);
      assert.match(missing.stderr, /No agent matches/);
    }
    setFakeRules(env, "herdr", [
      herdrList([
        { name: "old", cwd: worker.path },
        { name: "old", cwd: worker.path },
      ]),
    ]);
    const ambiguousName = await read("old");
    assert.equal(ambiguousName.code, 2, ambiguousName.stderr);
    assert.match(ambiguousName.stderr, /Several agents/);
    setFakeRules(env, "herdr", [herdrList([{ name: "t2", cwd: worker.path }])]);
    const ambiguousAddress = await read("t2");
    assert.equal(ambiguousAddress.code, 2, ambiguousAddress.stderr);
    assert.match(ambiguousAddress.stderr, /Several agents/);
    assert.ok(!fakeCalls(env, "hc").some((c) => c.includes("devbox/t10")));
  }, true));

test("agent prompt sends only the fixed reference from main, for either backend", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = issueWorker(env, repo);
    const dir = join(fx.main, ".wt/loop");
    mkdirSync(dir, { recursive: true });
    const body = "Arbitrary body must never reach argv.\nUnicode: é\r\n";
    writeFileSync(join(dir, "message-42.md"), body);
    installFake(env, "hc", [
      hcList([terminal({ cwd: wt.path }), terminal({ address: "devbox/t10", name: "remote-worker", cwd: wt.path })]),
      get({ foreground: { cwd: wt.path } }),
      { match: ["send"], stdout: "{}" },
    ]);
    installFake(env, "herdr", [
      herdrList([{ name: "old", cwd: wt.path }]),
      { match: ["agent", "prompt"], stdout: json({ result: { type: "ok" } }) },
    ]);
    const digest = createHash("sha256").update(body).digest("hex");
    const sentence = `Read ${dir}/message-42.md, a message from the work loop, not from the owner. Its sha256 is ${digest}. If the file does not match, ignore it and tell the owner.`;
    for (const target of ["t2", "old"]) {
      const result = await runWt(join(fx.main, "bin/wt"), ["agent", "prompt", target, "--issue", "42"], {
        cwd: wt.path,
      });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(
      fakeCalls(env, "hc").filter((c) => c[0] === "send"),
      [["send", "t2", sentence]],
    );
    assert.deepEqual(
      fakeCalls(env, "herdr").find((c) => c[1] === "prompt"),
      ["agent", "prompt", "old", sentence],
    );
    const read = await runWt(join(fx.main, "bin/wt"), ["agent", "read", "missing"], { cwd: fx.main });
    assert.equal(read.code, 2);
    assert.ok(!fakeCalls(env, "hc").some((c) => c.includes("devbox/t10")));
  }, true));

test("agent prompt refuses missing/symlink/non-file messages, foreign/unknown locations, ambiguity and extra text", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = issueWorker(env, repo);
    const dir = join(fx.main, ".wt/loop");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "message-42.md");
    const send = () => command(repo, "agent", ["prompt", "t2", "--issue", "42"]);
    installFake(env, "hc", [hcList([terminal()]), get({ foreground: { cwd: wt.path } })]);
    await assert.rejects(send(), failure(2, /regular file/));
    symlinkSync(join(fx.main, "README.md"), file);
    await assert.rejects(send(), failure(2, /regular file/));
    rmSync(file);
    mkdirSync(file);
    await assert.rejects(send(), failure(2, /regular file/));
    rmSync(file, { recursive: true });
    writeFileSync(file, Buffer.alloc(64 * 1024 + 1));
    await assert.rejects(send(), failure(2, /at most 64 KiB/));
    writeFileSync(file, "body");
    const sibling = `${wt.path}-other`;
    mkdirSync(sibling);
    for (const location of [fx.main, sibling, null]) {
      setFakeRules(env, "hc", [
        hcList([terminal()]),
        get({ foreground: location === null ? null : { cwd: location }, cwd: null }),
      ]);
      await assert.rejects(send(), failure(2, /No agent matches.*registered worktrees/));
    }
    setFakeRules(env, "hc", [hcList([terminal()]), get({ foreground: { cwd: wt.path } })]);
    installFake(env, "herdr", [herdrList([{ name: "t2", cwd: wt.path }])]);
    await assert.rejects(send(), failure(2, /Several agents/));
    for (const args of [
      ["prompt", "worker", "--issue", "42", "free text"],
      ["prompt", "worker", "--text", "anything"],
      ["prompt", "worker", "--issue", "42;echo"],
      ["prompt", "worker"],
    ])
      await assert.rejects(command(repo, "agent", args), failure(2));
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "send"));
    assert.ok(!fakeCalls(env, "herdr").some((c) => c[1] === "prompt"));
  }));

test("hc prompt refuses editors and REPLs without a reported agent status", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = issueWorker(env, repo);
    mkdirSync(join(fx.main, ".wt/loop"), { recursive: true });
    writeFileSync(join(fx.main, ".wt/loop/message-42.md"), "Worker message.\n");
    for (const status of [null, undefined, {}, { state: null }, { state: "unknown" }, { state: "UNKNOWN" }]) {
      installFake(env, "hc", [
        hcList([terminal({ status: null })]),
        get({
          argv: ["/bin/sh"],
          pid: 10,
          cwd: wt.path,
          foreground: { cwd: wt.path, pid: 11, name: status === null ? "vim" : "node" },
          status,
        }),
        { match: ["send"], stdout: "{}" },
      ]);
      const result = await runWt(join(fx.main, "bin/wt"), ["agent", "prompt", "t2", "--issue", "42"], {
        cwd: fx.main,
      });
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /target shows no agent/);
      assert.equal(result.stdout, "");
      assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "send"));
    }
  }, true));

test("hc spawn CLI uses desktop terminal wording", () =>
  scenario(async ({ env, fx }) => {
    installFake(env, "hc", launchRules("blocked"));
    const result = await runWt(join(fx.main, "bin/wt"), ["spawn", "--brief", brief, "--slug", options.slug], {
      cwd: fx.main,
      env: { HC_TERMINAL_ID: "t2" },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /waiting for an answer in herdr desktop terminal wt-emend-task-001-add-thing \(t1m\)/);
  }, true));

test("required backend failures close the guard and agents command, while list remains optional", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = setup(repo, { branch: "availability-check" });
    // Neither executable is installed: cleanup outside a session retains its original behavior.
    assert.deepEqual(safetyGuard(repo, wt.branch), { ok: true });
    const cases: { caller?: "herdr" | "hc" | "both"; herdr: FakeRule; hc: FakeRule; unavailable?: string }[] = [
      { herdr: herdrList(), hc: { code: 124 }, unavailable: "herdr desktop (hc)" },
      { herdr: { code: 127 }, hc: { code: 1 }, unavailable: "herdr desktop (hc)" },
      { herdr: herdrList(), hc: { stdout: "not JSON" }, unavailable: "herdr desktop (hc)" },
      { herdr: herdrList(), hc: { stdout: "{}" }, unavailable: "herdr desktop (hc)" },
      ...["devbox/x10", "a/b/t1", "/t1", "devbox/"].map((address) => ({
        herdr: herdrList(),
        hc: hcList([terminal(), terminal({ address })]),
        unavailable: "herdr desktop (hc)",
      })),
      { caller: "herdr", herdr: { code: 1 }, hc: { code: 127 }, unavailable: "herdr" },
      { caller: "herdr", herdr: { stdout: '{"result":{"agents":[null]}}' }, hc: hcList(), unavailable: "herdr" },
      { caller: "hc", herdr: herdrList(), hc: { code: 127 }, unavailable: "herdr desktop (hc)" },
      { caller: "hc", herdr: herdrList(), hc: { code: 124 }, unavailable: "herdr desktop (hc)" },
      { caller: "hc", herdr: herdrList(), hc: { stdout: "not JSON" }, unavailable: "herdr desktop (hc)" },
      { caller: "herdr", herdr: herdrList(), hc: { code: 124 }, unavailable: "herdr desktop (hc)" },
      { caller: "herdr", herdr: herdrList(), hc: { stdout: "not JSON" }, unavailable: "herdr desktop (hc)" },
      { caller: "both", herdr: { code: 124 }, hc: hcList(), unavailable: "herdr" },
      { herdr: { code: 1 }, hc: hcList() },
    ];
    for (const row of cases) {
      delete process.env.HERDR_ENV;
      delete process.env.HC_TERMINAL_ID;
      const callerEnv: Record<string, string> = {};
      if (row.caller === "herdr" || row.caller === "both") callerEnv.HERDR_ENV = "1";
      if (row.caller === "hc" || row.caller === "both") callerEnv.HC_TERMINAL_ID = "t2";
      Object.assign(process.env, callerEnv);
      installFake(env, "herdr", [row.herdr]);
      installFake(env, "hc", [row.hc]);
      assert.deepEqual(
        safetyGuard(repo, wt.branch),
        row.unavailable ? { ok: false, failed: "agents-unavailable", detail: row.unavailable } : { ok: true },
      );
      assert.equal(list(repo)[0]?.agent, null);
      const result = await runWt(join(fx.main, "bin/wt"), ["agents", "--json"], { cwd: fx.main, env: callerEnv });
      if (row.unavailable) {
        assert.deepEqual(agentInventory().unavailable, [row.unavailable]);
        assert.equal(result.code, 69, result.stderr);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes(row.unavailable), result.stderr);
        assert.throws(
          () => cleanup(repo, { target: wt.branch, closeWorkspace: false, discard: false }),
          failure(1, /agents-unavailable/),
        );
        assert.ok(existsSync(wt.path));
      } else {
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), []);
      }
    }
    delete process.env.HERDR_ENV;
    delete process.env.HC_TERMINAL_ID;
    installFake(env, "hc", [{ code: 127 }]);
    assert.deepEqual(safetyGuard(repo, wt.branch), { ok: true }, "an unavailable optional herdr server is ignored");
  }, true));

test("own-agent exemptions never cross backends or apply with both or neither detected", () =>
  scenario(({ env, repo }) => {
    const wt = setup(repo, { branch: "own-terminal" });
    const linked = resolveRepo(wt.path);
    process.env.HC_TERMINAL_ID = "t2";
    process.env.HERDR_PANE_ID = "w1:p1";
    installFake(env, "herdr", [herdrList([{ name: "legacy", pane_id: "w1:p1", cwd: wt.path, status: "working" }])]);
    installFake(env, "hc", [hcList([terminal()]), get({ foreground: { cwd: wt.path } })]);
    assert.deepEqual(safetyGuard(linked, wt.branch), { ok: false, failed: "agent-active" });
    process.env.HERDR_ENV = "1";
    assert.deepEqual(safetyGuard(linked, wt.branch), { ok: false, failed: "agent-active" }, "both exempts nothing");
    setFakeRules(env, "herdr", [herdrList()]);
    assert.deepEqual(
      safetyGuard(linked, wt.branch),
      { ok: false, failed: "agent-active" },
      "both cannot exempt its hc terminal either",
    );
    setFakeRules(env, "herdr", [herdrList([{ name: "legacy", pane_id: "w1:p1", cwd: wt.path, status: "working" }])]);
    delete process.env.HC_TERMINAL_ID;
    assert.deepEqual(safetyGuard(linked, wt.branch), { ok: false, failed: "agent-active" }, "herdr cannot exempt hc");
    installFake(env, "hc", [hcList()]);
    for (const status of ["working", "blocked"]) {
      setFakeRules(env, "herdr", [herdrList([{ name: "legacy", pane_id: "w1:p1", cwd: wt.path, status }])]);
      assert.deepEqual(safetyGuard(linked, wt.branch), { ok: true }, `herdr exempts its own ${status} pane`);
    }
    setFakeRules(env, "herdr", [herdrList([{ name: "legacy", pane_id: "w1:p1", cwd: wt.path, status: "unknown" }])]);
    assert.deepEqual(safetyGuard(linked, wt.branch), { ok: true }, "herdr exempts its own non-working pane");
    delete process.env.HERDR_ENV;
    assert.deepEqual(safetyGuard(linked, wt.branch), { ok: false, failed: "agent-active" }, "none exempts nothing");
  }));

test("hc guard considers null statuses and launch folders and distinguishes idle shells from foreground programs", () =>
  scenario(({ env, repo }) => {
    const wt = setup(repo, { branch: "terminal-processes" });
    const cases: [Record<string, unknown>, boolean][] = [
      [
        { argv: ["/usr/bin/claude"], pid: 10, status: null, cwd: wt.path, foreground: { cwd: wt.path, pid: 10 } },
        false,
      ],
      [{ cwd: wt.path, foreground: { cwd: "/elsewhere" }, status: { state: "working" } }, false],
      [{ cwd: wt.path, foreground: null, status: null }, false],
      [
        { argv: ["/bin/zsh"], pid: 10, status: null, cwd: wt.path, foreground: { cwd: wt.path, pid: 10, name: "zsh" } },
        true,
      ],
      [{ argv: ["/bin/zsh"], pid: 10, status: null, cwd: "/elsewhere", foreground: { cwd: wt.path, pid: 11 } }, false],
    ];
    for (const [info, allowed] of cases) {
      installFake(env, "hc", [hcList([terminal({ status: null })]), get(info)]);
      assert.deepEqual(safetyGuard(repo, wt.branch), allowed ? { ok: true } : { ok: false, failed: "agent-active" });
    }
    installFake(env, "hc", [hcList([terminal({ cwd: wt.path })]), { match: ["get"], code: 124 }]);
    const agent = locatedAgents()?.[0];
    assert.equal(agent?.location, null);
    assert.equal(agent?.launchCwd, null);
    assert.deepEqual(safetyGuard(repo, wt.branch), { ok: false, failed: "agent-unknown", detail: "worker" });
  }));

test("hc idle shells require a shell in the foreground and never hide working or blocked agents", () =>
  scenario(({ env, repo }) => {
    const wt = setup(repo, { branch: "exec-shell" });
    const cases: { foreground: Record<string, unknown>; status: unknown; idleShell: boolean }[] = [
      { foreground: { name: "claude" }, status: { state: "working" }, idleShell: false },
      { foreground: { name: "claude" }, status: null, idleShell: false },
      { foreground: { name: "sh" }, status: { state: "working" }, idleShell: false },
      { foreground: { name: "sh" }, status: { state: "blocked" }, idleShell: false },
      { foreground: { name: "sh" }, status: null, idleShell: true },
      { foreground: { argv: ["/bin/sh"] }, status: null, idleShell: true },
      { foreground: { argv: ["/usr/bin/claude"] }, status: null, idleShell: false },
      { foreground: { name: "claude", argv: ["/bin/sh"] }, status: null, idleShell: false },
      { foreground: {}, status: null, idleShell: false },
    ];
    for (const row of cases) {
      installFake(env, "hc", [
        hcList([terminal({ status: null })]),
        get({
          argv: ["/bin/sh", "-c", "cd X && claude"],
          pid: 10,
          cwd: wt.path,
          foreground: { pid: 10, cwd: wt.path, ...row.foreground },
          status: row.status,
        }),
      ]);
      assert.equal(locatedAgents()?.[0]?.idleShell, row.idleShell, json(row));
      assert.deepEqual(
        safetyGuard(repo, wt.branch),
        row.idleShell ? { ok: true } : { ok: false, failed: "agent-active" },
        json(row),
      );
    }
  }));

test("agents and read are scoped to registered live or launch folders; hc names and herdr panes are not targets", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = setup(repo, { branch: "scope-check" });
    installFake(env, "hc", [
      hcList([terminal(), terminal({ address: "t3", name: "foreign" })]),
      get({ cwd: wt.path, foreground: { cwd: "/outside" } }),
      get({ name: "foreign", cwd: `${wt.path}-other`, foreground: { cwd: "/outside" } }, "t3"),
      { match: ["read"], stdout: "worker output\n" },
    ]);
    installFake(env, "herdr", [
      herdrList([
        { name: "old", pane_id: "w1:p1", cwd: wt.path },
        { name: "foreign-old", pane_id: "w2:p1", cwd: "/outside" },
      ]),
      { match: ["agent", "read"], stdout: "old output\n" },
    ]);
    const run = (args: string[]) => runWt(join(fx.main, "bin/wt"), args, { cwd: fx.main });
    const listed = await run(["agents", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout);
    assert.deepEqual(
      rows.map((a: { name: string }) => a.name),
      ["old", "worker"],
    );
    assert.equal(rows[1].location, "/outside");
    assert.equal(rows[1].launchCwd, wt.path);
    for (const target of ["t3", "foreign-old", "worker", "w1:p1"]) {
      const result = await run(["agent", "read", target]);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "");
    }
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "read"));
    assert.ok(!fakeCalls(env, "herdr").some((c) => c[1] === "read"));
    assert.equal((await run(["agent", "read", "t2"])).stdout, "worker output\n");
    assert.equal((await run(["agent", "read", "old"])).stdout, "old output\n");
  }, true));

test("read and prompt refuse an hc address shadowed by an unrelated idle shell name", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = issueWorker(env, repo);
    mkdirSync(join(fx.main, ".wt/loop"), { recursive: true });
    writeFileSync(join(fx.main, ".wt/loop/message-42.md"), "hello");
    installFake(env, "hc", [
      hcList([terminal(), terminal({ address: "t3", name: "t2", status: null })]),
      get({ cwd: wt.path, foreground: { cwd: wt.path } }),
      get(
        {
          name: "t2",
          cwd: "/outside",
          status: null,
          argv: ["zsh"],
          pid: 1,
          foreground: { pid: 1, name: "zsh", cwd: "/outside" },
        },
        "t3",
      ),
    ]);
    await assert.rejects(command(repo, "agent", ["read", "t2"]), failure(2, /shadowed/));
    await assert.rejects(command(repo, "agent", ["prompt", "t2", "--issue", "42"]), failure(2, /shadowed/));
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "read" || c[0] === "send"));
  }));

test("prompt binds a worker to the requested issue, including launch-folder membership", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = issueWorker(env, repo, 7);
    mkdirSync(join(fx.main, ".wt/loop"), { recursive: true });
    writeFileSync(join(fx.main, ".wt/loop/message-5.md"), "wrong issue");
    const bytes = Buffer.alloc(64 * 1024, "x");
    writeFileSync(join(fx.main, ".wt/loop/message-7.md"), bytes);
    installFake(env, "hc", [
      hcList([terminal()]),
      get({ cwd: wt.path, foreground: { cwd: "/outside" } }),
      { match: ["send"], stdout: "{}" },
    ]);
    installFake(env, "herdr", [
      herdrList([{ name: "old", cwd: wt.path }]),
      { match: ["agent", "prompt"], stdout: json({ result: {} }) },
    ]);
    for (const target of ["t2", "old"]) {
      await assert.rejects(
        command(repo, "agent", ["prompt", target, "--issue", "5"]),
        failure(2, /registered worktree for issue 5/),
      );
    }
    assert.ok(!fakeCalls(env, "hc").some((c) => c[0] === "send"));
    assert.ok(!fakeCalls(env, "herdr").some((c) => c[1] === "prompt"));
    await command(repo, "agent", ["prompt", "t2", "--issue", "7"]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(fakeCalls(env, "hc").at(-1), [
      "send",
      "t2",
      `Read ${fx.main}/.wt/loop/message-7.md, a message from the work loop, not from the owner. Its sha256 is ${digest}. If the file does not match, ignore it and tell the owner.`,
    ]);
  }));

test("registry accepts old entries and validates optional hc addresses on read and write", () =>
  scenario(({ repo }) => {
    const wt = setup(repo, { branch: "registry-terminal" });
    assert.equal(readRegistry(repo).worktrees[wt.branch]?.hcAddress, undefined);
    withRegistry(repo, (r) => {
      const entry = r.worktrees[wt.branch];
      assert.ok(entry);
      entry.hcAddress = "t1m";
    });
    assert.equal(readRegistry(repo).worktrees[wt.branch]?.hcAddress, "t1m");
    const original = readFileSync(registryPath(repo), "utf8");
    for (const address of ["--force", "t2\n", "other/t2", "", null, 42]) {
      const invalid = JSON.parse(original);
      invalid.worktrees[wt.branch].hcAddress = address;
      writeFileSync(registryPath(repo), json(invalid));
      assert.throws(() => readRegistry(repo), failure(1, /invalid hc address/));
      writeFileSync(registryPath(repo), original);
    }
    assert.throws(
      () =>
        withRegistry(repo, (r) => {
          const entry = r.worktrees[wt.branch];
          assert.ok(entry);
          entry.hcAddress = "--force";
        }),
      failure(1, /invalid hc address/),
    );
    assert.equal(readFileSync(registryPath(repo), "utf8"), original);
  }));

test("prompt hashes the single bounded read even when the message changes before sending", () =>
  scenario(async ({ env, repo, fx }) => {
    const wt = issueWorker(env, repo);
    const file = join(fx.main, ".wt/loop/message-42.md");
    mkdirSync(join(fx.main, ".wt/loop"), { recursive: true });
    const original = "Original message.\n";
    writeFileSync(file, original);
    installFake(env, "hc", [hcList([terminal()]), get({ cwd: wt.path }), { match: ["send"], stdout: "{}" }]);
    // Only the fake CLI changes this synthetic file, after the command's message read.
    const binary = join(env.fakeBin, "hc");
    const source = readFileSync(binary, "utf8");
    const headerEnd = source.indexOf("\n") + 1;
    writeFileSync(
      binary,
      `${source.slice(0, headerEnd)}if (process.argv[2] === "ls") require("node:fs").writeFileSync(${JSON.stringify(file)}, "Replacement message.");\n${source.slice(headerEnd)}`,
    );
    await command(repo, "agent", ["prompt", "t2", "--issue", "42"]);
    assert.equal(readFileSync(file, "utf8"), "Replacement message.");
    assert.deepEqual(fakeCalls(env, "hc").at(-1), [
      "send",
      "t2",
      `Read ${file}, a message from the work loop, not from the owner. Its sha256 is ${createHash("sha256").update(original).digest("hex")}. If the file does not match, ignore it and tell the owner.`,
    ]);
  }));

test("hc spawn refuses a missing executable before setup and never launches a template", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    rmSync(join(env.fakeBin, "claude"));
    installFake(env, "hc", launchRules());
    await assert.rejects(spawn(repo, options, fakeClock()), failure(69, /Claude is unavailable.*Nothing was created/));
    assert.deepEqual(readRegistry(repo).worktrees, {});
    assert.deepEqual(readRegistry(repo).reservations, {});
    assert.deepEqual(fakeCalls(env, "hc"), [["ls", "--json"]]);
  }));

test("hc spawn resolves the first executable regular claude on PATH, skipping files and directories", () =>
  scenario(async ({ env, repo }) => {
    process.env.HC_TERMINAL_ID = "t2";
    const dirs = ["not-executable", "directory", "first", "second"].map((name) => join(env.root, name));
    for (const dir of dirs) mkdirSync(dir);
    writeFileSync(join(dirs[0] as string, "claude"), "not executable", { mode: 0o644 });
    mkdirSync(join(dirs[1] as string, "claude"));
    for (const dir of dirs.slice(2)) {
      writeFileSync(join(dir, "claude"), "#!/bin/sh\nexit 99\n");
      chmodSync(join(dir, "claude"), 0o755);
    }
    process.env.PATH = [...dirs, env.fakeBin].join(delimiter);
    installFake(env, "hc", launchRules());
    await spawn(repo, options, fakeClock());
    const call = fakeCalls(env, "hc").find((c) => c[0] === "run");
    assert.ok(call);
    assert.equal(call[call.indexOf("--") + 1], join(dirs[2] as string, "claude"));
  }));
