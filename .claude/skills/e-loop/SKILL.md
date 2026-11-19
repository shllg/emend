---
name: e-loop
description: Run the work loop from the main checkout by following `.claude/loop.md`. It keeps up to three worker sessions on pickable issues, steers them to finish, and watches each one to the merge. Use when the owner types /e-loop or /loop /e-loop, or asks to start or check the work loop.
---

# /e-loop

`.claude/loop.md` in the main checkout is the work loop. A bare `/loop` runs that file by itself.
A `/loop` with a prompt, such as `/loop /e-loop`, skips it, so this skill hands it over.

1. Find `<main>`: the parent of `git rev-parse --path-format=absolute --git-common-dir`.
2. Read `<main>/.claude/loop.md` in full, on every pass, and follow it as written. It holds every
   rule of the loop; this skill adds none and waives none.
3. A plain `/e-loop`, outside `/loop`, does one pass and skips the pacing of section 6.
   Say that `/loop /e-loop` or a bare `/loop` keeps it running.
