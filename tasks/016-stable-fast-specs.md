---
id: 016
title: Stable and fast specs
status: open
owner: agent + your approval
depends_on: []
done_on:
---

# 016 — Stable and fast specs

## Why

Plan task 6.3 T.1. The specs must be stable: about 60 timing-dependent assertions and sleeps get
deterministic replacements. A `yieldToLoop` work-unit check in the gate and a non-gating
`pnpm bench` replace the wall-clock budgets. CI fans out into parallel jobs and Vitest shards.
Detail and order are in the plan "emend: stable and fast specs", linked from the T.1 entry of the
plan of record. You decided D1 to D4 as recommended on 2026-11-05: static checks on both Node
versions, the plan's order of work, no deadline seam for `emend serve`, and bench-only coverage
for single synchronous steps.

## Steps

One commit per step, in the plan's order (D2):

- [x] Quick stability: batched seeds, races and sleeps, row counters instead of ratios. No
      production change.
- [x] CI fan-out: the `verify:*` scripts, a reusable verify workflow, 4 Vitest shards on both
      Node versions, static checks on both Node versions (D1), and the guard test.
- [x] Pacing hook: `pacing.ts` at the yield sites, behaviour unchanged.
- [x] New yields in the import pipeline, with one work-unit test per phase.
- [x] Bench: the `bench` project and `pnpm bench`; the timing assertions and both
      `EMEND_TIMING_STRICT` passes go. Single synchronous steps get bench coverage only (D4).
- [x] Slow fixtures and the 15 to 30 s timeout group. Also the real-render tests in
      `comment-html.test.ts` ("the HTML budget nulls…" renders 200,000-character bodies) and every
      test that passes alone but hits the 5 s timeout when two suites run at once (seen:
      `cli/direct.test.ts` "feedback refuses a newer database…" and its "serve" variant (:341,
      5174 ms), also reported from the 015 branch; `server/routes/agent-notes.test.ts:150` "range
      errors identify the file and note index…" (5173 ms);
      `cli/attach-failures.test.ts` "attached publish by id refuses an uncopied local review before
      any request", 6.2 s in a locked gate at load 25, with the file at 106 s against 36 s alone).
      Also no test may reach the network: the `ENOTFOUND example.test` lookup came from a happy-dom
      popup in a `reading-navigation.test.tsx` `_blank` test, and the web setup now refuses any
      request, WebSocket or lookup for a host that is not loopback.
- [x] Polling waits: `vi.waitFor` and Testing Library `waitFor` default to a 1 s deadline, a load
      bet in about 550 places. No polling wait gets a deadline shorter than the test's own.
- [x] `tailscale-process` and `serve-signals` onto fake timers and fake children; no deadline
      seam for `emend serve` (D3).
- [ ] The `core` budgets become work counts; their speed checks move to the bench.
- [ ] The web sleeps go onto fake timers, including the real absence waits in `App.test.tsx`
      (about :567, 700 ms) and `components/diff/diff.test.tsx` (about :962, 20 ms).
- [ ] Split the biggest test files only if the shards are still uneven.
- [ ] Reviews per step: emend-reviewer, a read-only Codex review, and emend-security-reviewer on
      every server, CI or hook change.

## Done when

`pnpm verify` passes with no wall-clock assertion or real sleep left in the gate, and `pnpm bench`
runs outside it. CI runs the sharded layout, and the plan's T.1 entry records the outcome.

## Notes

- Flaky or timing-dependent tests are bugs to fix at the root: never retry, loosen or skip them.
- Changes under `.github/` and the pacing hook need emend-security-reviewer.
- Found in step 3, out of this task's scope: main-thread loops in the publish path that never
  yield (snapshot and history loops, placement preparation, file and asset validation and
  indexing, topic insertion, render metadata construction). Revision limits bound them; a
  follow-up task should measure them with the bench and add yields where they stall.
- Found in step 4, same follow-up: import loops over bundle-sized arrays that still never yield
  (bundle indexing, id and hash collection, the file sort and delivery filter, file and asset
  validation, the placements byte check, placement preparation and the placement budget walk).
  Import limits bound them.
- Found in the step-4 security review, older than this task and left for the owner: when
  `prepareImport` throws after rendering (a row, byte or blob check, or an abort), its staged
  blob holds are never released. `importReview` releases them only after `prepareImport`
  returns, so the staged files outlive their pin with no `blobs` row and no cleanup. Also, the
  repo insert in `import/ingest.ts` spreads the bundle's repo after `ownerId`; zod strips
  unknown keys today, but spreading first would keep it safe.
- Part 1 (2026-11-05, branch `016-stable-fast-specs`) covers steps 1 to 7, plus `--no-wasm-code-gc`
  on Node 24 test workers against nodejs/node#66366 (drop it once nodejs/node#66376 ships) and
  a network guard for web tests. Steps 8 to 11 follow on a second branch, together with a
  Node-side network guard (it needs a `setupFiles` entry in `vitest.config.ts`) and a real-worker
  test for the comment renderer's default worker (`server/routes/comment-html.ts:128-129`).
- Also for the second branch, from the part-1 reviews. Most of these matter only after a test has
  already failed:
  - `pollUntil` checks the test's lifecycle before an async assertion runs, not after it settles,
    so an expired test body can resume once.
  - In `comment-html.test.ts` (about :354), a failed timer assertion skips `gate.resolve()`. The
    module's `tail` stays blocked, and later tests time out.
  - The web `asyncWrapper` never settles a late wait. That strands cleanup that sits only in a
    `finally` (`worker-render.test.tsx`, about :167). Rejecting instead would let it run.
  - The verify-layout guard should also pin `verify:static` and `verify:build`, and the state
    isolation (`globalSetup`) of the bench project.
  - `poll-until.test.ts:7` sets `{ timeout: 10000 }`, which it does not need.
  - happy-dom prints an "Iframe page loading is disabled" trace to stderr for each iframe in the web
    tests (about 69 per gate). Silence or stub them, so real failures stay visible.
  - Step 9 also covers the real sleeps in `reading-position.test.tsx` (:203, :223, :235) and
    `pair-device.test.tsx` (:321).
- CI hung once at `575e6f0` in serve-signals, "a second SIGTERM while startup escalation is
  pending…", until its 5 s timeout. The local runs never reproduced it: about 140, including
  CI's shard on 4 CPUs with dash as `/bin/sh`. As you chose, the held-escalation tests no longer
  depend on the fake shell's TERM and EXIT traps. A failed serve-signals test now reports its
  pending waits, its markers and the process states of emend, the launcher and the descendant.
  Left for the second branch: in the socket-double fixtures (`phase: "listen"` and `"close"`)
  the gate marker holds emend's own pid, so the report labels emend's pid as the launcher. The
  report also lacks labels for raw `closed` and `exited` waits outside the held-escalation tests.
  And "teardown never signals a completed call's old pid" runs the cleanup inside its body, so a
  later failure in that test reports no markers.
- Resuming a release that was tagged before this branch runs the new `verify.yml` on the old
  commit. That commit's `package.json` has no `verify:*` scripts, so the run fails without
  publishing anything. No release is unfinished today.
