import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { encodeCodes, naturalSize, restoreCodes, sanitizeSvg, startFrame } from "../mermaid-frame.ts";
import { MermaidBlock, parseFrameSize } from "./components/reading/MermaidBlock.tsx";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  mermaidAPI: {
    defaultConfig: {
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges"],
    },
  },
}));
vi.mock("mermaid", () => ({ default: mermaid }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mermaid.render.mockReset();
  mermaid.initialize.mockReset();
});

const stateSource = `stateDiagram-v2
  s0: quote #quot;a#quot;
  s1: colon a#58; b
  s2: em dash a #8212; b
  s3: less a #lt; b
  [*] --> s0
  s0 --> s1: next #quot;step#quot;
  s1 --> s2
  s2 --> s3`;

test("entity codes use distinct Latin stand-ins and reuse repeated codes", () => {
  const encoded = encodeCodes(stateSource);
  expect([...encoded.characters.values()]).toEqual(['"', ":", "<"]);
  for (const standIn of encoded.characters.keys()) expect(standIn).toMatch(/^[\u0100-\u024f]$/u);
  const [quote, colon, less] = encoded.characters.keys();
  if (!quote || !colon || !less) throw new Error("Missing entity stand-ins");
  expect(encoded.source).toBe(
    stateSource
      .replaceAll("#quot;", quote)
      .replaceAll("#58;", colon)
      .replaceAll("#8212;", "\u2014")
      .replaceAll("#lt;", less),
  );
  expect(encoded.source.split(quote)).toHaveLength(5);
});

test("entity codes keep encoded and literal state identifiers distinct", () => {
  const source = `stateDiagram-v2
  state "Encoded identifier" as n#8212;
  state "Literal identifier" as n\u2014
  n#8212; --> n\u2014`;
  const encoded = encodeCodes(source);
  const [standIn] = encoded.characters.keys();
  if (!standIn) throw new Error("Missing entity stand-in");
  expect(standIn).toMatch(/^[\u0100-\u024f]$/u);
  expect(standIn).not.toBe("\u2014");
  expect(encoded.characters).toEqual(new Map([[standIn, "\u2014"]]));
  expect(encoded.source).toBe(source.replaceAll("#8212;", standIn));
});

test("entity codes keep encoded and HTML-referenced gitGraph identifiers distinct", () => {
  // gitGraph decodes references in ids with <br>; Happy DOM's sanitizer differs, so this is a unit test.
  const source = `gitGraph
  commit id: "n#8212;<br>"
  commit id: "n&mdash;<br>"`;
  const encoded = encodeCodes(source);
  const [standIn] = encoded.characters.keys();
  if (!standIn) throw new Error("Missing entity stand-in");
  expect(standIn).toMatch(/^[\u0100-\u024f]$/u);
  expect(encoded.characters).toEqual(new Map([[standIn, "\u2014"]]));
  expect(encoded.source).toBe(source.replaceAll("#8212;", standIn));
});

test("numeric HTML references prevent inlining entity codes in identifiers", () => {
  const encoded = encodeCodes(`gitGraph
  commit id: "n#8212;"
  commit id: "n&#8212;"`);
  const [standIn] = encoded.characters.keys();
  if (!standIn) throw new Error("Missing entity stand-in");
  expect(standIn).toMatch(/^[\u0100-\u024f]$/u);
  expect(encoded.characters).toEqual(new Map([[standIn, "\u2014"]]));
  expect(encoded.source).toContain(`commit id: "n${standIn}"`);
});

test("different codes for the same character stay distinct", () => {
  const encoded = encodeCodes("#8212; #mdash;");
  const [standIn] = encoded.characters.keys();
  if (!standIn) throw new Error("Missing entity stand-in");
  expect(standIn).toMatch(/^[\u0100-\u024f]$/u);
  expect(standIn).not.toBe("\u2014");
  expect(encoded.characters).toEqual(new Map([[standIn, "\u2014"]]));
  expect(encoded.source).toBe(`\u2014 ${standIn}`);
});

test("literal characters elsewhere in the source prevent inlining", () => {
  const encoded = encodeCodes("#9829; and \u2665");
  const [standIn] = encoded.characters.keys();
  if (!standIn) throw new Error("Missing entity stand-in");
  expect(standIn).toMatch(/^[\u0100-\u024f]$/u);
  expect(encoded.characters).toEqual(new Map([[standIn, "\u2665"]]));
  expect(encoded.source).toBe(`${standIn} and \u2665`);
});

