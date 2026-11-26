<div align="center">

<a href="https://recense.dev/"><img src="https://raw.githubusercontent.com/shllg/recense/main/assets/logo.svg" alt="recense" width="80" height="80"></a>

# recense

**Review what your agents wrote.**

[![CI](https://github.com/shllg/recense/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shllg/recense/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@shllg/recense?color=f5af2e)](https://www.npmjs.com/package/@shllg/recense)
[![node](https://img.shields.io/node/v/@shllg/recense)](https://github.com/shllg/recense/blob/release/docs/setup/local.md#1-install-nodejs-and-git)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/shllg/recense/blob/main/LICENSE)
![platform: Linux | macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey)

**[Website](https://recense.dev/)** · [Install](https://recense.dev/#install) ·
[Docs](https://github.com/shllg/recense/blob/release/docs/setup.md) ·
[Vision](https://github.com/shllg/recense/blob/main/VISION.md) ·
[Changelog](https://github.com/shllg/recense/releases)

</div>

Open-source, local-first review for work done by coding agents: plans, docs and code. Read the
agent's writeup next to its diff, comment on any of it, press Send, and the waiting agent gets your
feedback. recense starts on your machine with one command. Machines can attach to a hub, so that you
review from any device, your phone included.

<p>
  <img src="https://raw.githubusercontent.com/shllg/recense/main/docs/images/review-desktop.png" alt="A recense review on a desktop: the agent's writeup and topics next to the diff, with a reviewer comment and the agent's reply" width="73%"
  >&emsp;<img src="https://raw.githubusercontent.com/shllg/recense/main/docs/images/review-phone.png" alt="The same review on a phone" width="21%">
</p>

## Requirements

Linux or macOS, Node.js 24.18 or newer and git 2.44 or newer.

## Quick start (one machine)

On macOS, install Node.js and git from Homebrew first:

```sh
brew install node git
```

If `node --version` is older than 24.18 or `git --version` older than 2.44, as on many Linux
distributions and with Apple's git on macOS, follow step 1 of
[local.md](https://github.com/shllg/recense/blob/release/docs/setup/local.md#1-install-nodejs-and-git)
first.

The full walkthrough, with a prompt that lets Claude Code or Codex do it with you, is
[docs/setup/local.md](https://github.com/shllg/recense/blob/release/docs/setup/local.md).

Install recense and add its skills:

```sh
npm install -g @shllg/recense
recense --version
claude plugin marketplace add shllg/recense@release
claude plugin install recense@recense
recense skills install
```

With mise activated in your shell, install with
`mise use -g 'npm:@shllg/recense[allow_low_downloads=true]'` instead of the `npm` line, from any
folder; [local.md](https://github.com/shllg/recense/blob/release/docs/setup/local.md#2-install-recense)
says why it needs `-g` and `allow_low_downloads`.

The two `claude plugin` lines add the skills to Claude Code, and
`recense skills install` adds them for Codex and other agents that read `~/.agents/skills`.

We recommend `recense service install`. It adds a user service that starts the recense server at
every login. On Linux this is a systemd user unit. On macOS it is a launchd agent.
`recense service uninstall` removes it. The server listens on `http://127.0.0.1:3636`, and only
this machine reaches it.

```sh
recense service install
```

Run `recense` in a terminal. Open the one-time link it prints within 10 minutes to sign your
browser in.

```sh
recense
```

To review from a phone or another device, set up a hub first
([your own hub on Tailscale](https://github.com/shllg/recense/blob/release/docs/setup/hub-tailscale.md)),
then pair each device with `recense pair`.

## Pick your setup

Each setup has its own page for Linux and macOS, with a copy-paste prompt for your agent.
[docs/setup.md](https://github.com/shllg/recense/blob/release/docs/setup.md) is the index, with the
one-prompt setup.

| Setup | Suits you if |
|---|---|
| [One machine](https://github.com/shllg/recense/blob/release/docs/setup/local.md) | You try recense or review agent work on the machine where the agents run. |
| [Your own hub on Tailscale](https://github.com/shllg/recense/blob/release/docs/setup/hub-tailscale.md) | You have an always-on machine and want to review from your phone and other devices. |
| [Attach more machines](https://github.com/shllg/recense/blob/release/docs/setup/attach.md) | You run a hub and want the agents on your other machines to publish to it. |
| [Set up your agents](https://github.com/shllg/recense/blob/release/docs/setup/agents.md) | recense runs and you want Claude Code, Codex or others to use it. |
| [Develop recense from a checkout](https://github.com/shllg/recense/blob/release/docs/setup/development.md) | You change recense itself or run it from a clone. |
| [Update](https://github.com/shllg/recense/blob/release/docs/setup/update.md) | A new version is out. |
| [Troubleshooting](https://github.com/shllg/recense/blob/release/docs/setup/troubleshooting.md) | A setup or update step fails. |
| [Your own hub behind your own address](https://github.com/shllg/recense/blob/release/docs/setup/hub-network.md) | You have your own name and HTTPS proxy and want to review from other devices. |

## Update

```sh
recense update
claude plugin marketplace update recense
claude plugin update recense@recense
```

`recense update` backs up the database, updates recense with mise, npm or pnpm, and restarts the
service. It runs only in your own terminal. A local build only gets the commands.

To update by hand, run `npm install -g @shllg/recense@latest`, or with mise, from your home folder,
`mise upgrade npm:@shllg/recense`. Either one replaces only the package. If you installed the
service, run `recense service install` again; it keeps its options. Without the service, run
`recense stop`; the next `recense` starts the new version. If you ran `recense skills install`
before, run it again. Then restart Claude Code. After `brew upgrade node` or `mise upgrade node`,
run `recense service install` again too.
With mise, a `postinstall` line in its config can reinstall the service, link the
skills again and update the plugin each time mise installs a new recense:
[update.md](https://github.com/shllg/recense/blob/release/docs/setup/update.md#let-mise-finish-the-update).

[docs/setup/update.md](https://github.com/shllg/recense/blob/release/docs/setup/update.md) covers the
order for a hub and its machines, Node.js upgrades and the phone app.

## Uninstall

Remove what a setup added with its Undo section: [one machine](https://github.com/shllg/recense/blob/release/docs/setup/local.md#undo)
and [your agents](https://github.com/shllg/recense/blob/release/docs/setup/agents.md#undo). The Undo
sections of the hub and attach pages cover those setups.

## Usage

[docs/usage.md](https://github.com/shllg/recense/blob/release/docs/usage.md) covers `recense config`,
publishing docs for review and [themes](https://github.com/shllg/recense/blob/release/docs/usage.md#themes),
with an example prompt that has your coding agent make one. It also shows how to
[put the review in Claude Code's status line](https://github.com/shllg/recense/blob/release/docs/usage.md#show-the-review-in-claude-codes-status-line).

## Development

[Develop recense from a checkout](https://github.com/shllg/recense/blob/release/docs/setup/development.md)
covers installing from a checkout, the plugin from a checkout and the checks.
[AGENTS.md](https://github.com/shllg/recense/blob/main/AGENTS.md) holds the working rules.
Maintainers: [docs/releasing.md](https://github.com/shllg/recense/blob/main/docs/releasing.md) holds
the release policy and checklist.

## About

[VISION.md](https://github.com/shllg/recense/blob/main/VISION.md) says what recense is for, and what it
is not.

recense grew out of [hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill), which stays
maintained alongside it.

## License

MIT. See [LICENSE](https://github.com/shllg/recense/blob/main/LICENSE).
