import { existsSync, readFileSync } from 'node:fs'

const API = 'https://api.twitterapi.io'
const MAX_PAGES = 10

async function call(path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, { headers: { 'X-API-Key': process.env.TWITTERAPI_KEY } })
    if (res.status === 429 && attempt < 60) { await new Promise((r) => setTimeout(r, Math.min(5500, 400 * attempt))); continue }
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.status === 'error') throw new Error(body.msg || `twitterapi.io ${res.status}`)
    return body
  }
}

export async function fetchAccount(handle) {
  const fixture = new URL(`./fixtures/${handle.toLowerCase()}.json`, import.meta.url)
  if (existsSync(fixture)) return JSON.parse(readFileSync(fixture, 'utf8'))
  if (!process.env.TWITTERAPI_KEY) throw new Error('No X data source configured.')
  const user = (await call(`/twitter/user/info?userName=${encodeURIComponent(handle)}`)).data
  if (!user || user.unavailable) throw new Error('That account is unavailable.')
  if (user.protected) throw new Error('That account is private.')
  const tweets = []
  let cursor = '', pinned = null
  for (let n = 0; n < MAX_PAGES; n++) {
    const body = await call(`/twitter/user/last_tweets?userId=${user.id}&includeReplies=true&cursor=${encodeURIComponent(cursor)}`)
    pinned ??= body.data?.pin_tweet ?? null
    tweets.push(...(body.data?.tweets ?? []))
    if (!body.has_next_page || !body.next_cursor) break
    cursor = body.next_cursor
  }
  return { user, tweets, pinned, fetchedAt: new Date().toISOString() }
}

const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const round = (n) => Math.round(n * 10) / 10
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const clamp01 = (n) => Math.min(1, Math.max(0, n))
const pct = (list, test) => (list.length ? Math.round((list.filter(test).length / list.length) * 100) : 0)
const clean = (t) => t.replace(/https?:\/\/t\.co\/\w+/g, '').trim()
const engaged = (p) => (p.views ? round(((p.likes + p.reposts + p.replies + p.quotes) / p.views) * 1000) : 0)
const old = (p) => Date.now() - Date.parse(p.date) > 86400000

function normalize(t) {
  const date = new Date(t.createdAt)
  return {
    id: String(t.id),
    url: t.url,
    text: t.text ?? '',
    firstLine: clean(t.text ?? '').split('\n').find((l) => l.trim())?.trim() ?? '',
    date: date.toISOString(),
    type: t.isReply ? 'reply' : t.quoted_tweet ? 'quote' : 'original',
    replyTo: t.inReplyToUsername || null,
    likes: t.likeCount ?? 0,
    reposts: t.retweetCount ?? 0,
    replies: t.replyCount ?? 0,
    quotes: t.quoteCount ?? 0,
    views: t.viewCount ?? 0,
    bookmarks: t.bookmarkCount ?? 0,
    links: t.entities?.urls?.length ?? 0,
    hour: date.getUTCHours(),
    weekday: DAYS[date.getUTCDay()],
  }
}

function group(posts) {
  return {
    count: posts.length,
    medianViews: median(posts.map((p) => p.views)),
    medianLikes: median(posts.map((p) => p.likes)),
    totalLikes: posts.reduce((s, p) => s + p.likes, 0),
  }
}

