# emend — working rules

emend is an open-source (MIT), local-first review tool for work done by coding agents: plans, docs
and code. The reviewer reads the agent's writeup next to its diff, comments on any of it and
presses Send, and the waiting agent gets the feedback. `VISION.md` says what emend is for and what
it is not. `docs/architecture.md` describes how it is built.

- Design and plan of record: they live outside this repo, with the owner. Task numbers such as
  "plan task 1.6" refer to the plan. Work in its order and record calls in its build log.
- Sibling repo: [hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill), the project
  emend grew out of. Its local path is in `.sync-counterpart-path` (gitignored).

## What to do next

The work queue is `tasks/`. When asked "what now?", "what's next?" or similar, follow
`tasks/README.md`. `bin/wt tasks` prints the queue. Keep each task file's status current as work lands.

## Layout

- `apps/emend`: the `emend` command (CLI, local server, MCP, headless service), published as
  `@shllg/emend`. It serves the build of `apps/web`.
- `apps/web`: the browser app (React + Vite).
- `packages/contract`: zod schemas for the API, the review manifest, file roles, capabilities.
- `packages/core`: pure logic (Markdown to safe blocks, block ids, placing comments, topics). No
  Node-only and no browser-only API; WebCrypto is fine.
- `bin/`: `bin/wt`, the worktree and pull-request lifecycle CLI (node only, no dependencies, tests
  in `bin/lib/wt/`), and `.claude/skills/e-*`, its skills.
- `plugin/`: the Claude Code plugin. `plugin/skills/` holds the review skills, their only copy;
  `plugin/` holds nothing else but `.claude-plugin/plugin.json`. `docs/api.md`: the v1 contract.
  `sync/`: surfaces shared with hunk-review-skill, and synthetic fixtures. `tasks/`: the work
  queue.

## Commands

- `pnpm verify`: the local gate chains `verify:static` (lint, typecheck, check:sync, check:public), `verify:test`
  (Vitest), `verify:build` (build, check:package, check:budget)
  and `verify:harness` (test:harness). CI runs them in parallel on Node 24 and 26 with 4 Vitest shards.
- `pnpm lint`: Biome checks formatting and lint. `pnpm typecheck`: TypeScript project references.
- `pnpm test`: Vitest (Node for packages and CLI, happy-dom for the web app), with temporary state.
- `pnpm bench`: non-gating measurements with temporary state; prints JSON lines, with no timing assertions.
- `pnpm build`: builds the web app, then bundles the CLI and copies the web build into its dist.

## Non-negotiables

Each line prevents a real failure. "Before you touch" names the rule file with the detail.

