# Update emend

This page suits you if emend already runs and a new version is out. You update every part you set
up: the package, the server, the agent skills, the Claude Code plugin and the app on your phone.
Skip the steps for parts you did not set up. If you run a hub, update the hub first and its
attached machines after it.

A single machine skips step 1 and step 6 (the phone app), unless it also serves your phone.

**After a Node.js upgrade.** `brew upgrade node` and `mise upgrade node` change the Node.js that
the emend service was installed with. Run `emend service install` again after either one. A
service that still points at the old Node.js fails to start.

An old state-folder config is copied only when the global config is missing, then renamed
`config.json.migrated`. If the global config already exists, emend keeps the old file under that
name and warns without merging it. `EMEND_HOME` moves only state; use `XDG_CONFIG_HOME` for config.
The service records an absolute `XDG_CONFIG_HOME` at install time. Reinstall it after changing that value.
A global config inside a repository that holds the working directory is ignored by publish and
bare `emend`; `emend config` refuses there. A dotfiles repository at the home folder is allowed.

## Set it up with an agent

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me the
change and wait for my yes; never read secrets (tokens, .env files, credential stores) or emend's
state folder; never open ~/.claude/settings.json whole; if a dotfiles tool manages a file or link
you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or similar),
change its source and tell me how to apply it; never run emend pair, attach, detach, config or
devices yourself, give me the command instead;
never run claude plugin commands yourself, give them to me for my own terminal; never pass --host or any flag this page does not
name; never retry a command through another program (for example script) to get a terminal; never
list the devices on my tailnet; outside your sandbox run only emend service install (no new flags),
emend service status, emend stop and emend skills install, and no other command; run no process listing
yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af '[e]mend.mjs serve'; macOS: pgrep
-lf '[e]mend.mjs serve').
Update emend on this machine. Follow
https://github.com/shllg/emend/blob/release/docs/setup/update.md step by step. First ask me which
parts I set up: the service, the agent skills, the Claude Code plugin, a hub, attached machines.
Update only those. If this machine is a hub, do it before any attached machine.
```

## What you need

- emend installed. `emend --version` prints the version you run now.
- For a hub setup: shell access to the hub and to each attached machine, and your phone.

## 1. Update the hub first

A hub runs the newest emend, and the machines attached to it follow. A hub refuses a machine that
is older than its minimum client version. `emend publish`, `wait`, `feedback` and `reply` then
print `emend: client_outdated`, and `emend attach` prints `emend: The client needs an update.` If you update the machines
first, and the new version raises that minimum, the old machines stop. Do these steps on the hub,
then repeat them on each attached machine ([attach.md](attach.md)).

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder.
Tell me which of these I run emend on: a hub, attached machines, a single machine. If I run a hub,
remind me to update the hub first and the attached machines after it.
```

## 2. Update the package

With npm, including Node.js from Homebrew:

```sh
npm install -g @shllg/emend@latest
```

With mise:

```sh
mise upgrade npm:@shllg/emend
```

Then check the version:

```sh
emend --version
```

