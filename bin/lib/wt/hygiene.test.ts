import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..");

const SKILLS = [
  "e-spawn",
  "e-work",
  "e-pr",
  "e-pr-finalize",
  "e-pr-merge",
  "e-rebase",
  "e-merge-local",
  "e-issue",
  "e-loop",
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
