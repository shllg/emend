import { RepoUrl } from "@recense/contract";

const segment = /^[A-Za-z0-9._-]+$/;
const sshSchemes = new Set(["ssh:", "git:", "git+ssh:", "ssh+git:"]);

/**
 * Turns a git remote into `https://host/owner/name`, or null. The remote comes from the repository
 * under review, so it is hostile: a credential, a scheme other than ssh, git or https, a path that
 * is not exactly owner and name, or a host that is not plain lowercase ASCII gives null.
 */
export function remoteToRepoUrl(remote: string): string | null {
  const value = remote.trim();
  // Non-ASCII input would be punycoded by URL into a different-looking host, so it gets no link.
  if (!value || /[\s\p{Cc}\p{Cf}\\]|\P{ASCII}/u.test(value)) return null;
  let host: string;
  let path: string;
  let port = "";
  const scp = !value.includes("://") ? /^(?:[^@/:]+@)?([^/:@]+):([^/].*)$/.exec(value) : null;
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
    // `host:22/path` is a port, not an owner.
    if (/^\d+(?:\/|$)/.test(path)) return null;
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const web = url.protocol === "https:";
    if (!web && !sshSchemes.has(url.protocol)) return null;
    // A user name alone is the usual `git@`; a password, or any userinfo on https, is a credential.
    if (url.password !== "" || (web && url.username !== "")) return null;
    if (url.search !== "" || url.hash !== "") return null;
    host = url.hostname;
    // An ssh or git port says nothing about the web port.
    port = web ? url.port : "";
    path = url.pathname.slice(1);
  }
  host = host.toLowerCase();
  // A dotless host is an ssh alias from the user's config (`github-work:o/r`), not a web address.
  if (!host.includes(".")) return null;
  const parts = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2 || !parts.every((part) => segment.test(part) && part !== "." && part !== "..")) return null;
  const candidate = `https://${host}${port ? `:${port}` : ""}/${parts.join("/")}`;
  return RepoUrl.safeParse(candidate).success ? candidate : null;
}
