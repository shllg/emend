---
id: 015
title: Reading docs, slice A
status: in-progress
owner: agent + your approval
depends_on: [005]
done_on:
---

# 015 — Reading docs, slice A

Plan task 1.12d, the first slice of the rewritten plan task 1.12b. You approved its design and
its rule text on 2026-11-05, after the security review. Every doc gets a title in a doc switcher,
Contents, links that open other docs with Back, and a reading position that survives. HTML docs
fill the reading pane in their own layout, with a Comments drawer. The Reading view of HTML docs
is slice B.

## Steps

- [x] Checkpoint 1: doc titles, headings and links to other docs (contract, API docs, core,
      server, the doc-navigation rule text).
- [x] Checkpoint 2: the doc bar, the Docs switcher, Contents, links, history and Back, and
      position memory.
- [x] Checkpoint 3: HTML docs in the full reading pane, the Comments drawer and the frame
      messages.
- [ ] Reviews pass for each checkpoint: emend-reviewer, the Codex review and
      emend-security-reviewer.
- [ ] You: check it on the laptop and the phone after checkpoint 3.

## Done when

The three checkpoints have landed and passed their reviews, and you have read a review with
several docs on the phone.

## Notes

- 2026-11-05: Opened after you approved slice A's design and rule text.
- 2026-11-05: Checkpoint 2 passed five review rounds. You chose lookup names for heading links
  (author id, hunk-review slug, GitHub slug) over readable ids, and approved four rule lines in
  `doc-navigation.md`.
- 2026-11-05: Checkpoint 3 passed seven review rounds. Most findings were in HTML position memory.
  It now measures against a reading line in the frame's viewport, and a restore is a bracketed
  search over the distance moved. The bridge reads every DOM property through its prototype and
  handles every same-doc link itself.
