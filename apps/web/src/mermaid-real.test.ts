import mermaid from "mermaid";
import { afterEach, expect, test } from "vitest";
import { encodeCodes, frameConfig } from "../mermaid-frame.ts";

afterEach(() => mermaid.mermaidAPI.globalReset());

test.each([
  `stateDiagram-v2
  s0: quote #quot;a#quot;
  s1: colon a#58; b
  s2: em dash a #8212; b
  s3: less a #lt; b
  [*] --> s0
  s0 --> s1: next #quot;step#quot;
  s1 --> s2
  s2 --> s3`,
  'flowchart LR\n  a["quote #quot;a#quot;"] --> b["colon a#58; b"]',
])("real Mermaid parses entity stand-ins in %s", async (source) => {
  mermaid.initialize(frameConfig(false));
  await expect(mermaid.parse(encodeCodes(source).source)).resolves.toBeTruthy();
});

test.each([
  '%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\nflowchart TD; A-->B; click A evil "click"',
  '%%{init: {"sequence": {"theme": "dark"}}}%%\nsequenceDiagram\nAlice->>Bob: Synthetic message',
])("real Mermaid keeps the frame theme and security level after parsing %s", async (source) => {
  mermaid.initialize(frameConfig(false));
  const sequenceTheme = mermaid.mermaidAPI.getConfig().sequence?.theme;
  await expect(mermaid.parse(source)).resolves.toBeTruthy();
  expect(mermaid.mermaidAPI.getConfig()).toMatchObject({ theme: "base", securityLevel: "strict" });
  expect(mermaid.mermaidAPI.getConfig().sequence?.theme).toBe(sequenceTheme);
});
