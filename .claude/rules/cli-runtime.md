---
paths:
  - "apps/emend/src/cli.ts"
  - "apps/emend/src/cli/**"
  - "apps/emend/bin/**"
---

# Where the emend CLI and its helpers run from

A repo under review may try to run its own code through emend: under mise, its tool config can
point `emend`, `node` or `git` at code it controls, and agents run emend with full rights. These
checks catch a copy inside the repo.

- `publish`, `wait`, `feedback`, `reply`, `mcp`, `stop`, `service` and `skills` refuse an emend
  whose Node.js or entry resolves inside a repository that holds the working directory
  (`apps/emend/src/cli.ts`, `runtime-repository.ts`). The refusal comes before `main.ts` loads.
- A `.git` folder counts unless it has no `HEAD` (git never accepts one without), so an empty one
  such as a sandbox mount point does not, and one whose `HEAD` cannot be checked does. A `.git`
  file counts when it is one `gitdir:` line; any other `.git` file, a symlinked `.git` or an
  unreadable entry refuses.
- Only a repository whose root is the home folder itself (a dotfiles repository) does not count.
  When the home folder is relative or missing, every repository counts; when it cannot be
  resolved otherwise, emend refuses.
- The config file (`config.json` in `$XDG_CONFIG_HOME/emend/` when that variable is absolute,
  else `~/.config/emend/`) and the old one in the state folder get the same check
  (`configRepository` in `cli/config.ts`). When the path, its real path or any symlink hop on the
  way, walked one hop at a time (at most 40), lies inside such a repository, `publish` and `open`
  ignore the file, never copying or renaming it, and `emend config` refuses. Keep the hop walk: a
  link inside the repository could point the file at one the repository writes, whose `docRoots`
  would let `publish` read a folder such as `~/.ssh`. The server reads only `approvedActiveHours`
  from that file, a bounded integer, without this check.
- Every helper program (git, systemctl, launchctl, tailscale, the browser opener) comes from
  `findExecutable` (`executable.ts`): absolute `PATH` entries without `.` or `..` parts, where no
  part of the entry's path or of the program's path, link targets included, lies inside such a
  repository. The helper runs with only those entries on its `PATH`, minus any entry where a file
  of that name exists but leads into such a repository or cannot be checked. On macOS, tailscale
  may instead come from the app's fixed path and then runs with the system `PATH`.
- An error refuses, or skips the entry; nothing unchecked is trusted.
- This is a tripwire for a genuine copy inside the repo, not a boundary: the launcher still finds
  `node` and its shell tools on `PATH`, so only an install outside every repo, run with a `PATH`
  and an environment (such as `NODE_OPTIONS`) the repo does not control, keeps the repo's code
  out. A `PATH` with version-manager shims (mise, asdf) is one the repo controls: the shim lies
  outside the repo but picks its tool from the repo's config.
- A test that reaches tailscale never uses the live `PATH`: it passes its own environment, and a
  mock of `executable.ts` refuses any lookup outside the test's own folders, so no test can reach a
  real `tailscale` or, on macOS, the Tailscale app. Tests of git run the system git with the
  fenced config above; tests of systemctl and launchctl use a fixture `PATH` and a mocked runner.
