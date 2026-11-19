import mermaid, { type MermaidConfig } from "mermaid";
import { statechartClassCSS } from "./src/components/reading/mermaid-classes.ts";
import type { MermaidColors } from "./src/components/reading/mermaid-colors.ts";

const MAX_SOURCE = 50000;
// Mermaid parses types like state charts at about 1 ms per statement; refuse longer diagrams before parsing.
const MAX_STATEMENTS = 500;
// Layout runs on the frame's main thread, which the page may share; time grows much faster than arrow count.
const MAX_EDGES = 150;
// Unmeasured or slow container algorithms need a lower arrow limit.
const MAX_EDGES_SLOW_LAYOUT = 50;
// Mermaid's swimlane layout grows quickly across lanes: 19 arrows took about 1 s, 50 about 10 s.
const MAX_EDGES_SWIMLANE = 20;
const MAX_NODES = 300;
// Venn layout time grows roughly with the fourth power of the number of distinct sets.
const MAX_VENN_SETS = 12;
// Repeated Venn areas add layout work even when the set count stays small.
const MAX_VENN_AREAS = 100;
const FONT_FAMILY = "system-ui, sans-serif";

// Mermaid writes codes as entity text in SVG labels and decodes only &amp;, &lt; and &gt;.
// Inline non-ASCII printable characters except Mermaid's markers; use stand-in letters
// of about the same width for other codes, then write their characters back as text.
// Inline a code only when its characters are unique in the source and its HTML references,
// so identifiers stay distinct. Names the HTML parser decodes only in part stay as written.
export function encodeCodes(source: string): { source: string; characters: Map<string, string> } {
  if (source.includes("\uffff")) return { source, characters: new Map() };
  const encoded = source
    .replace(/style.*:\S*#.*;/g, (match) => `${match.slice(0, -1)}\uffff`)
    .replace(/classDef.*:\S*#.*;/g, (match) => `${match.slice(0, -1)}\uffff`);
  const parser = new DOMParser();
  const decodedEntities = new Map<string, string>();
  const decode = (entity: string) => {
    const cached = decodedEntities.get(entity);
    if (cached !== undefined) return cached;
    const decoded = (parser.parseFromString(`x${entity}`, "text/html").body.textContent ?? `x${entity}`).slice(1);
    decodedEntities.set(entity, decoded);
    return decoded;
  };
  let referenceCharacters: Set<string> | undefined;
  const getReferenceCharacters = () => {
    if (referenceCharacters) return referenceCharacters;
    const decodedSource = source
      .replace(/\ufb02\u00b0\u00b0/g, "&#")
      .replace(/\ufb02\u00b0/g, "&")
      .replace(/\u00b6\u00df/g, ";");
    const references = new Set<string>();
    for (const text of [source, decodedSource]) {
      for (const [reference] of text.matchAll(/&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g)) {
        references.add(reference);
      }
    }
    referenceCharacters = new Set(references.size > 0 ? decode([...references].join("\n")) : "");
    return referenceCharacters;
  };
  const present = new Set(source);
  const used = new Set([...source, "\u0130", "\u0131", "\u0149", "\u017f", "\u01f0"]);
  const codes = new Map<string, string>();
  const pending = new Map<string, string>();
  const characters = new Map<string, string>();
  for (const [code] of encoded.matchAll(/#\w+;/g)) {
    if (codes.has(code) || pending.has(code)) continue;
    const inner = code.slice(1, -1);
    const numeric = /^\d+$/.test(inner);
    const entity = numeric ? `&#${inner};` : `&${inner};`;
    const decoded = decode(entity);
    if (
      decoded === entity ||
      (!numeric && [...inner].some((_, index) => index > 0 && decoded.endsWith(`${inner.slice(index)};`)))
    ) {
      codes.set(code, code);
      continue;
    }
    const referenced = getReferenceCharacters();
    if (
      /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Co}]+$/u.test(decoded) &&
      [...decoded].every(
        (character) => character.charCodeAt(0) > 0x7f && !present.has(character) && !referenced.has(character),
      ) &&
      !/[\u00b0\u00b6\u00df\ufb02]/u.test(decoded)
    ) {
      codes.set(code, decoded);
      for (const character of decoded) {
        present.add(character);
        used.add(character);
      }
    } else {
      pending.set(code, decoded);
    }
  }
  if (pending.size > 0) {
    for (const character of getReferenceCharacters()) used.add(character);
    let context: CanvasRenderingContext2D | null;
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
    if (context) context.font = `100px ${FONT_FAMILY}`;
    const width = (text: string) => context?.measureText(text).width ?? 0;
    const candidates = new Map<string, number>();
    for (let point = 0x0100; point <= 0x024f; point++) {
      const character = String.fromCodePoint(point);
      if (!used.has(character)) candidates.set(character, width(character));
    }
    if (pending.size > candidates.size) return { source, characters: new Map() };
    for (const [code, decoded] of pending) {
      const target = width(decoded);
      let standIn = "";
      let distance = Infinity;
      for (const [candidate, measured] of candidates) {
        const difference = Math.abs(measured - target);
        if (difference < distance) {
          standIn = candidate;
          distance = difference;
        }
      }
      candidates.delete(standIn);
      codes.set(code, standIn);
      characters.set(standIn, decoded);
    }
  }
  return {
    source: encoded.replace(/#\w+;/g, (code) => codes.get(code) ?? code).replaceAll("\uffff", ";"),
    characters,
  };
}

export function restoreCodes(svg: Element, characters: Map<string, string>): void {
  if (characters.size === 0) return;
  const standIns = [...characters.keys()].map((character) => `\\u{${character.charCodeAt(0).toString(16)}}`).join("");
  const pattern = new RegExp(`[${standIns}]`, "gu");
  const replace = (text: string) => text.replace(pattern, (standIn) => characters.get(standIn) ?? standIn);
  const walker = svg.ownerDocument.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.localName === "style") continue;
    const text = node as Text;
    text.data = replace(text.data);
  }
  for (const node of [svg, ...svg.querySelectorAll("[aria-label]")]) {
    const label = node.getAttribute("aria-label");
    if (label !== null) node.setAttribute("aria-label", replace(label));
  }
}

