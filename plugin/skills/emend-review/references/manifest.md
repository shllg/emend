# First review manifest

Create one private temporary folder per review, outside the worktree, using a POSIX shell:

```sh
review_dir=$(mktemp -d "${TMPDIR:-/tmp}/emend-review.XXXXXX")
printf '%s\n' "$review_dir"
```

GNU and BSD `mktemp` give it mode 0700. On Windows, create an equivalent private, unique folder
in the user's temporary directory. Before reusing an existing review folder, replace `<folder>` with its literal path.
Write the literal path without a trailing slash; a trailing slash makes `find` follow a symlink.
Run:

```sh
find "<folder>" -maxdepth 0 -type d -user "$(id -u)" -perm 700
```

Reuse it only when the command prints the folder path. GNU and BSD `find` check ownership and exact mode 0700.
The `-type d` check excludes symlinks. If the check fails, tell the user its literal path and that its saved results were not read.
Then create a new folder with the same `mktemp` command and rebuild the manifest.
Save a manifest like this as `review.json` there. Report the literal folder path with the review id;
shell variables do not survive between tool calls. Substitute that path for `<review-folder>` below.
For code, run `emend publish --manifest "<review-folder>/review.json"` from the repository being reviewed.
Keep saved wait output and reply body files in that same folder. Never read or write any of these
files at a fixed shared path or inside the worktree.
Use a review folder from one session at a time.
A second session on the same review creates its own folder only after the first has stopped.
Nothing enforces this rule.
Any session may read saved wait output after the folder passes the check.
Before reading saved results and before every `emend wait` or `emend feedback`, run this GNU or BSD `find` check.
Write the literal path without a trailing slash; a trailing slash makes `find` follow a symlink.

```sh
find "<review-folder>" -mindepth 1 -maxdepth 1 \( ! -user "$(id -u)" -o ! -type f \)
```

It prints every entry this user does not own and every entry that is not a regular file.
If it prints anything, tell the user each name, take no new hand-off in this folder, and stop.
The folder is no longer private.
Otherwise, list saved results and the handled record with GNU or BSD `find`, again without a trailing slash:

```sh
find "<review-folder>" -maxdepth 1 -type f -user "$(id -u)" \( -name 'wait-*.json' -o -name handled.txt \) | sort
```

Read only files this command prints: regular files owned by this user; `-type f` excludes symlinks.
Do not check group permissions in this listing.
An older `wait.json` also counts as saved output. List it with the same ownership and regular-file checks:

```sh
find "<review-folder>" -maxdepth 1 -type f -user "$(id -u)" -name wait.json
```

Use the literal path without a trailing slash here too. Read legacy `wait.json` only if this command prints it.
Otherwise, if it exists, do not read it and tell the user its name.
Never delete a saved file you did not see fail.
When listing, skip a `wait-*.json` that is empty or not complete JSON.
A wait may still be writing it, in this session or another.
Do not read or delete it; list it again later.
Tell the user its name if it stays empty after the waits you started have finished.
Apply the same rule to legacy `wait.json`.
Before running `emend wait` or `emend feedback`, handle every saved `go` whose `deliveryId` is absent from `handled.txt`.
Handle them oldest first: legacy `wait.json` first, then timestamped names in plain `ls` order (text order is time order).
If `handled.txt` is absent, no deliveries are recorded as handled.
Check comment ids and earlier outcomes; repeat a reply rather than skip one when resuming partly handled feedback.
The CLI confirms receipt only after the full JSON is written; a confirmed hand-off will not be offered again.

Save each new `emend wait` or `emend feedback` result with `--save "<review-folder>"`.
emend writes it as `wait-<UTC time>.json` in that folder, with mode 0600, and never replaces an existing file.
The file is complete or absent. emend confirms receipt only after it saved the file and printed the JSON.
A command that exits non-zero may have saved a file without confirming it; the server then offers the same feedback again later under a new `deliveryId`.
After any non-zero exit, list the folder again, read any new file like any saved result, and skip comments you already answered.

Use the command the loop needs:

```sh
emend wait <review-id> --timeout 540 --save "<review-folder>"
emend feedback <review-id> --save "<review-folder>"
```