test("entity encoding preserves colours, unknown codes and existing letters", () => {
  const source = 'flowchart LR\n  a["\u0100 #quot; #nosuchentity;"]\n  classDef dark fill:#333;\n  style a fill:#f9f;';
  const encoded = encodeCodes(source);
  expect(encoded.source).toContain("classDef dark fill:#333;\n  style a fill:#f9f;");
  expect(encoded.source).toContain("#nosuchentity;");
  expect(encoded.source).toContain("\u0100");
  expect(encoded.characters.size).toBe(1);
  const [standIn] = encoded.characters.keys();
  if (!standIn) throw new Error("Missing entity stand-in");
  expect(standIn).not.toBe("\u0100");
  expect(source).not.toContain(standIn);
  expect(encoded.characters.get(standIn)).toBe('"');
});

test.each(["#section;", "#region;", "#ltx;", "#notes;", "#lt_;", "#ampersand;"])(
  "partially decoded entity names stay unchanged: %s",
  (source) => {
    expect(encodeCodes(source)).toEqual({ source, characters: new Map() });
  },
);

test.each([
  { code: "#sect;", character: "\u00a7", inline: true },
  { code: "#not;", character: "\u00ac", inline: true },
  { code: "#semi;", character: ";", inline: false },
  { code: "#amp;", character: "&", inline: false },
])("complete entity names still decode: $code", ({ code, character, inline }) => {
  const encoded = encodeCodes(code);
  if (inline) {
    expect(encoded).toEqual({ source: character, characters: new Map() });
  } else {
    expect(encoded.source).toMatch(/^[\u0100-\u024f]$/u);
    expect(encoded.characters).toEqual(new Map([[encoded.source, character]]));
  }
});

test.each([
  "flowchart LR\n  a --> b",
  "flowchart LR; A-->B; style A fill:#f00 ; B-->C;",
  "classDef dark fill:#333;\nstyle a fill:#f9f;",
])("source without label entity codes stays unchanged: %s", (source) => {
  expect(encodeCodes(source)).toEqual({ source, characters: new Map() });
});

test("source containing the semicolon placeholder stays unchanged", () => {
  const source = 'flowchart LR\n  a["\uffff #quot;"]\n  style a fill:#f9f;';
  expect(encodeCodes(source)).toEqual({ source, characters: new Map() });
});

test.each([
  { source: "first#32;last", character: " ", prefix: "first", suffix: "last" },
  { source: "tab#9;x", character: "\t", prefix: "tab", suffix: "x" },
])("entity decoding preserves whitespace in $source", ({ source, character, prefix, suffix }) => {
  const encoded = encodeCodes(source);
  expect([...encoded.characters.values()]).toEqual([character]);
  const [standIn] = encoded.characters.keys();
  expect(encoded.source).toBe(`${prefix}${standIn}${suffix}`);
});

test("HTML references reserve their decoded characters before choosing stand-ins", () => {
  const encoded = encodeCodes("#quot; &Amacr; &#257; &#x102; &#259");
  expect([...encoded.characters.values()]).toEqual(['"', "\u0101"]);
  for (const standIn of encoded.characters.keys()) expect("\u0100\u0101\u0102\u0103").not.toContain(standIn);
});

test.each(["&Amacr\u00b6\u00df", "\ufb02\u00b0Amacr\u00b6\u00df", "\ufb02\u00b0\u00b0256\u00b6\u00df"])(
  "references formed from Mermaid markers reserve their decoded characters: %s",
  (reference) => {
    const encoded = encodeCodes(`flowchart LR; a["${reference} #65;"]`);
    expect([...encoded.characters.values()]).toEqual(["A"]);
    expect(encoded.characters.has("\u0100")).toBe(false);
  },
);

test.each([
  { code: "#quot;", parses: 1 },
  { code: "#8212;", parses: 1 },
  { code: "#quot; #8212; #65;", parses: 1 },
  { code: "", parses: 0 },
  { code: "#nosuchentity;", parses: 0 },
])("reference scanning batches distinct references once only when a code decodes: $code", ({ code, parses }) => {
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  const references = Array.from({ length: 50 }, (_, index) => `&a${index + 1};`);
  encodeCodes(`flowchart LR; a["${references.join(" ")} ${code}"]`);
  const calls = parse.mock.calls.filter(([input]) => input.includes("&a1;"));
  expect(calls).toHaveLength(parses);
  if (parses > 0) expect(calls[0]?.[0]).toBe(`x${references.join("\n")}`);
});

