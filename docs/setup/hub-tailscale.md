# Set up your own recense hub on Tailscale

This setup suits you if you own an always-on machine, such as a home server, a desktop or a
cloud VM, and want to review agent work from your phone or from other machines. You get a hub that
answers on `https://<hub>.<tailnet>.ts.net` for you and your devices only, and your phone paired
to it. You run the hub on your own tailnet; nobody else operates it.

A hub has one owner. Every device you pair sees every review on it, and your machines attach to
it ([attach.md](attach.md)) so their agents publish there.

## Set it up with an agent

```text prompt
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me the
change and wait for my yes; never read secrets (tokens, .env files, credential stores) or recense's
state folder; never open ~/.claude/settings.json whole; if a dotfiles tool manages a file or link
you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or similar),
change its source and tell me how to apply it; never run recense pair, attach, detach, config or
devices yourself, give me the command instead; never pass --host or any flag this page does not
name; never retry a command through another program (for example script) to get a terminal; never
list the devices on my tailnet; outside your sandbox run only recense service install --tailscale,
recense service status and recense service uninstall, and no other command; run no process listing
yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af '[r]ecense.mjs serve'; macOS: pgrep
-lf '[r]ecense.mjs serve').
Make this machine my recense hub on my own tailnet (https://github.com/shllg/recense). Follow
https://github.com/shllg/recense/blob/release/docs/setup/hub-tailscale.md step by step. recense must
already be installed here (https://github.com/shllg/recense/blob/release/docs/setup/local.md). Ask me
before each step, and tell me when I must act on my phone or in the Tailscale admin console. For the final check, give me the recense publish command to run in my own
terminal; run it yourself only if the command works inside your sandbox.
```

## What you need

