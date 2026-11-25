export const WATER_TYPES = [
  { id: 0, label: "Bebedouro" },
  { id: 1, label: "Fonte" },
  { id: 2, label: "Vau" },
  { id: 3, label: "Açude" },
  { id: 4, label: "Acesso" },
]

function pad(bytes) {
  const extra = (4 - (bytes.length % 4)) % 4
  if (!extra) return bytes
  const out = new Uint8Array(bytes.length + extra)
  out.set(bytes)
  return out
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

function cellOf(lat, lon, grid) {
  const y = Math.floor((lat - grid.lat0) / grid.step)
  const x = Math.floor((lon - grid.lon0) / grid.step)
  if (y < 0 || x < 0 || y >= grid.latN || x >= grid.lonN) return -1
  return y * grid.lonN + x
}

function cellsAlong(latA, lonA, latB, lonB, into, grid) {
  const y0 = Math.floor((latA - grid.lat0) / grid.step)
  const x0 = Math.floor((lonA - grid.lon0) / grid.step)
  const y1 = Math.floor((latB - grid.lat0) / grid.step)
  const x1 = Math.floor((lonB - grid.lon0) / grid.step)
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
  for (let index = 0; index <= steps; index += 1) {
    const y = Math.round(y0 + ((y1 - y0) * index) / steps)
    const x = Math.round(x0 + ((x1 - x0) * index) / steps)
    if (y < 0 || x < 0 || y >= grid.latN || x >= grid.lonN) continue
    into.add(y * grid.lonN + x)
  }
}

function waterGrid(points) {
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

function storedGridCovers(book) {
  if (!book.count || !book.step || book.latN < 1 || book.lonN < 1) return false
  if (book.cellHead.length !== book.latN * book.lonN + 1) return false
  for (let index = 0; index < book.count; index += 1) {
    if (cellOf(book.labelLat[index], book.labelLon[index], book) < 0) return false
  }
  return true
}

function rebuildWaterGrid(book) {
  const grid = waterGrid(Array.from({ length: book.count }, (_, index) => [book.labelLat[index], book.labelLon[index]]))
  if (!book.count || grid.latN * grid.lonN > 3000000) {
    book.gridReady = false
    return
  }
  const cellCount = grid.latN * grid.lonN
  const buckets = Array.from({ length: cellCount }, () => [])
  let indexed = 0
  for (let index = 0; index < book.count; index += 1) {
    const cell = cellOf(book.labelLat[index], book.labelLon[index], grid)
    if (cell < 0) continue
    buckets[cell].push(index)
    indexed += 1
  }
  if (!indexed) {
    book.gridReady = false
    return
  }
  const cellHead = new Uint32Array(cellCount + 1)
  let cursor = 0
  for (let index = 0; index < cellCount; index += 1) {
    cellHead[index] = cursor
    cursor += buckets[index].length
  }
  cellHead[cellCount] = cursor
  const cellIds = new Uint32Array(cursor)
  let fill = 0
  for (const bucket of buckets) {
    for (const id of bucket) cellIds[fill++] = id
  }
  book.lat0 = grid.lat0
  book.lon0 = grid.lon0
  book.latN = grid.latN
  book.lonN = grid.lonN
  book.step = grid.step
  book.cellHead = cellHead
  book.cellIds = cellIds
  book.gridReady = true
}

function ensureWaterGrid(book) {
  if (storedGridCovers(book)) {
    book.gridReady = true
    return
  }
  rebuildWaterGrid(book)
}

export function buildWaterBook(rows) {
  const kept = rows
    .filter((row) => row.type >= 0 && row.type < WATER_TYPES.length && Number.isFinite(row.lat) && Number.isFinite(row.lon))
    .map((row) => {
      const parts = (row.parts || [])
        .map((part) => part.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1])))
        .filter((part) => part.length >= 2)
      const kind = parts.length ? (row.area ? 2 : 1) : 0
      return {
        type: row.type,
        name: row.name || WATER_TYPES[row.type].label,
        kind,
        lat: Math.round(row.lat * 1e6),
        lon: Math.round(row.lon * 1e6),
        parts: parts.map((part) => part.map((point) => [Math.round(point[0] * 1e6), Math.round(point[1] * 1e6)])),
      }
    })
    .sort((a, b) => a.type - b.type || a.lat - b.lat || a.lon - b.lon || a.name.localeCompare(b.name, "pt"))
  const grid = waterGrid(kept.map((row) => [row.lat, row.lon]))
  const names = []
  const nameOff = []
  const nameLen = []
  let nameBytes = 0
  const geomChunks = []
  const geomOff = []
  const geomLen = []
  let geomBytes = 0
  const buckets = Array.from({ length: grid.latN * grid.lonN }, () => [])
  kept.forEach((row, index) => {
    const encoded = new TextEncoder().encode(row.name)
    nameOff.push(nameBytes)
    nameLen.push(encoded.length)
    names.push(encoded)
    nameBytes += encoded.length
    const cells = new Set()
    const home = cellOf(row.lat, row.lon, grid)
    if (home >= 0) cells.add(home)
    if (!row.parts.length) {
      geomOff.push(0)
      geomLen.push(0)
    } else {
      const bytes = []
      const push16 = (value) => {
        bytes.push(value & 255, (value >> 8) & 255)
      }
      const push32 = (value) => {
        bytes.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255)
      }
      push16(row.parts.length)
      for (const part of row.parts) {
        push16(part.length)
        let prev = null
        for (const [lat, lon] of part) {
          push32(lat)
          push32(lon)
          const cell = cellOf(lat, lon, grid)
          if (cell >= 0) cells.add(cell)
          if (prev) cellsAlong(prev[0], prev[1], lat, lon, cells, grid)
          prev = [lat, lon]
        }
      }
      const chunk = Uint8Array.from(bytes)
      geomOff.push(geomBytes)
      geomLen.push(chunk.length)
      geomChunks.push(chunk)
      geomBytes += chunk.length
    }
    let minLat = row.lat
    let maxLat = row.lat
    let minLon = row.lon
    let maxLon = row.lon
    for (const part of row.parts) {
      for (const [lat, lon] of part) {
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
      }
    }
    row.span = Math.min(65535, Math.floor((maxLat - minLat + maxLon - minLon) / 1000))
    for (const cell of cells) buckets[cell].push(index)
  })
  const cellIds = []
  const cellHead = [0]
  for (const bucket of buckets) {
    cellIds.push(...bucket)
    cellHead.push(cellIds.length)
  }
  const count = kept.length
  const geomBlob = concat(geomChunks)
  const parts = [new Uint8Array(64)]
  parts.push(pad(Uint8Array.from(kept.map((row) => row.type))))
  parts.push(pad(Uint8Array.from(kept.map((row) => row.kind))))
  const span = new Uint16Array(kept.map((row) => row.span))
  parts.push(pad(new Uint8Array(span.buffer)))
  parts.push(new Uint8Array(new Int32Array(kept.map((row) => row.lat)).buffer))
  parts.push(new Uint8Array(new Int32Array(kept.map((row) => row.lon)).buffer))
  parts.push(new Uint8Array(new Uint32Array(nameOff).buffer))
  parts.push(pad(new Uint8Array(new Uint16Array(nameLen).buffer)))
  parts.push(new Uint8Array(new Uint32Array(geomOff).buffer))
  parts.push(new Uint8Array(new Uint32Array(geomLen).buffer))
  parts.push(pad(concat(names)))
  parts.push(pad(geomBlob))
  parts.push(new Uint8Array(new Uint32Array(cellHead).buffer))
  parts.push(new Uint8Array(new Uint32Array(cellIds).buffer))
  const body = concat(parts)
  const view = new DataView(body.buffer)
  body.set(new TextEncoder().encode("WTR1"), 0)
  view.setUint32(4, 1, true)
  view.setUint32(8, count, true)
  view.setUint32(12, nameBytes, true)
  view.setInt32(16, grid.lat0, true)
  view.setInt32(20, grid.lon0, true)
  view.setUint32(24, grid.latN, true)
  view.setUint32(28, grid.lonN, true)
  view.setUint32(32, grid.step, true)
  view.setUint32(36, grid.latN * grid.lonN, true)
  view.setUint32(40, geomBytes, true)
  view.setUint32(44, body.length, true)
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
}