Run `emend wait` the way your harness allows a long command. Start one only when no `emend wait`
you started on this folder is still running; a delegated sub-agent never starts one.

- Claude Code: run `emend wait <review-id> --timeout 86400 --save "<review-folder>"` in the
  background (`run_in_background`), then end your turn. A background command is not held to the
  10 minutes of a foreground one, and its completion notification wakes you. If you stop the
  review loop before the wait ends, stop that command.
- Codex: run it with `exec_command`. While the wait runs, `exec_command` returns a `session_id`;
  call `write_stdin` on it with empty `chars` and `yield_time_ms` 300000 until the command exits.
  If your shell tool takes `timeout_ms` instead, set it above the wait, such as 600000.
- Anything else: in the foreground. If your shell tool stops commands sooner than 9 minutes, pass
  a `--timeout` below that limit.

When the command ends, read its output first: the exit code, any error line and any warning.

On success, repeat the folder-entry check and ownership listing above, then read the file you just wrote.
After reading a `pending` result, delete that file; only `go`, `approve` and `closed` results stay.
`pending` means no hand-off is waiting now; wait again while the session can stay active.
If the session must end, tell the user the review id and literal folder path.
The emend-feedback skill continues from them.
Handle a `go` through emend-feedback. After its last reply and any new revision, append its `deliveryId` as one line.
For a new or saved `approve`, report the approved revision, append its `deliveryId`, and stop.

`closed` means the reviewer retired or snoozed the review. Save and confirm it like `approve`, record its `deliveryId` as below, and never start another wait after it.

- `reason: "retired"`: stop the loop and tell the user the reviewer retired review <review-id>.
- `reason: "snoozed"`: stop the loop and tell the user: "The reviewer moved review <review-id> down until <time>. When they send feedback, resume with `/emend:emend-feedback <review-id>`." When `until` is `null`, say "until its next revision" in place of the time.

If an error line reads `review <review-id> is in the bin` (or a publish line says `is in the bin`), `review <review-id> was deleted or never existed` or `review <review-id> was deleted on the hub`, stop the loop. Tell the user that the reviewer moved review <review-id> to the bin, where they can restore it under Settings in emend, or that it was deleted, and quote the line. Offer to publish the current state as a new review. Publish only after the user agrees: run the same publish command without `--review` and with `--key <new-key>`, where `<new-key>` is a name this work has not used before, then continue with the new review id the publish prints.

Use the verified `handled.txt`, or create it if absent, replacing `<deliveryId>` with that result's field:

```sh
(set +C; umask 077; printf '%s\n' '<deliveryId>' >> "<review-folder>/handled.txt")
```

This subshell turns noclobber off so zsh can append even when `handled.txt` does not exist yet.
It sets `umask 077` so a newly created record is mode 0600.
A saved result whose `deliveryId` is listed there is handled. Keep the original JSON intact.
Before waiting again, repeat the folder-entry check and ownership listing above, then handle every remaining saved `go` oldest first.

With `head: "worktree"`, a manifest inside the worktree publishes itself under Other changes.
This example is entirely synthetic. Replace its base with the full merge-base commit hash,
and use real changed paths and accurate writeup text. `head` may also be a full commit hash.

The PRD is included as a diff because it changed, and as a doc because the reviewer needs to
read it. The cited ADR did not change, so it has only a `doc` entry.
Both docs name the topic whose prose leans on them. The topic cites the ADR's heading in words.
A doc's `path` is its published name. When the local filename differs, set `source`
to its local filename.
Relative `source` paths resolve from the repository root or, outside a git repository, from the folder publish runs in.
Outside a git repository, every doc source must sit in a folder listed in `docRoots`.
If one does not, ask the user to run `emend config add docRoots <folder>`; never run `emend config` or edit emend's configuration yourself.
It must end in the same kind of extension as `path`.
A doc's `source` must be inside the repository's worktree or inside a folder the user listed in
`docRoots` in emend's global configuration.
When publish prints `source is outside the allowed doc roots`, stop and ask the user to run `emend config add docRoots <folder>` for that folder, or to move the doc into the repository. Never run `emend config` or edit emend's configuration yourself.
A doc's optional `view` is `"rendered"` or `"source"`. Markdown and HTML render by default;
use `"source"` to read their literal text with line comments. Any other UTF-8 text file is a doc
shown as source with line comments. One path may appear once rendered and once as source.
Choose the view per file. Markdown renders as safe blocks; the writeup stays Markdown.

