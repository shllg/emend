import { toString as hastText } from "hast-util-to-string";
import { defaultSchema } from "rehype-sanitize";
import { type DocLinks, resolveDocLink } from "../links.ts";
import {
  type HtmlElement,
  type HtmlNode,
  type HtmlRoot,
  hasBlockChildren,
  renderData,
  visitElements,
} from "./blocks.ts";

const prefix = "user-content-";
const forbiddenTags = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "svg",
  "math",
  "noscript",
  "template",
  "textarea",
  "title",
  "xmp",
  "plaintext",
  "noembed",
  "select",
  "base",
  "meta",
  "link",
];
const droppedAttributes = new Set([
  "style",
  "htmlFor",
  "list",
  "headers",
  "useMap",
  "ariaLabelledBy",
  "ariaDescribedBy",
  "ariaControls",
  "ariaOwns",
  "cite",
  "longDesc",
  "srcSet",
  "action",
  "itemType",
  "itemProp",
  "itemScope",
  "accessKey",
  "tabIndex",
]);

// Narrow the default allowlist. In particular, do not enable arbitrary author classes.
export const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => !forbiddenTags.includes(tag)),
  clobberPrefix: prefix,
  attributes: Object.fromEntries(
    Object.entries(defaultSchema.attributes ?? {}).map(([tag, attributes]) => [
      tag,
      attributes.filter((attribute) => {
        const name = typeof attribute === "string" ? attribute : attribute[0];
        return !name.toLowerCase().startsWith("data") && !droppedAttributes.has(name);
      }),
    ]),
  ),
  protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"], src: ["http", "https"] },
  strip: [...new Set([...(defaultSchema.strip ?? []), ...forbiddenTags])],
};

export const FOOTNOTE_NODE = "emendFootnoteMarker";
type FootnoteNode = { type: typeof FOOTNOTE_NODE; data: { element: HtmlElement } };

function isGfmMarker(element: HtmlElement): boolean {
  if (element.tagName === "a" && Object.hasOwn(element.properties, "dataFootnoteBackref")) {
    return /^↩(\d+)?$/.test(hastText(element));
  }
  const link = element.children[0];
  return (
    element.tagName === "sup" &&
    element.children.length === 1 &&
    link?.type === "element" &&
    link.tagName === "a" &&
    Object.hasOwn(link.properties, "dataFootnoteRef") &&
    /^\d+$/.test(hastText(element))
  );
}

/** Run before rehype-raw: author HTML is still raw text, so only generated GFM nodes can match. */
export function markFootnotes() {
  return (tree: HtmlRoot) => {
    const pending: HtmlNode[] = [tree];
    for (let parent = pending.pop(); parent; parent = pending.pop()) {
      if (!("children" in parent)) continue;
      for (const [index, child] of parent.children.entries()) {
        if (child.type === "element" && isGfmMarker(child)) {
          renderData(child).emendFootnoteMarker = true;
          const carrier: FootnoteNode = { type: FOOTNOTE_NODE, data: { element: child } };
          // rehype-raw's documented passThrough supports custom nodes, outside HAST's standard union.
          parent.children[index] = carrier as unknown as HtmlElement;
        } else pending.push(child);
      }
    }
  };
}

/** Restore the original generated nodes before sanitize; raw HTML cannot create a custom AST type. */
export function restoreFootnotes() {
  return (tree: HtmlRoot) => {
    const pending: HtmlNode[] = [tree];
    for (let parent = pending.pop(); parent; parent = pending.pop()) {
      if (!("children" in parent)) continue;
      for (const [index, child] of parent.children.entries()) {
        if ((child as { type: string }).type === FOOTNOTE_NODE) {
          const element = (child as unknown as FootnoteNode).data.element;
          parent.children[index] = element;
          const link = element.children[0];
          if (element.tagName === "sup" && link?.type === "element") renderData(link).emendFootnoteMarker = true;
        } else pending.push(child);
      }
    }
  };
}

/** Store only generated, namespaced class tokens in AST metadata, never HTML attributes. */
export function namespaceClasses() {
  return (tree: HtmlRoot) => {
    visitElements(tree, (element) => {
      const classes = element.properties.className;
      if (!Array.isArray(classes)) return;
      renderData(element).emendClasses = classes.flatMap((value) =>
        String(value)
          .split(/\s+/)
          .filter(Boolean)
          .map((value) => (element.tagName === "code" && /^language-./.test(value) ? value : `${prefix}${value}`)),
      );
    });
  };
}

function isAbsoluteUrl(value: unknown, allowMail: boolean): value is string {
  if (typeof value !== "string") return false;
  // `http:other.md` and `http:/path` can resolve against the app's own origin.
  if (!/^https?:\/\//i.test(value) && !(allowMail && /^mailto:/i.test(value))) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || (allowMail && url.protocol === "mailto:");
  } catch {
    return false;
  }
}

/** A writeup image's displayed pixel size. */
export type MediaSize = { width: number; height: number };

const validSide = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;

export const MEDIA_URL_PREFIX = "/api/v1/media/";

