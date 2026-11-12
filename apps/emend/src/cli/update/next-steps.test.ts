import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { updateDoc } from "./install.ts";
import { checkSkillLinks, nextSteps } from "./next-steps.ts";

let root: string;
let home: string;
let folder: string;
let skills: string;
let links: string;
beforeEach(async () => {
  root = await mkdtemp(join(process.env.EMEND_HOME as string, "next-steps-"));
  home = join(root, "home");
  folder = join(root, "new-package");
  skills = join(folder, "dist/skills");
  links = join(home, ".agents/skills");
  await mkdir(home);
  await mkdir(join(skills, "emend-review"), { recursive: true });
});

describe("agent skill links", () => {
  test("current links target the real new skill folders", async () => {
    await mkdir(join(skills, "emend-publish"));
    await writeFile(join(skills, "README.md"), "not a skill");
    await symlink(join(skills, "emend-review"), join(skills, "alias"));
    await mkdir(links, { recursive: true });
    for (const name of ["emend-review", "emend-publish"])
      await symlink(await realpath(join(skills, name)), join(links, name));
    expect(await checkSkillLinks(home, folder)).toBe("current");
  });

  test("links resolving through an alias to the new skills are current", async () => {
    await symlink(skills, join(root, "skills-alias"));
    await mkdir(links, { recursive: true });
    await symlink(join(root, "skills-alias/emend-review"), join(links, "emend-review"));
    expect(await checkSkillLinks(home, folder)).toBe("current");
  });

  test("a link to an old package skill is stale", async () => {
    const old = join(root, "old-package/dist/skills/emend-review");
    await mkdir(old, { recursive: true });
    await mkdir(links, { recursive: true });
    await symlink(old, join(links, "emend-review"));
    expect(await checkSkillLinks(home, folder)).toBe("stale");
  });

  test.each(["missing", "not-directory"])("a broken link is stale: %s", async (kind) => {
    const target = join(root, "target");
    if (kind === "not-directory") await writeFile(target, "not a folder");
    await mkdir(links, { recursive: true });
    await symlink(join(target, "emend-review"), join(links, "emend-review"));
    expect(await checkSkillLinks(home, folder)).toBe("stale");
  });

  test.each(["missing", "folder", "file"])("a new skill next to linked ones is stale: %s", async (kind) => {
    await mkdir(join(skills, "emend-publish"));
    await mkdir(links, { recursive: true });
    await symlink(await realpath(join(skills, "emend-review")), join(links, "emend-review"));
    if (kind === "folder") await mkdir(join(links, "emend-publish"));
    if (kind === "file") await writeFile(join(links, "emend-publish"), "not a link");
    expect(await checkSkillLinks(home, folder)).toBe("stale");
  });

  test("no skills folder in home means none are linked", async () => {
    expect(await checkSkillLinks(home, folder)).toBe("none");
  });

  test.each(["folder", "file"])("a regular %s alone means none are linked", async (kind) => {
    await mkdir(links, { recursive: true });
    if (kind === "folder") await mkdir(join(links, "emend-review"));
    else await writeFile(join(links, "emend-review"), "not a link");
    expect(await checkSkillLinks(home, folder)).toBe("none");
  });

  test.each(["missing", "empty", "files-only"])("new package skills are unknown when %s", async (kind) => {
    await rm(skills, { recursive: true });
    if (kind !== "missing") await mkdir(skills);
    if (kind === "files-only") await writeFile(join(skills, "README.md"), "not a skill");
    expect(await checkSkillLinks(home, folder)).toBe("unknown");
  });

  test("a skills path that cannot be listed is unknown", async () => {
    await rm(skills, { recursive: true });
    await symlink(skills, skills);
    expect(await checkSkillLinks(home, folder)).toBe("unknown");
  });

  test("a home skills path that cannot be inspected is unknown", async () => {
    await mkdir(join(home, ".agents"));
    await writeFile(links, "not a folder");
    expect(await checkSkillLinks(home, folder)).toBe("unknown");
  });

  test("a link that cannot be resolved is unknown", async () => {
    await mkdir(links, { recursive: true });
    await symlink(join(links, "emend-review"), join(links, "emend-review"));
    expect(await checkSkillLinks(home, folder)).toBe("unknown");
  });
});

const version = "0.2.0";
const skillNotes = {
  current: `emend: agent skills: the links in ~/.agents/skills point at emend ${version}.`,
  stale: `emend: agent skills: the links in ~/.agents/skills do not all point at emend ${version}. Run emend skills install.`,
  none: "emend: agent skills: none are linked in ~/.agents/skills. If you linked them with emend skills install --dir, run it again with that folder.",
  unknown: "emend: agent skills: if you linked them with emend skills install, run it again.",
};

describe.each(["current", "stale", "none", "unknown"] as const)("%s notes", (status) => {
  test.each([false, true])("use the required inert prose with attached=%s", (attached) => {
    const notes = nextSteps(version, status, attached);
    expect(notes).toBe(
      [
        `emend: next, update the other parts of emend. Each step is in ${updateDoc}`,
        skillNotes[status],
        "emend: Claude Code plugin: if you use it, run claude plugin marketplace update emend, then claude plugin update emend@emend, then restart Claude Code or run /reload-plugins.",
        attached
          ? `emend: phone app: it comes from the hub. Once the hub runs emend ${version}, open Devices in the app and tap Check for update.`
          : "emend: phone app: if you use it, open Devices in the app, tap Check for update, then Update now and Reload.",
        "",
      ].join("\n"),
    );
    for (const line of notes.trimEnd().split("\n")) {
      expect(line.startsWith("emend: ")).toBe(true);
      expect(line).not.toMatch(/[;&|<>()$`\\"']/);
    }
  });

  test.each([false, true])("pasting runs no suggested program with attached=%s", async (attached) => {
    const bin = join(root, "bin");
    const log = join(home, "calls");
    await mkdir(bin);
    await writeFile(log, "");
    for (const name of ["emend", "claude", "run"])
      await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$HOME/calls"\n', { mode: 0o755 });
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("/bin/sh", [], {
        cwd: home,
        env: { PATH: bin, HOME: home },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(nextSteps(version, status, attached));
    });
    expect(code).toBe(127);
    expect(await readFile(log, "utf8")).toBe("");
  });
});