Set optional `main` to `"writeup"` or a declared doc path to choose the opening page, even with an empty writeup.
Without `main`, the app opens a nonempty writeup, then the first doc in manifest order, then the diff, or Writeup if nothing exists.
An explicit visible URL tab wins; a main doc opens Docs scrolled to that document.

`decisions: null` means the decisions section was not written because the original request is
unavailable. When that request is known first-hand, replace null with Markdown describing how
the change runs, assumptions, drift, and independent review findings. A docs-only review omits
both `base` and `head`, includes only doc entries, and needs `--key` for its first publication.
A code review on a detached HEAD also needs `--key` for its first publication.
`--key` is only for a first publish; later revisions use `--review <review-id>`.
Pick a key unique to this review, such as the doc's name and today's date
(`offline-sync-plan-2026-11-02`). A key names one review: publishing with a key that is already in use adds
a revision to that review.

Screenshots and other images for the writeup go in `media`, a list next to `files`.
Each entry is `{ "path": "media/before.png", "source": ".shots/before.png" }`.

- `path` is the published name and `source` the local file. Without `source`, publish reads `path`.
- Save the file in the worktree, in a folder git ignores, or in a `docRoots` folder.
- Use PNG, JPEG, GIF, WebP or AVIF only. The source must end in the same extension as `path`.
- Each file is at most 25 MiB. A review holds at most 50.
- `path` has no segment that starts with `.`, has no `:` and is unique.

How to show them in the writeup is in [the writing reference](writing.md).

Use these constraints when writing the manifest:

- Topic slugs use lowercase letters, digits and `-`, at most 64 characters. Start with a letter or digit.
- `scope` is one word, at most 32 characters.
- Set `attention` on every topic, as the writing reference rates risk: `skim` (Low), `review`
  (Medium) or `critical` (High).
- A `skim` topic starts folded.
- Tests that only follow the code, when there are any, go into one topic after every other topic
  you declare: slug `tests` (`routine-tests` if `tests` is taken), title "Tests that follow the
  code", attention `skim`, importance 99, which no other topic uses. A test file stays in its
  feature topic only when it holds an edge case, a tricky setup, a changed expectation, or a
  removed or weakened assertion, with a note on those lines that says why.
- Attention never changes order. `importance` alone sorts.
- Leave out `door`. A topic that a revert does not undo ends its `why` with an **Undo:** line.
- `writeup.review` is `{ "level", "topics"?, "reason" }`. `level` is `skim`, `topics` or
  `everything`. `topics` lists declared topic slugs, only with level `topics`. `reason` is one
  short sentence.
- Publish refuses a verdict that contradicts the topics. A `critical` topic needs `everything`.
  `skim` needs every topic at attention `skim`. `topics` must name every topic at attention `review`.
- `writeup.checked` and `writeup.notChecked` are Markdown and never blank.
- `title` is at most 200 characters; `summary` is at most 2000.
- `links` is optional: at most 8 entries of `url`, `label` and `kind`. `url` is an `https:` URL
  without a user name or password, at most 2048 characters. `label` has 1 to 60 characters.
  `kind` is `pr`, `issue` or `other`. Leave `links` out when there are none. An invalid link
  fails the publish; fix it and publish again.
- For a code review, emend takes the repository's web address from its `origin` remote, which
  links `#123`. Set `repoUrl` only when that remote is not where the issues live. It must be
  exactly `https://host/owner/name`, with no trailing slash, path, query or fragment; an invalid
  `repoUrl` is ignored. Set `"repoUrl": null` when the user does not want the repository's
  address stored with the review.
- `base` and `head` are full commit hashes. `head` may be `worktree`.
- `importance` is 0 to 99. The reserved Other changes topic uses 100.

