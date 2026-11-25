# Troubleshooting recense setup

This page lists the errors you meet while you set up or update recense, with the line recense prints,
why it happens, and the fix. Find your line in the headings below. The setup pages link here:
[local.md](local.md), [hub-tailscale.md](hub-tailscale.md), [attach.md](attach.md),
[agents.md](agents.md) and [update.md](update.md). recense starts most error lines with `recense: `;
the lines below show it only where the exact text matters.

## An agent's sandbox blocks recense

recense prints:

```text
recense cannot write its state folder <folder>. If an agent sandbox runs recense, let recense run outside it: https://github.com/shllg/recense/blob/release/docs/setup/troubleshooting.md#an-agents-sandbox-blocks-recense
```

Why: some agents run commands in a sandbox that keeps them from recense's state folder or from
the server on `127.0.0.1`.

Fix: run the command in your own terminal, or allow recense in your agent's own settings.
How depends on your agent, so see its documentation. Before you allow it, read
[What an agent can do with recense](agents.md#what-an-agent-can-do-with-recense).

Related lines:

- `recense: Could not contact the recense server.` The command reached no server. Inside a sandbox, this is
  the same cause. Outside one, see [recense is not running](#recense-is-not-running).
- `State directory <folder> has group or other permissions; fix it with chmod 700 '<folder>'`
  Run the `chmod` it prints. The state folder must be private to you.
- `Token file <path> has group or other permissions; fix it with chmod 600 '<path>'` Run the
  `chmod` it prints. recense reads no token that other users could read, and changes nothing until
  you fix it.

## recense is not running

recense prints:

```text
recense: recense is not running. Start it with `recense` or `recense serve --tailscale`.
```

`recense pair` and `recense devices` print this when no server answers. They never start one. Bare
`recense` starts a server instead. If that fails, it prints:

```text
recense: Could not start the recense server.
```

Why: no server runs, or the one that runs does not answer. Agent commands (`publish`, `wait`,
`feedback`, `reply`) do not need one: they work on the state folder directly.

Fix:

1. Run `recense` in a terminal. It starts a server if none runs.
2. If you use the service, run `recense service status`. If it says `installed but not running`,
   read [The service does not start](#the-service-does-not-start).
3. On a hub, `recense serve --tailscale` is what the service runs. Without the service, run
   `recense serve --tailscale` in a terminal that stays open, or install the service.
4. If another program holds the port, see [Port 3636 is in use](#port-3636-is-in-use).

Outside a terminal, `recense` prints `recense is running at <url>. Run recense in a terminal to get a
sign-in link.` That line is not an error: open a terminal and run `recense`. recense prints sign-in
links and pairing codes only to a terminal, which keeps them out of ordinary agent output. That is
not a security boundary: a process that can open a terminal can read them.

## Port 3636 is in use

recense prints:

```text
recense: Could not start the recense server.
```

Why: the server binds `127.0.0.1:3636`. Another program, or a `recense serve` you started earlier,
holds the port, so the new server cannot listen. recense prints the same line for other start
failures. The port is the first thing to check.

Fix: in your own terminal, find the program on the port. On Linux:

```sh
ss -ltnp 'sport = :3636'
```

On macOS:

```sh
lsof -nP -iTCP:3636 -sTCP:LISTEN
```

If it is a recense server that `recense` started, stop it with `recense stop`. If that says the server
is from an older recense, end it as
[A server from an older recense cannot be asked to stop](#a-server-from-an-older-recense-cannot-be-asked-to-stop)
says. If it is another program, move recense to another port:

```sh
recense serve --port 3700
```

Or, with the service:

```sh
recense service install --port 3700
```

`recense` finds the server through its state folder, so the port change needs nothing else. With
`--tailscale`, recense points Tailscale Serve at the port you chose. A route you made by hand with
`sudo` must name that same port.

## The service does not start

`recense service install` prints one of:

```text
the recense service did not start a server; run journalctl --user -u recense to see why.
the recense service did not start a server; see ~/Library/Logs/recense.log.
```

The first line is Linux, the second macOS. The path is printed in full. A second form says the
service runs but the command could not confirm its server: `the recense service runs, but this
command could not confirm its server; ...`. Its end adds that you should run
`recense service install` again in your own terminal if an agent sandbox runs the command.

Why: the unit or agent started but its server did not answer. Common causes: port 3636 is in use,
Tailscale is not running (with `--tailscale`), the Node.js the service was installed with is gone
after an upgrade (`brew upgrade node` or `mise upgrade node`), mise removed the recense version
the service was installed with ([update.md](update.md#2-update-the-package)), or the command ran
in an agent's sandbox, which cannot reach the service manager or `127.0.0.1`.

Fix:

- Linux: `journalctl --user -u recense`. The unit is `~/.config/systemd/user/recense.service`.
- macOS: `~/Library/Logs/recense.log`. The agent is
  `~/Library/LaunchAgents/dev.recense.server.plist`. Inspect it with
  `launchctl print gui/$(id -u)/dev.recense.server`.
- Run `recense service install` again after fixing the cause. After a Node.js upgrade it must run
  again.
- On Linux, a service that stops at logout needs linger. The install prints
  `To keep recense running after you log out, run sudo loginctl enable-linger $USER.`

If the problem stays, [Run without the service](#run-without-the-service).

## recense service refuses to run

`recense service` prints one of these lines, each with its own cause:

- `run recense service as the user who runs recense, not as root.` Run it as your own user, without
  `sudo`.
- `recense service supports systemd on Linux and launchd on macOS; run recense serve yourself.`
  Your machine has neither `systemctl` nor `launchctl` on its `PATH`. See
  [Run without the service](#run-without-the-service).
- `recense: this recense runs from inside the current repository (<path>); run recense from an install
  outside the repository.` The service must not run code that a repository can change. See
  [recense refuses to run from inside a repository](#recense-refuses-to-run-from-inside-a-repository).
- `<path> was not written by recense; move it away, then try again.` The unit or plist file at
  that path exists and recense did not make it. Move it away, then run the command again.
- `the node path contains $, quotes or a backslash, which a systemd unit cannot run; use a node
  installed at a plain path.` (Linux) Install Node.js at a path without those characters.
- `invalid saved service options; run recense service install with your options` The saved options
  are damaged. Run `recense service install` again with the options you want, for example
  `recense service install --tailscale`.
- `no saved service options; the service now uses the defaults` is not an error. It tells you
  that an installed service had no saved options, so it now uses `127.0.0.1:3636`.

## recense says the server runs another version

`recense` or `recense service status` prints one of:

```text
recense: the recense server at <url> runs recense <old>; this is recense <new>. Run recense stop, then recense, to start recense <new>.
recense: the recense server at <url> runs recense <old>; this is recense <new>. Run recense service install to restart it on recense <new>.
recense: the recense server at <url> runs recense <newer>, newer than this recense <version>; update recense: https://github.com/shllg/recense/blob/release/docs/setup/update.md
```

On an attached machine, `recense` prints this instead, ending in `Update the hub`,
`Update this machine` or `Update both to the same version`, and a link to update.md:

```text
recense: the hub at <url> runs recense <hub version>; this machine runs recense <version>. Update the hub: <link>
```

Why: a server keeps the version it started with. After an update, the server that `recense` or the
service started still runs the old version until it restarts. Agent commands never print this line.

Fix: run the command the line names.

- `Run recense stop, then recense`: the server is one that bare `recense` started. `recense stop` stops it,
  and the next `recense` starts the new version.
- `Run recense service install`: the service runs the server. The install keeps its options and
  restarts it.
- `newer than this recense`: the `recense` you ran is older than the server. Update it as
  [update.md](update.md) says. Check that `recense --version` prints the version you expect; an
  older install earlier on your `PATH` can hide the new one.
- On an attached machine, update the side the line names, the hub first.

`recense stop` refuses to stop the service's server and prints:

```text
recense: the recense server at <url> runs as the recense service; run recense service install to restart it, or recense service uninstall to stop it.
```

Run one of the two commands it names. The service manages that server, so it changes nothing else.

`recense stop` can also print:

```text
recense: could not check whether the recense service runs the server at <url>; nothing was changed. Run recense service status, then try again.
```

Why: recense's own service file exists, but recense could not ask `systemctl` or `launchctl` which
process the service runs: the program did not say, is missing, or sits inside the repository you
run recense in. So recense cannot tell whether the server is the service's. It stops nothing rather
than stop the service's server by mistake.

Fix: run `recense service status` and fix what it reports. If the service runs the server, use
`recense service install` or `recense service uninstall` instead of `recense stop`.

## recense refuses to run from inside a repository

`recense publish`, `wait`, `feedback`, `reply`, `mcp`, `stop`, `service` or `skills` prints one of:

```text
recense: this recense runs from inside the current repository (<path>); run recense from an install outside the repository.
recense: could not check where this recense runs; nothing was changed.
```

Any command that runs `git`, `tailscale`, `systemctl` or `launchctl` can print one of these
instead, with that program's name. Two places check quietly: `recense stop` then prints the "could
not check whether the recense service runs" line above, and `recense` prints its sign-in link instead
of opening your browser.

```text
recense: git on PATH sits inside the current repository; recense does not run it.
recense: Could not check where git on PATH runs; recense does not run it.
```

Why: these commands refuse a `recense` whose Node.js or code sits inside the repository you run
them in, and recense runs those programs only from `PATH` folders outside it. A `PATH` folder or a
program whose path passes through the repository, for example through a symlink in it, counts as
inside. recense skips a `PATH` folder written with `.` or `..`, so a program found only there is
reported as not found on `PATH`. A repository's own tool config (a `mise.toml`, or its
`node_modules/.bin` on your `PATH`) can point `recense` or `git` at code that the repository controls,
and agents run these commands with your rights. A repository whose top folder is your home folder
itself, such as a dotfiles repository, does not count, and neither does a `.git` folder without a
`HEAD`, such as the empty one some sandboxes create; git does not count it either. A line that says
recense could not check means a path it checks could not be resolved, so it refused: a `.git` in a
folder above your working folder that it cannot read, a `.git` that is a symlink, a `.git` file
that is not a single `gitdir:` line, a working folder or recense install that does not resolve, or a
home folder that exists but does not resolve (with no home folder at all, every repository
counts). recense skips a `PATH` folder, or a program in it, that it cannot check and keeps searching;
when no other folder has the program, it is reported as not found on `PATH`.

This check catches a copy inside the repository. It is not a security boundary: what keeps a
repository's code out is a recense installed outside every repository, and no repository config that
changes the `PATH` or environment recense runs with, for example by putting its own `recense`, `node`
or `git` first, or by setting `NODE_OPTIONS`. A `PATH` with version-manager shims, such as those of
mise or asdf, counts as one the repository controls: the shim sits outside the repository, but it
picks its tool from the repository's own config.

Fix: run `command -v recense` (or `command -v git`) in that repository to see which one runs. Install
recense outside any repository as [local.md](local.md) says, and remove the repository config that
puts its own program first. For a checkout of recense itself, install it with `pnpm install:local`
([development.md](development.md)).

## A server from an older recense cannot be asked to stop

`recense service install` prints:

```text
the recense server at <url> is from an older recense and cannot be asked to stop; stop it, then run recense service install again.
```

`recense stop` prints:

```text
recense: the recense server at <url> is from an older recense and cannot be asked to stop; end its process yourself: https://github.com/shllg/recense/blob/release/docs/setup/troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop
```

Why: both commands ask the running server to stop. A server from an older recense does not
understand the request.

Fix: stop that process yourself. Find it in your own terminal. On Linux:

```sh
pgrep -af '[r]ecense.mjs serve'
```

On macOS:

```sh
pgrep -lf '[r]ecense.mjs serve'
```

End the process it lists with `kill <pid>`. Then run `recense service install` again, or run `recense`
to start the new version.

`recense stop` can also print `did not answer; try again.`, `did not stop; try again.` or
`changed while recense asked it to stop; try again.` after `the recense server at <url>`. Run it again;
if the line comes back, use the fix above.

Related lines from `recense service install`:

- `the recense server at <url> did not answer; stop it, then run recense service install again.`
  Same fix.
- `the recense server at <url> did not stop; stop it, then run recense service install again.`
  Same fix.
- `the recense server at <url> changed while recense asked it to stop; run recense service install
  again.` Run the command again.

## Tailscale is not installed or not running

`recense serve --tailscale` and `recense service install --tailscale` print one of:

```text
tailscale is not installed or not on PATH.
Tailscale is not running or not logged in.
could not read the output of tailscale status.
tailscale did not answer within 10 seconds.
```

Why: recense finds the `tailscale` command on your `PATH`. On macOS it then tries
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`. It needs Tailscale to run and to be signed
in to your tailnet.

Fix: install Tailscale from [tailscale.com](https://tailscale.com), start it and sign in. Check
with `tailscale ip -4`. On macOS, open the Tailscale app. Then install the service again. Check
in the Tailscale admin console that MagicDNS and HTTPS certificates are on.

## Tailscale Serve is refused

`recense serve --tailscale` or the service install prints one of:

```text
Could not configure Tailscale Serve. Run `sudo tailscale serve --bg --https=443 http://127.0.0.1:3636` once as root, then try again. recense uses that route and never removes it.
Could not configure Tailscale Serve. Run `sudo tailscale set --operator=$USER` once, then try again.
port 443 of Tailscale Serve already has a setup recense did not make or cannot read; inspect it with `tailscale serve status`.
```

With `--tailscale-port <n>`, the lines name that port instead of 443.

Why: Tailscale does not let your user set up Serve, or port 443 already has a route that recense did
not make. recense never replaces a route it did not make.

Fix:

- Prefer the first line's one-time root route over the second line's
  `sudo tailscale set --operator=$USER`: the operator setting lets any process that runs as your
  user reconfigure Tailscale. See [hub-tailscale.md](hub-tailscale.md#2-install-the-service-with-tailscale)
  for what the root route risks while recense is down.
- For the first or second line, run the `sudo` command the line prints, once, then run
  `recense service install --tailscale` again. The first command creates the route as root. recense
  uses it and never removes it. Remove it with `sudo tailscale serve --https=443 off` when the
  machine stops being your hub.
- For the third line, run `tailscale serve status` and decide whether that route is yours. If you
  keep it, recense cannot serve the hub on port 443 of this machine. Choose another port with
  `--tailscale-port`: see [hub-tailscale.md](hub-tailscale.md#choose-another-port).

Three more lines come from recense itself:

- `another recense server (process <pid>) serves port 443 of Tailscale Serve; stop that server, then
  try again.` Another `recense serve --tailscale` or the service already serves the hub on this
  machine. Use that server, or stop it first: Ctrl-C in its terminal, or
  `recense service uninstall` for the service.
- `another recense is changing the Tailscale Serve route; try again.` Another recense command is
  setting up or removing the route. Wait until it finishes, then run the command again.
- `could not use the lock file <path>. If no recense server or recense stop is running, including one
  started with sudo, remove that file and try again.` recense cannot open the file it locks while it
  changes the route, often because a recense run with `sudo` created it. Check that no recense runs,
  also none started with `sudo`, then delete that file and run the command again.

One more line is a warning, not an error: `recense: warning: Tailscale Serve also serves other HTTPS
ports on <hub>.<tailnet>.ts.net; pages there receive recense's sign-in cookie.` Remove the other
HTTPS routes, or accept that pages there see the cookie. The warning covers only Tailscale Serve
HTTPS routes; any HTTPS service on the same Tailscale name receives the cookie.

A recense version older than `--tailscale-port` never removes a route on a chosen port. After you
go back to an older version, check `tailscale serve status` and remove that route yourself with
`tailscale serve --https=<n> off`.

## recense stop cannot remove a Tailscale route

When no server runs, `recense stop` removes a Tailscale Serve route that a crashed
`recense serve --tailscale` left, and prints
`recense: no recense server is running; removed the Tailscale Serve route a stopped recense server left at https://<hub>.<tailnet>.ts.net`.
If that fails, it prints:

```text
recense: no recense server is running, but removing the Tailscale Serve route it left at https://<hub>.<tailnet>.ts.net failed: <reason>
```

Why: recense remembers each route it creates, so it can remove the route after a crash. It removes
the route only when nothing answers on the route's local port any more, so no recense server still
uses it, and Serve still has exactly that route.

Fix: fix the reason the line names (see
[Tailscale is not installed or not running](#tailscale-is-not-installed-or-not-running)), then run
`recense stop` again. The next `recense serve --tailscale` also removes or reuses the route.

When `tailscale` is not on the `PATH` that `recense stop` sees, it keeps its record of the route and
prints:

```text
recense: no recense server is running; tailscale was not found on PATH, so the Tailscale Serve route at https://<hub>.<tailnet>.ts.net may still exist.
```

Run `recense stop` again in a terminal where `command -v tailscale` finds it. If you stopped using
Tailscale on this machine for good, delete the file `tailscale-serve.json` in recense's state folder
(where that folder lives: [local.md](local.md#undo), step 5).

## The hub behind your proxy answers bad_host or bad_origin

The proxy may rewrite the `Host` header or drop its port. A host recense does not know gets
`403 bad_host`. A host recense allows, such as `127.0.0.1:3636`, still differs from the browser's
public Origin. That makes pairing and every browser change fail with `403 bad_origin`.

For that pairing failure, the page says: "Could not pair. Check your connection and try again."
This is the page's fixed message for a 403 response; it does not show `bad_origin` itself.

Fix `bad_origin` by passing `Host` through unchanged, including its port, never by changing Origin.
Never set, strip or rewrite `Origin` in the proxy. recense's Origin check is its only defence against
requests from sibling names under the same domain. A fixed Origin turns that check off.

In nginx, use
`proxy_set_header Host $http_host;`, not `$host`, which drops the port. The default `$proxy_host`
sends the upstream host instead. With Apache, use `ProxyPreserveHost On` for the recense site.

Check that the address given to `--public-url` is the one the phone opens, including its port
when not 443. Then reload the proxy after fixing its configuration. If the address was wrong,
run `recense service install --public-url https://recense.example.com` with the right address.
See [hub-network.md](hub-network.md#1-point-your-proxy-at-recense).

## The hub is unreachable

A command on an attached machine prints one of:

```text
recense: cannot reach the hub at <hub address>: connection refused. Nothing was changed.
recense: cannot reach the hub at <hub address>: timed out. Nothing was changed.
recense: cannot reach the hub at <hub address>: connection failed. Nothing was changed.
recense: cannot reach the hub at <hub address>: not a recense hub. Nothing was changed.
recense: the hub at <hub address> did not answer. The request may have reached it; check before trying again.
```

Why: the hub is off, the server on it is stopped, this machine is not on the tailnet, or the
address is not a recense hub. The last line comes from a write that may have reached the hub, so
check the hub before you repeat it.

Fix:

1. On the hub, run `recense service status`. If it is not running, see
   [The service does not start](#the-service-does-not-start).
2. On this machine and on the hub, check that Tailscale runs and is signed in to the same tailnet:
   `tailscale ip -4`. Do not list the devices of your tailnet in an agent.
3. Open `https://<hub>.<tailnet>.ts.net` in a browser on this machine. You should see recense.
4. If the hub's address changed, detach and attach again ([attach.md](attach.md)).

If you see `recense: the hub at <hub address> rejected this machine's credential. Run recense detach,
then attach again. Nothing was changed.`, the hub revoked this machine. Run `recense detach`, then
attach again with a new `recense pair --machine` link.

## The pairing link is invalid

`recense attach` prints:

```text
recense: Invalid pairing link.
```

Why: the argument is not a pairing link the way `recense pair --machine` prints it:
`https://<hub>.<tailnet>.ts.net/pair#emp_...`. Typical causes: a missing or cut-off `#emp_...`
part, a line break in the paste, extra text around it, or `http://` for a hub that is not on this
machine. recense attaches only to a hub with HTTPS, except a hub on this machine itself.

Fix: run `recense pair --machine` on the hub, copy the whole link, and quote it:

```sh
recense attach '<link>'
```

`recense attach` takes exactly one argument. If the hub printed `http://`, the hub does not serve
over Tailscale HTTPS yet: finish [hub-tailscale.md](hub-tailscale.md).

Other lines from `recense attach`:

- An expired or already used pairing link does not print `Invalid pairing link.` The hub answers,
  and recense prints the hub's own message, such as `recense: The request is invalid.` or
  `recense: Authentication is required.` Run `recense pair --machine` on the hub again and use the
  new link. (The exact hub wording for an expired link was not checked against the source.)
- `recense: the server at <address> cannot accept machines.` The address is a server that is not a
  hub, or is too old. Update the hub.
- `recense: recense is attached to <hub name>. Run recense detach first.` This machine already
  attaches to a different hub.

## The pairing code expired or is locked

A pairing link, code and QR code are valid for 10 minutes and work once. recense prints
`Valid for 10 minutes, once.` next to them. On the pairing page of the web app you may see:

```text
That code did not work. Check it on the hub and try again.
Too many wrong codes. Wait 10 minutes, then try again.
```

Why: the code is wrong, expired or already used, or too many wrong codes locked entry. The server
also answers `Code entry is temporarily locked.` for a locked entry.

Fix: wait the 10 minutes after a lock. Then run `recense pair` (or `recense pair --machine`) on the
hub for a fresh link and code. On an iPhone, the home-screen app needs its own code even after
Safari paired.

## recense pair prints no code

`recense pair` prints:

```text
recense pair prints one-time codes only in a terminal.
```

Why: recense prints pairing secrets only to a terminal, which keeps them out of ordinary agent
output. That is not a security boundary: a process that can open a terminal can get them.

Fix: run `recense pair` yourself in a terminal, such as an SSH session to the hub. If it prints
`This link works only on this machine. To pair a phone, run recense serve --tailscale.`, the hub is
not serving the tailnet: see [hub-tailscale.md](hub-tailscale.md).

## This machine is already attached

`recense attach` prints:

```text
recense: This machine is already attached. Revoke it in the hub's devices, or run recense detach on it.
```

Why: the hub has this machine registered, but this machine has no usable attachment, for example
after you deleted its state folder.

Fix: open Devices on the hub, or run `recense devices` and `recense devices --revoke <id>` there, to
revoke this machine. Then run `recense pair --machine` on the hub and attach again.

## The client needs an update

`recense publish`, `wait`, `feedback` and `reply` on an attached machine print:

```text
recense: client_outdated
```

`recense attach` prints the hub's message instead:

```text
recense: The client needs an update.
```

Why: this machine's recense is older than the minimum client version that the hub accepts. The
hub is the newer side.

Fix: update this machine as [update.md](update.md) says, then repeat the command. Update the hub
first next time, then its machines.

## docRoots refusals

`recense publish` and `recense config add docRoots` print lines like these:

```text
source is outside the allowed doc roots
source is behind a symlink or non-folder
docRoots cannot be the filesystem root
docRoots cannot be the home folder or hold it
docRoots cannot hold or sit inside recense's state folder
docRoots entry <folder> <problem>; remove it with recense config remove docRoots '<folder>'
the repository at <folder> is the home folder or holds it, so recense does not publish from it
```

Why: `recense publish` reads a file only from the current git repository or a folder in `docRoots`.
It refuses your home folder, a folder that holds it, the filesystem root and recense's state folder.
It refuses a file behind a symlink. Temporary folders need permission too.

Fix:

- Move the doc into the repository, or allow its folder. You run this, not an agent:

  ```sh
  recense config add docRoots '<folder>'
  ```

  Use a subfolder of your home folder, not the home folder.
- For an entry that is now refused, run the `recense config remove docRoots ...` command in the
  line.
- Publish from a real path: a symlinked folder is refused. Use the path `pwd -P` prints.
- `recense config` lists the settings.

## mise refuses to install recense

`mise use -g npm:@shllg/recense`, `mise install` or `mise upgrade` stops with:

```text
refusing to add @shllg/recense: the package name was first published at <date>, within the configured `minimumPackageAge` of 43200 minutes
help: after verifying the package, set `allow_low_downloads = true` on `npm:@shllg/recense` to approve it
```

Or `mise upgrade` installs nothing and prints:

```text
newer npm:@shllg/recense release <version> (released <date>, eligible <date>) ignored by minimum_release_age (24h)
```

Why: the package manager built into mise refuses an npm package that is new or seldom
downloaded until you approve it. Separately, mise holds back every release for its first 24
hours.

Fix:

- Install with `mise use -g 'npm:@shllg/recense[allow_low_downloads=true]'`, as
  [local.md](local.md#2-install-recense) says, or add `allow_low_downloads = true` to the
  recense entry under `[tools]` in `~/.config/mise/config.toml`.
- For the 24-hour hold, add `"npm:@shllg/recense"` to `minimum_release_age_excludes` under
  `[settings]` in the same file. The release also arrives by itself after 24 hours.

## The skills links are broken after an update

`recense skills install` prints:

```text
<path> exists and was not made by recense; move it away, then run recense skills install again
<folder> is not a folder recense can write to
no skills found next to this recense; run pnpm build in the checkout
```

Or an agent says a skill is missing, or `ls -l ~/.agents/skills` shows a link in red or pointing
into a folder of an older version.

Why: `recense skills install` links each skill into `~/.agents/skills`, and the links point into the
installed package. mise keeps each version in its own folder, so a link into the old version
breaks when mise removes that version. The first line means the target is a file or folder that
recense did not make.

Fix: run `recense skills install` again after every update. It moves the links to the new version.
For the first line, move the named file or folder away, then run it again. Use
`recense skills install --dry-run` to see what it would link. The third line only appears when you
run recense from a checkout without a build.

## The plugin does not update

Claude Code still shows an old version of the recense plugin, or a new skill is missing.

Why: Claude Code updates a marketplace only when you ask it to or when auto-update is on for it.
The plugin comes from the `release` branch of the recense repository.

Fix:

```sh
claude plugin marketplace update recense
claude plugin update recense@recense
```

Then restart Claude Code, or run `/reload-plugins`. If `recense` is not in `claude plugin marketplace
list`, add it again: `claude plugin marketplace add shllg/recense@release`. If you added a checkout
as the marketplace earlier, remove one of the two (`claude plugin marketplace remove recense`) and
add the one you want. For auto-update, open `/plugin`, choose Marketplaces, and turn it on.

## Run without the service

If the service does not work and you cannot fix it, run recense without it. Everything on the setup
pages works except the start at login.

- Local use: run `recense`. It starts a server in the background when none runs.
- A hub: run the server in a terminal that stays open, or in a terminal multiplexer such as
  `tmux`:

  ```sh
  recense serve --tailscale
  ```

  It prints `recense: serving https://<hub>.<tailnet>.ts.net`. Stop it with Ctrl-C. When it stops, it
  removes the Tailscale route it created. If it crashed instead, the next `recense serve --tailscale`
  or `recense stop` removes the route it left.
- Plain loopback: `recense serve` prints `recense is serving http://127.0.0.1:3636`.

A server that `recense` started keeps running after your terminal closes, and keeps the version it
started with. After an update, stop it with `recense stop`. The next `recense` starts the new version.