export function openWaterBook(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== "WTR1" || view.getUint32(4, true) !== 1 || view.getUint32(44, true) !== bytes.byteLength) {
    throw new Error("water")
  }
  const count = view.getUint32(8, true)
  const nameBytes = view.getUint32(12, true)
  const lat0 = view.getInt32(16, true)
  const lon0 = view.getInt32(20, true)
  const latN = view.getUint32(24, true)
  const lonN = view.getUint32(28, true)
  const step = view.getUint32(32, true)
  const cellCount = view.getUint32(36, true)
  const geomBytes = view.getUint32(40, true)
  let offset = 64
  const type = bytes.slice(offset, offset + count)
  offset = align(offset + count)
  const kind = bytes.slice(offset, offset + count)
  offset = align(offset + count)
  const span = new Uint16Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset = align(offset + count * 2)
  const labelLat = new Int32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const labelLon = new Int32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const nameOff = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const nameLen = new Uint16Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset = align(offset + count * 2)
  const geomOff = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const geomLen = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const nameBlob = bytes.subarray(offset, offset + nameBytes)
  offset = align(offset + nameBytes)
  const geom = bytes.subarray(offset, offset + geomBytes)
  offset = align(offset + geomBytes)
  const cellHead = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, cellCount + 1)
  offset += (cellCount + 1) * 4
  const idCount = cellHead[cellCount]
  const cellIds = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, idCount)
  const book = {
    count,
    type,
    kind,
    span,
    labelLat,
    labelLon,
    nameOff,
    nameLen,
    nameBlob,
    geom,
    geomView: new DataView(geom.buffer, geom.byteOffset, geom.byteLength),
    geomOff,
    geomLen,
    cellHead,
    cellIds,
    lat0,
    lon0,
    latN,
    lonN,
    step,
    decoded: new Array(count),
    names: new Array(count),
    stamp: new Uint32Array(count),
    token: 1,
    gridReady: false,
  }
  ensureWaterGrid(book)
  if (!book.gridReady) throw new Error("water")
  return book
}

