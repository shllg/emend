# Set up emend on one machine

Use this page if you want to try emend, or review agent work on the machine where you run your
agents. You get the `emend` command, a review server on `127.0.0.1:3636` that only this machine
reaches, and the review skills for your agents. Phone and hub setups come later, on their own
pages: [hub-tailscale.md](hub-tailscale.md) and [attach.md](attach.md). Both start from this page.

## Set it up with an agent

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me
the change and wait for my yes; never read secrets (tokens, .env files, credential stores) or
emend's state folder; never open ~/.claude/settings.json whole; if a dotfiles tool manages a file
or link you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or
similar), change its source and tell me how to apply it; never run emend pair, attach, detach,
config or devices yourself, give me the command instead;
never run claude plugin commands yourself, give them to me for my own terminal; never pass --host or any flag this page
does not name; never retry a command through another program (for example script) to get a
terminal; never list the devices on my tailnet; outside your sandbox run only emend service
install, emend service status, emend service uninstall and emend skills install, and no other
command; run no process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af
'[e]mend.mjs serve'; macOS: pgrep -lf '[e]mend.mjs serve').
Set me up with emend on this one machine (https://github.com/shllg/emend). Follow
https://github.com/shllg/emend/blob/release/docs/setup/local.md step by step. Ask me which
optional steps I want: the service, the agent skills, and docRoots folders. For the final check,
give me the emend publish command to run in my own terminal; run it yourself only if the command
works inside your sandbox.
```

## What you need

- Linux or macOS, and a terminal.
- Node.js 24.18 or newer and git 2.44 or newer. Step 1 installs them.
- A user account that owns the machine. Do not run emend as root.

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
says, then activate it in your shell, or neither `node` nor `emend` lands on your `PATH`. In zsh,
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

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; if a dotfiles tool manages a file or link you would change (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it.
Check that Node.js 24.18 or newer and git 2.44 or newer are installed: run node --version, git
--version and command -v git, and show me the output. If one is missing or too old: on macOS with
Homebrew (brew exists), run brew install node git; git must come from Homebrew's folder, not
/usr/bin. If brew is missing after an install, tell me to run the two lines the installer
printed. Otherwise install mise as https://mise.jdx.dev/getting-started.html says, add its
activation line for my shell (eval "$(mise activate zsh)" in ~/.zshrc, or bash in ~/.bashrc), tell
me to open a new terminal, then run mise use -g node@24. On Linux install git with the package
manager. Verify by running the version commands again in a new terminal.
```

## 2. Install emend

Install the package with the tool that installed Node.js. With Homebrew's Node.js, or any Node.js
that npm belongs to:

```sh
npm install -g @shllg/emend
```

With mise (activated in your shell, as step 1 says):

```sh
mise use -g npm:@shllg/emend
```

If `npm install -g` fails with `EACCES` on a system Node.js, do not use `sudo`. Switch to
Homebrew's Node.js or to mise (step 1), then install again.

Check it:

```sh
emend --version
```

You should see `emend ` followed by a version number. If the shell says `emend: command not found`,
open a new terminal. With mise, the command is on your `PATH` only if mise is activated in your
shell.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder.
Install emend. If Node.js came from Homebrew or another npm install, run npm install -g
@shllg/emend. If mise manages Node.js, run mise use -g npm:@shllg/emend. On an EACCES error from
npm with a system Node.js, never use sudo: tell me to switch to Homebrew's Node.js or mise. Then
run emend --version and show me the result. If emend is not found, tell me to open a new terminal.
```

## 3. Start emend

Run `emend` in a terminal:

```sh
emend
```

If no server runs, `emend` starts one in the background and prints a one-time sign-in link:

```text
Open this link within 10 minutes: http://127.0.0.1:3636/pair#emp_...
```

Copy the whole link from that line and open it in your browser. It signs that browser in, and you see the
emend inbox, empty at first. The link works once and for 10 minutes. If it expired or you used it,
run `emend` again for a new one.

Safari and some other browsers show `http://127.0.0.1` as "not secure". That is expected: the
address never leaves your machine.

`emend` prints the link and pairing codes only to a terminal. That keeps them out of ordinary
agent output. It is not a security boundary: a process that can open a terminal can get them. Outside a
terminal, `emend` prints `emend is running at <url>. Run emend in a terminal to get a sign-in
link.` instead.

To let `emend` open your browser instead of printing the link, run this yourself:

```sh
emend config set openBrowser true
```

Then, if your system has a browser opener, `emend` opens the browser and prints
`Opening emend in your browser.` This suits a machine with a desktop that you use daily. On a
headless machine, leave it off.

The server that `emend` starts keeps running until you stop it. It does not start again at login.
Step 4 changes that.

You run this step yourself: the sign-in link is yours, and an agent does not run `emend config`.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never
run emend pair, attach, detach, config or devices yourself, give me the command instead.
Tell me to run emend in my own terminal and open the sign-in link it prints. Do not run emend
yourself to get that link. If I want emend to open my browser, give me the command emend config
set openBrowser true to run myself.
```

## 4. Keep the server running (recommended on a laptop you use daily)

`emend service install` runs the server as a service that starts at login: a systemd user unit on
Linux, a launchd agent on macOS. Without it, run `emend` again after every reboot or login.

```sh
emend service install
emend service status
```

You should see `emend: service installed`, then `emend: service running (<path>)`. The `<path>` is
the service file: the systemd unit on Linux, the LaunchAgent plist on macOS.

If a server already runs, the command asks it to stop so the service can take over, and prints
`emend: stopped the emend server at <url>, so the service can take over`. This covers a server
that `emend` started and one you started with `emend serve`. A server from an older emend cannot
be asked. The command says so, and you stop it yourself: see
[troubleshooting.md](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop).

The service starts emend with the Node.js it was installed with. After you upgrade Node.js, for
example with `brew upgrade node`, run `emend service install` again.

On Linux:

- The unit file is `~/.config/systemd/user/emend.service`, or
  `$XDG_CONFIG_HOME/systemd/user/emend.service` when that variable is set.
- Read the log with `journalctl --user -u emend`.
- A user service stops when you log out. If the machine should keep emend running, the command
  prints `To keep emend running after you log out, run sudo loginctl enable-linger $USER.` Run that
  command yourself, once.

On macOS:

- The LaunchAgent file is `~/Library/LaunchAgents/dev.emend.server.plist`. Its label is
  `dev.emend.server`.
- The log is `~/Library/Logs/emend.log`.
- Inspect the agent with `launchctl print gui/$(id -u)/dev.emend.server`.

Remove the service with:

```sh
emend service uninstall
```

You should see `emend: service uninstalled`.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; outside your sandbox run only emend service install and emend
service status, since they need the service manager, 127.0.0.1 and emend's state folder; never
pass any flag; never retry a command through another program (for example script) to get a
terminal; run no process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af
'[e]mend.mjs serve'; macOS: pgrep -lf '[e]mend.mjs serve').
Install the emend service: run emend service install and emend service status and show me the
output of both. If install reports a server it cannot ask to stop, ask me to run the pgrep command
for my system and to end that server, then run install again. If install prints the sudo loginctl
enable-linger line, give it to me to run. If install fails, show me the log (journalctl --user -u
emend on Linux, ~/Library/Logs/emend.log on macOS) and diagnose it with
https://github.com/shllg/emend/blob/release/docs/setup/troubleshooting.md.
```

## 5. Give your agents the skills

Your agents need the review skills. [agents.md](agents.md) covers the plugin, `emend skills install`
and the MCP server for Claude Code and Codex. Do that page now. Skip this step if you do not use
agents with emend yet.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or emend's state folder; never open ~/.claude/settings.json whole; if a dotfiles tool
manages a file or link you would change (a symlink into a dotfiles repository, stow, chezmoi,
home-manager or similar), change its source and tell me how to apply it; outside your sandbox run
only emend skills install.
Give my coding agents the emend skills: follow
https://github.com/shllg/emend/blob/release/docs/setup/agents.md and skip any agent I do not use.
```

## 6. Allow docs from other folders (optional)

`emend publish` reads a file only from the current git repository or from a folder you allowed.
To publish docs that live elsewhere, allow their folder. Run this yourself, once per folder:

```sh
emend config add docRoots <folder>
```

`emend config` lists the global configuration. `emend config remove docRoots <folder>` takes a folder back.
emend refuses the filesystem root, your home folder, any folder that holds your home folder, and
emend's own state folder. A subfolder of your home folder is fine.

```text
Rules: never read secrets (tokens, .env files, credential stores) or emend's state folder; never
run emend pair, attach, detach, config or devices yourself, give me the command instead.
I want my agents to publish docs from folders outside their repositories. Ask me which folders,
check that each exists, and give me one emend config add docRoots command per folder, with the
path quoted for my shell. Tell me emend refuses the home folder, any folder that holds it, and its
own state folder.
```

## Check that it works

Publish a small Markdown doc from a new git repository inside your home folder:

```sh
mkdir -p ~/emend-check
cd ~/emend-check
git init
printf '# emend check\n\nIt works.\n' > hello.md
emend publish hello.md
```

`emend publish` prints a review URL such as `http://127.0.0.1:3636/r/<review-id>`. A server need
not run for this: publish works without one and saves the review. Opening the URL needs a server.
If none runs, start one with `emend` or `emend service install`, then open the URL in the browser
you signed in with. You should see the page "emend check".

Why this location: `emend publish` accepts a file inside the current git repository or inside a
folder from `docRoots`. A fresh folder under your home folder is not in either until `git init`
makes it a repository. emend refuses a repository that is your home folder, holds it, or holds
emend's state folder.

Remove the check folder when you are done:

```sh
rm -r ~/emend-check
```

## Update

See [update.md](update.md). In short: update the package, rerun `emend service install` if you
installed the service, rerun `emend skills install` if you ran it, and update the plugin.

## Undo

Remove what this page set up, in this order. Skip a line for a part you did not set up.

1. The service: `emend service uninstall`.
2. A server that `emend` started without the service keeps running. Find it with
   `pgrep -af '[e]mend.mjs serve'` on Linux or `pgrep -lf '[e]mend.mjs serve'` on macOS and end
   the process it lists.
3. The agent parts: follow the Undo section of [agents.md](agents.md#undo).
4. The package: `npm uninstall -g @shllg/emend`, or with mise
   `mise unuse -g npm:@shllg/emend` and `mise uninstall npm:@shllg/emend`. Node.js, git, Homebrew
   and mise stay; remove them with the tool that installed them if you want them gone.
5. The state folder. **It holds every review, comment and hand-off on this machine, and the
   credentials for this machine's server. Deleting it cannot be undone.** Delete it only when you
   want no review back.
   - Linux: `~/.local/share/emend`, or `$XDG_DATA_HOME/emend` when that variable is set.
   - macOS: `~/Library/Application Support/emend`.
   - `EMEND_HOME` overrides both when it is set.
   - `docRoots` and `openBrowser` live in the global config file, outside the state folder.
     To clear them, run `emend config remove docRoots <folder>` and `emend config set openBrowser false`.
6. The check folder: `rm -r ~/emend-check`.

## When something goes wrong

- [emend is not running](troubleshooting.md#emend-is-not-running)
- [Port 3636 is in use](troubleshooting.md#port-3636-is-in-use)
- [The service does not start](troubleshooting.md#the-service-does-not-start)
- [emend service refuses to run](troubleshooting.md#emend-service-refuses-to-run)
- [A server from an older emend cannot be asked to stop](troubleshooting.md#a-server-from-an-older-emend-cannot-be-asked-to-stop)
- [An agent's sandbox blocks emend](troubleshooting.md#an-agents-sandbox-blocks-emend)
- [docRoots refusals](troubleshooting.md#docroots-refusals)
- [Run without the service](troubleshooting.md#run-without-the-service)
