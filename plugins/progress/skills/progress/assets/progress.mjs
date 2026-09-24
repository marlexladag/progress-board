#!/usr/bin/env node
/**
 * Progress board: PROGRESS.md -> progress-data.js, plus a watch server that
 * rebuilds on every save and pushes a reload to any open dashboard.
 *
 * No dependencies. Node 18+.
 *
 *   node progress.mjs where                          which board am I editing?
 *   node progress.mjs install [dir]                 (default docs/progress)
 *   node progress.mjs build   [board.md]
 *   node progress.mjs watch   [board.md] [--port 4321] [--open]
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync,
  watch as fsWatch,
} from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// A checkbox mark and what it means. Anything unrecognised reads as todo.
const MARKS = { ' ': 'todo', x: 'done', X: 'done', '~': 'doing', '/': 'doing', '-': 'dropped' }
// What each state contributes to a percentage. `dropped` leaves the
// denominator entirely -- work that was cut should not drag a number down.
const WEIGHT = { done: 1, doing: 0.5, todo: 0, dropped: null }

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

      // Trailing `@YYYY-MM-DD` is the day it was finished, not part of the text.
      let date = ''
      const dm = text.match(/\s*@(\d{4}-\d{2}-\d{2})\s*$/)
      if (dm) { date = dm[1]; text = text.slice(0, dm.index).trim() }

      const item = { text, state, date, children: [] }
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
    item.state = n ? (sum === n ? 'done' : sum > 0 ? 'doing' : 'todo') : item.state
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
  if (task.meta.status) return task.meta.status.toLowerCase()
  if (task.total === 0) return 'planned'
  if (task.pct >= 100) return 'done'
  if (task.pct > 0) return 'in progress'
  return 'not started'
}

export function measure(doc) {
  let sum = 0, n = 0
  const totals = { done: 0, doing: 0, todo: 0, dropped: 0 }

  for (const task of doc.tasks) {
    let ts = 0, tn = 0
    const counts = { done: 0, doing: 0, todo: 0, dropped: 0 }
    for (const g of task.groups) {
      for (const item of g.items) {
        const r = rollup(item)
        ts += r.sum; tn += r.n
        countLeaves(item, counts)
      }
    }
    task.done = counts.done
    task.doing = counts.doing
    task.todo = counts.todo
    task.dropped = counts.dropped
    task.total = tn
    task.pct = tn ? Math.round((100 * ts) / tn) : 0
    task.status = statusOf(task)
    sum += ts; n += tn
    for (const k of Object.keys(totals)) totals[k] += counts[k]
  }

  doc.totals = totals
  doc.total = n
  doc.pct = n ? Math.round((100 * sum) / n) : 0
  doc.tasksDone = doc.tasks.filter((t) => t.status === 'done').length
  doc.taskCount = doc.tasks.length
  return doc
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

// ---------------------------------------------------------------- emitting

function build(boardPath) {
  const md = readFileSync(boardPath, 'utf8')
  const doc = measure(parse(md))
  doc.source = boardPath
  doc.generatedAt = new Date().toISOString()
  doc.stamp = createHash('sha1').update(md).digest('hex').slice(0, 12)

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
    if (filename === 'progress-data.js') return
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

  const gitignore = join(dest, '.gitignore')
  if (!existsSync(gitignore)) writeFileSync(gitignore, 'progress-data.js\n')

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

if (mode === 'watch') {
  serve(board, port, flags.has('--open'))
} else {
  const { doc, out } = build(board)
  console.log(`${doc.pct}%  ${doc.totals.done}/${doc.total} done  ->  ${out}`)
}
