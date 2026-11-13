export const scoreColor = (s) => (s >= 9 ? '#f5b800' : s >= 8 ? '#34c759' : s >= 6 ? '#0a84ff' : s >= 4 ? '#ff9500' : '#ff3b30')
export const tier = (s) => (s >= 9 ? 'Top tier' : s < 3 ? 'Cooked' : null)
export const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n)))
export const realName = (name, handle) => (name && name.replace(/^@/, '').toLowerCase() !== handle.toLowerCase() ? name : null)
