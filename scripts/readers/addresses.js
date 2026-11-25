import { fold, streetKey } from "./search.js"

const TYPES = new Set([
  "rua", "avenida", "travessa", "largo", "praca", "calcada", "estrada", "urbanizacao",
  "quinta", "caminho", "alameda", "beco", "rotunda", "praceta", "vila", "bairro",
  "calcadinha", "ponte", "parque", "patio", "ruela", "sitio", "azinhaga", "viela",
  "campo", "casal", "canada", "escadas", "ladeira", "monte", "jardim", "impasse",
  "acesso", "adro", "autoestrada", "transversal", "vereda", "via",
])

function readString(view, bytes, offset) {
  const length = view.getUint16(offset, true)
  const start = offset + 2
  const text = new TextDecoder().decode(bytes.subarray(start, start + length))
  return [text, start + length]
}

export async function openAddressBook(file) {
  const headBytes = new Uint8Array(await file.slice(0, 28).arrayBuffer())
  const head = new DataView(headBytes.buffer)
  const magic = String.fromCharCode(...headBytes.subarray(0, 4))
  if (magic !== "ADR1" || head.getUint32(24, true) !== 18) {
    throw new Error("addresses")
  }
  const streetCount = head.getUint32(4, true)
  const cityCount = head.getUint32(8, true)
  const numberCount = head.getUint32(12, true)
  const recordOffset = head.getUint32(20, true)
  const indexBytes = new Uint8Array(await file.slice(0, recordOffset).arrayBuffer())
  const view = new DataView(indexBytes.buffer)
  let offset = 28
  const cities = []
  const cityKeys = new Set()
  for (let i = 0; i < cityCount; i += 1) {
    const [text, next] = readString(view, indexBytes, offset)
    cities.push(text)
    cityKeys.add(streetKey(text))
    offset = next
  }
  const numbers = []
  for (let i = 0; i < numberCount; i += 1) {
    const [text, next] = readString(view, indexBytes, offset)
    numbers.push(text)
    offset = next
  }
  const streets = []
  for (let i = 0; i < streetCount; i += 1) {
    const [name, next] = readString(view, indexBytes, offset)
    const first = view.getUint32(next, true)
    const count = view.getUint32(next + 4, true)
    streets.push({ name, key: streetKey(name), first, count })
    offset = next + 8
  }
  const book = { file, recordOffset, cities, numbers, streets, cityKeys }
  await prepareNearest(book)
  if (!book.grid?.ready) throw new Error("addresses")
  return book
}

function lowerBound(streets, query) {
  let lo = 0
  let hi = streets.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (streets[mid].key < query) lo = mid + 1
    else hi = mid
  }
  return lo
}

function formatPostcode(value) {
  if (!value) return ""
  const head = String(Math.floor(value / 1000)).padStart(4, "0")
  const tail = String(value % 1000).padStart(3, "0")
  return `${head}-${tail}`
}

function formatAddress(street, number, postcode, city) {
  const code = formatPostcode(postcode)
  return code ? `${street} ${number}, ${code} ${city}` : `${street} ${number}, ${city}`
}

function doorScore(house, query) {
  const left = fold(house).replace(/[^a-z0-9]/g, "")
  const right = fold(query).replace(/[^a-z0-9]/g, "")
  if (!right) return 0
  if (left === right) return 0
  if (left.startsWith(right) && !/\d/.test(left.slice(right.length))) return 1
  return -1
}

function tokensOf(query) {
  const post = fold(query).match(/\b(\d{4})-?(\d{3})\b/)
  const without = fold(query)
    .replace(/\b(\d{4})-?(\d{3})\b/g, " ")
    .replace(/\b(nº|n°|nr|num|numero)\b/g, " ")
  const tokens = without.split(/[^a-z0-9]+/).filter(Boolean)
  return { tokens, postcode: post ? `${post[1]}-${post[2]}` : "" }
}

function isStreet(tokens) {
  const key = streetKey(tokens.join(" "))
  const words = key.split(" ").filter(Boolean)
  return words.length >= 2 && words.some((word) => TYPES.has(word)) && words.some((word) => !TYPES.has(word))
}

export function parseDoorQuery(query, cityKeys) {
  const parsed = tokensOf(query)
  let { tokens } = parsed
  let number = ""
  let city = ""
  const peel = () => {
    if (!tokens.length) return false
    if (!number && tokens.length > 1 && /^\d+[a-z]?$/.test(tokens[tokens.length - 1])) {
      number = tokens.pop()
      return true
    }
    if (!city && cityKeys && tokens.length > 1) {
      const max = Math.min(4, tokens.length - 1)
      for (let size = max; size >= 1; size -= 1) {
        const suffix = streetKey(tokens.slice(-size).join(" "))
        const rest = tokens.slice(0, -size)
        if (suffix && cityKeys.has(suffix) && isStreet(rest)) {
          city = suffix
          tokens = rest
          return true
        }
      }
    }
    return false
  }
  while (peel()) {
    /* city and door number sit around the street */
  }
  return { street: streetKey(tokens.join(" ")), number, city, postcode: parsed.postcode }
}

