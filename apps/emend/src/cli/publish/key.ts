import { createHash } from "node:crypto";
import { CliError } from "../http.ts";

function key(parts: string[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}
export const reviewKey = (instanceId: string, root: string, branch: string) => key(["code", instanceId, root, branch]);
export const docsKey = (instanceId: string, name: string) => key(["docs", instanceId, name]);
export const projectKey = (name: string) => key(["project", name]);
export function normalizeRemote(remote: string): string {
  let value = remote.trim();
  if (!value.includes("://") && /^(?:[^@/]+@)?[^/:]+:.+/.test(value)) value = `ssh://${value.replace(":", "/")}`;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    url.search = "";
    url.hash = "";
    value = url.toString();
  } catch {
    if (value.includes("://")) throw new CliError("invalid origin URL");
    /* A local remote is a path, not a URL. */
  }
  return value.replace(/\/+$/, "").replace(/\.git$/, "");
}