export function naturalSize(svg: Element): { width: number; height: number } | null {
  const viewBox = svg
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  let width = viewBox?.[2];
  let height = viewBox?.[3];
  if (
    viewBox?.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  ) {
    ({ width, height } = svg.getBoundingClientRect());
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, 10000 / Math.max(width, height));
  const clamp = (value: number) => Math.max(1, Math.min(10000, Math.ceil(value * scale)));
  return { width: clamp(width), height: clamp(height) };
}

export function sanitizeSvg(source: string): SVGElement {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (
    parsed.querySelector("parsererror") ||
    svg.localName !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg"
  )
    throw new Error("Invalid diagram");
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    if (
      node.namespaceURI !== "http://www.w3.org/2000/svg" ||
      ["script", "foreignobject", "animate", "animatemotion", "animatetransform", "set"].includes(
        node.localName.toLowerCase(),
      )
    ) {
      node.remove();
      continue;
    }
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || (attribute.localName === "href" && !attribute.value.startsWith("#")))
        node.removeAttributeNode(attribute);
    }
  }
  return document.importNode(svg, true) as unknown as SVGElement;
}
function parseColors(value: unknown): MermaidColors | undefined {
  if (!value || typeof value !== "object") return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const keys = ["background", "surface", "text", "text2", "line", "border", "accentBg", "accent"] as const;
  if (Reflect.ownKeys(value).length !== keys.length) return;
  for (const key of keys) {
    const color: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$(?![\s\S])/.test(color)) return;
  }
  return value as MermaidColors;
}

