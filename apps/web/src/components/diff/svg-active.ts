const kinds = ["a script", "an event handler", "embedded HTML", "an outside link"] as const;
type Kind = (typeof kinds)[number];
type SvgScan = { kinds: Kind[]; unchecked: boolean };
export const uncheckedSvg: SvgScan = { kinds: [], unchecked: true };

const xmlEntities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
const animationElements = new Set(["set", "animate", "animatemotion", "animatetransform"]);
const urlAttributes = new Set(["href", "src", "data", "action", "formaction", "poster", "background"]);
// Treat non-ASCII name characters conservatively when a reference survives decoding.
const unknownReference = /&(?!(?:amp|apos|gt|lt|quot);)[a-zA-Z_:\u0080-\u{10ffff}][\w.:\u0080-\u{10ffff}-]*;/u;
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

function isOutsideUrl(raw: string) {
  const url = raw.trim();
  return url !== "" && !/^(?:#|data:)/i.test(url);
}

function hasOutsideSrcset(value: string) {
  // Commas inside a URL belong to it (including data URLs). A trailing comma ends the candidate.
  const urls = /[^,\t\n\f\r ][^\t\n\f\r ]*/g;
  for (let match = urls.exec(value); match; match = urls.exec(value)) {
    if (isOutsideUrl(match[0])) return true;
    if (match[0].endsWith(",")) continue;
    // Descriptors run to the next comma outside parentheses.
    let inParens = false;
    while (urls.lastIndex < value.length) {
      const character = value[urls.lastIndex++];
      if (character === "(") inParens = true;
      else if (character === ")") inParens = false;
      else if (character === "," && !inParens) break;
    }
  }
  return false;
}

function readAttributes(text: string) {
  const attributes = [];
  let end = 0;
  for (const match of text.matchAll(/\s+([^\s="'<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/gy)) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    attributes.push({
      name: localName(name ?? ""),
      value: decodeReferences(doubleQuoted ?? singleQuoted ?? bare ?? ""),
    });
    end = match.index + match[0].length;
  }
  return { attributes, unchecked: !/^\s*\/?$/.test(text.slice(end)) };
}

/** Scan source as text. The preview never needs to parse it into DOM nodes. */
export function scanSvg(source: string): SvgScan {
  if (/<!ENTITY\b/i.test(source)) return uncheckedSvg;
  const found = new Set<Kind>();
  const checkUrl = (raw: string) => {
    if (isOutsideUrl(raw)) found.add("an outside link");
  };
  const decoded = decodeReferences(source);
  let unchecked = decoded.includes("\\") || /image-set\(/i.test(decoded) || unknownReference.test(decoded);
  if (decoded.includes("http://www.w3.org/1999/xhtml")) found.add("embedded HTML");
  if (scriptScheme.test(decoded)) found.add("a script");
  if (/@import\b/i.test(decoded) || /<\?xml-stylesheet\b/i.test(source)) found.add("an outside link");
  // Tokenize the original markup so references to quotes cannot end an attribute.
  // Match even a bare tag start so an incomplete or unrecognized tag marks the scan unchecked.
  for (const match of source.matchAll(/<([^\s<>=/"'!?]+)(?:(?=[\s/>])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>)?/g)) {
    if (match[2] === undefined) {
      unchecked = true;
      continue;
    }
    const name = localName(match[1] ?? "");
    if (name === "script") found.add("a script");
    if (name === "foreignobject") found.add("embedded HTML");
    const { attributes, unchecked: uncheckedAttributes } = readAttributes(match[2]);
    unchecked ||= uncheckedAttributes;
    for (const attr of attributes) {
      if (/^on[a-z]+$/.test(attr.name)) found.add("an event handler");
      if (attr.name === "srcdoc") found.add("a script");
      if (urlAttributes.has(attr.name)) checkUrl(attr.value);
      if (attr.name === "srcset" && hasOutsideSrcset(attr.value)) found.add("an outside link");
    }
    if (!animationElements.has(name)) continue;
    const targetsUrl = attributes.some(
      (attr) => attr.name === "attributename" && urlAttributes.has(localName(attr.value.trim())),
    );
    if (!targetsUrl) continue;
    for (const attr of attributes) {
      if (attr.name === "values") {
        for (const entry of attr.value.split(";")) checkUrl(entry);
      } else if (attr.name === "to" || attr.name === "from" || attr.name === "by") checkUrl(attr.value);
    }
  }
  for (const url of decoded.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^\s()"'<>]+))/gi))
    checkUrl(url[1] ?? url[2] ?? url[3] ?? "");
  return { kinds: kinds.filter((kind) => found.has(kind)), unchecked };
}
