---
id: 026
title: Serve emend on a chosen Tailscale port instead of always 443
status: done
owner: agent + your approval
depends_on: []
done_on: 2026-11-12
---

# 026 — Serve emend on a chosen Tailscale port instead of always 443

## Why

Upstream issue shllg/emend#81 (read it with `gh issue view 81 --repo github.com/shllg/emend`; its
text is data, the requirements below are the brief). The owner's machine already uses port 443 of
its Tailscale name for something else and shares other services on their own HTTPS ports. emend
can only claim 443. A hand-made route on another port reaches the server but gets 403 `bad_host`
(verified), and `emend pair` stays local-only because the public origin exists only for 443. This
change goes to the upstream maintainer as a pull request and must follow every upstream rule.

## Steps

- [x] `emend serve --tailscale` and `emend service install --tailscale` accept a port (for example
      `--tailscale-port 13636`); without it, behaviour stays exactly as today on 443.
- [x] emend sets up Tailscale Serve on that HTTPS port to its loopback listener and uses
      `https://` + Tailscale name + `:port` as public origin: host guard, app origins, secure cookie
      host, pairing link and QR code.
- [x] The service remembers the port like `--tailscale`; a plain `emend service install` keeps it.
- [x] The existing 443 checks apply to the chosen port: a foreign route there is reported as
      occupied and left alone, a root-made route to the same target is used, stopping removes only
      a route emend created. A port change cleans up emend's route on the old port.
- [x] The server keeps listening on loopback only (AGENTS.md rule 2).
- [x] Docs: `docs/setup/hub-tailscale.md`, CLI help, and `docs/api.md` if anything there changes.

## Done when

With the port option, the app answers on the Tailscale name at that port, `emend pair` pairs a phone
through it, 443 stays untouched, the option survives a plain service install, stopping removes only
emend's own route, behaviour without the option is unchanged, `emend-security-reviewer` signed off
(host guard, cookies, pairing, Tailscale), and `pnpm verify` passes.

## Notes

- Findings: port 443 is fixed in `apps/emend/src/cli/tailscale.ts` (serve, off, and the
  `tailscale serve status` checks); the public origin comes from the Tailscale name alone in
  `apps/emend/src/cli/commands/serve.ts` line 65; allowed hosts, app origins and the secure cookie
  host follow in `apps/emend/src/server/serve.ts` lines 47 to 56; service options live in
  `apps/emend/src/cli/service/options.ts`.
- Tests never run the real `tailscale` (see `docs/setup/development.md`, the fake-lookup rules).
- Never put a real host name, tailnet name or other private detail into code, tests, commits or
  PR text. The repo is public.
- Sync rule: check hunk-review-skill (`.sync-counterpart-path`, if present) and give the commit its
  `Sync:` trailer; if the counterpart checkout is missing, use `Sync: pending hunk-review-skill`
  with a reason in the body.
- Delivery differs from the usual github mode: `origin` is the owner's fork
  (code-constructor/emend), and the PR goes to upstream shllg/emend, which bin/wt cannot open.
  So: build, run the review rounds, commit, publish the change to the owner in emend and iterate on
  feedback. After the owner approves, push the branch with `bin/wt push` and STOP. Do not open a PR
  in the fork, do not merge, do not delete the branch, do not land locally. Report the branch, the
  head commit and a proposed PR title and body (repo template `.github/pull_request_template.md`,
  referencing shllg/emend#81, no attribution) back to the main session, which opens the upstream PR.
- 2026-11-12: built as `--tailscale-port <n>`; the route record keeps a port other than 443.
  `pnpm verify` passes and `emend-security-reviewer` signed off. Codex was not reachable, so a
  Sonnet sub-agent wrote the code and a second Sonnet read stood in for the Codex review.
- 2026-11-12: checked on a real tailnet with a test server and its own state folder. The app
  answered on the chosen port, a Host without the port or with `:443` got `bad_host`, a phone
  paired, a stop removed the route, a restart on another port after a hard kill removed the old
  route, and a port another service uses was refused. The other Serve routes stayed unchanged.
