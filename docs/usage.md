# Using emend

Day-to-day use of the `emend` command: its settings, and how to publish a doc for review. To
install and set up emend first, start with [setup.md](setup.md).

## Configure

`emend config` lists the global configuration. `emend config add docRoots <folder>` lets agents publish docs
from a folder outside their repository. `emend config set openBrowser true` makes `emend` open your
browser instead of printing a one-time sign-in link. Run these yourself, never through an agent:
they change what your agents may publish.

The old state-folder config is copied once, only if the global config is missing, then renamed
`config.json.migrated`. An existing global config wins without merging the old file.
`EMEND_HOME` moves only state; set `XDG_CONFIG_HOME` too for a separate config.
For `docRoots` and `openBrowser`, publish and bare `emend` ignore a global config whose path or
links lie inside a repository holding the working directory, and warn. `emend config` refuses
there. An old state config inside such a repository is never read, copied or renamed.
A home-rooted dotfiles repository does not count. The server reads only `approvedActiveHours`, `approvedActiveLimit` and `keys`
from the file and does not apply this check. A config path set by a repository's environment
is not detected when emend runs from a folder outside every repository.
If `XDG_CONFIG_HOME` is absolute, `emend service install` records it at install time.
Reinstall the service after changing it.

Approved reviews stay in Active for 12 hours by default. Set `approvedActiveHours` in the global
config file to whole hours from 0 to 720, or use Settings → Inbox to override it for this server;
Reset falls back to the file, then the default, and 0 moves approvals out of Active at once.
Active keeps at most 5 approved reviews by default, choosing the newest approvals. Set
`approvedActiveLimit` in the global config file to a whole number from 0 to 200, or override it
in Settings → Inbox; 0 keeps none.

Active shows reviews that need you first (agent waiting, then unsent comments), followed by
To review, Answered and Approved. The newest change comes first inside each group.

Keyboard shortcuts work on desktop and tablet. Press `?` to list them. Settings → Keyboard shortcuts
changes, turns off or resets a key. Ctrl+Shift+P (⌘⇧P on a Mac) opens the command palette; type a
few letters of a command, move with the arrow keys and press Enter. Firefox keeps that key for a
private window, so pick another one in Settings there. In the config file, use
`"keys": { "inbox.next": "j", "file.toggleViewed": "shift+v", "review.snooze": null }`.
`null` turns a shortcut off. A key is one letter, digit or punctuation character, or `shift+`,
`mod+` or `mod+shift+` followed by a letter. `mod` means Ctrl, or ⌘ on a Mac.
See [api.md](api.md) for the command ids.

## Publish a doc

Publish any UTF-8 text file and get its review URL:

```sh
emend publish docs/plan.html
```

It prints the review URL, such as `http://127.0.0.1:3636/r/<review-id>`.

Run the same command after editing the file to add a revision at the same URL. Use `--key plan`
to keep one review when the generated file's path changes, or `--new` to start a separate review.
`--review <id>` updates a review directly. Add `--json` for the full result; the `--manifest` form
continues to print JSON. Markdown and HTML render by default; other text files show their whole
source with line numbers and syntax highlighting where available. `--source` shows every doc as
source, including Markdown and HTML, in the path shortcut only. It cannot combine with
`--manifest`; a manifest sets `view: "source"` per doc instead. For example,
`emend publish --source notes.md` keeps Markdown syntax literal. Source docs must be valid UTF-8
without NUL and at most 1 MiB; explicitly named binary files are refused. A folder walk skips names
that look like secrets (Markdown and HTML files publish whatever their name), folders named exactly
`secret`, `secrets`, `credential` or `credentials` in any case below the folder argument, binary
files, files that are too large or unreadable, and files shown as source that hold a private key
(walked Markdown and HTML that render are not scanned). Below a folder argument, an HTML asset
inside such a folder or holding a private key is not uploaded either. A file or folder named
explicitly is published as named, so never name a credential file or a secrets folder explicitly.
Name a public file the walk skipped, such as `passwords.ts`, to publish it. Skip warnings stop
after 20 (`SHORTCUT_LIMITS.warnings`), followed by a count of additional skips. Each folder argument still gets a summary line counting the published files.
CSS and JavaScript files in a folder also appear as source docs, even when an HTML doc
uses them as assets.

