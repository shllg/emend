import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathThroughRepository } from "../executable.ts";
import { CliError } from "../http.ts";
import { readRegular } from "../publish/read.ts";
import { validatePaths } from "../service/common.ts";
import { isReleaseManifest } from "./manifest.ts";

export interface NewRecense {
  folder: string;
  entry: string;
  version: string;
}

/** Check a folder the package manager named before recense runs anything from it. */
export async function checkNewRecense(folder: string, roots: readonly string[]): Promise<NewRecense> {
  const invalid = () => new CliError("the package manager did not install a usable recense.");
  const refused = () =>
    new CliError("the new recense lies inside a repository of the working directory; recense does not run it.");
  try {
    validatePaths(folder);
    if (await pathThroughRepository(folder, roots)) throw refused();
    const real = await realpath(folder);
    validatePaths(real);
    if (await pathThroughRepository(real, roots)) throw refused();
    const manifest: unknown = JSON.parse((await readRegular(join(real, "package.json"), 64 * 1024)).toString("utf8"));
    if (!isReleaseManifest(manifest)) throw invalid();
    const entry = join(real, "dist", "recense.mjs");
    if (await pathThroughRepository(entry, roots)) throw refused();
    if (!(await stat(entry)).isFile()) throw invalid();
    return { folder: real, entry: await realpath(entry), version: manifest.version };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid();
  }
}
