import {
  OTHER_TOPIC,
  type PublishLinks,
  type RenderedBlock,
  type RenderedWriteup,
  type SourceContent,
  type TopicMeta,
} from "@emend/contract";
import { fromHtml } from "hast-util-from-html";
import { toString as hastText } from "hast-util-to-string";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { HtmlElement as Element, HtmlRoot as Root } from "./blocks.ts";
import { MEDIA_URL_PREFIX } from "./sanitize.ts";

type ElementContent = Element["children"][number];
type RootContent = Root["children"][number];
type Properties = Element["properties"];
type Text = Extract<ElementContent, { type: "text" }>;

export const DOWNLOAD_FILE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";
export type DownloadAsset = { mediaType: string; bytes: Uint8Array };
export type ResolveResult = DownloadAsset | null | "too-large";
export type DownloadResolver = (path: string) => Promise<ResolveResult>;
export type DownloadDetails = {
  project: string | null;
  branch: string | null;
  seq: number;
  publishedAt: string;
  links: PublishLinks | undefined;
};
type PageInput = { title: string; details: DownloadDetails; resolveMedia: DownloadResolver };

// Literal reading tokens keep the exported page independent of the app and its fonts.
const READING_STYLES = `
:root{color-scheme:light dark;--bg:oklch(.985 .001 260);--sunken:oklch(.968 .002 260);--fg:oklch(.49 .004 260);--strong:oklch(.18 .004 260);--muted:oklch(.55 .004 260);--border:oklch(.895 .003 260);--link:oklch(.42 .09 60)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/1.7 ui-sans-serif,system-ui,sans-serif}.em-download{max-width:68ch;margin:auto;padding:32px 20px;overflow-wrap:break-word}h1,h2,h3,h5,h6,strong,code{color:var(--strong)}h1{font-size:24px;line-height:1.2;letter-spacing:-.015em;margin:0 0 16px}h2{font-size:19px;line-height:1.3;letter-spacing:-.01em;margin:36px 0 12px}h3{font-size:16px;line-height:1.35;margin:24px 0 6px}h4{font:600 11px/1.3 ui-monospace,"SF Mono",Menlo,monospace;text-transform:uppercase;letter-spacing:.04em}h1,h2,h3{font-weight:600}p,ul,ol{margin:0 0 12px}ul,ol{padding-left:22px}li{margin:6px 0}a{color:var(--link)}a :is(strong,code){color:inherit}.em-doc-link{color:inherit}code{font:400 .84em/1 ui-monospace,"SF Mono",Menlo,monospace;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--sunken)}pre{margin:0 0 14px;padding:12px 14px;border:1px solid var(--border);border-radius:6px;background:var(--sunken);overflow:auto;font:400 12px/1.6 ui-monospace,"SF Mono",Menlo,monospace}pre code{padding:0;border:0;background:none;font:inherit}.shiki{background-color:var(--shiki-light-bg,var(--sunken))}.shiki,.shiki span{color:var(--shiki-light,inherit)}blockquote{margin:0 0 12px;padding-left:14px;border-left:2px solid var(--border)}table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:0 0 14px;font-size:14px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border)}th{font-weight:500}hr{border:0;border-top:1px solid var(--border);margin:24px 0}img{max-width:100%;height:auto}.emend-media{display:inline-block;max-width:100%;vertical-align:top}.emend-media img{display:block;border-radius:6px}.emend-media-caption{display:block;margin-top:6px;overflow-wrap:anywhere}.em-meta,.emend-media-caption,figcaption,footer,.em-topic-blast,.em-link-host{font:400 12px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}.em-links{list-style:none;padding:0}.em-link-host{margin-left:6px}.em-diagram{margin:16px 0}.em-diagram figcaption{margin-bottom:6px}.em-download-note{padding:12px 14px;border:1px solid var(--border);border-radius:6px;background:var(--sunken)}footer{border-top:1px solid var(--border);margin-top:36px;padding-top:16px}
@media(prefers-color-scheme:dark){:root{--bg:oklch(.18 .004 260);--sunken:oklch(.125 .004 260);--fg:oklch(.79 .004 260);--strong:oklch(.895 .003 260);--muted:oklch(.7 .004 260);--border:oklch(.25 .004 260);--link:oklch(.85 .14 81)}.shiki{background-color:var(--shiki-dark-bg,var(--sunken))}.shiki,.shiki span{color:var(--shiki-dark,inherit)}}
`;
const rel = ["noopener", "noreferrer", "nofollow"];
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const text = (value: string): Text => ({ type: "text", value });
const element = (tagName: string, children: ElementContent[] = [], properties: Properties = {}): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});
const style = (css: string, properties: Properties = {}) =>
  element("style", [text(css.replace(/<\/style/gi, "<\\/style"))], properties);
