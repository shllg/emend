import { BRIDGE_SOURCE } from "./bridge.ts";

/** Preserve the leading doctype so adding the stylesheet never forces quirks mode. */
export function injectLook(html: string, css: string): string {
  let at = html.startsWith("\uFEFF") ? 1 : 0;
  let doctype = false;
  while (at < html.length) {
    const space = /^[\t\n\f\r ]+/.exec(html.slice(at));
    if (space) {
      at += space[0].length;
      continue;
    }
    if (html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      if (end < 0) {
        // An incomplete leading comment is not a safe prefix; never back up past a doctype.
        if (!doctype) at = 0;
        break;
      }
      at = end + 3;
      continue;
    }
    const declaration = !doctype && /^<!doctype(?:[\t\n\f\r ][^>]*|)>/i.exec(html.slice(at));
    if (declaration) {
      at += declaration[0].length;
      doctype = true;
      continue;
    }
    break;
  }
  return `${html.slice(0, at)}<style>${css}</style>${html.slice(at)}`;
}

export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  // A </body> after the real close in a script string, comment or attribute takes the bridge, so that doc has none.
  let at = -1;
  for (const match of html.matchAll(/<\/body>/gi)) at = match.index;
  return at < 0 ? html + script : html.slice(0, at) + script + html.slice(at);
}