test("non-ASCII letters are inlined and reserved before choosing stand-ins for ASCII", () => {
  const encoded = encodeCodes("#quot; #26085; #228; #65; #257; #101;nd");
  expect(encoded.source).toBe("\u0100 \u65e5 \u00e4 \u0102 \u0101 \u0103nd");
  expect(encoded.characters).toEqual(
    new Map([
      ["\u0100", '"'],
      ["\u0102", "A"],
      ["\u0103", "e"],
    ]),
  );
  expect(encoded.characters.has("\u0101")).toBe(false);
});

test.each([
  { source: "\u00b6#223;", prefix: "\u00b6", character: "\u00df" },
  { source: "\ufb02#176;", prefix: "\ufb02", character: "\u00b0" },
  { source: "#182;", prefix: "", character: "\u00b6" },
  { source: "#64258;", prefix: "", character: "\ufb02" },
])("entity codes never inline Mermaid marker characters: $source", ({ source, prefix, character }) => {
  const encoded = encodeCodes(source);
  expect([...encoded.characters.values()]).toEqual([character]);
  const [standIn] = encoded.characters.keys();
  expect(encoded.source).toBe(`${prefix}${standIn}`);
  expect(encoded.source).not.toContain("\u00b6\u00df");
  expect(encoded.source).not.toContain("\ufb02\u00b0");
});

test("non-ASCII printable characters are inlined for exact label measurements", () => {
  const encoded = encodeCodes("#11835; #8212; #8594; #9829; #128512; e#769; #57344; #178;");
  expect(encoded).toEqual({
    source: "\u2e3b \u2014 \u2192 \u2665 \u{1f600} e\u0301 \ue000 \u00b2",
    characters: new Map(),
  });
});

test("spaces, controls, separators, format and unassigned characters use stand-ins", () => {
  const encoded = encodeCodes("#160; #9; #8232; #8233; #8238; #65535; #888;");
  expect([...encoded.characters.values()]).toEqual(["\u00a0", "\t", "\u2028", "\u2029", "\u202e", "\uffff", "\u0378"]);
  expect(encoded.source).toMatch(/^[\u0100-\u024f ]+$/u);
  expect(encoded.source).not.toContain("\uffff");
});

test("stand-ins use the nearest width in the frame font", () => {
  const context = {
    font: "",
    measureText: vi.fn((text: string) => ({
      width: ["@", "\u0152"].includes(text) ? 100 : ['"', "\u013a"].includes(text) ? 30 : 50,
    })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const encoded = encodeCodes("#64; #quot; #64;");
  expect(encoded.source).toBe("\u0152 \u013a \u0152");
  expect(encoded.characters).toEqual(
    new Map([
      ["\u0152", "@"],
      ["\u013a", '"'],
    ]),
  );
  expect(context.font).toBe("100px system-ui, sans-serif");
});

test("stand-ins exclude reserved letters even when their width matches", () => {
  const reserved = ["\u0130", "\u0131", "\u0149", "\u017f", "\u01f0"];
  const context = {
    font: "",
    measureText: vi.fn((text: string) => ({ width: text === "@" || reserved.includes(text) ? 100 : 0 })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const encoded = encodeCodes("#64;");
  expect(encoded.source).toMatch(/^[\u0100-\u024f]$/u);
  expect(reserved).not.toContain(encoded.source);
  expect(encoded.characters).toEqual(new Map([[encoded.source, "@"]]));
});

test.each(["null", "throws"])("canvas %s falls back to the lowest available code points", (mode) => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    if (mode === "throws") throw new Error("Canvas unavailable");
    return null;
  });
  const encoded = encodeCodes("#64; #quot;");
  expect(encoded.source).toBe("\u0100 \u0101");
  expect(encoded.characters).toEqual(
    new Map([
      ["\u0100", "@"],
      ["\u0101", '"'],
    ]),
  );
});

test.each([
  { firstFree: 0x0130, expected: "\u0132" },
  { firstFree: 0x017f, expected: "\u0180" },
])("stand-ins skip letters with ASCII case mappings at $firstFree", ({ firstFree, expected }) => {
  const used = Array.from({ length: firstFree - 0x0100 }, (_, index) => String.fromCodePoint(0x0100 + index)).join("");
  expect(encodeCodes(`${used} #quot;`).characters).toEqual(new Map([[expected, '"']]));
});

test("repeated unknown entity codes share one cached decode", () => {
  const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
  const source = "#nosuchentity; #nosuchentity; &nosuchentity;";
  expect(encodeCodes(source)).toEqual({ source, characters: new Map() });
  expect(parse.mock.calls.filter(([input]) => input === "x&nosuchentity;")).toHaveLength(1);
});

test("running out of stand-ins returns the whole original source", () => {
  const letters = Array.from({ length: 0x024f - 0x0100 }, (_, index) => String.fromCodePoint(0x0100 + index)).join("");
  const source = `flowchart LR\n  a["${letters} #quot; #lt;"]\n  classDef dark fill:#333;`;
  expect(encodeCodes(source)).toEqual({ source, characters: new Map() });
});

test("entity restoration changes SVG text and accessible labels but leaves styles and other attributes alone", () => {
  const encoded = encodeCodes("#quot; #58; #8212; #lt;b#gt; #amp;");
  const svg = sanitizeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" aria-label="${encoded.source}" data-label="${encoded.source}" style="--label: ${encoded.source};"><style>${encoded.source}</style><a href="#${encoded.source}"><text aria-label="${encoded.source}">${encoded.source}<tspan>${encoded.source}</tspan></text></a><title>${encoded.source}</title></svg>`,
  );
  restoreCodes(svg, encoded.characters);
  const expected = '" : \u2014 <b> &';
  expect(svg.querySelector("text")?.firstChild?.textContent).toBe(expected);
  expect(svg.querySelector("tspan")?.textContent).toBe(expected);
  expect(svg.querySelector("title")?.textContent).toBe(expected);
  expect(svg.getAttribute("aria-label")).toBe(expected);
  expect(svg.querySelector("text")?.getAttribute("aria-label")).toBe(expected);
  expect(svg.querySelector("style")?.textContent).toBe(encoded.source);
  expect(svg.getAttribute("data-label")).toBe(encoded.source);
  expect(svg.getAttribute("style")).toBe(`--label: ${encoded.source};`);
  expect(svg.querySelector("a")?.getAttribute("href")).toBe(`#${encoded.source}`);
  expect(svg.querySelector("b")).toBeNull();
});

