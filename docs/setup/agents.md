# Set up your agents for recense

Use this page if recense already runs, on this machine or as a hub you attach to, and you want
Claude Code, Codex or another coding agent to publish to it and wait for your feedback. You get
the review skills and optionally the MCP server. Every other setup page sends you here for its
agent side.

## Set it up with an agent

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me
the change and wait for my yes; never read secrets (tokens, .env files, credential stores) or
recense's state folder; never open ~/.claude/settings.json whole; if a dotfiles tool manages a file
or link you would change (a symlink into a dotfiles repository, stow, chezmoi, home-manager or
similar), change its source and tell me how to apply it; never run recense pair, attach, detach,
config or devices yourself, give me the command instead;
never run claude plugin commands yourself, give them to me for my own terminal; never pass --host or any flag this page
does not name; never retry a command through another program (for example script) to get a
terminal; never list the devices on my tailnet; outside your sandbox run only recense skills
install, and no other command; run no process listing yourself, ask me to run pgrep in my own
terminal (Linux: pgrep -af '[r]ecense.mjs serve'; macOS: pgrep -lf '[r]ecense.mjs serve').
Give my coding agents recense. Follow
https://github.com/shllg/recense/blob/release/docs/setup/agents.md step by step. Ask me which agents
I use (Claude Code, Codex, others that read ~/.agents/skills) and whether I want the MCP server and
docRoots folders. Skip the agents I do not use.
```

## What you need

- recense installed: `recense --version` prints a version. See [local.md](local.md).
- At least one agent: Claude Code, Codex, or another agent that reads `~/.agents/skills`.
- Access to that agent's settings. You review every change to them.

## What an agent can do with recense

recense's state folder holds its tokens. Any program that can read it can act as you in recense. Keep
agents you don't trust away from it; how depends on your agent.

## 1. Add the plugin to Claude Code

The plugin comes from the `release` branch of the recense repository:

```sh
claude plugin marketplace add shllg/recense@release
claude plugin install recense@recense
```

Restart Claude Code, or run `/reload-plugins` in a running session. To see the skills, run
`/plugin` and check that `recense` is listed as installed. The skills `recense-review`, `recense-publish`
and `recense-feedback` then show in the slash-command list under the `recense:` prefix.

Claude Code can update a marketplace by itself. To switch that on, open `/plugin` in Claude Code,
choose Marketplaces, choose `recense`, and turn on auto-update. Without it, update by hand as
[update.md](update.md) says.

Do not add the marketplace twice from two sources. If you work in a recense checkout, add the
checkout as the marketplace instead of `shllg/recense@release`, never both.

```text
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never
run claude plugin commands yourself.
Add the recense plugin to Claude Code: give me claude plugin marketplace add shllg/recense@release and
claude plugin install recense@recense to run in my own terminal, since they change Claude Code's own
plugin folder, which an agent sandbox blocks. Then tell me to restart Claude Code or run
/reload-plugins. Tell me how to turn on auto-update in /plugin, under Marketplaces. Skip this if I
do not use Claude Code.
```

## 2. Link the skills for Codex and other agents

Codex and other agents that read `~/.agents/skills` get the skills as symlinks:

```sh
recense skills install --dry-run
recense skills install
```

`--dry-run` prints `would link <link> -> <skill folder>` for each skill and changes nothing. The
real command prints `linked ...`, or `... already linked` when the link is right. Each link goes
into `~/.agents/skills` and points into the installed package. `--dir <path>` links into another
folder instead.

Run `recense skills install` again after every update. mise keeps each version in its own folder,
and the command moves the links to the new one. A link that points into an old folder breaks when
mise removes that folder.

recense never replaces something it did not make. It stops with `<path> exists and was not made by
recense; move it away, then run recense skills install again`.

If a dotfiles tool manages `~/.agents/skills`, the links belong in its source. Link into that
source with `--dir <path>` and apply the change as the tool says.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; if a dotfiles tool manages a file or link you would change (a
symlink into a dotfiles repository, stow, chezmoi, home-manager or similar), change its source and
tell me how to apply it; outside your sandbox run only recense skills install (and its --dry-run).
Give Codex and my other agents the recense skills: run recense skills install --dry-run and show me
the output. If ~/.agents/skills is managed by a dotfiles tool, use --dir with its source folder.
After my yes, run recense skills install. Skip this if I use only Claude Code.
```

## 3. Register the MCP server (optional)

`recense mcp` runs recense's MCP server over stdio. An agent that speaks MCP gets three tools:
`wait_for_review`, `get_feedback` and `reply`. The server does not publish: publish stays a
command. On an attached machine the server uses the hub.

