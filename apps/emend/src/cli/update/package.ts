import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../http.ts";
import { readRegular } from "../publish/read.ts";
import { validatePaths } from "../service/common.ts";
import { updatePackage } from "./install.ts";

export interface NewEmend {
  folder: string;
  entry: string;
  version: string;
}

const plain = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Check a folder the package manager named before emend runs anything from it. */
export async function checkNewEmend(folder: string): Promise<NewEmend> {
  const invalid = () => new CliError("the package manager did not install a usable emend.");
  try {
    validatePaths(folder);
    const real = await realpath(folder);
    validatePaths(real);
    const manifest: unknown = JSON.parse((await readRegular(join(real, "package.json"), 64 * 1024)).toString("utf8"));
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("name" in manifest) ||
      manifest.name !== updatePackage ||
      !("version" in manifest) ||
      typeof manifest.version !== "string" ||
      !plain.test(manifest.version)
    )
      throw invalid();
    const entry = join(real, "dist", "emend.mjs");
    if (!(await stat(entry)).isFile()) throw invalid();
    return { folder: real, entry, version: manifest.version };
  } catch (error) {
    if (error instanceof CliError && error.message === invalid().message) throw error;
    throw invalid();
  }
}
