const kinds = ["a script", "an event handler", "embedded HTML", "an outside link"] as const;
type Kind = (typeof kinds)[number];
type SvgScan = { kinds: Kind[]; unchecked: boolean };
export const uncheckedSvg: SvgScan = { kinds: [], unchecked: true };

const xmlEntities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
const animationElements = new Set(["set", "animate", "animatemotion", "animatetransform"]);
const asciiSpacing = "[\\x00-\\x20\\x7f]*";
const scriptScheme = new RegExp(`\\b${[..."javascript:"].join(asciiSpacing)}`, "i");

function decodeReferences(text: string) {
  return text.replace(/&(?:#(\d+)|#[xX]([\da-fA-F]+)|(amp|apos|gt|lt|quot));/g, (ref, decimal, hex, name) => {
    if (name) return xmlEntities[name] ?? ref;
    const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
  });
}

function localName(name: string) {
  return name.slice(name.lastIndexOf(":") + 1).toLowerCase();
}

function isUrlAttribute(name: string) {
  return name === "href" || name === "src";
}

function readAttributes(text: string) {
  const matches = text.matchAll(/\s([^\s="'<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g);
  return Array.from(matches, ([, name, doubleQuoted, singleQuoted, bare]) => ({
    name: localName(name ?? ""),
    value: decodeReferences(doubleQuoted ?? singleQuoted ?? bare ?? ""),
  }));
}

/** Scan source as text. The preview never needs to parse it into DOM nodes. */
export function scanSvg(source: string): SvgScan {
  if (/<!ENTITY\b/i.test(source)) return uncheckedSvg;
  const found = new Set<Kind>();
  const checkUrl = (raw: string) => {
    const url = raw.trim();
    if (url && !/^(?:#|data:)/i.test(url)) found.add("an outside link");
  };
  const decoded = decodeReferences(source);
  if (scriptScheme.test(decoded)) found.add("a script");
  if (/@import\b/i.test(decoded) || /<\?xml-stylesheet\b/i.test(source)) found.add("an outside link");
  // Tokenize the original markup so references to quotes cannot end an attribute.
  for (const match of source.matchAll(/<([^\s<>=/"'!?]+)(?=[\s/>])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/g)) {
    const name = localName(match[1] ?? "");
    if (name === "script") found.add("a script");
    if (name === "foreignobject") found.add("embedded HTML");
    const attributes = readAttributes(match[2] ?? "");
    for (const attr of attributes) {
      if (/^on[a-z]+$/.test(attr.name)) found.add("an event handler");
      if (isUrlAttribute(attr.name)) checkUrl(attr.value);
    }
    if (!animationElements.has(name)) continue;
    const targetsUrl = attributes.some(
      (attr) => attr.name === "attributename" && isUrlAttribute(localName(attr.value.trim())),
    );
    if (!targetsUrl) continue;
    for (const attr of attributes) {
      if (attr.name === "values") {
        for (const entry of attr.value.split(";")) checkUrl(entry);
      } else if (attr.name === "to" || attr.name === "from" || attr.name === "by") checkUrl(attr.value);
    }
  }
  for (const url of decoded.matchAll(/\burl\(\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s()"'<>]+))/gi))
    checkUrl(url[1] ?? url[2] ?? url[3] ?? "");
  return { kinds: kinds.filter((kind) => found.has(kind)), unchecked: false };
}
