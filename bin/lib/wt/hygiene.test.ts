import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");

const SKILLS = [
  "e-spawn",
  "e-triage",
  "e-fix",
  "e-work",
  "e-pr",
  "e-pr-finalize",
  "e-pr-merge",
  "e-rebase",
  "e-merge-local",
  "e-issue",
  "e-outside",
  "e-loop",
  "e-groom",
];

// Built from parts so this file does not match its own patterns.
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: "home directory path", pattern: new RegExp(["/ho", "me/"].join("")) },
  { label: "user directory path", pattern: new RegExp(["/Us", "ers/"].join("")) },
  { label: "tailnet host name", pattern: new RegExp(["\\.ts", "\\.net"].join("")) },
  { label: "co-author trailer", pattern: new RegExp(["co-auth", "ored-by"].join(""), "i") },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function lifecycleFiles(): string[] {
  const files = walk(join(root, "bin"));
  files.push(join(root, ".claude", "loop.md"));
  const skillsDir = join(root, ".claude", "skills");
  for (const name of readdirSync(skillsDir)) {
    if (name.startsWith("e-")) walk(join(skillsDir, name), files);
  }
  return files;
}

test("lifecycle files carry no private paths", () => {
  const hits: string[] = [];
  for (const file of lifecycleFiles()) {
    const text = readFileSync(file, "utf8");
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(text)) hits.push(`${file.slice(root.length + 1)}: ${label}`);
    }
  }
  assert.deepEqual(hits, []);
});

// Placeholder names that may follow a home directory prefix.
const HOME_PLACEHOLDERS = ["someone", "user", "runner"];

test("no file in the repo contains a real home path", () => {
  // Built from parts so this file does not match its own pattern.
  const homePath = new RegExp(["/(?:ho", "me|Us", "ers)/([^/\\s]+)/"].join(""), "g");
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const hits: string[] = [];
  for (const rel of listed.split("\0")) {
    if (rel === "") continue;
    const path = join(root, rel);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8192).includes(0)) continue;
    buffer
      .toString("utf8")
      .split("\n")
      .forEach((line, index) => {
        for (const match of line.matchAll(homePath)) {
          if (!HOME_PLACEHOLDERS.includes(match[1] ?? "")) {
            hits.push(`${rel}:${index + 1}`);
            break;
          }
        }
      });
  }
  assert.deepEqual(hits, []);
});

test("tracked agent instructions use bin/findings for registry commands", () => {
  const paths = [".claude/", "AGENTS.md", ":(exclude).claude/worktrees/**"];
  const files = execFileSync("git", ["ls-files", "-z", "--", ...paths], { cwd: root, encoding: "utf8" });
  const oldCommand = /bin\/wt\s+(?:findings\b|groom\b|spawn\s+--findings\b)/;
  for (const path of files.split("\0").filter(Boolean)) {
    assert.doesNotMatch(readFileSync(join(root, path), "utf8"), oldCommand, path);
  }
});

