import { type HtmlCodeColour, htmlCodeColours } from "@emend/core";

export const CODE_COLOURS_CACHE_LIMIT = 16;
const colours = new Map<string, Promise<HtmlCodeColour[]>>();

export function cachedCodeColours(key: string, html: string): Promise<HtmlCodeColour[]> {
  let result = colours.get(key);
  if (result) colours.delete(key);
  else result = htmlCodeColours(html);
  colours.set(key, result);
  if (colours.size > CODE_COLOURS_CACHE_LIMIT) {
    const oldest = colours.keys().next().value;
    if (oldest !== undefined) colours.delete(oldest);
  }
  return result;
}
