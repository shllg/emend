export type IntegrationAgent = "Claude Code" | "Codex";

export type Integration = {
  id: string;
  name: string;
  summary: string;
  agents: readonly IntegrationAgent[];
  prompt: string;
  /** Names the `##` section of docs/usage.md whose one ```text prompt block must equal `prompt`. */
  docsHeading: string;
};

export const integrations: readonly Integration[] = [
  {
    id: "status-line",
    name: "Status line",
    summary: "Shows this branch's review in Claude Code's status line, such as “recense r3 · your turn”.",
    agents: ["Claude Code"],
    docsHeading: "Show the review in Claude Code's status line",
    prompt: `Add recense to my Claude Code status line. In my ~/.claude/settings.json, add a statusLine setting of type command that runs recense status --line.

Keep any existing status line by printing both: the existing command's output, a separator, then recense's line. Show me the change before saving it.`,
  },
];

export function agentsLabel(agents: readonly IntegrationAgent[]): string {
  return `Works with ${agents.join(" and ")}.`;
}
