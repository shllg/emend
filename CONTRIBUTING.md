# Contributing to recense

Thank you for helping. recense is small and maintained by one person, so the path below keeps
things simple for both of us.

## Report a bug or suggest a change

Open an issue. Say what you saw or want, why it matters to you, and how to reproduce a bug: your
recense version (`recense --version`), your OS and the steps. Screenshots help. Do not paste private
code, tokens or anything from a client project: issues are public.

For a security problem, do not open an issue: [SECURITY.md](SECURITY.md) says how to report it
privately.

A maintainer reads the issue, may ask questions, and labels it with a kind and a priority.

## Send a pull request

1. Start from an issue. If there is none, open one first, so we can agree on the change before you
   spend time on it.
2. Fork the repository and work on any branch of your fork. No task files, plan numbers or special
   branch names are needed: the issue is the brief.
3. Read [AGENTS.md](AGENTS.md), especially the non-negotiables. They apply to people and agents
   alike: no personal paths, private host names or secrets in the repository; the server binds
   loopback; no agent-written HTML on the app origin; contract first for API changes.
4. Set up as [docs/setup/development.md](docs/setup/development.md) says, and run `pnpm verify`
   before you open the pull request.
5. Put `Closes #<issue>` first in the pull request body, then fill in the template.
6. Leave `.github/` alone unless the issue is about CI.

## What happens next

- CI runs on your pull request after a maintainer approves it. That is GitHub's rule for pull
  requests from forks.
- A maintainer reviews the change in recense, and any comments come back as a review on your pull
  request. Push to the same branch to answer them.
- When it is ready, the maintainer squash-merges it. GitHub keeps you as the author.

Small fixes the maintainer prefers to make after the merge become follow-up issues, so you are not
asked to polish every detail.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
