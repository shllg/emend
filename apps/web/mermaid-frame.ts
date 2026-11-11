import mermaid, { type MermaidConfig } from "mermaid";

const MAX_SOURCE = 50000;
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
export function frameConfig(dark: boolean): MermaidConfig {
  // sRGB: bg-sunken, bg-surface, fg-1/2/3, border-2, topic-bg-2 and topic-solid.
  const [sunken, surface, fg, fg2, fg3, border, topicBg, topic] = dark
    ? ["#060708", "#111213", "#f4f4f6", "#c4c6c8", "#9d9ea1", "#2a2b2d", "#043232", "#00a19d"]
    : ["#f4f4f6", "#fdfdfe", "#111213", "#444547", "#5f6063", "#c4c6c8", "#c2f3f0", "#00807e"];
  return {
    theme: "base",
    fontFamily: "system-ui, sans-serif",
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
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    maxTextSize: MAX_SOURCE,
    secure: [
      ...new Set([
        ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "flowchart",
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
export function startFrame(root: HTMLElement) {
  mermaid.initialize(frameConfig(matchMedia("(prefers-color-scheme: dark)").matches));
  let active = true;
  let pending: string | undefined;
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
        const source = pending;
        pending = undefined;
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
          const result = await mermaid.render(`diagram-${++sequence}`, source, staging);
          if (active && pending === undefined) {
            const svg = sanitizeSvg(result.svg);
            root.replaceChildren(svg);
            natural = naturalSize(svg);
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
    pending = data.source;
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
