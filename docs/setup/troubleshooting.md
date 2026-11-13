# Troubleshooting emend setup

This page lists the errors you meet while you set up or update emend, with the line emend prints,
why it happens, and the fix. Find your line in the headings below. The setup pages link here:
[local.md](local.md), [hub-tailscale.md](hub-tailscale.md), [attach.md](attach.md),
[agents.md](agents.md) and [update.md](update.md). emend starts most error lines with `emend: `;
the lines below show it only where the exact text matters.

## An agent's sandbox blocks emend

emend prints:

```text
emend cannot write its state folder <folder>. If an agent sandbox runs emend, let emend run outside it: https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md#an-agents-sandbox-blocks-emend
```

Why: some agents run commands in a sandbox that keeps them from emend's state folder or from
the server on `127.0.0.1`.

Fix: run the command in your own terminal, or allow emend in your agent's own settings.
How depends on your agent, so see its documentation. Before you allow it, read
[What an agent can do with emend](agents.md#what-an-agent-can-do-with-emend).

Related lines:

- `emend: Could not contact the emend server.` The command reached no server. Inside a sandbox, this is
  the same cause. Outside one, see [emend is not running](#emend-is-not-running).
- `State directory <folder> has group or other permissions; fix it with chmod 700 '<folder>'`
  Run the `chmod` it prints. The state folder must be private to you.
- `Token file <path> has group or other permissions; fix it with chmod 600 '<path>'` Run the
  `chmod` it prints. emend reads no token that other users could read, and changes nothing until
  you fix it.

## emend is not running

emend prints:

```text
emend: emend is not running. Start it with `emend` or `emend serve --tailscale`.
```

`emend pair` and `emend devices` print this when no server answers. They never start one. Bare
`emend` starts a server instead. If that fails, it prints:

```text
emend: Could not start the emend server.
```

Why: no server runs, or the one that runs does not answer. Agent commands (`publish`, `wait`,
`feedback`, `reply`) do not need one: they work on the state folder directly.

Fix:

1. Run `emend` in a terminal. It starts a server if none runs.
2. If you use the service, run `emend service status`. If it says `installed but not running`,
   read [The service does not start](#the-service-does-not-start).
3. On a hub, `emend serve --tailscale` is what the service runs. Without the service, run
   `emend serve --tailscale` in a terminal that stays open, or install the service.
4. If another program holds the port, see [Port 3636 is in use](#port-3636-is-in-use).

Outside a terminal, `emend` prints `emend is running at <url>. Run emend in a terminal to get a
sign-in link.` That line is not an error: open a terminal and run `emend`. emend prints sign-in
links and pairing codes only to a terminal, which keeps them out of ordinary agent output. That is
not a security boundary: a process that can open a terminal can read them.

## Port 3636 is in use

emend prints:

```text
emend: Could not start the emend server.
```

Why: the server binds `127.0.0.1:3636`. Another program, or an `emend serve` you started earlier,
holds the port, so the new server cannot listen. emend prints the same line for other start
failures. The port is the first thing to check.

Fix: in your own terminal, find the program on the port. On Linux:

```sh
ss -ltnp 'sport = :3636'
```

On macOS:

```sh
lsof -nP -iTCP:3636 -sTCP:LISTEN
```

If it is an emend server that `emend` started, stop it with `emend stop`. If that says the server
is from an older emend, end it as
[A server from an older emend cannot be asked to stop](#a-server-from-an-older-emend-cannot-be-asked-to-stop)
says. If it is another program, move emend to another port:

```sh
emend serve --port 3700
```

Or, with the service:

```sh
emend service install --port 3700
```

`emend` finds the server through its state folder, so the port change needs nothing else. With
`--tailscale`, emend points Tailscale Serve at the port you chose. A route you made by hand with
`sudo` must name that same port.

## The service does not start

`emend service install` prints one of:

```text
the emend service did not start a server; run journalctl --user -u emend to see why.
the emend service did not start a server; see ~/Library/Logs/emend.log.
```

The first line is Linux, the second macOS. The path is printed in full. A second form says the
service runs but the command could not confirm its server: `the emend service runs, but this
command could not confirm its server; ...`. Its end adds that you should run
`emend service install` again in your own terminal if an agent sandbox runs the command.

Why: the unit or agent started but its server did not answer. Common causes: port 3636 is in use,
Tailscale is not running (with `--tailscale`), the Node.js the service was installed with is gone
after an upgrade (`brew upgrade node` or `mise upgrade node`), or the command ran in an agent's sandbox, which cannot reach the service
manager or `127.0.0.1`.

Fix:

- Linux: `journalctl --user -u emend`. The unit is `~/.config/systemd/user/emend.service`.
- macOS: `~/Library/Logs/emend.log`. The agent is
  `~/Library/LaunchAgents/dev.emend.server.plist`. Inspect it with
  `launchctl print gui/$(id -u)/dev.emend.server`.
- Run `emend service install` again after fixing the cause. After a Node.js upgrade it must run
  again.
- On Linux, a service that stops at logout needs linger. The install prints
  `To keep emend running after you log out, run sudo loginctl enable-linger $USER.`

If the problem stays, [Run without the service](#run-without-the-service).

## emend service refuses to run

`emend service` prints one of these lines, each with its own cause:

- `run emend service as the user who runs emend, not as root.` Run it as your own user, without
  `sudo`.
- `emend service supports systemd on Linux and launchd on macOS; run emend serve yourself.`
  Your machine has neither `systemctl` nor `launchctl` on its `PATH`. See
  [Run without the service](#run-without-the-service).
- `emend: this emend runs from inside the current repository (<path>); run emend from an install
  outside the repository.` The service must not run code that a repository can change. See
  [emend refuses to run from inside a repository](#emend-refuses-to-run-from-inside-a-repository).
- `<path> was not written by emend; move it away, then try again.` The unit or plist file at
  that path exists and emend did not make it. Move it away, then run the command again.
- `the node path contains $, quotes or a backslash, which a systemd unit cannot run; use a node
  installed at a plain path.` (Linux) Install Node.js at a path without those characters.
- `invalid saved service options; run emend service install with your options` The saved options
  are damaged. Run `emend service install` again with the options you want, for example
  `emend service install --tailscale`.
- `no saved service options; the service now uses the defaults` is not an error. It tells you
  that an installed service had no saved options, so it now uses `127.0.0.1:3636`.

## emend says the server runs another version

`emend` or `emend service status` prints one of:

```text
emend: the emend server at <url> runs emend <old>; this is emend <new>. Run emend stop, then emend, to start emend <new>.
emend: the emend server at <url> runs emend <old>; this is emend <new>. Run emend service install to restart it on emend <new>.
emend: the emend server at <url> runs emend <newer>, newer than this emend <version>; update emend: https://github.com/shllg/emend/blob/release/docs/setup/update.md
```

On an attached machine, `emend` prints this instead, ending in `Update the hub`,
`Update this machine` or `Update both to the same version`, and a link to update.md:

```text
emend: the hub at <url> runs emend <hub version>; this machine runs emend <version>. Update the hub: <link>
```

Why: a server keeps the version it started with. After an update, the server that `emend` or the
service started still runs the old version until it restarts. Agent commands never print this line.

Fix: run the command the line names.

- `Run emend stop, then emend`: the server is one that bare `emend` started. `emend stop` stops it,
  and the next `emend` starts the new version.
- `Run emend service install`: the service runs the server. The install keeps its options and
  restarts it.
- `newer than this emend`: the `emend` you ran is older than the server. Update it as
  [update.md](update.md) says. Check that `emend --version` prints the version you expect; an
  older install earlier on your `PATH` can hide the new one.
- On an attached machine, update the side the line names, the hub first.

`emend stop` refuses to stop the service's server and prints:

```text
emend: the emend server at <url> runs as the emend service; run emend service install to restart it, or emend service uninstall to stop it.
```

Run one of the two commands it names. The service manages that server, so it changes nothing else.

`emend stop` can also print:

```text
emend: could not check whether the emend service runs the server at <url>; nothing was changed. Run emend service status, then try again.
```

Why: emend's own service file exists, but emend could not ask `systemctl` or `launchctl` which
process the service runs: the program did not say, is missing, or sits inside the repository you
run emend in. So emend cannot tell whether the server is the service's. It stops nothing rather
than stop the service's server by mistake.

Fix: run `emend service status` and fix what it reports. If the service runs the server, use
`emend service install` or `emend service uninstall` instead of `emend stop`.

## emend refuses to run from inside a repository

`emend publish`, `wait`, `feedback`, `reply`, `mcp`, `stop`, `service` or `skills` prints one of:

```text
emend: this emend runs from inside the current repository (<path>); run emend from an install outside the repository.
emend: could not check where this emend runs; nothing was changed.
```

Any command that runs `git`, `tailscale`, `systemctl` or `launchctl` can print one of these
instead, with that program's name. Two places check quietly: `emend stop` then prints the "could
not check whether the emend service runs" line above, and `emend` prints its sign-in link instead
of opening your browser.

```text
emend: git on PATH sits inside the current repository; emend does not run it.
emend: Could not check where git on PATH runs; emend does not run it.
```

Why: these commands refuse an `emend` whose Node.js or code sits inside the repository you run
them in, and emend runs those programs only from `PATH` folders outside it. A `PATH` folder or a
program whose path passes through the repository, for example through a symlink in it, counts as
inside. emend skips a `PATH` folder written with `.` or `..`, so a program found only there is
reported as not found on `PATH`. A repository's own tool config (a `mise.toml`, or its
`node_modules/.bin` on your `PATH`) can point `emend` or `git` at code that the repository controls,
and agents run these commands with your rights. A repository whose top folder is your home folder
itself, such as a dotfiles repository, does not count, and neither does a `.git` folder without a
`HEAD`, such as the empty one some sandboxes create; git does not count it either. A line that says
emend could not check means a path it checks could not be resolved, so it refused: a `.git` in a
folder above your working folder that it cannot read, a `.git` that is a symlink, a `.git` file
that is not a single `gitdir:` line, a working folder or emend install that does not resolve, or a
home folder that exists but does not resolve (with no home folder at all, every repository
counts). emend skips a `PATH` folder, or a program in it, that it cannot check and keeps searching;
when no other folder has the program, it is reported as not found on `PATH`.

This check catches a copy inside the repository. It is not a security boundary: what keeps a
repository's code out is an emend installed outside every repository, and no repository config that
changes the `PATH` or environment emend runs with, for example by putting its own `emend`, `node`
or `git` first, or by setting `NODE_OPTIONS`. A `PATH` with version-manager shims, such as those of
mise or asdf, counts as one the repository controls: the shim sits outside the repository, but it
picks its tool from the repository's own config.

Fix: run `command -v emend` (or `command -v git`) in that repository to see which one runs. Install
emend outside any repository as [local.md](local.md) says, and remove the repository config that
puts its own program first. For a checkout of emend itself, install it with `pnpm install:local`
([development.md](development.md)).

## A server from an older emend cannot be asked to stop

`emend service install` prints:

```text
the emend server at <url> is from an older emend and cannot be asked to stop; stop it, then run emend service install again.
```

`emend stop` prints:

```text
emend: the emend server at <url> is from an older emend and cannot be asked to stop; end its process yourself: https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop
```

Why: both commands ask the running server to stop. A server from an older emend does not
understand the request.

Fix: stop that process yourself. Find it in your own terminal. On Linux:

```sh
pgrep -af '[e]mend.mjs serve'
```

On macOS:

```sh
pgrep -lf '[e]mend.mjs serve'
```

End the process it lists with `kill <pid>`. Then run `emend service install` again, or run `emend`
to start the new version.

`emend stop` can also print `did not answer; try again.`, `did not stop; try again.` or
`changed while emend asked it to stop; try again.` after `the emend server at <url>`. Run it again;
if the line comes back, use the fix above.

Related lines from `emend service install`:

- `the emend server at <url> did not answer; stop it, then run emend service install again.`
  Same fix.
- `the emend server at <url> did not stop; stop it, then run emend service install again.`
  Same fix.
- `the emend server at <url> changed while emend asked it to stop; run emend service install
  again.` Run the command again.

## Tailscale is not installed or not running

`emend serve --tailscale` and `emend service install --tailscale` print one of:

```text
tailscale is not installed or not on PATH.
Tailscale is not running or not logged in.
could not read the output of tailscale status.
tailscale did not answer within 10 seconds.
```

Why: emend finds the `tailscale` command on your `PATH`. On macOS it then tries
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`. It needs Tailscale to run and to be signed
in to your tailnet.

Fix: install Tailscale from [tailscale.com](https://tailscale.com), start it and sign in. Check
with `tailscale ip -4`. On macOS, open the Tailscale app. Then install the service again. Check
in the Tailscale admin console that MagicDNS and HTTPS certificates are on.

## Tailscale Serve is refused

`emend serve --tailscale` or the service install prints one of:

```text
Could not configure Tailscale Serve. Run `sudo tailscale serve --bg --https=443 http://127.0.0.1:3636` once as root, then try again. emend uses that route and never removes it.
Could not configure Tailscale Serve. Run `sudo tailscale set --operator=$USER` once, then try again.
port 443 of Tailscale Serve already has a setup emend did not make or cannot read; inspect it with `tailscale serve status`.
```

With `--tailscale-port <n>`, the lines name that port instead of 443.

Why: Tailscale does not let your user set up Serve, or port 443 already has a route that emend did
not make. emend never replaces a route it did not make.

Fix:

- Prefer the first line's one-time root route over the second line's
  `sudo tailscale set --operator=$USER`: the operator setting lets any process that runs as your
  user reconfigure Tailscale. See [hub-tailscale.md](hub-tailscale.md#2-install-the-service-with-tailscale)
  for what the root route risks while emend is down.
- For the first or second line, run the `sudo` command the line prints, once, then run
  `emend service install --tailscale` again. The first command creates the route as root. emend
  uses it and never removes it. Remove it with `sudo tailscale serve --https=443 off` when the
  machine stops being your hub.
- For the third line, run `tailscale serve status` and decide whether that route is yours. If you
  keep it, emend cannot serve the hub on port 443 of this machine. Choose another port with
  `--tailscale-port`: see [hub-tailscale.md](hub-tailscale.md#choose-another-port).

Three more lines come from emend itself:

- `another emend server (process <pid>) serves port 443 of Tailscale Serve; stop that server, then
  try again.` Another `emend serve --tailscale` or the service already serves the hub on this
  machine. Use that server, or stop it first: Ctrl-C in its terminal, or
  `emend service uninstall` for the service.
- `another emend is changing the Tailscale Serve route; try again.` Another emend command is
  setting up or removing the route. Wait until it finishes, then run the command again.
- `could not use the lock file <path>. If no emend server or emend stop is running, including one
  started with sudo, remove that file and try again.` emend cannot open the file it locks while it
  changes the route, often because an emend run with `sudo` created it. Check that no emend runs,
  also none started with `sudo`, then delete that file and run the command again.

One more line is a warning, not an error: `emend: warning: Tailscale Serve also serves other HTTPS
ports on <hub>.<tailnet>.ts.net; pages there receive emend's sign-in cookie.` Remove the other
HTTPS routes, or accept that pages there see the cookie. The warning covers only Tailscale Serve
HTTPS routes; any HTTPS service on the same Tailscale name receives the cookie.

An emend version older than `--tailscale-port` never removes a route on a chosen port. After you
go back to an older version, check `tailscale serve status` and remove that route yourself with
`tailscale serve --https=<n> off`.

## emend stop cannot remove a Tailscale route

When no server runs, `emend stop` removes a Tailscale Serve route that a crashed
`emend serve --tailscale` left, and prints
`emend: no emend server is running; removed the Tailscale Serve route a stopped emend server left at https://<hub>.<tailnet>.ts.net`.
If that fails, it prints:

```text
emend: no emend server is running, but removing the Tailscale Serve route it left at https://<hub>.<tailnet>.ts.net failed: <reason>
```

Why: emend remembers each route it creates, so it can remove the route after a crash. It removes
the route only when nothing answers on the route's local port any more, so no emend server still
uses it, and Serve still has exactly that route.

Fix: fix the reason the line names (see
[Tailscale is not installed or not running](#tailscale-is-not-installed-or-not-running)), then run
`emend stop` again. The next `emend serve --tailscale` also removes or reuses the route.

When `tailscale` is not on the `PATH` that `emend stop` sees, it keeps its record of the route and
prints:

```text
emend: no emend server is running; tailscale was not found on PATH, so the Tailscale Serve route at https://<hub>.<tailnet>.ts.net may still exist.
```

Run `emend stop` again in a terminal where `command -v tailscale` finds it. If you stopped using
Tailscale on this machine for good, delete the file `tailscale-serve.json` in emend's state folder
(where that folder lives: [local.md](local.md#undo), step 5).

## The hub is unreachable

A command on an attached machine prints one of:

```text
emend: cannot reach the hub at <hub address>: connection refused. Nothing was changed.
emend: cannot reach the hub at <hub address>: timed out. Nothing was changed.
emend: cannot reach the hub at <hub address>: connection failed. Nothing was changed.
emend: cannot reach the hub at <hub address>: not an emend hub. Nothing was changed.
emend: the hub at <hub address> did not answer. The request may have reached it; check before trying again.
```

Why: the hub is off, the server on it is stopped, this machine is not on the tailnet, or the
address is not an emend hub. The last line comes from a write that may have reached the hub, so
check the hub before you repeat it.

Fix:

1. On the hub, run `emend service status`. If it is not running, see
   [The service does not start](#the-service-does-not-start).
2. On this machine and on the hub, check that Tailscale runs and is signed in to the same tailnet:
   `tailscale ip -4`. Do not list the devices of your tailnet in an agent.
3. Open `https://<hub>.<tailnet>.ts.net` in a browser on this machine. You should see emend.
4. If the hub's address changed, detach and attach again ([attach.md](attach.md)).

If you see `emend: the hub at <hub address> rejected this machine's credential. Run emend detach,
then attach again. Nothing was changed.`, the hub revoked this machine. Run `emend detach`, then
attach again with a new `emend pair --machine` link.

## The pairing link is invalid

`emend attach` prints:

```text
emend: Invalid pairing link.
```

Why: the argument is not a pairing link the way `emend pair --machine` prints it:
`https://<hub>.<tailnet>.ts.net/pair#emp_...`. Typical causes: a missing or cut-off `#emp_...`
part, a line break in the paste, extra text around it, or `http://` for a hub that is not on this
machine. emend attaches only to a hub with HTTPS, except a hub on this machine itself.

Fix: run `emend pair --machine` on the hub, copy the whole link, and quote it:

```sh
emend attach '<link>'
```

`emend attach` takes exactly one argument. If the hub printed `http://`, the hub does not serve
over Tailscale HTTPS yet: finish [hub-tailscale.md](hub-tailscale.md).

Other lines from `emend attach`:

- An expired or already used pairing link does not print `Invalid pairing link.` The hub answers,
  and emend prints the hub's own message, such as `emend: The request is invalid.` or
  `emend: Authentication is required.` Run `emend pair --machine` on the hub again and use the
  new link. (The exact hub wording for an expired link was not checked against the source.)
- `emend: the server at <address> cannot accept machines.` The address is a server that is not a
  hub, or is too old. Update the hub.
- `emend: emend is attached to <hub name>. Run emend detach first.` This machine already
  attaches to a different hub.

## The pairing code expired or is locked

A pairing link, code and QR code are valid for 10 minutes and work once. emend prints
`Valid for 10 minutes, once.` next to them. On the pairing page of the web app you may see:

```text
That code did not work. Check it on the hub and try again.
Too many wrong codes. Wait 10 minutes, then try again.
```

Why: the code is wrong, expired or already used, or too many wrong codes locked entry. The server
also answers `Code entry is temporarily locked.` for a locked entry.

Fix: wait the 10 minutes after a lock. Then run `emend pair` (or `emend pair --machine`) on the
hub for a fresh link and code. On an iPhone, the home-screen app needs its own code even after
Safari paired.

## emend pair prints no code

`emend pair` prints:

```text
emend pair prints one-time codes only in a terminal.
```

Why: emend prints pairing secrets only to a terminal, which keeps them out of ordinary agent
output. That is not a security boundary: a process that can open a terminal can get them.

Fix: run `emend pair` yourself in a terminal, such as an SSH session to the hub. If it prints
`This link works only on this machine. To pair a phone, run emend serve --tailscale.`, the hub is
not serving the tailnet: see [hub-tailscale.md](hub-tailscale.md).

## This machine is already attached

`emend attach` prints:

```text
emend: This machine is already attached. Revoke it in the hub's devices, or run emend detach on it.
```

Why: the hub has this machine registered, but this machine has no usable attachment, for example
after you deleted its state folder.

Fix: open Devices on the hub, or run `emend devices` and `emend devices --revoke <id>` there, to
revoke this machine. Then run `emend pair --machine` on the hub and attach again.

## The client needs an update

`emend publish`, `wait`, `feedback` and `reply` on an attached machine print:

```text
emend: client_outdated
```

`emend attach` prints the hub's message instead:

```text
emend: The client needs an update.
```

Why: this machine's emend is older than the minimum client version that the hub accepts. The
hub is the newer side.

Fix: update this machine as [update.md](update.md) says, then repeat the command. Update the hub
first next time, then its machines.

## docRoots refusals

`emend publish` and `emend config add docRoots` print lines like these:

```text
source is outside the allowed doc roots
source is behind a symlink or non-folder
docRoots cannot be the filesystem root
docRoots cannot be the home folder or hold it
docRoots cannot hold or sit inside emend's state folder
docRoots entry <folder> <problem>; remove it with emend config remove docRoots '<folder>'
the repository at <folder> is the home folder or holds it, so emend does not publish from it
```

Why: `emend publish` reads a file only from the current git repository or a folder in `docRoots`.
It refuses your home folder, a folder that holds it, the filesystem root and emend's state folder.
It refuses a file behind a symlink. Temporary folders need permission too.

Fix:

- Move the doc into the repository, or allow its folder. You run this, not an agent:

  ```sh
  emend config add docRoots '<folder>'
  ```

  Use a subfolder of your home folder, not the home folder.
- For an entry that is now refused, run the `emend config remove docRoots ...` command in the
  line.
- Publish from a real path: a symlinked folder is refused. Use the path `pwd -P` prints.
- `emend config` lists the settings.

## The skills links are broken after an update

`emend skills install` prints:

```text
<path> exists and was not made by emend; move it away, then run emend skills install again
<folder> is not a folder emend can write to
no skills found next to this emend; run pnpm build in the checkout
```

Or an agent says a skill is missing, or `ls -l ~/.agents/skills` shows a link in red or pointing
into a folder of an older version.

Why: `emend skills install` links each skill into `~/.agents/skills`, and the links point into the
installed package. mise keeps each version in its own folder, so a link into the old version
breaks when mise removes that version. The first line means the target is a file or folder that
emend did not make.

Fix: run `emend skills install` again after every update. It moves the links to the new version.
For the first line, move the named file or folder away, then run it again. Use
`emend skills install --dry-run` to see what it would link. The third line only appears when you
run emend from a checkout without a build.

## The plugin does not update

Claude Code still shows an old version of the emend plugin, or a new skill is missing.

Why: Claude Code updates a marketplace only when you ask it to or when auto-update is on for it.
The plugin comes from the `release` branch of the emend repository.

Fix:

```sh
claude plugin marketplace update emend
claude plugin update emend@emend
```

Then restart Claude Code, or run `/reload-plugins`. If `emend` is not in `claude plugin marketplace
list`, add it again: `claude plugin marketplace add shllg/emend@release`. If you added a checkout
as the marketplace earlier, remove one of the two (`claude plugin marketplace remove emend`) and
add the one you want. For auto-update, open `/plugin`, choose Marketplaces, and turn it on.

## Run without the service

If the service does not work and you cannot fix it, run emend without it. Everything on the setup
pages works except the start at login.

- Local use: run `emend`. It starts a server in the background when none runs.
- A hub: run the server in a terminal that stays open, or in a terminal multiplexer such as
  `tmux`:

  ```sh
  emend serve --tailscale
  ```

  It prints `emend: serving https://<hub>.<tailnet>.ts.net`. Stop it with Ctrl-C. When it stops, it
  removes the Tailscale route it created. If it crashed instead, the next `emend serve --tailscale`
  or `emend stop` removes the route it left.
- Plain loopback: `emend serve` prints `emend is serving http://127.0.0.1:3636`.

A server that `emend` started keeps running after your terminal closes, and keeps the version it
started with. After an update, stop it with `emend stop`. The next `emend` starts the new version.