test("entity restoration does not replace decoded characters again", () => {
  const characters = new Map([
    ["\u0100", "\u0101"],
    ["\u0101", '"'],
  ]);
  const svg = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" aria-label="\u0100 \u0101"><text>\u0100 \u0101</text></svg>',
  );
  restoreCodes(svg, characters);
  expect(svg.textContent).toBe('\u0101 "');
  expect(svg.getAttribute("aria-label")).toBe('\u0101 "');
});

test("entity restoration with no stand-ins leaves SVG text alone", () => {
  const svg = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>');
  restoreCodes(svg, new Map());
  expect(svg.textContent).toBe("A");
});

test("web sources have one audited server HTML sink and no DOM string insertion", () => {
  const root = join(import.meta.dirname, "..");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (path) => /\.(tsx?|html)$/.test(path) && !/^(node_modules|dist|\.tsbuild)\//.test(path),
  );
  const forbidden = ["inner" + "HTML", "outer" + "HTML", "insertAdjacent" + "HTML"];
  const reactSink = "dangerouslySet" + "InnerHTML";
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const name of forbidden) expect(text, `${file}: ${name}`).not.toContain(name);
    if (text.includes(reactSink)) expect(file).toBe("src/components/reading/BlockView.tsx");
  }
  expect(readFileSync(join(root, "src/components/reading/BlockView.tsx"), "utf8")).toContain(reactSink);
});
test("SVG scrub drops executable elements, click handlers and non-fragment links", () => {
  const svg = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="evil()"><script>evil()</script><foreignObject><p>bad</p></foreignObject><a href="javascript:evil()" onclick="evil()"><text>click</text></a><a xlink:href="https://example.com">external</a><use href="#safe"/></svg>',
  );
  expect(svg.querySelector("script, foreignObject")).toBeNull();
  expect(svg.querySelector("a")?.hasAttribute("onclick")).toBe(false);
  expect(svg.hasAttribute("onload")).toBe(false);
  expect(
    [...svg.querySelectorAll("a")].every((node) => !node.hasAttribute("href") && !node.hasAttribute("xlink:href")),
  ).toBe(true);
  expect(svg.querySelector("use")?.getAttribute("href")).toBe("#safe");
});
test.each([
  'graph TD; A-->B; click A evil "click"',
  '%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\ngraph TD; A-->B; click A evil "click"',
])("frame config is strict, ignores strangers and never binds a Mermaid click directive: %s", async (source) => {
  const root = document.createElement("div");
  document.body.append(root);
  const bindFunctions = vi.fn();
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><a onclick="evil()" href="javascript:evil()"><text>A</text></a></svg>',
    bindFunctions,
  });
  const stop = startFrame(root);
  try {
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, maxTextSize: 50000 }),
    );
    window.dispatchEvent(new MessageEvent("message", { source: null, data: { type: "render", source } }));
    expect(mermaid.render).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
    await waitFor(() => expect(root.querySelector("svg")).not.toBeNull());
    expect(bindFunctions).not.toHaveBeenCalled();
    expect(root.querySelector("[onclick], [href]")).toBeNull();
    for (const node of root.querySelectorAll("svg, svg *"))
      expect([...node.attributes].some((attr) => attr.name.toLowerCase().startsWith("on"))).toBe(false);
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "base",
        securityLevel: "strict",
        secure: expect.arrayContaining(["theme", "themeVariables", "securityLevel"]),
      }),
    );
  } finally {
    stop();
    root.remove();
  }
});
test("oversize source stays text and is never passed to Mermaid", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const stop = startFrame(root);
  try {
    const source = `${"x".repeat(50001)}#quot;`;
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
    await waitFor(() => expect(root.textContent).toContain("This diagram is too large to draw."));
    expect(root.querySelector("pre")?.textContent).toBe(source);
    expect(mermaid.render).not.toHaveBeenCalled();
  } finally {
    stop();
    root.remove();
  }
});

