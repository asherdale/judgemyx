import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'
import { scoreColor, tier, realName } from './site/ui.js'

GlobalFonts.registerFromPath(fileURLToPath(new URL('./site/fonts/inter.woff2', import.meta.url)), 'Inter')

const W = 1200, H = 630, PAD = 64
const FAMILY = `Inter, 'Noto Sans Math', 'Noto Color Emoji', 'Noto Sans CJK JP', 'Noto Sans', 'Apple Color Emoji', 'Apple Symbols'`
const FG = '#1d1d1f', MUTED = '#6e6e73', LINE = '#ececf0'
const LABELS = { content: 'Content', consistency: 'Consistency', engagement: 'Engagement', profile: 'Profile', originality: 'Originality' }

function wrap(ctx, text, maxWidth, maxLines) {
  const lines = []
  let line = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = w } else line = next
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…') }
  return lines
}

const text = (ctx, str, x, y, { font, color = FG, spacing = '0px', align = 'left' }) => {
  ctx.font = font; ctx.fillStyle = color; ctx.letterSpacing = spacing; ctx.textAlign = align
  ctx.fillText(str, x, y)
  ctx.letterSpacing = '0px'; ctx.textAlign = 'left'
}

export async function renderCard({ profile, report }) {
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d'), color = scoreColor(report.score)
  ctx.fillStyle = '#fbfbfd'; ctx.fillRect(0, 0, W, H)
  if (tier(report.score)) { ctx.strokeStyle = color; ctx.lineWidth = 12; ctx.strokeRect(6, 6, W - 12, H - 12) }

  try {
    const img = await loadImage(Buffer.from(await (await fetch(profile.avatar)).arrayBuffer()))
    ctx.save(); ctx.beginPath(); ctx.arc(PAD + 28, 92, 28, 0, 7); ctx.clip(); ctx.drawImage(img, PAD, 64, 56, 56); ctx.restore()
  } catch {}
  const name = realName(profile.name, profile.handle)
  if (name) {
    text(ctx, name.slice(0, 30), PAD + 72, 88, { font: `600 26px ${FAMILY}`, spacing: '-0.3px' })
    text(ctx, '@' + profile.handle, PAD + 72, 116, { font: `400 20px ${FAMILY}`, color: MUTED })
  } else text(ctx, '@' + profile.handle, PAD + 72, 101, { font: `600 26px ${FAMILY}`, spacing: '-0.3px' })
  text(ctx, 'Judge My 𝕏', W - PAD, 88, { font: `600 24px ${FAMILY}`, align: 'right', spacing: '-0.3px' })
  text(ctx, 'judged by an AI agent on Omnara', W - PAD, 116, { font: `400 18px ${FAMILY}`, color: MUTED, align: 'right' })

  const textW = 620
  let size = 46, roast
  for (; size >= 34; size -= 2) { ctx.font = `600 ${size}px ${FAMILY}`; ctx.letterSpacing = `${-size * 0.03}px`; roast = wrap(ctx, report.verdict, textW, 4); if (roast.length <= 3 || size <= 38) break }
  ctx.letterSpacing = '0px'
  const lh = size * 1.12, archH = report.archetype ? 104 : 0, blockH = archH + 28 + roast.length * lh
  let y = 150 + (340 - blockH) / 2
  if (report.archetype) {
    text(ctx, 'ARCHETYPE', PAD, y + 13, { font: `500 15px ${FAMILY}`, color: MUTED, spacing: '1.2px' })
    text(ctx, report.archetype, PAD, y + 56, { font: `600 34px ${FAMILY}`, spacing: '-0.7px' })
    y += archH
  }
  text(ctx, 'THE ROAST', PAD, y + 13, { font: `500 15px ${FAMILY}`, color: MUTED, spacing: '1.2px' })
  roast.forEach((l, i) => text(ctx, l, PAD, y + 28 + size * 0.92 + i * lh, { font: `600 ${size}px ${FAMILY}`, spacing: `${-size * 0.03}px` }))

  const cx = 960, cy = 312, r = 132
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.08)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r + 16, 0, Math.PI * 2); ctx.fill(); ctx.restore()
  ctx.lineCap = 'round'; ctx.lineWidth = 10
  ctx.strokeStyle = '#f0f0f3'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, report.score / 10) * Math.PI * 2); ctx.stroke()
  text(ctx, report.score.toFixed(1), cx, cy + 30, { font: `600 96px ${FAMILY}`, align: 'center', spacing: '-4px' })
  text(ctx, tier(report.score)?.toUpperCase() ?? 'OUT OF 10', cx, cy + 68, { font: `500 17px ${FAMILY}`, color: MUTED, align: 'center', spacing: '1.2px' })

  const top = 530, left = 460, colW = (W - PAD - left) / 5
  ctx.fillStyle = LINE; ctx.fillRect(PAD, top - 36, W - PAD * 2, 1)
  Object.entries(report.breakdown).forEach(([key, { score: s }], i) => {
    const x = left + i * colW
    text(ctx, LABELS[key], x, top, { font: `500 18px ${FAMILY}`, color: MUTED })
    text(ctx, s.toFixed(1), x, top + 40, { font: `600 32px ${FAMILY}`, spacing: '-0.8px' })
    ctx.fillStyle = LINE; ctx.beginPath(); ctx.roundRect(x, top + 54, colW - 24, 5, 2.5); ctx.fill()
    ctx.fillStyle = FG; ctx.beginPath(); ctx.roundRect(x, top + 54, ((colW - 24) * s) / 10, 5, 2.5); ctx.fill()
  })
  return canvas.toBuffer('image/png')
}

export async function renderHomeCard() {
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fbfbfd'; ctx.fillRect(0, 0, W, H)
  text(ctx, 'Judge My 𝕏', PAD, 96, { font: `600 28px ${FAMILY}`, spacing: '-0.3px' })
  text(ctx, 'How good is your', PAD, 236, { font: `600 64px ${FAMILY}`, spacing: '-2.4px' })
  text(ctx, '𝕏 account, really?', PAD, 310, { font: `600 64px ${FAMILY}`, spacing: '-2.4px' })
  ctx.font = `400 26px ${FAMILY}`
  wrap(ctx, 'An AI agent reads your last 200 posts, scores your account out of 10, and roasts you.', 600, 2)
    .forEach((l, i) => text(ctx, l, PAD, 384 + i * 38, { font: `400 26px ${FAMILY}`, color: MUTED }))
  text(ctx, 'Reply on 𝕏 to get judged  ·  built on Omnara', PAD, 490, { font: `500 22px ${FAMILY}` })

  const cx = 960, cy = 315, r = 140
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.08)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r + 18, 0, Math.PI * 2); ctx.fill(); ctx.restore()
  ctx.lineCap = 'round'; ctx.lineWidth = 11
  ctx.strokeStyle = '#f0f0f3'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  ctx.strokeStyle = scoreColor(7); ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 0.72 * Math.PI * 2); ctx.stroke()
  text(ctx, '?', cx, cy + 36, { font: `600 112px ${FAMILY}`, align: 'center' })
  text(ctx, 'OUT OF 10', cx, cy + 78, { font: `500 18px ${FAMILY}`, color: MUTED, align: 'center', spacing: '1.2px' })
  return canvas.toBuffer('image/png')
}
