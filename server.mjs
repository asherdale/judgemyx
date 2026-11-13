import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { extname, join, normalize } from 'node:path'
import { fetchAccount, analyze, openers } from './xdata.mjs'
import { judge, ask } from './judge.mjs'
import { renderCard, renderHomeCard } from './card.mjs'
import { moderate } from './moderate.mjs'
import { startBot } from './bot.mjs'
import { api } from './omnara.mjs'

const PORT = Number(process.env.PORT ?? 8788)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4)
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT ?? 300)
const X_HANDLE = process.env.X_HANDLE
if (!X_HANDLE) throw new Error('Set X_HANDLE to the X account that posts the launch post')
const LAUNCH_URL = process.env.LAUNCH_POST_URL || `https://x.com/${X_HANDLE}`
const LAUNCH_TEXT = process.env.LAUNCH_POST_TEXT || 'reply to get judged'
const UNLISTED = (process.env.UNLISTED ?? 'demo_founder').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
const LISTED = `handle not in (${UNLISTED.map(() => '?').join(', ')})`
const QUESTIONS_PER_IP = Number(process.env.QUESTIONS_PER_IP ?? 20)
const ROOT = import.meta.dirname, SITE = join(ROOT, 'site'), DATA = process.env.DATA_DIR ?? join(ROOT, 'data')
for (const d of ['raw', 'reports', 'cards']) mkdirSync(join(DATA, d), { recursive: true })

const db = new DatabaseSync(join(DATA, 'ratemyx.db'))
db.exec(`create table if not exists ratings (
  handle text primary key, name text, avatar text, followers integer, score real, verdict text,
  status text, error text, agent_id text, created_at text, finished_at text
)`)
db.exec(`update ratings set status = 'failed', error = 'Interrupted.' where status in ('queued', 'running')`)
try { db.exec('alter table ratings add column screen_name text') } catch {}
for (const { handle } of db.prepare('select handle from ratings where screen_name is null').all()) {
  const f = join(DATA, 'reports', `${handle}.json`)
  if (existsSync(f)) db.prepare('update ratings set screen_name = ? where handle = ?').run(JSON.parse(readFileSync(f, 'utf8')).profile.handle, handle)
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/
const live = new Map(), queue = []
let running = 0
const now = () => new Date().toISOString()
const key = (h) => h.toLowerCase()
const row = (h) => db.prepare('select * from ratings where handle = ?').get(key(h))
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2000) req.destroy() }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } }) })