function matchingStreets(book, query, cap = 20) {
  const hits = []
  const start = lowerBound(book.streets, query)
  for (let i = start; i < book.streets.length && hits.length < cap; i += 1) {
    const key = book.streets[i].key
    if (!key.startsWith(query)) break
    if (key === query || key.startsWith(`${query} `)) hits.push(book.streets[i])
  }
  if (hits.length) return hits
  const needle = ` ${query}`
  for (const street of book.streets) {
    if (street.key.endsWith(needle) || street.key.includes(`${needle} `)) hits.push(street)
    if (hits.length >= Math.min(cap, 12)) break
  }
  return hits
}

function publicHit(hit) {
  return { name: hit.name, city: hit.city, lat: hit.lat, lon: hit.lon }
}

async function streetView(book, street) {
  const start = book.recordOffset + street.first * 18
  const bytes = new Uint8Array(await book.file.slice(start, start + street.count * 18).arrayBuffer())
  return new DataView(bytes.buffer)
}

function hitAt(book, street, view, index) {
  const base = index * 18
  const number = book.numbers[view.getUint32(base, true)]
  const city = book.cities[view.getUint16(base + 4, true)]
  const postcode = view.getUint32(base + 6, true)
  return {
    name: formatAddress(street.name, number, postcode, city),
    city,
    lat: view.getInt32(base + 10, true) / 1e6,
    lon: view.getInt32(base + 14, true) / 1e6,
    number,
    postcode,
  }
}

async function doorsMatching(book, street, parsed) {
  const view = await streetView(book, street)
  const hits = []
  const perCity = new Map()
  const broad = !parsed.city && !parsed.number && street.count > 500
  for (let i = 0; i < street.count; i += 1) {
    const hit = hitAt(book, street, view, i)
    if (!hit.city) continue
    if (parsed.city && streetKey(hit.city) !== parsed.city) continue
    let score = 0
    if (parsed.number) {
      score = doorScore(hit.number, parsed.number)
      if (score < 0) continue
    }
    if (parsed.postcode && formatPostcode(hit.postcode) !== parsed.postcode) continue
    if (broad) {
      const seen = perCity.get(hit.city) || 0
      if (seen >= 30) continue
      perCity.set(hit.city, seen + 1)
    }
    hits.push({ ...hit, score })
    if (hits.length >= 400) break
  }
  return hits
}

async function collectHits(book, query) {
  let parsed = parseDoorQuery(query, book.cityKeys)
  const street = parsed.street || streetKey(query)
  if (street.length < 3) return { parsed, hits: [] }
  const streets = matchingStreets(book, street).slice(0, 6)
  let hits = []
  for (const row of streets) {
    hits.push(...(await doorsMatching(book, row, parsed)))
    if (hits.length >= 400) break
  }
  if (!hits.length && parsed.number && (parsed.city || parsed.postcode)) {
    parsed = { ...parsed, city: "", postcode: "" }
    hits = []
    for (const row of streets) {
      hits.push(...(await doorsMatching(book, row, parsed)))
      if (hits.length >= 400) break
    }
  }
  if (parsed.number) hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "pt"))
  return { parsed, hits }
}

export async function searchAddresses(book, query, limit = 6) {
  if (!book) return []
  const { hits } = await collectHits(book, query)
  return hits.slice(0, limit).map(publicHit)
}

function byAnchor(hits, anchor) {
  return [...hits].sort((a, b) => {
    const distance = metersBetween(anchor.lat, anchor.lon, a.lat, a.lon) - metersBetween(anchor.lat, anchor.lon, b.lat, b.lon)
    return distance || a.name.localeCompare(b.name, "pt")
  })
}

async function streetPoint(book, street, parsed, anchor) {
  const view = await streetView(book, street)
  let best = null
  let bestM = Infinity
  for (let i = 0; i < street.count; i += 1) {
    const hit = hitAt(book, street, view, i)
    if (!hit.city) continue
    if (parsed.city && streetKey(hit.city) !== parsed.city) continue
    if (parsed.postcode && formatPostcode(hit.postcode) !== parsed.postcode) continue
    if (!anchor) return hit
    const distance = metersBetween(anchor.lat, anchor.lon, hit.lat, hit.lon)
    if (distance < bestM) {
      bestM = distance
      best = hit
    }
  }
  return best
}

