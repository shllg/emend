# Set up emend

Anyone can run their own emend, on their own machines and their own network. Pick the setups you
need. Start with one machine; add a hub, more machines and your agents when you want them. Each
setup has its own page for Linux and macOS, and each page starts with a prompt that lets Claude
Code or Codex do the setup with you.

## The setups

| Setup | Suits you if | You need | What reaches your server |
|---|---|---|---|
| [One machine](setup/local.md) | You try emend or review agent work where the agents run. | Linux or macOS, Node.js 24.18 or newer, git 2.44 or newer. | Only this machine (`127.0.0.1:3636`). |
| [Your own hub on Tailscale](setup/hub-tailscale.md) | You want to review from your phone and other devices. | An always-on machine, Tailscale on it and on every device, MagicDNS and HTTPS certificates on. | Your own devices on your tailnet, over HTTPS. |
| [Your own hub behind your own address](setup/hub-network.md) | You have your own name and HTTPS proxy and want to review from other devices. | An always-on Linux or macOS machine, a name, an HTTPS proxy and a certificate your devices trust. | Your devices on your home network or VPN, through your HTTPS proxy. |
| [Attach more machines](setup/attach.md) | You run a hub and work with agents on other machines. | A working hub and emend on each machine. | Each machine sends its reviews to your hub. |
| [Set up your agents](setup/agents.md) | You want Claude Code, Codex or others to publish and wait. | emend installed and your agent. | Nothing new; it sets up the skills and the MCP server. |
| [Develop emend from a checkout](setup/development.md) | You change emend itself or run it from a clone. | A clone, Node.js 24.18 or newer, git 2.44 or newer and pnpm. | Nothing new; it installs a build from the checkout. |
| [Update](setup/update.md) | A new version is out. | The setups you run. | The hub updates first, then its machines. |
| [Troubleshooting](setup/troubleshooting.md) | A setup or update step fails. | The error line. | Nothing. |

A hub behind your own address and HTTPS proxy is on [hub-network.md](setup/hub-network.md).

## Recommended order

1. [One machine](setup/local.md). Every other setup starts here.
2. [Set up your agents](setup/agents.md).
3. Optional: [your own hub on Tailscale](setup/hub-tailscale.md) or
   [behind your own address](setup/hub-network.md), then
   [attach](setup/attach.md) your other machines to it.
4. [Update](setup/update.md) when a new version is out. If something fails, see
   [Troubleshooting](setup/troubleshooting.md).

## The whole setup in one prompt

```text
Rules: run the steps yourself and show me what each command printed; before you change an agent's
permission or sandbox settings (for example ~/.claude/settings.json or ~/.codex/rules/), show me the
change and wait for my yes; before you change the proxy's configuration, show me the change and wait
for my yes; give me any command that needs sudo to run myself; never read secrets (tokens, .env
files, credential stores) or emend's state folder; never open ~/.claude/settings.json whole; if a
dotfiles tool manages a file or link you would change (a symlink into a dotfiles repository, stow,
chezmoi, home-manager or similar), change its source and tell me how to apply it; never run emend
pair, attach, detach, config or devices yourself, give me the command instead; never run claude
plugin commands yourself, give them to me for my own terminal; never pass --host or any flag the
pages do not name; never retry a command through another program (for example script) to get a
terminal; never list the devices on my tailnet; outside your sandbox run only emend service install
(with only the flags the pages name, including --public-url <my address>, never --host), emend
service status, emend service uninstall and emend skills install, and no other command; run no
process listing yourself, ask me to run pgrep in my own terminal (Linux: pgrep -af '[e]mend.mjs
serve'; macOS: pgrep -lf '[e]mend.mjs serve').
Set me up with emend, the review tool for agent work (https://github.com/shllg/emend). Ask me
which setups I want: one machine, my own hub on Tailscale or behind my own address, attached
machines, my agents. Then follow the page of each setup step by step, starting with
https://github.com/shllg/emend/blob/release/docs/setup/local.md. This index is
https://github.com/shllg/emend/blob/release/docs/setup.md.
```

## The pages

- [One machine](setup/local.md)
- [Your own hub on Tailscale](setup/hub-tailscale.md)
- [Your own hub behind your own address](setup/hub-network.md)
- [Attach more machines](setup/attach.md)
- [Set up your agents](setup/agents.md)
- [Develop emend from a checkout](setup/development.md)
- [Update](setup/update.md)
- [Troubleshooting](setup/troubleshooting.md)

For day-to-day use of the `emend` command, see [usage.md](usage.md).
