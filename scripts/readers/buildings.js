const UNIT = 10

function align(offset) {
  return (offset + 3) & ~3
}

export function openBuildingBook(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== "BLD1" || view.getUint32(4, true) !== 1 || view.getUint32(40, true) !== bytes.byteLength) {
    throw new Error("buildings")
  }
  const count = view.getUint32(8, true)
  const grid = {
    lat0: view.getInt32(12, true),
    lon0: view.getInt32(16, true),
    latN: view.getUint32(20, true),
    lonN: view.getUint32(24, true),
    step: view.getUint32(28, true),
  }
  const cellCount = view.getUint32(32, true)
  if (!grid.step || grid.latN * grid.lonN !== cellCount) throw new Error("buildings")
  const geomBytes = view.getUint32(36, true)
  let offset = 64
  const originLat = new Int32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const originLon = new Int32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const geomOff = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset += count * 4
  const geomLen = new Uint16Array(bytes.buffer, bytes.byteOffset + offset, count)
  offset = align(offset + count * 2)
  const geom = bytes.subarray(offset, offset + geomBytes)
  offset = align(offset + geomBytes)
  const cellHead = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, cellCount + 1)
  offset += (cellCount + 1) * 4
  const cellIds = new Uint32Array(bytes.buffer, bytes.byteOffset + offset, cellHead[cellCount])
  const book = {
    count,
    grid,
    originLat,
    originLon,
    geomOff,
    geomLen,
    geom,
    geomView: new DataView(geom.buffer, geom.byteOffset, geom.byteLength),
    cellHead,
    cellIds,
    rings: new Array(count),
    stamp: new Uint32Array(count),
    token: 1,
  }
  book.allows = (lat1, lon1, lat2, lon2) => allowsConnector(book, lat1, lon1, lat2, lon2)
  book.links = (lat1, lon1, lat2, lon2) => allowsLink(book, lat1, lon1, lat2, lon2)
  book.cuts = (lat1, lon1, lat2, lon2) => segmentCuts(book, lat1, lon1, lat2, lon2)
  return book
}

function ringOf(book, id) {
  const cached = book.rings[id]
  if (cached) return cached
  const view = book.geomView
  let offset = book.geomOff[id]
  const n = view.getUint16(offset, true)
  offset += 2
  const ring = new Float64Array(n * 2)
  const lat0 = book.originLat[id]
  const lon0 = book.originLon[id]
  ring[0] = lat0 / 1e6
  ring[1] = lon0 / 1e6
  for (let index = 1; index < n; index += 1) {
    ring[index * 2] = (lat0 + view.getInt16(offset, true) * UNIT) / 1e6
    ring[index * 2 + 1] = (lon0 + view.getInt16(offset + 2, true) * UNIT) / 1e6
    offset += 4
  }
  book.rings[id] = ring
  return ring
}

