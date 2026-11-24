# Standards

Taste rules for recense. `recense-reviewer` checks them. Correctness rules live in `AGENTS.md` and
`.claude/rules/`.

## Code

- Validate every input at the boundary with zod. Trust typed values inside.
- No `any`. No non-null `!` without a comment that says why it holds.
- Small modules with one job. Name a file after what it exports.
- Keep pure logic (block ids, placement, hand-off merge) in `packages/core` or apart from I/O,
  and unit-test it.
- Throw typed errors inside. Map them to the one error shape at the API edge.
- Comments explain why, not what. No commented-out code.
- No new dependency for what the platform or an existing dependency already does.

## Tests

- Test first for behaviour changes.
- Name a test after the behaviour: "refuses a send for an older revision".
- Add hostile-input cases for anything that renders or parses agent-written content.
- Fixtures are synthetic. State lives in temporary `RECENSE_HOME` folders.

## UI text

- Short, plain, active sentences. One idea per sentence.
- Say what happened and what to do next: "This page is out of date. Reload to see the newest
  revision."
- No exclamation marks.

## Commits

- Until the first release, commits land directly on `main`. One logical change per commit.
- The commit body names the plan task and records the Sync decision. A PR body (Summary,
  Evidence, Sync) comes back with PRs after the first release.