async function nearbyStreetHits(book, queryKey, parsed, anchor, limit) {
  await prepareNearest(book)
  const grid = book.grid
  if (!grid?.ready) return []
  const cx = Math.floor((anchor.lon - grid.lon0) / grid.cell)
  const cy = Math.floor((anchor.lat - grid.lat0) / grid.cell)
  const best = new Map()
  for (let ring = 0; ring <= 5 && best.size < limit * 2; ring += 1) {
    for (let y = cy - ring; y <= cy + ring; y += 1) {
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        if (ring && Math.abs(y - cy) !== ring && Math.abs(x - cx) !== ring) continue
        if (y < 0 || x < 0 || y >= grid.yn || x >= grid.xn) continue
        const cell = y * grid.xn + x
        const start = grid.starts[cell]
        const size = grid.counts[cell]
        for (let i = 0; i < size; i += 1) {
          const id = grid.ids[start + i]
          const street = streetAt(grid.spans, book.streets, id)
          if (!street) continue
          const key = street.key
          if (key !== queryKey && !key.startsWith(`${queryKey} `)) continue
          const lat = grid.lats[id] / 1e6
          const lon = grid.lons[id] / 1e6
          const distance = metersBetween(anchor.lat, anchor.lon, lat, lon)
          const prev = best.get(street)
          if (prev && prev.distance <= distance) continue
          best.set(street, { lat, lon, distance, index: id })
        }
      }
    }
  }
  const hits = []
  for (const point of [...best.entries()].sort((a, b) => a[1].distance - b[1].distance).slice(0, limit)) {
    const [street, door] = point
    const bytes = new Uint8Array(await book.file.slice(book.recordOffset + door.index * 18, book.recordOffset + (door.index + 1) * 18).arrayBuffer())
    const view = new DataView(bytes.buffer)
    const city = book.cities[view.getUint16(4, true)]
    if (parsed.city && streetKey(city) !== parsed.city) continue
    hits.push({
      name: `${street.name}, ${city}`,
      city,
      lat: door.lat,
      lon: door.lon,
      distance: door.distance,
    })
  }
  return hits
}

async function suggestStreets(book, query, limit, anchor) {
  const parsed = parseDoorQuery(query, book.cityKeys)
  const street = parsed.street || streetKey(query)
  if (street.length < 3 || parsed.number) return []
  if (anchor && street.split(" ").length < 2) {
    const near = await nearbyStreetHits(book, street, parsed, anchor, limit)
    if (near.length) return near.map(publicHit)
  }
  const rows = matchingStreets(book, street, 40)
  const hits = []
  for (const row of rows) {
    const door = await streetPoint(book, row, parsed, anchor)
    if (!door) continue
    hits.push({
      name: `${row.name}, ${door.city}`,
      city: door.city,
      lat: door.lat,
      lon: door.lon,
      distance: anchor ? metersBetween(anchor.lat, anchor.lon, door.lat, door.lon) : 0,
    })
  }
  if (anchor) hits.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name, "pt"))
  return hits.slice(0, limit).map(publicHit)
}

export async function suggestAddresses(book, query, limit = 8, anchor = null) {
  if (!book) return []
  const parsed = parseDoorQuery(query, book.cityKeys)
  if (!parsed.number) return suggestStreets(book, query, limit, anchor)
  const { hits } = await collectHits(book, query)
  const ordered = anchor && !parsed.city ? byAnchor(hits, anchor) : hits
  return ordered.slice(0, 80).map(publicHit)
}

function cellIndex(lat, lon, grid) {
  const y = Math.floor((lat - grid.lat0) / grid.cell)
  const x = Math.floor((lon - grid.lon0) / grid.cell)
  if (y < 0 || x < 0 || y >= grid.yn || x >= grid.xn) return -1
  return y * grid.xn + x
}

function doorGrid(lats, lons) {
  let cell = 0.02
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  let kept = 0
  for (let index = 0; index < lats.length; index += 1) {
    const lat = lats[index] / 1e6
    const lon = lons[index] / 1e6
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue
    kept += 1
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  if (!kept) return null
  let lat0 = Math.floor(minLat / cell) * cell - cell
  let lon0 = Math.floor(minLon / cell) * cell - cell
  let yn = Math.floor((maxLat - lat0) / cell) + 2
  let xn = Math.floor((maxLon - lon0) / cell) + 2
  while (yn * xn > 2000000) {
    cell *= 2
    lat0 = Math.floor(minLat / cell) * cell - cell
    lon0 = Math.floor(minLon / cell) * cell - cell
    yn = Math.floor((maxLat - lat0) / cell) + 2
    xn = Math.floor((maxLon - lon0) / cell) + 2
  }
  return { cell, lat0, lon0, yn, xn, ready: true }
}

function metersBetween(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)))
}