const decoder = new TextDecoder()

function featureName(book, id) {
  const cached = book.names[id]
  if (cached) return cached
  const start = book.nameOff[id]
  const name = decoder.decode(book.nameBlob.subarray(start, start + book.nameLen[id]))
  book.names[id] = name
  return name
}

function featureParts(book, id) {
  if (book.decoded[id]) return book.decoded[id]
  if (book.kind[id] === 0 || book.geomLen[id] === 0) {
    book.decoded[id] = []
    return []
  }
  const view = book.geomView
  let offset = book.geomOff[id]
  const partCount = view.getUint16(offset, true)
  offset += 2
  const parts = []
  for (let part = 0; part < partCount; part += 1) {
    const n = view.getUint16(offset, true)
    offset += 2
    const coords = new Float64Array(n * 2)
    for (let index = 0; index < n; index += 1) {
      coords[index * 2] = view.getInt32(offset, true) / 1e6
      coords[index * 2 + 1] = view.getInt32(offset + 4, true) / 1e6
      offset += 8
    }
    parts.push(coords)
  }
  book.decoded[id] = parts
  return parts
}

function inside(lat, lon, west, south, east, north) {
  return lat >= south && lat <= north && lon >= west && lon <= east
}

function orient(ax, ay, bx, by, cx, cy) {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by)
}

