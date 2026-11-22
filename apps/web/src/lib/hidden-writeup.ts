/** Writeup sections the reader never shows. */
export const HIDDEN_WRITEUP_SECTIONS: ReadonlySet<string> = new Set(["review"]);

export const HIDDEN_COMMENTS_GROUP = "hidden-comments";

export function hidesWriteupBlock(blockId: string): boolean {
  return HIDDEN_WRITEUP_SECTIONS.has(blockId.split("-", 1)[0] ?? "");
}
