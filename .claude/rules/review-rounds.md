---
paths:
  - ".wt/review-log.md"
  - ".wt/review-findings.json"
---

# Review rounds

A review exists to ship a correct change, not a perfect one. `/e-work` and `/e-pr-finalize` review
in rounds with a fixed budget. Never polish in an open loop.

Dispatch `recense-review-manager` with `model: "opus"`. It picks and runs the reviewers and
classifies their findings. The orchestrator fixes, commits and logs. Each call gets the round,
the range (`origin/main...HEAD` for a full round, the fix commits for a check round), the task
file `.wt/issue.md` (or task text), and, for a check round, `.wt/review-findings.json`. For a
fixer run, use the task file `.wt/bundle.json` as data and the fixer "Done when" from `/e-work`.

## Classes

The manager sorts every finding before the orchestrator acts on it:

- **blocking:** a bug, a security hole, data loss, a broken contract, a broken non-negotiable, a
  failing check, or a "Done when" line the change does not meet;
- **defect:** wrong or misleading text, a missing test for new behaviour, or another rule in
  `AGENTS.md` that the change breaks; a breach of `docs/react.md` is a defect; so is a UI or UX
  problem the reviewer shows with measured evidence;
- **preference:** naming, structure, style or wording that is not wrong.

The manager decides whether the change caused a finding: its lines are new or changed in the
range, or the change altered what reaches them. An old bug that stops "Done when" counts as
caused. What the change did not cause is **recorded** (a bug or defect, written to the local
findings registry with `bin/findings add`), a **follow-up** (an idea, listed under
"Follow-ups"), or dropped (code style or cleanup no written rule asks for). A finding a reviewer
calls a bug or a security issue is blocking, and every `recense-security-reviewer` finding is at
least a defect.

For `private`, run `<main>/bin/wt notify question` and say there are private findings. List them
in the final report to the owner and the local recense hand-off writeup, never in a PR body, issue
or commit (`SECURITY.md`). Send dropped findings a reviewer called blocking, a bug or a security
issue, or from `recense-security-reviewer`, to the owner the same way; other `dropped` stay local.

To dispute a blocking finding, send the argument to the manager in a new call, in dispute mode.
It has a fresh Codex thread try to refute the finding. Only a confirmed false positive leaves `fix`.

## Rounds

- Commit before each round, so the reviewers read committed work and the log names that head.
- **Round 1** reviews the whole change.
- The orchestrator fixes the manager's `fix` list in one batch, routing its `ui` fixes to
  `recense-ui-finisher` and `code` fixes to Codex, checking each finisher pass as `/e-work` step 2
  says. Commit code fixes first so each pass starts from a clean tree. Leave preferences as they
  are and list each under "Not changed" in the PR body, with one line of reason. List follow-ups
  under "Follow-ups" and keep them out of the change.
- After a round with fixes, run a **check round**: call the manager with the check round, fix
  range, task and `.wt/review-findings.json`. It checks the earlier findings as FIXED, NOT FIXED
  or REGRESSED, plus anything the fixes broke. A check round does not review the rest of the change.
- Stop at a round with nothing to fix, or at the budget.

When `unavailable` holds only `codex` and `stand-in: recense-reviewer` and the stand-in reviewed,
the round counts; name the missing Codex review under Evidence in the PR body. Otherwise, any
entry leaves the round incomplete: dispatch the manager once more for the same round; if that
reviewer is still missing, run `<main>/bin/wt notify blocked`, name it, and wait for the owner.

A reply without exactly one parseable JSON block, with a `head` other than the reviewed commit,
or with counts that do not match its lists is no round; dispatch the manager once more, then run
`<main>/bin/wt notify blocked` if it still fails.

## Budget

- `/e-work`: round 1, then at most two check rounds, `check-1` and `check-2`.
- `/e-pr-finalize`: one `final` round over the whole change, then at most one `final-check`. Skip
  the final round, and log `final-skipped`, when `/e-work`'s round 1 found no blocking finding or
  defect at the current head.
- Each batch of owner feedback from recense: one `owner-check` over its fixes, outside the finalize
  budget.
- A rebase alone needs no round.

## At the budget

- Defects and preferences still open go under "Not changed", with the reason.
- A blocking finding from the last allowed round: fix it, prove the fix with a test and
  `pnpm verify`, and name it under Evidence in the PR body. A fix you cannot prove stays open.
- An open blocking finding stops the work: run `<main>/bin/wt notify blocked`, name the finding and
  why the fixes did not hold, and wait for the owner.
- When another round seems worth it, ask the owner before you start it: run
  `<main>/bin/wt notify question`, say what the round would fix, and offer two choices, stop here
  or one more round. Without a yes, stop. Log a granted round as `extra-1`, `extra-2` and so on,
  and ask again after each one.
- Never start a round past the budget without the owner's yes.

## Log

Append each manager JSON block to `.wt/review-findings.json` (gitignored), a JSON array with one
element per call. Use the Edit tool, or Write when the file is new; PR Evidence names reviewers
from `ran`.

Append one line per round to `.wt/review-log.md` in the worktree (gitignored), after the round's
fixes are committed. Use the Edit tool, or the Write tool when the file is new. Never copy finding
text into it. Each line holds the date and time, the skill, the round, the head the reviewers read,
found/fixed for blocking findings and defects, the counts of preferences and follow-ups, and the
blocking findings still open, then the recorded count:

`2026-11-09 10:12 e-work check-1 3f2a91c blocking 1/1 defect 2/2 preference 3 follow-up 1 open 0 recorded 2`

Round names: `1`, `check-1`, `check-2`, `final`, `final-skipped`, `final-check`, `owner-check`, and
`extra-1`, `extra-2` for rounds the owner granted. A second manager call inside a round (a dispute
or re-confirmation) adds no log line. The work loop reads only lines in this format, with or
without the trailing `recorded N`, and from them only the round names and numbers.