function segmentsCross(aLat, aLon, bLat, bLon, cLat, cLon, dLat, dLon) {
  const left = orient(aLon, aLat, bLon, bLat, cLon, cLat)
  const right = orient(aLon, aLat, bLon, bLat, dLon, dLat)
  const across = orient(cLon, cLat, dLon, dLat, aLon, aLat)
  const back = orient(cLon, cLat, dLon, dLat, bLon, bLat)
  return left * right < 0 && across * back < 0
}

function segmentHits(aLat, aLon, bLat, bLon, west, south, east, north) {
  if (inside(aLat, aLon, west, south, east, north) || inside(bLat, bLon, west, south, east, north)) return true
  if (Math.max(aLat, bLat) < south || Math.min(aLat, bLat) > north) return false
  if (Math.max(aLon, bLon) < west || Math.min(aLon, bLon) > east) return false
  return (
    segmentsCross(aLat, aLon, bLat, bLon, south, west, south, east) ||
    segmentsCross(aLat, aLon, bLat, bLon, north, west, north, east) ||
    segmentsCross(aLat, aLon, bLat, bLon, south, west, north, west) ||
    segmentsCross(aLat, aLon, bLat, bLon, south, east, north, east)
  )
}

function remember(best, lat, lon, cy, cx) {
  const dist = (lat - cy) * (lat - cy) + (lon - cx) * (lon - cx)
  if (!best || dist < best.dist) return { lat, lon, dist }
  return best
}

function anchorFor(book, id, west, south, east, north, cy, cx) {
  if (book.kind[id] === 0) {
    const lat = book.labelLat[id] / 1e6
    const lon = book.labelLon[id] / 1e6
    if (!inside(lat, lon, west, south, east, north)) return null
    return { lat, lon, dist: (lat - cy) * (lat - cy) + (lon - cx) * (lon - cx) }
  }
  const parts = featureParts(book, id)
  let best = null
  let hit = false
  for (const part of parts) {
    const n = part.length / 2
    let prevLat = 0
    let prevLon = 0
    for (let index = 0; index < n; index += 1) {
      const lat = part[index * 2]
      const lon = part[index * 2 + 1]
      if (inside(lat, lon, west, south, east, north)) {
        hit = true
        best = remember(best, lat, lon, cy, cx)
      }
      if (index) {
        if (segmentHits(prevLat, prevLon, lat, lon, west, south, east, north)) hit = true
        const dlat = lat - prevLat
        const dlon = lon - prevLon
        const denom = dlat * dlat + dlon * dlon
        let t = 0
        if (denom > 0) t = ((cy - prevLat) * dlat + (cx - prevLon) * dlon) / denom
        if (t < 0) t = 0
        else if (t > 1) t = 1
        const onLat = prevLat + dlat * t
        const onLon = prevLon + dlon * t
        if (inside(onLat, onLon, west, south, east, north)) {
          hit = true
          best = remember(best, onLat, onLon, cy, cx)
        } else {
          for (let step = 1; step < 8; step += 1) {
            const share = step / 8
            const midLat = prevLat + dlat * share
            const midLon = prevLon + dlon * share
            if (!inside(midLat, midLon, west, south, east, north)) continue
            hit = true
            best = remember(best, midLat, midLon, cy, cx)
            break
          }
        }
      }
      prevLat = lat
      prevLon = lon
    }
  }
  if (!hit || !best) return null
  return best
}

function ringCoordinates(part) {
  const n = part.length / 2
  const ring = new Array(n)
  for (let index = 0; index < n; index += 1) ring[index] = [part[index * 2 + 1], part[index * 2]]
  const first = ring[0]
  const last = ring[n - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push([first[0], first[1]])
  return ring
}

function lineCoordinates(part) {
  const n = part.length / 2
  const line = new Array(n)
  for (let index = 0; index < n; index += 1) line[index] = [part[index * 2 + 1], part[index * 2]]
  return line
}

function shapeFeature(book, id) {
  const parts = featureParts(book, id)
  if (!parts.length) return null
  if (book.kind[id] === 2) {
    const polygons = parts.map((part) => [ringCoordinates(part)])
    if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] }
    return { type: "MultiPolygon", coordinates: polygons }
  }
  const lines = parts.map((part) => lineCoordinates(part))
  if (lines.length === 1) return { type: "LineString", coordinates: lines[0] }
  return { type: "MultiLineString", coordinates: lines }
}