Spell every key exactly as in the example, because unknown keys are dropped silently.
Only `diff` files accept `notes`. Use single-digit notes on a large change, at most eight per file and 64 per revision.
Each note earns its place with a decision, trade-off, risk, or something easy to get wrong.
Never write “this adds a method”. Write `summary` as one sentence of 15 words or fewer, at most 160 characters.
It must fit on one line. Optional `rationale` has at most 1200 characters. Both fields are plain text, never Markdown or HTML.
Set `side` to `old` or `new`. Take `start` and `end` from the patch's `@@` headers or the file; never guess.
They are positive integers, with `end` at least `start`.
Publish refuses a range outside the stored diff side, a missing side, or a flagged file, naming the file and note index.
Unchanged stored lines are valid in a file with changed content.
Publish and import refuse notes when the file's old and new content is identical.
Notes are read-only revision content, carried by export and import.
Use `ref` only when a writeup bullet cites the note with `<span class="ref">ref A</span>`.
Assign `A`, `B`, `C`… in file order, restarting per topic. Refs must be unique within the topic.

For an invalid manifest, the CLI names the failing fields.
If it says the manifest is not found, check the path. If it says the manifest is not valid JSON,
fix the syntax at the line it names, if any; with no line, check for an empty or cut-off file.
An unescaped quote or line break inside a string is the usual cause.
Fix those fields and publish again.

```json
{
  "version": 1,
  "title": "Bound the retry budget",
  "base": "1111111111111111111111111111111111111111",
  "head": "worktree",
  "links": [
    { "url": "https://github.com/example/app/pull/42", "label": "PR #42", "kind": "pr" },
    { "url": "https://github.com/example/app/issues/17", "label": "Issue #17", "kind": "issue" }
  ],
  "topics": [
    {
      "slug": "retry-budget",
      "title": "Retry budget",
      "importance": 10,
      "attention": "review",
      "summary": "Requests stop retrying after three attempts.",
      "blastRadius": { "scope": "user", "note": "A failed request could stop before a later attempt succeeds." }
    }
  ],
  "files": [
    {
      "path": "src/retry.ts",
      "role": "diff",
      "topic": "retry-budget",
      "notes": [
        {
          "side": "new",
          "start": 38,
          "end": 44,
          "summary": "The first call consumes one attempt, keeping the retry budget finite.",
          "rationale": "Counting only retries would allow a fourth call.",
          "ref": "A"
        }
      ]
    },
    { "path": "docs/retry-prd.md", "role": "diff", "topic": "retry-budget" },
    { "path": "docs/retry-prd.md", "role": "doc", "topic": "retry-budget" },
    { "path": "docs/adr/2026-07-01-retries.md", "role": "doc", "topic": "retry-budget" }
  ],
  "writeup": {
    "tldr": "Requests that kept failing retried without end and held the request loop. Each request now stops after three attempts, as the retry PRD asks.",
    "review": { "level": "topics", "topics": ["retry-budget"], "reason": "Every request passes the new retry loop." },
    "checked": "- Unit tests for one, two and three failed attempts pass.\n- The full test suite passes.",
    "notChecked": "- A real network that drops requests.",
    "overview": "- **Goal:** Failed requests must stop retrying.\n- **Change:** Each request gets three attempts.",
    "outOfScope": "- The wait between attempts.",
    "whereToLook": "- **Biggest risk:** An early stop could discard the final attempt.\n- **Check first:** Read `src/retry.ts` in Retry budget.",
    "context": "- The request loop and its PRD change.\n- No new dependency.\n- The retry budget follows `docs/adr/2026-07-01-retries.md`.",
    "decisions": null,
    "glossary": [{ "term": "Retry budget", "definition": "The total number of attempts allowed for one request." }],
    "topics": {
      "retry-budget": {
        "why": "**What it is:** The request loop retries temporary failures.\n\n**Problem:** Repeated failures kept the loop running.\n\n**Fix:** The loop stops after three attempts.",
        "example": "A request fails on every attempt.\n\n| Input | Before | After |\n| --- | --- | --- |\n| Repeated temporary failure | Retries continue | Stops after attempt three |",
        "body": "- The first call counts as attempt one. <span class=\"ref\">ref A</span>\n- A successful attempt ends the loop immediately.\n- Check that the third attempt can still succeed.\n- The retry budget follows `docs/adr/2026-07-01-retries.md`, section Consistency model."
      }
    }
  }
}
```
