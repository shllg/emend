import mermaid from "mermaid";
import { afterEach, expect, test } from "vitest";
import { encodeCodes, exceedsLimits, frameConfig } from "../mermaid-frame.ts";

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

function diagramSource(type: string, nodes: number, edges: number): string {
  const prefix = type === "classDiagram" ? "class " : type === "architecture-beta" ? "service " : "";
  const lines = [type, ...Array.from({ length: nodes }, (_, index) => `${prefix}s${index}`)];
  for (let index = 0; index < edges; index++) {
    const from = index % nodes;
    const round = Math.floor(index / nodes);
    const to = round === 0 ? (from + 1) % nodes : (from * 7 + round * 3) % nodes;
    if (type === "erDiagram") {
      lines.push(`s${from} ||--o{ s${to} : relates`);
    } else if (type === "architecture-beta") {
      lines.push(`s${from}:R -- L:s${to}`);
    } else {
      lines.push(`s${from} --> s${to}`);
    }
  }
  return lines.join("\n");
}

test.each([
  { type: "stateDiagram-v2", nodes: 60, edges: 151, expected: true },
  { type: "stateDiagram-v2", nodes: 25, edges: 50, expected: false },
  { type: "flowchart LR", nodes: 60, edges: 151, expected: true },
  { type: "flowchart LR", nodes: 60, edges: 150, expected: false },
  { type: "stateDiagram-v2", nodes: 301, edges: 0, expected: true },
  { type: "classDiagram", nodes: 60, edges: 151, expected: true },
  { type: "classDiagram", nodes: 5, edges: 4, expected: false },
  { type: "erDiagram", nodes: 60, edges: 151, expected: true },
  { type: "erDiagram", nodes: 5, edges: 4, expected: false },
  { type: "architecture-beta", nodes: 60, edges: 151, expected: true },
  { type: "architecture-beta", nodes: 5, edges: 4, expected: false },
])("real Mermaid checks $type limits with $nodes nodes and $edges edges", async ({ type, nodes, edges, expected }) => {
  mermaid.initialize(frameConfig(false));
  await expect(exceedsLimits(diagramSource(type, nodes, edges))).resolves.toBe(expected);
});

test.each([
  { kind: "init directive", config: '%%{init: {"maxEdges": 1000}}%%' },
  { kind: "front matter", config: "---\nconfig: { maxEdges: 1000 }\n---" },
])("real Mermaid refuses an arrow limit override through $kind", async ({ config }) => {
  mermaid.initialize(frameConfig(false));
  const source = `${config}\n${diagramSource("flowchart LR", 60, 151)}`;
  await expect(mermaid.parse(source)).rejects.toThrow(/^Edge limit exceeded/);
  await expect(exceedsLimits(source)).resolves.toBe(true);
});

test.each([
  { config: "", nodes: 400, expected: true },
  { config: "---\nconfig: { class: { hierarchicalNamespaces: false } }\n---\n", nodes: 200, expected: false },
])("real Mermaid counts $nodes class nodes with namespace config", async ({ config, nodes, expected }) => {
  mermaid.initialize(frameConfig(false));
  const namespaces = Array.from(
    { length: 100 },
    (_, index) => `namespace N${index}.Inner.Leaf {\n  class C${index}\n}`,
  );
  const source = `${config}classDiagram\n${namespaces.join("\n")}`;
  await expect(exceedsLimits(source)).resolves.toBe(expected);
  await mermaid.parse(source);
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const db = diagram.db as typeof diagram.db & { getData(): { nodes: unknown[] } };
  expect(db.getData().nodes).toHaveLength(nodes);
});

