import { BRIDGE_SOURCE } from "./bridge.ts";

/** Preserve the leading doctype so adding the stylesheet never forces quirks mode. */
export function injectLook(html: string, css: string, light = false): string {
  let at = html.startsWith("\uFEFF") ? 1 : 0;
  let doctype = false;
  while (at < html.length) {
    const space = /^[\t\n\f\r ]+/.exec(html.slice(at));
    if (space) {
      at += space[0].length;
      continue;
    }
    if (html.startsWith("<!--", at)) {
      const content = at + 4;
      if (html[content] === ">") at = content + 1;
      else if (html.startsWith("->", content)) at = content + 2;
      else {
        const end = /--!?>/g;
        end.lastIndex = content;
        const match = end.exec(html);
        if (!match) break;
        at = match.index + match[0].length;
      }
      continue;
    }
    const declaration = /^<!doctype/i.test(html.slice(at));
    if (declaration && !doctype) {
      const end = html.indexOf(">", at + 9);
      if (end < 0) break;
      at = end + 1;
      doctype = true;
      continue;
    }
    if (
      html.startsWith("<?", at) ||
      (html.startsWith("<!", at) && !declaration) ||
      (html.startsWith("</", at) && at + 2 < html.length && !/[a-z]/i.test(html[at + 2] ?? ""))
    ) {
      const end = html.indexOf(">", at + 2);
      if (end < 0) break;
      at = end + 1;
      continue;
    }
    break;
  }
  return `${html.slice(0, at)}${light ? '<html data-theme="light">' : ""}<style>${css}</style>${html.slice(at)}`;
}

export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  // A </body> after the real close in a script string, comment or attribute takes the bridge, so that doc has none.
  let at = -1;
  for (const match of html.matchAll(/<\/body>/gi)) at = match.index;
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}
