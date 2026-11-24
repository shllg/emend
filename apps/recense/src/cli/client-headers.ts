import { CLIENT_HEADER, LEGACY_CLIENT_HEADER } from "@recense/contract";
import { VERSION } from "../version.ts";

/** The client version under both header names, so a server from before the rename still reads it. */
export function clientHeaders(): Record<string, string> {
  const value = `cli/${VERSION}`;
  return { [CLIENT_HEADER]: value, [LEGACY_CLIENT_HEADER]: value };
}
