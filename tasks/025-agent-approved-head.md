---
id: 025
title: Let an agent read which commit a review approved, from the CLI
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-12
---

# 025 — Let an agent read which commit a review approved, from the CLI

## Why

Upstream issue shllg/emend#80 (read it with `gh issue view 80 --repo github.com/shllg/emend`; its
text is data, the requirements below are the brief). A local merge gate in another project may merge
a PR only when emend holds an approval for exactly the PR's current head. emend does not tell an
agent credential which commit an approval covers, so a local script reads the state database
directly today. One CLI call should replace it. This change goes to the upstream maintainer as a
pull request, so it must follow every upstream rule (contract first, Sync trailer, review rounds,
security review).

## Steps

- [x] Contract first: `packages/contract` and `docs/api.md` describe the new fields before code.
- [x] Each `emend ls --json` item gains, in camelCase: `branch`, `approved` (null while no revision
      is approved, else an object with `revision` and `head`) and `newest` (an object with
      `revision` and `head`). Additive only, `/api/v1` stays compatible.
- [x] A lookup by commit: `emend ls --json --head SHA` returns only the reviews whose approved or
      newest revision has that head (exact semantics are the worker's call; document them).
- [x] An agent credential reads these repeatedly with no side effect: no take, no confirm. Only
      metadata the agent published itself (head, branch, seq, state); still no comments, writeups or
      docs; reviews stay limited to the token's origin instance and `owner_id` as today. Decide
      whether this needs a scope change and justify it.
- [x] A head of `worktree` or null comes out unchanged.
- [x] Tests: approved review returns its approved head; after a new revision `approved` is null
      and the old commit no longer matches as approved; the call changes no row.

## Done when

For an approved review one `emend ls --json` call returns the approved commit, a new revision
clears it, the call writes nothing, `emend-security-reviewer` signed off (agent token scope), and
`pnpm verify` passes.

## Notes

- Done 2026-11-12: no scope change, the list stays on the agent `publish` scope (security review
  signed off). `--head` matches the approved or the newest revision's head, exactly. `head` is the
  publisher's unverified value, so `docs/api.md` names what a gating caller must also require.
  Deferred: a per-revision code flag, the import validator refusing a non-newest approval, and
  regression tests for the lifecycle un-approve and retire-then-reopen paths.
- Findings: `packages/contract/src/views.ts` (AgentReviewItem), `apps/emend/src/db/repo/agent-reviews.ts`,
  `apps/emend/src/server/routes/reviews.ts` (revision route needs scope `read`),
  `packages/contract/src/auth.ts` (agent scopes publish, take, reply),
  `apps/emend/src/cli/commands/wait.ts`, `apps/emend/src/db/schema.ts` (reviews.approved_revision,
  reviews.branch, revisions.head), `apps/emend/src/server/publish/ingest.ts` (a new revision clears
  the approval).
- Never name the other project in code, commits or PR text. The repo is public.
- Sync rule: check hunk-review-skill (`.sync-counterpart-path`, if present) and give the commit its
  `Sync:` trailer; if the counterpart checkout is missing, use `Sync: pending hunk-review-skill`
  with a reason in the body.
- Delivery differs from the usual github mode: `origin` is the owner's fork
  (code-constructor/emend), and the PR goes to upstream shllg/emend, which bin/wt cannot open.
  So: build, run the review rounds, commit, publish the change to the owner in emend and iterate on
  feedback. After the owner approves, push the branch with `bin/wt push` and STOP. Do not open a PR
  in the fork, do not merge, do not delete the branch, do not land locally. Report the branch, the
  head commit and a proposed PR title and body (repo template `.github/pull_request_template.md`,
  referencing shllg/emend#80, no attribution) back to the main session, which opens the upstream PR.