const serialize = (tree: Root) =>
  String(unified().use(rehypeStringify, { allowDangerousCharacters: false }).stringify(tree));
const note = () =>
  element("p", [text("Some images or files were left out because the download would pass 128 MiB.")], {
    className: ["em-download-note"],
  });
const headMetas = () => [
  element("meta", [], { charSet: "utf-8" }),
  element("meta", [], { httpEquiv: ["Content-Security-Policy"], content: DOWNLOAD_FILE_CSP }),
  element("meta", [], { name: "referrer", content: "no-referrer" }),
];
function absoluteLink(value: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
function dataUri(asset: DownloadAsset): string {
  const chunks: string[] = [];
  for (let i = 0; i < asset.bytes.length; i += 0x8000)
    chunks.push(String.fromCharCode(...asset.bytes.subarray(i, i + 0x8000)));
  return `data:${asset.mediaType};base64,${btoa(chunks.join(""))}`;
}
function resolverState(resolve: DownloadResolver) {
  const cache = new Map<string, Promise<DownloadAsset | null>>();
  const state = {
    tooLarge: false,
    get(path: string): Promise<DownloadAsset | null> {
      let result = cache.get(path);
      if (!result) {
        result = resolve(path).then((asset) => {
          if (asset === "too-large") {
            state.tooLarge = true;
            return null;
          }
          return asset;
        });
        cache.set(path, result);
      }
      return result;
    },
  };
  return state;
}
type AssetState = ReturnType<typeof resolverState>;
function frame(input: PageInput, content: ElementContent[], tooLarge: boolean): string {
  const { title, details } = input;
  const links = (details.links ?? []).flatMap((link) => {
    try {
      const url = new URL(link.url);
      if (url.protocol !== "https:" || url.username || url.password) return [];
      return [
        element("li", [
          element("a", [text(link.label)], { href: url.href, rel }),
          element("span", [text(url.host)], { className: ["em-link-host"] }),
        ]),
      ];
    } catch {
      return [];
    }
  });
  const meta = [
    details.project,
    details.branch,
    `Revision ${details.seq}`,
    new Date(details.publishedAt).toISOString().slice(0, 10),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return serialize({
    type: "root",
    children: [
      { type: "doctype" },
      element(
        "html",
        [
          element("head", [
            ...headMetas(),
            element("meta", [], { name: "viewport", content: "width=device-width, initial-scale=1" }),
            element("meta", [], { name: "color-scheme", content: "light dark" }),
            element("title", [text(title)]),
            style(READING_STYLES),
          ]),
          element("body", [
            element(
              "main",
              [
                ...(tooLarge ? [note()] : []),
                element("header", [
                  element("h1", [text(title)]),
                  element("p", [text(meta)], { className: ["em-meta"] }),
                  ...(links.length ? [element("ul", links, { className: ["em-links"] })] : []),
                ]),
                ...content,
                element("footer", [text("Downloaded from emend.")]),
              ],
              { className: ["em-download"] },
            ),
          ]),
        ],
        { lang: "en" },
      ),
    ],
  });
}
const blockRemoved = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "link",
  "meta",
  "base",
  "form",
  "template",
  "noscript",
]);
const blockAttributes = new Set(["ping", "srcset", "srcdoc", "formaction", "action"]);
function stripAttributes(el: Element, removed: Set<string>) {
  for (const key of Object.keys(el.properties))
    if (/^on/i.test(key) || removed.has(key.toLowerCase())) delete el.properties[key];
}
async function transformBlocks(parent: Root | Element, state: AssetState): Promise<void> {
  const children: ElementContent[] = [];
  for (const node of parent.children) {
    if (node.type === "text") {
      children.push(node);
      continue;
    }
    if (node.type !== "element" || blockRemoved.has(node.tagName.toLowerCase())) continue;
    stripAttributes(node, blockAttributes);
    if (typeof node.properties.style === "string" && /url\s*\(|expression\s*\(/i.test(node.properties.style))
      delete node.properties.style;
    if (node.tagName === "img") {
      const src = String(node.properties.src ?? "");
      const hash = src.startsWith(MEDIA_URL_PREFIX) ? src.slice(MEDIA_URL_PREFIX.length) : "";
      const asset = /^[0-9a-f]{64}$/.test(hash) ? await state.get(hash) : null;
      if (!asset || !imageTypes.has(asset.mediaType)) continue;
      node.properties.src = dataUri(asset);
    }
    if (node.tagName === "a") {
      if (absoluteLink(String(node.properties.href ?? ""))) {
        node.properties.rel = rel;
        delete node.properties.target;
        delete node.properties.download;
      } else {
        node.tagName = "span";
        node.properties = { className: ["em-doc-link"] };
      }
    }
    await transformBlocks(node, state);
    children.push(node);
  }
  parent.children = children;
}
async function blocksContent(blocks: RenderedBlock[], state: AssetState): Promise<ElementContent[]> {
  const children: ElementContent[] = [];
  for (const block of blocks) {
    if (block.kind === "diagram") {
      children.push(
        element(
          "figure",
          [
            element("figcaption", [text("Mermaid diagram")]),
            element("pre", [element("code", [text(block.source ?? block.text)])]),
          ],
          { className: ["em-diagram"] },
        ),
      );
    } else {
      const tree = fromHtml(block.html, { fragment: true });
      await transformBlocks(tree, state);
      children.push(...tree.children.filter((node): node is ElementContent => node.type !== "doctype"));
    }
  }
  return children;
}
export async function buildWriteupDownload(
  input: PageInput & { writeup: RenderedWriteup; topics: TopicMeta[] },
): Promise<string> {
  const state = resolverState(input.resolveMedia);
  // Revisions arrive in review order. The reserved Other topic never receives a rank.
  const ranked = input.topics.filter((topic) => topic.slug !== OTHER_TOPIC.slug);
  const bySlug = new Map(ranked.map((topic) => [topic.slug, topic]));
  const groups: { key: string; node: Element }[] = [];
  const written = new Map<string, Element>();
  for (const section of input.writeup.sections) {
    const topic = section.topic ? bySlug.get(section.topic) : undefined;
    const content = await blocksContent(section.blocks, state);
    if (!topic) {
      groups.push({
        key: section.key,
        node: element("section", [
          element("h2", [text(section.key === "decisions" ? "Decisions & drift" : section.label)]),
          ...content,
        ]),
      });
      continue;
    }
    let group = written.get(topic.slug);
    if (!group) {
      group = element("section", [element("h2", [text(topic.title)]), element("p", [text(topic.summary)])], {
        id: `topic-${topic.slug}`,
      });
      if (topic.blastRadius)
        group.children.push(
          element(
            "p",
            [
              text("Blast radius: "),
              element("strong", [text(topic.blastRadius.scope)]),
              text(` — ${topic.blastRadius.note}`),
            ],
            { className: ["em-topic-blast"] },
          ),
        );
      written.set(topic.slug, group);
      groups.push({ key: section.key, node: group });
    }
    const suffix = section.key.slice(section.key.lastIndexOf("-") + 1);
    group.children.push(
      element("h3", [text(suffix === "why" ? "Why" : suffix === "example" ? "Example" : "Details")]),
      ...content,
    );
  }
  if (ranked.length) {
    const intro = ["overview", "tldr", "outOfScope", "whereToLook", "context", "decisions", "glossary"];
    const index = groups.findLastIndex((group) => intro.includes(group.key)) + 1;
    groups.splice(index, 0, {
      key: "topics",
      node: element("section", [
        element("h2", [text("Topics")]),
        element(
          "ol",
          ranked.map((topic, index) =>
            element(
              "li",
              [
                written.has(topic.slug)
                  ? element("a", [text(topic.title)], { href: `#topic-${topic.slug}` })
                  : element("span", [text(topic.title)]),
                element("p", [text(topic.summary)]),
              ],
              { value: String(index + 1) },
            ),
          ),
        ),
      ]),
    });
  }
  return frame(
    input,
    groups.map((group) => group.node),
    state.tooLarge,
  );
}
export async function buildDocDownload(
  input: PageInput & {
    content: { kind: "markdown"; blocks: RenderedBlock[] } | { kind: "source"; lines: SourceContent["lines"] };
  },
): Promise<string> {
  const state = resolverState(input.resolveMedia);
  let content: ElementContent[];
  if (input.content.kind === "markdown") content = await blocksContent(input.content.blocks, state);
  else {
    const lines: ElementContent[] = [];
    input.content.lines.forEach((line, index) => {
      if (index) lines.push(text("\n"));
      lines.push(
        element(
          "span",
          line.map((token) => {
            const colors = (["light", "dark"] as const).flatMap((mode) => {
              const color = token[mode];
              return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? [`--shiki-${mode}:${color}`] : [];
            });
            return element("span", [text(token.text)], colors.length ? { style: colors.join(";") } : {});
          }),
          { className: ["line"] },
        ),
      );
    });
    content = [element("pre", [element("code", lines)], { className: ["shiki", "em-source"] })];
  }
  return frame(input, content, state.tooLarge);
}

/** Resolve once, with browser path semantics, but never let a reference pick an origin. */
function assetPath(ref: string, basePath: string): string | null {
  ref = ref.trim();
  if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || /[\\\p{Cc}]/u.test(ref)) return null;
  try {
    const url = new URL(ref, `https://download.invalid/${basePath.split("/").map(encodeURIComponent).join("/")}`);
    if (url.origin !== "https://download.invalid") return null;
    const segments = url.pathname.slice(1).split("/").map(decodeURIComponent);
    if (segments.some((segment) => /[/\\\p{Cc}]/u.test(segment))) return null;
    return segments.join("/");
  } catch {
    return null;
  }
}
const fragment = (value: string) => /^#[^\s]*$/.test(value);
const resourceType = (asset: DownloadAsset) => !["text/javascript", "text/css"].includes(asset.mediaType);
const cssValue = (value: string) => value.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
// Import and URL alternatives share a pass so rewritten imports keep their own base path.
const cssReferences =
  /@import\s+(?:url\(\s*("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^)]*)\s*\)|("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'))[^;{}]*(?:;|$)|url\(\s*("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|[^)]*)\s*\)/gi;
async function rewriteCss(css: string, basePath: string, state: AssetState, chain: string[] = []): Promise<string> {
  const parts: string[] = [];
  let offset = 0;
  for (const match of css.matchAll(cssReferences)) {
    parts.push(css.slice(offset, match.index));
    offset = match.index + match[0].length;
    const isImport = /^@import/i.test(match[0]);
    const value = cssValue(match[1] ?? match[2] ?? match[3] ?? "");
    if (!isImport && (/^data:/i.test(value) || fragment(value))) {
      parts.push(match[0]);
      continue;
    }
    const path = assetPath(value, basePath);
    if (isImport) {
      if (!path || chain.length >= 4 || chain.includes(path)) continue;
      const asset = await state.get(path);
      if (asset?.mediaType === "text/css")
        parts.push(await rewriteCss(new TextDecoder().decode(asset.bytes), path, state, [...chain, path]));
    } else {
      const asset = path ? await state.get(path) : null;
      parts.push(`url("${asset && resourceType(asset) ? dataUri(asset) : "data:,"}")`);
    }
  }
  parts.push(css.slice(offset));
  return parts.join("");
}
const htmlRemoved = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "base",
  "template",
]);
const htmlAttributes = new Set(["ping", "srcdoc", "formaction", "action", "integrity", "nonce", "download", "target"]);
const srcTags = new Set(["img", "source", "video", "audio", "track", "input"]);
const svgResourceTags = new Set(["image", "use", "feimage"]);
export async function buildHtmlDocDownload(input: {
  html: string;
  docPath: string;
  title: string;
  resolveAsset: DownloadResolver;
}): Promise<string> {
  const tree = fromHtml(input.html);
  const state = resolverState(input.resolveAsset);
  const resource = async (value: string) => {
    if (fragment(value)) return value;
    const path = assetPath(value, input.docPath);
    const asset = path ? await state.get(path) : null;
    return asset && resourceType(asset) ? dataUri(asset) : null;
  };
  async function walk(parent: Root | Element): Promise<void> {
    const children: RootContent[] = [];
    for (const node of parent.children) {
      if (node.type !== "element") {
        if (node.type !== "comment") children.push(node);
        continue;
      }
      const tag = node.tagName.toLowerCase();
      if (htmlRemoved.has(tag) || (tag === "meta" && ("httpEquiv" in node.properties || "charSet" in node.properties)))
        continue;
      stripAttributes(node, htmlAttributes);
      if (tag === "link") {
        const rels = String(node.properties.rel ?? "")
          .toLowerCase()
          .split(/[\s,]+/);
        const path = rels.includes("stylesheet") ? assetPath(String(node.properties.href ?? ""), input.docPath) : null;
        const asset = path ? await state.get(path) : null;
        if (path && asset?.mediaType === "text/css")
          children.push(
            style(
              await rewriteCss(new TextDecoder().decode(asset.bytes), path, state, [path]),
              node.properties.media ? { media: node.properties.media } : {},
            ),
          );
        continue;
      }
      if (typeof node.properties.style === "string")
        node.properties.style = await rewriteCss(node.properties.style, input.docPath, state);
      if (tag === "form") delete node.properties.method;
      const resources = [
        "data",
        ...(srcTags.has(tag) ? ["src"] : []),
        ...(tag === "video" ? ["poster"] : []),
        ...(svgResourceTags.has(tag) ? ["href", "xLinkHref"] : []),
      ];
      for (const key of resources) {
        if (!(key in node.properties)) continue;
        const value = await resource(String(node.properties[key]));
        if (value === null) delete node.properties[key];
        else node.properties[key] = value;
      }
      if ((tag === "img" || tag === "source") && node.properties.srcSet) {
        const candidates: string[] = [];
        for (const candidate of String(node.properties.srcSet).split(",")) {
          const [ref, ...descriptors] = candidate.trim().split(/\s+/);
          if (!ref || !descriptors.every((item) => /^\d+(?:\.\d+)?[wxh]$/.test(item))) continue;
          const value = await resource(ref);
          if (value) candidates.push([value, ...descriptors].join(" "));
        }
        if (candidates.length) node.properties.srcSet = candidates.join(", ");
        else delete node.properties.srcSet;
      }
      if (tag === "a")
        for (const key of ["href", "xLinkHref"]) {
          const value = String(node.properties[key] ?? "");
          if (absoluteLink(value)) node.properties.rel = rel;
          else if (!fragment(value)) delete node.properties[key];
        }
      if (tag === "style") {
        children.push(style(await rewriteCss(hastText(node), input.docPath, state), node.properties));
        continue;
      }
      await walk(node);
      children.push(node);
    }
    // A doctype belongs only to the root; fromHtml enforces this when parsing.
    if (parent.type === "root") parent.children = children;
    else parent.children = children.filter((node): node is ElementContent => node.type !== "doctype");
  }
  await walk(tree);
  let html = tree.children.find((node): node is Element => node.type === "element" && node.tagName === "html");
  if (!html) {
    html = element("html");
    tree.children.push(html);
  }
  let head = html.children.find((node): node is Element => node.type === "element" && node.tagName === "head");
  if (!head) {
    head = element("head");
    html.children.unshift(head);
  }
  head.children.unshift(...headMetas());
  if (!head.children.some((node) => node.type === "element" && node.tagName === "title"))
    head.children.push(element("title", [text(input.title)]));
  let body = html.children.find((node): node is Element => node.type === "element" && node.tagName === "body");
  if (!body) {
    body = element("body");
    html.children.push(body);
  }
  if (state.tooLarge) body.children.unshift(note());
  if (!tree.children.some((node) => node.type === "doctype")) tree.children.unshift({ type: "doctype" });
  return serialize(tree);
}
