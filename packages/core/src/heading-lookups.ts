import { type DocHeading, LIMITS } from "@emend/contract";

/** Ephemeral lookup keys only; declared ids and rendered metadata remain unchanged. */
export function headingLookups(headings: readonly DocHeading[]): Map<string, string> {
  const author = new Map<string, string>();
  const hunk = new Map<string, string>();
  const github = new Map<string, string>();
  const hunkCounts = new Map<string, number>();
  const githubCounts = new Map<string, number>();
  const valid = (name: string) => name.length > 0 && name.length <= LIMITS.headingIdChars;
  const register = (
    names: Map<string, string>,
    counts: Map<string, number>,
    base: string,
    id: string,
    start: number,
  ) => {
    if (!valid(base)) return;
    let name = base;
    let count = counts.get(base) ?? start;
    while (names.has(name)) name = `${base}-${count++}`;
    counts.set(base, count);
    if (valid(name)) names.set(name, id);
  };
  for (const heading of headings.slice(0, LIMITS.headingsPerDoc)) {
    if (!heading.id) continue;
    if (heading.id.startsWith("user-content-")) {
      const name = heading.id.slice(13);
      if (valid(name) && !author.has(name)) author.set(name, heading.id);
    }
    const text = heading.text;
    register(
      hunk,
      hunkCounts,
      String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, ""),
      heading.id,
      2,
    );
    register(
      github,
      githubCounts,
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\-_ ]/gu, "")
        .replace(/ /g, "-"),
      heading.id,
      1,
    );
  }
  for (const names of [hunk, github]) for (const [name, id] of names) if (!author.has(name)) author.set(name, id);
  return author;
}