/** Resolve a writeup image reference to a declared media path, or null. */
export function mediaKey(src: unknown, media: ReadonlyMap<string, string>): string | null {
  if (typeof src !== "string" || /^https?:\/\//i.test(src)) return null;
  let path = src.split(/[?#]/)[0] ?? "";
  while (path.startsWith("./")) path = path.slice(2);
  // An encoded slash would let one segment hide a path separator.
  if (/%2f/i.test(path)) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes(":") ||
    path.includes("\\") ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split("/").includes("..")
  )
    return null;
  return media.has(path) ? path : null;
}

function mediaSpan(image: HtmlElement, path: string, sha: string, sized: boolean): HtmlElement {
  const alt = typeof image.properties.alt === "string" ? image.properties.alt : "";
  const caption = alt === "" ? (path.split("/").at(-1) ?? path) : alt;
  const span: HtmlElement = {
    type: "element",
    tagName: "span",
    // The marker tells the client the width and height are the server's reading, not the author's.
    properties: { className: sized ? ["emend-media", "emend-media-sized"] : ["emend-media"] },
    children: [
      image,
      {
        type: "element",
        tagName: "span",
        properties: { className: ["emend-media-caption"] },
        children: [{ type: "text", value: caption }],
      },
    ],
  };
  renderData(span).emendMedia = JSON.stringify([alt, path, sha]);
  return span;
}

const isMediaSpan = (node: HtmlNode) => node.type === "element" && renderData(node).emendMedia !== undefined;

/** Wrap the images marked by the resolver and flag paragraphs that hold nothing else. */
function wrapMedia(
  node: HtmlNode,
  media: ReadonlyMap<string, string>,
  sizes: ReadonlyMap<string, MediaSize> | undefined,
) {
  if (!("children" in node)) return;
  for (const [index, child] of node.children.entries()) {
    if (child.type !== "element") continue;
    const marked = renderData(child).emendMediaPath;
    if (child.tagName === "img" && typeof marked === "string") {
      const sha = media.get(marked) ?? "";
      child.properties.src = `${MEDIA_URL_PREFIX}${sha}`;
      child.properties.loading = "lazy";
      child.properties.decoding = "async";
      // Author-written sizes are never trusted; only the server's reading of the stored bytes is.
      delete child.properties.width;
      delete child.properties.height;
      const size = sizes?.get(sha);
      const sized = size !== undefined && validSide(size.width) && validSide(size.height);
      if (sized) {
        child.properties.width = size.width;
        child.properties.height = size.height;
      }
      node.children[index] = mediaSpan(child, marked, sha, sized);
    } else wrapMedia(child, media, sizes);
  }
  if (node.type === "element" && node.tagName === "p") {
    const spans = node.children.filter(isMediaSpan);
    const rest = node.children.filter((child) => !isMediaSpan(child));
    if (spans.length > 0 && rest.every((child) => child.type === "text" && child.value.trim() === "")) {
      const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
      node.properties.className = [...classes, "emend-media-row"];
    }
  }
}

/** Runs only after sanitize. AST metadata cannot be supplied through raw HTML attributes. */
export function hardenLinks() {
  return (tree: HtmlRoot, file: { data: Record<string, unknown> }) => {
    const media = file.data.media as ReadonlyMap<string, string> | undefined;
    const sizes = file.data.mediaSizes as ReadonlyMap<string, MediaSize> | undefined;
    const docs = file.data.docs as DocLinks | undefined;
    const base = typeof file.data.docBase === "string" ? file.data.docBase : "";
    visitElements(tree, (element) => {
      const classes = renderData(element).emendClasses;
      if (
        Array.isArray(classes) &&
        classes.every(
          (value) =>
            typeof value === "string" &&
            (value.startsWith(prefix) || (element.tagName === "code" && /^language-./.test(value))),
        )
      ) {
        element.properties.className = classes;
      }
      const { href, src } = element.properties;
      if (isAbsoluteUrl(href, true) && !(element.tagName === "a" && hasBlockChildren(element))) {
        element.properties.rel = ["noopener", "noreferrer", "nofollow"];
        // Only the server decides: an absolute web link opens in a new tab and never replaces the app.
        if (element.tagName === "a" && /^https?:/i.test(href)) element.properties.target = "_blank";
        else delete element.properties.target;
      } else {
        delete element.properties.href;
        delete element.properties.rel;
        delete element.properties.target;
        if (
          docs &&
          element.tagName === "a" &&
          !renderData(element).emendFootnoteMarker &&
          !hasBlockChildren(element) &&
          typeof href === "string"
        ) {
          // Queries are discarded here; the shared resolver itself refuses them.
          const hash = href.indexOf("#");
          const query = href.indexOf("?");
          const lookup =
            query >= 0 && (hash < 0 || query < hash) ? href.slice(0, query) + (hash < 0 ? "" : href.slice(hash)) : href;
          // Even a missing target can resolve in another folder. Fragment-only links
          // additionally depend on the filename, so those cannot share a folder render.
          file.data.docBaseUsed = true;
          if (lookup.startsWith("#")) file.data.docPathUsed = true;
          const link = resolveDocLink(base, lookup, docs);
          if (link) {
            const params = new URLSearchParams({ tab: "docs", doc: link.path });
            const id = link.fragment ? docs.get(link.path)?.get(link.fragment) : undefined;
            const heading = id ? `#h-${encodeURIComponent(id)}` : "";
            element.properties.href = `?${params}${heading}`;
          }
        }
      }
      if (element.tagName === "img") {
        // The app CSP allows only same-origin images, and an absolute same-origin URL could show
        // another review's media. An image keeps a source only when it names a declared media path.
        const path = media ? mediaKey(src, media) : null;
        if (path !== null) renderData(element).emendMediaPath = path;
        else delete element.properties.src;
      } else if (!isAbsoluteUrl(src, false)) delete element.properties.src;
    });
    // Generated classes are set after the namespaced author classes, on nodes made here.
    if (media && media.size > 0) wrapMedia(tree, media, sizes);
  };
}