export function analyze({ user, tweets: all, pinned }) {
  const mine = (t) => String(t.author?.id ?? '') === String(user.id) || t.author?.userName?.toLowerCase() === user.userName.toLowerCase()
  const tweets = all.filter((t) => !t.author || mine(t))
  const reposts = tweets.filter((t) => t.retweeted_tweet)
  const posts = tweets.filter((t) => !t.retweeted_tweet).map(normalize).sort((a, b) => b.date.localeCompare(a.date))
  const originals = posts.filter((p) => p.type !== 'reply'), replies = posts.filter((p) => p.type === 'reply')
  const days = posts.length > 1 ? Math.max(1, (Date.parse(posts[0].date) - Date.parse(posts.at(-1).date)) / 86400000) : 1
  const bucket = (list, key, keys) => keys.map((k) => ({ key: k, ...group(list.filter((p) => key(p) === k)) }))
  const length = (p) => (p.text.length < 80 ? 'short' : p.text.length <= 200 ? 'medium' : 'long')
  const replyTargets = Object.entries(replies.reduce((m, p) => ((m[p.replyTo] = (m[p.replyTo] ?? 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([handle, count]) => ({ handle, count }))
  const profile = {
    handle: user.userName,
    name: user.name,
    bio: user.description ?? '',
    location: user.location ?? '',
    website: user.url ?? '',
    followers: user.followers ?? 0,
    following: user.following ?? 0,
    totalPosts: user.statusesCount ?? 0,
    joined: user.createdAt,
    verified: !!user.isBlueVerified,
    avatar: (user.profilePicture ?? '').replace('_normal', '_400x400'),
    hasBanner: !!user.coverPicture,
    pinned: pinned ? { text: pinned.text, likes: pinned.likeCount ?? 0, views: pinned.viewCount ?? 0, date: new Date(pinned.createdAt).toISOString() } : null,
  }
  const stats = {
    analyzed: posts.length,
    reposts: reposts.length,
    from: posts.at(-1)?.date ?? null,
    to: posts[0]?.date ?? null,
    postsPerWeek: round((posts.length / days) * 7),
    originals: group(originals),
    replies: group(replies),
    replyShare: posts.length ? Math.round((replies.length / posts.length) * 100) : 0,
    medianEngagementPer1kViews: median(posts.filter((p) => p.views).map(engaged)),
    byLength: bucket(originals, length, ['short', 'medium', 'long']),
    withLinks: group(originals.filter((p) => p.links)),
    withoutLinks: group(originals.filter((p) => !p.links)),
    byHourUTC: bucket(originals, (p) => p.hour, [...Array(24).keys()]),
    byWeekdayUTC: bucket(originals, (p) => p.weekday, DAYS),
    mostRepliedTo: replyTargets,
    hooks: hooks(originals),
    scores: scores(posts, originals, profile, days),
  }
  return { profile, stats, posts }
}

export function listPosts(posts, { sort = 'recent', type = 'all', limit = 10, offset = 0 } = {}) {
  const pool = posts.filter((p) => type === 'all' || (type === 'original' ? p.type !== 'reply' : p.type === type))
  const sorted = sort === 'top' ? [...pool].sort((a, b) => b.views - a.views || b.likes - a.likes)
    : sort === 'worst' ? [...pool].filter((p) => Date.now() - Date.parse(p.date) > 86400000).sort((a, b) => a.views - b.views || a.likes - b.likes)
    : pool
  const n = Math.min(20, Math.max(1, Number(limit) || 10)), o = Math.max(0, Number(offset) || 0)
  return { total: pool.length, posts: sorted.slice(o, o + n).map(({ id, date, type, replyTo, text, likes, reposts, replies, quotes, views }) => ({ id, date, type, replyTo, text: text.slice(0, 400), likes, reposts, replies, quotes, views })) }
}

function hooks(originals) {
  const sorted = originals.filter(old).sort((a, b) => b.views - a.views)
  if (sorted.length < 8) return null
  const q = Math.floor(sorted.length / 4)
  const traits = (list) => ({
    posts: list.length,
    medianViews: median(list.map((p) => p.views)),
    opensWithQuestion: pct(list, (p) => p.firstLine.includes('?')),
    opensWithNumber: pct(list, (p) => /\d/.test(p.firstLine)),
    multiLine: pct(list, (p) => clean(p.text).includes('\n')),
    lowercaseStart: pct(list, (p) => /^[a-z]/.test(p.firstLine)),
    medianFirstLineChars: median(list.map((p) => p.firstLine.length)),
  })
  return { topQuarter: traits(sorted.slice(0, q)), bottomQuarter: traits(sorted.slice(-q)) }
}

function scores(posts, originals, profile, days) {
  const span = Math.max(1, Math.ceil(days)), perWeek = (originals.length / days) * 7
  const active = new Set(originals.map((p) => p.date.slice(0, 10))).size
  const sinceLast = posts.length ? (Date.now() - Date.parse(posts[0].date)) / 86400000 : 999
  const viewed = originals.filter((p) => p.views)
  const rate = median(viewed.map(engaged)), views = median(viewed.map((p) => p.views))
  const consistency = 0.4 * clamp01(perWeek / 7) + 0.4 * clamp01(active / span / 0.6) + 0.2 * (1 - clamp01((sinceLast - 7) / 83))
  const engagement = 0.5 * (rate > 0 ? clamp01(Math.log10(rate / 3) / Math.log10(40 / 3)) : 0) + 0.5 * (views > 0 ? clamp01((Math.log10(views) - 2) / 3) : 0)
  return {
    consistency: { score: round(consistency * 10), basis: `${round(perWeek)} own posts a week, posting on ${active} of the last ${span} days, last post ${Math.round(sinceLast)} days ago` },
    engagement: { score: round(engagement * 10), basis: `a typical own post gets ${Math.round(views).toLocaleString('en-US')} views and ${round(rate)} likes, reposts, replies and quotes per 1,000 views` },
  }
}

const ownPosts = (posts) => posts.filter((p) => p.type !== 'reply').slice(0, 150)

export function allOriginals(posts) {
  return ownPosts(posts).map((p, n) => ({ n, views: p.views, likes: p.likes, text: clean(p.text).replace(/\s+/g, ' ').slice(0, 140) }))
}

export function topicStats(posts, topics) {
  const own = ownPosts(posts)
  if (!Array.isArray(topics) || topics.length < 2 || topics.length > 6) return 'Use 2 to 6 topics.'
  const out = []
  for (const t of topics) {
    const name = String(t?.name ?? '').trim(), list = [...new Set(t?.posts ?? [])].map((n) => own[n]).filter(Boolean)
    if (!name || name.length > 30) return 'Every topic needs a name of at most 30 characters.'
    if (!list.length) return `Topic "${name}" has no valid posts. Use the n values from the list in the first message.`
    out.push({ name, posts: list.length, share: Math.round((list.length / own.length) * 100), medianViews: median(list.map((p) => p.views)), medianLikes: median(list.map((p) => p.likes)) })
  }
  return out.sort((a, b) => b.posts - a.posts)
}

export function openers(posts) {
  const seen = new Set(), sorted = posts.filter((p) => p.type !== 'reply' && old(p) && p.firstLine).sort((a, b) => b.views - a.views)
    .filter((p) => !seen.has(p.firstLine.toLowerCase()) && seen.add(p.firstLine.toLowerCase()))
  if (sorted.length < 6) return null
  const pick = (list) => list.map((p) => ({ text: p.firstLine.slice(0, 120), views: p.views }))
  return { top: pick(sorted.slice(0, 3)), bottom: pick(sorted.slice(-3).reverse()) }
}
