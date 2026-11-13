# Set up your own emend hub behind your own address

This setup suits you if you have an always-on machine, your own name for it and your own HTTPS
reverse proxy, instead of Tailscale. You get a hub at `https://emend.example.com` for your devices
and your phone paired to it. This page writes the address as `emend.example.com`; use yours.

emend keeps listening on `127.0.0.1:3636` over plain HTTP. Your proxy answers HTTPS and forwards
to it. emend does not set up the name, the certificate or the proxy. It never contacts the address
itself.

A hub has one owner. Every device you pair sees every review on it, and your machines attach to
it ([attach.md](attach.md)) so their agents publish there.

## Set it up with an agent

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me the
change and wait for my yes; before you change the proxy's configuration, show me the change and
wait for my yes; give me any command that needs sudo to run myself; never read secrets (tokens,
.env files, credential stores) or emend's state folder; never open ~/.claude/settings.json whole;
if a dotfiles tool manages a file or link you would change (a symlink into a dotfiles repository,
stow, chezmoi, home-manager or similar), change its source and tell me how to apply it; never run
emend pair, attach, detach, config or devices yourself, give me the command instead; never pass
--host or any flag this page does not name; never retry a command through another program (for
example script) to get a terminal; outside your sandbox run only emend service install --public-url
<my address>, emend service status and emend service uninstall, and no other command; run no process
listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af '[e]mend.mjs serve';
macOS: pgrep -lf '[e]mend.mjs serve').
Make this machine my emend hub behind my own HTTPS address (https://github.com/shllg/emend).
Follow https://github.com/shllg/emend/blob/release/docs/setup/hub-network.md step by step. emend
must already be installed here (https://github.com/shllg/emend/blob/release/docs/setup/local.md).
Ask me for my address and before each step. Tell me when I must act on my phone. For the final
check, give me the emend publish command to run in my own terminal; run it yourself only if the
command works inside your sandbox.
```

## What you need

- An always-on machine on Linux or macOS with emend installed. See [local.md](local.md).
- A name your devices resolve to the hub, through your DNS, your router or a hosts entry.
- An HTTPS reverse proxy on the hub: Caddy, nginx, Traefik or another. Its certificate must be
  trusted by every device that reviews or attaches. A publicly trusted certificate works
  everywhere. For example, Let's Encrypt through the DNS challenge needs no open port. If you use
  your own CA, trust it on the phone and on each attached machine. Node.js ignores the system
  store by default: set `NODE_EXTRA_CA_CERTS` to your CA certificate's path in the environment
  emend runs in.
- A network only you and your devices reach, such as your home network or your VPN. Do not expose
  the hub to the open internet. Anyone who reaches `/pair` can lock code entry for ten minutes by
  guessing wrong codes.
- A name of its own for emend. Every HTTPS service on the same name, on any port, receives emend's
  sign-in cookie.
- A phone with a browser. On an iPhone, use Safari.

## 1. Point your proxy at emend

Configure your proxy to:

- Forward `https://emend.example.com` to `http://127.0.0.1:3636`.
- Pass the `Host` header through unchanged, port included. emend answers hosts outside its
  allowlist with `403 bad_host`. It marks the sign-in cookie `Secure` only for the configured
  HTTPS host.
- Not buffer responses. The browser's live updates are a server-sent event stream.
- Not cap request bodies. emend enforces its own limits; attached machines upload whole reviews.

For Caddy, the Caddyfile site block is:

```caddyfile
emend.example.com {
    reverse_proxy 127.0.0.1:3636
}
```

Caddy passes `Host` through, streams event responses and sets no body limit by default. This
block uses Caddy's automatic HTTPS. Configure certificate issuance for your network; for a DNS
challenge, Caddy needs the DNS provider's module and configuration. Adding `tls internal` uses
Caddy's own CA instead. Every device must then trust that CA.

For nginx, set these in the emend site's proxy configuration:

```nginx
proxy_set_header Host $http_host;
proxy_buffering off;
client_max_body_size 0;
```

Use `$http_host`, not `$host`: `$host` drops the port. You also need the site's HTTPS listener,
certificate and `proxy_pass http://127.0.0.1:3636;`.

On Linux, Caddy and nginx come from your distribution's packages. On macOS, both are available
through Homebrew. Changing a system proxy usually needs `sudo`. Run those commands yourself.

```text
Rules: never read secrets (tokens, .env files, credential stores, private keys) or emend's state
folder; before you change the proxy's configuration, show me the change and wait for my yes;
give me any command that needs sudo to run myself; if a dotfiles tool manages a file or link you
would change, change its source and tell me how to apply it; run no process listing yourself;
stay inside your sandbox and give me commands that need to run outside it.
Find which HTTPS proxy runs on this machine. Ask me for emend's address and how its certificate
is trusted. Show me the site change that forwards it to http://127.0.0.1:3636, preserves Host
including its port, streams responses and sets no request body limit. Wait for my yes before
changing it. Give me any sudo commands to apply the change myself.
```

## 2. Install the service with your address

```sh
emend service install --public-url https://emend.example.com
emend service status
```

You should see `emend: service installed`, then `emend: service running (<path>)`. The service
log holds `emend: serving https://emend.example.com`.

The server still listens on `127.0.0.1:3636`. The address only names where your devices reach it.
Pairing links, the QR code and review links use it, and emend accepts requests for that name.
emend does not check whether the proxy or the address works.

The value must be an HTTPS origin with no path. One trailing `/` is allowed. A port is allowed,
such as `https://emend.example.com:8443`. You cannot combine `--public-url` with `--tailscale`.

HTTPS is required because the sign-in cookie lasts 30 days and can create comments, Sends and
approvals. Plain HTTP would carry that cookie and pairing codes across the network.

The service remembers `--public-url`. `emend service install` without options keeps it. To run a
server by hand instead, run `emend serve --public-url https://emend.example.com` in a terminal
that stays open.

If a server already runs, the install command asks it to stop first. See
[troubleshooting.md](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop) if
the server is too old to be asked.

On a headless Linux machine, a user service stops when you log out. The install command then
prints `To keep emend running after you log out, run sudo loginctl enable-linger $USER.` Run that
command yourself, once.

On Linux, the unit is `~/.config/systemd/user/emend.service` and the log is
`journalctl --user -u emend`. On macOS, the agent is
`~/Library/LaunchAgents/dev.emend.server.plist` and the log is `~/Library/Logs/emend.log`.

**Why this matters.** While emend is down, whatever listens on `127.0.0.1:3636` receives the
requests your proxy forwards, including the reviewer cookie. On a shared machine, any local user
could bind that port. Run the hub on a machine you alone use.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; outside your sandbox run only emend service install --public-url
<my address>, emend service status and emend service uninstall, and no other command; never pass
--host or any flag this page does not name; never retry a command through another program (for
example script) to get a terminal; run no process listing yourself, ask me to run pgrep in my own
terminal (Linux: pgrep -af '[e]mend.mjs serve'; macOS: pgrep -lf '[e]mend.mjs serve').
Run emend service install --public-url with my HTTPS origin, then emend service status. Show me
both outputs. If the output says to enable linger, give me that sudo command to run myself. If a
server cannot be asked to stop, ask me to run the pgrep command for my system and end that server,
then install again. On a failure, diagnose it with
https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md.
```

### A proxy on another machine

`--host <address of the hub>` makes emend listen on that address, over plain HTTP. Every
device on that network can reach emend directly, unencrypted. Use it only on a network you trust.
Run this yourself; agents must not pass `--host`:

```sh
emend service install --host <address> --public-url https://emend.example.com
```

## 3. Pair your phone

On the hub, in a terminal, run:

```sh
emend pair
```

`emend pair` prints a one-time link, an 8-character code and a QR code. All three are valid for
10 minutes and work once. It prints them only in a terminal. If it says
`This link works only on this machine. To pair a phone, run emend serve --tailscale.`, the server
does not know its address: check step 2.

On your phone:

1. Scan the QR code, or open the link, in the phone's browser. The browser pairs and shows the
   inbox. If it asks for a code instead, type the 8-character code.
2. iPhone: use Safari. Tap Share, then Add to Home Screen. Open emend from the home screen and
   enter the code. The home-screen app keeps its own storage, so it needs its own pairing even
   after Safari paired. Run `emend pair` again for a fresh code.
3. Other phones: install emend from the browser's menu (Install app or Add to Home Screen), open
   it, and pair it the same way.

Pair another browser or phone at any time with `emend pair` again. You can also open Devices in a
browser that is already signed in and choose Pair a device.

List and revoke paired devices from the hub:

```sh
emend devices
emend devices --revoke <id>
```

`emend devices` prints one line per device: its name, kind, creation date, last-seen date and id,
separated by tabs. `--revoke <id>` prints `Revoked <name>.` and signs that device out.

You run `emend pair` and `emend devices` yourself: they print one-time secrets and manage who
may review.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never run
emend pair, attach, detach, config or devices yourself, give me the command instead.
Walk me through pairing my phone. Tell me to run emend pair myself in a terminal on this machine,
then explain: scan the QR code or open the link on the phone and type the code if asked; on an
iPhone use Safari, choose Add to Home Screen, open the home-screen app, and enter a code there too,
because it has its own storage; on another phone install the app from the browser menu.
```

## 4. Attach your machines and set up their agents (optional)

To make the agents on your other machines publish to the hub, follow [attach.md](attach.md). The
agent side of each machine is on [agents.md](agents.md).

If the proxy uses a certificate from your own CA, each attached machine must trust it too. Set
`NODE_EXTRA_CA_CERTS` to your CA certificate's path in the environment that runs emend, including
the agents that call it. Node.js reads that variable when it starts.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never run
emend pair, attach, detach, config or devices yourself, give me the command instead.
Help me attach another machine to this hub: follow
https://github.com/shllg/emend/blob/release/docs/setup/attach.md. Tell me to run emend pair
--machine on the hub myself, and the emend attach command it prints on the other machine myself.
If I use my own CA, explain how to set NODE_EXTRA_CA_CERTS to its certificate on that machine
before emend or its agents start. Then follow
https://github.com/shllg/emend/blob/release/docs/setup/agents.md for its agents.
```

## Check that it works

1. On the hub: `emend service status` prints `emend: service running (<path>)`.
2. On your phone, connected to your home network or VPN, open `https://emend.example.com`.
   You should see the inbox, not the pairing page or a certificate warning.
3. On the hub, publish a small doc as [local.md](local.md#check-that-it-works) shows. Reload the
   phone: the review appears.
4. `emend devices` lists your phone.

## Update

Update the hub first, then its machines. See [update.md](update.md).

## Undo

1. Stop the hub: `emend service uninstall`. This stops the server and deletes its saved options.
2. Remove the proxy's emend site and reload the proxy. Until you do, a program on port 3636
   receives requests meant for emend. Run commands that need `sudo` yourself.
3. To run a loopback-only server again, run `emend service install` with no options after the
   uninstall. It uses `127.0.0.1:3636`, without a public address. Skip this to run no service at
   all.
4. Revoke a lost phone at once with `emend devices --revoke <id>` on the hub. Revoke your devices
   if the hub stays up: `emend devices`, then `emend devices --revoke <id>` for each. Remove the
   emend app from your phone's home screen.
5. Detach each attached machine with `emend detach` ([attach.md](attach.md#undo)).
6. The proxy and the name otherwise stay as they were.

## When something goes wrong

- [The hub behind your proxy answers
  bad_host](troubleshooting.md#the-hub-behind-your-proxy-answers-bad_host)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [The hub is unreachable](troubleshooting.md#the-hub-is-unreachable)
- [The pairing code expired or is locked](troubleshooting.md#the-pairing-code-expired-or-is-locked)
- [emend pair prints no code](troubleshooting.md#emend-pair-prints-no-code)
- [A server from an older emend cannot be asked to
  stop](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop)
