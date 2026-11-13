import { existsSync, readFileSync } from 'node:fs'

const { OMNARA_API_KEY, OMNARA_ORG_ID, OMNARA_PROJECT_ID } = process.env
if (!OMNARA_API_KEY || !OMNARA_ORG_ID || !OMNARA_PROJECT_ID) throw new Error('Set OMNARA_API_KEY, OMNARA_ORG_ID and OMNARA_PROJECT_ID')
const BASE = `https://api.omnara.com/v1/orgs/${OMNARA_ORG_ID}/projects/${OMNARA_PROJECT_ID}`
const HEADERS = { Authorization: `Bearer ${OMNARA_API_KEY}`, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROFILES_FILE = new URL('./agents/profiles.txt', import.meta.url)
if (!existsSync(PROFILES_FILE)) throw new Error('Missing agents/profiles.txt: run `npm run setup` first')
export const PROFILES = Object.fromEntries(
  readFileSync(PROFILES_FILE, 'utf8').trim().split('\n').map((l) => l.split(' ').slice(0, 2)),
)

export async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined })
    if (res.ok) return res.status === 204 ? null : res.json()
    if (res.status === 429 && attempt < 60) { console.warn('omnara rate limited', method); await sleep(Number(res.headers.get('retry-after') ?? 1) * 1000 + Math.random() * 500); continue }
    if (res.status >= 500 && attempt < 5) { await sleep(1000 + attempt * 500); continue }
    throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
}

export async function* sse(path, signal) {
  const res = await fetch(BASE + path, { headers: { ...HEADERS, Accept: 'text/event-stream' }, signal })
  if (!res.ok) throw new Error(`stream ${res.status}`)
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      let event = 'message', data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) yield { event, data: JSON.parse(data) }
    }
  }
}