const hits = new Map()
const LOCAL = /^(::1|127\.|::ffff:127\.)/
const clientIp = (req) => req.headers['fly-client-ip'] ?? req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress
function allow(ip, kind, max, windowMs) {
  const k = `${kind}:${ip}`, cutoff = Date.now() - windowMs, list = (hits.get(k) ?? []).filter((t) => t > cutoff)
  if (list.length >= max) return false
  list.push(Date.now()); hits.set(k, list)
  return true
}
const readRecord = (handle) => { const f = join(DATA, 'reports', `${key(handle)}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const handle = queue.shift()
    running++
    rate(handle).catch((e) => {
      console.error('rating failed', handle, e.message)
      db.prepare("update ratings set status = 'failed', error = ?, finished_at = ? where handle = ?").run(e.message.slice(0, 200), now(), key(handle))
    }).finally(() => { running--; live.delete(key(handle)); pump() })
  }
}

async function rate(handle) {
  const state = { log: [] }, previous = row(handle)?.agent_id
  live.set(key(handle), state)
  db.prepare("update ratings set status = 'running' where handle = ?").run(key(handle))
  state.log.push({ t: Date.now(), step: 'Pulling the account from X' })
  const raw = await fetchAccount(handle)
  writeFileSync(join(DATA, 'raw', `${key(handle)}.json`), JSON.stringify(raw))
  const data = analyze(raw)
  if (data.stats.analyzed < 5) throw new Error('Not enough posts to rate yet.')
  db.prepare('update ratings set name = ?, avatar = ?, followers = ?, screen_name = ? where handle = ?').run(data.profile.name, data.profile.avatar, data.profile.followers, data.profile.handle, key(handle))
  const { agentId, report } = await judge(data, (entry) => state.log.push(entry))
  const words = [report.archetype, report.verdict, report.topics_note, report.hooks, report.best_post.why, report.worst_post.why, ...report.what_works, ...report.fixes.flatMap((f) => [f.title, f.detail]), ...Object.values(report.breakdown).map((b) => b.note)].join('\n')
  if (!(await moderate(words))) throw new Error('The judge wrote something we cannot publish. Try again.')
  const byId = new Map(data.posts.map((p) => [p.id, p]))
  const post = async (id) => { const p = byId.get(id); return p && ((await moderate(p.text)) ? p : { ...p, text: '[post hidden]', hidden: true }) }
  const open = openers(data.posts)
  if (open) {
    const n = open.top.length, ok = await moderate([...open.top, ...open.bottom].map((o) => o.text))
    open.top = open.top.filter((_, i) => ok[i]); open.bottom = open.bottom.filter((_, i) => ok[n + i])
  }
  const record = {
    profile: data.profile,
    stats: data.stats,
    report: { ...report, best_post: { ...report.best_post, post: await post(report.best_post.id) }, worst_post: { ...report.worst_post, post: await post(report.worst_post.id) } },
    openers: open,
    timeline: data.posts.map((p) => [p.date, p.views, p.likes, p.type === 'reply' ? 1 : 0]),
    log: state.log,
    agentId,
    ratedAt: now(),
  }
  writeFileSync(join(DATA, 'reports', `${key(handle)}.json`), JSON.stringify(record))
  writeFileSync(join(DATA, 'cards', `${key(handle)}.png`), await renderCard(record))
  db.prepare("update ratings set status = 'done', score = ?, verdict = ?, agent_id = ?, error = null, finished_at = ? where handle = ?").run(report.score, report.verdict, agentId, now(), key(handle))
  if (previous && previous !== agentId) api('POST', `/agents/${previous}/archive`).catch(() => {})
}

function request(handle) {
  if (!HANDLE.test(handle)) return { status: 400, error: "That's not a valid X handle." }
  const existing = row(handle)
  if (existing && existing.status !== 'failed') return { handle: key(handle) }
  const today = db.prepare("select count(*) n from ratings where created_at >= ?").get(now().slice(0, 10)).n
  if (today >= DAILY_LIMIT) return { status: 429, error: "We're out of ratings for today. Come back tomorrow." }
  db.prepare("insert into ratings (handle, status, created_at) values (?, 'queued', ?) on conflict(handle) do update set status = 'queued', error = null, created_at = excluded.created_at").run(key(handle), now())
  queue.push(handle); pump()
  return { handle: key(handle) }
}

async function start(req, res) {
  if (!LOCAL.test(req.socket.remoteAddress) || req.headers['fly-client-ip'] || req.headers['x-forwarded-for']) return send(res, 403, { error: 'Ratings start from replies on X.' })
  const out = request(String((await readBody(req)).handle ?? '').trim().replace(/^@/, ''))
  send(res, out.status ?? 200, out)
}

async function question(req, res) {
  const body = await readBody(req), handle = String(body.handle ?? ''), q = String(body.question ?? '').trim()
  if (q.length < 3 || q.length > 280) return send(res, 400, { error: 'Ask a question between 3 and 280 characters.' })
  const r = HANDLE.test(handle) && row(handle)
  if (!r || r.status !== 'done' || !r.agent_id) return send(res, 404, { error: 'This account has no report yet.' })
  if (!allow(clientIp(req), 'ask', QUESTIONS_PER_IP, 3600000)) return send(res, 429, { error: "You've asked a lot this hour. Try again later." })
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' })
  const line = (o) => res.write(JSON.stringify(o) + '\n')
  try {
    const data = analyze(JSON.parse(readFileSync(join(DATA, 'raw', `${key(handle)}.json`), 'utf8')))
    const answer = await ask(r.agent_id, data, q, (step) => line({ step }))
    line({ answer: (await moderate(answer)) ? answer : "The judge's answer was hidden. Try another question." })
  } catch (e) {
    console.error('ask failed', handle, e.message)
    line({ error: 'The judge could not answer that. Try again.' })
  }
  res.end()
}

function status(res, handle) {
  const r = row(handle)
  if (!r) return send(res, 404, { error: 'Not rated yet.' })
  send(res, 200, {
    status: r.status, error: r.error, screen_name: r.screen_name,
    position: r.status === 'queued' ? queue.indexOf(queue.find((h) => key(h) === r.handle)) + 1 : 0,
    log: live.get(r.handle)?.log ?? [],
    record: r.status === 'done' ? readRecord(handle) : null,
  })
}

function leaderboard(res, query) {
  const q = query.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_ ]/g, '').slice(0, 30)
  const ranked = `select row_number() over (order by score desc, finished_at asc) rank, coalesce(screen_name, handle) handle, name, avatar, followers, score, verdict from ratings where status = 'done' and ${LISTED}`
  send(res, 200, {
    rows: q ? db.prepare(`select * from (${ranked}) where handle like ? or lower(name) like ? limit 50`).all(...UNLISTED, `%${q}%`, `%${q}%`) : db.prepare(`${ranked} limit 200`).all(...UNLISTED),
    live: db.prepare(`select coalesce(screen_name, handle) handle, name, avatar, status from ratings where status in ('queued', 'running') and ${LISTED} order by created_at limit 20`).all(...UNLISTED),
  })
}

function page(req, res, file, { title = 'Judge My 𝕏', description = 'An AI agent reads your last 200 posts, scores your account out of 10, and roasts you.', image = '/og.png' } = {}) {
  const origin = process.env.PUBLIC_URL ?? `http://${req.headers.host}`
  const tags = [
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(origin + req.url)}">`,
    `<meta property="og:image" content="${esc(origin + image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:creator" content="@${esc(X_HANDLE)}">`,
  ].join('\n')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(readFileSync(join(SITE, file), 'utf8').replace('</title>', `</title>\n${tags}`).replaceAll('%LAUNCH_URL%', esc(LAUNCH_URL)).replaceAll('%X_HANDLE%', esc(X_HANDLE)).replaceAll('%X_INITIAL%', esc(X_HANDLE[0].toUpperCase())).replace('<!--REPO-->', process.env.REPO_URL ? `<a class="btn ghost" href="${esc(process.env.REPO_URL)}" target="_blank">View the code</a>` : '').replace('<!--REPO_NAV-->', process.env.REPO_URL ? `<a class="gh" href="${esc(process.env.REPO_URL)}" target="_blank">GitHub</a>` : '').replaceAll('%LAUNCH_TEXT%', esc(LAUNCH_TEXT)))
}