test("every lifecycle skill exists with a matching name and a description", () => {
  for (const name of SKILLS) {
    const text = readFileSync(join(root, ".claude", "skills", name, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(match?.[1], `${name}: frontmatter missing`);
    const front = match[1];
    assert.match(front, new RegExp(`^name: ${name}$`, "m"), `${name}: name mismatch`);
    assert.match(front, /^description: \S/m, `${name}: description missing`);
  }
});

function fixerBuildItem(): string {
  const skill = readFileSync(join(root, ".claude/skills/e-work/SKILL.md"), "utf8");
  const build = skill.split("## 2. Build\n")[1] ?? "";
  const item = /^1\. [\s\S]*?(?=^2\. )/m.exec(build);
  assert.ok(item, "missing e-work build item 1");
  return item[0];
}

test("e-fix selects approved findings by priority and counts those waiting for triage", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-fix/SKILL.md"), "utf8");
  assert.match(skill, /bin\/findings list --state open --triage approved --json/);
  assert.match(skill, /priority: \.approval\.priority/);
  assert.match(skill, /sort_by\(\.priority, \.createdAt, \.id\)/);
  assert.match(skill, /bin\/findings list --state open --triage untriaged --json/);
});

test("e-triage validates the heading, checks before approve or skip and republishes only after a change", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-triage/SKILL.md"), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.ok(skill.includes("^f-[0-9a-f]{12}$"));
  assert.ok(skill.includes("^e-triage-[0-9a-f]{12}$"));
  assert.ok(skill.includes(`recense publish '<main>/.wt/triage.md' --title "Findings triage" --key <key>`));
  assert.ok(skill.includes("targets the `### <id>` heading itself"));
  const otherTarget = skill.indexOf("For any other target, answer the comment");
  assert.ok(otherTarget >= 0);
  assert.ok(skill.indexOf("For a comment on the security count, reply `explained`") > otherTarget);
  assert.ok(skill.indexOf("Put nothing about security findings in a reply but the page's count.") > otherTarget);
  assert.ok(skill.indexOf("Never read security findings to answer a comment.") > otherTarget);
  const mode = skill.indexOf("read the hand-off's `mode` first");
  const explain = skill.indexOf("In `explain`, change nothing in the registry");
  const show = skill.indexOf("<main>/bin/findings show <id>");
  assert.ok(mode >= 0 && mode < explain && explain < show);
  assert.ok(skill.includes("still `open` and has no approval"));
  assert.ok(skill.includes("a literal priority from `P0`, `P1`, `P2`"));
  const commands = [...skill.matchAll(/<main>\/bin\/findings ([^`\n]+)/g)].map((match) => match[1]);
  assert.deepEqual(commands, ["page", "show <id>", "approve <id> --priority <P>", "skip <id>", "page"]);
  assert.ok(skill.includes("After the replies, run `<main>/bin/findings page`"));
  assert.ok(skill.includes("Republish only if this delivery recorded at least one approve or skip"));
  assert.ok(skill.includes("and the returned `findings` list is non-empty"));
  assert.ok(skill.includes("Otherwise keep the published page and its ids.\nWait again"));
});

test("e-pr-merge reports FIXED lines and checks the registered ids and worktree for manual recovery", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-pr-merge/SKILL.md"), "utf8");
  const recovery = skill.split("## 8. After the merge")[1] ?? "";
  assert.ok(recovery.includes("with a merge warning or `QUEUED`, run `<main>/bin/wt list --json`"));
  assert.ok(recovery.includes("row whose `branch` equals the PR's head branch"));
  assert.ok(recovery.includes("row or its `findings` list is missing, report that and give no resolve command"));
  assert.ok(recovery.includes("For each id in that row's `findings` list, run `<main>/bin/findings show <id>`"));
  assert.ok(recovery.includes("`claim.branch` equals the head branch and `claim.worktree` equals the row's `path`"));
  assert.ok(!recovery.includes("bin/findings list --state claimed"));
  const manual = skill.split("\n").filter((line) => line.includes("--fixed"));
  assert.equal(manual.length, 1);
  assert.match(manual[0] ?? "", /the owner runs `<main>\/bin\/findings resolve <id> --fixed <merge commit>`/);
  assert.ok(skill.includes("report the findings named in the merge's `FIXED <id>` lines"));
});

test("e-work reads each claim before its first resolve in build item 1", () => {
  const item = fixerBuildItem();
  const show = item.indexOf("<main>/bin/findings show <id>");
  const firstResolve = item.indexOf("<main>/bin/findings resolve");
  assert.ok(show >= 0 && show < firstResolve);
});

test("e-work records a security finding before dismissing the original", () => {
  const bullet = /^ {3}- [^\n]*security problem.*(?:\n {5}.*)*/m.exec(fixerBuildItem());
  assert.ok(bullet, "missing security bullet");
  assert.match(bullet[0], /Use the `path` and `line` of the problem at this worktree's `HEAD`/);
  const add = bullet[0].indexOf("<main>/bin/findings add --file");
  const dismiss = bullet[0].indexOf("--dismissed");
  assert.ok(add >= 0 && add < dismiss);
});

test("e-work and e-pr use the same private security dismissal reason", () => {
  for (const name of ["e-work", "e-pr"]) {
    const skill = readFileSync(join(root, ".claude", "skills", name, "SKILL.md"), "utf8");
    assert.ok(skill.includes("needs a private security report"), name);
  }
});

test("e-work and e-pr count released findings as not fixed unless stale or dismissed", () => {
  const rule = "A finding this branch no longer holds, other than a stale or dismissed one, is not fixed.";
  for (const name of ["e-work", "e-pr"]) {
    const skill = readFileSync(join(root, ".claude", "skills", name, "SKILL.md"), "utf8");
    assert.ok(skill.includes(rule), name);
    assert.doesNotMatch(skill, /stale, dismissed or open|For any other state or claim/, name);
  }
});

test("e-pr omits every dismissed finding from PR text", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-pr/SKILL.md"), "utf8");
  assert.ok(skill.includes("Omit every dismissed finding from all PR text."));
  assert.doesNotMatch(skill, /Use `stale` or `dismissed`/);
});

test("the merge skill checks the approved review for late feedback before restarting the gates", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-pr-merge/SKILL.md"), "utf8");
  const readiness = skill.slice(skill.indexOf("## 2. Readiness"), skill.indexOf("## 3. The approval"));
  const approval = readiness.indexOf("<main>/bin/wt approval --head <head>");
  const take = readiness.indexOf('In the PR\'s worktree, run "Take pending feedback"');
  const restart = readiness.indexOf("Then restart at step 1");
  assert.ok(approval >= 0 && approval < take && take < restart);
  assert.match(readiness.slice(take, restart), /In the main checkout, skip that procedure\.[^\n]*question in step 3/);
  const lookup = readiness.slice(approval, take);
  assert.match(lookup, /In the main checkout, run `<main>\/bin\/wt approval --branch <headRefName> --head <head>`/);
  assert.match(lookup, /retained approved head/);
  const exitOne = lookup
    .slice(lookup.indexOf("- On exit 1,"), lookup.indexOf("- On exit 2 or 69,"))
    .replace(/\s+/g, " ");
  assert.match(
    exitOne,
    /if `\/e-pr-finalize` invoked this skill or this is the 4\.4\.5 rerun, run `<main>\/bin\/wt notify blocked`, report that no approval is on record, and stop\./,
  );
  assert.match(exitOne, /A later run restarts at step 1/);
  assert.match(
    exitOne,
    /Otherwise the owner typed the command\. Follow step 6 to ask for approval in recense and stop\./,
  );
  assert.doesNotMatch(exitOne, /before the settle window/);
  assert.match(lookup, /exit 2 or 69[^\n]*notify blocked[^\n]*stop/i);
  assert.match(lookup, /approved <sha> review <id> revision <n>/);
});

test("the merge skill asks the owner in main and takes pending feedback only in the PR's worktree", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-pr-merge/SKILL.md"), "utf8");
  const gate = skill.slice(skill.indexOf("## 3. The approval"), skill.indexOf("### Take pending feedback"));
  assert.match(gate, /In the main checkout, run `<main>\/bin\/wt approval --branch <headRefName> --head <headRefOid>`/);
  const approved = gate.slice(gate.indexOf("- Exit 0:"), gate.indexOf("- Exit 1:"));
  assert.match(approved, /keep the approved head[^\n]*review id/);
  assert.match(approved, /In the PR's worktree, run "Take pending feedback" with that id before going on/);
  const mainCheckout = approved.slice(approved.indexOf("In the main checkout,"));
  assert.match(
    mainCheckout,
    /show the owner the approved head and review id[\s\S]*notify question`, then ask the owner once/,
  );
  assert.match(
    mainCheckout,
    /"Merge PR #[^\n]*later Go\?"\n\s*- `Merge`[^\n]*step 4[^\n]*`--pr <n>` in step 7\.\n\s*- `Stop` — stop here\./,
  );
  assert.doesNotMatch(mainCheckout, /Take pending feedback|recense feedback/);

  const procedure = skill.slice(skill.indexOf("### Take pending feedback"), skill.indexOf("## 4. Behind main"));
  assert.match(procedure, /Run this procedure only in the PR's worktree/);
  assert.match(procedure, /A main-checkout run never takes or saves feedback/);
  const tracked = procedure.indexOf("git ls-files -- .wt");
  const saved = procedure.indexOf("List saved results");
  const fetch = procedure.indexOf('recense feedback <review-id> --save "<folder>"');
  assert.ok(tracked >= 0 && tracked < saved && saved < fetch);
  assert.match(procedure.slice(tracked, saved), /Read the hand-off[\s\S]*notify blocked[^\n]*stop/);
  const savedResults = procedure.slice(saved, fetch);
  assert.match(savedResults, /Delete each saved `pending` file and continue checking saved results/);
  assert.match(
    savedResults,
    /saved `go`, `approve` or `closed` whose `deliveryId` is absent from `handled.txt`[^\n]*\/e-pr-finalize[^\n]*stop/,
  );
  const result = procedure.slice(fetch);
  assert.match(result, /non-zero exit[\s\S]*notify blocked[^\n]*stop/);
  assert.match(result, /On `pending`, delete that file and continue/);
  assert.match(result, /On `closed`, [^\n]*stop the whole flow/);
  assert.match(result, /On `go`, [^\n]*\/e-pr-finalize[^\n]*stop/);
  assert.match(result, /On an `approve`[^\n]*handled.txt[^\n]*\/e-pr-finalize[^\n]*stop/);
  const rerun = skill.slice(skill.indexOf("5. After the rebase, push and green CI"), skill.indexOf("## 5."));
  assert.match(
    rerun,
    /In the PR's worktree, run "Take pending feedback"[^\n]*\n\s*Rerun `<main>\/bin\/wt approval --head <approved head>`/,
  );
  assert.match(rerun, /On exit 1, run `<main>\/bin\/wt notify blocked`, report [^\n]*approval[^\n]* and stop\./);
  assert.match(rerun, /A later run restarts at step 1/);
  assert.match(skill, /Any other change from READY[^\n]*stops the merge[^\n]*e-pr-finalize/);
});

test("local landing takes feedback for the approved review after verification and before land", () => {
  const skill = readFileSync(join(root, ".claude/skills/e-merge-local/SKILL.md"), "utf8");
  const land = skill.slice(skill.indexOf("## 4. Land"), skill.indexOf("## 5."));
  const verify = land.lastIndexOf("pnpm verify");
  const tracked = land.indexOf("3. Run `git ls-files -- .wt` in the worktree");
  const check = land.indexOf("check the folder and its entries");
  const saved = land.indexOf("List saved results");
  const fetch = land.indexOf('recense feedback <review-id> --save "<top>/.wt/review"');
  const command = land.indexOf("<main>/bin/wt land");
  assert.ok(verify >= 0 && verify < tracked && tracked < check && check < saved && saved < fetch && fetch < command);
  assert.match(
    land.slice(tracked, check),
    /must succeed and print nothing\.\n\s*Otherwise run `<main>\/bin\/wt notify blocked`, report the failure and stop/,
  );
  assert.match(land.slice(saved, fetch), /unhandled `go` as in step 3/);
  const feedback = land.slice(fetch, command);
  assert.match(feedback, /review id from step 3's `bin\/wt approval` output/);
  assert.match(feedback, /On `pending`, delete that file and land/);
  assert.match(feedback, /On `go`, return to step 3/);
  assert.match(feedback, /On `closed`, [^\n]*stop/);
  assert.match(feedback, /On a new `approve`, record it [^\n]* and land/);
});
