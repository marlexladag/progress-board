# progress-board

A [Claude Code](https://claude.com/claude-code) skill that keeps a progress
board for a project and renders it as a dashboard that updates while you watch.

One markdown file is the source of truth. Claude ticks the boxes as it finishes
work, and the page reflects it without a refresh.

![The dashboard](docs/light.png#gh-light-mode-only)
![The dashboard](docs/dark.png#gh-dark-mode-only)

## Install

This repository is a Claude Code marketplace containing one plugin. In Claude
Code:

```
/plugin marketplace add marlexladag/progress-board
/plugin install progress-board@progress-board
```

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
- `@YYYY-MM-DD` at the end of a step records when it finished.

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
| `progress.mjs where [board]` | print which board would be edited |
| `progress.mjs serving [board]` | print the URL if a watch server is already up |
| `progress.mjs static [board] [out]` | write one self-contained HTML file — no server, no sibling files |

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

## Licence

MIT.
