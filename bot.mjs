import { appendFileSync } from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'

const POLL = Number(process.env.BOT_POLL_SECONDS ?? 5) * 1000
const OVERLAP = 20
const LIVE = process.env.X_POST === '1'
const PER_AUTHOR = Number(process.env.RATINGS_PER_AUTHOR ?? 3)
const ACTIVE = "status in ('waiting', 'replied', 'dry-run', 'failed')"

export function parseRequest(t, bot) {
  const text = t.text ?? '', range = t.displayTextRange
  const context = [bot, t.inReplyToUsername].filter(Boolean).join('|')
  const body = Array.isArray(range) ? [...text].slice(range[0]).join('') : text.replace(new RegExp(`^(\\s*@(${context})\\b)+`, 'i'), '')
  const tag = [...body.matchAll(/(?<![\w@])@(\w{1,15})/g)].map((m) => m[1]).find((h) => h.toLowerCase() !== bot)
  return tag ?? t.author?.userName
}

export function replyText(record, url) {
  return `@${record.profile.handle} has been judged: ${record.report.score.toFixed(1)}/10\n${url}`
}

const quote = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
function oauth(method, url) {
  const params = { oauth_consumer_key: process.env.X_APP_CONSUMER_KEY, oauth_nonce: randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: process.env.X_ACCESS_TOKEN, oauth_version: '1.0' }
  const base = [method, quote(url), quote(Object.keys(params).sort().map((k) => `${quote(k)}=${quote(params[k])}`).join('&'))].join('&')
  params.oauth_signature = createHmac('sha1', `${quote(process.env.X_APP_CONSUMER_KEY_SECRET)}&${quote(process.env.X_ACCESS_SECRET)}`).update(base).digest('base64')
  return 'OAuth ' + Object.keys(params).sort().map((k) => `${quote(k)}="${quote(params[k])}"`).join(', ')
}

async function post(url, body, contentType) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: oauth('POST', url), 'Content-Type': contentType }, body })
  if (!res.ok) throw Object.assign(new Error(`X ${res.status} ${(await res.text()).slice(0, 200)}`), { status: res.status })
  return res.json()
}

async function publish(text, replyTo) {
  return post('https://api.x.com/2/tweets', JSON.stringify({ text, reply: { in_reply_to_tweet_id: replyTo } }), 'application/json')
}

async function replies(since) {
  const out = []
  let cursor = ''
  for (let page = 0; page < 5; page++) {
    const res = await fetch(`https://api.twitterapi.io/twitter/tweet/replies?tweetId=${process.env.LAUNCH_POST_ID}&sinceTime=${since}&cursor=${encodeURIComponent(cursor)}`, { headers: { 'X-API-Key': process.env.TWITTERAPI_KEY } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.status === 'error') throw new Error(body.msg || `twitterapi.io ${res.status}`)
    out.push(...(body.tweets ?? []))
    if (!body.has_next_page || !body.next_cursor || !body.tweets?.length) break
    cursor = body.next_cursor
  }
  return out
}

export function startBot({ db, request, row, readRecord, handle, logFile }) {
  if (!process.env.LAUNCH_POST_ID || !process.env.TWITTERAPI_KEY) return
  if (LIVE && !process.env.PUBLIC_URL) throw new Error('Set PUBLIC_URL so replies on X link to your site')
  const bot = handle.toLowerCase(), site = process.env.PUBLIC_URL ?? 'http://localhost:8788'
  db.exec('create table if not exists mentions (tweet_id text primary key, author text, target text, status text, note text, posted_at text, created_at text, replied_at text)')
  let since = Math.floor(Date.now() / 1000) - Number(process.env.BOT_LOOKBACK_HOURS ?? 24) * 3600
  const note = (id, status, text) => db.prepare('update mentions set status = ?, note = ?, replied_at = ? where tweet_id = ?').run(status, text, new Date().toISOString(), id)
  const log = (line) => { console.log('bot', line); appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) }

  async function check() {
    const started = Math.floor(Date.now() / 1000) - OVERLAP
    for (const t of await replies(since)) {
      const author = t.author?.userName ?? ''
      const own = author.toLowerCase() === bot
      if (!author || (own && String(t.inReplyToId) !== String(process.env.LAUNCH_POST_ID)) || db.prepare('select 1 from mentions where tweet_id = ?').get(String(t.id))) continue
      const target = parseRequest(t, bot)
      const today = db.prepare(`select count(*) n from mentions where lower(author) = lower(?) and ${ACTIVE} and created_at > ?`).get(author, new Date(Date.now() - 86400000).toISOString()).n
      const repeat = db.prepare(`select 1 from mentions where lower(author) = lower(?) and lower(target) = lower(?) and ${ACTIVE}`).get(author, target)
      const posted = Date.parse(t.createdAt) ? new Date(t.createdAt).toISOString() : null
      db.prepare('insert into mentions (tweet_id, author, target, status, posted_at, created_at) values (?, ?, ?, ?, ?, ?)').run(String(t.id), author, target, repeat ? 'repeat' : 'waiting', posted, new Date().toISOString())
      if (repeat) continue
      if (today >= PER_AUTHOR) { note(String(t.id), 'skipped', `@${author} already asked for ${PER_AUTHOR} ratings today`); continue }
      const out = request(target)
      if (out.error) note(String(t.id), 'skipped', out.error)
    }
    since = started
  }

  async function deliver() {
    for (const m of db.prepare("select * from mentions where status = 'waiting' order by created_at").all()) {
      const r = row(m.target)
      if (!r || r.status === 'failed') { note(m.tweet_id, 'failed', r?.error ?? 'not queued'); continue }
      if (r.status !== 'done') continue
      const text = replyText(readRecord(m.target), `${site}/@${readRecord(m.target).profile.handle}`)
      const after = m.posted_at ? ` ${Math.round((Date.now() - Date.parse(m.posted_at)) / 1000)}s after they posted` : ''
      if (!LIVE) { note(m.tweet_id, 'dry-run', text); log(`would reply to ${m.tweet_id} (@${m.author})${after}: ${JSON.stringify(text)}`); continue }
      try {
        await publish(text, m.tweet_id)
        note(m.tweet_id, 'replied', text)
        log(`replied to ${m.tweet_id} (@${m.author})${after}`)
      } catch (e) {
        if (e.status === 429 || e.status >= 500) { log(`will retry ${m.tweet_id}: ${e.message}`); break }
        note(m.tweet_id, 'failed', e.message); log(`gave up on ${m.tweet_id}: ${e.message}`)
      }
    }
  }

  const every = (fn, ms) => { const run = () => fn().catch((e) => console.error('bot', fn.name, 'failed', e.message)).finally(() => setTimeout(run, ms)); run() }
  every(check, POLL)
  every(deliver, 1000)
  console.log(`bot watching replies to ${process.env.LAUNCH_POST_ID} (${LIVE ? 'live' : 'dry run'})`)
}
