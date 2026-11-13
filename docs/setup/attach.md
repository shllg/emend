# Attach more of your machines to your hub

This setup suits you if you run your own emend hub ([hub-tailscale.md](hub-tailscale.md) or
[hub-network.md](hub-network.md)) and
work with agents on other machines, such as a laptop or a build box. You get one inbox for all of
them: the agents on an attached machine publish to your hub, and the feedback you send from any
device reaches them.

## Set it up with an agent

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me the
change and wait for my yes; never read secrets (tokens, .env files, credential stores) or emend's
state folder; never open ~/.claude/settings.json whole; if a dotfiles tool manages a file or link
you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or similar),
change its source and tell me how to apply it; never run emend pair, attach, detach, config or
devices yourself, give me the command instead; never pass --host or any flag this page does not
name; never retry a command through another program (for example script) to get a terminal; never
list the devices on my tailnet; outside your sandbox run only emend skills install, and no other
command; run no process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af
'[e]mend.mjs serve'; macOS: pgrep -lf '[e]mend.mjs serve').
Attach this machine to my emend hub (https://github.com/shllg/emend). Follow
https://github.com/shllg/emend/blob/release/docs/setup/attach.md step by step. emend must already be
installed here (https://github.com/shllg/emend/blob/release/docs/setup/local.md). Tell me what to
run on the hub and what to run here, and wait for me between the two. For the final check, give me
the emend publish command to run in my own terminal; run it yourself only if the command works
inside your sandbox.
```

## What you need

- A working hub with its address, for example `https://<hub>.<tailnet>.ts.net`. See
  [hub-tailscale.md](hub-tailscale.md) or [hub-network.md](hub-network.md).
- emend installed on this machine. A hub refuses a machine whose emend is older than the hub's
  minimum client version. See [local.md](local.md) and [update.md](update.md).
- This machine reaches the hub. For a Tailscale hub, Tailscale runs here and is signed in to the
  same tailnet.
- A terminal on the hub and a terminal on this machine.

emend attaches only to a hub that answers over HTTPS. It refuses a plain `http://` hub unless the
address is on this machine itself.

## 1. Create the pairing link on the hub

On the hub, run:

```sh
emend pair --machine
```

You should see a link such as `https://<hub>.<tailnet>.ts.net/pair#emp_...`, a code, the line
`Valid for 10 minutes, once.`, and the command to run on the machine:
`On the other machine, run: emend attach <link>`.

If the hub prints `This link works only on this machine. To attach another machine, run emend
serve --tailscale.`, the hub does not know its public address yet. Finish
[hub-tailscale.md](hub-tailscale.md) or [hub-network.md](hub-network.md) first.

You run this yourself: the link is a one-time secret.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never run
emend pair, attach, detach, config or devices yourself, give me the command instead.
Tell me to run emend pair --machine myself in a terminal on my hub, and to copy the emend attach
command it prints. Explain that the link is valid for 10 minutes and works once.
```

## 2. Attach this machine

On the machine you attach, run the command the hub printed:

```sh
emend attach <link>
```

emend registers the machine with the hub, then copies this machine's existing reviews to the hub.
You should see:

```text
emend: attached to <hub name>; copied <n> reviews, skipped <m>.
```

What attach changes:

- emend stores the hub address and a machine credential in its state folder on this machine.
- It copies every existing local review whole to the hub: revisions, files and diffs, threads,
  comments, Sends and open deliveries, with the same review ids. Every device paired to the hub
  then sees them. Running attach again skips reviews already on the hub.
- A review with a running `emend wait` is skipped. Attach then exits with 1 and prints
  `emend: review <id> has a running wait; run emend attach again when it ends.` Run attach again
  after the wait ends.
- The success line goes to stderr, not stdout.
- The local copies become read-only links to the hub. Review them on the hub.
- It is a one-time copy. There is no two-way sync.

A machine attaches to one hub. To attach to another, run `emend detach` first.

The machine credential sits in this machine's state folder. Anyone with a copy of that folder, such
as a backup or a lost laptop, can act as this machine. If you lose a machine or a phone, revoke it
at once on the hub: `emend devices`, then `emend devices --revoke <id>`.

You run this yourself, never an agent: attaching sends this machine's reviews to the hub. See
[What an agent can do with emend](agents.md#what-an-agent-can-do-with-emend).

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never run
emend pair, attach, detach, config or devices yourself, give me the command instead.
Tell me to run the emend attach <link> command from my hub myself, on this machine, and what the
success line (on stderr) looks like: "emend: attached to <hub name>; copied <n> reviews, skipped
<m>." Then check that emend --version works here.
```

## 3. Set up the agents on this machine

The agents here need the review skills. Follow [agents.md](agents.md).

This machine needs no service of its own. An attached emend does not use a local server: its
`emend publish`, `wait`, `feedback`, `reply` and MCP tools go to the hub. Run `emend` and it prints
the hub's address, or opens it in your browser when `openBrowser` is on. A browser on this machine
is not paired yet: pair it from the hub with `emend pair`. If you installed a service on this
machine earlier and want none, run `emend service uninstall`.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; if a dotfiles tool manages a file or link you would change (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it; outside your sandbox run only emend skills install, and no other command;
never retry a command through another program (for example script) to get a terminal.
Give the agents on this attached machine the emend skills: follow
https://github.com/shllg/emend/blob/release/docs/setup/agents.md and skip any agent I do not use. Do
not install an emend service here; this machine uses the hub.
```

## Check that it works

1. On this machine, in a git repository, publish a small doc:
   `emend publish <file>`. It prints a review URL on the hub's address.
2. Open that URL on your phone or on the hub. The review is there, with this machine's name on it.
3. Turn the hub off, or disconnect from the tailnet, and run `emend publish <file>` again. It
   fails with one line and changes nothing:
   `emend: cannot reach the hub at <hub address>: connection refused. Nothing was changed.`
   The reason after the colon can also be `timed out` or `connection failed`.

## Update

Update the hub first, then each machine. See [update.md](update.md). A machine that is older than
the hub's minimum client version stops: `emend publish`, `wait`, `feedback` and `reply` print
`emend: client_outdated`, and `emend attach` prints `emend: The client needs an update.` Update
this machine.

## Undo

On the attached machine, run:

```sh
emend detach
```

You should see `emend: detached from <hub name>.` New reviews on this machine are local again.
Reviews already on the hub stay there; delete them on the hub if you want them gone. If the hub
was not reached, the line adds `The hub was not reached; revoke this machine in its devices.`
Then open Devices on the hub, or run `emend devices` on the hub and
`emend devices --revoke <id>` for this machine. Revoke a lost machine or phone the same way, at
once. The reviews this machine copied to the hub stay there until you delete them.

Undo the agent side of this machine as [agents.md](agents.md#undo) says.

## When something goes wrong

- [The pairing link is invalid](troubleshooting.md#the-pairing-link-is-invalid)
- [The pairing code expired or is locked](troubleshooting.md#the-pairing-code-expired-or-is-locked)
- [This machine is already attached](troubleshooting.md#this-machine-is-already-attached)
- [The hub is unreachable](troubleshooting.md#the-hub-is-unreachable)
- [The client needs an update](troubleshooting.md#the-client-needs-an-update)
- [An agent's sandbox blocks emend](troubleshooting.md#an-agents-sandbox-blocks-emend)
