---
id: 017
title: Any text file as a doc, shown as source
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-05
---

# 017 — Any text file as a doc, shown as source

## Why

Plan task 4.7 (the plan of record's "Task 4.7: Any text file as a doc, shown as source"; read that
section in full before you start). Today a file reaches a review only as a diff (the changed lines
against a base commit) or as a rendered doc, and only Markdown and HTML can be docs
(`apps/emend/src/cli/publish/resolve.ts`). The owner wants a whole file shown as source: a config,
a script, a SQL file, a log, or the source of a Markdown or HTML file, with line comments. Images,
PDF and media are out of scope. The owner said "yes, now" on 2026-11-05.

## Steps

- [x] Contract first (`packages/contract`, `docs/api.md`), all additive: the manifest's file entry
      gains `view?: "rendered" | "source"`. Markdown and HTML default to `rendered` and may ask for
      `source`; every other text file is `source`. The agent decides per file, not the extension
      (`VISION.md`). One path may appear both rendered and as source. `RevisionView.docs[]` gains
      `{ path, kind: "source", language, lines }`, rendered on the server like a code block.
- [x] Failing tests first: a `.ts` file publishes as highlighted source; a `.md` with
      `view: "source"` shows its raw text; the same path rendered and as source; a binary file
      (not UTF-8, or containing NUL) is refused with one line; a line comment keeps its line after
      an insert above it in the next revision; markup in the source shows as text, never as markup.
- [x] Server: the whole file, highlighted with Shiki (already a dependency of `packages/core`) by
      extension, plain text when the language is unknown, with line numbers. Its size limit is the
      Markdown doc's (`LIMITS`, today 1 MiB). Rendering goes through the sanitize rules of
      `.claude/rules/content-isolation.md`.
- [x] Web: the source view with line comments as on a diff line. A line comment on a source doc
      follows its text into the next revision, like a diff comment (reuse or extend the line
      target and its placement).
- [x] CLI shortcut: `emend publish config.yaml` shows source; `emend publish notes.md` renders;
      `--source` shows a Markdown or HTML file as source. The folder walk of `emend publish <dir>`
      takes every text file.
- [x] Reviews: `emend-reviewer`, a fresh Codex review and `emend-security-reviewer` (rendering
      agent content). Checkpoint: `feat(render): show any text file as a doc with line comments`.
- [x] Sync: check the change against hunk-review-skill and record the outcome in the commit body.

## Done when

A text file of any kind publishes as a doc shown as source, with line comments that follow their
text into the next revision; the tests above pass in `pnpm verify`, and the three reviews passed.

## Notes

- Parallel work: plan task 1.12d (repo task 015, branch `feat/015-reading-docs-slice-a`) is
  rebuilding the docs pane right now: the doc bar, the Docs switcher, Contents, history and
  position memory (`apps/web/src/components/reading/`, `apps/web/src/routes/review.tsx`,
  `apps/web/src/lib/reading-position.ts`, `RevisionView.docs[]` gains `title` and `headings`).
  Keep this task's changes to those files small and additive, so the rebase onto 015 stays easy.
  Do not build a doc switcher or doc bar of your own; a source doc appears in the existing doc list.
- Rules to read first: `AGENTS.md`, `.claude/rules/content-isolation.md`,
  `.claude/rules/api-and-auth.md`, `.claude/rules/cli.md`.
- No new dependency without the owner's approval.
- Done 2026-11-05: source docs are Shiki tokens (never HTML) in `text/plain` doc rows, with a
  `source-lines` target, per-revision line, byte and highlight budgets, progressive line mounting
  and a folder walk that skips secret-looking, binary, oversized and unreadable files. Follow-ups:
  source reading positions (after 015), re-anchoring resumed line drafts, camelCase secret names.