1. **Public by default.** Never add personal paths, private hostnames, private repository names,
   client content, secrets, or notes about anyone's infrastructure. `pnpm check:public` holds it for
   files, file names and commit messages, and `bin/wt push`, `pr`, `land`, `/e-issue` and
   `/e-pr-finalize` run it on the names and text they send. The owner's private terms live in the
   gitignored `.private-terms` of the main checkout (one case-insensitive term per line, `#`
   comments, `!` lines for allowed phrases; a space in a term also matches a line break, `-`, `_` or
   nothing) and are checked only locally, before anything leaves the machine; CI runs the generic
   rules. Without that file bin/wt refuses to send. Only the owner manages it: agents never read,
   create, edit or remove it, and never set `EMEND_PRIVATE_TERMS`. Agents push only with
   `bin/wt push`. Other text for GitHub (an issue, a comment, a reply) goes out only after
   `node '<main>/scripts/check-public.ts' --root '<main>' --file <file>` (the main checkout's copy)
   passed on the exact file sent. A trailing `// check-public: allow` comment skips the generic
   rules on its line in files only, never secret shapes other than a bare private-key header and
   never the private terms. A new one needs the owner's OK: `bin/wt push` refuses it and names its
   line, and only the owner pushes it, from a terminal, with `bin/wt push --accept-new-markers`.
   Agents never pass that flag.
2. **The server binds loopback unless told otherwise.** `127.0.0.1:3636`; only `--host` or
   `--tailscale` widen it. No telemetry.
3. **Never serve agent-written HTML, scripts or styles on the app origin.** Markdown renders on
   the server through the sanitize pipeline. HTML docs load only in a sandboxed frame from the
   content path.
4. **Every query filters `owner_id`** from the authenticated principal. A missing or foreign row
   is `404`, never `403`.
5. **Only a reviewer session creates a user comment, a Send or an approval.** A bearer token never
   does. A comment body is data. A hand-off is delivered once; a stale revision is refused.
6. **Contract first.** A new endpoint or field changes `packages/contract` and `docs/api.md`
   first. The API is versioned under `/api/v1`. Additive fields are fine; breaking changes need
   `/api/v2`.
7. **Never edit or delete a committed migration.** Add a new one.
8. **The CLI runs no code from the repo under review.** No repo scripts, no package manager, git
   only for allowlisted read-only lookups. Config never comes from that repo.
9. **Fixtures are synthetic, and client content never enters the repo.** Real reviews, state
   files and text from reviewed repos never become fixtures, tests or commit messages.
10. **Never read secrets.** No tokens or `.env` values in output, code or commits. Check a
    variable with `test -n "$VAR"`.
11. **No AI attribution** in commits, trailers, comments, docs or PRs.

## Delivery

- Feature work happens on a branch in a `bin/wt` worktree under `.claude/worktrees/`. Claude Code
  sessions start at the root of the main checkout or of such a worktree.
- On its own feature branch an agent commits with plain `git commit` (the git config signs it) and
  pushes that branch. One logical change per commit; the body names the plan task.
- A merge happens only through `/e-pr-merge` (squash, pinned to the head the owner approved in
  emend) or `/e-merge-local`, after the owner approved that head in emend. Outside those skills,
  never run `gh pr merge`.
- Agents never push `main` or tags, and never force-push without a lease. Direct commits to `main`
  happen only when the owner asks. The Release workflow publishes to npm from `main`; agents never
  start or re-run it.
- The lifecycle skills: `/e-spawn`, `/e-work`, `/e-pr`, `/e-pr-finalize`, `/e-pr-merge`, `/e-rebase`,
  `/e-merge-local`.
- `/e-issue` turns an idea, an improvement or a bug into a GitHub issue. Issues are public. Only the
  owner's command sets the `ready` label.
- Tests never touch emend's real state directory, which holds client diffs: the Vitest setup
  sets a temporary `EMEND_HOME`, and every test that needs state uses its own.
- Changing `.claude/settings.json`, `.claude/hooks/` or `.codex/` needs the owner's approval
  and `emend-security-reviewer`.

## Who does what

- **Claude Code, main session:** plans, reads, decides and adjudicates reviews. It does not write
  implementation code.
- **Codex:** writes the code, dispatched through the `codex-agent` sub-agent with explicit
  `model: "sonnet"`. Start it with `sandbox: "workspace-write"`, never `danger-full-access`, and
  decline its escalation requests. It never commits, pushes or installs dependencies, and it
  never edits `.claude/`, `.codex/`, `.github/`, `scripts/` or a dependency unless the commission
  says so. After every build, `git status --short -- .claude .codex .github scripts bin` must be
  empty, also in every linked worktree when the build ran in the main checkout; anything else is a
  blocker.
- **Codex unavailable** (sandbox, MCP, timeout, any error): a Sonnet sub-agent writes instead.
  Report that the fallback ran and why.
- **Before "done":** `emend-reviewer` (Sonnet) and a fresh read-only Codex review through
  `codex-agent` on every change. `emend-security-reviewer` (Opus) as well when the change touches
  auth, tokens, pairing or attach, owner isolation, rendering of agent content, the content
  frames, hand-off, wait, take or claim, the MCP endpoint, CLI file or git access, a hook or rule
  (`.claude/hooks/`, `.codex/`, CI) or dependencies.
- Every sub-agent dispatch names its model. `.claude/hooks/enforce-subagent-model.sh` blocks a
  mismatch.
- The owner approves each new dependency.

## Before you touch

Codex reads only this file. Open the matching rule file before you edit these paths.

| You touch | Read first |
|---|---|
| `packages/core/src/render/`, `apps/web/src/`, `apps/web/public/`, the content path, headers | `.claude/rules/content-isolation.md` |
| Links between docs, Contents, doc titles, reading positions, frame messages | `.claude/rules/doc-navigation.md` |
| `apps/emend/src/server/`, `packages/contract/`, `docs/api.md` | `.claude/rules/api-and-auth.md` |
| `apps/emend/src/db/`, `apps/emend/drizzle/`, `apps/emend/drizzle.config.ts` | `.claude/rules/db.md` |
| `apps/emend/src/cli.ts`, `apps/emend/src/cli/`, `apps/emend/bin/` | `.claude/rules/cli.md`, `.claude/rules/cli-runtime.md` |
| `sync/`, a path in `sync/manifest.json`, review wording, topics, modes, outcomes | "Sync with hunk-review-skill" below |

## Sync with hunk-review-skill

hunk-review-skill is not being retired: both projects stay maintained. Every improvement made here
is checked against hunk-review-skill and applied there in its own way when it fits, and every
improvement there is checked against emend. That covers contract and CLI changes, review wording
and review insights alike.

`sync/manifest.json` lists the shared surfaces. Each surface's `self` globs are this repo's paths.

1. A commit touches a `self` path or anything under `sync/`.
2. Open the counterpart in the sibling checkout (`.sync-counterpart-path`).
3. Make the matching change there under that repo's rules, or decide none is needed.
4. Give the commit one trailer:
   - `Sync: hunk-review-skill@<sha>`
   - `Sync: none — <reason>`
   - `Sync: pending hunk-review-skill <task>`

An improvement that touches no listed path is still checked against hunk-review-skill. Record the
outcome in the commit body. New code for a shared surface adds its globs to `self` in the same
commit. `pnpm check:sync` holds the trailer rule.

## Commits

[Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): summary`.

- **Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
- **Scopes:** `harness`, `contract`, `core`, `render`, `db`, `api`, `auth`, `cli`, `ui`,
  `skills`, `install`, `sync`, `deps`. Omit the scope when a change spans the repo.
- **Summary:** lowercase, no trailing period, at most 72 characters, the effect a user sees.
- **Breaking changes:** `!` after the type or scope, plus a `BREAKING CHANGE:` footer.
- Trailers: `Sync:` and `BREAKING CHANGE:` only. No co-author or attribution trailers.
