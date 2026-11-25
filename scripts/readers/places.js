import { fold } from "./search.js"

export const CATEGORIES = [
  { id: 0, label: "Saúde", mark: "Saúde", color: "#0f6b4c" },
  { id: 1, label: "Polícia", mark: "Polícia", color: "#1d4ed8" },
  { id: 2, label: "Bombeiros", mark: "Bombeiros", color: "#dc2626" },
  { id: 3, label: "Gasolina", mark: "Gasolina", color: "#7c3aed" },
  { id: 4, label: "Supermercados", mark: "Supermercado", color: "#b45309" },
  { id: 5, label: "Restaurantes", mark: "Restaurante", color: "#be185d" },
]

function pad(bytes) {
  const extra = (4 - (bytes.length % 4)) % 4
  if (!extra) return bytes
  const out = new Uint8Array(bytes.length + extra)
  out.set(bytes)
  return out
}

function encode(text) {
  return new TextEncoder().encode(text || "")
}

function gridFor(points) {
  const step = 20000
  const finite = points.filter((point) => point[0] >= -90000000 && point[0] <= 90000000 && point[1] >= -180000000 && point[1] <= 180000000)
  if (!finite.length) return { lat0: 0, lon0: 0, latN: 1, lonN: 1, step }
  let minLat = finite[0][0]
  let maxLat = finite[0][0]
  let minLon = finite[0][1]
  let maxLon = finite[0][1]
  for (const [lat, lon] of finite) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }
  const lat0 = Math.floor(minLat / step) * step - step
  const lon0 = Math.floor(minLon / step) * step - step
  const latN = Math.floor((maxLat - lat0) / step) + 2
  const lonN = Math.floor((maxLon - lon0) / step) + 2
  return { lat0, lon0, latN, lonN, step }
}

export function buildPlaceBook(rows) {
  const kept = rows
    .filter((row) => row.category >= 0 && row.category < CATEGORIES.length && Number.isFinite(row.lat) && Number.isFinite(row.lon))
    .map((row) => ({
      category: row.category,
      name: row.name || CATEGORIES[row.category].mark,
      address: row.address || "",
      lat: Math.round(row.lat * 1e6),
      lon: Math.round(row.lon * 1e6),
    }))
    .sort((a, b) => a.category - b.category || a.lat - b.lat || a.lon - b.lon || a.name.localeCompare(b.name, "pt"))
  const names = []
  const addrs = []
  let nameBytes = 0
  let addrBytes = 0
  const nameOff = []
  const nameLen = []
  const addrOff = []
  const addrLen = []
  for (const row of kept) {
    const name = encode(row.name)
    const addr = encode(row.address)
    nameOff.push(nameBytes)
    nameLen.push(name.length)
    names.push(name)
    nameBytes += name.length
    addrOff.push(addrBytes)
    addrLen.push(addr.length)
    addrs.push(addr)
    addrBytes += addr.length
  }
  const grid = gridFor(kept.map((row) => [row.lat, row.lon]))
  const cellCount = grid.latN * grid.lonN
  const buckets = Array.from({ length: cellCount }, () => [])
  kept.forEach((row, index) => {
    const y = Math.floor((row.lat - grid.lat0) / grid.step)
    const x = Math.floor((row.lon - grid.lon0) / grid.step)
    if (y < 0 || x < 0 || y >= grid.latN || x >= grid.lonN) throw new Error("places")
    buckets[y * grid.lonN + x].push(index)
  })
  const cellIds = []
  const cellHead = [0]
  for (const bucket of buckets) {
    cellIds.push(...bucket)
    cellHead.push(cellIds.length)
  }
  const count = kept.length
  const parts = [new Uint8Array(64)]
  parts.push(pad(Uint8Array.from(kept.map((row) => row.category))))
  const lats = new Int32Array(kept.map((row) => row.lat))
  const lons = new Int32Array(kept.map((row) => row.lon))
  parts.push(new Uint8Array(lats.buffer), new Uint8Array(lons.buffer))
  const nameOffs = new Uint32Array(nameOff)
  const nameLens = new Uint16Array(nameLen)
  parts.push(new Uint8Array(nameOffs.buffer), pad(new Uint8Array(nameLens.buffer)))
  const addrOffs = new Uint32Array(addrOff)
  const addrLens = new Uint16Array(addrLen)
  parts.push(new Uint8Array(addrOffs.buffer), pad(new Uint8Array(addrLens.buffer)))
  parts.push(pad(concat(names)))
  parts.push(pad(concat(addrs)))
  const heads = new Uint32Array(cellHead)
  const ids = new Uint32Array(cellIds)
  parts.push(new Uint8Array(heads.buffer), new Uint8Array(ids.buffer))
  const body = concat(parts)
  const view = new DataView(body.buffer)
  const head = new Uint8Array(body.buffer, 0, 64)
  head.set(new TextEncoder().encode("POI1"))
  view.setUint32(4, 1, true)
  view.setUint32(8, count, true)
  view.setUint32(12, nameBytes, true)
  view.setUint32(16, addrBytes, true)
  view.setInt32(20, grid.lat0, true)
  view.setInt32(24, grid.lon0, true)
  view.setUint32(28, grid.latN, true)
  view.setUint32(32, grid.lonN, true)
  view.setUint32(36, grid.step, true)
  view.setUint32(40, cellCount, true)
  view.setUint32(44, body.length, true)
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
}

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function align(offset) {
  return (offset + 3) & ~3
}