You can name several files or a folder. A folder bundles its visible text files with the
assets those HTML docs reference; dotfiles, `.git/` and `node_modules/` are skipped. Symlinks
leaving the folder are refused. A folder of HTML docs keeps its links and images; Markdown docs
in a folder do not link to each other or show local images yet.

The default key uses the instance and the sorted, distinct real input paths, so reordering the
arguments keeps the URL. Adding files inside a named folder also keeps it; changing the set of
input paths needs `--key` to keep one review.

`--main <path>` selects the opening doc, using its bundled path or its path from the current
directory. Otherwise emend picks the only doc, `index.html`, the only HTML doc, `index.md`,
`README.md`, the only Markdown doc, then the first doc in path order. The title comes from
`--title`, that doc's HTML title or first Markdown `#` heading, then its filename, capped at 200
characters. A source main doc uses its filename as the inferred title.

Docs must be in the current worktree or an allowed `docRoots` folder. For another folder, run
`emend config add docRoots <folder>` yourself first; temporary folders need permission too.
Publishing while the server is stopped saves the review and prints its URL; run `emend` or
`emend service install` to open it. An attached machine publishes to its hub.

## List your reviews and check the connection

`emend ls` lists the reviews this machine published, newest first, one line each: id, state, last
update, title and URL. It also lists snoozed and finished reviews, and it never shows comments. The
update time is UTC. Add `--json` for one JSON object with an `items` list. It shows at most the
newest 100. Each JSON item also carries `branch`, `newest` (`{ revision, head }` of the newest
revision, `null` without any) and `approved` (`null` while nothing is approved, else `{ revision,
head }` of the approved revision). `head` is a full commit id, `worktree` or `null`.

To check which commit an approval covers, run `emend ls --json --head <sha>` with the full commit
id (40 or 64 lowercase hex characters). It lists only reviews whose approved or newest revision has
that head. `head` and `branch` are what the publisher sent and are not verified, and a review of docs
or a plan alone shows no diff, so `approved.head` equal to `<sha>` means the reviewer approved a
revision labelled with that commit, not that its content was shown. To rely on it, also require
`approved.revision` equal to `newest.revision` and the expected `branch`, and check that the review
carried the diff. An item with `newest.head` equal to `<sha>` and `approved: null` is published but
not approved. It reads only, takes no comments and changes nothing.

`emend status` shows whether this machine is `local` or `attached`, the server or hub address,
the hub name when attached, this machine's instance name, whether the server or hub answers, and
the `emend` version. Add `--json` for the same fields as JSON, where `address: none` and
`instance: none` in the human form are `null`. It prints no token, creates no file, and reports a
server or hub that does not answer instead of failing.

## Stop the server

`emend stop` stops the server that `emend` started on this machine, for example after an update so
the next `emend` runs the new version. It does not stop a server the service runs: run
`emend service install` to restart that one, or `emend service uninstall` to stop it. When no
server runs, it removes a Tailscale Serve route that a crashed `emend serve --tailscale` left.

## A look around

The inbox lists every review and published doc, with the ones that need you first. A phone shows
the same groups as a desktop.

<p>
  <img src="images/inbox-desktop.png" alt="The inbox on a desktop, with six reviews and docs" width="73%"
  >&emsp;<img src="images/inbox-phone.png" alt="The inbox on a phone" width="21%">
</p>

A plan or other doc that comes with a review opens next to its diff, with its diagrams drawn and
your comments beside the text.

![A plan doc with a state diagram and a comment thread](images/doc-desktop.png)

Comments stay unsent until you press Send. The Comments tab lists them, and the Send bar lets you
pick how the agent should act on them.

![The Comments tab with three unsent comments and the Send button](images/send-desktop.png)

Download (on a phone: in the menu) saves the revision on screen as one HTML file that opens offline
in any browser, so you can send it to someone who cannot reach emend. A code review's file holds
its writeup; a published doc's file holds that doc. You can tick docs to add them. With any doc
ticked, the download is a ZIP holding the writeup file (or the pub's base doc) and one HTML file
per selected doc. Rendered and source views of the same path are separate choices; source choices
say “source” beside the path. Links between files stay plain text. Diagrams show as their source
text. Tick Comments and replies to add the sent comments and the agent's replies next to their
text; unsent comments stay out. File names are made safe for Windows too. Size and CSS processing
limits are shared across the download. A doc that does not fit is replaced by a page with its
title and a left-out note.

An HTML doc's comments come in a separate list or file, never inside the doc.