- An always-on machine on Linux or macOS with recense installed. See [local.md](local.md).
- [Tailscale](https://tailscale.com) on that machine and on every device that will review: your
  phone and each machine you attach. All of them sign in to the same tailnet.
- MagicDNS and HTTPS certificates switched on for the tailnet, in the Tailscale admin console
  (the DNS page). Tailscale Serve needs them to answer on an `https://` name.
- On macOS, the Tailscale app is enough. recense looks for a `tailscale` command on your `PATH`
  first and then for the app's own command at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
  On first run, macOS may ask you to approve the Tailscale system extension or login item in
  System Settings. Approve it, or Tailscale does not start.
- A tailnet that only you sign in to, or an access rule (ACL) that limits the hub to your own
  devices. On a shared tailnet, other members can reach the hub's `/pair` page and lock code
  entry for ten minutes by guessing wrong codes.
- A phone with a browser. On an iPhone, use Safari.

This page writes the hub's address as `<hub>.<tailnet>.ts.net`. Tailscale shows you the real one.
`recense serve` prints it as `recense: serving https://<hub>.<tailnet>.ts.net`.

## 1. Check that Tailscale runs on the hub

```sh
tailscale ip -4
```

You should see one Tailscale address. If the command is not found on macOS, use the app's own
command instead: `/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`. Also check in the
Tailscale app that it is signed in. If it prints an error, sign in to Tailscale first.

```text prompt
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never
list the devices on my tailnet.
Check that Tailscale runs on this machine: run tailscale ip -4 and show me the output. On macOS, if
tailscale is not on PATH, use /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4. Remind me
to check in the Tailscale admin console that MagicDNS and HTTPS certificates are on; I do that
myself.
```

## 2. Install the service with Tailscale

```sh
recense service install --tailscale
recense service status
```

With `--tailscale`, recense serves the hub on your tailnet through Tailscale Serve on HTTPS port 443, or on the port you choose (below). The
server itself keeps listening on `127.0.0.1:3636`; Tailscale Serve forwards the HTTPS requests to
it. Only devices on your tailnet reach the address. You should see `recense: service installed`,
then `recense: service running (<path>)`. The service log then holds
`recense: serving https://<hub>.<tailnet>.ts.net`.

If a server already runs, the command asks it to stop first. See
[troubleshooting.md](troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop) if
the server is too old to be asked.

The service remembers `--tailscale`. `recense service install` without options keeps it.

### Choose another port

Port 443 of your Tailscale name may already serve something else. Then pick another HTTPS port
for recense:

```sh
recense service install --tailscale --tailscale-port 13636
```

`recense serve --tailscale --tailscale-port <n>` takes the same option. The port is a number from 1
to 65535 and needs `--tailscale`. The hub then
answers at `https://<hub>.<tailnet>.ts.net:13636`. Pairing links, the QR code and the service log
use that address. A phone must open it with the port.

The server still listens only on `127.0.0.1:3636`; the port only picks where Tailscale Serve
listens. Whatever is on port 443, or on other ports, stays untouched. A route on the chosen port
that recense did not make blocks the setup, as on 443: recense reports it and leaves it alone.

The service remembers the port like `--tailscale`, and `recense service install` without options
keeps it. To move back to 443, run `recense service install --tailscale`. When you change the port,
recense removes the route it made on the old port before it sets up the new one. A route you made
with `sudo` is never removed.

The sign-in cookie does not depend on the port: every page on the same Tailscale name, on any
HTTPS port, receives it. recense warns when Serve also serves other HTTPS ports on that name. That
warning covers only Tailscale Serve HTTPS routes. It does not see a Serve TCP passthrough to a
local TLS server, or a process bound directly to the Tailscale address. Any HTTPS service on the
same Tailscale name, on any port, receives recense's sign-in cookie. When port 443 of the name
belongs to something you do not fully trust, put recense on a separate Tailscale name.

A recense version older than this option does not recognise the route record of a chosen port, so
it never removes that route. After you go back to an older version, check `tailscale serve status`
and remove the route on the chosen port yourself with `tailscale serve --https=<n> off`.

If Tailscale refuses to let your user set up Serve, run this once as root, then install again:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3636
```

With a chosen port, use that port in place of 443 here and in the commands below.

recense uses that route and never removes a route it did not create. The route stays until you run
`sudo tailscale serve --https=443 off`. Remove it when the machine stops being your hub.

**Why this matters.** While recense is down, whatever listens on `127.0.0.1:3636` receives your
phone's requests. That includes the reviewer cookie, which lasts 30 days and can create comments,
Sends and approvals. On a shared machine, any local user could bind that port. Keep the root
route only on a machine you alone use.

When Tailscale refuses, recense prints one of two hints: this root route, or
`sudo tailscale set --operator=$USER`. Prefer the one-time root route. The operator setting lets
any process that runs as your user reconfigure Tailscale.

On a headless Linux machine, a user service stops when you log out. The install command then
prints `To keep recense running after you log out, run sudo loginctl enable-linger $USER.` Run that
command yourself, once.

On Linux, the unit is `~/.config/systemd/user/recense.service` and the log is
`journalctl --user -u recense`. On macOS, the agent is
`~/Library/LaunchAgents/dev.recense.server.plist` and the log is `~/Library/Logs/recense.log`.

```text prompt
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; never list the devices on my tailnet; outside your sandbox run only
recense service install --tailscale, recense service status and recense service uninstall, and no other
command; never pass --host or any flag this page does not name; never retry a command through
another program (for example script) to get a terminal; run no process listing yourself, ask me to
run pgrep in my own terminal (Linux: pgrep -af '[r]ecense.mjs serve'; macOS: pgrep -lf '[r]ecense.mjs
serve').
Run recense service install --tailscale and recense service status and show me the output of both. If
Tailscale refuses to set up Serve, give me the sudo tailscale serve command recense prints, to run
once as root (prefer it over sudo tailscale set --operator), then run install again. If the output
says to enable linger, give me that sudo command. If a server cannot be asked to stop, ask me to run
the pgrep command for my system and end that server, then install again. On a failure, diagnose it
with https://github.com/shllg/recense/blob/release/docs/setup/troubleshooting.md.
```

## 3. Pair your phone

On the hub, in a terminal, run:

```sh
recense pair
```

`recense pair` prints a one-time link, an 8-character code and a QR code. All three are valid for
10 minutes and work once. It prints them only in a terminal. If it says
`This link works only on this machine. To pair a phone, run recense serve --tailscale.`, the server
is not serving the tailnet: check step 2.

On your phone:

1. Scan the QR code, or open the link, in the phone's browser. The browser pairs and shows the
   inbox. If it asks for a code instead, type the 8-character code.
2. iPhone: use Safari. Tap Share, then Add to Home Screen. Open recense from the home screen and
   enter the code. The home-screen app keeps its own storage, so it needs its own pairing even
   after Safari paired. Run `recense pair` again for a fresh code.
3. Other phones: install recense from the browser's menu (Install app or Add to Home Screen), open
   it, and pair it the same way.

Pair another browser or phone at any time with `recense pair` again. You can also open Devices in a
browser that is already signed in and choose Pair a device.

List and revoke paired devices from the hub:

```sh
recense devices
recense devices --revoke <id>
```

`recense devices` prints one line per device: its name, kind, creation date, last-seen date and id,
separated by tabs. `--revoke <id>` prints `Revoked <name>.` and signs that device out.

You run `recense pair` and `recense devices` yourself: they print one-time secrets and manage who
may review.

```text prompt
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never run
recense pair, attach, detach, config or devices yourself, give me the command instead.
Walk me through pairing my phone. Tell me to run recense pair myself in a terminal on this machine,
then explain: scan the QR code or open the link on the phone and type the code if asked; on an
iPhone use Safari, choose Add to Home Screen, open the home-screen app, and enter a code there too,
because it has its own storage; on another phone install the app from the browser menu.
```

## 4. Attach your machines and set up their agents (optional)

To make the agents on your other machines publish to the hub, follow [attach.md](attach.md). The
agent side of each machine is on [agents.md](agents.md).

```text prompt
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never run
recense pair, attach, detach, config or devices yourself, give me the command instead.
Help me attach another machine to this hub: follow
https://github.com/shllg/recense/blob/release/docs/setup/attach.md. Tell me to run recense pair
--machine on the hub myself, and the recense attach command it prints on the other machine myself.
```

## Check that it works

1. On the hub: `recense service status` prints `recense: service running (<path>)`.
2. On your phone, with Tailscale connected, open `https://<hub>.<tailnet>.ts.net`. You should see
   the inbox, not the pairing page.
3. On the hub, publish a small doc as [local.md](local.md#check-that-it-works) shows. Reload the
   phone: the review appears.
4. `recense devices` lists your phone.

## Update

Update the hub first, then its machines. See [update.md](update.md).

## Undo

1. Stop the hub: `recense service uninstall`. This stops the server. A Serve route that recense
   created is removed when the server stops cleanly. If the server crashed, the route can survive.
2. Check for a leftover route: `tailscale serve status`. Remove a route you made with `sudo`, or
   one that survived a crash: `sudo tailscale serve --https=443 off`. Until you do, a program on
   port 3636 receives requests meant for recense.
3. To run a loopback-only server again, run `recense service install` with no options after the
   uninstall. The uninstall deletes the saved service options, so the new service uses the
   defaults: `127.0.0.1:3636`, no Tailscale. Skip this to run no service at all.
4. Revoke a lost phone at once with `recense devices --revoke <id>` on the hub. Revoke your
   devices if the hub stays up: `recense devices`, then `recense devices --revoke <id>`
   for each. Remove the recense app from your phone's home screen.
5. Detach each attached machine with `recense detach` ([attach.md](attach.md#undo)).
6. Tailscale and the tailnet stay as they were.

## When something goes wrong

- [Tailscale is not installed or not running](troubleshooting.md#tailscale-is-not-installed-or-not-running)
- [Tailscale Serve is refused](troubleshooting.md#tailscale-serve-is-refused)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [The hub is unreachable](troubleshooting.md#the-hub-is-unreachable)
- [The pairing code expired or is locked](troubleshooting.md#the-pairing-code-expired-or-is-locked)
- [recense pair prints no code](troubleshooting.md#recense-pair-prints-no-code)
- [A server from an older recense cannot be asked to stop](troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop)
