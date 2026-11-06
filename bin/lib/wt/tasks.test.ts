import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { readRegistry, withRegistry } from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import { formatTasks, nextTaskNumber, releaseReservation, reserveTask, scanTasks } from "./tasks.ts";
import { commitFile, type Fixture, gitIn, makeFixture, makeTestEnv, runWt, type TestEnv } from "./test-support.ts";
import { WtError } from "./validate.ts";
import { setup } from "./worktree.ts";

async function scenario(fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>): Promise<void> {
  const env = makeTestEnv();
  try {
    const fx = makeFixture(env);
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    env.cleanup();
  }
}

function taskText(n: string, status = "open", title = `Task ${n}`): string {
  return `---\nid: ${n}\ntitle: ${title}\nstatus: ${status}\nowner: agent\ndepends_on: [001, 002]\n---\n\n# ${n}\n`;
}

function writeTask(dir: string, n: string, status = "open"): void {
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "tasks", `${n}-thing.md`), taskText(n, status));
}

function expectCode(fn: () => unknown, code: number): void {
  assert.throws(fn, (e: unknown) => e instanceof WtError && e.code === code, `expected exit ${code}`);
}

test("next number spans all sources", () =>
  scenario(({ repo, fx }) => {
    // 010 on origin/main
    commitFile(fx.main, "tasks/010-a.md", taskText("010"));
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    // 011 on local main only
    commitFile(fx.main, "tasks/011-b.md", taskText("011"));
    // 013 in a worktree (uncommitted)
    const w = setup(repo, { branch: "feat-w", busy: new Set() });
    writeTask(w.path, "013");
    // 012 reserved
    withRegistry(repo, (r) => {
      r.reservations["012"] = { branch: "012-x-y", slug: "x-y", reservedAt: new Date().toISOString() };
    });
    assert.equal(
      withRegistry(repo, (r) => nextTaskNumber(repo, r)),
      "014",
    );
  }));

test("untracked and branch-only task files count", () =>
  scenario(({ repo, fx }) => {
    commitFile(fx.main, "tasks/010-a.md", taskText("010"));
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    // 012 committed only on a local branch that has no worktree
    gitIn(fx.main, "checkout", "--quiet", "-b", "side");
    commitFile(fx.main, "tasks/012-side.md", taskText("012"));
    gitIn(fx.main, "checkout", "--quiet", "main");
    // 011 untracked in the main checkout
    writeTask(fx.main, "011");
    const rows = scanTasks(repo);
    assert.deepEqual(
      rows.map((r) => [r.number, r.where]),
      [
        ["010", "origin/main"],
        ["011", "main"],
        ["012", "side"],
      ],
    );
    assert.equal(
      withRegistry(repo, (r) => nextTaskNumber(repo, r)),
      "013",
    );
  }));

