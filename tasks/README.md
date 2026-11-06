# Tasks

The older work queue for this repo. New work comes as GitHub issues (`bin/wt issues`, `/e-issue`,
`/e-loop`); the task files below stay until their work is done or dropped. One file per task,
numbered in the order they were opened. The design and the plan of record live outside this repo,
with the owner. Task content comes from the plan, and each task names the plan's task numbers.

## "What should I do now?"

When the owner asks what to do next:

1. Run `bin/wt issues`, by its absolute path in the main checkout. When an issue is pickable, give
   the first one: its number, kind and priority, and its title when the row shows one. Then go on
   with the task files.
2. Run `bin/wt tasks` the same way. It prints the queue from every
   task file in `origin/main`, local `main` and every worktree. `--json` prints the same rows for
   machines. Read the task files' frontmatter for the details.
3. Pick the lowest-numbered task whose `status` is `open` and whose `depends_on` tasks are all
   `done`. A task that is `in-progress` already has a branch; point to it instead of starting
   it again.
4. Answer with its title, who does it (`owner`), the first unchecked step, and its "Done when"
   line. Mention anything `blocked`.
5. For task 008, the next step is the first unchecked step in its list, in the order its
   intro gives.
6. If no issue and no task qualifies, say so and point to the plan. Do not invent work.

## Keeping it current

- Tick a step's checkbox when it is done.
- `status` is one of `open`, `in-progress`, `blocked`, `done` and `dropped`. A branch sets
  `in-progress` when work starts.
- When a task is done: set `status: done` and `done_on: YYYY-MM-DD`, and add one line under
  "Notes". The branch does this in its own task file before it merges, so the merge carries it
  to `main`.
- A task that is no longer needed gets `status: dropped`, `done_on` and a line under "Notes".
- New task files come only from the plan; other new work is a GitHub issue. Task numbers come from
  `bin/wt`: it reserves them, so parallel branches never collide, and it never reuses a number. A
  task's branch is `emend-task-<NNN>-<slug>`. Numbers stay below 099. Keep the
  frontmatter fields.
- `owner: you` means the owner runs it. Agents may prepare and guide, but never run the commands
  `AGENTS.md` reserves for the owner.
