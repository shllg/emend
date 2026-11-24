export function splitMigrationStatements(source: string): string[] {
  const chunks = source
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    let quote: string | undefined;
    let lineComment = false;
    let blockComment = false;
    let ended = false;
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];
      const next = chunk[i + 1];
      if (lineComment) {
        if (char === "\n" || char === "\r") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          i++;
        }
        continue;
      }
      if (quote) {
        if (char === quote) {
          if (quote !== "]" && next === quote) i++;
          else quote = undefined;
        }
        continue;
      }
      if (char === "-" && next === "-") {
        lineComment = true;
        i++;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        i++;
        continue;
      }
      if (char === undefined || /\s/.test(char)) continue;
      if (char === ";") {
        ended = true;
        continue;
      }
      if (ended) throw new Error("Migration chunk contains multiple statements; add --> statement-breakpoint");
      if (char === "'" || char === '"' || char === "`") quote = char;
      else if (char === "[") quote = "]";
    }
  }
  return chunks;
}
