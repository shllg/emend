import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkBudget } from "./check-budget.ts";

const temps: string[] = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface TreeOptions {
  agents?: string;
  claude?: string;
  rule?: string;
}

const VALID_RULE = '---\npaths:\n  - "cli/**"\n---\n\n# Rule\n';

function makeTree(options: TreeOptions = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "budget-"));
  temps.push(root);
  mkdirSync(path.join(root, ".claude", "rules"), { recursive: true });
  mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    path.join(root, "AGENTS.md"),
    options.agents ?? "# Rules\n\nRead `.claude/rules/cli.md` first.\n",
  );
  writeFileSync(path.join(root, "CLAUDE.md"), options.claude ?? "@AGENTS.md\n");
  writeFileSync(path.join(root, ".claude", "rules", "cli.md"), options.rule ?? VALID_RULE);
  writeFileSync(
    path.join(root, ".claude", "agents", "worker.md"),
    "---\nname: worker\nmodel: sonnet\n---\n\nBody.\n",
  );
  return root;
}

test("a valid tree passes", () => {
  const { errors, summary } = checkBudget(makeTree());
  assert.deepEqual(errors, []);
  assert.match(summary, /^check:budget ok: AGENTS\.md \d+\/16384 bytes, 1 rules, 1 agents$/);
});

test("an AGENTS.md over the limit fails", () => {
  const body = "# Rules\n`.claude/rules/cli.md`\n";
  const { errors } = checkBudget(makeTree({ agents: body + "x".repeat(16385 - body.length) }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /AGENTS\.md is 16385 bytes/);
});

test("an AGENTS.md of exactly the limit passes", () => {
  const body = "# Rules\n`.claude/rules/cli.md`\n";
  const { errors } = checkBudget(makeTree({ agents: body + "x".repeat(16384 - body.length) }));
  assert.deepEqual(errors, []);
});

test("a CLAUDE.md without the import fails", () => {
  const { errors } = checkBudget(makeTree({ claude: "Read AGENTS.md\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /@AGENTS\.md/);
});

test("a rule without paths fails", () => {
  const { errors } = checkBudget(makeTree({ rule: "---\nname: x\n---\n\n# Rule\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cli\.md needs frontmatter with a paths: key/);
});

test("a rule with an empty paths list fails", () => {
  const { errors } = checkBudget(makeTree({ rule: "---\npaths: []\n---\n\n# Rule\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /empty paths/);
});

test("a rule not named in AGENTS.md fails", () => {
  const { errors } = checkBudget(makeTree({ agents: "# Rules\n" }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not named in AGENTS\.md/);
});

test("an agent with model inherit fails", () => {
  const root = makeTree();
  writeFileSync(
    path.join(root, ".claude", "agents", "worker.md"),
    "---\nname: worker\nmodel: inherit\n---\n\nBody.\n",
  );
  const { errors } = checkBudget(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /worker\.md needs a pinned model/);
});

test("an agent without a model fails", () => {
  const root = makeTree();
  writeFileSync(path.join(root, ".claude", "agents", "worker.md"), "---\nname: worker\n---\n");
  assert.equal(checkBudget(root).errors.length, 1);
});

test("an inline paths list passes", () => {
  const { errors } = checkBudget(makeTree({ rule: '---\npaths: ["cli/**", "x/**"]\n---\n\n# Rule\n' }));
  assert.deepEqual(errors, []);
});

test("a block paths list passes", () => {
  const { errors } = checkBudget(makeTree({ rule: "---\npaths:\n  - cli/**\n  - x/**\n---\n" }));
  assert.deepEqual(errors, []);
});

test("a missing AGENTS.md fails", () => {
  const root = makeTree();
  rmSync(path.join(root, "AGENTS.md"));
  assert.ok(checkBudget(root).errors.includes("AGENTS.md is missing"));
});

test("a missing CLAUDE.md fails", () => {
  const root = makeTree();
  rmSync(path.join(root, "CLAUDE.md"));
  assert.deepEqual(checkBudget(root).errors, ["CLAUDE.md is missing"]);
});

test("a CLAUDE.md over 1024 bytes fails", () => {
  const { errors } = checkBudget(makeTree({ claude: `@AGENTS.md\n${"x".repeat(1100)}\n` }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CLAUDE\.md is \d+ bytes/);
});

test("a rule over 6656 bytes fails", () => {
  const { errors } = checkBudget(makeTree({ rule: `${VALID_RULE}${"x".repeat(6700)}\n` }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /cli\.md is \d+ bytes; the limit is 6656/);
});

test("a rule with unterminated frontmatter fails", () => {
  const { errors } = checkBudget(makeTree({ rule: '---\npaths:\n  - "cli/**"\n\n# Rule\n' }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /needs frontmatter with a paths: key/);
});

test("an unindented block list passes", () => {
  const { errors } = checkBudget(makeTree({ rule: '---\npaths:\n- "cli/**"\n- "x/**"\n---\n' }));
  assert.deepEqual(errors, []);
});

test("an agent whose name differs from its file name fails", () => {
  const root = makeTree();
  writeFileSync(
    path.join(root, ".claude", "agents", "worker.md"),
    "---\nname: other\nmodel: sonnet\n---\n",
  );
  const { errors } = checkBudget(root);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /needs name: worker/);
});

test("the real repo passes", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkBudget(root).errors, []);
});