test("frame renders encoded labels and restores their characters as SVG text", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  const source = 'flowchart LR\n  a["quote #quot;a#quot; colon #58; dash #8212; #lt;b#gt;"]';
  const encoded = encodeCodes(source);
  mermaid.render.mockImplementation(async (_id: string, source: string) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${source.split('"')[1]}</text></svg>`,
  }));
  const stop = startFrame(root);
  try {
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
    await waitFor(() => expect(root.querySelector("text")?.textContent).toBe('quote "a" colon : dash \u2014 <b>'));
    expect(mermaid.render).toHaveBeenCalledExactlyOnceWith("diagram-1", encoded.source, expect.any(HTMLElement));
    expect(mermaid.render.mock.calls[0]?.[1]).not.toContain("#quot;");
    expect(root.querySelector("b")).toBeNull();
  } finally {
    stop();
    root.remove();
  }
});

test.each([
  { label: "#lt;script#gt;evil()#lt;/script#gt;", expected: "<script>evil()</script>", click: "" },
  { label: "#lt;img src=x onerror=evil()#gt;", expected: "<img src=x onerror=evil()>", click: "" },
  { label: "#106;avascript:evil()", expected: "javascript:evil()", click: '\nclick A href "#106;avascript:evil()"' },
])("frame restores hostile entity-coded labels only as text: $label", async ({ label, expected, click }) => {
  const root = document.createElement("div");
  document.body.append(root);
  const source = `flowchart LR\n  A["${label}"]${click}`;
  mermaid.render.mockImplementation(async (_id: string, encoded: string) => {
    const label = encoded.split('"')[1];
    const href = encoded.split('"')[3] ?? label;
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><a href="${href}" onclick="evil()"><text aria-label="${label}">${label}</text></a><a href="#safe"/></svg>`,
    };
  });
  const stop = startFrame(root);
  try {
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
    await waitFor(() => expect(root.querySelector("text")?.textContent).toBe(expected));
    expect(root.querySelector("text")?.getAttribute("aria-label")).toBe(expected);
    expect(root.querySelector("script, img, foreignObject")).toBeNull();
    for (const node of root.querySelectorAll("svg, svg *")) {
      for (const attribute of node.attributes) {
        expect(attribute.name.toLowerCase().startsWith("on")).toBe(false);
        if (attribute.localName === "href") expect(attribute.value.startsWith("#")).toBe(true);
      }
    }
  } finally {
    stop();
    root.remove();
  }
});

test("failed rendering keeps the original entity codes in the source fallback", async () => {
  const root = document.createElement("div");
  document.body.append(root);
  mermaid.render.mockRejectedValueOnce(new Error("Invalid diagram"));
  const stop = startFrame(root);
  try {
    window.dispatchEvent(
      new MessageEvent("message", { source: window.parent, data: { type: "render", source: stateSource } }),
    );
    await waitFor(() => expect(root.querySelector("pre")?.textContent).toBe(stateSource));
    expect(root.textContent).toContain("This diagram could not be drawn.");
    expect(mermaid.render).toHaveBeenCalledExactlyOnceWith(
      "diagram-1",
      encodeCodes(stateSource).source,
      expect.any(HTMLElement),
    );
    expect(mermaid.render.mock.calls[0]?.[1]).not.toContain("#quot;");
  } finally {
    stop();
    root.remove();
  }
});

