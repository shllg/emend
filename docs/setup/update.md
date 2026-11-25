# Update recense

This page suits you if recense already runs and a new version is out. You update every part you set
up: the package, the server, the agent skills, the Claude Code plugin and the app on your phone.
Skip the steps for parts you did not set up. If you run a hub, update the hub first and its
attached machines after it.

A single machine skips step 1 and step 6 (the phone app), unless it also serves your phone.

**After a Node.js upgrade.** `brew upgrade node` and `mise upgrade node` change the Node.js that
the recense service was installed with. Run `recense service install` again after either one. A
service that still points at the old Node.js fails to start.

An old state-folder config is copied only when the global config is missing, then renamed
`config.json.migrated`. If the global config already exists, recense keeps the old file under that
name and warns without merging it. `RECENSE_HOME` moves only state; use `XDG_CONFIG_HOME` for config.
The service records an absolute `XDG_CONFIG_HOME` at install time. Reinstall it after changing that value.
For `docRoots` and `openBrowser`, publish and bare `recense` ignore a global config whose path or
links lie inside a repository holding the working directory. `recense config` refuses there.
An old state config inside such a repository is never read, copied or renamed.
A dotfiles repository at the home folder is allowed. The server reads only `approvedActiveHours`, `approvedActiveLimit` and `keys`
from the file and does not apply this check. A config path set by a repository's environment
is not detected when recense runs from a folder outside every repository.

## Update with one command

`recense update` does steps 2 and 3 for you. Run it in your own terminal, on each machine:

```sh
recense update
```

It does six things:

1. It finds how you installed recense: mise, npm or pnpm. A mise install counts with any package
   manager mise's `npm.package_manager` setting picks: aube, npm, bun or pnpm.
2. It copies the database to `backups/` in the state folder and prints the path. Three backups
   stay after a successful change, always including this run's backup. A failed update keeps all
   backups. If the version and service stay unchanged and no older server is running, it removes
   only the backup it just made.
3. It updates recense from your home folder, never from inside a repository.
4. It restarts the service on the new version, when you installed the service. The server migrates
   the database as before.
5. It prints the version this machine runs and, when the machine is attached, the version of its
   hub and which one is behind.
6. It ends with notes for the other parts: whether the links in `~/.agents/skills` point at the
   new version, the Claude Code plugin commands, and the phone app. It changes none of them itself.

