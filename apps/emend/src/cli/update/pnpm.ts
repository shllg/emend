import { realpath } from "node:fs/promises";
import { escapeReference } from "../escape.ts";
import { CliError } from "../http.ts";
import { validatePaths } from "../service/common.ts";
import { locateArgs, updatePackage } from "./install.ts";
import { isPnpmProjects } from "./manifest.ts";
import { runChild, succeeded } from "./run.ts";

/** Query ownership and the updated location through the same bounded, validated global list. */
export async function pnpmPackages(
  file: string,
  home: string,
  env: Record<string, string>,
  expectedFolder?: string,
): Promise<string[]> {
  const result = await runChild(file, locateArgs({ kind: "pnpm" }), {
    cwd: home,
    env,
    timeoutMs: 30_000,
    output: "capture",
  });
  const detail = result.stderr.split(/\r?\n/, 1)[0];
  const invalid = () =>
    new CliError(`pnpm did not confirm its global emend package${detail ? `: ${escapeReference(detail)}` : "."}`);
  if (!succeeded(result)) throw invalid();
  try {
    const projects: unknown = JSON.parse(result.stdout);
    if (!isPnpmProjects(projects)) throw invalid();
    const folders = projects.flatMap((project) => {
      const dependency = project.dependencies?.[updatePackage];
      return dependency ? [dependency.path] : [];
    });
    for (const folder of folders) validatePaths(folder);
    if (folders.length === 0) throw invalid();
    if (expectedFolder !== undefined) {
      for (const folder of folders) {
        if ((await realpath(folder).catch(() => undefined)) === expectedFolder) return [folder];
      }
      throw invalid();
    }
    return folders;
  } catch {
    throw invalid();
  }
}