test("parallel reservations are distinct", () =>
  scenario(async ({ repo, fx }) => {
    const here = pathToFileURL(import.meta.dirname).href;
    const code = `
      import { reserveTask } from "${here}/tasks.ts";
      import { resolveRepo } from "${here}/repo.ts";
      const repo = resolveRepo(process.argv[1]);
      process.stdout.write(reserveTask(repo, process.argv[2], process.argv[3]));`;
    const args = (slug: string, branch: string) => ["--input-type=module", "-e", code, fx.main, slug, branch];
    const [a, b] = await Promise.all([
      runWt(process.execPath, args("alpha-one", "001-alpha-one"), { cwd: fx.main }),
      runWt(process.execPath, args("beta-two", "002-beta-two"), { cwd: fx.main }),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.notEqual(a.stdout, b.stdout);
    const numbers = Object.keys(readRegistry(repo).reservations).sort();
    assert.deepEqual(numbers, [a.stdout, b.stdout].sort());
  }));

test("reserve records slug and branch; release drops it; bad input exits 2", () =>
  scenario(({ repo }) => {
    const n = reserveTask(repo, "add-thing", "001-add-thing");
    assert.equal(n, "001");
    const res = readRegistry(repo).reservations[n];
    assert.equal(res?.branch, "001-add-thing");
    assert.equal(res?.slug, "add-thing");
    assert.equal(reserveTask(repo, "second-thing", "002-second-thing"), "002");
    releaseReservation(repo, "001");
    assert.deepEqual(Object.keys(readRegistry(repo).reservations), ["002"]);
    releaseReservation(repo, "001"); // not an error
    expectCode(() => reserveTask(repo, "Bad Slug", "x-y"), 2);
    expectCode(() => reserveTask(repo, "ok-slug", "main"), 2);
    expectCode(() => releaseReservation(repo, "1"), 2);
  }));

test("range end refuses", () =>
  scenario(({ repo, fx }) => {
    writeTask(fx.main, "098");
    expectCode(() => withRegistry(repo, (r) => nextTaskNumber(repo, r)), 69);
    expectCode(() => reserveTask(repo, "last-one", "last-one"), 69);
    assert.deepEqual(readRegistry(repo).reservations, {});
  }));

test("tasks shows the furthest source", () =>
  scenario(({ repo, fx }) => {
    commitFile(fx.main, "tasks/011-thing.md", taskText("011", "open"));
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const w = setup(repo, { branch: "feat-w", busy: new Set() });
    writeFileSync(join(w.path, "tasks", "011-thing.md"), taskText("011", "in-progress"));
    const rows = scanTasks(repo);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "in-progress");
    assert.equal(rows[0]?.where, "feat-w");
    assert.deepEqual(rows[0]?.dependsOn, ["001", "002"]);
    assert.match(formatTasks(rows), /^# +STATUS +OWNER +TITLE +WHERE/);
  }));

for (const branch of ["011-thing", "emend-011-thing", "emend-task-011-thing"]) {
  test(`tasks maps the in-progress task from ${branch} to the unprefixed task file`, () =>
    scenario(({ env, repo, fx }) => {
      commitFile(fx.main, "tasks/011-thing.md", taskText("011", "open"));
      gitIn(fx.main, "push", "--quiet", "origin", "main");
      let path: string;
      if (branch === "emend-011-thing") {
        assert.throws(
          () => setup(repo, { branch }),
          (e: unknown) => e instanceof WtError && e.code === 2 && /require --issue/.test(e.message),
        );
        // Preserve coverage of pre-existing numeric task worktrees without allowing setup to create them.
        path = join(env.root, "legacy-task");
        gitIn(fx.main, "worktree", "add", "--quiet", "-b", branch, path, "main");
      } else path = setup(repo, { branch }).path;
      writeFileSync(join(path, "tasks/011-thing.md"), taskText("011", "in-progress"));
      const [row] = scanTasks(repo);
      assert.equal(row?.number, "011");
      assert.equal(row?.file, "011-thing.md");
      assert.equal(row?.where, branch);
      assert.equal(row?.status, "in-progress");
      assert.equal(
        withRegistry(repo, (r) => nextTaskNumber(repo, r)),
        "012",
      );
    }));
}

test("task text is stripped of control characters", () =>
  scenario(({ repo, fx }) => {
    mkdirSync(join(fx.main, "tasks"), { recursive: true });
    writeFileSync(join(fx.main, "tasks", "005-x.md"), "---\ntitle: bad \u001b[31mred\u0007 title\nstatus: open\n---\n");
    const row = scanTasks(repo)[0];
    assert.ok(row);
    assert.doesNotMatch(row.title, /\p{Cc}/u);
  }));

test("task text and branch names are stripped of C1 control characters too", () =>
  scenario(({ repo, fx }) => {
    mkdirSync(join(fx.main, "tasks"), { recursive: true });
    writeFileSync(join(fx.main, "tasks", "006-x.md"), "---\ntitle: a\u0085b\u009bc\u007fd\nstatus: o\u0080k\n---\n");
    gitIn(fx.main, "branch", "odd\u0085name");
    commitFile(fx.main, "tasks/007-y.md", taskText("007"));
    const rows = scanTasks(repo);
    for (const row of rows) {
      assert.doesNotMatch(`${row.title}${row.status}${row.owner}${row.where}`, /\p{Cc}/u);
    }
    assert.doesNotMatch(formatTasks(rows), /[^\P{Cc}\n]/u);
  }));

test("a tasks directory that is a symlink is skipped and said so on stderr", () =>
  scenario(({ repo, fx, env }) => {
    const w = setup(repo, { branch: "feat-link", busy: new Set() });
    const outside = join(env.root, "outside-tasks");
    mkdirSync(outside);
    writeFileSync(join(outside, "042-secret.md"), taskText("042", "open", "SECRET-OUTSIDE"));
    rmSync(join(w.path, "tasks"), { recursive: true, force: true });
    symlinkSync(outside, join(w.path, "tasks"));
    writeTask(fx.main, "003");
    const seen: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      seen.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let rows: ReturnType<typeof scanTasks>;
    try {
      rows = scanTasks(repo);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(
      rows.map((r) => r.number),
      ["003"],
    );
    assert.match(seen.join(""), /Skipped a tasks directory that is, or lies behind, a symlink \(feat-link\)/);
  }));

test("a task file that is a symlink is skipped", () =>
  scenario(({ repo, fx, env }) => {
    writeTask(fx.main, "004");
    const outside = join(env.root, "outside-task.md");
    writeFileSync(outside, taskText("005", "open", "SECRET-OUTSIDE"));
    symlinkSync(outside, join(fx.main, "tasks", "005-link.md"));
    const rows = scanTasks(repo);
    assert.equal(
      rows.some((r) => r.title === "SECRET-OUTSIDE"),
      false,
    );
    assert.equal(
      rows.some((r) => r.number === "004"),
      true,
    );
  }));

test("a stale checkout does not beat a newer origin/main version, and is listed as stale", () =>
  scenario(({ repo, fx }) => {
    commitFile(fx.main, "tasks/020-thing.md", taskText("020", "in-progress"));
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    // a worktree made while the task was in progress
    const old = setup(repo, { branch: "feat-old", busy: new Set() });
    // origin/main moves the status forward
    commitFile(fx.main, "tasks/020-thing.md", taskText("020", "done"));
    gitIn(fx.main, "push", "--quiet", "origin", "main");
    const row = scanTasks(repo).find((r) => r.number === "020");
    assert.equal(row?.status, "done", "the old branch and working tree must not win");
    assert.equal(row?.where.startsWith("origin/main"), true);
    assert.match(row?.where ?? "", /feat-old \(stale\)/);
    assert.deepEqual(row?.stale, ["feat-old"]);
    assert.match(formatTasks(scanTasks(repo)), /feat-old \(stale\)/);

    // genuinely new work in that worktree (a text origin/main never held) still wins
    writeFileSync(join(old.path, "tasks", "020-thing.md"), taskText("020", "blocked"));
    const fresh = scanTasks(repo).find((r) => r.number === "020");
    assert.equal(fresh?.status, "blocked");
    assert.equal(fresh?.where.startsWith("feat-old"), true);
  }));

test("two files with one number print one row each and mark the later ones", () =>
  scenario(({ repo, fx }) => {
    mkdirSync(join(fx.main, "tasks"), { recursive: true });
    writeFileSync(join(fx.main, "tasks", "008-a.md"), taskText("008", "open", "First"));
    writeFileSync(join(fx.main, "tasks", "008-b.md"), taskText("008", "open", "Second"));
    const rows = scanTasks(repo).filter((r) => r.number === "008");
    assert.deepEqual(
      rows.map((r) => [r.file, r.title, r.duplicate]),
      [
        ["008-a.md", "First", false],
        ["008-b.md", "Second", true],
      ],
    );
    assert.match(formatTasks(rows), /\(duplicate\)/);
  }));
