import { fileURLToPath } from "node:url";

export interface CliRuntime {
  node: string;
  entry: string;
}

export function cliRuntime(overrides: Partial<CliRuntime> = {}, moduleUrl = import.meta.url): CliRuntime {
  // In the bundle import.meta.url is the entry; source execution uses cli.ts.
  return {
    node: overrides.node ?? process.execPath,
    entry: overrides.entry ?? fileURLToPath(moduleUrl.endsWith(".ts") ? new URL("../cli.ts", moduleUrl) : moduleUrl),
  };
}
