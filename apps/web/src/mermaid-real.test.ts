import mermaid from "mermaid";
import { afterEach, expect, test } from "vitest";
import { encodeCodes, frameConfig } from "../mermaid-frame.ts";

afterEach(() => mermaid.mermaidAPI.globalReset());

const stateSource = `stateDiagram-v2
  s0: quote #quot;a#quot;
  s1: colon a#58; b
  s2: em dash a #8212; b
  s3: less a #lt; b
  [*] --> s0
  s0 --> s1: next #quot;step#quot;
  s1 --> s2
  s2 --> s3`;
const flowchartSource = 'flowchart LR\n  a["quote #quot;a#quot;"] --> b["colon a#58; b"]';

test.each([stateSource, flowchartSource])("real Mermaid parses entity stand-ins in %s", async (source) => {
  mermaid.initialize(frameConfig(false));
  await expect(mermaid.parse(encodeCodes(source).source)).resolves.toBeTruthy();
});

// Real renders return empty SVG strings in Happy DOM, and link nodes lack getBBox.
// Check real parser labels here; the frame tests cover sanitizing and text restoration.
test("real Mermaid preserves stand-ins and inlined printable characters in state descriptions", async () => {
  mermaid.initialize(frameConfig(false));
  const encoded = encodeCodes(
    `${stateSource}\n  s4: letters #26085; #228; #257;\n  s3 --> s4\n  s5: #8212; #9829; \u00b6#223;\n  s4 --> s5`,
  );
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(encoded.source);
  const db = diagram.db as typeof diagram.db & {
    getStates(): Map<string, { descriptions?: string[] }>;
    getRelations(): { relationTitle?: string }[];
  };
  const [quote, colon, less, marker] = encoded.characters.keys();
  expect([...encoded.characters.values()]).toEqual(['"', ":", "<", "\u00df"]);
  const states = db.getStates();
  expect(states.get("s0")?.descriptions).toEqual([`quote ${quote}a${quote}`]);
  expect(states.get("s1")?.descriptions).toEqual([`colon a${colon} b`]);
  expect(states.get("s2")?.descriptions).toEqual(["em dash a \u2014 b"]);
  expect(states.get("s3")?.descriptions).toEqual([`less a ${less} b`]);
  expect(states.get("s4")?.descriptions).toEqual(["letters \u65e5 \u00e4 \u0101"]);
  expect(states.get("s5")?.descriptions).toEqual([`\u2014 \u2665 \u00b6${marker}`]);
  expect(db.getRelations()).toEqual(
    expect.arrayContaining([expect.objectContaining({ relationTitle: `next ${quote}step${quote}` })]),
  );
});

test.each(["n\u2014", "n#mdash;"])("real Mermaid keeps n#8212; and %s as distinct states", async (other) => {
  mermaid.initialize(frameConfig(false));
  const encoded = encodeCodes(`stateDiagram-v2
  state "Encoded identifier" as n#8212;
  state "Literal identifier" as ${other}
  n#8212; --> ${other}`);
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(encoded.source);
  const db = diagram.db as typeof diagram.db & {
    getStates(): Map<string, { descriptions?: string[] }>;
    getRelations(): { id1: string; id2: string }[];
  };
  const states = db.getStates();
  const relations = db.getRelations();
  expect(states.size).toBe(2);
  expect(relations).toHaveLength(1);
  const [relation] = relations;
  if (!relation) throw new Error("Missing state relation");
  expect(relation.id1).not.toBe(relation.id2);
  expect(states.get(relation.id1)?.descriptions).toEqual(["Encoded identifier"]);
  expect(states.get(relation.id2)?.descriptions).toEqual(["Literal identifier"]);
});

test("real Mermaid preserves stand-ins and inlined letters in flowchart vertices", async () => {
  mermaid.initialize(frameConfig(false));
  const encoded = encodeCodes(`${flowchartSource}\n  b --> c["letters #26085; #228; #257;"]`);
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(encoded.source);
  const db = diagram.db as typeof diagram.db & { getVertices(): Map<string, { text: string }> };
  const [quote, colon] = encoded.characters.keys();
  expect(encoded.characters.size).toBe(2);
  const vertices = db.getVertices();
  expect(vertices.get("a")?.text).toBe(`quote ${quote}a${quote}`);
  expect(vertices.get("b")?.text).toBe(`colon a${colon} b`);
  expect(vertices.get("c")?.text).toBe("letters \u65e5 \u00e4 \u0101");
});

test.each([
  'flowchart LR\n A["#lt;script#gt;evil()#lt;/script#gt;"]',
  'flowchart LR\n A["#lt;img src=x onerror=evil()#gt;"]',
  'flowchart LR\n A["#106;avascript:evil()"]\n click A href "#106;avascript:evil()"',
])("real Mermaid keeps hostile entity-coded labels as stand-ins when parsing %s", async (source) => {
  mermaid.initialize(frameConfig(false));
  const encoded = encodeCodes(source);
  await expect(mermaid.parse(encoded.source)).resolves.toBeTruthy();
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(encoded.source);
  const db = diagram.db as typeof diagram.db & { getVertices(): Map<string, { text: string }> };
  const label = db.getVertices().get("A")?.text;
  expect(label).toBe(encoded.source.split('"')[1]);
  for (const standIn of encoded.characters.keys()) expect(label).toContain(standIn);
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
