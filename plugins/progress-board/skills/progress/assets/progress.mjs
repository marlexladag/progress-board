#!/usr/bin/env node
/**
 * Progress board: PROGRESS.md -> progress-data.js, plus a watch server that
 * rebuilds on every save and pushes a reload to any open dashboard.
 *
 * No dependencies. Node 18+.
 *
 *   node progress.mjs task  [board] [match]         ONE task (default: the [>] one)
 *   node progress.mjs baseline [board] [--set "why"] scope drift since a recorded day
 *   node progress.mjs where                          which board am I editing?
 *   node progress.mjs serving [board]               URL if a watch server is up
 *   node progress.mjs static [board] [out.html]     one self-contained file
 *                                                   (headless: no server, no browser)
 *   node progress.mjs install [dir]                 (default docs/progress)
 *   node progress.mjs build   [board.md]
 *   node progress.mjs watch   [board.md] [--port 4321] [--open]
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync,
  watch as fsWatch,
} from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// A checkbox mark and what it means. Anything unrecognised reads as todo.
const MARKS = {
  ' ': 'todo', x: 'done', X: 'done',
  '~': 'doing', '/': 'doing',
  '>': 'running',   // being worked on AT THIS MOMENT, not merely started
  '-': 'dropped',
}
// What each state contributes to a percentage. `dropped` leaves the
// denominator entirely -- work that was cut should not drag a number down.
const WEIGHT = { done: 1, doing: 0.5, running: 0.5, todo: 0, dropped: null }

// ---------------------------------------------------------------- parsing

export function parse(md) {
  const doc = { title: 'Progress', subtitle: '', tasks: [] }
  let task = null
  let group = null
  let stack = []      // open parents, for indented sub-items
  let inMeta = false  // right after a `## Task`, `key: value` lines are metadata
  let blank = true    // a blank line is what starts a new paragraph

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const t = line.trim()

    if (/^#\s+/.test(t)) {
      doc.title = t.replace(/^#\s+/, '')
      task = null; group = null; stack = []; inMeta = false; blank = true
      continue
    }

    if (/^##\s+/.test(t)) {
      task = { name: t.replace(/^##\s+/, ''), meta: {}, notes: [], groups: [] }
      doc.tasks.push(task)
      group = null; stack = []; inMeta = true; blank = true
      continue
    }

    if (/^###\s+/.test(t) && task) {
      group = { name: t.replace(/^###\s+/, ''), items: [] }
      task.groups.push(group)
      stack = []; inMeta = false; blank = true
      continue
    }

    const box = line.match(/^(\s*)[-*]\s+\[(.)\]\s*(.*)$/)
    if (box && task) {
      inMeta = false
      const indent = box[1].replace(/\t/g, '  ').length
      const state = MARKS[box[2]] ?? 'todo'
      let text = box[3].trim()

      // Trailing `@token`s are metadata, not text: a date-shaped one is the day
      // it finished, anything else names whoever is on it -- an agent, a
      // worktree, a person. Several are allowed, since parallel agents share
      // a step.
      let date = ''
      const agents = []
      for (;;) {
        const at = text.match(/\s*@([A-Za-z0-9][\w.\-/]*)\s*$/)
        if (!at) break
        if (/^\d{4}-\d{2}-\d{2}$/.test(at[1])) date = at[1]
        else agents.unshift(at[1])
        text = text.slice(0, at.index).trim()
      }

      const item = { text, state, date, agents, children: [] }
      if (!group) { group = { name: '', items: [] }; task.groups.push(group) }

      while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop()
      if (stack.length) stack[stack.length - 1].item.children.push(item)
      else group.items.push(item)
      stack.push({ indent, item })
      continue
    }

    if (task && inMeta) {
      const m = t.match(/^([A-Za-z][\w -]*):\s+(.*)$/)
      if (m) { task.meta[m[1].toLowerCase().trim()] = m[2].trim(); continue }
    }

    if (!t) { blank = true; continue }
    if (task) {
      if (blank || !task.notes.length) task.notes.push(t)
      else task.notes[task.notes.length - 1] += ' ' + t
      blank = false
    } else if (!doc.tasks.length) {
      doc.subtitle += (doc.subtitle ? ' ' : '') + t
    }
  }

  return doc
}

// -------------------------------------------------------------- arithmetic

// Only leaves count. A parent with children takes its state FROM them, so
// ticking every sub-item completes the parent whether or not anyone
// remembered to tick the parent's own box.
function rollup(item) {
  if (item.children.length) {
    let sum = 0, n = 0
    for (const c of item.children) { const r = rollup(c); sum += r.sum; n += r.n }
    item.pct = n ? Math.round((100 * sum) / n) : null
    const anyRunning = item.children.some((c) => c.state === 'running')
    item.state = anyRunning ? 'running'
      : n ? (sum === n ? 'done' : sum > 0 ? 'doing' : 'todo')
      : item.state
    return { sum, n }
  }
  item.pct = null
  const w = WEIGHT[item.state]
  return w === null ? { sum: 0, n: 0 } : { sum: w, n: 1 }
}

function countLeaves(item, acc) {
  if (item.children.length) { for (const c of item.children) countLeaves(c, acc) ; return acc }
  acc[item.state] = (acc[item.state] || 0) + 1
  return acc
}

function statusOf(task) {
  // Running beats an explicit status: what is happening now is the most
  // useful thing a collapsed row can say.
  if (task.running > 0) return 'running'
  if (task.meta.status) return task.meta.status.toLowerCase()
  if (task.total === 0) return 'planned'
  if (task.pct >= 100) return 'done'
  if (task.pct > 0) return 'in progress'
  return 'not started'
}

export function measure(doc) {
  let sum = 0, n = 0
  const totals = { done: 0, doing: 0, running: 0, todo: 0, dropped: 0 }

  for (const task of doc.tasks) {
    let ts = 0, tn = 0
    const counts = { done: 0, doing: 0, running: 0, todo: 0, dropped: 0 }
    for (const g of task.groups) {
      for (const item of g.items) {
        const r = rollup(item)
        ts += r.sum; tn += r.n
        countLeaves(item, counts)
      }
    }
    task.done = counts.done
    task.doing = counts.doing
    task.running = counts.running

    // Who is on this task right now. Attribution on a finished step is
    // history; this is the answer to "is anyone working on it".
    const active = new Set()
    const walkAgents = (items) => {
      for (const it of items) {
        if ((it.state === 'running' || it.state === 'doing') && it.agents) {
          for (const a of it.agents) active.add(a)
        }
        walkAgents(it.children)
      }
    }
    for (const g of task.groups) walkAgents(g.items)
    task.agents = [...active]
    task.todo = counts.todo
    task.dropped = counts.dropped
    task.total = tn
    task.pct = tn ? Math.round((100 * ts) / tn) : 0
    task.status = statusOf(task)
    sum += ts; n += tn
    for (const k of Object.keys(totals)) totals[k] += counts[k]
  }

  // A flat list of what is running right now, for the banner.
  doc.running = []
  for (const task of doc.tasks) {
    for (const g of task.groups) {
      const walk = (items, trail) => {
        for (const it of items) {
          if (!it.children.length && it.state === 'running') {
            doc.running.push({ task: task.name, step: it.text, trail, agents: it.agents || [] })
          }
          walk(it.children, it.children.length ? [...trail, it.text] : trail)
        }
      }
      walk(g.items, [])
    }
  }

  doc.totals = totals
  doc.total = n
  doc.pct = n ? Math.round((100 * sum) / n) : 0
  doc.tasksDone = doc.tasks.filter((t) => t.status === 'done').length
  doc.taskCount = doc.tasks.length
  return doc
}

// One self-contained HTML file: the data inlined, nothing to fetch, nothing
// to serve. This is the only form that works where there is no browser to
// open and no port to listen on -- Cowork and other headless surfaces, where
// the user is handed a file they open themselves.
function buildStatic(boardPath, outPath) {
  const { doc } = build(boardPath)
  const viewer = join(dirname(boardPath), 'index.html')
  if (!existsSync(viewer)) {
    console.error(`No viewer at ${viewer}`)
    process.exit(1)
  }

  const inline =
    '<script>window.__STATIC__ = true; window.__PROGRESS__ = ' +
    JSON.stringify(doc).replace(/<\//g, '<\\/') +
    ';</script>'

  const html = readFileSync(viewer, 'utf8')
    .replace('<script src="progress-data.js"></script>', inline)

  if (html.includes('progress-data.js"></script>')) {
    console.error('Could not inline the data: the viewer has an unexpected shape.')
    process.exit(1)
  }

  const out = resolve(outPath || join(dirname(boardPath), 'progress.html'))
  writeFileSync(out, html)
  return { doc, out }
}

// Is a watch server already up for THIS board? Reading another process's
// command line cannot answer that: the path in it is relative to the server's
// working directory, not ours, so a server for a different board resolves to
// a false match. The server drops a file beside the board instead, which is
// scoped to the board by construction.
const SERVING = (boardPath) => join(dirname(boardPath), '.serving')

function markServing(boardPath, port) {
  const f = SERVING(boardPath)
  writeFileSync(f, JSON.stringify({ pid: process.pid, port }) + '\n')
  const clear = () => { try { unlinkSync(f) } catch {} }
  process.on('exit', clear)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clear(); process.exit(0) })
  }
}

function serving(boardPath) {
  const f = SERVING(boardPath)
  if (!existsSync(f)) return null
  let rec
  try { rec = JSON.parse(readFileSync(f, 'utf8')) } catch { return null }

  // A hard kill leaves the file behind; a dead pid means it is stale.
  try {
    process.kill(rec.pid, 0)
  } catch (err) {
    if (err.code === 'ESRCH') { try { unlinkSync(f) } catch {} ; return null }
  }
  return { pid: rec.pid, port: rec.port }
}

// One task, not the whole board. "Where are we in this task?" deserves that
// task's number -- quoting the project total answers a question nobody asked.
const GLYPH = { done: 'x', running: '>', doing: '~', todo: ' ', dropped: '-' }

function printSteps(items, indent) {
  for (const it of items) {
    const g = GLYPH[it.state] ?? ' '
    const date = it.date ? `  @${it.date}` : ''
    const who = it.agents && it.agents.length ? `  [${it.agents.join(', ')}]` : ''
    const pct = it.children.length && it.pct !== null ? `  (${it.pct}%)` : ''
    console.log(`${indent}[${g}] ${it.text}${pct}${who}${date}`)
    printSteps(it.children, indent + '    ')
  }
}

function reportTask(doc, match) {
  let task = null

  if (match) {
    const needle = match.toLowerCase()
    const hits = doc.tasks.filter((t) => t.name.toLowerCase().includes(needle))
    if (hits.length === 0) {
      console.error(`No task matching ${JSON.stringify(match)}. The board has:`)
      for (const t of doc.tasks) console.error(`  ${t.name}`)
      process.exit(1)
    }
    if (hits.length > 1) {
      console.error(`${JSON.stringify(match)} matches more than one task:`)
      for (const t of hits) console.error(`  ${t.name}`)
      process.exit(1)
    }
    task = hits[0]
  } else {
    // No name given: "this task" is the one being worked on.
    task = doc.tasks.find((t) => t.running > 0)
    if (!task) {
      console.error('Nothing is marked [>], so there is no current task.')
      console.error('Name one, or mark the step being worked on with [>].')
      process.exit(1)
    }
  }

  console.log(task.name)
  console.log(`  ${task.pct}%  ${task.status}  ${task.done}/${task.total} done`)
  if (task.agents && task.agents.length) {
    console.log(`  working: ${task.agents.join(', ')}`)
  }
  // A declared status that `running` overrode would read as a contradiction.
  if (task.meta.status && task.status === task.meta.status.toLowerCase()) {
    console.log(`  declared: ${task.meta.status}`)
  }
  console.log('')
  for (const g of task.groups) {
    if (g.name) console.log(`  ${g.name}`)
    printSteps(g.items, '  ')
  }
  console.log('')
  console.log(`  (project: ${doc.pct}%  ${doc.totals.done}/${doc.total} done)`)
}

// ------------------------------------------------------------- resolving

// An agent working in a git worktree has its own checkout, and the board is
// usually not committed -- so `docs/progress/PROGRESS.md` simply is not there.
// Left alone it would install a SECOND board that diverges from the real one
// and dies with the worktree. So: if the board is not where we were told,
// look in the main working tree before giving up.
function mainWorktreeRoot(from) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const abs = resolve(from, common)
    if (basename(abs) === '.git') return dirname(abs)
  } catch {}
  return null
}

export function resolveBoard(given, cwd = process.cwd()) {
  const direct = resolve(cwd, given)
  if (existsSync(direct)) return direct

  const main = mainWorktreeRoot(cwd)
  if (main && resolve(main) !== resolve(cwd)) {
    const candidate = join(main, 'docs', 'progress', 'PROGRESS.md')
    if (existsSync(candidate)) return candidate
  }
  return direct
}

// ---------------------------------------------------------------- baseline

// A percentage cannot tell progress from scope discovery. A baseline can:
// it records what the board looked like on a day, so "27 still to do" can be
// read against "27 still to do a week ago, after closing 42 steps".
const BASELINE = (boardPath) => join(dirname(boardPath), 'baseline.json')

function readBaselines(boardPath) {
  const f = BASELINE(boardPath)
  if (!existsSync(f)) return []
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'))
    return Array.isArray(d.baselines) ? d.baselines : []
  } catch {
    return []
  }
}

// Net, not gross: without identity per step we cannot tell an added step from
// a renamed one, so the wording everywhere says "net" and means it.
function drift(base, doc) {
  const remainingThen = base.total - base.done
  const remainingNow = doc.total - doc.totals.done
  return {
    date: base.date,
    label: base.label || '',
    total: base.total,
    done: base.done,
    addedNet: doc.total - base.total,
    closed: doc.totals.done - base.done,
    remainingThen,
    remainingNow,
    remainingDelta: remainingNow - remainingThen,
  }
}

function setBaseline(boardPath, label) {
  const { doc } = build(boardPath)
  const list = readBaselines(boardPath)
  const entry = {
    date: new Date().toISOString().slice(0, 10),
    total: doc.total,
    done: doc.totals.done,
    label: label || '',
  }
  list.push(entry)
  writeFileSync(BASELINE(boardPath), JSON.stringify({ baselines: list }, null, 2) + '\n')
  console.log(`Baseline recorded: ${entry.date}  ${entry.done}/${entry.total} done${label ? '  — ' + label : ''}`)
  console.log(`  ${BASELINE(boardPath)}`)
  if (list.length > 1) {
    console.log('')
    console.log(`  This is baseline #${list.length}. The earlier ones are kept --`)
    console.log('  drift is always reported against the FIRST, so a new one')
    console.log('  cannot quietly reset the comparison.')
  }
}

function showBaseline(boardPath) {
  const { doc } = build(boardPath)
  const list = readBaselines(boardPath)
  if (!list.length) {
    console.error('No baseline recorded. Set one with:')
    console.error(`  progress.mjs baseline ${boardPath} --set "why now"`)
    process.exit(1)
  }
  console.log(`now            ${doc.totals.done}/${doc.total} done   ${doc.total - doc.totals.done} remaining   ${doc.pct}%`)
  console.log('')
  for (const b of list) {
    const d = drift(b, doc)
    const sign = d.remainingDelta > 0 ? '+' : ''
    console.log(`since ${d.date}   ${d.done}/${d.total} then${d.label ? '  (' + d.label + ')' : ''}`)
    console.log(`               ${d.closed} closed, ${d.addedNet >= 0 ? '+' : ''}${d.addedNet} steps net`)
    console.log(`               remaining ${d.remainingThen} -> ${d.remainingNow}  (${sign}${d.remainingDelta})`)
    console.log('')
  }
}

// ---------------------------------------------------------------- emitting

function build(boardPath) {
  const md = readFileSync(boardPath, 'utf8')
  const doc = measure(parse(md))
  doc.source = boardPath
  doc.generatedAt = new Date().toISOString()
  doc.stamp = createHash('sha1').update(md).digest('hex').slice(0, 12)

  // Always against the FIRST baseline: a later one must not reset the story.
  const bases = readBaselines(boardPath)
  doc.drift = bases.length ? drift(bases[0], doc) : null

  const out = join(dirname(boardPath), 'progress-data.js')
  writeFileSync(
    out,
    '// Generated by progress.mjs -- edit PROGRESS.md, not this file.\n' +
      'window.__PROGRESS__ = ' + JSON.stringify(doc, null, 2) + ';\n' +
      'if (window.__onProgress) window.__onProgress();\n',
  )
  return { doc, out }
}

// ----------------------------------------------------------------- serving

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function serve(boardPath, port, openIt) {
  const root = dirname(boardPath)
  const clients = new Set()

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('retry: 1000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    const name = url.pathname === '/' ? '/index.html' : url.pathname
    const file = resolve(root, '.' + name)
    if (!file.startsWith(resolve(root)) || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('not found')
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(readFileSync(file))
  })

  server.listen(port, () => {
    const { doc } = build(boardPath)
    const url = `http://localhost:${port}/`
    markServing(boardPath, port)
    console.log(`progress  ${doc.pct}%  ${doc.totals.done}/${doc.total} done  ->  ${url}`)
    console.log(`watching  ${boardPath}`)
    if (openIt) {
      const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open'
      spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
    }
  })

  // Watch the whole directory, so editing the VIEWER reaches an open tab too
  // -- otherwise a redesign sits on disk while the browser shows the old one.
  // The generated file is written by this watcher, so ignoring it is what
  // keeps the rebuild from retriggering itself forever.
  const boardName = basename(boardPath)
  let timer = null
  let pendingPage = false

  fsWatch(root, (_evt, filename) => {
    if (filename === 'progress-data.js' || filename === '.serving') return
    if (filename && filename !== boardName && filename !== 'index.html') return
    if (filename === 'index.html') pendingPage = true

    // fs.watch fires more than once per save on most platforms; settle first.
    clearTimeout(timer)
    timer = setTimeout(() => {
      const page = pendingPage
      pendingPage = false
      try {
        if (page) {
          console.log('  viewer changed -- reloading open tabs')
          for (const c of clients) c.write('data: page\n\n')
          return
        }
        const { doc } = build(boardPath)
        console.log(`  rebuilt  ${doc.pct}%  ${doc.totals.done}/${doc.total} done`)
        for (const c of clients) c.write('data: reload\n\n')
      } catch (err) {
        console.error('  build failed:', err.message)
      }
    }, 90)
  })
}

// A starter board, inline so that an installed copy of this script can seed
// another repo on its own -- it does not ship the skill's template file.
const STARTER = `# PROJECT — Progress

What this board covers, in a line. Everything under a \`##\` is a task and
everything under a \`- [ ]\` is a step. The percentages come from the steps, so
the steps are the only thing that has to be honest.

## First task

- [x] A step that is finished @DATE
- [~] A step being worked on right now (counts half)
- [ ] A step not started
- [-] A step that was dropped — it leaves the denominator entirely

## Second task

### An optional group of steps
- [ ] Parent step, its state comes from its children
  - [ ] Indented children are what actually count
  - [ ] Tick these and the parent completes on its own
`

// Drop the board, the viewer and this script into a repo, then build once.
function install(target) {
  const dest = resolve(target)
  mkdirSync(dest, { recursive: true })

  const copied = []
  for (const f of ['index.html', 'progress.mjs']) {
    const src = join(HERE, f)
    const out = join(dest, f)
    if (resolve(src) === resolve(out)) continue
    if (!existsSync(src)) {
      console.error(`Missing ${src} -- run this from the skill's assets/ directory.`)
      process.exit(1)
    }
    copyFileSync(src, out)
    copied.push(f)
  }

  // Both are runtime artefacts of this directory, never content.
  const gitignore = join(dest, '.gitignore')
  const want = ['progress-data.js', '.serving']
  const have = existsSync(gitignore) ? readFileSync(gitignore, 'utf8').split(/\r?\n/) : []
  const merged = have.filter(Boolean)
  for (const w of want) if (!merged.includes(w)) merged.push(w)
  writeFileSync(gitignore, merged.join('\n') + '\n')

  const board = join(dest, 'PROGRESS.md')
  const fresh = !existsSync(board)
  if (fresh) {
    const tpl = join(HERE, 'PROGRESS.template.md')
    if (existsSync(tpl)) copyFileSync(tpl, board)
    else writeFileSync(board, STARTER.replace('@DATE', '@' + new Date().toISOString().slice(0, 10)))
  }

  const { doc } = build(board)
  const rel = (p) => p.replace(process.cwd() + '/', '')

  console.log(`Installed into ${rel(dest)}/`)
  if (copied.length) console.log(`  copied   ${copied.join(', ')}`)
  console.log(`  board    ${rel(board)}${fresh ? '  (new, from the template)' : '  (kept, already existed)'}`)
  console.log(`  ${doc.pct}%  ${doc.totals.done}/${doc.total} done`)
  console.log('')
  console.log('Open it:')
  console.log(`  node ${rel(join(dest, 'progress.mjs'))} watch ${rel(board)} --open`)
  console.log(`  open ${rel(join(dest, 'index.html'))}`)
}

// --------------------------------------------------------------------- cli

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const portArg = argv.find((a) => a.startsWith('--port'))
const port = portArg ? Number(portArg.split('=')[1] ?? argv[argv.indexOf(portArg) + 1]) : 4321
const positional = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const verb = positional[0]
const mode = verb === 'watch' ? 'watch'
  : verb === 'install' ? 'install'
  : verb === 'where' ? 'where'
  : verb === 'static' ? 'static'
  : verb === 'serving' ? 'serving'
  : verb === 'task' ? 'task'
  : verb === 'baseline' ? 'baseline'
  : 'build'

if (mode === 'install') {
  install(positional[1] || 'docs/progress')
  process.exit(0)
}

const board = resolveBoard(positional[1] || join(HERE, 'PROGRESS.md'))

if (mode === 'where') {
  console.log(board)
  console.log(existsSync(board) ? '  (exists)' : '  (MISSING -- run: progress.mjs install docs/progress)')
  process.exit(existsSync(board) ? 0 : 1)
}

if (!existsSync(board)) {
  console.error(`No board at ${board}`)
  console.error('Create one with:  node progress.mjs install docs/progress')
  process.exit(1)
}

if (mode === 'serving') {
  const s = serving(board)
  if (s) {
    console.log(`http://localhost:${s.port}/`)
    process.exit(0)
  }
  console.log('not serving')
  process.exit(1)
}

if (mode === 'baseline') {
  const setIdx = argv.indexOf('--set')
  if (setIdx !== -1) setBaseline(board, argv[setIdx + 1] && !argv[setIdx + 1].startsWith('--') ? argv[setIdx + 1] : '')
  else showBaseline(board)
  process.exit(0)
}

if (mode === 'task') {
  const { doc } = build(board)
  reportTask(doc, positional[2])
  process.exit(0)
}

if (mode === 'static') {
  const outArg = positional[2]
  const { doc, out } = buildStatic(board, outArg)
  const kb = Math.round(readFileSync(out).length / 1024)
  console.log(`${doc.pct}%  ${doc.totals.done}/${doc.total} done  ->  ${out}  (${kb} kB, self-contained)`)
} else if (mode === 'watch') {
  serve(board, port, flags.has('--open'))
} else {
  const { doc, out } = build(board)
  console.log(`${doc.pct}%  ${doc.totals.done}/${doc.total} done  ->  ${out}`)
}
