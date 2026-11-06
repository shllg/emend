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

## Done when

The new test fails without the fix and passes with it, `pnpm verify` is green, and no git call in
`bin/lib/wt` that is parsed or applied can pick up color from the user's config.

## Notes

- Never change the user's git config, in a test or anywhere else. Set the color keys only in the
  fixture repo's config.
- Done on 2026-11-06. The color fix also covers push and remote-delete error text through
  `GIT_BASE`. At the coordinating session's request, a second fix makes
  `bin/wt push --force-with-lease` push `refs/heads/<branch>` instead of a bare commit id, which a
  pre-push guard that checks the local branch's reflog refuses. The final review found the same
  root cause in the patch's shape, so a third fix pins its context and path prefixes:
  `diff.context=0` failed every restack, and `diff.noprefix=true` put a new nested file at the
  wrong path. Left open: `makeTestEnv()` does
  not isolate `XDG_CONFIG_HOME` or set `GIT_CONFIG_NOSYSTEM`, so the bin/wt tests read the
  developer's XDG and system git config.