test("parent uses the minimal sandbox, posts only source after load, and validates the sending window and size", () => {
  const { container } = render(<MermaidBlock source="graph TD; A-->B" />);
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/mermaid-frame.html");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith({ type: "render", source: "graph TD; A-->B" }, "*");
  const initial = frame.style.height;
  const other = document.createElement("iframe");
  Object.defineProperty(other, "contentWindow", { value: { postMessage: vi.fn() } });
  fireEvent(window, new MessageEvent("message", { source: other.contentWindow, data: { type: "size", height: 500 } }));
  expect(frame.style.height).toBe(initial);
  for (const height of [NaN, Infinity, "500", -1, 10001]) {
    fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "size", height } }));
    expect(frame.style.height).toBe(initial);
  }
  fireEvent(window, new MessageEvent("message", { source: frame.contentWindow, data: { type: "size", height: 500 } }));
  expect(frame.style.height).toBe("500px");
});

test.each([
  [Number.NaN, 1],
  [Infinity, 1],
  [-20, 1],
  [20000, 10000],
  [41.2, 42],
])("frame clamps measured height %s to %s", async (measured, height) => {
  const root = document.createElement("div");
  document.body.append(root);
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ height: measured } as DOMRect);
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>' });
  const stop = startFrame(root);
  try {
    window.dispatchEvent(
      new MessageEvent("message", { source: window.parent, data: { type: "render", source: "graph TD; A-->B" } }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: "size", height, natural: null }, "*"));
  } finally {
    stop();
    root.remove();
  }
});

test.each(["q", "xlink"])("SVG scrub removes %s:href in every namespace", (prefix) => {
  for (const url of ["https://example.com", "javascript:evil()"])
    for (const namespace of ["http://www.w3.org/1999/xlink", "urn:synthetic"]) {
      // Happy DOM's XML parser only resolves the literal xlink prefix. Construct
      // a namespaced Attr so this exercises the namespace-aware browser DOM.
      const parsed = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg"><a><text>link</text></a></svg>',
        "image/svg+xml",
      );
      parsed.querySelector("a")?.setAttributeNS(namespace, `${prefix}:href`, url);
      expect(parsed.querySelector("a")?.getAttributeNodeNS(namespace, "href")?.localName).toBe("href");
      vi.spyOn(DOMParser.prototype, "parseFromString").mockReturnValueOnce(parsed);
      const svg = sanitizeSvg("synthetic SVG");
      expect(svg.querySelector("a")?.hasAttribute(`${prefix}:href`)).toBe(false);
    }
});
test("mock secure defaults match the installed Mermaid library", async () => {
  const actual = await vi.importActual<typeof import("mermaid")>("mermaid");
  expect(mermaid.mermaidAPI.defaultConfig.secure).toEqual(actual.default.mermaidAPI.defaultConfig.secure);
});
test.each([
  { version: "installed", defaults: mermaid.mermaidAPI.defaultConfig.secure },
  { version: "future", defaults: ["futureSecureKey"] },
])("frame config names its protected keys and extends $version defaults", ({ defaults }) => {
  const original = mermaid.mermaidAPI.defaultConfig.secure;
  mermaid.mermaidAPI.defaultConfig.secure = defaults;
  const stop = startFrame(document.createElement("div"));
  try {
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: expect.arrayContaining([
          ...defaults,
          "secure",
          "securityLevel",
          "startOnLoad",
          "maxTextSize",
          "suppressErrorRendering",
          "maxEdges",
          "htmlLabels",
          "flowchart",
          "theme",
          "themeCSS",
          "themeVariables",
          "dompurifyConfig",
          "fontFamily",
          "altFontFamily",
        ]),
      }),
    );
  } finally {
    stop();
    mermaid.mermaidAPI.defaultConfig.secure = original;
  }
});
test("lazy frames receive source only on first load, with a fresh frame for changed source", () => {
  const { container, rerender } = render(<MermaidBlock source="flowchart LR; A-->B" />);
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("Missing frame");
  expect(frame.getAttribute("loading")).toBe("lazy");
  const post = vi.fn();
  Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
  fireEvent.load(frame);
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledTimes(1);
  rerender(<MermaidBlock source="flowchart LR; B-->C" />);
  const next = container.querySelector("iframe");
  if (!next) throw new Error("Missing frame");
  expect(next).not.toBe(frame);
  const nextPost = vi.fn();
  Object.defineProperty(next, "contentWindow", { value: { postMessage: nextPost } });
  fireEvent.load(next);
  fireEvent.load(next);
  expect(nextPost).toHaveBeenCalledExactlyOnceWith({ type: "render", source: "flowchart LR; B-->C" }, "*");
});

