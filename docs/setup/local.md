# Set up recense on one machine

Use this page if you want to try recense, or review agent work on the machine where you run your
agents. You get the `recense` command, a review server on `127.0.0.1:3636` that only this machine
reaches, and the review skills for your agents. Phone and hub setups come later, on their own
pages: [hub-tailscale.md](hub-tailscale.md) and [attach.md](attach.md). Both start from this page.

## Set it up with an agent

```text prompt
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show
me the change and wait for my yes; never read secrets (tokens, .env files, credential stores) or
recense's state folder; never open ~/.claude/settings.json whole; never open mise's config files
and never run a mise command that prints environment values (such as mise env, mise set, mise
doctor or mise config get), since they can show secrets from [env]; if a dotfiles tool manages a
file or link you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager
or similar), change its source and tell me how to apply it; never run recense pair, attach,
detach, config or devices yourself, give me the command instead; never run claude plugin commands
or a mise command that installs recense yourself, give them to me for my own terminal; never pass
--host or any flag this page does not name; never retry a command through another program (for
example script) to get a terminal; never list the devices on my tailnet; outside your sandbox
run only recense service install, recense service status, recense service uninstall and recense
skills install, and no other command; run no process listing yourself, ask me to run pgrep in my
own terminal (Linux: pgrep -af '[r]ecense.mjs serve'; macOS: pgrep -lf '[r]ecense.mjs serve').
Set me up with recense on this one machine (https://github.com/shllg/recense). Follow
https://github.com/shllg/recense/blob/release/docs/setup/local.md step by step. Ask me which
optional steps I want: the service, the agent skills, and docRoots folders. For the final check,
give me the recense publish command to run in my own terminal; run it yourself only if the command
works inside your sandbox.
```

## What you need

- Linux or macOS, and a terminal.
- Node.js 24.18 or newer and git 2.44 or newer. Step 1 installs them.
- A user account that owns the machine. Do not run recense as root.

## 1. Install Node.js and git

Check what you have:

```sh
node --version
git --version
```

You need Node.js 24.18 or newer (`v24.18.0` or higher from `node`) and git 2.44 or newer. If one
is missing or too old, install it.