let homeCard
async function sendHomeCard(res) {
  homeCard ??= await renderHomeCard()
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }); res.end(homeCard)
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
function serveStatic(res, path) {
  const file = normalize(join(SITE, path))
  if (!file.startsWith(SITE) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'Not found.' })
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), path = url.pathname
  try {
    if (req.method === 'POST' && path === '/api/rate') return await start(req, res)
    if (req.method === 'POST' && path === '/api/ask') return await question(req, res)
    if (path === '/api/leaderboard') return leaderboard(res, url.searchParams.get('q') ?? '')
    if (path === '/og.png') return await sendHomeCard(res)
    let m = path.match(/^\/api\/rating\/([A-Za-z0-9_]{1,15})$/)
    if (m) return status(res, m[1])
    m = path.match(/^\/card\/([A-Za-z0-9_]{1,15})\.png$/)
    if (m) {
      const file = join(DATA, 'cards', `${key(m[1])}.png`)
      if (!existsSync(file)) return send(res, 404, { error: 'No card yet.' })
      res.writeHead(200, { 'Content-Type': 'image/png' }); return createReadStream(file).pipe(res)
    }
    if (path === '/') return page(req, res, 'index.html')
    if (path === '/how') return page(req, res, 'how.html', { title: 'How it works · Judge My 𝕏', description: 'Every rating is done by its own AI agent on Omnara. It reads your posts, crunches your numbers, and writes the verdict.' })
    m = path.match(/^\/@([A-Za-z0-9_]{1,15})$/)
    if (m) {
      const r = row(m[1])
      return page(req, res, 'report.html', r?.status === 'done' ? { title: `@${r.screen_name ?? r.handle} scored ${r.score.toFixed(1)}/10 on Judge My 𝕏`, description: r.verdict, image: `/card/${r.handle}.png` } : {})
    }
    return serveStatic(res, path)
  } catch (e) {
    console.error(e); send(res, 500, { error: 'Something went wrong.' })
  }
}).listen(PORT, () => console.log(`listening on http://localhost:${PORT}`))

startBot({ db, request, row, readRecord, handle: X_HANDLE, logFile: join(DATA, 'replies.log') })
