---
id: 023
title: Pin the config that shapes bin/wt's rebase
status: in-progress
owner: agent + your approval
depends_on: []
done_on:
---

# 023 — Pin the config that shapes bin/wt's rebase

## Why

`bin/wt rebase` runs `git rebase --merge` (`bin/lib/wt/history.ts`) with the user's and the
repository's git config. Some rebase and sequencer settings change which steps the rebase performs
or how it resolves them, so a config value can make `bin/wt rebase` do more than replay the
branch. Restack already builds its patch with plumbing that ignores diff config; the rebase call
needs the same treatment.

## Steps

- [ ] Failing tests first in `bin/lib/wt`: a fixture repo whose config sets
      `rebase.instructionFormat` to a value that adds a `break` step to the rebase. `bin/wt rebase`
      still replays exactly the branch's commits and reports `rebased`, or restacks as today. Use
      harmless steps such as `break` in tests, never one that runs a program.
- [ ] Pin `-c rebase.instructionFormat=%s` on the rebase call.
- [ ] Audit every other config key that shapes the sequencer or the rebase the same way, for
      example `rebase.autoSquash`, `rebase.autoStash`, `rebase.updateRefs`,
      `rebase.missingCommitsCheck`, `rebase.rescheduleFailedExec`, `sequence.editor`,
      `core.editor`, `merge.renames`, `rerere.enabled` and `rerere.autoUpdate`. Pin each one that
      can change what the rebase does, with a test where it matters. Record the list and each call
      in Notes.
- [ ] Never change the user's git config.
- [ ] Reviews: emend-reviewer, the read-only Codex review and emend-security-reviewer (harness,
      git access).
- [ ] Commit type and scope: `fix(harness)`.

## Done when

The rebase call pins every config key that could change its steps, a regression test fails before
the fix and passes after, `pnpm verify` is green, and the reviews are clean.

## Notes

- Keep commit messages and the PR text generic: name the keys that are pinned and why a pin keeps
  the rebase to a plain replay, nothing more.
