import type { Finding } from "./findings.ts";
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

function excerpt(repo: Repo, { path, line }: Finding): string {
  const untracked = "Not tracked as a file in the main checkout's HEAD.";
  const nonText = "The file is too large or not text.";
  const tree = gitBytes(repo, ["--literal-pathspecs", "ls-tree", "--long", "-z", "--full-tree", "HEAD", "--", path]);
  const tab = tree.stdout.indexOf(9);
  if (tree.code !== 0 || tab < 0 || !tree.stdout.subarray(tab + 1).equals(Buffer.from(`${path}\0`))) return untracked;
  const entry = /^(?:100644|100755) blob ([0-9a-f]{40}) +(\d+)$/.exec(tree.stdout.subarray(0, tab).toString("ascii"));
  if (!entry) return untracked;
  if (Number(entry[2]) > 1024 * 1024) return nonText;
  const blob = gitBytes(repo, ["cat-file", "blob", entry[1] as string]);
  if (blob.code !== 0) return untracked;
  if (blob.stdout.includes(0)) return nonText;
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.stdout);
  } catch {
    return nonText;
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const start = Math.max(0, Math.min(line - 7, lines.length - 1));
  return codeBlock(lines.slice(start, line + 6).join("\n"));
}

function renderFinding(repo: Repo, finding: Finding): string {
  const location = codeSpan(`${finding.path}:${finding.line}`);
  const meta = `${finding.kind} · ${finding.severity} · ${finding.size} · ${location} · ${finding.createdAt}`;
  const body =
    finding.kind === "security"
      ? `A security finding's text stays on this machine. Read it with \`bin/findings show ${finding.id}\`.`
      : [codeSpan(finding.title), codeBlock(finding.detail, "text"), excerpt(repo, finding)].join("\n\n");
  return `### ${finding.id}\n\n${meta}\n\n${body}`;
}

/** Findings arrive oldest first, with id breaking ties. Map insertion order preserves each area's first finding. */
export function renderTriagePage(repo: Repo, findings: Finding[]): { markdown: string; ids: string[] } {
  const groups = new Map<string | null, Finding[]>();
  const ineligible: Finding[] = [];
  for (const finding of findings) {
    if (finding.kind === "security" || finding.size === "large") {
      ineligible.push(finding);
      continue;
    }
    const area = finding.path.split("/").slice(0, 2).join("/");
    const group = groups.get(area);
    if (group) group.push(finding);
    else groups.set(area, [finding]);
  }
  if (ineligible.length) groups.set(null, ineligible);
  const parts = [INSTRUCTIONS];
  const ids: string[] = [];
  for (const [area, group] of groups) {
    parts.push(area === null ? "## Not for /e-fix\n\nThese findings take only `skip`." : `## ${codeSpan(area)}`);
    for (const finding of group) {
      parts.push(renderFinding(repo, finding));
      ids.push(finding.id);
    }
  }
  return { markdown: `${parts.join("\n\n")}\n`, ids };
}