export function frameConfig(dark: boolean, colors?: MermaidColors): MermaidConfig {
  // sRGB: bg-sunken, bg-surface, fg-1/2/3, border-2, topic-bg-2 and topic-solid.
  const [sunken, surface, fg, fg2, fg3, border, topicBg, topic] = colors
    ? [
        colors.background,
        colors.surface,
        colors.text,
        colors.text2,
        colors.line,
        colors.border,
        colors.accentBg,
        colors.accent,
      ]
    : dark
      ? ["#060708", "#111213", "#f4f4f6", "#c4c6c8", "#9d9ea1", "#2a2b2d", "#043232", "#00a19d"]
      : ["#f4f4f6", "#fdfdfe", "#111213", "#444547", "#5f6063", "#c4c6c8", "#c2f3f0", "#00807e"];
  return {
    theme: "base",
    fontFamily: FONT_FAMILY,
    themeCSS: statechartClassCSS(dark, surface, fg),
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
      ...(dark ? { edgeLabelBackground: sunken } : {}),
      noteBkgColor: topicBg,
      noteBorderColor: topicBg,
      activationBkgColor: topicBg,
      activationBorderColor: topic,
      archEdgeColor: fg3,
      archEdgeArrowColor: fg3,
      archGroupBorderColor: border,
      pieOuterStrokeColor: border,
      pieStrokeColor: sunken,
      gridColor: fg3,
      doneTaskBorderColor: border,
      critBorderColor: border,
      todayLineColor: fg3,
      vertLineColor: fg3,
      radar: { graticuleColor: fg3 },
      cynefin: { cliffColor: fg3 },
      wardleyEvolutionColor: fg3,
      emUiStroke: border,
      emProcessorStroke: border,
      emReadModelStroke: border,
      emCommandStroke: border,
      emEventStroke: border,
      emSwimlaneBackgroundStroke: border,
    },
    sequence: {
      mirrorActors: false,
      actorMargin: 48,
      messageMargin: 30,
      boxMargin: 8,
      useMaxWidth: true,
      actorFontWeight: 500,
    },
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: MAX_SOURCE,
    maxEdges: MAX_EDGES,
    secure: [
      ...new Set([
        ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "numIter",
        "layout",
        "elk",
        "htmlLabels",
        "flowchart",
        "architecture",
        "venn",
        "themeCSS",
        "theme",
        "themeVariables",
        "dompurifyConfig",
        "fontFamily",
        "altFontFamily",
      ]),
    ],
  };
}
async function measure(
  source: string,
): Promise<
  { nodes: number; edges: number; sets: number; areas: number; maxAreaSets: number; maxEdges: number } | undefined
