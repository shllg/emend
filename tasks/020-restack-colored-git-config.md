---
id: 020
title: Restack under a colored git config
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-06
---

# 020 — Restack under a colored git config

## Why

When `bin/wt rebase` hits a conflict, it restacks. `replay()` in `bin/lib/wt/history.ts` (around
line 139) writes the branch's change with
`git diff --binary --full-index --no-ext-diff --no-textconv --ignore-submodules=all --output=<patch>`,
then runs `git apply --3way` on that patch.

That diff call has no `--no-color`. With `color.ui=always` or `color.diff=always` in the user's git
config, the patch holds ANSI codes, and `git apply` fails with "No valid patches in input". So
every conflicting rebase fails for such a user. `changeDigest()` in the same file already passes
`--no-color`.

## Steps

- [x] Write a regression test in `bin/lib/wt` first. It restacks a conflicting branch with
      `color.ui=always` and `color.diff=always` set in the fixture repo's own config. It must fail
      before the fix.
- [x] Add `--no-color` to `replay()`'s diff.
- [x] Check every other git call in `bin/lib/wt` whose output is parsed, digested or applied for
      the same gap, and close each one found.
- [x] Reviews: emend-reviewer and the read-only Codex review.
- [x] One commit, `fix(harness): ...`, with the sync outcome in the body.
- [x] Added by the coordinating session: `bin/wt push --force-with-lease` pushes
      `refs/heads/<branch>` instead of a bare commit id, checks right before the push that the
      branch still points at the resolved HEAD, and keeps the lease as tight as before.
- [x] Found by the reviews, same root cause as the color bug: `replay()`'s patch no longer
      depends on the user's or the repo's diff settings. It is built with `git diff-tree`, and the
      settings plumbing still reads are pinned: context, prefixes, rename detection and limit,
      `diff.suppressBlankEmpty`. `git apply` runs with `apply.ignoreWhitespace=no`, `run()`
      drops `GIT_DIFF_OPTS`, and `bin/wt rebase` uses the merge backend.
- [x] Found by the security review: the restack writes no patch file. It reads the change with
      `git diff-tree` before the branch moves and passes it to `git apply` on stdin.
- [x] Found by the same review: the restack lists conflicted paths with
      `git ls-files --unmerged`, so a diff setting such as a missing `diff.orderFile` cannot break
      the list after a conflicting restack.

## Done when

The new test fails without the fix and passes with it, `pnpm verify` is green, and no git call in
`bin/lib/wt` that is parsed or applied can pick up color from the user's config.

## Notes

- Never change the user's git config, in a test or anywhere else. Set the color keys only in the
  fixture repo's config.
- Done on 2026-11-06.
- The color fix also keeps push and remote-delete error text plain, through `GIT_BASE`.
- The lease push: a pre-push guard that checks the local branch's reflog refuses a bare commit id
  as the source. A commit that lands in the milliseconds between bin/wt's branch check and git's
  own read of the branch would still go out; the merge skills pin the merge to the approved head.
- Two of the patch-shape cases gave a wrong result while reporting success: `diff.noprefix=true`
  put a new nested file at the wrong path, and `apply.ignoreWhitespace=change` (also through
  `rebase.backend=apply`) let a deletion drop a re-indent from main. The others failed closed:
  `diff.context=0`, `diff.renames=false`, `diff.renameLimit`, a missing `diff.orderFile` and
  `GIT_DIFF_OPTS`.
- Left open: `makeTestEnv()` does not isolate `XDG_CONFIG_HOME` or set `GIT_CONFIG_NOSYSTEM`, so
  the bin/wt tests read the developer's XDG and system git config.
