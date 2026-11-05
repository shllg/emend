// Guards accidental drift between pnpm verify and CI; unexpected keys or layout fail closed.
// Deliberate CI changes are reviewed like any other code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

function workflow(name: string): string {
  return readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

// These guards deliberately require the workflows' simple block layout, without a YAML dependency.
function block(source: string, key: string, indent = 0): string {
  const pattern = new RegExp(`^ {${indent}}${key}:\\n([\\s\\S]*?)(?=^ {0,${indent}}\\S|(?![\\s\\S]))`, "gm");
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, `expected one ${key} block at indent ${indent}`);
  return matches[0][1].trimEnd();
}

function keys(source: string, indent: number): string[] {
  const names = source
    .split("\n")
    .filter((line) => line.trim() && /^ */.exec(line)?.[0].length === indent)
    .map((line) => {
      const match = /^(?:"([^"]+)"|'([^']+)'|([\w-]+)):/.exec(line.slice(indent));
      assert(match, `expected a mapping key: ${line}`);
      return match[1] ?? match[2] ?? match[3];
    });
  assert.equal(new Set(names).size, names.length, `duplicate keys at indent ${indent}`);
  return names;
}

function allowKeys(actual: string[], required: string[], optional: string[] = []): void {
  assert.deepEqual(actual.filter((key) => !optional.includes(key)).sort(), [...required].sort());
}

function jobs(source: string): Map<string, string> {
  const pattern = /^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm;
  const entries = [...block(source, "jobs").matchAll(pattern)].map(
    (match): [string, string] => [match[1], match[2]],
  );
  assert(entries.length > 0, "expected jobs");
  assert.equal(new Set(entries.map(([name]) => name)).size, entries.length, "duplicate job names");
  return new Map(entries);
}

function steps(body: string): string[] {
  const parts = block(body, "steps", 4).split(/^      - /m);
  assert.equal(parts.shift()?.trim(), "", "expected a block sequence of steps");
  return parts.map((step) => `        ${step.trimEnd()}`);
}

function runScripts(source: string): string[] {
  const lines = source.split("\n");
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const parts = [match[2]];
    const indent = match[1].length + (lines[i].trimStart().startsWith("- ") ? 2 : 0);
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const nested = /^\s*/.exec(lines[j])?.[0].length ?? 0;
      if (nested <= indent) break;
      parts.push(lines[j].trim());
    }
    commands.push(parts.join("\n"));
  }
  return commands;
}

function matrix(body: string, name: string): number[] {
  const matches = [...body.matchAll(new RegExp(`^        ${name}: \\[(\\d+(?:, \\d+)*)\\]$`, "gm"))];
  assert.equal(matches.length, 1, `expected one ${name} matrix`);
  return matches[0][1].split(", ").map(Number);
}

const verify = workflow("verify");
const verifyJobs = jobs(verify);
const calls = scripts.verify.split(" && ");
const chained = calls.map((call) => call.replace(/^pnpm /, ""));

test("verify chains every verify:* script exactly once", () => {
  for (const call of calls) assert.match(call, /^pnpm verify:[\w-]+$/);
  const defined = Object.keys(scripts).filter((name) => name.startsWith("verify:"));
  assert.deepEqual([...chained].sort(), defined.sort());
  assert.equal(scripts["verify:test"], "vitest run", "shard arguments must reach Vitest directly");
  assert.equal(scripts.test, "pnpm verify:test && pnpm verify:timing");
  assert.equal(scripts["verify:harness"], "pnpm test:harness");
  assert(scripts["test:harness"].split(" ").includes("scripts/verify-layout.test.ts"), "the gate must run this guard");
});

test("CI jobs run exactly the local verify chain, with only a frozen install before each check", () => {
  const ran: string[] = [];
  for (const [name, body] of verifyJobs) {
    const script = `verify:${name}`;
    const args = name === "test" ? ` --shard="$SHARD/${matrix(body, "shard").length}"` : "";
    assert.deepEqual(runScripts(body), ["pnpm install --frozen-lockfile", `pnpm ${script}${args}`], name);
    assert.doesNotMatch(body, /^\s*(?:- )?(?:if|needs|continue-on-error):/m, "checks must run unconditionally");
    ran.push(script);
  }
  assert.deepEqual(ran.sort(), [...chained].sort(), "CI and local verification must cover the same scripts");
});

