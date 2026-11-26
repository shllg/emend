import type { Finding } from "./findings.ts";
import { findingAnchor, findingLines } from "./findings-source.ts";
import { gitBytes, type Repo } from "./repo.ts";

const INSTRUCTIONS = `# Findings triage

## How to answer

Comment on the finding's \`### <id>\` heading with \`fix P0\`, \`fix P1\`, \`fix P2\` or \`skip\`.
An approved finding is available to \`/e-fix\`, highest priority first.
A skipped finding is dismissed and \`/e-fix\` never takes it.
A finding without a comment waits for the next triage.
Press Send to record your calls. Approve the review when done.`;

function backticks(content: string, minimum: number): string {
  let length = minimum;
  for (const run of content.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  return "`".repeat(length);
}

function codeSpan(content: string): string {
  const fence = backticks(content, 1);
  const pad = content.startsWith("`") || content.endsWith("`") || (/^ .* $/.test(content) && /[^ ]/.test(content));
  return pad ? `${fence} ${content} ${fence}` : `${fence}${content}${fence}`;
}

function codeBlock(content: string, language = ""): string {
  const fence = backticks(content, 3);
  return `${fence}${language}\n${content}\n${fence}`;
}

function shortenFindingIds(text: string): string {
  return text.replace(/(f-[0-9a-f]{4})[0-9a-f]{8}/g, "$1…");
}

function excerpt(repo: Repo, { path, line, anchor }: Finding): string {
  const untracked = "Not tracked as a file in the main checkout's HEAD.";
  const readFailure = "Could not read the file from the main checkout's HEAD.";
  const nonText = "The file is too large or not text.";
  const tree = gitBytes(repo, ["--literal-pathspecs", "ls-tree", "--long", "-z", "--full-tree", "HEAD", "--", path]);
  if (tree.code !== 0) return readFailure;
  const tab = tree.stdout.indexOf(9);
  if (tab < 0 || !tree.stdout.subarray(tab + 1).equals(Buffer.from(`${path}\0`))) return untracked;
  const entry = /^(?:100644|100755) blob ([0-9a-f]{40}) +(\S+)$/.exec(tree.stdout.subarray(0, tab).toString("ascii"));
  if (!entry) return untracked;
  const size = entry[2] as string;
  if (!/^\d+$/.test(size)) return readFailure;
  if (Number(size) > 1024 * 1024) return nonText;
  const blob = gitBytes(repo, ["cat-file", "blob", entry[1] as string]);
  if (blob.code !== 0) return readFailure;
  if (blob.stdout.includes(0)) return nonText;
  let lines: string[];
  try {
    lines = findingLines(blob.stdout);
  } catch {
    return nonText;
  }
  const current = lines[line - 1];
  if (current === undefined) return `Line ${line} is past the end of the file in the main checkout's HEAD.`;
  const block = codeBlock(lines.slice(Math.max(0, line - 7), line + 6).join("\n"));
  if (findingAnchor(current) !== anchor) return `${block}\n\nThe recorded line changed since the finding was recorded.`;
  return block;
}

function renderFinding(repo: Repo, finding: Finding): string {
  const location = codeSpan(`${finding.path}:${finding.line}`);
  const meta = `${finding.kind} · ${finding.severity} · ${finding.size} · ${location} · ${finding.createdAt}`;
  const body = [meta, codeSpan(finding.title), codeBlock(finding.detail, "text"), excerpt(repo, finding)].join("\n\n");
  return `### ${finding.id}\n\n${shortenFindingIds(body)}`;
}

/** Open findings arrive oldest first, with id breaking ties. Map insertion order preserves each area's first finding. */
export function renderTriagePage(repo: Repo, findings: Finding[]): { markdown: string; ids: string[] } | null {
  const groups = new Map<string | null, Finding[]>();
  const large: Finding[] = [];
  let securityCount = 0;
  for (const finding of findings) {
    if (finding.kind === "security") {
      securityCount++;
      continue;
    }
    if (finding.approval) continue;
    if (finding.size === "large") {
      large.push(finding);
      continue;
    }
    const area = finding.path.split("/").slice(0, 2).join("/");
    const group = groups.get(area);
    if (group) group.push(finding);
    else groups.set(area, [finding]);
  }
  if (large.length) groups.set(null, large);
  if (!groups.size && !securityCount) return null;
  const parts = [INSTRUCTIONS];
  if (securityCount)
    parts.push(
      `${securityCount} security findings are open. They stay on this machine: list them with \`bin/findings list --state open --kind security\`.`,
    );
  const ids: string[] = [];
  for (const [area, group] of groups) {
    parts.push(
      area === null
        ? "## Not for /e-fix\n\nThese findings take only `skip`."
        : `## ${codeSpan(shortenFindingIds(area))}`,
    );
    for (const finding of group) {
      parts.push(renderFinding(repo, finding));
      ids.push(finding.id);
    }
  }
  return { markdown: `${parts.join("\n\n")}\n`, ids };
}