function pointInside(ring, lat, lon) {
  let inside = false
  const n = ring.length / 2
  let prevLat = ring[(n - 1) * 2]
  let prevLon = ring[(n - 1) * 2 + 1]
  for (let index = 0; index < n; index += 1) {
    const nextLat = ring[index * 2]
    const nextLon = ring[index * 2 + 1]
    if (nextLat > lat !== prevLat > lat && lon < ((prevLon - nextLon) * (lat - nextLat)) / (prevLat - nextLat) + nextLon) {
      inside = !inside
    }
    prevLat = nextLat
    prevLon = nextLon
  }
  return inside
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

function ringHitsSegment(ring, lat1, lon1, lat2, lon2) {
  if (pointInside(ring, lat1, lon1) || pointInside(ring, lat2, lon2)) return true
  const n = ring.length / 2
  let prevLat = ring[(n - 1) * 2]
  let prevLon = ring[(n - 1) * 2 + 1]
  for (let index = 0; index < n; index += 1) {
    const nextLat = ring[index * 2]
    const nextLon = ring[index * 2 + 1]
    if (segmentsCross(lat1, lon1, lat2, lon2, prevLat, prevLon, nextLat, nextLon)) return true
    prevLat = nextLat
    prevLon = nextLon
  }
  return false
}

function cellRange(grid, south, north, west, east) {
  const { lat0, lon0, latN, lonN, step } = grid
  return {
    y0: Math.max(0, Math.min(latN - 1, Math.floor((Math.round(south * 1e6) - lat0) / step))),
    y1: Math.max(0, Math.min(latN - 1, Math.floor((Math.round(north * 1e6) - lat0) / step))),
    x0: Math.max(0, Math.min(lonN - 1, Math.floor((Math.round(west * 1e6) - lon0) / step))),
    x1: Math.max(0, Math.min(lonN - 1, Math.floor((Math.round(east * 1e6) - lon0) / step))),
  }
}

function candidates(book, lat1, lon1, lat2, lon2) {
  const south = Math.min(lat1, lat2)
  const north = Math.max(lat1, lat2)
  const west = Math.min(lon1, lon2)
  const east = Math.max(lon1, lon2)
  const { y0, y1, x0, x1 } = cellRange(book.grid, south, north, west, east)
  const token = (book.token + 1) >>> 0
  book.token = token === 0 ? 1 : token
  if (token === 0) book.stamp.fill(0)
  const ids = []
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const cell = y * book.grid.lonN + x
      for (let index = book.cellHead[cell]; index < book.cellHead[cell + 1]; index += 1) {
        const id = book.cellIds[index]
        if (book.stamp[id] === book.token) continue
        book.stamp[id] = book.token
        ids.push(id)
      }
    }
  }
  return ids
}

function meters(lat1, lon1, lat2, lon2) {
  const scale = Math.cos(((lat1 + lat2) / 2) * 0.017453292519943295)
  return Math.hypot((lat2 - lat1) * 110540, (lon2 - lon1) * scale * 111320)
}

function crossT(lat1, lon1, lat2, lon2, lat3, lon3, lat4, lon4) {
  const rx = lon2 - lon1
  const ry = lat2 - lat1
  const sx = lon4 - lon3
  const sy = lat4 - lat3
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-15) return null
  const qpx = lon3 - lon1
  const qpy = lat3 - lat1
  const t = (qpx * sy - qpy * sx) / den
  const u = (qpx * ry - qpy * rx) / den
  if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null
  if (t < 0) return 0
  if (t > 1) return 1
  return t
}

function exitShare(ring, lat1, lon1, lat2, lon2) {
  const n = ring.length / 2
  let exit = null
  let prevLat = ring[(n - 1) * 2]
  let prevLon = ring[(n - 1) * 2 + 1]
  for (let index = 0; index < n; index += 1) {
    const nextLat = ring[index * 2]
    const nextLon = ring[index * 2 + 1]
    const share = crossT(lat1, lon1, lat2, lon2, prevLat, prevLon, nextLat, nextLon)
    if (share != null) {
      const probe = Math.min(1, share + 1e-4)
      const lat = lat1 + (lat2 - lat1) * probe
      const lon = lon1 + (lon2 - lon1) * probe
      if (!pointInside(ring, lat, lon)) exit = exit == null ? share : Math.max(exit, share)
    }
    prevLat = nextLat
    prevLon = nextLon
  }
  return exit
}

function cutsRing(ring, lat1, lon1, lat2, lon2) {
  const midLat = (lat1 + lat2) / 2
  const midLon = (lon1 + lon2) / 2
  if (pointInside(ring, midLat, midLon)) return true
  const n = ring.length / 2
  let prevLat = ring[(n - 1) * 2]
  let prevLon = ring[(n - 1) * 2 + 1]
  for (let index = 0; index < n; index += 1) {
    const nextLat = ring[index * 2]
    const nextLon = ring[index * 2 + 1]
    if (segmentsCross(lat1, lon1, lat2, lon2, prevLat, prevLon, nextLat, nextLon)) return true
    prevLat = nextLat
    prevLon = nextLon
  }
  return false
}

