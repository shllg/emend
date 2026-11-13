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
change and wait for my yes; never open the proxy's configuration files, certificate keys or data
folder yourself: work from the emend site block I paste with credentials removed, show me the new
block and give me the commands to apply it; give me any command that needs sudo to run myself;
never read secrets (tokens, .env files, credential stores) or emend's state folder; never open
~/.claude/settings.json whole;
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
  trusted by every device that reviews or attaches. Prefer a publicly trusted certificate.
  For example, Let's Encrypt through the DNS challenge needs no open port. If you use your own
  CA, trust it on the phone and on each attached machine. Without name constraints, a device that
  trusts your CA trusts every certificate its key signs, for any site. Whoever reads that key
  can impersonate any site to that device. The key may be on the hub, in the proxy's data folder
  or in a backup. If you make a CA, prefer one limited to your own names through name constraints.
- A network only you and your devices reach, such as your home network or your VPN. Do not expose
  the hub to the open internet. Anyone who reaches `/pair` can lock code entry for ten minutes by
  guessing wrong codes.
- A name of its own for emend. Every HTTPS service on the same name, on any port, receives emend's
  sign-in cookie.
- A phone with a browser. On an iPhone, use Safari.

For an own-CA certificate, Node.js ignores the system store by default. On attached machines,
set `NODE_EXTRA_CA_CERTS` to your CA certificate's path only where emend runs. It applies to
every Node.js program started with it. The hub itself does not need it: emend never contacts its
own address, and its CLI talks to `127.0.0.1`.

## 1. Point your proxy at emend

Configure your proxy to:

- Serve emend only on HTTPS. Redirect plain HTTP on port 80 to HTTPS; never forward it to emend.
  A phone that opens the HTTP address could send a pairing secret or code across the network in
  plain text before emend refuses the request.
- Forward `https://emend.example.com` to `http://127.0.0.1:3636`, never `localhost`. `localhost`
  can resolve to `::1`, where emend does not listen and another local user could.
- Pass the `Host` header through unchanged, port included. emend answers hosts outside its
  allowlist with `403 bad_host`. Rewriting it to an allowed host such as `127.0.0.1:3636` makes
  pairing and every browser change fail with `403 bad_origin`: the browser's Origin names the
  public host. emend marks the sign-in cookie `Secure` only for that configured HTTPS host.
- Never set, strip or rewrite `Origin`. emend's Origin check is its only defence against requests
  from sibling names under the same domain. A fixed Origin turns that check off.
- Not buffer responses. The browser's live updates are a server-sent event stream.
- Allow request bodies of at least 25 MiB. That is emend's largest request body, a blob upload.
  emend enforces its own limits; attached machines upload whole reviews.

For Caddy, the Caddyfile site block is:

```caddyfile
emend.example.com {
    reverse_proxy 127.0.0.1:3636
}
```

Caddy passes `Host` through, streams event responses and sets no body limit by default. This
block uses Caddy's automatic HTTPS. Configure certificate issuance for your network; for a DNS
challenge, Caddy needs the DNS provider's module and configuration. Prefer a publicly trusted
certificate. Adding `tls internal` uses Caddy's own CA instead. Every device must then trust that
CA. Anyone who reads its key can impersonate sites to those devices. If you make a CA, prefer
one limited to your own names through name constraints.

For nginx, set these in the emend site's proxy configuration:

```nginx
proxy_set_header Host $http_host;
proxy_buffering off;
client_max_body_size 32m;
```

Use `$http_host`, not `$host`: `$host` drops the port. You also need the site's HTTPS listener,
certificate and `proxy_pass http://127.0.0.1:3636;`. The emend server block listens on 443 only.
Port 80 belongs in a separate block that redirects to HTTPS.

Keep a finite body limit. By default, nginx stores a request body before forwarding it. With no
limit, any client can fill the hub's disk. The 32 MiB cap allows emend's largest request body.

On Linux, Caddy and nginx come from your distribution's packages. On macOS, both are available
through Homebrew. Changing a system proxy usually needs `sudo`. Run those commands yourself.

