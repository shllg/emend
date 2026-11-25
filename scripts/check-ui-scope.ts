import { execFileSync } from "node:child_process";
import { posix } from "node:path";

const readingBoundaries = new Set([
  "BlockView.tsx", "HtmlDocFrame.tsx", "HtmlDiagramRenderer.tsx", "MermaidBlock.tsx",
].map((name) => `apps/web/src/components/reading/${name}`));

function allowed(path: string): boolean {
  const name = posix.basename(path);
  if (readingBoundaries.has(path) || /mermaid|html-bridge|html-doc|sanitiz|frame-build/i.test(name) || /^sw[.-]/i.test(name))
    return false;
  return path.startsWith("apps/web/public/") ||
    /^apps\/web\/src\/(components|routes|styles)\//.test(path) ||
    /^apps\/web\/src\/[^/]+\.test\.tsx?$/.test(path) ||
    ["apps/web/src/styles.css", "apps/web/src/App.tsx", "apps/web/index.html"].includes(path);
}

export function outsideScope(paths: Iterable<string>): string[] {
  return [...new Set(paths)].filter((path) => !allowed(path)).sort();
}

function main(args: string[]): number {
  if (args.length !== 2 || args[0] !== "--since" || !args[1]) {
    console.error("Usage: node scripts/check-ui-scope.ts --since <commit>");
    return 2;
  }
  const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] } as const;
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trimEnd();
  const git = (args: string[]) => execFileSync("git", args, { ...options, cwd, maxBuffer: 64 * 1024 * 1024 });
  const base = git(["rev-parse", "--verify", "--end-of-options", `${args[1]}^{commit}`]).trim();
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  // The index can still differ even when the working copy matches the base again.
  const paths = git([...diff, base, "--"]) + git([...diff, "--cached", base, "--"]) +
    git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const outside = outsideScope(paths.split("\0").filter(Boolean));
  for (const path of outside) console.log(/[\r\n]/.test(path) ? JSON.stringify(path) : path);
  return outside.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    console.error("Could not read the base commit or the worktree paths");
    process.exitCode = 2;
  }
}
