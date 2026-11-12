import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { escapeReference } from "../escape.ts";
import { updateDoc } from "./install.ts";

export type SkillLinks = "current" | "stale" | "none" | "unknown";

export async function checkSkillLinks(home: string, folder: string): Promise<SkillLinks> {
  try {
    const skills = join(folder, "dist/skills");
    const names = (await readdir(skills, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (names.length === 0) return "unknown";
    let linked = 0;
    let current = 0;
    for (const name of names) {
      const link = join(home, ".agents/skills", name);
      try {
        if (!(await lstat(link)).isSymbolicLink()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return "unknown";
      }
      linked++;
      try {
        if ((await realpath(link)) === (await realpath(join(skills, name)))) current++;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return "unknown";
      }
    }
    return linked === 0 ? "none" : current === names.length ? "current" : "stale";
  } catch {
    return "unknown";
  }
}

export function nextSteps(version: string, skills: SkillLinks, attached: boolean): string {
  const shown = escapeReference(version);
  const skillNotes = {
    current: `emend: agent skills: the links in ~/.agents/skills point at emend ${shown}.`,
    stale: `emend: agent skills: the links in ~/.agents/skills do not all point at emend ${shown}. Run emend skills install.`,
    none: "emend: agent skills: none are linked in ~/.agents/skills. If you linked them with emend skills install --dir, run it again with that folder.",
    unknown: "emend: agent skills: if you linked them with emend skills install, run it again.",
  };
  return [
    `emend: next, update the other parts of emend. Each step is in ${updateDoc}`,
    skillNotes[skills],
    "emend: Claude Code plugin: if you use it, run claude plugin marketplace update emend, then claude plugin update emend@emend, then restart Claude Code or run /reload-plugins.",
    attached
      ? `emend: phone app: it comes from the hub. Once the hub runs emend ${shown}, open Devices in the app and tap Check for update.`
      : "emend: phone app: if you use it, open Devices in the app, tap Check for update, then Update now and Reload.",
    "",
  ].join("\n");
}