function streetAt(spans, streets, index) {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].first <= index) lo = mid + 1
    else hi = mid
  }
  const span = spans[lo - 1]
  if (!span || index < span.first || index >= span.first + span.count) return null
  return streets[span.street]
}

export function prepareNearest(book) {
  if (!book) return Promise.resolve()
  if (book.grid) return Promise.resolve()
  if (!book.nearestTask) book.nearestTask = buildNearest(book)
  return book.nearestTask
}

async function buildNearest(book) {
  const count = Math.floor((book.file.size - book.recordOffset) / 18)
  const lats = new Int32Array(count)
  const lons = new Int32Array(count)
  const chunk = 120000
  for (let start = 0; start < count; start += chunk) {
    const size = Math.min(chunk, count - start)
    const bytes = new Uint8Array(
      await book.file.slice(book.recordOffset + start * 18, book.recordOffset + (start + size) * 18).arrayBuffer(),
    )
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < size; i += 1) {
      lats[start + i] = view.getInt32(i * 18 + 10, true)
      lons[start + i] = view.getInt32(i * 18 + 14, true)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const grid = doorGrid(lats, lons)
  if (!grid) {
    book.grid = { ready: false }
    return
  }
  const counts = new Uint32Array(grid.yn * grid.xn)
  for (let i = 0; i < count; i += 1) {
    const cell = cellIndex(lats[i] / 1e6, lons[i] / 1e6, grid)
    if (cell >= 0) counts[cell] += 1
  }
  const starts = new Uint32Array(counts.length)
  let cursor = 0
  for (let i = 0; i < counts.length; i += 1) {
    starts[i] = cursor
    cursor += counts[i]
  }
  const ids = new Uint32Array(cursor)
  const fill = starts.slice()
  for (let i = 0; i < count; i += 1) {
    const cell = cellIndex(lats[i] / 1e6, lons[i] / 1e6, grid)
    if (cell < 0) continue
    ids[fill[cell]] = i
    fill[cell] += 1
  }
  const spans = book.streets
    .map((street, streetIndex) => ({ first: street.first, count: street.count, street: streetIndex }))
    .sort((a, b) => a.first - b.first)
  book.grid = { ...grid, lats, lons, counts, starts, ids, spans }
}

function nearestIndex(grid, lat, lon) {
  if (!grid?.ready) return -1
  const cx = Math.floor((lon - grid.lon0) / grid.cell)
  const cy = Math.floor((lat - grid.lat0) / grid.cell)
  let best = -1
  let bestM = Infinity
  for (let ring = 0; ring < 40; ring += 1) {
    for (let y = cy - ring; y <= cy + ring; y += 1) {
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        if (ring && Math.abs(y - cy) !== ring && Math.abs(x - cx) !== ring) continue
        if (y < 0 || x < 0 || y >= grid.yn || x >= grid.xn) continue
        const cell = y * grid.xn + x
        const start = grid.starts[cell]
        const size = grid.counts[cell]
        for (let i = 0; i < size; i += 1) {
          const id = grid.ids[start + i]
          const d = metersBetween(lat, lon, grid.lats[id] / 1e6, grid.lons[id] / 1e6)
          if (d < bestM) {
            bestM = d
            best = id
          }
        }
      }
    }
    if (best < 0) continue
    const south = grid.lat0 + (cy - ring) * grid.cell
    const north = grid.lat0 + (cy + ring + 1) * grid.cell
    const west = grid.lon0 + (cx - ring) * grid.cell
    const east = grid.lon0 + (cx + ring + 1) * grid.cell
    if (lat < south || lat > north || lon < west || lon > east) continue
    const latM = Math.min(lat - south, north - lat) * 111320
    const lonM = Math.min(lon - west, east - lon) * 111320 * Math.cos((lat * Math.PI) / 180)
    if (bestM <= Math.min(latM, lonM)) break
  }
  return best
}

export async function nearestDoor(book, lat, lon) {
  if (!book || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  await prepareNearest(book)
  const index = nearestIndex(book.grid, lat, lon)
  if (index < 0) return null
  const street = streetAt(book.grid.spans, book.streets, index)
  if (!street) return null
  const bytes = new Uint8Array(await book.file.slice(book.recordOffset + index * 18, book.recordOffset + (index + 1) * 18).arrayBuffer())
  const view = new DataView(bytes.buffer)
  const number = book.numbers[view.getUint32(0, true)]
  const city = book.cities[view.getUint16(4, true)]
  const postcode = view.getUint32(6, true)
  return {
    name: formatAddress(street.name, number, postcode, city),
    lat: view.getInt32(10, true) / 1e6,
    lon: view.getInt32(14, true) / 1e6,
  }
}