> {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
  const { db } = diagram;
  if ("getData" in db && typeof db.getData === "function") {
    const data: unknown = db.getData();
    const nodes = data && typeof data === "object" && "nodes" in data ? data.nodes : undefined;
    const edges = data && typeof data === "object" && "edges" in data ? data.edges : undefined;
    const slowLayout =
      Array.isArray(nodes) &&
      nodes.some((node: unknown) => {
        if (!node || typeof node !== "object" || !("metadata" in node)) return false;
        const metadata = node.metadata;
        if (!metadata || typeof metadata !== "object" || !("algorithm" in metadata)) return false;
        return (
          typeof metadata.algorithm === "string" &&
          !["elk.layered", "elk.rectpacking", "elk.mrtree", "elk.sporeOverlap"].includes(metadata.algorithm)
        );
      });
    return {
      nodes: Array.isArray(nodes) ? nodes.length : 0,
      edges: Array.isArray(edges)
        ? edges.reduce((total: number, edge: unknown) => {
            const minlen = edge && typeof edge === "object" && "minlen" in edge ? edge.minlen : undefined;
            return total + Math.max(1, typeof minlen === "number" && Number.isFinite(minlen) ? minlen : 1);
          }, 0)
        : 0,
      sets: 0,
      areas: 0,
      maxAreaSets: 0,
      maxEdges: Math.min(
        diagram.type === "swimlane" ? MAX_EDGES_SWIMLANE : MAX_EDGES,
        slowLayout ? MAX_EDGES_SLOW_LAYOUT : MAX_EDGES,
      ),
    };
  }
  if ("getNodes" in db && typeof db.getNodes === "function" && "getEdges" in db && typeof db.getEdges === "function") {
    const nodes: unknown = db.getNodes();
    const groups: unknown = "getGroups" in db && typeof db.getGroups === "function" ? db.getGroups() : undefined;
    const edges: unknown = db.getEdges();
    return {
      nodes: (Array.isArray(nodes) ? nodes.length : 0) + (Array.isArray(groups) ? groups.length : 0),
      edges: Array.isArray(edges) ? edges.length : 0,
      sets: 0,
      areas: 0,
      maxAreaSets: 0,
      maxEdges: MAX_EDGES,
    };
  }
  if ("getSubsetData" in db && typeof db.getSubsetData === "function") {
    const data: unknown = db.getSubsetData();
    const subsets: unknown[] = Array.isArray(data) ? data : [];
    const sets = new Set<string>();
    let maxAreaSets = 0;
    for (const subset of subsets) {
      if (!subset || typeof subset !== "object" || !("sets" in subset) || !Array.isArray(subset.sets)) continue;
      maxAreaSets = Math.max(maxAreaSets, subset.sets.length);
      for (const set of subset.sets) {
        if (typeof set === "string") sets.add(set);
      }
    }
    return { nodes: 0, edges: 0, sets: sets.size, areas: subsets.length, maxAreaSets, maxEdges: MAX_EDGES };
  }
  return undefined;
}
function countStatements(source: string): number {
  return source.split(/[\r\n;]/).filter((statement) => statement.trim() !== "").length;
}
export async function exceedsLimits(source: string): Promise<boolean> {
  if (countStatements(source) > MAX_STATEMENTS) return true;
  try {
    // Site config is an upper bound; apply the diagram's own config only before refusing on nodes alone.
    mermaid.mermaidAPI.reset();
    const count = await measure(source);
    if (!count) return false;
    if (
      count.edges > count.maxEdges ||
      count.sets > MAX_VENN_SETS ||
      count.areas > MAX_VENN_AREAS ||
      count.maxAreaSets > MAX_VENN_SETS
    )
      return true;
    if (count.nodes <= MAX_NODES) return false;
    await mermaid.parse(source);
    const recounted = await measure(source);
    return (
      recounted !== undefined &&
      (recounted.nodes > MAX_NODES ||
        recounted.edges > recounted.maxEdges ||
        recounted.sets > MAX_VENN_SETS ||
        recounted.areas > MAX_VENN_AREAS ||
        recounted.maxAreaSets > MAX_VENN_SETS)
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Edge limit exceeded")) return true;
    throw error;
  }
}
export function startFrame(root: HTMLElement) {
  const systemTheme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const applyTheme = (theme: "dark" | "light", colors?: MermaidColors) => {
    mermaid.initialize(frameConfig(theme === "dark", colors));
    document.documentElement.style.colorScheme = theme;
  };
  applyTheme(systemTheme());
  let active = true;
  let pending: { source: string; theme: "dark" | "light"; colors?: MermaidColors } | undefined;
  let rendering = false;
  let sequence = 0;
  let natural: ReturnType<typeof naturalSize> | undefined;
  const size = () => {
    const measured = root.getBoundingClientRect().height;
    const height = Number.isFinite(measured) ? Math.max(1, Math.min(10000, Math.ceil(measured))) : 1;
    window.parent.postMessage({ type: "size", height, ...(natural === undefined ? {} : { natural }) }, "*");
  };
  const fallback = (message: string, source: string) => {
    const label = document.createElement("p");
    label.textContent = message;
    const text = document.createElement("pre");
    text.textContent = source;
    root.replaceChildren(label, text);
    natural = null;
  };
  const draw = async () => {
    if (rendering) return;
    rendering = true;
    try {
      while (active && pending !== undefined) {
        const { source, theme, colors } = pending;
        pending = undefined;
        applyTheme(theme, colors);
        if (source.length > MAX_SOURCE) {
          fallback("This diagram is too large to draw.", source);
          size();
          continue;
        }
        const staging = document.createElement("div");
        staging.style.visibility = "hidden";
        staging.style.position = "absolute";
        root.append(staging);
        try {
          const encoded = encodeCodes(source);
          const tooLarge = await exceedsLimits(encoded.source);
          if (active && pending === undefined) {
            if (tooLarge) {
              fallback("This diagram is too large to draw.", source);
            } else {
              const result = await mermaid.render(`diagram-${++sequence}`, encoded.source, staging);
              if (active && pending === undefined) {
                const svg = sanitizeSvg(result.svg);
                restoreCodes(svg, encoded.characters);
                root.replaceChildren(svg);
                natural = naturalSize(svg);
              }
            }
          }
        } catch {
          if (active && pending === undefined) fallback("This diagram could not be drawn.", source);
        } finally {
          staging.remove();
        }
        if (active) size();
      }
    } finally {
      rendering = false;
    }
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data: unknown = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("type" in data) ||
      data.type !== "render" ||
      !("source" in data) ||
      typeof data.source !== "string"
    )
      return;
    const theme = "theme" in data && (data.theme === "dark" || data.theme === "light") ? data.theme : systemTheme();
    pending = { source: data.source, theme, colors: parseColors("colors" in data ? data.colors : undefined) };
    void draw();
  };
  const observer = new ResizeObserver(size);
  observer.observe(root);
  window.addEventListener("message", receive);
  return () => {
    active = false;
    pending = undefined;
    observer.disconnect();
    window.removeEventListener("message", receive);
  };
}
const root = document.getElementById("diagram");
if (root) startFrame(root);