```text
Rules: never read secrets (tokens, .env files, credential stores, private keys) or emend's state
folder; never read the proxy's certificate keys or its data folder; never open the proxy's
configuration files yourself; work only from the emend site block I paste with credentials
removed; show me the new block and give me the commands to apply it myself; give me any command
that needs sudo to run myself; if a dotfiles tool manages the file or link, give me the change to
its source and tell me how to apply it; run no process listing yourself; stay inside your sandbox
and give me commands that need to run outside it.
Ask me which proxy I run and where its emend site lives. Ask me for emend's address and how its
certificate is trusted. Ask me to paste the emend site block with any credential removed, including
a token in a tls or dns block or an API key. Work from that paste. Show me a new block that serves
emend only on HTTPS and redirects port 80 to HTTPS. It must forward to http://127.0.0.1:3636, never
localhost, preserve Host including its port, leave Origin unchanged, stream responses and allow
request bodies of at least 25 MiB. For nginx, use client_max_body_size 32m. Give me the commands to
apply the change myself.
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

**Why this matters.** While emend is down, whatever binds `127.0.0.1:3636` serves its own pages on
`https://emend.example.com`. On a shared machine, any local user could bind that port. That process
also receives the requests your proxy forwards, including the reviewer cookie. It can use that
session from the hub's loopback until you revoke it. A script it leaves in the phone's browser,
such as a service worker, can keep running after emend is back. It can read reviews and send
comments, Sends and approvals with the reviewer's cookie. A stolen reviewer cookie can also pair
new devices and machines.

Clear the site's data in the phone's browser to remove that script. Clearing site data does not
revoke the stolen session. Run `emend devices`. Revoke every device you do not recognize and every
device that used the address during the window, with `emend devices --revoke <id>`. Then pair again.

This window exists during every service restart or install, during `emend update`, and after a
crash until the restart. It also exists while the proxy runs whenever you are logged out of the
hub: on Linux unless linger is on, and on macOS always. The LaunchAgent runs only in your session,
while a system proxy starts at boot. After uninstall, the window lasts until you
remove the proxy's emend site. emend cannot remove your proxy's route. Point the proxy at
`127.0.0.1:3636`, never `localhost`: it can resolve to `::1`, where emend does not listen and
another local user could. Run the hub on a machine you alone use.

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
Every request on the proxy-to-hub hop is plain text. That includes the reviewer's sign-in cookie
and pairing secrets. Anyone who can watch that network can read them. Only an encrypted link
between the two machines, such as WireGuard, keeps the cookie and pairing secrets off the network.
A firewall rule that lets only the proxy's address reach the port additionally keeps other
devices from connecting directly. It does not stop anyone watching the network from reading the
hop.
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

Prefer a publicly trusted certificate. If you use your own CA, each attached machine must trust
it too. Without name constraints, that trust covers every certificate its key signs, for any
site. Whoever reads the key on the hub, in the proxy's data folder or in a backup can impersonate
sites to those devices. If you make a CA, prefer one limited to your own names.

Set `NODE_EXTRA_CA_CERTS` to your CA certificate's path only where emend runs on attached
machines. Node.js reads it when it starts. It applies to every Node.js program started with it,
so do not set it for unrelated programs. The hub itself does not need it: emend never contacts its
own address, and its CLI talks to `127.0.0.1`.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never run
emend pair, attach, detach, config or devices yourself, give me the command instead.
Help me attach another machine to this hub: follow
https://github.com/shllg/emend/blob/release/docs/setup/attach.md. Tell me to run emend pair
--machine on the hub myself, and the emend attach command it prints on the other machine myself.
Recommend a publicly trusted certificate first. If I use my own CA, explain that a device trusts
every certificate its key signs, for any site, unless the CA has name constraints. Whoever reads
the key on the hub, in the proxy's data folder or in a backup can impersonate sites to that
device. Recommend name constraints that limit the CA to my own names. Explain how to set
NODE_EXTRA_CA_CERTS to its certificate only where emend runs on the attached machine. It applies
to every Node.js program started with it. The hub does not need it: emend never contacts its own
address, and its CLI talks to 127.0.0.1. Then follow
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
2. If you ran `emend serve --public-url …` in a terminal instead of the service, stop it with
   Ctrl-C in that terminal, or run `emend stop`.
3. Remove the proxy's emend site and reload the proxy. emend cannot remove that route. Until you
   do, the risk in step 2's "Why this matters" applies. Run commands that need `sudo` yourself.
4. To run a loopback-only server again, run `emend service install` with no options after the
   uninstall. It uses `127.0.0.1:3636`, without a public address. Skip this to run no service at
   all.
5. Revoke a lost phone at once with `emend devices --revoke <id>` on the hub. Revoke your devices
   if the hub stays up: `emend devices`, then `emend devices --revoke <id>` for each. Remove the
   emend app from your phone's home screen.
6. Detach each attached machine with `emend detach` ([attach.md](attach.md#undo)).
7. The proxy and the name otherwise stay as they were.

## When something goes wrong

- [The hub behind your proxy answers bad_host or
  bad_origin](troubleshooting.md#the-hub-behind-your-proxy-answers-bad_host-or-bad_origin)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [The hub is unreachable](troubleshooting.md#the-hub-is-unreachable)
- [The pairing code expired or is locked](troubleshooting.md#the-pairing-code-expired-or-is-locked)
- [emend pair prints no code](troubleshooting.md#emend-pair-prints-no-code)
- [A server from an older emend cannot be asked to
  stop](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop)