If something fails after the package manager starts, it prints how to restore the old version. The [Undo](#undo) section lists the
same steps.

If the package manager installs the same version, recense says
`recense <v> is already installed; <tool> installed nothing newer`. This does not claim the registry
has no newer release: the tool may defer one under its own release policy.

mise holds back every release for its first 24 hours unless recense is in
`minimum_release_age_excludes`: see [local.md](local.md#2-install-recense).

A local build gets the commands and nothing else. If you built recense from a checkout (or linked it
with `pnpm install:local`), `recense update` prints `git pull`, `pnpm install` and
`pnpm install:local` for you to run, and changes nothing. Older local builds without the build
marker may still be mistaken for release installs.

`recense update` requires a terminal to prevent accidental agent runs; this does not stop a determined
agent. Agents must not run it: give the command to the user for their own terminal.

Registry and proxy settings must live in `~/.npmrc`, pnpm's or mise's own config: `recense update`
passes only a short list of environment variables. HOME must resolve to your account's home folder.
Path settings and the newly installed recense must stay outside the repositories of your working
directory, including paths reached through symbolic links.

With mise, `recense update` runs `mise upgrade --bump npm:@shllg/recense`. That keeps `latest` and
the other options of the recense entry in mise's config. A `postinstall` line
([Let mise finish the update](#let-mise-finish-the-update)) runs inside it, so it also links the
skills again and updates the Claude Code plugin, and the notes then show the links on the new
version. `recense update` does not pass `CLAUDE_CONFIG_DIR` on, so inside it the line updates the
plugin only in Claude Code's default config folder.

The other steps still apply unless a mise `postinstall` line did them, and the notes name them.
Update the hub first, link the skills again (step 4), update the
plugin (step 5) and the phone app (step 6). It reports the hub only, not the machines attached to
it: run it on each machine.

## Set it up with an agent

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me the
change and wait for my yes; never read secrets (tokens, .env files, credential stores) or recense's
state folder; never open ~/.claude/settings.json whole;
never open mise's config files and never run mise env, mise set or mise config get, since they can
show secrets from [env]; if a dotfiles tool manages a file or link
you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or similar),
change its source and tell me how to apply it; never run recense pair, attach, detach, config or
devices yourself, give me the command instead;
never run claude plugin commands or mise upgrade yourself, give them to me for my own terminal;
never pass --host or any flag this page does not name; never retry a command through another
program (for example script) to get a terminal; never
list the devices on my tailnet; outside your sandbox run only recense service install (no new flags),
recense service status, recense stop and recense skills install, and no other command; run no process listing
yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af '[r]ecense.mjs serve'; macOS: pgrep
-lf '[r]ecense.mjs serve').
Update recense on this machine. Follow
https://github.com/shllg/recense/blob/release/docs/setup/update.md step by step. First ask me which
parts I set up: the service, the agent skills, the Claude Code plugin, a hub, attached machines.
Update only those. If this machine is a hub, do it before any attached machine.
```

## What you need

- recense installed. `recense --version` prints the version you run now.
- For a hub setup: shell access to the hub and to each attached machine, and your phone.

## 1. Update the hub first

A hub runs the newest recense, and the machines attached to it follow. A hub refuses a machine that
is older than its minimum client version. `recense publish`, `wait`, `feedback` and `reply` then
print `recense: client_outdated`, and `recense attach` prints `recense: The client needs an update.` If you update the machines
first, and the new version raises that minimum, the old machines stop. Do these steps on the hub,
then repeat them on each attached machine ([attach.md](attach.md)).

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; never read secrets (tokens, .env files, credential stores) or recense's state folder.
Tell me which of these I run recense on: a hub, attached machines, a single machine. If I run a hub,
remind me to update the hub first and the attached machines after it.
```

## 2. Update the package

With npm, including Node.js from Homebrew:

```sh
npm install -g @shllg/recense@latest
```

With mise:

```sh
cd ~
mise upgrade npm:@shllg/recense
```

Then check the version:

```sh
recense --version
```

You should see `recense ` and the new version number. Use the command that matches how you
installed it. Run mise from your home folder, as the `cd ~` line does: a `postinstall` line (below)
runs in the folder where mise runs, and a project's mise config there can give the service another
Node.js.

`mise upgrade` replaces only the package. The rest stays on the old version until you do steps 3
to 5: the service until `recense service install` runs again, the links in `~/.agents/skills` until
`recense skills install` runs again, and the Claude Code plugin. mise keeps the old version for 24
hours, and `mise ls npm:@shllg/recense` marks it `pruned in 24h`. After that, a later mise command
removes it, or `mise prune` at once, as soon as no running process was started from it. A skill
link that still points there then breaks, and a service still installed on it fails at its next
start.

### Let mise finish the update

A `postinstall` command in mise's config runs each time mise installs a recense version: with
`mise upgrade` or `mise install`, also when they upgrade or install all your tools, and inside
`recense update`. This one does steps 3 to 5 for
the parts you set up. In `~/.config/mise/config.toml`, replace the recense line under `[tools]`
with:

```toml
"npm:@shllg/recense" = { version = "latest", allow_low_downloads = true, postinstall = '''
if recense service status | grep -q -e 'service running' -e 'service installed'; then
  recense service install || echo 'recense: service install failed' >&2
fi
if [ -L "$HOME/.agents/skills/recense-review" ]; then
  recense skills install || echo 'recense: skills install failed' >&2
fi
if command -v claude >/dev/null && claude plugin list | grep -q 'recense@recense'; then
  claude plugin marketplace update recense && claude plugin update recense@recense ||
    echo 'recense: Claude plugin update failed' >&2
fi
''' }
```

The same line works on Linux and macOS. mise runs it with `sh`, in the folder where you ran
mise, with the new `recense` first on `PATH`. Each part runs only for what you set up:

- The service: when `recense service status` finds one, `recense service install` restarts it
  on the new version (step 3). Without the service, step 3's `recense stop` still applies.
- The skills: when `~/.agents/skills/recense-review` is a link, `recense skills install` moves
  the links (step 4). If you link with `--dir <folder>`, use that folder in the `[ -L ... ]`
  test and add `--dir <folder>` to the command.
- The plugin: when Claude Code lists `recense@recense`, it updates the marketplace and the
  plugin (step 5). Restart Claude Code or run `/reload-plugins` afterwards.

A failing `postinstall` fails mise's install, so a part that fails prints a
`recense: ... failed` line and the install goes on; run that step by hand. Run every mise
command that can install recense from your home folder: in a project folder, the project's mise
config can give the service another Node.js.

After `mise upgrade npm:@shllg/recense`, mise prints `Upgraded 1 tool` and the output of each
part, such as `recense: service installed` and
`Plugin "recense" updated from <old> to <new>`. A line saying that the server runs the old
version can come first; the service install right after it fixes that. Check it:
`recense service status` prints `recense: service running (<path>)` and no line about another
version, and `recense skills install --dry-run` prints `... already linked` for each skill you linked.

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; never open mise's config files and never run mise env, mise set
or mise config get, since they can show secrets from [env]; never run mise upgrade or claude plugin
commands yourself.
Run recense --version and show me the result. Then update the package. If mise manages it, give me
cd ~ && mise upgrade npm:@shllg/recense to run in my own terminal, since a postinstall line in my
mise config would run inside it. If I want mise to finish each update, point me to the postinstall
entry under "Let mise finish the update" in
https://github.com/shllg/recense/blob/release/docs/setup/update.md to copy into
~/.config/mise/config.toml myself. Otherwise (npm or Homebrew's Node.js) run npm install -g
@shllg/recense@latest. Run recense --version again and show me the new version.
```

## 3. Restart the server on the new version

With the service, run the install again. It keeps the options you installed it with, such as
`--tailscale`, and restarts the server so the new version runs:

```sh
recense service install
recense service status
```

You should see `recense: keeping the service options ...` when the service has options, then
`recense: service installed`, then `recense: service running (<path>)`.

Run it again after every Node.js upgrade, as the note at the top says.

Without the service, the server that `recense` started keeps running the old version. Stop it:

```sh
recense stop
```

You should see `recense: stopped the recense server at <url>`, or `recense: no recense server is running.`
The next `recense` starts the new version.

Until the server runs the new version, `recense` and `recense service status` print one line that
names both versions and the command that fixes it, for example:

```text
recense: the recense server at http://127.0.0.1:3636 runs recense 0.2.0; this is recense 0.3.0. Run recense stop, then recense, to start recense 0.3.0.
```

Run the command that line names. See
[troubleshooting.md](troubleshooting.md#recense-says-the-server-runs-another-version) for the other
forms of the line.

If `recense service install` or `recense stop` says a server is from an older recense and cannot be asked
to stop, see
[troubleshooting.md](troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop).

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; outside your sandbox run only recense service install (no new flags),
recense service status and recense stop, and no other command; never pass --host or any flag this page
does not name; never retry a command through another program (for example script) to get a
terminal; run no process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af
'[r]ecense.mjs serve'; macOS: pgrep -lf '[r]ecense.mjs serve').
If I installed the recense service, run recense service install and recense service status and show me
both outputs; it keeps its options and restarts the server. If I did not, run recense stop and show
me the output; the next recense starts the new version. If recense stop says the server is from an
older recense, ask me to run the pgrep command for my system and to end the process it lists.
If I upgraded Node.js (brew upgrade node, mise upgrade node), the service install must run again.
```

## 4. Link the skills again

If you ran `recense skills install`, run it again. mise keeps each version in its own folder, and the
command moves the links to the new one:

```sh
recense skills install
```

You should see `linked ...` for each skill, or `... already linked` when nothing changed.

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; if a dotfiles tool manages a file or link you would change (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it; outside your sandbox run only recense skills install, and no other command.
If I linked recense skills before (ls -l ~/.agents/skills shows recense-feedback, recense-publish and
recense-review), run recense skills install and show me the output. If a dotfiles tool manages that
folder, use --dir with its source folder. Otherwise skip this.
```

## 5. Update the Claude Code plugin

```sh
claude plugin marketplace update recense
claude plugin update recense@recense
```

Restart Claude Code, or run `/reload-plugins` in a running session. If you turned on auto-update
for the marketplace in `/plugin`, under Marketplaces, Claude Code does this for you; you can still
run the commands. See [agents.md](agents.md#1-add-the-plugin-to-claude-code).

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; never read secrets (tokens, .env files, credential stores) or recense's state folder; never
run claude plugin commands yourself.
If I use the recense plugin in Claude Code, give me claude plugin marketplace update recense and claude
plugin update recense@recense to run in my own terminal, since they change Claude Code's own plugin
folder, which an agent sandbox blocks. Then tell me to restart Claude Code or run /reload-plugins.
Otherwise skip this.
```

## 6. Update the app on your phone

The app on your phone is served by your hub, so it updates after the hub does. In the installed
app, open Devices and find the App section. It shows `recense <version>`. Tap Check for update. When
an update is ready, the section says `An update is ready.` and offers Update now. Tap it. When it
says to reload, tap Reload.

The check works in the installed app over HTTPS. A plain browser tab on an address that is not
secure shows `Updates need the installed app over a secure connection.`

You do this step on the phone yourself.

```text
Rules: never run recense update yourself; give it to me to run in my own terminal; never read secrets (tokens, .env files, credential stores) or recense's state folder.
Remind me to update the recense app on my phone after the hub is updated: open Devices, find the App
section, tap Check for update, then Update now, then Reload. Do not try to do this for me.
```

## Check that it works

1. `recense --version` prints the new version on every machine you updated.
2. `recense service status` prints `recense: service running (<path>)` where you use the service, and
   no line that the server runs another version.
3. Open the web app, then Devices. The App section shows the new `recense <version>`. This is the
   version of the server that serves the page. If it shows the old one, the old server still runs:
   repeat step 3.
4. On an attached machine, `recense publish <file>` works. If it prints `recense: client_outdated`,
   update that machine (`recense attach` prints `recense: The client needs an update.` instead).

## Update

This page is the update procedure. Run it again for the next release.

## Undo

recense has no rollback command. Use the two parts printed by `recense update`. The first restores
the old package and starts it; it leaves the database intact. It prints after a version change
and after any failure or interruption once the package manager started, even without a database.
An unchanged successful update prints no recovery steps.

Stop every agent that uses recense, then paste the recovery output into a POSIX shell such as bash
or zsh. You may paste both parts, including their comment lines: the database part checks whether
restoration is needed before changing anything. Keep the quotes,
`/usr/bin/env -i` arguments and `&&` between commands: the list stops at the first failure.

1. Change to the printed home folder.
2. With a service, stop it first. Linux uses the checked absolute path to `systemctl` with
   `--user stop recense` through the pinned environment. macOS runs `/bin/launchctl bootout` in a
   subshell, then polls `print` up to 50 times, sleeping 0.2 seconds between attempts. Only a final exit status of 113 (not loaded)
   permits the next command; a still-loaded job, missing launchctl or any other error stops the list.
3. Restore the old package through the printed absolute helper path. npm uses
   `install --global --prefix <prefix> --ignore-scripts @shllg/recense@<old>`; pnpm uses
   `add --global --ignore-scripts --ignore-pnpmfile @shllg/recense@<old>`; mise uses
   `use --global npm:@shllg/recense@<old>`.
   Without a service, restore first, then run the printed Node.js and restored old entry with
   `stop`. It waits until the server process exits or removes its discovery record after database
   cleanup, even when the listener has already closed.
4. Run the printed Node.js and old entry with `service install` when there is a service, or with
   no arguments to start the server and open the inbox otherwise.

The second part prints only when a backup exists, and names the backup time. Stop every agent
that uses recense before running it. It first changes to the home folder and runs the restored old
entry's `ls` with the pinned environment. It proceeds only if the output contains the newer-database
error. A list, an answer from a running server, or any other error stops the list without restoring.
**Everything since that backup is lost if it is restored, including devices and tokens revoked
since then: revoke them again afterwards.**

After that check, the second list stops the service, or runs the old entry's `stop` and waits for
the server process and its database cleanup. It copies the backup to `recense.db.restore` with
`/bin/cp`, removes the database's WAL and SHM files with `/bin/rm`, then moves the copy over the
database with `/bin/mv`. Existing open handles retain the old inode. Finally it starts the old
entry again. Without a backup, stay on the newer version if the old one refuses the database.

Every program in both lists runs through `/usr/bin/env -i`, discarding the pasting shell's
settings. It pins the checked `PATH`, `HOME`, mise directories, tool homes, certificate paths,
`TMPDIR`, all retained `XDG_*` names (including `XDG_RUNTIME_DIR`) and `DBUS_SESSION_BUS_ADDRESS`
from the update's child environment. It omits identity, shell, locale and terminal settings.
The restore adds `npm_config_ignore_scripts=true`, including for mise's npm backend, and refers
to each retained proxy variable as `NAME="${NAME-}"`: proxy values are never printed, and come
from the shell where you paste the list. The recense commands also pin `RECENSE_HOME`.

The state folder defaults to `$XDG_DATA_HOME/recense` on Linux when `XDG_DATA_HOME` is absolute,
otherwise `~/.local/share/recense`; on macOS it is `~/Library/Application Support/recense`.
`RECENSE_HOME` overrides these defaults. The printed restore paths already account for it.

## When something goes wrong

- [recense says the server runs another version](troubleshooting.md#recense-says-the-server-runs-another-version)
- [A server from an older recense cannot be asked to stop](troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [The client needs an update](troubleshooting.md#the-client-needs-an-update)
- [The skills links are broken after an update](troubleshooting.md#the-skills-links-are-broken-after-an-update)
- [The plugin does not update](troubleshooting.md#the-plugin-does-not-update)