**macOS, the simplest path.** [Homebrew](https://brew.sh) ships a current Node.js that meets 24.18.
Apple's own git, from the Command Line Tools, is older than 2.44, so install git with Homebrew too:

```sh
brew install node git
```

If the shell says `brew: command not found` right after you installed Homebrew, run the two lines
the Homebrew installer printed at its end. They add `brew shellenv` to `~/.zprofile`. Then open a
new terminal. Homebrew's folder (`/opt/homebrew/bin` on Apple silicon) must come before `/usr/bin`
on your `PATH`, or the shell finds Apple's old git first. Check it:

```sh
command -v git
git --version
```

`command -v git` should print a path under Homebrew's folder, such as `/opt/homebrew/bin/git`, and
`git --version` should show 2.44 or newer.

**Linux, and macOS if you prefer it.** Use [mise](https://mise.jdx.dev). Many Linux distributions
ship a Node.js older than 24.18. If yours ships a new enough one, you can use it instead. Install
git with your package manager. Install mise as [its guide](https://mise.jdx.dev/getting-started.html)
says, then activate it in your shell, or neither `node` nor `recense` lands on your `PATH`. In zsh,
the macOS default:

```sh
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
```

In bash:

```sh
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
```

Open a new terminal, then install Node.js:

```sh
mise use -g node@24
```

If a dotfiles tool manages your shell rc file, add the activation line to its source instead and
apply it as the tool says.

Open a new terminal afterwards and run the two version commands again. You should see Node.js
24.18 or newer and git 2.44 or newer.

```text prompt
Rules: show me each change and wait for my yes; never read secrets (tokens, .env
files, credential stores) or recense's state folder; never open mise's config files and
never run a mise command that prints environment values (such as mise env, mise set,
mise doctor or mise config get), since they can show secrets from [env]; if a dotfiles
tool manages a file or link you would change (a symlink into a dotfiles repository,
stow, chezmoi, home-manager or similar), change its source and tell me how to apply it.
Check that Node.js 24.18 or newer and git 2.44 or newer are installed: run node --version, git
--version and command -v git, and show me the output. If one is missing or too old: on macOS with
Homebrew (brew exists), run brew install node git; git must come from Homebrew's folder, not
/usr/bin. If brew is missing after an install, tell me to run the two lines the installer
printed. Otherwise install mise as https://mise.jdx.dev/getting-started.html says, add its
activation line for my shell (eval "$(mise activate zsh)" in ~/.zshrc, or bash in ~/.bashrc), tell
me to open a new terminal, then run mise use -g node@24. On Linux install git with the package
manager. Verify by running the version commands again in a new terminal.
```

## 2. Install recense

Install the package with the tool that installed Node.js. With Homebrew's Node.js, or any Node.js
that npm belongs to:

```sh
npm install -g @shllg/recense
```

With mise (activated in your shell, as step 1 says), from any folder:

```sh
mise use -g 'npm:@shllg/recense[allow_low_downloads=true]'
```

`-g` writes recense into mise's global config, `~/.config/mise/config.toml`, so `recense` works
in every folder. Without `-g`, mise writes it into the config of the project you are in, and
`recense` is missing everywhere else. Remove it there with `mise unuse npm:@shllg/recense`, then
run the command above.

`allow_low_downloads=true` approves recense for the package manager built into mise. That
package manager refuses an npm package that is new or seldom downloaded until you approve it;
without the option, mise stops with `refusing to add @shllg/recense`.

mise also holds back every release for 24 hours (its `minimum_release_age` setting). Right after a
release it installs the one before, and `mise upgrade` and `recense update` find nothing newer. The
hold gives a broken release time to be found and withdrawn before mise installs it, and with a
`postinstall` line, before it runs as your service. To get each release on its first day anyway,
add recense to `minimum_release_age_excludes` in `~/.config/mise/config.toml`:

```toml
[settings]
minimum_release_age_excludes = ["npm:@shllg/recense"]
```

If that list already exists, add `"npm:@shllg/recense"` to it.

To let `mise upgrade` also update the service, the skills and the Claude Code plugin, add the
`postinstall` line from [update.md](update.md#let-mise-finish-the-update). It skips each part
you have not set up yet, so you can add it now.

If `npm install -g` fails with `EACCES` on a system Node.js, do not use `sudo`. Switch to
Homebrew's Node.js or to mise (step 1), then install again.

Check it:

```sh
recense --version
```

You should see `recense ` followed by a version number. If the shell says `recense: command not found`,
open a new terminal. With mise, the command is on your `PATH` only if mise is activated in your
shell.

With mise, run `recense --version` once more from another folder, such as your home folder. It
should print the same version. If it says `recense: command not found` there, recense went into a
project's config: see the `-g` paragraph above.

```text prompt
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; never open mise's config files and never run a mise command that
prints environment values (such as mise env, mise set, mise doctor or mise config get), since they
can show secrets from [env]; never run a mise command that installs recense yourself.
Install recense. If Node.js came from Homebrew or another npm install, run npm install -g
@shllg/recense. If mise manages Node.js, give me mise use -g
'npm:@shllg/recense[allow_low_downloads=true]' to run in my own terminal, always with -g: it writes
mise's global config, and a postinstall line there would run inside it. On an EACCES error from npm
with a system Node.js, never use sudo: tell me to switch to Homebrew's Node.js or mise. Then run
recense --version and show me the result; with mise, run it again from my home folder. If recense
is not found, tell me to open a new terminal; with mise, if it is found in one folder but not in my
home folder, tell me it went into a project's config and point me to the -g paragraph in step 2 of
https://github.com/shllg/recense/blob/release/docs/setup/local.md. With mise, ask me whether I want
each release on its first day, and tell me that mise's 24-hour hold gives a broken
release time to be withdrawn; if I do, point me to the minimum_release_age_excludes
lines in step 2 of that page to copy into ~/.config/mise/config.toml myself.
```

## 3. Start recense

Run `recense` in a terminal:

```sh
recense
```

If no server runs, `recense` starts one in the background and prints a one-time sign-in link:

```text
Open this link within 10 minutes: http://127.0.0.1:3636/pair#emp_...
```

Copy the whole link from that line and open it in your browser. It signs that browser in, and you see the
recense inbox, empty at first. The link works once and for 10 minutes. If it expired or you used it,
run `recense` again for a new one.

Safari and some other browsers show `http://127.0.0.1` as "not secure". That is expected: the
address never leaves your machine.

`recense` prints the link and pairing codes only to a terminal. That keeps them out of ordinary
agent output. It is not a security boundary: a process that can open a terminal can get them. Outside a
terminal, `recense` prints `recense is running at <url>. Run recense in a terminal to get a sign-in
link.` instead.

To let `recense` open your browser instead of printing the link, run this yourself:

```sh
recense config set openBrowser true
```

Then, if your system has a browser opener, `recense` opens the browser and prints
`Opening recense in your browser.` This suits a machine with a desktop that you use daily. On a
headless machine, leave it off.

The server that `recense` starts keeps running until you stop it. It does not start again at login.
Step 4 changes that.

You run this step yourself: the sign-in link is yours, and an agent does not run `recense config`.

```text prompt
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never
run recense pair, attach, detach, config or devices yourself, give me the command instead.
Tell me to run recense in my own terminal and open the sign-in link it prints. Do not run recense
yourself to get that link. If I want recense to open my browser, give me the command recense config
set openBrowser true to run myself.
```

## 4. Keep the server running (recommended on a laptop you use daily)

`recense service install` adds a user service that starts the server at every login. On Linux this
is a systemd user unit. On macOS it is a launchd agent. `recense service uninstall` removes it
(see below). The service serves `http://127.0.0.1:3636`, which only this machine reaches.
Without it, run `recense` again after every reboot or login.

```sh
recense service install
recense service status
```

```text
recense: service installed
recense: the service starts at login and serves http://127.0.0.1:3636
To sign a browser in, run recense in your own terminal.
recense: service running (<path>)
```

The last line comes from `recense service status`. The `<path>` is the service file, either the
systemd unit on Linux or the LaunchAgent plist on macOS. If you have not signed a browser in yet,
run `recense` as step 3 says.

If a server already runs, the command asks it to stop so the service can take over, and prints
`recense: stopped the recense server at <url>, so the service can take over`. This covers a server
that `recense` started and one you started with `recense serve`. A server from an older recense cannot
be asked. The command says so, and you stop it yourself: see
[troubleshooting.md](troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop).

The service starts recense with the Node.js it was installed with. After you upgrade Node.js, for
example with `brew upgrade node`, run `recense service install` again.
If `XDG_CONFIG_HOME` is absolute, the install records it in the service.
Reinstall the service after changing that variable.

On Linux:

- The unit file is `~/.config/systemd/user/recense.service`, or
  `$XDG_CONFIG_HOME/systemd/user/recense.service` when that variable is set.
- Read the log with `journalctl --user -u recense`.
- A user service stops when you log out. If the machine should keep recense running, the command
  prints `To keep recense running after you log out, run sudo loginctl enable-linger $USER.` Run that
  command yourself, once.

On macOS:

- The LaunchAgent file is `~/Library/LaunchAgents/dev.recense.server.plist`. Its label is
  `dev.recense.server`.
- The log is `~/Library/Logs/recense.log`.
- Inspect the agent with `launchctl print gui/$(id -u)/dev.recense.server`.

Remove the service with:

```sh
recense service uninstall
```

You should see `recense: service uninstalled`.

```text prompt
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; outside your sandbox run only recense service install and recense
service status, since they need the service manager, 127.0.0.1 and recense's state folder; never
pass any flag; never retry a command through another program (for example script) to get a
terminal; run no process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af
'[r]ecense.mjs serve'; macOS: pgrep -lf '[r]ecense.mjs serve').
Install the recense service: run recense service install and recense service status and show me the
output of both. If install reports a server it cannot ask to stop, ask me to run the pgrep command
for my system and to end that server, then run install again. If install prints the sudo loginctl
enable-linger line, give it to me to run. If install fails, show me the log (journalctl --user -u
recense on Linux, ~/Library/Logs/recense.log on macOS) and diagnose it with
https://github.com/shllg/recense/blob/release/docs/setup/troubleshooting.md.
Do not run recense yourself, and if I have not signed a browser in yet, tell me to run recense in
my own terminal.
```

## 5. Give your agents the skills

Your agents need the review skills. [agents.md](agents.md) covers the plugin, `recense skills install`
and the MCP server for Claude Code and Codex. Do that page now. Skip this step if you do not use
agents with recense yet.

```text prompt
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; never open ~/.claude/settings.json whole; if a dotfiles tool
manages a file or link you would change (a symlink into a dotfiles repository, stow, chezmoi,
home-manager or similar), change its source and tell me how to apply it; outside your sandbox run
only recense skills install.
Give my coding agents the recense skills: follow
https://github.com/shllg/recense/blob/release/docs/setup/agents.md and skip any agent I do not use.
```

## 6. Allow docs from other folders (optional)

`recense publish` reads a file only from the current git repository or from a folder you allowed.
To publish docs that live elsewhere, allow their folder. Run this yourself, once per folder:

```sh
recense config add docRoots <folder>
```

`recense config` lists the global configuration. `recense config remove docRoots <folder>` takes a folder back.
recense refuses the filesystem root, your home folder, any folder that holds your home folder, and
recense's own state folder. A subfolder of your home folder is fine.

```text prompt
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never
run recense pair, attach, detach, config or devices yourself, give me the command instead.
I want my agents to publish docs from folders outside their repositories. Ask me which folders,
check that each exists, and give me one recense config add docRoots command per folder, with the
path quoted for my shell. Tell me recense refuses the home folder, any folder that holds it, and its
own state folder.
```

## Check that it works

Publish a small Markdown doc from a new git repository inside your home folder:

```sh
mkdir -p ~/recense-check
cd ~/recense-check
git init
printf '# recense check\n\nIt works.\n' > hello.md
recense publish hello.md
```

`recense publish` prints a review URL such as `http://127.0.0.1:3636/r/<review-id>`. A server need
not run for this: publish works without one and saves the review. Opening the URL needs a server.
If none runs, start one with `recense` or `recense service install`, then open the URL in the browser
you signed in with. You should see the page "recense check".

Why this location: `recense publish` accepts a file inside the current git repository or inside a
folder from `docRoots`. A fresh folder under your home folder is not in either until `git init`
makes it a repository. recense refuses a repository that is your home folder, holds it, or holds
recense's state folder.

Remove the check folder when you are done:

```sh
rm -r ~/recense-check
```

## Update

See [update.md](update.md). In short: update the package, rerun `recense service install` if you
installed the service, rerun `recense skills install` if you ran it, and update the plugin.
With mise, a `postinstall` line can do the last three for you:
[update.md](update.md#let-mise-finish-the-update).

## Undo

Remove what this page set up, in this order. Skip a line for a part you did not set up.

1. The service: `recense service uninstall`.
2. A server that `recense` started without the service keeps running. Find it with
   `pgrep -af '[r]ecense.mjs serve'` on Linux or `pgrep -lf '[r]ecense.mjs serve'` on macOS and end
   the process it lists.
3. The agent parts: follow the Undo section of [agents.md](agents.md#undo).
4. The package: `npm uninstall -g @shllg/recense`, or with mise
   `mise unuse -g npm:@shllg/recense` and `mise uninstall npm:@shllg/recense`. If you added recense to
   `minimum_release_age_excludes`, remove it from that list too. Node.js, git, Homebrew and mise
   stay; remove them with the tool that installed them if you want them gone.
5. The state folder. **It holds every review, comment and hand-off on this machine, and the
   credentials for this machine's server. Deleting it cannot be undone.** Delete it only when you
   want no review back.
   - Linux: `~/.local/share/recense`, or `$XDG_DATA_HOME/recense` when that variable is set.
   - macOS: `~/Library/Application Support/recense`.
   - `RECENSE_HOME` overrides both state locations. It does not move the global config.
     Set `XDG_CONFIG_HOME` too to keep a separate config.
   - `docRoots` and `openBrowser` live in the global config file, outside the state folder.
     To clear them, run `recense config remove docRoots <folder>` and `recense config set openBrowser false`.
6. The check folder: `rm -r ~/recense-check`.

## When something goes wrong

- [mise refuses to install recense](troubleshooting.md#mise-refuses-to-install-recense)
- [recense is not running](troubleshooting.md#recense-is-not-running)
- [Port 3636 is in use](troubleshooting.md#port-3636-is-in-use)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [recense service refuses to run](troubleshooting.md#recense-service-refuses-to-run)
- [A server from an older recense cannot be asked to stop](troubleshooting.md#a-server-from-an-older-recense-cannot-be-asked-to-stop)
- [An agent's sandbox blocks recense](troubleshooting.md#an-agents-sandbox-blocks-recense)
- [docRoots refusals](troubleshooting.md#docroots-refusals)
- [Run without the service](troubleshooting.md#run-without-the-service)