test.each([false, true])("frame locks its base theme to the embedding colour scheme (dark=%s)", (dark) => {
  const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: dark } as MediaQueryList);
  const stop = startFrame(document.createElement("div"));
  try {
    expect(media).toHaveBeenCalledExactlyOnceWith("(prefers-color-scheme: dark)");
    const [sunken, surface, fg, fg2, fg3, border, topicBg, topic] = dark
      ? ["#060708", "#111213", "#f4f4f6", "#c4c6c8", "#9d9ea1", "#2a2b2d", "#043232", "#00a19d"]
      : ["#f4f4f6", "#fdfdfe", "#111213", "#444547", "#5f6063", "#c4c6c8", "#c2f3f0", "#00807e"];
    expect(mermaid.initialize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        theme: "base",
        fontFamily: "system-ui, sans-serif",
        startOnLoad: false,
        securityLevel: "strict",
        secure: expect.arrayContaining(["theme", "themeVariables", "themeCSS", "fontFamily"]),
        themeVariables: {
          darkMode: dark,
          fontSize: "13px",
          background: sunken,
          tertiaryColor: sunken,
          labelBoxBkgColor: sunken,
          primaryColor: surface,
          actorBkg: surface,
          primaryTextColor: fg,
          textColor: fg,
          noteTextColor: fg,
          actorTextColor: fg,
          signalColor: fg2,
          signalTextColor: fg2,
          labelTextColor: fg2,
          loopTextColor: fg2,
          lineColor: fg3,
          primaryBorderColor: border,
          actorBorder: border,
          actorLineColor: border,
          labelBoxBorderColor: border,
          secondaryColor: topicBg,
          noteBkgColor: topicBg,
          noteBorderColor: topicBg,
          activationBkgColor: topicBg,
          activationBorderColor: topic,
        },
        sequence: {
          mirrorActors: false,
          actorMargin: 48,
          messageMargin: 30,
          boxMargin: 8,
          useMaxWidth: true,
          actorFontWeight: 500,
        },
      }),
    );
  } finally {
    stop();
  }
});

test.each(["0 0 400 200", "-10, -20, 400, 200", " 0,0 400,200 "])(
  "natural size uses the SVG viewBox %s before its measured rectangle",
  (viewBox) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", viewBox);
    const rect = vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ width: 80, height: 40 } as DOMRect);
    expect(naturalSize(svg)).toEqual({ width: 400, height: 200 });
    expect(rect).not.toHaveBeenCalled();
  },
);

test.each([
  undefined,
  "",
  "0 0 400",
  "0 0 400 200 1",
  "0 0 0 200",
  "0 0 -1 200",
  "0 0 NaN 200",
  "0 0 400 Infinity",
  "bad 0 400 200",
])("natural size falls back to the rectangle for invalid viewBox %s", (viewBox) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (viewBox !== undefined) svg.setAttribute("viewBox", viewBox);
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ width: 80.2, height: 40.1 } as DOMRect);
  expect(naturalSize(svg)).toEqual({ width: 81, height: 41 });
});

test.each([
  [0, 40],
  [40, 0],
  [-1, 40],
  [NaN, 40],
  [40, Infinity],
])("natural size is null for an unmeasurable SVG (%s × %s)", (width, height) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ width, height } as DOMRect);
  expect(naturalSize(svg)).toBeNull();
});

test.each([
  [20000, 10000, { width: 10000, height: 5000 }],
  [5000, 20000, { width: 2500, height: 10000 }],
  [30000, 10000, { width: 10000, height: 3334 }],
  [0.1, 0.2, { width: 1, height: 1 }],
])("natural size proportionally clamps and rounds %s × %s", (width, height, expected) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  expect(naturalSize(svg)).toEqual(expected);
  svg.removeAttribute("viewBox");
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({ width, height } as DOMRect);
  expect(naturalSize(svg)).toEqual(expected);
});

