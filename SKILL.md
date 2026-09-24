---
name: progress
description: Keep and show a live progress board for a project — a percentage per task, checkboxes for the steps, and an HTML dashboard that hot-reloads. Use when the user asks where a project stands, what is done, what is left, for a status or progress report, or to set up / install / update a progress board. Also use after finishing a unit of work in a repo that has a board, to tick the box.
---

# Progress board

A board is one markdown file plus a dashboard that renders it. The markdown is
the source of truth and the thing you edit; the HTML is generated from it and
refreshes itself while the user watches.

## Where a board lives

`docs/progress/` inside the repo being worked on:

```
docs/progress/
  PROGRESS.md        source of truth — the only file you edit by hand
  index.html         the dashboard, never regenerated
  progress.mjs       parser + watch server, no dependencies
  progress-data.js   generated; gitignored
```

Before anything else, check whether the repo already has one:
`ls docs/progress/PROGRESS.md`. If it does, **never re-install** — just edit.

## Installing into a repo

One command, run from the repo root:

```bash
node ~/.claude/skills/progress/assets/progress.mjs install docs/progress
```

It copies the viewer and this script in, writes the `.gitignore`, creates a
`PROGRESS.md` from the template if there is not one already, builds, and prints
how to open it. It never overwrites an existing board, so re-running it is
safe — that is also how you upgrade an already-installed board to a newer
viewer.

Then replace the template's contents. Seed `PROGRESS.md` from what the repo
already knows — a roadmap, a plan file, a
milestone list, open TODOs, recent commits — rather than inventing tasks. Ask
the user before guessing at work you cannot see evidence for. Then build and
tell them the two ways to open it.

## The format

```markdown
# Project — Progress

Optional line or two of context.

## Task name
status: blocked
owner: whoever

Optional paragraph shown under the task.

- [x] A finished step @2026-01-15
- [~] A step in flight (counts half)
- [ ] A step not started
- [-] A dropped step (leaves the denominator)
  - [x] Indented steps are the ones that count; parents derive their state
```

- `## heading` is a task. `### heading` groups steps inside one.
- `key: value` lines directly under a `##` are metadata. `status:` overrides
  the computed status — use it only for something the checkboxes cannot say,
  like `blocked` or `deferred`. Let `done`, `in progress` and `not started`
  compute themselves.
- `@YYYY-MM-DD` at the end of a step is the day it finished.
- Only leaf steps count. A parent with children completes when they all do.
- Task % = weighted steps / countable steps. Overall % = the same sum across
  every task, so a big task moves the number more than a small one.

## Worktrees and subagents — resolve the board first

There is ONE board per project, in the main working tree. An agent running in
a git worktree has its own checkout, and the board is usually not committed, so
`docs/progress/PROGRESS.md` is simply absent there. Installing a new one is the
wrong move: it creates a second board that diverges from the real one and dies
when the worktree is cleaned up.

So before editing, ask where the board actually is:

```bash
node ~/.claude/skills/progress/assets/progress.mjs where docs/progress/PROGRESS.md
```

It prints the resolved path — falling back to the main working tree when the
board is not in the current one — and exits non-zero if there is genuinely no
board anywhere. Edit the path it prints, never a fresh copy. An edit made this
way reaches a watch server running in the main tree, so the user's open
dashboard updates even though the work happened in a worktree.

Only run `install` when `where` reports no board anywhere.

## Keeping it current — the standing rule

**When you finish a unit of work in a repo that has a board, tick its box in
the same turn, with today's date. Do not ask first, and do not wait to be
told.** Then rebuild:

```bash
node docs/progress/progress.mjs build docs/progress/PROGRESS.md
```

If the watch server is running, the rebuild is automatic and the user's open
tab updates on its own — but running `build` is harmless and makes the
file:// case correct too, so just always run it.

Other rules that keep the board trustworthy:

- Mark a step `[~]` when you start it, `[x]` when it is actually finished —
  tests passing, not "written". A board that reports work that does not run is
  worse than no board.
- New work that appears mid-task gets appended as new unchecked steps, even
  though it drops the percentage. Never delete a step to make a number look
  better; mark it `[-]` if it was genuinely cut, and say so.
- If asked for progress and the board is stale, reconcile it against the repo
  first (git log, tests, the files themselves), say what you changed, then
  report.

## Showing it

Two ways, and the user picks. Offer the watch command whenever they will be
watching while you work — it is the one that updates without being asked:

```bash
# Live: rebuilds on save, pushes to the browser, opens a tab.
node docs/progress/progress.mjs watch docs/progress/PROGRESS.md --open

# Or just open the file — it polls the generated data every 2 seconds.
open docs/progress/index.html
```

Both hot-reload. The served one is instant over SSE; the file:// one lags up
to two seconds and needs `build` to have run. Offer the watch command when the
user will be watching while you work.

## Reporting in chat

When asked where things stand, lead with the overall number and the one or two
tasks that actually matter, not a recital of every step. `progress.mjs build`
prints the headline (`64%  18/28 done`) — cheap to run and quote. Link the
board as `docs/progress/PROGRESS.md` and mention the dashboard once.
