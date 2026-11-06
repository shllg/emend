---
id: 013
title: Release emend and document every setup
status: open
owner: agent + your approval
depends_on: [005]
done_on:
---

# 013 — Release emend and document every setup

Plan slice 6 (tasks 6.1 to 6.3). You asked on 2026-11-04 for a real release and clean setup docs,
with an agent prompt for each part. Anyone installs and runs their own emend and sets it up as they
like: local only, their own hub over Tailscale, their own hub on their own network, more machines
attached to their hub, or all of them. The first outside user starts on 2026-11-05, on macOS.

6.1 and 6.2 come first, before that user starts. 6.3 follows, R.3 first. One commit per step.

## Steps

6.1 Release pipeline:

- [x] R.1: `apps/emend/package.json`, `apps/emend/src/version.ts` and `plugin.json` carry the
      same version. `version.test.ts` fails when `version.ts` differs, and `check:package` fails
      when `plugin.json` differs. `pnpm release` writes all three; nobody edits them by hand.
      Superseded by R.3.
- [x] R.2: `pnpm release <x.y.z>` bumps the versions, drafts `CHANGELOG.md` from the commits since
      the last tag, runs the gate and writes the commit message. It never commits, tags, pushes or
      publishes. `docs/releasing.md` holds the policy and your checklist. Superseded by R.3.
- [x] R.4: the docs install the Claude Code plugin from `shllg/emend@release`.
- [x] You: publish 0.1.0 to npm, then push `main`, the tag and `release` (done 2026-11-05).

6.2 Setup docs:

- [x] D.1: the README becomes a landing page with absolute links; usage moves to `docs/usage.md`.
- [x] D.2: `docs/setup.md` keeps its URL and becomes the index with the one-prompt setup.
- [x] D.3 to D.8: `docs/setup/local.md`, `hub-tailscale.md`, `attach.md`, `agents.md`,
      `update.md` and `troubleshooting.md`, each for Linux and macOS.
- [x] D.9: one prompt per page and one per step, for Claude Code and Codex.
- [x] D.10: dry run of the packed tarball with a fresh `EMEND_HOME`, following `local.md`.

6.3 Smooth updates and any network:

- [x] R.3: `.github/workflows/release.yml` releases nightly at 02:00 UTC and on a manual trigger,
      only when shipped changes landed since the last `v*` tag. It picks patch or minor from the
      commit types, runs `pnpm verify`, packs, publishes through npm trusted publishing with
      provenance, tags the released `main` commit, moves `release` and creates a GitHub Release.
      Nothing is committed back. `plugin.json` drops its version, so the plugin follows commits.
      `pnpm release` and `release-pack` go away; `install:local` stamps the newest tag's version.
- [x] You: create the GitHub environment `npm` and the rulesets for `release` and `v*`, then the
      npm trusted publisher with direct `npm publish` allowed, then set the repository variable
      `RELEASE_ENABLED` (docs/releasing.md, "One-time setup"). Then run the workflow with
      `dry_run`, then for real (done 2026-11-05: 0.2.0 released from GitHub Actions, and npm
      publishing now requires 2FA and disallows tokens).
- [ ] N.1: `emend serve --public-url <origin>` for a hub behind your own address;
      `docs/setup/hub-network.md`.
- [x] S.1: `emend` and `emend service status` say when the running server is another version.
- [x] S.2: `emend stop`.
- [x] S.3: `publish`, `wait`, `feedback`, `reply` and `mcp` refuse an `emend` that resolves inside
      the current repository, as `emend service install` already does. Under mise, a repo's own
      tool config can point `emend` at its code, and agents run these commands with full rights.
- [x] S.4: emend remembers the Tailscale Serve route it created, so a route left by a crash is
      still removed on the next stop (open owner item 31).

## Done when

0.1.0 is on npm, a reader with a new Linux or macOS machine reaches a working setup from the
README alone, every setup has its page with prompts, and the 6.3 steps have landed and passed
their reviews.

## Notes

- 2026-11-05: For R.3, you chose fully automatic publishing. The security review flagged that a
  push to `main` now reaches npm by the next nightly with no 2FA step. You turned down npm's
  staged publishing (approve each version with 2FA) and a GitHub approval gate. The approval gate
  would not stop an agent anyway, because `gh` on your machine is signed in as you. The
  workflow does nothing until `RELEASE_ENABLED` is set, so the first nightly cannot tag before the
  setup is done. A tag that reached npm but not `release` is finished by the next run. A tag that
  never reached npm is published only from a run at its own commit, since npm provenance names the
  run's commit. No run publishes or tags a commit behind `release`. A deny rule for
  `gh workflow run` was dropped: a manual run ships only what the nightly would ship.
- 2026-11-05: You asked to release from GitHub Actions instead of your terminal: nightly when
  changes landed, plus a manual trigger. You accepted that a nightly may ship half-finished work
  pushed to sync your machines. Release tags are no longer signed by your key; trust rests on npm
  provenance, on only you pushing `main`, and on the ruleset. A checkout version with build
  metadata (`0.3.0+4.g…`) was dropped: the server accepts only a plain `x.y.z` client version.
- 2026-11-05: For plan task 6.2, you chose to leave sandbox setup to each agent's own
  documentation. The setup docs drop the sandbox and deny rules, and say that any program that can
  read emend's state folder can act as you. Developing from a checkout moves from the README to
  `docs/setup/development.md`.
- 2026-11-04: Opened from your request. You chose the `release` branch for the plugin and open
  networking. 014 stays with plan task 5.1.
- 2026-11-04: Codex was not reachable (no `codex` MCP server), so Sonnet sub-agents built and a
  second Sonnet reviewer stood in for the Codex review. The security reviews added S.3 and S.4,
  and moved the publish step to a fresh clone of the pushed tag.
- 2026-11-04: R.1 first injected the version at build time (`__EMEND_VERSION__`). The gate failed:
  three test files load `apps/emend/src` through plain Node or their own esbuild call, where that
  global does not exist. R.1 now keeps the literal in `version.ts`, and `pnpm release` writes it.
  R.1 lands in R.2's commit, since both change `scripts/check-package.ts`.