test("size messages omit natural before drawing and retain or replace each completed outcome", async () => {
  let resize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const root = document.createElement("div");
  document.body.append(root);
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ height: 42 } as DOMRect);
  const post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  mermaid.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" />' });
  const stop = startFrame(root);
  const send = (source: string) =>
    window.dispatchEvent(new MessageEvent("message", { source: window.parent, data: { type: "render", source } }));
  try {
    resize();
    expect(post).toHaveBeenLastCalledWith({ type: "size", height: 42 }, "*");
    send("graph TD; A-->B");
    await waitFor(() => expect(root.querySelector("svg")).not.toBeNull());
    const drawn = { type: "size", height: 42, natural: { width: 400, height: 200 } };
    expect(post).toHaveBeenLastCalledWith(drawn, "*");
    resize();
    expect(post).toHaveBeenLastCalledWith(drawn, "*");
    send("x".repeat(50001));
    expect(post).toHaveBeenLastCalledWith({ type: "size", height: 42, natural: null }, "*");
    resize();
    expect(post).toHaveBeenLastCalledWith({ type: "size", height: 42, natural: null }, "*");
    send("graph TD; B-->C");
    await waitFor(() => expect(root.querySelector("svg")).not.toBeNull());
    expect(post).toHaveBeenLastCalledWith(drawn, "*");
    mermaid.render.mockRejectedValueOnce(new Error("Invalid diagram"));
    send("bad diagram");
    await waitFor(() => expect(root.textContent).toContain("This diagram could not be drawn."));
    expect(post).toHaveBeenLastCalledWith({ type: "size", height: 42, natural: null }, "*");
    resize();
    expect(post).toHaveBeenLastCalledWith({ type: "size", height: 42, natural: null }, "*");
  } finally {
    stop();
    root.remove();
  }
});

test("frame size parser preserves pending and failed states and copies only dimensions", () => {
  expect(parseFrameSize({ type: "size", height: 1 })).toEqual({ height: 1 });
  expect(parseFrameSize({ type: "size", height: 10000, natural: undefined })).toEqual({ height: 10000 });
  expect(parseFrameSize({ type: "size", height: 42, natural: null })).toEqual({ height: 42, natural: null });
  const natural = { width: 1, height: 10000, extra: "ignored" };
  const parsed = parseFrameSize({ type: "size", height: 42.5, natural, extra: "ignored" });
  expect(parsed).toEqual({ height: 42.5, natural: { width: 1, height: 10000 } });
  expect(parsed?.natural).not.toBe(natural);
});

test.each([NaN, Infinity, -Infinity, "500", 0, -1, 10001, undefined, null])(
  "frame size parser rejects invalid dimensions %s",
  (value) => {
    expect(parseFrameSize({ type: "size", height: value })).toBeUndefined();
    expect(parseFrameSize({ type: "size", height: 42, natural: { width: value, height: 200 } })).toBeUndefined();
    expect(parseFrameSize({ type: "size", height: 42, natural: { width: 400, height: value } })).toBeUndefined();
  },
);

test.each([false, 42, "400x200", [], {}, { height: 200 }, { width: 400 }])(
  "frame size parser rejects invalid natural payload %j",
  (natural) => {
    expect(parseFrameSize({ type: "size", height: 42, natural })).toBeUndefined();
  },
);

test.each([null, undefined, 42, "size", {}, { height: 42 }, { type: "render", height: 42 }, { type: "size" }])(
  "frame size parser rejects invalid envelopes %j",
  (data) => expect(parseFrameSize(data)).toBeUndefined(),
);

test("inline Enlarge leaves the source disclosure and selection capture separate", () => {
  const mouseUp = vi.fn();
  const keyUp = vi.fn();
  const source = "graph TD; A-->B";
  const { container, getByRole, getByText } = render(<MermaidBlock source={source} />);
  container.addEventListener("mouseup", mouseUp);
  container.addEventListener("keyup", keyUp);
  const enlarge = getByRole("button", { name: "Enlarge diagram" });
  expect(enlarge.textContent).toBe("Enlarge");
  expect(enlarge.getAttribute("aria-haspopup")).toBe("dialog");
  expect(enlarge.hasAttribute("data-lightbox-diagram")).toBe(true);
  fireEvent.mouseUp(enlarge);
  fireEvent.keyUp(enlarge, { key: "Enter" });
  expect(mouseUp).not.toHaveBeenCalled();
  expect(keyUp).not.toHaveBeenCalled();
  const details = container.querySelector("details");
  expect(details?.parentElement).toBe(enlarge.parentElement);
  expect(details?.parentElement?.classList.contains("items-baseline")).toBe(true);
  expect(details?.open).toBe(false);
  fireEvent.click(getByText("Diagram source"));
  expect(details?.open).toBe(true);
  expect(details?.querySelector("pre")?.textContent).toBe(source);
  fireEvent.click(getByText("Diagram source"));
  expect(details?.open).toBe(false);
});