function emptyWater() {
  return { counts: [0, 0, 0, 0, 0], total: 0, list: [], collection: { type: "FeatureCollection", features: [] } }
}

export function waterInView(book, west, south, east, north, zoom = 14) {
  if (!book?.gridReady) return emptyWater()
  const counts = [0, 0, 0, 0, 0]
  let token = (book.token + 1) >>> 0
  if (token === 0) {
    book.stamp.fill(0)
    token = 1
  }
  book.token = token
  const y0 = Math.max(0, Math.min(book.latN - 1, Math.floor((Math.round(south * 1e6) - book.lat0) / book.step)))
  const y1 = Math.max(0, Math.min(book.latN - 1, Math.floor((Math.round(north * 1e6) - book.lat0) / book.step)))
  const x0 = Math.max(0, Math.min(book.lonN - 1, Math.floor((Math.round(west * 1e6) - book.lon0) / book.step)))
  const x1 = Math.max(0, Math.min(book.lonN - 1, Math.floor((Math.round(east * 1e6) - book.lon0) / book.step)))
  const cy = (south + north) / 2
  const cx = (west + east) / 2
  const hits = []
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const cell = y * book.lonN + x
      const start = book.cellHead[cell]
      const end = book.cellHead[cell + 1]
      for (let index = start; index < end; index += 1) {
        const id = book.cellIds[index]
        if (book.stamp[id] === book.token) continue
        book.stamp[id] = book.token
        const anchor = anchorFor(book, id, west, south, east, north, cy, cx)
        if (!anchor) continue
        counts[book.type[id]] += 1
        hits.push({ id, lat: anchor.lat, lon: anchor.lon, dist: anchor.dist })
      }
    }
  }
  const list = hits
    .slice()
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 160)
    .map((hit) => ({
      type: book.type[hit.id],
      typeLabel: WATER_TYPES[book.type[hit.id]].label,
      name: featureName(book, hit.id),
      lat: hit.lat,
      lon: hit.lon,
    }))
  const points = []
  for (const hit of hits) {
    if (book.kind[hit.id] !== 0) continue
    points.push({ id: hit.id, lat: hit.lat, lon: hit.lon, dist: hit.dist })
  }
  const drawnPoints = zoom >= 13 ? points.slice().sort((a, b) => a.dist - b.dist).slice(0, 80) : []
  const features = []
  for (const row of drawnPoints) {
    const name = featureName(book, row.id)
    features.push({
      type: "Feature",
      properties: {
        name,
        typeLabel: WATER_TYPES[book.type[row.id]].label,
        lat: row.lat,
        lon: row.lon,
        role: "label",
      },
      geometry: { type: "Point", coordinates: [row.lon, row.lat] },
    })
  }
  const total = counts.reduce((sum, count) => sum + count, 0)
  return {
    counts,
    total,
    list,
    collection: { type: "FeatureCollection", features },
  }
}

export function waterIcon() {
  const canvas = document.createElement("canvas")
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext("2d")
  ctx.clearRect(0, 0, 64, 64)
  ctx.beginPath()
  ctx.arc(32, 32, 26, 0, Math.PI * 2)
  ctx.fillStyle = "#0e7490"
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = "#ffffff"
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(32, 14)
  ctx.bezierCurveTo(46, 30, 44, 40, 32, 48)
  ctx.bezierCurveTo(20, 40, 18, 30, 32, 14)
  ctx.fillStyle = "#ffffff"
  ctx.fill()
  return canvas
}

export function waterTotals(book) {
  const counts = [0, 0, 0, 0, 0]
  for (let index = 0; index < book.count; index += 1) counts[book.type[index]] += 1
  return counts
}
