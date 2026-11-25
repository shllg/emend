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

function frontmatter(text: string) {
  const lines = text.split(/\r?\n/);
  assert.equal(lines[0], "---", "frontmatter must start on the first line");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "frontmatter must have a closing delimiter");
  const fields = new Map<string, string[]>();
  let key: string | undefined;
  let servers: Record<string, Record<string, unknown>> | undefined;
  let server: Record<string, unknown> | undefined;
  for (const line of lines.slice(1, end)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      assert(!fields.has(key), `duplicate frontmatter field ${key}`);
      const value = field[2].trim();
      if (key === "mcpServers") {
        assert.equal(value, "", "expected a block list of inline servers");
        servers = {};
      }
      fields.set(key, value ? value.split(",").map((item) => unquote(item.trim())) : []);
      continue;
    }
    if (key === "mcpServers" && servers) {
      const entry = /^  - ([\w-]+):$/.exec(line);
      if (entry) {
        assert(!Object.hasOwn(servers, entry[1]), "duplicate inline server");
        server = {};
        servers[entry[1]] = server;
      } else {
        const property = /^      ([\w-]+): (.+)$/.exec(line);
        assert(property && server, `unexpected inline server field: ${line}`);
        const [, name, value] = property;
        assert(!Object.hasOwn(server, name), "duplicate inline server field");
        server[name] = name === "args" ? JSON.parse(value) : unquote(value);
      }
      continue;
    }
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item && key) fields.get(key)?.push(unquote(item[1]));
  }
  return { fields, servers };
}

const agents = new Map(
  readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => [path.basename(name, ".md"), frontmatter(readFileSync(path.join(directory, name), "utf8"))]),
);

test("every agent file pins a model", () => {
  assert.ok(agents.size > 0, "agent files must exist");
  for (const [name, { fields }] of agents) {
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
    "recense-ui-finisher": "sonnet",
    "recense-security-reviewer": "opus",
    "recense-react-reviewer": "sonnet",
    "recense-architecture-reviewer": "opus",
    "codex-agent": "sonnet",
    "e-outside-reader": "opus",
  })) {
    const fields = agents.get(name)?.fields;
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
    const fields = agents.get(name)?.fields;
    assert.ok(fields, `${name} must exist`);
    for (const tool of ["Edit", "Write", "NotebookEdit", "Agent"]) {
      assert.ok(fields.get("disallowedTools")?.includes(tool), `${name} must disallow ${tool}`);
    }
  }
});

test("the review manager has exactly the tools it needs", () => {
  const fields = agents.get("recense-review-manager")?.fields;
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
    const fields = agents.get(name)?.fields;
    assert.ok(fields, `${name} must exist`);
    const tools = fields.get("tools") ?? [];
    assert.deepEqual([...tools].sort(), ["Read", "Grep", "Glob", "Bash"].sort(), name);
  }
});


test("only the UI finisher has an inline MCP server and only its tools are available", () => {
  const finisher = agents.get("recense-ui-finisher");
  assert.ok(finisher);
  assert.deepEqual(finisher.servers, {
    "ui-browser": { type: "stdio", command: "node", args: ["scripts/ui-browser-mcp.ts"] },
  });
  assert.deepEqual([...(finisher.fields.get("tools") ?? [])].sort(),
    ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "mcp__ui-browser__*"].sort());
  for (const [name, { servers }] of agents)
    if (name !== "recense-ui-finisher") assert.equal(servers, undefined, name);
});

test("the orchestrator snapshots and checks each finisher pass with the committed checker", () => {
  const skill = (name: string) =>
    readFileSync(path.join(root, ".claude", "skills", name, "SKILL.md"), "utf8");
  const work = skill("e-work").replace(/\s+/g, " ");
  const steps = [
    "Run `mktemp -d` once",
    "git rev-parse --verify <build>^{commit}",
    "git --no-replace-objects show <full-id>:scripts/check-ui-scope.ts > <temp>/check-ui-scope.mts",
    "node <temp>/check-ui-scope.mts --snapshot <temp>/ignored.json",
    'Dispatch `recense-ui-finisher` (`model: "sonnet"`)',
    "mktemp --suffix=.mts <temp>/check-XXXXXXXX",
    "git --no-replace-objects show <full-id>:scripts/check-ui-scope.ts > <fresh>",
    "node <fresh> --since <full-id> --snapshot <temp>/ignored.json --snapshot-sha256 <digest>",
    "Report every printed line as a blocker",
    "For `head moved`, `index flag`, `ignored changed`, `ignored removed`, `git changed`, " +
      "`main changed`, `nested repository`, `gitlink` or `undecodable name`, stop for the owner",
    "While any stop-for-owner line is printed, run no cleanup at all.",
    "For any such line or any exit other than 0 or 1",
    "`<main>/bin/wt notify blocked`",
    "Never put a printed path on a command line",
    "xargs -0 -r rm -f -- < <temp>/delete.nul",
    "test ! -s <temp>/restore.nul || git --no-replace-objects --literal-pathspecs " +
      "-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null " +
      "restore --source=<full-id> --staged --worktree " +
      "--pathspec-from-file=<temp>/restore.nul --pathspec-file-nul",
    "Run the check again after cleanup. Continue only at exit 0",
    "Run `node scripts/ui-demo.ts stop`",
    "If `.wt/ui-demo.json` still exists, run `<main>/bin/wt notify blocked` and wait for the owner",
    "Then run the check again. Continue only at exit 0.",
    "Remove `node_modules/.vitest-cache`, `.tsbuild`, `apps/*/.tsbuild` and `packages/*/.tsbuild`",
    "then run `pnpm verify`",
    "Stage the finish and run the check once more right before the commit. " +
      "Continue only at exit 0.",
    "Commit the finish separately, then remove the temp folder",
  ];
  let index = -1;
  for (const step of steps) {
    index = work.indexOf(step, index + 1);
    assert.notEqual(index, -1, step);
  }
  assert(!work.includes("node scripts/check-ui-scope.ts --since"));
  assert.match(work, /follow step 2 from a clean tree using the pass's starting commit/);
  const rounds = readFileSync(path.join(root, ".claude", "rules", "review-rounds.md"), "utf8");
  for (const text of [skill("e-pr-finalize"), rounds]) {
    const words = text.replace(/\s+/g, " ");
    assert.match(words, /Commit code fixes first so each pass starts from a clean tree/);
    assert.match(words, /checking each finisher pass as `\/e-work` step 2/);
  }
});

test("the manager tags fixes and the finisher uses the checked stop and screenshot paths", () => {
  const body = (agent: string) =>
    readFileSync(path.join(directory, agent + ".md"), "utf8").replace(/\s+/g, " ");
  const manager = body("recense-review-manager");
  assert.match(manager, /all its paths are allowed by `scripts\/check-ui-scope.ts`/);
  assert.match(manager, /it is not a security finding as defined in "Judge", step 4/);
  assert.match(manager, /every other fix `code`/);
  assert.match(manager, /The orchestrator routes the fixes\. The manager dispatches no fixer/);
  const finisher = body("recense-ui-finisher");
  assert.match(finisher, /Read `scripts\/check-ui-scope.ts` for the allowed and refused paths/);
  assert.match(finisher, /Save screenshots to `\.wt\/ui\/`.*refuses that path, report it/);
  assert.ok(finisher.includes("browser's file tools write only to `.wt/ui/` " +
    "and its own temporary folder"));
  assert.match(finisher, /stop every background command you started, then run/);
  assert.match(finisher, /run `node scripts\/ui-demo.ts stop`, including when a check fails/);
  assert.doesNotMatch(finisher, /\bkill\b/);
});
