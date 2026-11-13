---
name: emend-publish
description: Publish a standalone Markdown or HTML document for the user to read (report, plan, analysis, cheatsheet) with `emend publish <path>` and return its review URL. Use it when you wrote, or are about to write, such a document and it is not a file the task adds to the repository. Also use it when the user asks to publish or share a document with emend, or to read one on a phone or another device. Not for source code, a hunk-review HTML writeup, or anything the user wants kept out of emend. Use emend-review for code review.
---

# Publish a document with emend

This skill needs the `emend` command on `PATH`.
If `emend` is not found, skip publishing, keep the local file and tell the user why.
Do not try to install emend.

## When to use

Use it when you wrote, or are about to write, a standalone document for the user to read.
Examples are a report, an analysis, a cheatsheet, a plan meant for reading or a writeup of your work.
Also use it when the user asks to publish or share a document, or to read one on a phone or another device.
A document the user asks you to publish may live in the repository.
Do not publish unasked a file the task adds to the repository, such as docs, specs or tasks.
Do not use it for source code, for a hunk-review HTML writeup (see "Publish") or for anything the user wants kept out of emend.
If you wrote it elsewhere, copy it into a doc root as step 1 says.

## Steps

1. Write the document into the repository when it belongs there.
   Otherwise write it into a folder the user allowed as a doc root.
   Prefer one Markdown file or one HTML file.
   Before you write it, read [the writing reference](../emend-review/references/writing.md) and
   follow it. It covers sentences, the TL;DR, the glossary, images and HTML pages.
   emend renders Markdown on its server: GFM tables, code colours, and ```` ```mermaid ```` fences become diagrams.
   Keep it out of hidden folders: folder publishing skips dotfiles and hidden folders.
   Tell the user the path of the file you wrote.
2. Publish it with the command under "Publish" below.
   Stdout is the review URL alone.
3. Give the URL to the user on its own line.
4. After a change, publish the same path again.
   The review keeps its URL and gets a new revision.
   Use `--key <name>` when a regenerated document lands at a new path each run.
   Use `--new` to start a separate review.
   A folder bundles its documents and the assets its HTML documents reference.
   `--main <path>` picks the document that opens first.
5. If publishing fails, keep the file, tell the user where it is and carry on with the main task.
   Publishing never blocks the work.
   If publish says the review is in the bin, tell the user they can restore it under Settings in emend.
   Offer to publish a new review with `--new`, and do so only after they agree.

## Publish

Run from the document's repository, or name a path under a doc root the user allowed.
The review shows its repository's name; outside one, add `--project <name>`.
Use a short, plain title; titles starting with `--` are refused.

`emend publish <file>` also takes any UTF-8 text file: config, script, SQL or log.
It shows these as source with line comments. Add `--source` to show Markdown or HTML as source.
A folder walk skips secret-looking filenames (not Markdown or HTML), binary, oversized or unreadable
files, text shown as source holding a private key, and folders named `secret(s)` or `credential(s)` in any case below the folder argument.
Below a folder argument, HTML assets in those folders or holding a private key are skipped too; other assets are not checked.
Explicit file or folder arguments publish as named; never name a credential file or secrets folder.
Warnings stop after 20, then count further skips.
Each folder argument gets a published-file count.

If an emend error line mentions an agent sandbox, show the user that line and stop.
Do not run emend another way, retry it outside the sandbox, ask for escalated permissions,
change sandbox or agent settings, or touch emend's state folder.

Publish the document with:

```sh
emend publish <path> --title "<title>"
```

When publish prints `source is outside the allowed doc roots`, stop and ask the user to run `emend config add docRoots <folder>` for that folder, or to move the doc into the repository. Never run `emend config` or edit emend's configuration yourself.

Pass every `emend:` note on stderr to the user.
Examples are skipped files, documents that could not render, or a stopped server.
When the server is stopped, publish still saves the review and prints its URL.

Do not publish a hunk-review HTML writeup with emend yet.
Its Markdown sits in script elements that emend does not run, so its sections show empty.

## Never publish

Do not publish secrets, credentials, API keys, tokens or `.env` content.
Check the file or folder before publishing.
Ask the user first before publishing anything they marked confidential.

## Feedback

No agent waits on this review.
The reviewer's comments reach an agent later through the emend-feedback skill, with the review id.
The review id is the last segment of the URL, `/r/<review-id>`.
