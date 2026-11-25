const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "a", "o"])

export function fold(value) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim()
}

export function streetKey(value) {
  return fold(value)
    .replace(/-/g, " ")
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z0-9]/g, ""))
    .filter((part) => part && !SMALL.has(part))
    .join(" ")
}

function byKey(a, b) {
  if (a.key < b.key) return -1
  if (a.key > b.key) return 1
  return (a.rank ?? 9) - (b.rank ?? 9)
}

export function preparePlaces(rows) {
  return rows
    .map((row) => ({ name: row[0], lat: row[1], lon: row[2], rank: row[3] ?? 4, key: fold(row[0]) }))
    .sort(byKey)
}

export function prepareStreets(rows) {
  return rows
    .map((row) => ({ name: row[0], lat: row[1], lon: row[2], rank: 5, key: fold(row[0]) }))
    .sort(byKey)
}

function lowerBound(items, query) {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].key < query) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function searchNames(items, query, limit) {
  const q = fold(query)
  if (q.length < 2) return []
  const start = lowerBound(items, q)
  const pool = []
  for (let i = start; i < items.length && pool.length < 40; i += 1) {
    if (!items[i].key.startsWith(q)) break
    pool.push(items[i])
  }
  pool.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "pt"))
  return pool.slice(0, limit)
}
