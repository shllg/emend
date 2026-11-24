import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("../.claude/hooks/enforce-subagent-model.sh", import.meta.url));
const temps: string[] = [];

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function which(program: string): string {
  const result = spawnSync("sh", ["-c", `command -v ${program}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  return result.stdout.trim();
}

function makeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "model-"));
  temps.push(root);
  const agents = path.join(root, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(path.join(agents, "recense-reviewer.md"), "---\nname: recense-reviewer\nmodel: sonnet\n---\nBody\n");
  writeFileSync(path.join(agents, "renamed-file.md"), "---\nname: security-bot\nmodel: opus\n---\nBody\n");
  writeFileSync(path.join(agents, "floating.md"), "---\nname: floating\nmodel: inherit\n---\nBody\n");
  return root;
}

function agentCall(subagentType: string, model?: string): string {
  return JSON.stringify({
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType, ...(model ? { model } : {}) },
  });
}

function run(root: string, input: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [hook], {
    input,
    encoding: "utf8",
    // A startup file named by the caller's BASH_ENV or ENV must never run in the test.
    env: {
      ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}),
      // Keep the caller's HOME for PATH shims (mise, asdf) to find real programs; the hook never reads HOME.
      ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
      CLAUDE_PROJECT_DIR: root,
      CLAUDE_CODE_SUBAGENT_MODEL: "",
      ...env,
    },
  });
}

test("a pinned agent with the wrong model exits 2", () => {
  const result = run(makeProject(), agentCall("recense-reviewer", "opus"));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires explicit model: "sonnet"/);
});

test("a pinned agent with no model exits 2", () => {
  assert.equal(run(makeProject(), agentCall("recense-reviewer")).status, 2);
});

test("a pinned agent with the right model exits 0", () => {
  assert.equal(run(makeProject(), agentCall("recense-reviewer", "sonnet")).status, 0);
});

test("blocks a nested dispatch without the pinned model", () => {
  const root = makeProject();
  const input = {
    tool_name: "Agent",
    agent_id: "review-round-1",
    agent_type: "recense-review-manager",
    tool_input: { subagent_type: "recense-reviewer" },
  };
  assert.equal(run(root, JSON.stringify(input)).status, 2);
  assert.equal(
    run(root, JSON.stringify({ ...input, tool_input: { ...input.tool_input, model: "sonnet" } })).status,
    0,
  );
});

test("caller startup files never run in the test", () => {
  const root = makeProject();
  const startup = path.join(root, "startup.sh");
  const marker = `${startup}.marker`;
  writeFileSync(startup, `: > '${marker.replaceAll("'", "'\\''")}'\n`);
  const previousBashEnv = process.env.BASH_ENV;
  const previousEnv = process.env.ENV;
  try {
    process.env.BASH_ENV = startup;
    process.env.ENV = startup;
    const result = run(root, agentCall("recense-reviewer", "sonnet"));
    assert.equal(result.status, 0);
    assert.equal(existsSync(marker), false);
  } finally {
    if (previousBashEnv === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = previousBashEnv;
    if (previousEnv === undefined) delete process.env.ENV;
    else process.env.ENV = previousEnv;
  }
});

test("an agent whose file name differs from its name is still enforced", () => {
  const root = makeProject();
  assert.equal(run(root, agentCall("security-bot", "sonnet")).status, 2);
  assert.equal(run(root, agentCall("security-bot", "opus")).status, 0);
});

test("an environment override that differs from the pin exits 2", () => {
  const result = run(makeProject(), agentCall("recense-reviewer", "sonnet"), {
    CLAUDE_CODE_SUBAGENT_MODEL: "opus",
  });
  assert.equal(result.status, 2);
});

test("an unpinned agent and an unknown agent exit 0", () => {
  const root = makeProject();
  assert.equal(run(root, agentCall("floating", "opus")).status, 0);
  assert.equal(run(root, agentCall("general-purpose")).status, 0);
});

test("a name with a slash does not read files outside the agents folder", () => {
  assert.equal(run(makeProject(), agentCall("../agents/recense-reviewer", "opus")).status, 0);
});

test("other tools exit 0", () => {
  assert.equal(run(makeProject(), JSON.stringify({ tool_name: "Bash", tool_input: {} })).status, 0);
});

test("input that is not JSON exits 2", () => {
  const result = run(makeProject(), "not json");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unreadable hook input/);
});

// A version manager's jq shim needs the manager on PATH, so look for the real binary.
function realJq(): string | null {
  for (const candidate of ["/usr/bin/jq", "/usr/local/bin/jq", which("jq")]) {
    if (candidate && existsSync(candidate) && path.basename(realpathSync(candidate)).startsWith("jq")) {
      return candidate;
    }
  }
  return null;
}

function runWithTools(tools: string[]) {
  const bin = mkdtempSync(path.join(tmpdir(), "tools-"));
  temps.push(bin);
  for (const program of tools) {
    symlinkSync(program === "jq" ? (realJq() ?? which("jq")) : which(program), path.join(bin, program));
  }
  chmodSync(bin, 0o755);
  return spawnSync(which("bash"), [hook], {
    input: agentCall("recense-reviewer", "sonnet"),
    encoding: "utf8",
    env: { PATH: bin, CLAUDE_PROJECT_DIR: makeProject() },
  });
}

test("a PATH without jq exits 2", () => {
  const result = runWithTools(["bash", "awk", "cat"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /jq is not on PATH/);
});

test("a PATH without awk exits 2", () => {
  const result = runWithTools(["bash", "jq", "cat"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /awk is not on PATH/);
});

test("a PATH without cat exits 2", () => {
  const result = runWithTools(["bash", "jq", "awk"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cat is not on PATH/);
});

test("a PATH with every tool still enforces the pin", { skip: realJq() === null }, () => {
  assert.equal(runWithTools(["bash", "jq", "awk", "cat"]).status, 0);
});
