// Keeps the agent instructions small and wired (AGENTS.md, "Who does what").
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Codex silently truncates the AGENTS.md chain at 32 KiB; 16 KiB leaves room for the user's global
// file (about 11 KiB today).
const AGENTS_MAX_BYTES = 16384;
const CLAUDE_MAX_BYTES = 1024;
const RULE_MAX_BYTES = 6656;

export interface BudgetResult {
  errors: string[];
  summary: string;
}

/** The lines between the first two `---` lines, or null when there is no frontmatter. */
function frontmatter(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  return end === -1 ? null : lines.slice(1, end);
}

function pathsEntries(front: string[]): string[] | null {
  const index = front.findIndex((line) => /^paths:/.test(line));
  if (index === -1) return null;
  const inline = front[index].replace(/^paths:\s*/, "").trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter((entry) => entry !== "");
  }
  const entries: string[] = [];
  for (const line of front.slice(index + 1)) {
    const match = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (!match) break;
    entries.push(match[1].replace(/^["']|["']$/g, ""));
  }
  return entries;
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(dir, name));
}

export function checkBudget(root: string): BudgetResult {
  const errors: string[] = [];

  const agentsPath = path.join(root, "AGENTS.md");
  let agentsText = "";
  let agentsBytes = 0;
  if (!existsSync(agentsPath)) {
    errors.push("AGENTS.md is missing");
  } else {
    agentsBytes = statSync(agentsPath).size;
    agentsText = readFileSync(agentsPath, "utf8");
    if (agentsBytes > AGENTS_MAX_BYTES) {
      errors.push(`AGENTS.md is ${agentsBytes} bytes; the limit is ${AGENTS_MAX_BYTES}`);
    }
  }

  const claudePath = path.join(root, "CLAUDE.md");
  if (!existsSync(claudePath)) {
    errors.push("CLAUDE.md is missing");
  } else {
    const claudeBytes = statSync(claudePath).size;
    if (claudeBytes > CLAUDE_MAX_BYTES) {
      errors.push(`CLAUDE.md is ${claudeBytes} bytes; the limit is ${CLAUDE_MAX_BYTES}`);
    }
    if (!readFileSync(claudePath, "utf8").split(/\r?\n/).includes("@AGENTS.md")) {
      errors.push("CLAUDE.md must contain a line that is exactly @AGENTS.md");
    }
  }

  const rules = markdownFiles(path.join(root, ".claude", "rules"));
  for (const file of rules) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const bytes = statSync(file).size;
    if (bytes > RULE_MAX_BYTES) {
      errors.push(`${rel} is ${bytes} bytes; the limit is ${RULE_MAX_BYTES}`);
    }
    const front = frontmatter(readFileSync(file, "utf8"));
    const entries = front === null ? null : pathsEntries(front);
    if (entries === null) {
      errors.push(`${rel} needs frontmatter with a paths: key`);
    } else if (entries.length === 0) {
      errors.push(`${rel} has an empty paths: list`);
    }
    if (!agentsText.includes(rel)) {
      errors.push(`${rel} is not named in AGENTS.md, so Codex is never pointed to it`);
    }
  }

  const agents = markdownFiles(path.join(root, ".claude", "agents"));
  for (const file of agents) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const front = frontmatter(readFileSync(file, "utf8"));
    const modelLine = front?.find((line) => /^model:/.test(line));
    const model = modelLine?.replace(/^model:\s*/, "").replace(/["']/g, "").trim();
    if (!model || model === "inherit") {
      errors.push(`${rel} needs a pinned model: in its frontmatter (not inherit)`);
    }
    const nameLine = front?.find((line) => /^name:/.test(line));
    const agentName = nameLine?.replace(/^name:\s*/, "").replace(/["']/g, "").trim();
    const fileName = path.basename(file, ".md");
    if (agentName !== fileName) {
      errors.push(`${rel} needs name: ${fileName} in its frontmatter, so the model pin finds it`);
    }
  }

  const summary = `check:budget ok: AGENTS.md ${agentsBytes}/${AGENTS_MAX_BYTES} bytes, ${rules.length} rules, ${agents.length} agents`;
  return { errors, summary };
}

function main(): void {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { errors, summary } = checkBudget(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(summary);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
