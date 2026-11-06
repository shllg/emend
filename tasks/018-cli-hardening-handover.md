---
id: 018
title: CLI hardening before handover
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-05
---

# 018 — CLI hardening before handover

## Why

The owner wants emend in a state they can hand to a colleague who installs it from the README
(2026-11-05). Two open repo tasks hold the CLI work for that, both already approved by the owner:
`tasks/012-cli-state-checks.md` (plan task 4.5b) and the S steps of
`tasks/013-release-and-setup.md` (plan task 6.3, steps S.1 to S.4). This task carries them out in
one branch, one commit per step, and ticks the steps in those two task files as they land. Read
both task files and the plan of record's sections "Task 4.5b" and "6.3 Smooth updates and any
network" before you start.

## Steps

- [x] 012, modes: before it reads a token, the CLI refuses a state folder or a token file that has
      group or other permission bits. One stderr line names the path and the `chmod` fix, and
      nothing changes. The server already checks the folder.
- [x] 012, reply cap: the CLI reads at most 64 MiB of a server reply, four times the largest
      hand-off the server sends. Uploads keep their own limits, so a publish never fails on this
      cap. Then set 012 to done.
- [x] S.3 first among the S steps (security): `publish`, `wait`, `feedback`, `reply` and `mcp`
      refuse an `emend` that resolves inside the current repository, as `emend service install`
      already does. Under mise, a repo's own tool config can point `emend` at its code, and agents
      run these commands with full rights.
- [x] S.1: `emend` and `emend service status` say when the running server is another version.
- [x] S.2: `emend stop`.
- [x] S.4: emend remembers the Tailscale Serve route it created, so a route left by a crash is
      still removed on the next stop (open owner item 31 in the plan).
- [x] Docs: `docs/setup/update.md` and `docs/setup/troubleshooting.md` mention S.1 and S.2 where a
      reader needs them.

## Done when

Each step has landed as its own commit with tests, `pnpm verify` passes, and `emend-reviewer`, a
fresh Codex review and `emend-security-reviewer` (CLI file access, tokens, the service) passed;
012 is done and 013's S.1 to S.4 are ticked.

## Notes

- Out of scope: 013's N.1 (`--public-url`), any UI change.
- Rules to read first: `AGENTS.md`, `.claude/rules/cli.md`, `.claude/rules/api-and-auth.md`.
- Other sessions run in parallel: 015 (reading docs, web app and core), 016 (stable and fast specs:
  test timing, CI), 017 (text files as source docs). Keep test changes to the files you touch;
  016 owns timing fixes across the suite.
- 2026-11-05: Done after six review rounds; most findings were in S.3, which now walks each
  helper's path link by link, counts a `.git` folder unless it has no `HEAD`, and exempts only a
  repository at the home folder itself. Codex was rate limited (429) three times, so Sonnet
  sub-agents built the lifecycle test update, batch 4b and one correction. Declined: a bare
  repository (a folder that is itself a git folder) does not count for S.3, because it holds no
  checked-out files and publish needs a worktree. Open for you: a `HOME` equal to the repository
  root still exempts it; the launcher `apps/emend/bin/emend` runs `dirname`, `basename`, `readlink`
  and `node` from the unfiltered `PATH` before the check; hunk-review-skill's hunk-plan runs
  `hunk`, `jq` and `git` from `PATH` inside the reviewed repository; `docs/usage.md` does not
  mention `emend stop`.
