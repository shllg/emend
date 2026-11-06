---
id: 022
title: Stream content-path assets
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-06
---

# 022 — Stream content-path assets

## Why

Plan task 4.8c. The content path serves each HTML doc asset through a full in-memory buffer. The
route (`apps/emend/src/server/content/route.ts`, around lines 57 and 74) and the blob store
(`apps/emend/src/store/blobs.ts`, around line 162) read the whole file, copy it, hash it with a
synchronous SHA-256 on the main thread, and copy it again. So one request holds about three times
the asset's size.

Agent-written HTML can request the same asset under many query strings (`big.png?1`, `big.png?2`,
...). The route ignores the query and the response is `no-store`, so nothing dedupes those
requests. Plan task 4.8 raises the asset limit from 8 to 25 MiB, which makes this about 75 MiB per
request and several hundred MiB per viewing device with parallel loads.

The writeup image route (`apps/emend/src/server/routes/media.ts`, around lines 35 and 47) buffers
the same way, for images up to 25 MiB. Behind `--tailscale`, HTTP/2 allows many more parallel
requests than loopback HTTP/1.1.

## Steps

- [x] Failing tests first: an asset response and a writeup image response are streamed (peak
      memory does not scale with the number of parallel requests for a large blob), the size is
      checked with `fstat` before any byte is sent, and a blob whose content does not match its
      hash never reaches the client, not even in part.
- [x] Put the streaming read in `BlobStore`, so the content route and `media.ts` share it. Hash
      without whole-file copies and without synchronous hashing on the main thread. A hash checked
      only while streaming sends bytes before the mismatch is known, so decide how a mismatch
      stays unsent: for example, verify once with a streamed hash and remember the result keyed by
      the blob's hash and its file identity (inode, size, mtime, ctime), checked again from
      `fstat` on the open descriptor before each response. Record the choice in Notes.
- [x] Consider a server-wide cap on concurrent blob reads. Record the call in Notes.
- [x] Keep every header and rule in `.claude/rules/content-isolation.md` exactly as it is:
      server-chosen `Content-Type`, `nosniff`, the CSP, owner isolation, `404` for a missing or
      foreign blob.
- [x] Reviews: emend-reviewer, the read-only Codex review and emend-security-reviewer (content
      path and rendering of agent content).
- [x] One commit: `perf(api): stream html doc assets and writeup images from disk`.

## Done when

Large assets and writeup images are served without whole-file buffers or copies, a mismatched
blob never reaches the client, the content-isolation headers are unchanged, `pnpm verify` is
green, and the reviews are clean.

## Notes

- Merge order: this task lands before plan task 4.8 (task 019), which raises the asset limit to
  25 MiB. That branch rebases onto this one and is checked again.
- Mismatch choice: `BlobStore.open` checks the size with `fstat` on the open descriptor, then
  hashes that descriptor in 64 KiB reads before any byte is sent. The result is remembered by sha,
  device, inode, size, mtime and ctime (nanoseconds), at most 4096 entries, oldest dropped first,
  and every request compares it with `fstat` on its own descriptor. Parallel first requests share
  one hash; a failure is never remembered. The response streams from that same descriptor, so a
  blob replaced by rename cannot swap bytes under it. Not caught: another local process rewriting
  the file in place while it streams, or keeping every identity field; emend replaces blobs only
  by rename.
- Hashing: SHA-256 runs on the main thread, one 64 KiB slice per awaited read, never as one call
  over the whole file. A blob that fails the check is hashed again on each request, because a
  failure is never remembered.
- Cap call: no server-wide cap on concurrent blob reads. Memory per response is one chunk plus
  socket backpressure (node-server pre-reads at most three chunks), the hash is shared and
  remembered, and a cap would queue responses behind slow clients.
- The descriptor follows the request's abort signal: node-server drops a body returned after the
  client left without cancelling it. Node 26 ends the process when garbage collection closes a
  FileHandle, so the route test fixtures fail a test that leaves a blob read open.
- `tightenSecretFile` now skips a chmod when the mode is already 0600: a no-op chmod moves ctime,
  which made a check in flight fail and threw away remembered results. The blob open adds
  `O_NONBLOCK`, so a FIFO at a blob path is refused instead of blocking a file thread.
- Follow-up, out of scope: the HTML doc itself stays buffered, because the bridge injection needs
  the whole text.
- Done: assets and writeup images stream from a checked descriptor; three reviews ran with no
  blocking finding, and their fixes are in. Follow-ups: off-thread hashing, an admission cap that
  also frees waiting requests on abort, slow-consumer tests through the adapter, and streaming the
  HTML doc itself.