test.each([
  { algorithm: "elk.force", edges: 51, expected: true },
  { algorithm: "elk.force", edges: 50, expected: false },
  { algorithm: "elk.layered", edges: 150, expected: false },
])("real Mermaid checks $edges arrows inside an $algorithm subgraph", async ({ algorithm, edges, expected }) => {
  mermaid.initialize(frameConfig(false));
  const lines = Array.from({ length: edges }, (_, index) => `  a${index} --> a${index + 1}`);
  const source = `flowchart LR\nsubgraph S\n${lines.join("\n")}\nend\nS@{ algorithm: ${algorithm} }`;
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const db = diagram.db as typeof diagram.db & {
    getData(): { nodes: { id: string; metadata?: { algorithm?: string } }[] };
  };
  expect(db.getData().nodes.find((node) => node.id === "S")?.metadata?.algorithm).toBe(algorithm);
  await expect(exceedsLimits(source)).resolves.toBe(expected);
});

test("real Mermaid ignores a diagram's architecture iteration override", async () => {
  mermaid.initialize(frameConfig(false));
  const source = `%%{init: {"architecture": {"numIter": 100000}}}%%\n${diagramSource("architecture-beta", 2, 1)}`;
  await expect(mermaid.parse(source)).resolves.toBeTruthy();
  expect(mermaid.mermaidAPI.getConfig().architecture?.numIter).not.toBe(100000);
});

test.each([
  { layout: "elk.stress", config: "---\nconfig: { layout: elk.stress }\n---" },
  { layout: "elk.force", config: '%%{init: {"layout": "elk.force"}}%%' },
])("real Mermaid ignores a diagram's $layout layout override", async ({ layout, config }) => {
  mermaid.initialize(frameConfig(false));
  const source = `${config}\nflowchart LR\n  A --> B`;
  await expect(mermaid.parse(source)).resolves.toBeTruthy();
  expect(mermaid.mermaidAPI.getConfig().layout).not.toBe(layout);
});

test("real Mermaid ignores a diagram's ELK strategy override", async () => {
  mermaid.initialize(frameConfig(false));
  const source = '%%{init: {"elk": {"nodePlacementStrategy": "LINEAR_SEGMENTS"}}}%%\nflowchart LR\n  A --> B';
  await expect(mermaid.parse(source)).resolves.toBeTruthy();
  expect(mermaid.mermaidAPI.getConfig().elk?.nodePlacementStrategy).not.toBe("LINEAR_SEGMENTS");
});

test.each([
  { sets: 13, expected: true },
  { sets: 3, expected: false },
])("real Mermaid checks venn limits with $sets sets", async ({ sets, expected }) => {
  mermaid.initialize(frameConfig(false));
  const lines = Array.from({ length: sets }, (_, index) => `set S${index}`);
  const source = `venn-beta\n${lines.join("\n")}\nunion S0,S1`;
  await expect(exceedsLimits(source)).resolves.toBe(expected);
});

test.each([
  { areas: 101, expected: true },
  { areas: 100, expected: false },
])("real Mermaid counts $areas venn areas including duplicate unions", async ({ areas, expected }) => {
  mermaid.initialize(frameConfig(false));
  const unions = Array.from({ length: areas - 3 }, () => "union A,B,C");
  const source = `venn-beta\nset A\nset B\nset C\n${unions.join("\n")}`;
  await expect(exceedsLimits(source)).resolves.toBe(expected);
});

test.each([
  { length: 10, expected: true },
  { length: 1, expected: false },
])("real Mermaid weighs 16 flowchart links of length $length", async ({ length, expected }) => {
  mermaid.initialize(frameConfig(false));
  const link = `${"-".repeat(length + 1)}>`;
  const lines = Array.from({ length: 16 }, (_, index) => `s${index} ${link} s${index + 1}`);
  const source = `flowchart LR\n${lines.join("\n")}`;
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const db = diagram.db as typeof diagram.db & { getData(): { edges: { minlen: number }[] } };
  expect(db.getData().edges.map((edge) => edge.minlen)).toEqual(Array.from({ length: 16 }, () => length));
  await expect(exceedsLimits(source)).resolves.toBe(expected);
});

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
