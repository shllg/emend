/** Safe doc entry names in file order; folders may be shared, but never overlap a file. */
export function downloadDocNames(paths: readonly string[]): string[] {
  const files = new Set<string>();
  const folders = new Set<string>(["docs"]);
  return paths.map((path) => {
    const parts = path.split("/").map(
      (part) =>
        part
          .replace(/[^A-Za-z0-9._-]+/g, "-")
          .replace(/^\.+/, "")
          .replace(/[.-]+$/, "")
          .slice(0, 80)
          .replace(/[.-]+$/, "") || "_",
    );
    const last = parts.length - 1;
    if (!/\.html$/i.test(parts[last] ?? "")) parts[last] += ".html";
    let prefix = "docs";
    for (const [index, part] of parts.entries()) {
      let candidate = `${prefix}/${part}`;
      let suffix = 2;
      while (files.has(candidate.toLowerCase()) || (index === last && folders.has(candidate.toLowerCase()))) {
        const renamed = /\.html$/i.test(part)
          ? part.replace(/\.html$/i, `-${suffix}${part.slice(-5)}`)
          : `${part}-${suffix}`;
        candidate = `${prefix}/${renamed}`;
        suffix++;
      }
      (index === last ? files : folders).add(candidate.toLowerCase());
      prefix = candidate;
    }
    return prefix;
  });
}