export function openPlaceBook(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== "POI1" || view.getUint32(4, true) !== 1 || view.getUint32(44, true) !== bytes.byteLength) {
    throw new Error("places")
  }
  const count = view.getUint32(8, true)
  const nameBytes = view.getUint32(12, true)
  const addrBytes = view.getUint32(16, true)
  const lat0 = view.getInt32(20, true)
  const lon0 = view.getInt32(24, true)
  const latN = view.getUint32(28, true)
  const lonN = view.getUint32(32, true)
  const step = view.getUint32(36, true)
  const cellCount = view.getUint32(40, true)
  let offset = 64
  const category = bytes.slice(offset, offset + count)
  offset = align(offset + count)
  const lat = new Int32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const lon = new Int32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const nameOff = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const nameLen = new Uint16Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset = align(offset + count * 2)
  const addrOff = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const addrLen = new Uint16Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset = align(offset + count * 2)
  const nameBlob = bytes.subarray(offset, offset + nameBytes)
  offset = align(offset + nameBytes)
  const addrBlob = bytes.subarray(offset, offset + addrBytes)
  offset = align(offset + addrBytes)
  const cellHead = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, cellCount + 1)
  offset += (cellCount + 1) * 4
  const cellIds = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  const decoder = new TextDecoder()
  const names = new Array(count)
  const addrs = new Array(count)
  for (let i = 0; i < count; i += 1) {
    names[i] = decoder.decode(nameBlob.subarray(nameOff[i], nameOff[i] + nameLen[i]))
    addrs[i] = decoder.decode(addrBlob.subarray(addrOff[i], addrOff[i] + addrLen[i]))
  }
  return { count, category, lat, lon, names, addrs, lat0, lon0, latN, lonN, step, cellHead, cellIds }
}

export function placesInView(book, west, south, east, north, category = -1, limit = 80) {
  const counts = CATEGORIES.map(() => 0)
  const kept = CATEGORIES.map(() => 0)
  const items = []
  if (!book || !(east > west) || !(north > south)) return { counts, items }
  const y0 = Math.max(0, Math.floor((south * 1e6 - book.lat0) / book.step))
  const y1 = Math.min(book.latN - 1, Math.floor((north * 1e6 - book.lat0) / book.step))
  const x0 = Math.max(0, Math.floor((west * 1e6 - book.lon0) / book.step))
  const x1 = Math.min(book.lonN - 1, Math.floor((east * 1e6 - book.lon0) / book.step))
  if (y1 < y0 || x1 < x0) return { counts, items }
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const cell = y * book.lonN + x
      const start = book.cellHead[cell]
      const end = book.cellHead[cell + 1]
      for (let k = start; k < end; k += 1) {
        const id = book.cellIds[k]
        const lat = book.lat[id] / 1e6
        const lon = book.lon[id] / 1e6
        if (lat < south || lat > north || lon < west || lon > east) continue
        const kind = book.category[id]
        counts[kind] += 1
        if (category >= 0 && kind !== category) continue
        if (kept[kind] >= limit) continue
        kept[kind] += 1
        items.push({
          category: kind,
          name: book.names[id],
          address: book.addrs[id],
          lat,
          lon,
        })
      }
    }
  }
  return { counts, items }
}

const PIN_ZOOM = 6.2
const SERVICE_WORDS = [
  ["hospital", "urgencia", "inem", "centro hospitalar"],
  ["comando", "esquadra", "psp"],
  ["bombeiro"],
  ["galp", "repsol", "bp", "prio", "cepsa", "shell"],
  ["continente", "pingo doce", "lidl", "auchan", "intermarche", "aldi"],
  ["restaurante"],
]

function metersBetweenPlaces(lat1, lon1, lat2, lon2) {
  const radius = 6371e3
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)))
}

