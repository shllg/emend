/** Revision-local lookup only: no URL parser's normalization or ambient origin. */
export function resolveDocLink(
  base: string,
  href: string,
  docs: Pick<ReadonlySet<string>, "has">,
): { path: string; fragment?: string } | null {
  const hasControl = (value: string) =>
    Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    });
  if (!href || hasControl(href) || href.includes("\\")) return null;
  const hash = href.indexOf("#");
  const rawPath = hash < 0 ? href : href.slice(0, hash);
  if (rawPath.startsWith("/") || rawPath.includes("?") || /%2f|%5c/i.test(href)) return null;
  let parts: string[];
  let fragment: string | undefined;
  try {
    parts = rawPath.split("/").map((part) => decodeURIComponent(part));
    fragment = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
  } catch {
    return null;
  }
  if (
    parts.some((part) => hasControl(part) || part.includes("\\") || part.includes(":")) ||
    (fragment !== undefined && hasControl(fragment))
  )
    return null;
  if (rawPath !== "" && (rawPath.endsWith("/") || parts.at(-1) === "." || parts.at(-1) === "..")) return null;
  const path = rawPath === "" ? base.split("/") : base.split("/").slice(0, -1);
  if (rawPath !== "")
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "") return null;
      if (part === "..") {
        if (!path.length) return null;
        path.pop();
      } else path.push(part);
    }
  const resolved = path.join("/");
  return docs.has(resolved) ? { path: resolved, ...(fragment ? { fragment } : {}) } : null;
}

export type DocLinks = ReadonlyMap<string, ReadonlyMap<string, string>>;
