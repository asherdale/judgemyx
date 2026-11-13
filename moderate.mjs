export async function moderate(input) {
  const list = Array.isArray(input) ? input : [input]
  if (!process.env.OPENAI_API_KEY) return Array.isArray(input) ? list.map(() => true) : true
  const results = []
  try {
    for (let i = 0; i < list.length; i += 32) {
      const chunk = list.slice(i, i + 32).map((t) => String(t || ' '))
      const res = await fetch('https://api.openai.com/v1/moderations', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'omni-moderation-latest', input: chunk }) })
      if (!res.ok) throw new Error(`moderation ${res.status}`)
      results.push(...(await res.json()).results.map((r) => !r.flagged))
    }
  } catch {
    return Array.isArray(input) ? list.map(() => false) : false
  }
  return Array.isArray(input) ? results : results[0]
}