function pinBudget(zoom) {
  if (zoom < PIN_ZOOM - 0.05) return { limit: 0, spacing: Infinity }
  if (zoom >= 14) return { limit: 1e9, spacing: 0 }
  const steps = zoom - PIN_ZOOM
  return {
    limit: Math.max(2, Math.round(2 * Math.pow(1.55, steps))),
    spacing: 140000 * Math.pow(0.5, steps / 1.15),
  }
}

function serviceScore(category, name) {
  const text = fold(name || "")
  const words = SERVICE_WORDS[category] || []
  let score = 1
  for (const word of words) if (text.includes(word)) score += 10
  return score
}

function pickSpread(points, zoom, scoreOf) {
  const budget = pinBudget(zoom)
  if (budget.limit <= 0 || !points.length) return []
  const ranked = points.map((point) => ({ point, score: scoreOf(point) }))
  ranked.sort((a, b) => b.score - a.score || a.point.lat - b.point.lat || a.point.lon - b.point.lon)
  const chosen = []
  for (const row of ranked) {
    if (chosen.length >= budget.limit) break
    if (budget.spacing > 0 && chosen.some((kept) => metersBetweenPlaces(kept.lat, kept.lon, row.point.lat, row.point.lon) < budget.spacing)) continue
    chosen.push(row.point)
  }
  return chosen
}

export function serviceIcons(items, zoom) {
  const shown = []
  for (let kind = 0; kind < CATEGORIES.length; kind += 1) {
    const group = items.filter((place) => place.category === kind)
    for (const place of pickSpread(group, zoom, (place) => serviceScore(kind, place.name))) shown.push(place)
  }
  return shown
}

export function searchServices(book, query, limit = 6) {
  const parts = fold(query).split(/\s+/).filter((part) => part.length > 1)
  if (!book || parts.length === 0) return []
  if (!book.keys) {
    book.keys = []
    for (let i = 0; i < book.count; i += 1) book.keys.push(fold(book.names[i]))
  }
  const hits = []
  for (let i = 0; i < book.count; i += 1) {
    const key = book.keys[i]
    if (!parts.every((part) => key.includes(part))) continue
    hits.push({
      service: true,
      category: book.category[i],
      name: book.names[i],
      address: book.addrs[i],
      lat: book.lat[i] / 1e6,
      lon: book.lon[i] / 1e6,
      rank: key.startsWith(parts[0]) ? 0 : 1,
    })
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name, "pt"))
  return hits.slice(0, limit)
}

export function categoryIcon(kind) {
  const spec = CATEGORIES[kind]
  const canvas = document.createElement("canvas")
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext("2d")
  ctx.clearRect(0, 0, 64, 64)
  ctx.beginPath()
  ctx.arc(32, 32, 26, 0, Math.PI * 2)
  ctx.fillStyle = spec.color
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = "#ffffff"
  ctx.stroke()
  ctx.strokeStyle = "#ffffff"
  ctx.fillStyle = "#ffffff"
  ctx.lineWidth = 4
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  if (kind === 0) {
    ctx.fillRect(28, 16, 8, 32)
    ctx.fillRect(16, 28, 32, 8)
  } else if (kind === 1) {
    ctx.beginPath()
    ctx.moveTo(32, 14)
    ctx.lineTo(48, 20)
    ctx.lineTo(44, 38)
    ctx.quadraticCurveTo(32, 50, 20, 38)
    ctx.lineTo(16, 20)
    ctx.closePath()
    ctx.stroke()
  } else if (kind === 2) {
    ctx.beginPath()
    ctx.moveTo(32, 14)
    ctx.quadraticCurveTo(46, 28, 40, 42)
    ctx.quadraticCurveTo(32, 50, 24, 42)
    ctx.quadraticCurveTo(18, 28, 32, 14)
    ctx.fill()
  } else if (kind === 3) {
    ctx.strokeRect(26, 16, 12, 28)
    ctx.beginPath()
    ctx.moveTo(38, 20)
    ctx.lineTo(46, 20)
    ctx.lineTo(46, 30)
    ctx.lineTo(38, 30)
    ctx.stroke()
  } else if (kind === 4) {
    ctx.strokeRect(18, 26, 28, 18)
    ctx.beginPath()
    ctx.moveTo(22, 26)
    ctx.lineTo(26, 16)
    ctx.lineTo(40, 16)
    ctx.lineTo(44, 26)
    ctx.stroke()
  } else {
    ctx.beginPath()
    ctx.moveTo(24, 14)
    ctx.lineTo(24, 36)
    ctx.moveTo(30, 14)
    ctx.lineTo(30, 36)
    ctx.moveTo(40, 14)
    ctx.lineTo(40, 28)
    ctx.quadraticCurveTo(40, 36, 32, 36)
    ctx.stroke()
  }
  return canvas
}
