const kinds = ["a script", "an event handler", "embedded HTML", "an outside link"] as const;
type Kind = (typeof kinds)[number];

/** Scan source as text. The preview never needs to parse it into DOM nodes. */
export function svgActiveKinds(source: string): Kind[] {
  const found = new Set<Kind>();
  const checkUrl = (raw: string) => {
    const url = raw.trim();
    if (url && !/^(?:#|data:)/i.test(url)) found.add("an outside link");
  };
  if (/\bjavascript:/i.test(source)) found.add("a script");
  for (const match of source.matchAll(/<([a-z][\w:.-]*)(?=[\s/>])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>/gi)) {
    const name = match[1]?.toLowerCase();
    if (name === "script") found.add("a script");
    if (name === "foreignobject") found.add("embedded HTML");
    const attributes = match[2] ?? "";
    for (const attr of attributes.matchAll(/\s([^\s="'<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      if (/^on[a-z]+$/i.test(attr[1] ?? "")) found.add("an event handler");
      if (/^(?:href|xlink:href|src)$/i.test(attr[1] ?? "")) checkUrl(attr[2] ?? attr[3] ?? attr[4] ?? "");
    }
  }
  for (const url of source.matchAll(/\burl\(\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s()"'<>]+))/gi))
    checkUrl(url[1] ?? url[2] ?? url[3] ?? "");
  return kinds.filter((kind) => found.has(kind));
}