test("verification jobs and steps allow only the keys needed to run their checks", () => {
  for (const [name, body] of verifyJobs) {
    allowKeys(keys(body, 4), ["runs-on", "timeout-minutes", "strategy", "steps"]);
    const strategy = block(body, "strategy", 4);
    allowKeys(keys(strategy, 6), ["fail-fast", "matrix"]);
    allowKeys(keys(block(strategy, "matrix", 6), 8), name === "test" ? ["node", "shard"] : ["node"]);
    for (const step of steps(body)) {
      const stepKeys = keys(step, 8);
      if (stepKeys.includes("uses")) {
        allowKeys(stepKeys, ["uses", "with"], ["name"]);
      } else {
        const command = runScripts(step)[0];
        let envKeys: string[] = [];
        if (command === "pnpm verify:static") envKeys = ["SYNC_BASE"];
        if (name === "test" && command === `pnpm verify:test --shard="$SHARD/${matrix(body, "shard").length}"`) {
          envKeys = ["SHARD"];
        }
        allowKeys(stepKeys, envKeys.length ? ["run", "env"] : ["run"], ["name"]);
        if (envKeys.length) allowKeys(keys(block(step, "env", 8), 10), envKeys);
      }
    }
  }
});

test("verification commands receive their required variables on the run step itself", () => {
  for (const [name, variable, expression] of [
    ["static", "SYNC_BASE", "inputs.sync-base"],
    ["test", "SHARD", "matrix.shard"],
  ]) {
    const body = verifyJobs.get(name);
    assert(body, `missing ${name} job`);
    const args = name === "test" ? ` --shard="$SHARD/${matrix(body, "shard").length}"` : "";
    const matches = steps(body).filter((step) => runScripts(step)[0] === `pnpm verify:${name}${args}`);
    assert.equal(matches.length, 1, `expected one verify:${name} step`);
    assert.equal(block(matches[0], "env", 8), `          ${variable}: \${{ ${expression} }}`);
  }
});

test("each check runs on both Node versions and test shards cover 1 through N", () => {
  for (const [name, body] of verifyJobs) {
    assert.match(body, /^    runs-on: ubuntu-latest$/m, name);
    assert.match(body, /^    timeout-minutes: [1-9]\d*$/m, name);
    assert.match(body, /^    strategy:\n      fail-fast: false\n      matrix:\n/m, name);
    assert.deepEqual(matrix(body, "node"), [24, 26], name);
    assert.doesNotMatch(body, /^\s*(?:include|exclude):/m, "matrix entries must not be skipped or added");
  }
  const body = verifyJobs.get("test");
  assert(body, "missing test job");
  const shards = matrix(body, "shard");
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1));
  assert.equal(runScripts(body)[1], `pnpm verify:test --shard="$SHARD/${shards.length}"`);
});

test("the shared workflow is callable only, with read-only contents and no secrets or cache", () => {
  allowKeys(keys(verify, 0), ["name", "on", "permissions", "jobs"]);
  const events = block(verify, "on");
  assert.deepEqual([...events.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]), ["workflow_call"]);
  const inputs = block(block(events, "workflow_call", 2), "inputs", 4);
  const inputNames = [...inputs.matchAll(/^      ([\w-]+):/gm)].map((match) => match[1]);
  assert.deepEqual(inputNames.sort(), ["ref", "sync-base"]);
  for (const input of ["ref", "sync-base"]) {
    assert.equal(block(inputs, input, 6), "        required: true\n        type: string");
  }
  assert.equal(block(verify, "permissions"), "  contents: read");
  assert.equal([...verify.matchAll(/^\s*permissions:/gm)].length, 1, "no other permissions");
  assert.doesNotMatch(verify, /^\s*concurrency:/m, "callers own concurrency");
  assert.doesNotMatch(verify, /secrets\s*\./);
  assert.doesNotMatch(verify.replace(/^ +package-manager-cache: false$/gm, ""), /\bcache\b/i);
});

