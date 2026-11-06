---
id: 023
title: Pin the config that shapes bin/wt's rebase
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-06
---

# 023 — Pin the config that shapes bin/wt's rebase

## Why

`bin/wt rebase` runs `git rebase --merge` (`bin/lib/wt/history.ts`) with the user's and the
repository's git config. Some rebase and sequencer settings change which steps the rebase performs
or how it resolves them, so a config value can make `bin/wt rebase` do more than replay the
branch. Restack already builds its patch with plumbing that ignores diff config; the rebase call
needs the same treatment.

## Steps

- [x] Failing tests first in `bin/lib/wt`: a fixture repo whose config sets
      `rebase.instructionFormat` to a value that adds a `break` step to the rebase. `bin/wt rebase`
      still replays exactly the branch's commits and reports `rebased`, or restacks as today. Tests
      inject only harmless todo lines, such as `break`.
- [x] Pin `-c rebase.instructionFormat=%s` on the rebase call.
- [x] Audit every other config key that shapes the sequencer or the rebase the same way, for
      example `rebase.autoSquash`, `rebase.autoStash`, `rebase.updateRefs`,
      `rebase.missingCommitsCheck`, `rebase.rescheduleFailedExec`, `sequence.editor`,
      `core.editor`, `merge.renames`, `rerere.enabled` and `rerere.autoUpdate`. Pin each one that
      can change what the rebase does, with a test where it matters. Record the list and each call
      in Notes.
- [x] Never change the user's git config.
- [x] Reviews: emend-reviewer, the read-only Codex review and emend-security-reviewer (harness,
      git access).
- [x] Commit type and scope: `fix(harness)`.

## Done when

The rebase call pins every config key that could change its steps, a regression test fails before
the fix and passes after, `pnpm verify` is green, and the reviews are clean.

## Notes

- Keep commit messages and the PR text generic: name the keys that are pinned and why a pin keeps
  the rebase to a plain replay, nothing more.
- Pinned with `-c` on the rebase call, each with a test that fails without it:
  `rebase.instructionFormat=%s` (no extra todo lines), `i18n.logOutputEncoding=UTF-8` (the todo is
  built in the log encoding, so a subject cannot become a todo line), `core.commentChar=#` (it also
  overrides `core.commentString`, so no todo line reads as a comment), `core.abbrev=no` (the todo
  names each commit by its full id), `commit.cleanup=verbatim` and `i18n.commitEncoding=UTF-8`
  (replayed messages keep their bytes), `notes.rewrite.rebase=false` (notes refs stay put),
  `rerere.enabled=false` (a recorded resolution never replaces a conflict; the restack's
  `apply --3way` pins it too), `merge.renames=true` and `merge.directoryRenames=conflict` (a pick
  resolves as with git's merge defaults).
- Pinned with a test: the flags `--strategy=ort` (the sequencer reads its default strategy from
  `pull.twohead`, where the first value wins, so `-c` cannot pin it), `--no-rebase-merges`,
  `--no-update-refs` and `--reapply-cherry-picks` with `--empty=drop` (no branch commit is skipped
  by a whitespace-insensitive patch match; a commit that becomes empty is dropped).
- Pinned without a test; each restates git's default as defence in depth: `merge.renameLimit=7000`,
  `merge.renormalize=false`, `--no-autostash`, `--no-autosquash` and `--no-fork-point`.
- Not pinned, no effect on a non-interactive rebase with an explicit upstream: `rebase.autoSquash`
  (interactive only), `rebase.forkPoint` (off when an upstream is given), `rebase.missingCommitsCheck`
  (todo edits only), `rebase.rescheduleFailedExec` (the todo holds only picks),
  `rebase.abbreviateCommands`, `rebase.maxLabelLength`, `rebase.stat`, `sequence.editor` and
  `core.editor` (no step opens an editor), `rerere.autoUpdate` (read only when rerere is on) and
  `merge.conflictStyle` (marker style only; the rebase aborts on a conflict).
- `merge.default` stays unpinned on purpose: any pinned value makes git look up a driver of that
  name, which config can define, while an unset value uses the built-in text merge directly.
- After git exits 0, `checkRebased` refuses a result with an operation still in progress (it aborts
  it and checks that the branch is back at its old tip), a HEAD off the branch, or a target that is
  not an ancestor of HEAD. The e-rebase skill names the one exit-1 case that may leave the branch
  rewritten.
