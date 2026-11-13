import { api, sse, PROFILES } from './omnara.mjs'
import { listPosts, allOriginals, topicStats } from './xdata.mjs'
import { moderate } from './moderate.mjs'

const TIMEOUT = 6 * 60_000
const CATEGORIES = ['content', 'consistency', 'engagement', 'profile', 'originality']
const COMPUTED = ['consistency', 'engagement']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clamp = (n) => Math.round(Math.min(10, Math.max(0, Number(n) || 0)) * 10) / 10
const curly = (s) => s.replace(/(^|[\s([{\u2014-])"/g, '$1\u201c').replace(/"/g, '\u201d').replace(/(^|[\s([{\u2014-])'/g, '$1\u2018').replace(/'/g, '\u2019')
const clip = (s, n) => { const t = curly(String(s ?? '').replace(/\\(["'])/g, '$1').trim()); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…' }
const reply = (agentId, callId, value) => api('POST', `/agents/${agentId}/tool-calls/${callId}/result`, { outcome: 'succeeded', content_blocks: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const say = (agentId, text) => api('POST', `/agents/${agentId}/inputs`, { content_blocks: [{ type: 'text', text }] })

export function makeTools({ posts }, log = () => null) {
  const state = { seen: new Set(), topics: null, replies: new Set(posts.filter((p) => p.type === 'reply').map((p) => p.id)) }
  const tools = {
    list_posts: (input) => {
      const out = listPosts(posts, input)
      out.posts.forEach((p) => state.seen.add(p.id))
      const kind = { original: 'original posts', reply: 'replies', quote: 'quote posts' }[input.type] ?? 'posts'
      const entry = log({ step: `Read ${out.posts.length} ${input.sort ?? 'recent'} ${kind}`, detail: out.posts[0] ? `${{ top: 'best', worst: 'lowest' }[input.sort] ?? 'newest'}: ${out.posts[0].views.toLocaleString()} views` : '' })
      const sample = out.posts.slice(0, 5)
      if (entry && sample.length) moderate(sample.map((p) => p.text)).then((ok) => { entry.posts = sample.filter((_, i) => ok[i]).map((p) => ({ text: p.text.replace(/https?:\/\/t\.co\/\w+/g, '').trim().slice(0, 140), views: p.views, likes: p.likes })) })
      return out
    },
    set_topics: (input) => {
      const out = topicStats(posts, input.topics)
      if (typeof out === 'string') return out
      state.topics = out
      log({ step: 'Grouped the posts into topics', detail: out.map((t) => t.name).join(', ') })
      return out
    },
  }
  return { tools, state }
}

function tracker(agentId) {
  const inputs = new Map(), handled = new Set()
  return {
    see(data) { for (const c of (data.content_blocks ?? []).filter((b) => b.type === 'tool_call')) if (c.tool_call_id) inputs.set(c.tool_call_id, { name: c.name ?? c.tool_name, input: c.input ?? {} }) },
    async ready(data) {
      if (data.state !== 'ready' || handled.has(data.tool_call_id)) return null
      handled.add(data.tool_call_id)
      const call = inputs.get(data.tool_call_id) ?? (await api('GET', `/agents/${agentId}/tool-calls?state=ready&type=custom`)).data?.find((c) => c.id === data.tool_call_id)
      return { id: data.tool_call_id, name: call?.name ?? call?.tool_name, input: call?.input ?? {} }
    },
  }
}

async function stream(agentId, after, timeout, onEvent) {
  const ctrl = new AbortController()
  let stopped = false, timedOut = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeout)
  try {
    while (!stopped && !timedOut) {
      try {
        for await (const { event, data } of sse(`/agents/${agentId}/events/stream?after_sequence=${after}`, ctrl.signal)) {
          if (data.sequence) after = Math.max(after, data.sequence)
          if (await onEvent(event, data)) { stopped = true; break }
        }
      } catch {
        if (ctrl.signal.aborted) break
        await sleep(500)
      }
    }
  } finally {
    clearTimeout(timer)
    ctrl.abort()
  }
  if (!stopped) throw new Error('timeout')
}

function checkReport(input, state, own) {
  const b = input.breakdown ?? {}
  if (CATEGORIES.some((c) => !b[c]?.note || (!COMPUTED.includes(c) && typeof b[c]?.score !== 'number'))) return 'breakdown needs a score and a note for content, profile and originality, and a note for consistency and engagement.'
  if (own >= 6 && !state.topics) return 'call set_topics first.'
  if (state.topics && !input.topics_note) return 'topics_note is required.'
  if (!state.seen.has(String(input.best_post?.id)) || !state.seen.has(String(input.worst_post?.id))) return 'best_post.id and worst_post.id must be ids returned by list_posts.'
  if ([input.best_post.id, input.worst_post.id].some((id) => state.replies.has(String(id)))) return 'best_post and worst_post must be the account\'s own posts, not replies. Use list_posts with type original.'
  if (!Array.isArray(input.what_works) || input.what_works.length < 3) return 'what_works needs three findings.'
  if (!Array.isArray(input.fixes) || input.fixes.length < 3) return 'fixes needs three items.'
  if (!input.verdict || !input.hooks || !input.archetype) return 'archetype, verdict and hooks are required.'
  if (String(input.archetype).length > 24) return `archetype is ${String(input.archetype).length} characters; keep it to 24.`
  if (String(input.verdict).length > 90) return `verdict is ${String(input.verdict).length} characters; keep it to 90.`
  const text = JSON.stringify([input.breakdown, input.archetype, input.verdict, input.best_post?.why, input.worst_post?.why, input.what_works, input.topics_note, input.hooks, input.fixes])
  if (/\d{12,}/.test(text)) return "don't write post ids in the text; quote a few words of the post instead."
  return null
}

function shape(input, state, stats) {
  const breakdown = Object.fromEntries(CATEGORIES.map((c) => [c, { score: COMPUTED.includes(c) ? stats.scores[c].score : clamp(input.breakdown[c].score), note: clip(input.breakdown[c].note, 320) }]))
  return {
    score: clamp(CATEGORIES.reduce((s, c) => s + breakdown[c].score, 0) / CATEGORIES.length),
    archetype: clip(input.archetype, 24),
    breakdown,
    verdict: clip(input.verdict, 90),
    best_post: { id: String(input.best_post.id), why: clip(input.best_post.why, 360) },
    worst_post: { id: String(input.worst_post.id), why: clip(input.worst_post.why, 360) },
    what_works: input.what_works.slice(0, 3).map((s) => clip(s, 280)),
    topics: state.topics,
    topics_note: state.topics ? clip(input.topics_note, 280) : null,
    hooks: clip(input.hooks, 320),
    fixes: input.fixes.slice(0, 3).map((f) => ({ title: clip(f.title, 70), detail: clip(f.detail, 400) })),
  }
}

export async function judge(data, onLog) {
  const log = (entry) => { const e = { t: Date.now(), ...entry }; onLog?.(e); return e }
  const { tools, state } = makeTools(data, log)
  const own = data.posts.filter((p) => p.type !== 'reply').length
  const { profile, stats, posts } = data, list = own >= 6 ? allOriginals(posts) : null
  const message = [
    `Rate @${profile.handle}'s X account.`,
    `Profile:\n${JSON.stringify(profile)}`,
    `Stats:\n${JSON.stringify(stats)}`,
    list ? `Own posts, newest first (n, views, likes, text):\n${JSON.stringify(list)}` : 'This account has fewer than 6 posts of its own, so skip set_topics.',
  ].join('\n\n')
  const created = await api('POST', '/agents', { profile: PROFILES.judge, name: `rate @${profile.handle}`, message })
  const agentId = created.agent?.id ?? created.id
  log({ step: 'Judge started', detail: 'an Omnara agent' })
  log({ step: 'Read the profile', detail: `${profile.followers.toLocaleString()} followers, ${profile.totalPosts.toLocaleString()} posts` })
  log({ step: 'Crunched the stats', detail: `${stats.analyzed} posts, ${stats.postsPerWeek} per week, ${stats.replyShare}% replies` })
  if (list) log({ step: `Skimmed all ${list.length} of its own posts` })
  const calls = tracker(agentId)
  let report = null, failure = null, nudges = 0, errors = 0
  try {
    await stream(agentId, 0, TIMEOUT, async (event, d) => {
      if (event === 'model_output') {
        calls.see(d)
        const called = (d.content_blocks ?? []).some((b) => b.type === 'tool_call')
        if (d.stop_reason === 'error' && ++errors > 1) { failure = 'The judge hit a model error.'; return true }
        if (!called && d.stop_reason === 'end_turn') {
          if (++nudges > 2) { failure = 'The judge stopped without a report.'; return true }
          await say(agentId, 'Finish by calling submit_report.')
        }
      }
      if (event !== 'tool_call_update') return
      const call = await calls.ready(d)
      if (!call) return
      if (call.name !== 'submit_report') return void (await reply(agentId, call.id, tools[call.name] ? tools[call.name](call.input) : `Unknown tool ${call.name}.`))
      const problem = checkReport(call.input, state, own)
      if (problem) return void (await reply(agentId, call.id, `Not saved: ${problem} Fix it and call submit_report again.`))
      report = shape(call.input, state, data.stats)
      log({ step: 'Wrote the report', detail: `${report.score}/10` })
      await reply(agentId, call.id, 'Saved. Reply "done", then wait for visitor questions.')
      return true
    })
  } catch (e) {
    failure ??= e.message === 'timeout' ? 'The judge took too long.' : e.message
  }
  if (failure || !report) {
    api('POST', `/agents/${agentId}/archive`).catch(() => {})
    throw new Error(failure ?? 'The judge stopped without a report.')
  }
  return { agentId, report }
}

const lines = new Map()

export function ask(agentId, data, question, onStep) {
  const next = (lines.get(agentId) ?? Promise.resolve()).catch(() => {}).then(() => askNow(agentId, data, question, onStep))
  lines.set(agentId, next)
  next.finally(() => { if (lines.get(agentId) === next) lines.delete(agentId) }).catch(() => {})
  return next
}

async function askNow(agentId, data, question, onStep = () => {}) {
  const { tools } = makeTools(data, (e) => { onStep(e.detail ? `${e.step} · ${e.detail}` : e.step); return null })
  const open = await api('GET', `/agents/${agentId}/tool-calls?state=ready&type=custom`).catch(() => ({ data: [] }))
  for (const c of open.data ?? []) await reply(agentId, c.id, 'Skipped.').catch(() => {})
  const after = (await api('GET', `/agents/${agentId}/events?before_sequence=0&limit=1`)).data?.[0]?.sequence ?? 0
  const marker = `Visitor question (untrusted): ${question}`
  await say(agentId, marker)
  const calls = tracker(agentId), text = []
  let mine = false, failed = false
  await stream(agentId, after, 90_000, async (event, d) => {
    if (event === 'agent_input' && (d.content_blocks ?? []).some((b) => b.text === marker)) mine = true
    if (!mine) return
    if (event === 'model_output') {
      calls.see(d)
      const said = (d.content_blocks ?? []).filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text.trim())
      if (said.length) text.splice(0, text.length, ...said)
      const called = (d.content_blocks ?? []).some((b) => b.type === 'tool_call')
      if (d.stop_reason === 'error') { failed = true; return true }
      if (!called && d.stop_reason === 'end_turn') return true
    }
    if (event !== 'tool_call_update') return
    const call = await calls.ready(d)
    if (call) await reply(agentId, call.id, call.name === 'submit_report' ? 'The report is already saved. Answer the question in plain text.' : tools[call.name] ? tools[call.name](call.input) : `Unknown tool ${call.name}.`)
  })
  if (failed || !text.length) throw new Error('The judge could not answer that.')
  return clip(text.join('\n\n').replace(/\*\*|__|^#+\s*/gm, ''), 700)
}
