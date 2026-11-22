import { expect, test } from "vitest";
import usage from "../../../../docs/usage.md?raw";
import { agentsLabel, integrations } from "./integrations.ts";

test.each(integrations)("$name prompt matches its usage guide section exactly", (integration) => {
  const lines = usage.split("\n");
  const heading = lines.indexOf(`## ${integration.docsHeading}`);
  expect(heading).toBeGreaterThanOrEqual(0);
  const following = lines.slice(heading + 1);
  const nextHeading = following.findIndex((line) => line.startsWith("## "));
  const section = (nextHeading === -1 ? following : following.slice(0, nextHeading)).join("\n");
  const blocks = [...section.matchAll(/^```text\n([\s\S]*?)^```$/gm)];
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.[1]?.replace(/\n$/, "")).toBe(integration.prompt);
});

test("integration ids are unique", () => {
  expect(new Set(integrations.map((integration) => integration.id)).size).toBe(integrations.length);
});

test.each([
  { agents: ["Claude Code"], label: "Works with Claude Code." },
  { agents: ["Codex"], label: "Works with Codex." },
  { agents: ["Claude Code", "Codex"], label: "Works with Claude Code and Codex." },
] as const)("agent label: $label", ({ agents, label }) => {
  expect(agentsLabel(agents)).toBe(label);
});
