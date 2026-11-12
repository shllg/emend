# Architecture

emend is a local-first review tool for plans, documents and code. One distributable,
`@shllg/emend`, contains the Node command and server together with the built browser app. Hub
mode is a setting of the same app. This page describes the intended runtime; the initial
workspace scaffold implements the version command and a minimal browser shell.

## Repository boundaries

| Path | Responsibility |
| --- | --- |
| `apps/emend` | The CLI, local server, MCP endpoint and headless service. Serves the web build. |
| `apps/web` | The React and Vite browser app. |
| `packages/contract` | Shared schemas for the API, review manifest, file roles and capabilities. |
| `packages/core` | Pure logic for safe Markdown blocks, block ids, comment placement and topics. |
| `plugin` | The Claude Code plugin. `plugin/skills` holds the skills for creating reviews and handling reviewer feedback. |
| `docs` | The versioned API contract and architecture. |
| `sync` | Surfaces shared with hunk-review-skill and synthetic fixtures. |

Core has no Node-only or browser-only APIs; WebCrypto is allowed. Both apps can use it without
introducing a runtime dependency on the other app. Contract and core expose their TypeScript
sources to workspace consumers. Vite builds the browser app first; esbuild bundles the CLI
as Node 24 ESM, then copies the browser output into `apps/emend/dist/web`. The runtime requires
Node >=24.18.0; SQLite warning behavior has been verified on Node 24.18.0 and 26.12.0.

## One machine

The global config is a plain JSON object in `$XDG_CONFIG_HOME/emend/config.json` when
`XDG_CONFIG_HOME` is absolute, else `~/.config/emend/config.json`, on Linux and macOS.
The file or its folder may be a symlink. An old `config.json` in the state folder is copied only
when the global file is missing. An exclusive create lets only one concurrent migration win.
The old file is renamed `config.json.migrated`. When a global file already exists, the old file
is kept under that name without merging, and the CLI prints a warning. A failed rename does not
fail the command. If the global file cannot be created, the old values apply only for that run.

For `docRoots` and `openBrowser`, publish and bare `emend` ignore a config file whose path or
links lie inside a repository holding the working directory. They warn; `emend config` refuses
that global file. An old state config inside such a repository is never read, copied or renamed.
An old config outside it can still supply values in memory. A dotfiles repository rooted at the
home folder does not count. The server reads only `approvedActiveHours` and `keys` from the file
and does not apply this check. Known limit: a config path set by a repository's environment is not detected
when emend runs from a folder outside every repository.

Settings have defaults. The config file's `approvedActiveHours` sets how long approved reviews
stay in Active. A value set in Settings is stored per owner in that server's database and wins.
Clearing it falls back to the file, then the default of 12 hours. The file's `keys` sets keyboard
shortcuts the same way: a stored key wins, then the file, then the default. Each server, hub or attached
machine, reads only its own file and database. Settings do not sync between servers.

The default `emend` command starts a server if needed and prints a one-time sign-in link; it opens
the browser only when the global `config.json` sets `"openBrowser": true`. `emend config`
lists and changes this file's `docRoots` and `openBrowser`; each publish or bare `emend`
call reads them again, so no server or restart is needed. Outside a terminal it prints no link or
pairing code. This keeps links out of agent output; it does not stop a
process that can open a terminal, read the state folder, or, with `openBrowser` on, choose the
opener.
Publish re-checks each stored doc root and refuses one that is not a real path or that `emend config add` would refuse.
`emend serve` runs without opening a browser; `emend service install` installs a systemd
user unit or a launchd agent. The server binds `127.0.0.1:3636` unless `--host` or `--tailscale`
explicitly widens access. There is no telemetry.
If `XDG_CONFIG_HOME` is absolute, the service install records it. Reinstall after changing it.

Agent commands (`publish`, `wait`, `feedback`, `reply` and the MCP tools) work with or without a
running server and never start one. They use a discovered server's API, or open the same local
state directly when discovery finds no server. Attached publish, wait, feedback, reply and MCP tools use
the hub; pairing a phone happens on the hub. Only the reviewer command `emend`, explicit
`emend serve`, and the service start a server. Direct writes send no
live event; the browser sees them on its next load. A direct wait polls every second, renewing a
30-second database waiter every 10 seconds so a later server can show that the agent is waiting.
A killed wait's row stops counting after 30 seconds and the next wait removes expired rows for
that owner. A challenge timeout or hidden pid can select direct mode while a server is running;
shared claims and transactions keep writes safe, but a newer CLI may migrate the database under
a running older server. Blob files are the exception: the lock that guards blob removal after a
delete holds only inside the server, so a direct publish that reuses the same content at that
moment can lose a file. Publishing that content again restores it.
A signal after a hand-off is claimed leaves it unconfirmed, and it is offered again after the lease.

State is one SQLite database and a content-addressed blob store with SHA-256 names. `EMEND_HOME`
overrides the platform data location: the XDG data directory on Linux, Application Support on
macOS. It moves only state; set `XDG_CONFIG_HOME` too for a separate config.
Each instance has a stable id and a name, defaulting to the hostname.
Both live in the state folder's `instance.json`, which emend creates once and never rewrites. If
that file is deleted, the next server start or direct-mode command creates a new instance:
reviews published before stay, but agents on this machine reach only the new instance's reviews.
The next server start also revokes the old instance's admin and agent tokens and writes new ones.
Tests always use temporary state directories.

## Attached machines and the phone

An always-on machine can serve as the hub. `emend serve --tailscale` exposes its server through
Tailscale Serve HTTPS. Pairing provides a one-time link, QR code and code for browser sessions.
A phone opens the same web app and can install it with Add to Home Screen. Its session has
reviewer privileges only.

A laptop attaches with `emend attach <pairing-link>`, storing the hub URL and a machine token.
Its CLI then publishes to and waits on the hub; it does not need a local server. The default
command prints the hub address, or opens it when the global `config.json` sets
`"openBrowser": true`. An unpaired browser sees the pairing page.

Attach records the pairing origin in a private `attach.pending` file before it asks the hub for
a token, and removes it once the attachment is saved. If a crash leaves that marker or a
`hub.token` without `attach.json`, the next attach or detach, holding `attach.lock`, revokes the
token only at the recorded origin, never sends a token that has no valid marker, and removes the
marker last. A token emend receives but does not keep is revoked at once; when the hub does not
confirm it, the error says to revoke the machine in the hub's devices.

Attach copies existing local reviews whole, including revisions, files, threads, comments,
Sends and open deliveries, while retaining review ids. Repeating attach skips reviews already
on the hub. Local copies become read-only links to the hub. Detach makes new reviews local;
reviews already on the hub stay there. There is no two-way synchronization in the MVP.
A copy whose outcome is unknown keeps the review read-only here and says "Run emend attach
again"; the next attach finishes it. Only one attach runs at a time per state directory.

Reviews on the hub belong to its owner. Each records its origin instance, shown as an inbox
badge; a machine token reaches only that instance's reviews. If the hub is unreachable,
publish and wait fail with one clear line and change nothing. Offline queuing is deferred.
