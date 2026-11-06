---
id: 019
title: Larger doc size limits
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-06
---

# 019 — Larger doc size limits

## Why

Plan task 4.8. Today emend shows a Markdown doc up to 1 MiB, and an HTML doc or asset up to 8 MiB,
with 20 MiB per HTML doc and its assets. Real docs outgrow that. The proposal:

- an HTML doc and each asset up to 25 MiB, and 50 MiB per HTML doc with its assets;
- Markdown up to 4 MiB, but only once a synthetic 4 MiB doc renders and places threads in
  reasonable time and memory;
- diff sides unchanged.

Measure first, then change the limits.

The measurements (Notes) showed that the publish worker cannot take the larger HTML and Markdown
docs. The owner chose to raise only the asset limits: each asset up to 25 MiB, and 50 MiB per HTML
doc with its assets. The HTML doc itself stays at 8 MiB and Markdown at 1 MiB, until plan task
4.8b makes the worker leaner.

## Steps

- [x] Step 1: measure render, thread placement and import time and peak memory for a synthetic
      4 MiB Markdown doc and a synthetic 25 MiB HTML doc with assets. Record the numbers and the
      method in this file's Notes. If the 4 MiB Markdown numbers are not reasonable, propose a
      lower Markdown limit and ask.
- [x] Step 2: contract first. Change `LIMITS.assetBytes` (25 MiB) and
      `LIMITS.htmlDocWithAssetsBytes` (50 MiB) in `packages/contract` and in `docs/api.md`, then
      the code that enforces them, with tests at each new edge (at the limit passes, one byte over
      is refused).
- [x] Step 3: check the knock-on limits and change them only where the new limits need it:
      `revisionBytes` (256 MiB), the block and rendered-byte caps per revision, the import
      budgets, the publish JSON body size, the blob upload ceiling and the CLI's upload timeout.
      Record each call in Notes.
- [x] Reviews: emend-reviewer and the read-only Codex review; emend-security-reviewer as well,
      because limits guard the CLI's file access and the server's input.
- [x] Checkpoint commit: `feat(contract): raise the asset size limits to 25 and 50 MiB`.

## Done when

The measured numbers are in Notes, the new limits hold at each edge in tests and in
`docs/api.md`, `pnpm verify` is green, and the reviews are clean.

## Notes

- Synthetic fixtures only; generate large docs at test time rather than committing them.
- This branch lands after the current merge chain (016, 017, 015, 018). Open the PR when it is
  ready; the merge waits for the coordinating session.
- Step 1 method: a throwaway harness, not committed. Docs were generated at run time from a seeded
  PRNG at exact byte sizes: typical Markdown (headings, paragraphs with inline marks and links,
  lists, TypeScript fences, tables, quotes), dense Markdown (one-line paragraphs of about 40
  bytes), code-heavy Markdown, typical HTML (sections, headings, paragraphs, lists, tables, code),
  image-heavy HTML (1 MiB of markup plus inline `data:` images) and random PNG-prefixed assets.
  Every job ran in the production publish worker (`workerExecutor()`: 256 MB old generation,
  32 MB young generation, 4 MB stack, 10 s render and 30 s placement timeouts), in a fresh worker
  and a fresh process, one at a time. Peak memory is the process's peak RSS, which includes the
  worker. The end-to-end runs used an in-process server with the same worker, LIMITS raised at
  run time, and 200 threads. Heap needs came from the same jobs with a larger
  `maxOldGenerationSizeMb`. Machine: AMD Ryzen 7 PRO 6850U, 16 threads, Node 26.12.0.
- Step 1, Markdown, production worker: typical 1 MiB renders in 2.1 s (title and headings
  1.4 s), 2 MiB in 3.4 s (2.7 s), 3 MiB in 5.0 s. Typical 4 MiB renders in 7.3 s (12817 blocks,
  11.0 MB of rendered JSON; title and headings 6.4 s), and ran out of worker memory
  (`ERR_WORKER_OUT_OF_MEMORY`) in 4 of 9 runs; with a 512 MB heap it renders in 6.5 s. Dense
  Markdown renders 1 MiB in 5.3 s (26215 blocks) and runs out of memory at 2 MiB; with 512 MB,
  2 MiB takes 12.2 s, over the 10 s render timeout; with 1 GiB, 4 MiB takes 41 s and makes
  104858 blocks, over `blocksPerRevision`. Code-heavy 4 MiB renders in 3.1 s (1985 blocks).
- Step 1, HTML, production worker: at 8 MiB, title and headings take 0.7 s and the placement
  text 1.5 s (peak RSS 457 MB). At 12 MiB the placement text runs out of worker memory, at 16 MiB
  both jobs do, and at 25 MiB both do, image-heavy HTML too. With 512 MB, 25 MiB still runs out
  for the placement text; with 1 GiB it takes 2.9 s, with a process peak of 1.1 GB. End to end,
  a 25 MiB HTML doc with two 12.5 MiB assets published in 2.4 s with its title and headings
  silently dropped, and its placement text, which every thread on it needs, ran out of memory.
  A placement failure refuses a later publish with `400` (`docs/api.md`). A two-revision import of a 4 MiB Markdown doc
  with 200 threads returned `201` in 22.5 s (807 rows); the harness did not check whether its
  renders succeeded.
- Step 1 call (owner, 2026-11-06): the 4 MiB Markdown and 25 MiB HTML numbers are not
  reasonable. Assets are never parsed (media and assets are checked by extension and size only),
  so only the asset limits rise: `assetBytes` 25 MiB, `htmlDocWithAssetsBytes` 50 MiB.
  `htmlDocBytes` stays 8 MiB and `markdownDocBytes` 1 MiB. Plan task 4.8b makes the publish
  worker leaner (streaming HTML text and heading extraction, cheaper dense-Markdown rendering)
  and then revisits those two limits.
- Step 3 calls. Changed, because the new asset limit needs them: the blob upload ceiling moves
  from `htmlDocBytes` to `assetBytes`, now the largest per-file limit (a contract test pins it
  at or above every other blob limit); without it a 25 MiB asset could not be uploaded. The CLI's
  blob upload timeout moves from a fixed 5 s to 5 s plus 1 s per started MiB (30 s for a 25 MiB
  asset); 5 s for 25 MiB would need about 42 Mbit/s to a hub. Unchanged: `revisionBytes`
  (256 MiB) still bounds a revision's total, which holds five HTML docs at the full 50 MiB and
  caps writeup media (50 images of up to 25 MiB each) at 256 MiB together. The block and
  rendered-byte caps and the import budgets stay, because assets are never rendered or placed
  and charge none of them. `publishJsonBytes` (8 MiB) stays, because blobs travel as separate
  uploads and the JSON body carries only their hashes. The worker's heap and timeouts stay,
  because nothing new is parsed. The attach copy keeps its 30 s per-blob upload timeout, the
  same as the new formula gives at 25 MiB.
- Review follow-ups, all older than this change, kept out of its scope: plan task 4.8c streams
  content-path assets instead of buffering each one three times (it lands before this branch);
  4.8d handles rendered blobs above the blob upload ceiling, which an attach copy cannot upload;
  4.8e bounds blobs that nothing references.
- Done: assets up to 25 MiB and an HTML doc with its assets up to 50 MiB, with the blob upload
  ceiling and the CLI's upload timeout to match; emend-reviewer, the Codex review and
  emend-security-reviewer found nothing above low.