You should see `emend ` and the new version number. Use the command that matches how you
installed it. If you installed with mise, `mise upgrade` keeps the old version in its own folder.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder.
Run emend --version and show me the result. Then update the package: if mise manages it, run mise
upgrade npm:@shllg/emend; otherwise (npm or Homebrew's Node.js) run npm install -g
@shllg/emend@latest. Run emend --version again and show me the new version.
```

## 3. Restart the server on the new version

With the service, run the install again. It keeps the options you installed it with, such as
`--tailscale`, and restarts the server so the new version runs:

```sh
emend service install
emend service status
```

You should see `emend: keeping the service options ...` when the service has options, then
`emend: service installed`, then `emend: service running (<path>)`.

Run it again after every Node.js upgrade, as the note at the top says.

Without the service, the server that `emend` started keeps running the old version. Stop it:

```sh
emend stop
```

You should see `emend: stopped the emend server at <url>`, or `emend: no emend server is running.`
The next `emend` starts the new version.

Until the server runs the new version, `emend` and `emend service status` print one line that
names both versions and the command that fixes it, for example:

```text
emend: the emend server at http://127.0.0.1:3636 runs emend 0.2.0; this is emend 0.3.0. Run emend stop, then emend, to start emend 0.3.0.
```

Run the command that line names. See
[troubleshooting.md](troubleshooting.md#emend-says-the-server-runs-another-version) for the other
forms of the line.

If `emend service install` or `emend stop` says a server is from an older emend and cannot be asked
to stop, see
[troubleshooting.md](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop).

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; outside your sandbox run only emend service install (no new flags),
emend service status and emend stop, and no other command; never pass --host or any flag this page
does not name; never retry a command through another program (for example script) to get a
terminal; run no process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af
'[e]mend.mjs serve'; macOS: pgrep -lf '[e]mend.mjs serve').
If I installed the emend service, run emend service install and emend service status and show me
both outputs; it keeps its options and restarts the server. If I did not, run emend stop and show
me the output; the next emend starts the new version. If emend stop says the server is from an
older emend, ask me to run the pgrep command for my system and to end the process it lists.
If I upgraded Node.js (brew upgrade node, mise upgrade node), the service install must run again.
```

## 4. Link the skills again

If you ran `emend skills install`, run it again. mise keeps each version in its own folder, and the
command moves the links to the new one:

```sh
emend skills install
```

You should see `linked ...` for each skill, or `... already linked` when nothing changed.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; if a dotfiles tool manages a file or link you would change (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it; outside your sandbox run only emend skills install, and no other command.
If I linked emend skills before (ls -l ~/.agents/skills shows emend-feedback, emend-publish and
emend-review), run emend skills install and show me the output. If a dotfiles tool manages that
folder, use --dir with its source folder. Otherwise skip this.
```

## 5. Update the Claude Code plugin

```sh
claude plugin marketplace update emend
claude plugin update emend@emend
```

Restart Claude Code, or run `/reload-plugins` in a running session. If you turned on auto-update
for the marketplace in `/plugin`, under Marketplaces, Claude Code does this for you; you can still
run the commands. See [agents.md](agents.md#1-add-the-plugin-to-claude-code).

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never
run claude plugin commands yourself.
If I use the emend plugin in Claude Code, give me claude plugin marketplace update emend and claude
plugin update emend@emend to run in my own terminal, since they change Claude Code's own plugin
folder, which an agent sandbox blocks. Then tell me to restart Claude Code or run /reload-plugins.
Otherwise skip this.
```

## 6. Update the app on your phone

The app on your phone is served by your hub, so it updates after the hub does. In the installed
app, open Devices and find the App section. It shows `emend <version>`. Tap Check for update. When
an update is ready, the section says `An update is ready.` and offers Update now. Tap it. When it
says to reload, tap Reload.

The check works in the installed app over HTTPS. A plain browser tab on an address that is not
secure shows `Updates need the installed app over a secure connection.`

You do this step on the phone yourself.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder.
Remind me to update the emend app on my phone after the hub is updated: open Devices, find the App
section, tap Check for update, then Update now, then Reload. Do not try to do this for me.
```

## Check that it works

1. `emend --version` prints the new version on every machine you updated.
2. `emend service status` prints `emend: service running (<path>)` where you use the service, and
   no line that the server runs another version.
3. Open the web app, then Devices. The App section shows the new `emend <version>`. This is the
   version of the server that serves the page. If it shows the old one, the old server still runs:
   repeat step 3.
4. On an attached machine, `emend publish <file>` works. If it prints `emend: client_outdated`,
   update that machine (`emend attach` prints `emend: The client needs an update.` instead).

## Update

This page is the update procedure. Run it again for the next release.

## Undo

emend has no rollback command. To go back to an older version, install it by number, then repeat
steps 3 to 5. With mise:

```sh
mise use -g npm:@shllg/emend@<version>
```

With npm:

```sh
npm install -g @shllg/emend@<version>
```

An older emend refuses a database that a newer emend migrated, and says
`The emend database is newer than this emend. Update emend, then try again.` In that case, stay on
the newer version.

## When something goes wrong

- [emend says the server runs another version](troubleshooting.md#emend-says-the-server-runs-another-version)
- [A server from an older emend cannot be asked to stop](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [The client needs an update](troubleshooting.md#the-client-needs-an-update)
- [The skills links are broken after an update](troubleshooting.md#the-skills-links-are-broken-after-an-update)
- [The plugin does not update](troubleshooting.md#the-plugin-does-not-update)