function segmentCuts(book, lat1, lon1, lat2, lon2) {
  if (meters(lat1, lon1, lat2, lon2) <= 1.5) return false
  for (const id of candidates(book, lat1, lon1, lat2, lon2)) {
    if (cutsRing(ringOf(book, id), lat1, lon1, lat2, lon2)) return true
  }
  return false
}

function allowsLink(book, lat1, lon1, lat2, lon2) {
  const length = meters(lat1, lon1, lat2, lon2)
  if (length <= 1.5) return true
  const ids = candidates(book, lat1, lon1, lat2, lon2)
  let origin = -1
  for (const id of ids) {
    if (!pointInside(ringOf(book, id), lat1, lon1)) continue
    origin = id
    break
  }
  if (origin >= 0) {
    const share = exitShare(ringOf(book, origin), lat1, lon1, lat2, lon2)
    if (share == null) return length <= 40
    if (length * share > 40) return false
    if (length * (1 - share) > 22) return false
    const midLat = lat1 + (lat2 - lat1) * share
    const midLon = lon1 + (lon2 - lon1) * share
    for (const id of ids) {
      if (id === origin) continue
      if (ringHitsSegment(ringOf(book, id), midLat, midLon, lat2, lon2)) return false
    }
    return true
  }
  for (const id of ids) {
    if (cutsRing(ringOf(book, id), lat1, lon1, lat2, lon2)) return false
  }
  return true
}

function allowsConnector(book, lat1, lon1, lat2, lon2) {
  const length = meters(lat1, lon1, lat2, lon2)
  if (length <= 1.5) return true
  const ids = candidates(book, lat1, lon1, lat2, lon2)
  let origin = -1
  for (const id of ids) {
    if (!pointInside(ringOf(book, id), lat1, lon1)) continue
    origin = id
    break
  }
  if (origin >= 0) {
    const share = exitShare(ringOf(book, origin), lat1, lon1, lat2, lon2)
    if (share == null) return length <= 8
    if (length * share > 15) return false
    const midLat = lat1 + (lat2 - lat1) * share
    const midLon = lon1 + (lon2 - lon1) * share
    if (length * (1 - share) > 22) return false
    for (const id of ids) {
      if (id === origin) continue
      if (ringHitsSegment(ringOf(book, id), midLat, midLon, lat2, lon2)) return false
    }
    return true
  }
  if (length > 22) return false
  for (const id of ids) {
    if (ringHitsSegment(ringOf(book, id), lat1, lon1, lat2, lon2)) return false
  }
  return true
}

export function buildingsInView(book, west, south, east, north, limit = 2500) {
  const { y0, y1, x0, x1 } = cellRange(book.grid, south, north, west, east)
  const token = (book.token + 1) >>> 0
  book.token = token === 0 ? 1 : token
  if (token === 0) book.stamp.fill(0)
  const features = []
  for (let y = y0; y <= y1 && features.length < limit; y += 1) {
    for (let x = x0; x <= x1 && features.length < limit; x += 1) {
      const cell = y * book.grid.lonN + x
      for (let index = book.cellHead[cell]; index < book.cellHead[cell + 1] && features.length < limit; index += 1) {
        const id = book.cellIds[index]
        if (book.stamp[id] === book.token) continue
        book.stamp[id] = book.token
        const ring = ringOf(book, id)
        const n = ring.length / 2
        let seen = false
        const coordinates = new Array(n + 1)
        for (let point = 0; point < n; point += 1) {
          const lat = ring[point * 2]
          const lon = ring[point * 2 + 1]
          if (lat >= south && lat <= north && lon >= west && lon <= east) seen = true
          coordinates[point] = [lon, lat]
        }
        coordinates[n] = coordinates[0]
        if (!seen) continue
        features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coordinates] } })
      }
    }
  }
  return { type: "FeatureCollection", features }
}
