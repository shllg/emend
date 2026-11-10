---
id: 024
title: bin/wt skips other machines' terminals under herdr desktop
status: in-progress
owner: agent + your approval
depends_on: []
done_on:
---

# 024 — bin/wt skips other machines' terminals under herdr desktop

## Why

When herdr desktop has another machine registered (`hc machine add`), `hc ls --json` also lists that
machine's terminals, with addresses such as `<machine>/t10`. `hcTerminals()` in
`bin/lib/wt/herdr.ts` checks every entry with `hcAddress()` (`bin/lib/wt/validate.ts`, which accepts
only `^t[0-9a-z]+$`) and rejects the whole list. So `bin/wt agents` exits 69 ("Could not list
required agents: herdr desktop (hc)"), and `spawn`, `agent read`, `agent prompt` and the terminal
close in cleanup fail the same way. The work loop cannot run on a machine that sees another
machine's terminals.

## Steps

- [ ] In `hcTerminals()`, accept the local address shape `t…` and the other-machine shape
      `<machine>/t…`. Any other address shape still rejects the whole list, as today.
- [ ] Leave other-machine terminals out of the agent listing. Never match them to a worktree: both
      machines can share the same checkout path, and bin/wt must never read or type into a session
      on another machine.
- [ ] Keep other-machine terminals in the name-shadow check of `assertHcTarget()`, so that check
      stays fail-closed.
- [ ] Tests in `bin/lib/wt/hc.test.ts`: a listing with an other-machine terminal gives only the local
      agents; a listing with a malformed address still fails.

## Done when

`bin/wt agents`, `spawn`, `agent read` and `agent prompt` work while the hc listing holds
other-machine terminals, other-machine terminals never appear as agents, and `pnpm verify` passes.

## Notes

- The commission may edit `bin/lib/wt/` (`herdr.ts`, `validate.ts` if needed, `hc.test.ts`) and
  nothing else under `bin/`.
- Synthetic machine names only, in tests and in every text that leaves the machine.
- The owner wants this fast: keep the change minimal.
