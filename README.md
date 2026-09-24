# progress-board

A [Claude Code](https://claude.com/claude-code) skill that keeps a progress
board for a project and renders it as a dashboard that updates while you watch.

One markdown file is the source of truth. Claude ticks the boxes as it finishes
work, and the page reflects it without a refresh.

![The dashboard](docs/light.png#gh-light-mode-only)
![The dashboard](docs/dark.png#gh-dark-mode-only)

## Install

This repository is a Claude Code marketplace containing one plugin. Install it
from inside Claude Code, or from a terminal — the two are equivalent.

**Inside Claude Code**, at the prompt (these are slash commands, not shell):

```
/plugin marketplace add marlexladag/progress-board
/plugin install progress-board@progress-board
```

**From a terminal**, which also works before you have started Claude Code and
in a setup script:

```bash
claude plugin marketplace add marlexladag/progress-board
claude plugin install progress-board@progress-board
```

Then restart Claude Code, or run `/reload-plugins` in a running session.
Confirm it took with `claude plugin list`.

`install` takes `--scope user` (the default, every project), `project` (written
to the repository's settings, so everyone who clones it gets the plugin) or
`local` (this repository, just you):

```bash
claude plugin install progress-board@progress-board --scope project
```

Useful afterwards: `claude plugin list`, `claude plugin details progress-board`,
`claude plugin disable progress-board`, and `claude plugin marketplace update
progress-board` to pull a newer version.

<details>
<summary>Or install it as a plain skill, without the plugin system</summary>

Copy the skill directory into wherever you keep skills:

```bash
git clone https://github.com/marlexladag/progress-board.git /tmp/progress-board
cp -R /tmp/progress-board/plugins/progress-board/skills/progress ~/.claude/skills/progress
```

Restart Claude Code. It scans `~/.claude/skills/` at startup and reads the
`name` and `description` from the frontmatter of `SKILL.md` — that is the whole
registration step. To give it to everyone working on one repository instead,
copy it to `<repo>/.claude/skills/progress` and commit it.

</details>

Requires Node 18 or newer. Nothing else — no dependencies, no build step.

## Use it

In any project, ask Claude to *"install a progress board here"*, or run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/progress/assets/progress.mjs" install docs/progress
```

That writes `docs/progress/`, creates a starter `PROGRESS.md`, and prints how
to open it. It never overwrites a board that already exists, so re-running it is
also how you upgrade an installed board to a newer viewer.

Then open it:

```bash
# Live: rebuilds on save and pushes to the browser
node docs/progress/progress.mjs watch docs/progress/PROGRESS.md --open

# Or just open the file — it polls the generated data every 2 seconds
open docs/progress/index.html
```

Both hot-reload. Leave the first one on a second monitor and the bars move as
Claude works.

With several projects open, `watch` takes the next free port and says which it
took, so two boards never collide. A port named with `--port` is never quietly
swapped — it fails instead. A board already being watched gets no second
server; `watch` prints the existing URL and stops.

## The board

````markdown
# Checkout rewrite — Progress

Optional context, shown under the title.

## Payment provider migration
owner: platform team

An optional paragraph about this task.

- [x] A finished step @2026-09-16
- [>] The step being worked on right now — counts half
- [~] Underway, but not being touched this moment — counts half
- [ ] A step not started
- [-] A step that was cut — leaves the denominator entirely
- [ ] A step with children
  - [x] Only leaves count
  - [ ] The parent completes when its children do

### An optional group
- [ ] Groups split one task into phases

## A task that is waiting on someone
status: blocked
````

- `##` is a task, `###` groups steps inside one.
- `key: value` lines under a `##` are metadata. `status:` overrides the computed
  status — use it for something the checkboxes cannot say, like `blocked` or
  `deferred`. Let `done`, `in progress` and `not started` compute themselves.
- `@YYYY-MM-DD` at the end of a step records when it finished. Any other
  trailing `@name` says who is on it — an agent, a worktree, a person — and
  several are allowed. The dashboard shows them beside the step, on the
  collapsed task row and in the "Running now" banner, so a board with several
  agents on it says who is where.

### The baseline

A percentage cannot distinguish progress from scope discovery. A board can go
from 34% to 68% while the work remaining does not move, because closing 42
steps and finding 42 more looks the same as closing 42 steps.

```bash
progress.mjs baseline PROGRESS.md --set "seeded from ROADMAP"   # record
progress.mjs baseline PROGRESS.md                                # read the drift
```

```
now            56/83 done   27 remaining   68%
since 2026-09-24   14/41 then
               42 closed, +42 steps net
               remaining 27 -> 27  (0)
```

The dashboard shows the same line under the ring and flags it when the
remaining count has not fallen. Drift is always measured against the *first*
baseline, and later ones are kept rather than replacing it, so a fresh
baseline cannot quietly reset the story. `baseline.json` is committed — it is
recorded state, not a build artefact.

### Size, and work in progress

By default every step counts the same, so the percentage is partly an artefact
of how finely the work was chopped. A trailing size fixes that — `~S` `~M`
`~L` `~XL` are 1, 3, 9, 27, and `~12` sets a weight directly:

```markdown
- [ ] Start the Windows OV certificate ~XL
- [ ] Delete a stale gate ~S
```

A release board with four such steps reads **29% by step count and 10% by
weight**; the second is the one that matches how much is left. An unsized step
counts 1, so a board that never mentions size behaves exactly as before, and
the dashboard says "weighted by size" only when some step declares one.

Board-level `wip: 3` sets a limit on how many tasks may be open at once. The
dashboard always shows the count and flags it when the limit is exceeded —
everything being 60% done and nothing shipping is the failure it exists to
make visible.

### How the numbers work

Task percentage is weighted steps over countable steps: `[x]` counts 1, `[>]`
and `[~]` count a half, `[ ]` counts 0, and `[-]` leaves the denominator, so
cutting scope does not quietly depress the number forever.

`[>]` is the live marker, and it is what separates *in progress* from *being
worked on this moment*. Its task reports `running`, the dashboard shows it in a
"Running now" banner with the path to the exact step, and its card is
highlighted — useful precisely because every other card also says "in
progress".

Only leaf steps count. A parent with children takes its state from them, so a
task cannot be reported complete by ticking a headline.

The overall percentage is the same sum across every task, which means a large
task moves it more than a small one.

## What Claude does with it

The skill carries a standing rule: when Claude finishes a unit of work in a
repository that has a board, it ticks the box with the date and rebuilds in the
same turn, without being asked. It is also told not to mark a step done until
the work actually runs, and never to delete a step to improve a number — work
that was genuinely cut is marked `[-]` instead.

Ask *"where are we in this task?"* and it answers about that one task — its
percentage and its remaining steps — rather than the project total, which is a
different question. With nothing to narrow it, ask *"where are we?"* and it reads the board, reconciles it against the
repository if it looks stale, and answers with the number — in chat. If a
dashboard is already running it includes the link; if not, it offers in one
line rather than opening a browser tab you did not ask for. Say *"open the
board"* and it opens immediately.

### Worktrees

There is one board per project, in the main working tree. An agent running in a
git worktree has its own checkout where the board usually does not exist, so the
skill resolves the path through `git rev-parse --git-common-dir` before editing
rather than installing a second board that would diverge and then vanish:

```bash
node docs/progress/progress.mjs where docs/progress/PROGRESS.md
```

An edit made that way reaches a watch server running in the main tree, so the
dashboard updates even though the work happened somewhere else.

## Commands

| command | what it does |
| --- | --- |
| `progress.mjs install [dir]` | install into a repository (default `docs/progress`) |
| `progress.mjs build [board]` | regenerate `progress-data.js` from the board |
| `progress.mjs watch [board]` | rebuild on save and push to the browser; `--open`, `--port` |
| `progress.mjs task [board] [match]` | report ONE task — the `[>]` one, or matched by name |
| `progress.mjs baseline [board] [--set "why"]` | record a baseline, or show scope drift since one |
| `progress.mjs where [board]` | print which board would be edited |
| `progress.mjs serving [board]` | print the URL if a watch server is already up |
| `progress.mjs static [board] [out]` | write one self-contained HTML file — no server, no sibling files |

## Stopping the permission prompts

Ticking a box is a routine edit to one file you asked to have kept current, so
being asked each time defeats the point. Add to the repo's
`.claude/settings.json` (merging with any existing rules):

```json
{
  "permissions": {
    "allow": [
      "Edit(docs/progress/PROGRESS.md)",
      "Edit(docs/progress/baseline.json)",
      "Bash(node docs/progress/progress.mjs *)"
    ]
  }
}
```

It grants nothing outside `docs/progress/`. A newly created settings file may
need a session restart to take effect.

## Headless surfaces

Where there is a filesystem and a shell but no display or browser — Cowork, a
CI job, a remote box — `watch` and `--open` cannot help, and the viewer on its
own is not enough because it reads its data from a file beside it. Produce a
single self-contained file instead:

```bash
node docs/progress/progress.mjs static docs/progress/PROGRESS.md report.html
```

Everything is inlined, so it opens alone with nothing next to it, and its
footer says "snapshot" rather than claiming to be live. The skill knows to
reach for this when it cannot open a browser. `install`, `build`, `where` and
every edit to the board need only Node, git and a filesystem, so they work
on those surfaces unchanged.

## How the live reload works

The viewer is a single HTML file with no build step, and it has to work both
double-clicked from a file manager and served over HTTP.

`fetch` and ES modules are both blocked on `file://`, so the generated data is a
classic script that the page re-injects with a cache-busting query — the one
mechanism that works in both places. Served, the watcher additionally holds an
SSE stream and pushes two kinds of event: a data change re-pulls the data and
animates the bars while your scroll position and collapsed sections survive, and
a change to the viewer itself triggers a full reload, since new CSS cannot
arrive through a data pull.

## Releasing

The version in `plugins/progress-board/.claude-plugin/plugin.json` is what
gates updates — someone who installed an earlier version receives nothing until
that field moves, however many commits land. So:

```bash
# 1. bump the version in plugin.json (and the skill's frontmatter, to match)
# 2. check it the way the review pipeline does
claude plugin validate ./plugins/progress-board --strict

# 3. commit, then tag and push in one step
claude plugin tag ./plugins/progress-board --push -m "progress-board %s"
```

`claude plugin tag` reads the version from `plugin.json`, **checks it agrees
with the marketplace entry**, and creates `progress-board--v<version>` at HEAD.
`--dry-run` prints what it would do without doing it.

Tags before v0.5.1 were originally created by hand as plain `v<version>`; the
conventional names were added afterwards at the same commits, and both sets are
kept rather than rewriting published history. There is no 0.3.0 — the version
was bumped to it and then bumped again before anything was committed, so the
work it named shipped inside 0.4.0.

## Licence

MIT.
