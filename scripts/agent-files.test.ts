import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".claude", "agents");

function unquote(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function frontmatter(text: string): Map<string, string[]> {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], "---", "frontmatter must start on the first line");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "frontmatter must have a closing delimiter");
  const fields = new Map<string, string[]>();
  let key: string | undefined;
  for (const line of lines.slice(1, end)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      const value = field[2].trim();
      fields.set(key, value ? value.split(",").map((item) => unquote(item.trim())) : []);
      continue;
    }
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item && key) fields.get(key)?.push(unquote(item[1]));
  }
  return fields;
}

const agents = new Map(
  readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => [path.basename(name, ".md"), frontmatter(readFileSync(path.join(directory, name), "utf8"))]),
);

test("every agent file pins a model", () => {
  assert.ok(agents.size > 0, "agent files must exist");
  for (const [name, fields] of agents) {
    const models = fields.get("model");
    assert.equal(models?.length, 1, `${name} must pin one model`);
    const model = models?.[0]?.trim();
    assert.ok(model, `${name} must pin a non-empty model`);
    assert.notEqual(model, "inherit", `${name} must not inherit its model`);
  }
});

test("each agent uses its assigned model", () => {
  for (const [name, model] of Object.entries({
    "recense-review-manager": "opus",
    "recense-reviewer": "sonnet",
    "recense-security-reviewer": "opus",
    "recense-react-reviewer": "sonnet",
    "recense-architecture-reviewer": "opus",
    "codex-agent": "sonnet",
    "e-outside-reader": "opus",
  })) {
    const fields = agents.get(name);
    assert.ok(fields, `${name} must exist`);
    assert.deepEqual(fields.get("model"), [model], `${name} must use ${model}`);
  }
});

test("reviewers cannot edit files or dispatch agents", () => {
  for (const name of [
    "recense-reviewer",
    "recense-security-reviewer",
    "recense-react-reviewer",
    "recense-architecture-reviewer",
    "codex-agent",
  ]) {
    const fields = agents.get(name);
    assert.ok(fields, `${name} must exist`);
    for (const tool of ["Edit", "Write", "NotebookEdit", "Agent"]) {
      assert.ok(fields.get("disallowedTools")?.includes(tool), `${name} must disallow ${tool}`);
    }
  }
});

test("the review manager has exactly the tools it needs", () => {
  const fields = agents.get("recense-review-manager");
  assert.ok(fields, "recense-review-manager must exist");
  const tools = fields.get("tools") ?? [];
  assert.deepEqual([...tools].sort(), ["Read", "Grep", "Glob", "Bash", "Agent"].sort());
});

test("the review manager removes a finding only on a false positive", () => {
  const body = readFileSync(path.join(directory, "recense-review-manager.md"), "utf8");
  assert.ok(!body.includes("Send the decision itself"));
  assert.ok(body.includes('A finding leaves `fix` only on "false positive".'));
});

test("a measured UI or UX problem is at least a defect", () => {
  const rounds = readFileSync(path.join(root, ".claude", "rules", "review-rounds.md"), "utf8").replace(
    /\s+/g,
    " ",
  );
  const manager = readFileSync(path.join(directory, "recense-review-manager.md"), "utf8").replace(
    /\s+/g,
    " ",
  );
  const react = readFileSync(path.join(directory, "recense-react-reviewer.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(rounds.includes("a UI or UX problem the reviewer shows with measured evidence"));
  assert.ok(manager.includes("is at least a defect when its reviewer justifies it with"));
  assert.ok(
    manager.includes(
      "Without that evidence, it is a preference, unless it is a bug or a security finding: " +
        "this rule never lowers one.",
    ),
  );
  assert.ok(manager.includes("is never a preference and is recorded with kind `security`"));
  assert.ok(react.includes("call it taste, unless it is a bug or a security issue"));
});

test("react and architecture reviewers have exactly the local read-only tools", () => {
  for (const name of ["recense-react-reviewer", "recense-architecture-reviewer"]) {
    const fields = agents.get(name);
    assert.ok(fields, `${name} must exist`);
    const tools = fields.get("tools") ?? [];
    assert.deepEqual([...tools].sort(), ["Read", "Grep", "Glob", "Bash"].sort(), name);
  }
});