**Read this closely.** An agent starts the MCP server and keeps it for the whole session. It runs
with your full rights. Register it only when `recense` on your `PATH` is an install no agent can
write, never a development checkout that agents work in. Check where `recense` lives:

```sh
command -v recense
```

A path under Homebrew (`/opt/homebrew/...`), under npm's global folder, or inside a mise install
folder is fine. A path inside a git checkout is not.

**mise warning.** With mise, the `recense` that runs can depend on the folder: a repository's
`mise.toml` or `.tool-versions` can point `recense` at another build. An MCP server started there
runs that build with your full rights. The one-time `command -v recense` check does not cover this.
For agent use, prefer an npm or Homebrew install of Node.js, or keep mise's per-project config out
of agents' reach: use mise's paranoid mode, do not trust repositories that agents can edit, or do
not activate mise in the shell your agents run in.

The skills work without the MCP server: register it only if you want the tools.

Claude Code:

```sh
claude mcp add --scope user recense -- recense mcp
```

Codex has its own command for it:

```sh
codex mcp add recense -- recense mcp
```

If you edit Codex's config by hand instead, add this to `~/.codex/config.toml`. That file can hold
tokens, so an agent must not open it: edit it yourself.

```toml
[mcp_servers.recense]
command = "recense"
args = ["mcp"]
```

Restart the agent. You should see a `recense` server in its MCP list.

```text
Rules: show me each change and wait for my yes; never read secrets (tokens, .env files, credential
stores) or recense's state folder; never open ~/.codex/config.toml or ~/.claude/settings.json; if a
dotfiles tool manages a file or link you would change (a symlink into a dotfiles repository,
stow, chezmoi, home-manager or similar), change its source and tell me how to apply it.
Register recense's MCP server (the command is recense mcp; its tools are wait_for_review,
get_feedback and reply, and it runs with my full rights for the whole session). First run
command -v recense and tell me where it lives; if it is inside a git checkout, stop. Warn me about
mise: a project's mise.toml or .tool-versions can change which recense runs. For Claude Code, show
me claude mcp add --scope user recense -- recense mcp and run it after my yes. For Codex, show me
codex mcp add recense -- recense mcp and run it after my yes. Skip this if I do not want the MCP
server.
```

## 4. Publish docs from other folders (optional)

An agent publishes a doc from outside its repository only from a folder you allowed with
`recense config add docRoots <folder>`. You run that command, once per folder.
[local.md](local.md#6-allow-docs-from-other-folders-optional) explains it and what recense refuses.

```text
Rules: never read secrets (tokens, .env files, credential stores) or recense's state folder; never
run recense pair, attach, detach, config or devices yourself, give me the command instead.
Ask me which folders outside my repositories my agents should publish docs from, check that each
exists, and give me one recense config add docRoots command per folder, with the path quoted for my
shell.
```

## Check that it works

1. In Claude Code, run `/plugin`: `recense` is listed as installed. For Codex and other agents,
   `ls -l ~/.agents/skills` shows `recense-feedback`, `recense-publish` and `recense-review` as links.
2. Ask your agent to publish a small doc with recense. It runs `recense publish <file>` and gives you
   a review URL. If the agent reports a line about its sandbox, see
   [An agent's sandbox blocks recense](troubleshooting.md#an-agents-sandbox-blocks-recense).
3. Open the URL, leave a comment, and press Send. The waiting agent receives it.

## Update

See [update.md](update.md): `recense skills install` again after each update, and the plugin
commands for Claude Code.

## Undo

Remove what you set up, and nothing else:

- The Claude Code plugin: `claude plugin uninstall recense@recense`, then
  `claude plugin marketplace remove recense`.
- The skill links: `ls -l ~/.agents/skills` shows them. Remove the links, not folders:
  `rm ~/.agents/skills/recense-feedback ~/.agents/skills/recense-publish ~/.agents/skills/recense-review`.
  If you used `--dir`, remove the three links there.
- The MCP server: `claude mcp remove recense` and `codex mcp remove recense`, or delete the
  `[mcp_servers.recense]` table from `~/.codex/config.toml` yourself.
- The `docRoots` folders: `recense config remove docRoots <folder>` for each.

## When something goes wrong

- [An agent's sandbox blocks recense](troubleshooting.md#an-agents-sandbox-blocks-recense)
- [The skills links are broken after an update](troubleshooting.md#the-skills-links-are-broken-after-an-update)
- [The plugin does not update](troubleshooting.md#the-plugin-does-not-update)
- [docRoots refusals](troubleshooting.md#docroots-refusals)
- [recense is not running](troubleshooting.md#recense-is-not-running)