test("every job uses pinned setup actions without checkout credentials or package-manager caching", () => {
  const actions = [...verify.matchAll(/^\s*(?:- )?uses: (.+)$/gm)];
  assert.equal(actions.length, verifyJobs.size * 3);
  for (const [, action] of actions) assert.match(action, /^[\w/-]+@[0-9a-f]{40} # v[\d.]+$/);
  for (const [name, body] of verifyJobs) {
    const jobSteps = steps(body);
    assert.equal(jobSteps.length, 5, name);
    assert.match(jobSteps[0], /^        uses: actions\/checkout@/m);
    allowKeys(keys(block(jobSteps[0], "with", 8), 10), ["ref", "fetch-depth", "fetch-tags", "persist-credentials"]);
    assert.match(jobSteps[0], /^          ref: \$\{\{ inputs.ref \}\}$/m);
    assert.match(jobSteps[0], /^          fetch-depth: 0$/m);
    assert.match(jobSteps[0], /^          fetch-tags: true$/m);
    assert.match(jobSteps[0], /^          persist-credentials: false$/m);
    assert.match(jobSteps[1], /^        uses: pnpm\/action-setup@/m);
    allowKeys(keys(block(jobSteps[1], "with", 8), 10), ["run_install"]);
    assert.match(jobSteps[1], /^          run_install: false$/m);
    assert.match(jobSteps[2], /^        uses: actions\/setup-node@/m);
    allowKeys(keys(block(jobSteps[2], "with", 8), 10), ["node-version", "package-manager-cache"]);
    assert.match(jobSteps[2], /^          node-version: \$\{\{ matrix.node \}\}$/m);
    assert.match(jobSteps[2], /^          package-manager-cache: false$/m);
  }
});

test("shared run scripts receive expressions only through env", () => {
  const commands = runScripts(verify);
  assert(commands.length > 0);
  for (const command of commands) assert(!command.includes("${{"), command);
});

test("CI runs on every push to main and every pull request into main without extra filters", () => {
  const ci = workflow("ci");
  allowKeys(keys(ci, 0), ["name", "on", "permissions", "concurrency", "jobs"]);
  assert.equal(
    block(ci, "on"),
    [
      "  push:",
      "    branches:",
      "      - main",
      "  pull_request:",
      "    branches:",
      "      - main",
    ].join("\n"),
  );
});

test("CI and release delegate verification to the shared workflow", () => {
  for (const name of ["ci", "release"]) {
    const source = workflow(name);
    const body = jobs(source).get("verify");
    assert(body, `${name}: missing verify job`);
    allowKeys(
      keys(body, 4),
      name === "ci" ? ["uses", "with"] : ["needs", "if", "permissions", "uses", "with"],
    );
    assert.match(body, /^    uses: \.\/\.github\/workflows\/verify\.yml$/m, name);
    assert.doesNotMatch(body, /^    (?:steps|runs-on|strategy):/m, name);
    assert.doesNotMatch(body, /^    (?:secrets|continue-on-error):/m, `${name}: no secrets or ignored failures`);
    for (const command of runScripts(source)) assert.doesNotMatch(command, /\bpnpm\s+(?:run\s+)?verify\b/, name);
  }
  const ci = jobs(workflow("ci")).get("verify") ?? "";
  assert.doesNotMatch(ci, /^    (?:if|needs):/m, "CI verification must run unconditionally");
  assert.match(ci, /^      ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}$/m);
  assert.match(
    ci,
    /^      sync-base: \$\{\{ github.event_name == 'push' && github.event.before \|\| format\('origin\/\{0\}', github.base_ref\) \}\}$/m,
  );
  const release = jobs(workflow("release")).get("verify") ?? "";
  assert.deepEqual(release.match(/^    needs:.*$/gm), ["    needs: plan"]);
  assert.deepEqual(release.match(/^    if:.*$/gm), ["    if: needs.plan.outputs.release == 'true'"]);
  assert.equal(block(release, "permissions", 4), "      contents: read");
  assert.match(release, /^      ref: \$\{\{ needs.plan.outputs.sha \}\}$/m);
  assert.match(release, /^      sync-base: \$\{\{ needs.plan.outputs.previous \}\}$/m);
});
