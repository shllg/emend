# recense — vision

Status: draft, 2026-10-26. Items marked *(proposal)* still wait for confirmation.

recense is an open-source, local-first review tool for work done by coding agents: plans, docs and
code. You read the agent's writeup next to its diff, comment on any of it, press Send, and the
waiting agent gets your feedback. It starts on your machine with one command. Machines can attach to
a hub, so that you review from any device, your phone included.

## Why

Reviewing plans and implementations is now the main task of an engineer who works with coding
agents. It is also the most annoying one. recense makes review focused and fast, on any screen, from
anywhere.

## The pains

- Raw diffs are too large with LLM coding.
- Feedback on planning files (PRD, RFC, plan) is a mess. Commenting on them is annoying.
- Review docs, such as an agent's HTML writeup, are not coupled to the diff. You search for the
  right window.
- On a large screen, the writeup, the docs and the diff are not next to each other.
- Focused, fast review does not work with the same tool on a desktop and on a phone.
- With many projects and worktrees open, you lose track: did I already review this, did it change
  so that I need to re-review it, and what state is its PR in?
- You would like to sit on the couch in the evening and comment on reviews there. Today you can't.

## What works today, and carries over

[hunk-review-skill](https://github.com/vendis-ai/hunk-review-skill) and
[Hunk](https://github.com/modem-dev/hunk) already solve two things:

- **Topics.** The skill groups a diff into ranked topics. You focus on the relevant ones and can
  ignore the rest further down.
- **The writeup.** An HTML writeup explains the change, so you don't read every single line.

recense keeps both ideas, with its own skill and logic. hunk-review-skill stays maintained alongside
recense.

## What is missing

- One hub that shows all your reviews, like an inbox.
- One app that shows the writeup, HTML, Markdown and references next to the diff.
- One app that works on a large screen and on a phone.
- Hunk is loved by many, but its UX can be better. recense aims to do that.

## What recense is

- **Its own review skill and logic.** A recense skill and recense's own logic produce the topics and
  the writeup.
- **A review is a collection of files,** each kind handled in its own way. Code and diffs are one
  kind; docs (HTML, Markdown) are the other. Docs can also stand alone, without code. The agent
  that creates the review decides this on purpose, file by file, through the API, not by file
  type: a PRD changed in the branch belongs to the diff, and a PRD meant for reading is a doc.
- **Responsive.** On a large screen, from left to right:
  1. the hub: all reviews as an inbox, inspired by [T3 Code](https://github.com/pingdotgg/t3code);
  2. the writeup, HTML, Markdown and references;
  3. the code diff, sorted by topic.

  On a phone: the same content, one pane at a time. The code diff and the docs are separate tabs.
  The menu still needs design work.
- **Reachable from everywhere.** recense also replaces readout, a tool for reading agent-written
  pages on a phone.
- **Reviews of things that are not code,** such as a PRD, an RFC or a plan. It works like a code
  review minus the code.
- **Comments that stay** on diffs and files after a change, like GitHub reviews.
- **Agents stay in the loop,** waiting for feedback. When a wait has timed out, the feedback stays
  in recense, and a later session can pick it up.
- **Later:** sync with GitHub comments.

Every review in the hub answers three questions at a glance: have I reviewed it, did it change
since I looked, and what is its PR state?

## What success looks like *(proposal)*

- At your desk, you open recense and see every review that waits for you, across projects, worktrees
  and machines, with what changed since you last looked.
- On the couch in the evening, you open the same review on your phone. You read the writeup,
  comment on a plan paragraph and on a diff line, and press Send. The waiting agent gets your
  feedback. If its wait has timed out, the next session picks it up.
- After the agent's changes, your comments are still where you left them, and the review shows
  what changed since you looked.

## Where it runs

- Agents often run on more than one machine, for example a laptop and an always-on box. The
  reviewer works on a laptop or a phone, and wants every review from every machine on both.
- **Local first.** One command starts recense and opens it in the browser. No account, no setup.
- **Headless mode** runs recense without a UI, as a background service on an always-on machine.
- **Attached mode,** like herdr: a machine's recense attaches to another recense, the hub. Its reviews
  are copied to the hub, diffs included. The laptop and the phone open the hub and see the reviews
  from every machine in one inbox.
- **Remote access** follows T3 Code: pairing by one-time link and QR code, Tailscale HTTPS, scoped
  tokens (a phone gets review rights only), and capability flags between versions.
- **The browser comes first,** installable as a web app on the desktop and the phone. A desktop
  app can follow later.
- **The same software covers every step:** local on one machine, and machines attached over a
  tailnet. The goal is the most comfortable solution, and at some point that includes a commercial
  product. It is not there yet.
- Content is stored securely, and the server can read it, so that it renders well. There is no
  end-to-end encryption.
- A device that is fully offline is out of scope.
- This repository becomes the main one: a monorepo with the skills, the app, the CLI and the
  contract.

## Who it is for

- It starts with its author's daily review work, and the first version has to work for that.
- Nothing in it may block more users later.

## Non-goals *(proposal)*

- A team product now: teams, sharing and billing come later, if at all.
- Replacing GitHub as the place where PRs are merged.

## Anti-goals *(proposal)*

- A comment is lost, or silently lands on the wrong text or line.
- Content written by an agent, or text from a repo under review, runs as script with the
  reviewer's session.
- An approval covers content that was hidden from the reviewer, or that changed after they saw it.
  Approving accepts the shown revision's decisions and risk on its evidence; it does not claim that
  every line was read.
- A review is reachable by anyone but its owner and the devices they paired.
- An existing hunk-review-skill workflow breaks.

## Open questions

- Does Hunk stay as an optional terminal client?
- The phone's menu and navigation.

## Prior art

- [crit](https://github.com/tomasz-tomczyk/crit): local review of agent output, with the best plan
  review and agent loop among the local tools.
- [farol](https://github.com/winnin/farol): risk triage that ranks what to read first.
- [T3 Code](https://github.com/pingdotgg/t3code): a local-first server with web, desktop and
  mobile clients, and the model for recense's remote access.
- herdr: machines that attach to each other, with one view of all of them.
