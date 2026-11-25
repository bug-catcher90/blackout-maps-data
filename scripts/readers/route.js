export function metersBetween(lat1, lon1, lat2, lon2) {
  const radius = 6371000
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)))
}

function push(heap, item) {
  heap.push(item)
  let i = heap.length - 1
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (heap[parent][0] <= heap[i][0]) break
    const swap = heap[parent]
    heap[parent] = heap[i]
    heap[i] = swap
    i = parent
  }
}

function pop(heap) {
  const top = heap[0]
  const last = heap.pop()
  if (heap.length === 0 || !last) return top
  heap[0] = last
  let i = 0
  for (;;) {
    let smallest = i
    const left = i * 2 + 1
    const right = left + 1
    if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left
    if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right
    if (smallest === i) break
    const swap = heap[smallest]
    heap[smallest] = heap[i]
    heap[i] = swap
    i = smallest
  }
  return top
}

export function prepareGraph(nodesE5, edges) {
  const nodes = nodesE5.map(([lat, lon]) => [lat / 1e5, lon / 1e5])
  const adj = Array.from({ length: nodes.length }, () => [])
  for (const edge of edges) {
    const a = edge[0]
    const b = edge[1]
    const mid = []
    for (let i = 3; i < edge.length; i += 2) mid.push([edge[i] / 1e5, edge[i + 1] / 1e5])
    const straight = metersBetween(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
    const len = Math.max(edge[2], straight)
    adj[a].push({ to: b, len, mid, dir: 1 })
    adj[b].push({ to: a, len, mid, dir: -1 })
  }
  const cell = 0.15
  const buckets = new Map()
  for (let i = 0; i < nodes.length; i += 1) {
    const key = `${Math.round(nodes[i][0] / cell)}:${Math.round(nodes[i][1] / cell)}`
    const list = buckets.get(key)
    if (list) list.push(i)
    else buckets.set(key, [i])
  }
  return { nodes, adj, buckets, cell }
}

function nearestNode(graph, lat, lon) {
  const { nodes, buckets, cell } = graph
  const gy = Math.round(lat / cell)
  const gx = Math.round(lon / cell)
  let best = -1
  let bestD = Infinity
  for (let radius = 0; radius <= 12; radius += 1) {
    let hit = false
    for (let y = gy - radius; y <= gy + radius; y += 1) {
      for (let x = gx - radius; x <= gx + radius; x += 1) {
        if (radius > 0 && Math.abs(y - gy) !== radius && Math.abs(x - gx) !== radius) continue
        const list = buckets.get(`${y}:${x}`)
        if (!list) continue
        hit = true
        for (const id of list) {
          const d = (nodes[id][0] - lat) ** 2 + (nodes[id][1] - lon) ** 2
          if (d < bestD) {
            bestD = d
            best = id
          }
        }
      }
    }
    if (hit && radius > 0) return best
  }
  return best
}

function direct(from, to) {
  return {
    coordinates: [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
    meters: metersBetween(from.lat, from.lon, to.lat, to.lon),
    direct: true,
    edges: [],
  }
}

export const TRAVEL_KMH = { walk: 5, bicycle: 15, car: 60 }
export const CLASS_KMH = [120, 100, 80, 70, 50, 40, 30, 20]
export const TOLL_BIT = 16

export function tripMinutes(meters, mode) {
  const kmh = TRAVEL_KMH[mode] || TRAVEL_KMH.car
  if (!Number.isFinite(meters) || meters <= 0) return 0
  return Math.max(1, Math.round((meters / 1000 / kmh) * 60))
}

export function isTollEdge(graph, edge) {
  return Boolean(graph?.klass) && (graph.klass[edge] & TOLL_BIT) !== 0
}

function classKmh(graph, edge) {
  if (!graph?.klass) return TRAVEL_KMH.car
  return CLASS_KMH[graph.klass[edge] & 7] || 40
}

function secondsFor(meters, kmh) {
  if (!Number.isFinite(meters) || meters <= 0) return 0
  return (meters / 1000 / kmh) * 3600
}

function timed(graph) {
  return graph?.costMode === "car" && Boolean(graph.klass)
}

function edgeCost(graph, edge, meters) {
  if (!timed(graph)) return meters
  return secondsFor(meters, classKmh(graph, edge))
}

function connectorCost(graph, meters) {
  if (!timed(graph)) return meters
  return secondsFor(meters, 20)
}

function heuristicCost(graph, meters) {
  if (!timed(graph)) return meters
  return secondsFor(meters, CLASS_KMH[0])
}

function bearingDeg(lon1, lat1, lon2, lat2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

function turnDelta(from, to) {
  return ((to - from + 540) % 360) - 180
}

function segmentShare(lat, lon, lon1, lat1, lon2, lat2) {
  const scale = Math.cos(((lat1 + lat2) * 0.5) * 0.017453292519943295)
  const dx = (lon2 - lon1) * scale
  const dy = lat2 - lat1
  const den = dx * dx + dy * dy
  if (den <= 0) return 0
  let share = (((lon - lon1) * scale) * dx + (lat - lat1) * dy) / den
  if (share < 0) share = 0
  else if (share > 1) share = 1
  return share
}

function lineCursor(coordinates, lat, lon) {
  let total = 0
  let best = Infinity
  let along = 0
  let qLat = coordinates[0][1]
  let qLon = coordinates[0][0]
  const spans = [0]
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1]
    const to = coordinates[index]
    const seg = metersBetween(from[1], from[0], to[1], to[0])
    const share = segmentShare(lat, lon, from[0], from[1], to[0], to[1])
    const latQ = from[1] + (to[1] - from[1]) * share
    const lonQ = from[0] + (to[0] - from[0]) * share
    const dist = metersBetween(lat, lon, latQ, lonQ)
    if (dist < best) {
      best = dist
      along = total + seg * share
      qLat = latQ
      qLon = lonQ
    }
    total += seg
    spans.push(total)
  }
  return { along, total, lat: qLat, lon: qLon, spans }
}

function pointOnLine(coordinates, spans, at) {
  if (at <= 0) return { lat: coordinates[0][1], lon: coordinates[0][0], index: 1 }
  for (let index = 1; index < coordinates.length; index += 1) {
    if (spans[index] + 1e-6 < at) continue
    const span = spans[index] - spans[index - 1]
    const share = span > 0 ? (at - spans[index - 1]) / span : 0
    const from = coordinates[index - 1]
    const to = coordinates[index]
    return {
      lat: from[1] + (to[1] - from[1]) * share,
      lon: from[0] + (to[0] - from[0]) * share,
      index,
    }
  }
  const last = coordinates[coordinates.length - 1]
  return { lat: last[1], lon: last[0], index: coordinates.length - 1 }
}

export function advanceOnLine(coordinates, lat, lon, distanceM) {
  if (!coordinates || coordinates.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const here = lineCursor(coordinates, lat, lon)
  const at = Math.max(0, Math.min(here.total, here.along + Math.max(0, distanceM || 0)))
  const point = pointOnLine(coordinates, here.spans, at)
  return { lat: point.lat, lon: point.lon, along: at, remaining: Math.max(0, here.total - at) }
}

export function sliceRoute(coordinates, lat, lon) {
  if (!coordinates || coordinates.length < 2 || !Number.isFinite(lat)) {
    return { coordinates: coordinates || [], meters: 0 }
  }
  const here = lineCursor(coordinates, lat, lon)
  const start = pointOnLine(coordinates, here.spans, here.along)
  const rest = [[start.lon, start.lat]]
  for (let index = start.index; index < coordinates.length; index += 1) {
    const point = coordinates[index]
    const last = rest[rest.length - 1]
    if (Math.abs(last[0] - point[0]) < 1e-7 && Math.abs(last[1] - point[1]) < 1e-7) continue
    rest.push(point)
  }
  if (rest.length === 1) rest.push(coordinates[coordinates.length - 1])
  return { coordinates: rest, meters: Math.max(0, here.total - here.along) }
}

function classifyTurn(delta) {
  const abs = Math.abs(delta)
  const right = delta > 0
  if (abs < 20) return null
  if (abs >= 160) return { turn: "uturn", text: "Inverta a marcha" }
  if (abs >= 120) return right
    ? { turn: "sharp-right", text: "Vire acentuadamente à direita" }
    : { turn: "sharp-left", text: "Vire acentuadamente à esquerda" }
  if (abs >= 50) return right
    ? { turn: "right", text: "Vire à direita" }
    : { turn: "left", text: "Vire à esquerda" }
  return right
    ? { turn: "slight-right", text: "Vire ligeiramente à direita" }
    : { turn: "slight-left", text: "Vire ligeiramente à esquerda" }
}

function alongPoint(coordinates, meters) {
  let walked = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1]
    const to = coordinates[index]
    const dist = metersBetween(from[1], from[0], to[1], to[0])
    if (walked + dist >= meters || index === coordinates.length - 1) {
      const share = dist > 0 ? Math.min(1, Math.max(0, (meters - walked) / dist)) : 0
      return {
        lat: from[1] + (to[1] - from[1]) * share,
        lon: from[0] + (to[0] - from[0]) * share,
      }
    }
    walked += dist
  }
  const last = coordinates[coordinates.length - 1] || [0, 0]
  return { lat: last[1], lon: last[0] }
}

function routeSamples(coordinates) {
  const samples = []
  let meters = 0
  for (let i = 1; i < coordinates.length; i += 1) {
    const from = coordinates[i - 1]
    const to = coordinates[i]
    const dist = metersBetween(from[1], from[0], to[1], to[0])
    if (dist < 8) {
      meters += dist
      continue
    }
    samples.push({ at: meters, head: bearingDeg(from[0], from[1], to[0], to[1]) })
    meters += dist
  }
  return { samples, meters }
}

function roundaboutAt(samples, index, base) {
  const start = samples[index].at
  let last = base
  let cumulative = 0
  let steps = 0
  let sign = 0
  for (let j = index; j < samples.length && samples[j].at - start <= 60; j += 1) {
    const step = turnDelta(last, samples[j].head)
    const abs = Math.abs(step)
    if (abs < 8) {
      last = samples[j].head
      continue
    }
    if (abs > 55) return false
    const nextSign = step > 0 ? 1 : -1
    if (sign && nextSign !== sign) return false
    sign = nextSign
    cumulative += step
    steps += 1
    last = samples[j].head
  }
  return steps >= 3 && Math.abs(cumulative) >= 55 && Math.abs(cumulative) <= 300
}

function maneuverAt(coordinates, meters, turn, text) {
  const spot = alongPoint(coordinates, Math.min(routeSamples(coordinates).meters, meters + 15))
  return { turn, text, meters, lat: spot.lat, lon: spot.lon }
}

export function maneuver(coordinates) {
  const { samples, meters } = routeSamples(coordinates)
  if (!samples.length) return maneuverAt(coordinates, 0, "straight", "Siga em frente")
  if (samples.length === 1) return maneuverAt(coordinates, meters, "straight", "Siga em frente")
  let base = samples[0].head
  for (let i = 1; i < samples.length; i += 1) {
    const delta = turnDelta(base, samples[i].head)
    if (Math.abs(delta) < 20) {
      base = samples[i].head
      continue
    }
    if (roundaboutAt(samples, i, base)) return maneuverAt(coordinates, samples[i].at, "roundabout", "Entre na rotunda")
    const kind = classifyTurn(delta)
    if (kind) return maneuverAt(coordinates, samples[i].at, kind.turn, kind.text)
    base = samples[i].head
  }
  return maneuverAt(coordinates, meters, "straight", "Siga em frente")
}

export function nextInstruction(coordinates) {
  return maneuver(coordinates).text
}

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

function sameEdges(a, b) {
  if (!a?.edges || !b?.edges || a.edges.length !== b.edges.length) return false
  for (let i = 0; i < a.edges.length; i += 1) if (a.edges[i] !== b.edges[i]) return false
  return true
}

function routePrepared(graph, from, to, penalty) {
  if (!graph || !from || !to) return penalty ? null : direct(from, to)
  const start = nearestNode(graph, from.lat, from.lon)
  const goal = nearestNode(graph, to.lat, to.lon)
  if (start < 0 || goal < 0 || start === goal) return penalty ? null : direct(from, to)

  const { nodes, adj } = graph
  const count = nodes.length
  const gScore = new Float64Array(count)
  const trueScore = new Float64Array(count)
  gScore.fill(Infinity)
  trueScore.fill(Infinity)
  gScore[start] = 0
  trueScore[start] = 0
  const prev = new Int32Array(count)
  prev.fill(-1)
  const settled = new Uint8Array(count)
  const goalLat = nodes[goal][0]
  const goalLon = nodes[goal][1]
  const heap = [[metersBetween(nodes[start][0], nodes[start][1], goalLat, goalLon), start]]
  let found = false
  while (heap.length) {
    const item = pop(heap)
    const u = item[1]
    if (settled[u]) continue
    settled[u] = 1
    if (u === goal) {
      found = true
      break
    }
    for (const edge of adj[u]) {
      if (settled[edge.to]) continue
      const factor = penalty && penalty.has(edgeKey(u, edge.to)) ? 6 : 1
      const next = gScore[u] + edge.len * factor
      if (next >= gScore[edge.to]) continue
      gScore[edge.to] = next
      trueScore[edge.to] = trueScore[u] + edge.len
      prev[edge.to] = u
      const h = metersBetween(nodes[edge.to][0], nodes[edge.to][1], goalLat, goalLon)
      push(heap, [next + h, edge.to])
    }
  }
  if (!found) return penalty ? null : direct(from, to)

  const ids = []
  for (let node = goal; node >= 0; node = prev[node]) {
    ids.push(node)
    if (node === start) break
  }
  ids.reverse()
  if (ids[0] !== start) return penalty ? null : direct(from, to)

  const edges = []
  const coordinates = [[from.lon, from.lat], [nodes[start][1], nodes[start][0]]]
  for (let i = 1; i < ids.length; i += 1) {
    edges.push(edgeKey(ids[i - 1], ids[i]))
    const edge = adj[ids[i - 1]].find((item) => item.to === ids[i])
    const mids = edge && edge.dir === 1 ? edge.mid : edge ? [...edge.mid].reverse() : []
    for (const [lat, lon] of mids) coordinates.push([lon, lat])
    coordinates.push([nodes[ids[i]][1], nodes[ids[i]][0]])
  }
  coordinates.push([to.lon, to.lat])
  const link =
    metersBetween(from.lat, from.lon, nodes[start][0], nodes[start][1]) +
    metersBetween(nodes[goal][0], nodes[goal][1], to.lat, to.lon)
  return { coordinates, meters: trueScore[goal] + link, direct: false, edges }
}

export function isMotorwayEdge(graph, edge) {
  return Boolean(graph?.klass) && (graph.klass[edge] & 7) === 0
}

export function knownRoadLimits(graph) {
  return {
    motorway: Boolean(graph?.klass),
    toll: Boolean(graph?.klass),
    ic: false,
  }
}

export function findRoute(graph, from, to, penalty, mode = "car", maxMeters = Infinity, allow = null) {
  if (graph?.kind === "road") return routeOnRoad(graph, from, to, penalty, mode, maxMeters, allow)
  return routePrepared(graph, from, to, penalty)
}

export function findRoutes(graph, from, to, mode = "car") {
  if (graph?.kind === "road") return findRoadRoutes(graph, from, to, mode)
  const first = findRoute(graph, from, to)
  if (!first) return []
  const routes = [first]
  if (first.direct || !first.edges?.length) return routes
  const used = new Set(first.edges)
  const second = findRoute(graph, from, to, used)
  if (second && !sameEdges(first, second)) {
    routes.push(second)
    const usedMore = new Set([...used, ...(second.edges || [])])
    const third = findRoute(graph, from, to, usedMore)
    if (third && !routes.some((route) => sameEdges(route, third))) routes.push(third)
  }
  return routes
}

const ROAD_NONE = 0xffffffff
const WALK_BIT = 1
const SNAP_M = { walk: 55, bicycle: 22, car: 22 }
const APPROACH_M = 1500

export const MODE_BIT = { walk: WALK_BIT, bicycle: 2, car: 4 }

function align4(value) {
  return (value + 3) & ~3
}

function createHeap() {
  let keys = new Float64Array(1024)
  let vals = new Int32Array(1024)
  let size = 0
  return {
    get size() {
      return size
    },
    push(key, val) {
      if (size === keys.length) {
        const nextKeys = new Float64Array(size * 2)
        const nextVals = new Int32Array(size * 2)
        nextKeys.set(keys)
        nextVals.set(vals)
        keys = nextKeys
        vals = nextVals
      }
      keys[size] = key
      vals[size] = val
      let index = size
      size += 1
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (keys[parent] <= keys[index]) break
        const keySwap = keys[parent]
        keys[parent] = keys[index]
        keys[index] = keySwap
        const valSwap = vals[parent]
        vals[parent] = vals[index]
        vals[index] = valSwap
        index = parent
      }
    },
    pop() {
      const key = keys[0]
      const val = vals[0]
      size -= 1
      if (size > 0) {
        keys[0] = keys[size]
        vals[0] = vals[size]
        let index = 0
        for (;;) {
          let smallest = index
          const left = index * 2 + 1
          const right = left + 1
          if (left < size && keys[left] < keys[smallest]) smallest = left
          if (right < size && keys[right] < keys[smallest]) smallest = right
          if (smallest === index) break
          const keySwap = keys[smallest]
          keys[smallest] = keys[index]
          keys[index] = keySwap
          const valSwap = vals[smallest]
          vals[smallest] = vals[index]
          vals[index] = valSwap
          index = smallest
        }
      }
      return [key, val]
    },
  }
}

export function openRoadGraph(buffer) {
  const view = new DataView(buffer)
  if (view.byteLength < 64 || view.getUint8(0) !== 82 || view.getUint8(1) !== 68 || view.getUint8(2) !== 71 || view.getUint8(3) !== 49) {
    throw new Error("roads")
  }
  if (view.getUint32(4, true) !== 1) throw new Error("roads")
  const nodeCount = view.getUint32(8, true)
  const edgeCount = view.getUint32(12, true)
  const geomCount = view.getUint32(16, true)
  const cellCount = view.getUint32(20, true)
  const gridLat0 = view.getInt32(24, true)
  const gridLon0 = view.getInt32(28, true)
  const gridLatN = view.getUint32(32, true)
  const gridLonN = view.getUint32(36, true)
  const gridStep = view.getUint32(40, true)
  const bytes = view.getUint32(44, true)
  if (bytes && bytes !== buffer.byteLength) throw new Error("roads")
  let offset = 64
  const lat = new Int32Array(buffer, offset, nodeCount)
  offset += nodeCount * 4
  const lon = new Int32Array(buffer, offset, nodeCount)
  offset += nodeCount * 4
  const head = new Uint32Array(buffer, offset, nodeCount + 1)
  offset += (nodeCount + 1) * 4
  const from = new Uint32Array(buffer, offset, edgeCount)
  offset += edgeCount * 4
  const to = new Uint32Array(buffer, offset, edgeCount)
  offset += edgeCount * 4
  const len = new Uint32Array(buffer, offset, edgeCount)
  offset += edgeCount * 4
  const rev = new Uint32Array(buffer, offset, edgeCount)
  offset += edgeCount * 4
  const access = new Uint8Array(buffer, offset, edgeCount)
  offset = align4(offset + edgeCount)
  const klass = new Uint8Array(buffer, offset, edgeCount)
  offset = align4(offset + edgeCount)
  const geomOff = new Uint32Array(buffer, offset, edgeCount)
  offset += edgeCount * 4
  const geomN = new Uint16Array(buffer, offset, edgeCount)
  offset = align4(offset + edgeCount * 2)
  const geomLat = new Int32Array(buffer, offset, geomCount)
  offset += geomCount * 4
  const geomLon = new Int32Array(buffer, offset, geomCount)
  offset += geomCount * 4
  const cellHead = new Uint32Array(buffer, offset, cellCount + 1)
  offset += (cellCount + 1) * 4
  const cellEdgeCount = cellHead[cellCount]
  const cellEdges = new Uint32Array(buffer, offset, cellEdgeCount)
  offset += cellEdgeCount * 4
  if (offset !== buffer.byteLength) throw new Error("roads")
  return {
    kind: "road",
    nodeCount,
    edgeCount,
    lat,
    lon,
    head,
    from,
    to,
    len,
    rev,
    access,
    klass,
    geomOff,
    geomN,
    geomLat,
    geomLon,
    cellHead,
    cellEdges,
    gridLat0,
    gridLon0,
    gridLatN,
    gridLonN,
    gridStep,
    bytes: buffer.byteLength,
  }
}

export function buildRoadGraph(nodes, edges) {
  const nodeCount = nodes.length
  const lat = Int32Array.from(nodes.map((node) => Math.round(node[0] * 1e7)))
  const lon = Int32Array.from(nodes.map((node) => Math.round(node[1] * 1e7)))
  const prepared = edges.map((edge) => {
    const mid = edge.mid || []
    const points = [[nodes[edge.from][0], nodes[edge.from][1]]]
    for (const point of mid) points.push(point)
    points.push([nodes[edge.to][0], nodes[edge.to][1]])
    let length = 0
    for (let i = 1; i < points.length; i += 1) {
      length += metersBetween(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
    }
    return {
      from: edge.from,
      to: edge.to,
      len: Math.max(1, Math.round(length)),
      access: edge.access,
      klass: edge.klass || 0,
      mid,
    }
  })
  prepared.sort((a, b) => a.from - b.from || a.to - b.to)
  const edgeCount = prepared.length
  const from = new Uint32Array(edgeCount)
  const to = new Uint32Array(edgeCount)
  const len = new Uint32Array(edgeCount)
  const access = new Uint8Array(edgeCount)
  const klass = new Uint8Array(edgeCount)
  const rev = new Uint32Array(edgeCount)
  const geomOff = new Uint32Array(edgeCount)
  const geomN = new Uint16Array(edgeCount)
  rev.fill(ROAD_NONE)
  geomOff.fill(ROAD_NONE)
  const geomLat = []
  const geomLon = []
  for (let index = 0; index < edgeCount; index += 1) {
    const edge = prepared[index]
    from[index] = edge.from
    to[index] = edge.to
    len[index] = edge.len
    access[index] = edge.access
    klass[index] = edge.klass
    if (edge.mid.length) {
      geomOff[index] = geomLat.length
      geomN[index] = edge.mid.length
      for (const point of edge.mid) {
        geomLat.push(Math.round(point[0] * 1e7))
        geomLon.push(Math.round(point[1] * 1e7))
      }
    }
  }
  for (let index = 0; index < edgeCount; index += 1) {
    if (rev[index] !== ROAD_NONE) continue
    for (let other = 0; other < edgeCount; other += 1) {
      if (other !== index && from[other] === to[index] && to[other] === from[index] && rev[other] === ROAD_NONE) {
        rev[index] = other
        rev[other] = index
        break
      }
    }
  }
  const head = new Uint32Array(nodeCount + 1)
  for (let index = 0; index < edgeCount; index += 1) head[from[index] + 1] += 1
  for (let index = 1; index <= nodeCount; index += 1) head[index] += head[index - 1]
  let minLat = Infinity
  let minLon = Infinity
  let maxLat = -Infinity
  let maxLon = -Infinity
  for (let index = 0; index < nodeCount; index += 1) {
    minLat = Math.min(minLat, lat[index])
    maxLat = Math.max(maxLat, lat[index])
    minLon = Math.min(minLon, lon[index])
    maxLon = Math.max(maxLon, lon[index])
  }
  const gridStep = 100000
  const gridLat0 = minLat - gridStep
  const gridLon0 = minLon - gridStep
  const gridLatN = Math.max(1, Math.ceil((maxLat - gridLat0) / gridStep) + 1)
  const gridLonN = Math.max(1, Math.ceil((maxLon - gridLon0) / gridStep) + 1)
  const cellCount = gridLatN * gridLonN
  const buckets = Array.from({ length: cellCount }, () => [])
  for (let edge = 0; edge < edgeCount; edge += 1) {
    let loLat = lat[from[edge]]
    let hiLat = loLat
    let loLon = lon[from[edge]]
    let hiLon = loLon
    const count = geomN[edge]
    const off = count ? geomOff[edge] : 0
    for (let i = 0; i < count; i += 1) {
      loLat = Math.min(loLat, geomLat[off + i])
      hiLat = Math.max(hiLat, geomLat[off + i])
      loLon = Math.min(loLon, geomLon[off + i])
      hiLon = Math.max(hiLon, geomLon[off + i])
    }
    loLat = Math.min(loLat, lat[to[edge]])
    hiLat = Math.max(hiLat, lat[to[edge]])
    loLon = Math.min(loLon, lon[to[edge]])
    hiLon = Math.max(hiLon, lon[to[edge]])
    const y0 = Math.max(0, Math.min(gridLatN - 1, Math.floor((loLat - gridLat0) / gridStep)))
    const y1 = Math.max(0, Math.min(gridLatN - 1, Math.floor((hiLat - gridLat0) / gridStep)))
    const x0 = Math.max(0, Math.min(gridLonN - 1, Math.floor((loLon - gridLon0) / gridStep)))
    const x1 = Math.max(0, Math.min(gridLonN - 1, Math.floor((hiLon - gridLon0) / gridStep)))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) buckets[y * gridLonN + x].push(edge)
    }
  }
  const cellHead = new Uint32Array(cellCount + 1)
  for (let index = 0; index < cellCount; index += 1) cellHead[index + 1] = cellHead[index] + buckets[index].length
  const cellEdges = new Uint32Array(cellHead[cellCount])
  for (let index = 0; index < cellCount; index += 1) cellEdges.set(buckets[index], cellHead[index])
  return {
    kind: "road",
    nodeCount,
    edgeCount,
    lat,
    lon,
    head,
    from,
    to,
    len,
    rev,
    access,
    klass,
    geomOff,
    geomN,
    geomLat: Int32Array.from(geomLat),
    geomLon: Int32Array.from(geomLon),
    cellHead,
    cellEdges,
    gridLat0,
    gridLon0,
    gridLatN,
    gridLonN,
    gridStep,
    bytes: 0,
  }
}

function pushCoord(coordinates, lon, lat) {
  const last = coordinates[coordinates.length - 1]
  if (last && Math.abs(last[0] - lon) < 1e-6 && Math.abs(last[1] - lat) < 1e-6) return
  coordinates.push([lon, lat])
}

function nodeLat(graph, node) {
  return graph.lat[node] * 1e-7
}

function nodeLon(graph, node) {
  return graph.lon[node] * 1e-7
}

function edgeLine(graph, edge) {
  const from = graph.from[edge]
  const to = graph.to[edge]
  const count = graph.geomN[edge]
  const off = count ? graph.geomOff[edge] : 0
  const total = count + 2
  const lat = new Float64Array(total)
  const lon = new Float64Array(total)
  const at = new Float64Array(total)
  lat[0] = nodeLat(graph, from)
  lon[0] = nodeLon(graph, from)
  for (let i = 0; i < count; i += 1) {
    lat[i + 1] = graph.geomLat[off + i] * 1e-7
    lon[i + 1] = graph.geomLon[off + i] * 1e-7
  }
  lat[total - 1] = nodeLat(graph, to)
  lon[total - 1] = nodeLon(graph, to)
  for (let i = 1; i < total; i += 1) at[i] = at[i - 1] + metersBetween(lat[i - 1], lon[i - 1], lat[i], lon[i])
  return { lat, lon, at, total: at[total - 1] }
}

function pointAt(line, meters) {
  if (meters <= 0) return [line.lon[0], line.lat[0]]
  if (meters >= line.total) return [line.lon[line.lon.length - 1], line.lat[line.lat.length - 1]]
  let index = 1
  while (index < line.at.length - 1 && line.at[index] < meters) index += 1
  const span = line.at[index] - line.at[index - 1]
  const tee = span > 0 ? (meters - line.at[index - 1]) / span : 0
  return [line.lon[index - 1] + (line.lon[index] - line.lon[index - 1]) * tee, line.lat[index - 1] + (line.lat[index] - line.lat[index - 1]) * tee]
}

function sliceLine(line, fromM, toM) {
  const start = Math.max(0, Math.min(fromM, line.total))
  const end = Math.max(start, Math.min(toM, line.total))
  const coordinates = [pointAt(line, start)]
  for (let index = 1; index < line.at.length - 1; index += 1) {
    if (line.at[index] <= start + 0.3) continue
    if (line.at[index] >= end - 0.3) break
    coordinates.push([line.lon[index], line.lat[index]])
  }
  const last = pointAt(line, end)
  pushCoord(coordinates, last[0], last[1])
  return coordinates
}

function appendLine(coordinates, line, fromM, toM) {
  for (const [lon, lat] of sliceLine(line, fromM, toM)) pushCoord(coordinates, lon, lat)
}

function projectEdge(graph, edge, lat, lon) {
  const from = graph.from[edge]
  const to = graph.to[edge]
  const count = graph.geomN[edge]
  const off = count ? graph.geomOff[edge] : 0
  const xScale = Math.cos(lat * 0.017453292519943295) * 111320
  let prevLat = nodeLat(graph, from)
  let prevLon = nodeLon(graph, from)
  let best = Infinity
  let bestLat = prevLat
  let bestLon = prevLon
  let bestAlong = 0
  let walked = 0
  const steps = count + 1
  for (let index = 0; index < steps; index += 1) {
    const nextLat = index < count ? graph.geomLat[off + index] * 1e-7 : nodeLat(graph, to)
    const nextLon = index < count ? graph.geomLon[off + index] * 1e-7 : nodeLon(graph, to)
    const ax = prevLon * xScale
    const bx = nextLon * xScale
    const px = lon * xScale
    const ay = prevLat * 110540
    const by = nextLat * 110540
    const py = lat * 110540
    const dx = bx - ax
    const dy = by - ay
    const den = dx * dx + dy * dy
    let tee = 0
    if (den > 0) {
      tee = ((px - ax) * dx + (py - ay) * dy) / den
      if (tee < 0) tee = 0
      else if (tee > 1) tee = 1
    }
    const qLat = (ay + dy * tee) / 110540
    const qLon = (ax + dx * tee) / xScale
    const dist = Math.hypot((qLat - lat) * 110540, (qLon - lon) * xScale)
    const seg = metersBetween(prevLat, prevLon, nextLat, nextLon)
    if (dist < best) {
      best = dist
      bestLat = qLat
      bestLon = qLon
      bestAlong = walked + tee * seg
    }
    walked += seg
    prevLat = nextLat
    prevLon = nextLon
  }
  return { edge, dist: best, lat: bestLat, lon: bestLon, along: bestAlong, total: walked }
}

function snapPoint(graph, lat, lon, bit, maxMeters, skip) {
  const gy = Math.floor((lat * 1e7 - graph.gridLat0) / graph.gridStep)
  const gx = Math.floor((lon * 1e7 - graph.gridLon0) / graph.gridStep)
  if (!graph.edgeSeen || graph.edgeSeen.length !== graph.edgeCount) {
    graph.edgeSeen = new Uint32Array(graph.edgeCount)
    graph.edgeTick = 1
  }
  graph.edgeTick = (graph.edgeTick + 1) >>> 0
  if (graph.edgeTick === 0) {
    graph.edgeSeen.fill(0)
    graph.edgeTick = 1
  }
  const tick = graph.edgeTick
  let best = null
  const visit = (y, x) => {
    if (y < 0 || x < 0 || y >= graph.gridLatN || x >= graph.gridLonN) return
    const cell = y * graph.gridLonN + x
    for (let index = graph.cellHead[cell]; index < graph.cellHead[cell + 1]; index += 1) {
      const edge = graph.cellEdges[index]
      if (graph.edgeSeen[edge] === tick) continue
      graph.edgeSeen[edge] = tick
      if (skip && skip.has(edge)) continue
      if (!permitted(graph, edge, bit)) continue
      const hit = projectEdge(graph, edge, lat, lon)
      if (!best || hit.dist < best.dist) best = hit
    }
  }
  for (let y = gy - 1; y <= gy + 1; y += 1) {
    for (let x = gx - 1; x <= gx + 1; x += 1) visit(y, x)
  }
  if (!best || best.dist > maxMeters) {
    for (let y = gy - 2; y <= gy + 2; y += 1) {
      for (let x = gx - 2; x <= gx + 2; x += 1) {
        if (Math.abs(y - gy) <= 1 && Math.abs(x - gx) <= 1) continue
        visit(y, x)
      }
    }
  }
  if (!best || best.dist > maxMeters) return null
  return best
}

function edgeCutsBuilding(graph, edge) {
  if (!graph.buildings?.cuts || graph.costMode !== "walk") return false
  if (!graph.walkOpen || graph.walkOpen.length !== graph.edgeCount) graph.walkOpen = new Uint8Array(graph.edgeCount)
  const known = graph.walkOpen[edge]
  if (known) return known === 2
  const line = edgeLine(graph, edge)
  let cuts = false
  for (let index = 1; index < line.lat.length; index += 1) {
    if (graph.buildings.cuts(line.lat[index - 1], line.lon[index - 1], line.lat[index], line.lon[index])) {
      cuts = true
      break
    }
  }
  graph.walkOpen[edge] = cuts ? 2 : 1
  return cuts
}

function permitted(graph, edge, bit) {
  const access = graph.access[edge] || 0
  let allowed = (access & bit) !== 0
  if (!allowed && bit === WALK_BIT && graph.klass && graph.len[edge] <= 40 && (graph.klass[edge] & 7) >= 3 && (access & 6) !== 0) allowed = true
  if (!allowed) return false
  if (graph.allow && !graph.allow(edge)) return false
  if (bit === WALK_BIT && edgeCutsBuilding(graph, edge)) return false
  return true
}

function bestRoadExit(graph, node, heading, bit, skipEdge) {
  let best = -1
  let bestAbs = 181
  const lat = nodeLat(graph, node)
  const lon = nodeLon(graph, node)
  for (let edge = graph.head[node]; edge < graph.head[node + 1]; edge += 1) {
    if (edge === skipEdge || !permitted(graph, edge, bit)) continue
    const line = edgeLine(graph, edge)
    const aim = pointAt(line, Math.min(8, line.total))
    const bearing = bearingDeg(lon, lat, aim[0], aim[1])
    const delta = Math.abs(turnDelta(heading, bearing))
    if (delta < bestAbs) {
      bestAbs = delta
      best = edge
    }
  }
  return best
}

export function moveAlongRoad(graph, lat, lon, distanceM, headingDeg, mode = "walk") {
  if (!graph || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const bit = MODE_BIT[mode] || MODE_BIT.walk
  const snap = snapPoint(graph, lat, lon, bit, mode === "walk" ? 80 : 45, null)
  if (!snap) return null
  if (!(distanceM > 0) || !Number.isFinite(headingDeg)) return { lat: snap.lat, lon: snap.lon }
  let edge = snap.edge
  let line = edgeLine(graph, edge)
  let along = snap.along
  let dir = 1
  const aheadPoint = pointAt(line, Math.min(line.total, along + 6))
  const ahead = bearingDeg(snap.lon, snap.lat, aheadPoint[0], aheadPoint[1])
  let preferBack = false
  if (along > 4) {
    const backPoint = pointAt(line, Math.max(0, along - 6))
    const back = bearingDeg(snap.lon, snap.lat, backPoint[0], backPoint[1])
    preferBack = Math.abs(turnDelta(headingDeg, back)) + 8 < Math.abs(turnDelta(headingDeg, ahead))
  }
  if (preferBack) {
    const rev = graph.rev[edge]
    if (rev !== ROAD_NONE && permitted(graph, rev, bit)) {
      edge = rev
      line = edgeLine(graph, edge)
      along = Math.max(0, line.total - snap.along)
    } else {
      dir = -1
    }
  }
  let remain = distanceM
  for (let guard = 0; guard < 40 && remain > 0.2; guard += 1) {
    if (dir > 0) {
      const room = line.total - along
      if (room >= remain) {
        const point = pointAt(line, along + remain)
        return { lat: point[1], lon: point[0] }
      }
      remain -= Math.max(0, room)
      const node = graph.to[edge]
      const skip = graph.rev[edge]
      const next = bestRoadExit(graph, node, headingDeg, bit, skip === ROAD_NONE ? -1 : skip)
      if (next < 0) {
        const point = pointAt(line, line.total)
        return { lat: point[1], lon: point[0] }
      }
      edge = next
      line = edgeLine(graph, edge)
      along = 0
      dir = 1
      continue
    }
    if (along >= remain) {
      const point = pointAt(line, along - remain)
      return { lat: point[1], lon: point[0] }
    }
    remain -= Math.max(0, along)
    const node = graph.from[edge]
    const next = bestRoadExit(graph, node, headingDeg, bit, edge)
    if (next < 0) {
      const point = pointAt(line, 0)
      return { lat: point[1], lon: point[0] }
    }
    edge = next
    line = edgeLine(graph, edge)
    along = 0
    dir = 1
  }
  const point = pointAt(line, dir > 0 ? along : Math.max(0, along))
  return { lat: point[1], lon: point[0] }
}

function hasOutgoing(graph, node, bit) {
  for (let edge = graph.head[node]; edge < graph.head[node + 1]; edge += 1) {
    if (permitted(graph, edge, bit)) return true
  }
  return false
}

function appendEdge(graph, coordinates, edge) {
  const line = edgeLine(graph, edge)
  for (let index = 1; index < line.lat.length; index += 1) pushCoord(coordinates, line.lon[index], line.lat[index])
}

function leaveSnap(graph, snap, point, bit, penalty) {
  const results = []
  const add = (edge) => {
    if (!permitted(graph, edge, bit)) return
    const hit = edge === snap.edge ? snap : projectEdge(graph, edge, snap.lat, snap.lon)
    const line = edgeLine(graph, edge)
    if (!linkAllowed(graph, point.lat, point.lon, hit.lat, hit.lon)) return
    const connector = connectorCost(graph, metersBetween(point.lat, point.lon, hit.lat, hit.lon))
    const startLon = point.lon
    const startLat = point.lat
    if (hit.along <= 2) {
      const coordinates = [[startLon, startLat]]
      pushCoord(coordinates, nodeLon(graph, graph.from[edge]), nodeLat(graph, graph.from[edge]))
      results.push({ node: graph.from[edge], cost: connector, coordinates, edges: [] })
    }
    const remain = line.total - hit.along
    if (remain <= 2) {
      const coordinates = [[startLon, startLat]]
      pushCoord(coordinates, nodeLon(graph, graph.to[edge]), nodeLat(graph, graph.to[edge]))
      results.push({ node: graph.to[edge], cost: connector, coordinates, edges: [] })
    } else {
      let weight = edgeCost(graph, edge, remain)
      if (penalty && penalty.has(edge)) weight *= 6
      const coordinates = [[startLon, startLat]]
      appendLine(coordinates, line, hit.along, line.total)
      results.push({ node: graph.to[edge], cost: connector + weight, coordinates, edges: [edge] })
    }
  }
  add(snap.edge)
  const rev = graph.rev[snap.edge]
  if (rev !== ROAD_NONE) add(rev)
  return results
}

function enterSnap(graph, snap, point, bit, penalty) {
  const results = []
  const add = (edge) => {
    if (!permitted(graph, edge, bit)) return
    const hit = edge === snap.edge ? snap : projectEdge(graph, edge, point.lat, point.lon)
    const line = edgeLine(graph, edge)
    if (!linkAllowed(graph, point.lat, point.lon, hit.lat, hit.lon)) return
    const connector = connectorCost(graph, metersBetween(point.lat, point.lon, hit.lat, hit.lon))
    if (hit.along <= 2) {
      const coordinates = [[nodeLon(graph, graph.from[edge]), nodeLat(graph, graph.from[edge])]]
      pushCoord(coordinates, point.lon, point.lat)
      results.push({ node: graph.from[edge], cost: connector, coordinates, edges: [] })
    } else {
      let weight = edgeCost(graph, edge, hit.along)
      if (penalty && penalty.has(edge)) weight *= 6
      const coordinates = []
      appendLine(coordinates, line, 0, hit.along)
      pushCoord(coordinates, point.lon, point.lat)
      results.push({ node: graph.from[edge], cost: connector + weight, coordinates, edges: [edge] })
    }
    if (line.total - hit.along <= 2) {
      const coordinates = [[nodeLon(graph, graph.to[edge]), nodeLat(graph, graph.to[edge])]]
      pushCoord(coordinates, point.lon, point.lat)
      results.push({ node: graph.to[edge], cost: connector, coordinates, edges: [] })
    }
  }
  add(snap.edge)
  const rev = graph.rev[snap.edge]
  if (rev !== ROAD_NONE) add(rev)
  return results
}

function approachFromWalk(graph, point, bit, walk) {
  const saved = graph.costMode
  graph.costMode = "walk"
  const starts = leaveSnap(graph, walk, point, WALK_BIT, null)
  graph.costMode = saved
  const best = new Map()
  const heap = createHeap()
  const seen = []
  for (const start of starts) {
    const known = best.get(start.node)
    if (known && known.cost <= start.cost) continue
    best.set(start.node, { node: start.node, cost: start.cost, coordinates: start.coordinates, edges: [] })
    heap.push(start.cost, start.node)
  }
  const found = []
  let pops = 0
  while (heap.size && pops < 12000) {
    const popped = heap.pop()
    const node = popped[1]
    const known = best.get(node)
    if (!known || popped[0] > known.cost + 0.2) continue
    pops += 1
    if (hasOutgoing(graph, node, bit)) found.push(known)
    if (known.cost > APPROACH_M) continue
    for (let edge = graph.head[node]; edge < graph.head[node + 1]; edge += 1) {
      if ((graph.access[edge] & WALK_BIT) === 0) continue
      seen.push(edge)
      const next = graph.to[edge]
      const cost = known.cost + graph.len[edge]
      if (cost > APPROACH_M) continue
      const previous = best.get(next)
      if (previous && previous.cost <= cost) continue
      const coordinates = known.coordinates.slice()
      appendEdge(graph, coordinates, edge)
      best.set(next, { node: next, cost, coordinates, edges: [] })
      heap.push(cost, next)
    }
  }
  found.sort((a, b) => a.cost - b.cost)
  return { found, seen }
}

function linkAllowed(graph, fromLat, fromLon, toLat, toLon) {
  if (!graph.buildings || graph.costMode !== "walk") return true
  const check = graph.buildings.links || graph.buildings.allows
  return check(fromLat, fromLon, toLat, toLon)
}

function snapOnNode(graph, edge, node, point) {
  const lat = nodeLat(graph, node)
  const lon = nodeLon(graph, node)
  const line = edgeLine(graph, edge)
  const atEnd = node === graph.to[edge]
  return {
    edge,
    dist: metersBetween(point.lat, point.lon, lat, lon),
    lat,
    lon,
    along: atEnd ? line.total : 0,
    total: line.total,
  }
}

function walkSnap(graph, point, skip) {
  const skipped = new Set(skip || [])
  for (const max of [55, 140, 280]) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const hit = snapPoint(graph, point.lat, point.lon, WALK_BIT, max, skipped)
      if (!hit) break
      if (linkAllowed(graph, point.lat, point.lon, hit.lat, hit.lon)) return { kind: "edge", snap: hit }
      const ends = [graph.from[hit.edge], graph.to[hit.edge]]
      let best = null
      for (const node of ends) {
        const lat = nodeLat(graph, node)
        const lon = nodeLon(graph, node)
        if (!linkAllowed(graph, point.lat, point.lon, lat, lon)) continue
        const candidate = snapOnNode(graph, hit.edge, node, point)
        if (!best || candidate.dist < best.dist) best = candidate
      }
      if (best) return { kind: "edge", snap: best }
      skipped.add(hit.edge)
      const rev = graph.rev[hit.edge]
      if (rev !== ROAD_NONE) skipped.add(rev)
    }
  }
  return null
}

function approachNodes(graph, point, bit, skip) {
  const mode = bit === WALK_BIT ? "walk" : bit === 2 ? "bicycle" : "car"
  if (bit === WALK_BIT && graph.buildings) return walkSnap(graph, point, skip)
  const direct = snapPoint(graph, point.lat, point.lon, bit, SNAP_M[mode], skip)
  if (direct) return { kind: "edge", snap: direct }
  if (bit === WALK_BIT) {
    const farther = snapPoint(graph, point.lat, point.lon, bit, 140, skip)
    return farther ? { kind: "edge", snap: farther } : null
  }
  const skipped = new Set(skip || [])
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const walk = snapPoint(graph, point.lat, point.lon, WALK_BIT, 140, skipped)
    if (!walk) break
    const { found, seen } = approachFromWalk(graph, point, bit, walk)
    if (found.length) return { kind: "nodes", nodes: found.slice(0, 48) }
    skipped.add(walk.edge)
    const rev = graph.rev[walk.edge]
    if (rev !== ROAD_NONE) skipped.add(rev)
    for (const edge of seen) skipped.add(edge)
  }
  const farther = snapPoint(graph, point.lat, point.lon, bit, 450, skip)
  return farther ? { kind: "edge", snap: farther } : null
}

function terminalsFor(graph, access, point, bit, penalty, towardDoor) {
  if (!access) return []
  if (access.kind === "nodes") {
    return access.nodes.map((node) => ({
      node: node.node,
      cost: timed(graph) ? secondsFor(node.cost, TRAVEL_KMH.walk) : node.cost,
      coordinates: towardDoor ? node.coordinates.slice().reverse() : node.coordinates,
      edges: [],
    }))
  }
  return towardDoor ? enterSnap(graph, access.snap, point, bit, penalty) : leaveSnap(graph, access.snap, point, bit, penalty)
}

function sameEdgeRoute(graph, from, to, fromAccess, toAccess, bit, penalty) {
  if (!fromAccess || !toAccess || fromAccess.kind !== "edge" || toAccess.kind !== "edge") return null
  const seen = new Set([fromAccess.snap.edge, toAccess.snap.edge])
  const revFrom = graph.rev[fromAccess.snap.edge]
  const revTo = graph.rev[toAccess.snap.edge]
  if (revFrom !== ROAD_NONE) seen.add(revFrom)
  if (revTo !== ROAD_NONE) seen.add(revTo)
  let best = null
  for (const edge of seen) {
    if (!permitted(graph, edge, bit)) continue
    const start = projectEdge(graph, edge, from.lat, from.lon)
    const end = projectEdge(graph, edge, to.lat, to.lon)
    if (end.along + 1 < start.along) continue
    if (start.dist > 160 || end.dist > 160) continue
    const line = edgeLine(graph, edge)
    if (!linkAllowed(graph, from.lat, from.lon, start.lat, start.lon)) continue
    if (!linkAllowed(graph, end.lat, end.lon, to.lat, to.lon)) continue
    const coordinates = []
    pushCoord(coordinates, from.lon, from.lat)
    appendLine(coordinates, line, start.along, end.along)
    pushCoord(coordinates, to.lon, to.lat)
    const meters = pathMeters(coordinates)
    const along = Math.max(0, end.along - start.along)
    let cost = connectorCost(graph, metersBetween(from.lat, from.lon, start.lat, start.lon)) + edgeCost(graph, edge, along) + connectorCost(graph, metersBetween(end.lat, end.lon, to.lat, to.lon))
    if (penalty && penalty.has(edge)) cost += Math.max(0, end.along - start.along) * 5
    if (!best || cost < best.cost) best = { cost, route: finishRoute(graph, { coordinates, meters, direct: false, edges: [edge] }, cost) }
  }
  return best
}

function pathMeters(coordinates) {
  let meters = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    meters += metersBetween(coordinates[index - 1][1], coordinates[index - 1][0], coordinates[index][1], coordinates[index][0])
  }
  return meters
}

function ensureScratch(graph) {
  if (graph.gScore && graph.gScore.length === graph.nodeCount) return
  graph.gScore = new Float64Array(graph.nodeCount)
  graph.prevN = new Int32Array(graph.nodeCount)
  graph.prevE = new Int32Array(graph.nodeCount)
  graph.settled = new Uint8Array(graph.nodeCount)
  graph.stamp = new Uint32Array(graph.nodeCount)
  graph.tick = 1
}

function touchNode(graph, node) {
  if (graph.stamp[node] !== graph.tick) {
    graph.stamp[node] = graph.tick
    graph.gScore[node] = Infinity
    graph.settled[node] = 0
  }
}

function searchRoads(graph, sources, goals, bit, penalty, target, limit, bestCost) {
  if (!sources.length || !goals.length) return null
  ensureScratch(graph)
  graph.tick = (graph.tick + 1) >>> 0
  if (graph.tick === 0) {
    graph.stamp.fill(0)
    graph.tick = 1
  }
  const prefix = new Map()
  const goalAt = new Map()
  const heap = createHeap()
  for (const source of sources) {
    touchNode(graph, source.node)
    if (source.cost >= graph.gScore[source.node]) continue
    graph.gScore[source.node] = source.cost
    graph.prevN[source.node] = -1
    graph.prevE[source.node] = -1
    prefix.set(source.node, source)
    const estimate = heuristicCost(graph, metersBetween(nodeLat(graph, source.node), nodeLon(graph, source.node), target.lat, target.lon))
    heap.push(source.cost + estimate, source.node)
  }
  for (const goal of goals) {
    const known = goalAt.get(goal.node)
    if (!known || goal.cost < known.cost) goalAt.set(goal.node, goal)
  }
  let best = bestCost
  let bestNode = -1
  for (const source of sources) {
    const goal = goalAt.get(source.node)
    if (!goal) continue
    const cost = source.cost + goal.cost
    if (cost < best) {
      best = cost
      bestNode = source.node
    }
  }
  let pops = 0
  while (heap.size) {
    const node = heap.pop()[1]
    touchNode(graph, node)
    if (graph.settled[node]) continue
    graph.settled[node] = 1
    pops += 1
    const spent = graph.gScore[node]
    const goal = goalAt.get(node)
    if (goal && spent + goal.cost < best) {
      best = spent + goal.cost
      bestNode = node
    }
    const estimate = heuristicCost(graph, metersBetween(nodeLat(graph, node), nodeLon(graph, node), target.lat, target.lon))
    if (spent + estimate >= best) break
    if (limit && spent > limit) break
    if (pops > 900000) break
    for (let edge = graph.head[node]; edge < graph.head[node + 1]; edge += 1) {
      if (!permitted(graph, edge, bit)) continue
      let weight = edgeCost(graph, edge, graph.len[edge])
      if (penalty && penalty.has(edge)) weight *= 6
      const next = graph.to[edge]
      const nextCost = spent + weight
      touchNode(graph, next)
      if (nextCost >= graph.gScore[next]) continue
      graph.gScore[next] = nextCost
      graph.prevN[next] = node
      graph.prevE[next] = edge
      const nextEstimate = heuristicCost(graph, metersBetween(nodeLat(graph, next), nodeLon(graph, next), target.lat, target.lon))
      heap.push(nextCost + nextEstimate, next)
    }
  }
  if (bestNode < 0 || !prefix.has(startOf(graph, bestNode))) return { cost: Infinity, route: null, exhausted: pops < 800 }
  const nodes = []
  let cursor = bestNode
  while (cursor !== -1) {
    nodes.push(cursor)
    cursor = graph.prevN[cursor]
  }
  nodes.reverse()
  const source = prefix.get(nodes[0])
  if (!source) return null
  const coordinates = source.coordinates.slice()
  const edges = [...(source.edges || [])]
  for (let index = 1; index < nodes.length; index += 1) {
    const edge = graph.prevE[nodes[index]]
    edges.push(edge)
    appendEdge(graph, coordinates, edge)
  }
  const goal = goalAt.get(bestNode)
  if (goal) {
    for (let index = 1; index < goal.coordinates.length; index += 1) {
      pushCoord(coordinates, goal.coordinates[index][0], goal.coordinates[index][1])
    }
    if (goal.edges) edges.push(...goal.edges)
  }
  return { cost: best, route: finishRoute(graph, { coordinates, meters: pathMeters(coordinates), direct: false, edges }, best) }
}

function startOf(graph, node) {
  let cursor = node
  let guard = 0
  while (graph.prevN[cursor] !== -1 && guard < graph.nodeCount) {
    cursor = graph.prevN[cursor]
    guard += 1
  }
  return cursor
}

function samePlace(point, place) {
  return point && place && Math.abs(point[0] - place.lon) < 1e-7 && Math.abs(point[1] - place.lat) < 1e-7
}

function sealWalkEnds(graph, route, from, to) {
  if (!route || graph.costMode !== "walk" || !from || !to) return route
  const coordinates = route.coordinates.slice()
  if (!coordinates.length) return route
  if (!samePlace(coordinates[0], from) && linkAllowed(graph, from.lat, from.lon, coordinates[0][1], coordinates[0][0])) {
    coordinates.unshift([from.lon, from.lat])
  }
  const last = coordinates[coordinates.length - 1]
  if (!samePlace(last, to) && linkAllowed(graph, last[1], last[0], to.lat, to.lon)) coordinates.push([to.lon, to.lat])
  route.coordinates = coordinates
  route.meters = pathMeters(coordinates)
  return route
}

function finishRoute(graph, route, cost) {
  if (!route) return route
  if (timed(graph) && Number.isFinite(cost)) route.seconds = cost
  else {
    const kmh = TRAVEL_KMH[graph?.costMode] || TRAVEL_KMH.walk
    route.seconds = secondsFor(route.meters, kmh)
  }
  return route
}

function walkGapRoute(graph, from, to) {
  const book = graph.buildings
  if (!book?.cuts || !book.links || graph.costMode !== "walk") return null
  const crow = metersBetween(from.lat, from.lon, to.lat, to.lon)
  if (crow < 12 || crow > 850) return null
  const cos = Math.cos(((from.lat + to.lat) / 2) * 0.017453292519943295)
  const padLat = 80 / 111320
  const padLon = 80 / (111320 * cos)
  const south = Math.min(from.lat, to.lat) - padLat
  const north = Math.max(from.lat, to.lat) + padLat
  const west = Math.min(from.lon, to.lon) - padLon
  const east = Math.max(from.lon, to.lon) + padLon
  const step = 4
  const dlat = step / 111320
  const dlon = step / (111320 * cos)
  const rows = Math.ceil((north - south) / dlat)
  const cols = Math.ceil((east - west) / dlon)
  if (rows < 2 || cols < 2 || rows * cols > 80000) return null
  const open = new Uint8Array(rows * cols)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const lat = south + (row + 0.5) * dlat
      const lon = west + (col + 0.5) * dlon
      open[row * cols + col] = book.cuts(lat, lon, lat + 2.2 / 111320, lon) ? 0 : 1
    }
  }
  const cellAt = (lat, lon) => {
    const row = Math.max(0, Math.min(rows - 1, Math.floor((lat - south) / dlat)))
    const col = Math.max(0, Math.min(cols - 1, Math.floor((lon - west) / dlon)))
    return row * cols + col
  }
  const center = (cell) => {
    const row = Math.floor(cell / cols)
    const col = cell % cols
    return [west + (col + 0.5) * dlon, south + (row + 0.5) * dlat]
  }
  const nearest = (lat, lon) => {
    let best = -1
    let bestD = 48
    for (let cell = 0; cell < open.length; cell += 1) {
      if (!open[cell]) continue
      const point = center(cell)
      const distance = metersBetween(lat, lon, point[1], point[0])
      if (distance < bestD) {
        bestD = distance
        best = cell
      }
    }
    return best
  }
  const start = nearest(from.lat, from.lon)
  const goal = nearest(to.lat, to.lon)
  if (start < 0 || goal < 0) return null
  const segmentOk = (lon1, lat1, lon2, lat2) => !book.cuts(lat1, lon1, lat2, lon2) || book.links(lat1, lon1, lat2, lon2) || book.links(lat2, lon2, lat1, lon1)
  if (!segmentOk(from.lon, from.lat, center(start)[0], center(start)[1])) return null
  if (!segmentOk(center(goal)[0], center(goal)[1], to.lon, to.lat)) return null
  const heap = createHeap()
  const cost = new Float64Array(open.length)
  const prev = new Int32Array(open.length)
  cost.fill(Infinity)
  prev.fill(-1)
  cost[start] = 0
  const goalPoint = center(goal)
  heap.push(metersBetween(center(start)[1], center(start)[0], goalPoint[1], goalPoint[0]), start)
  const steps = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]
  let found = false
  while (heap.size) {
    const cell = heap.pop()[1]
    if (cell === goal) {
      found = true
      break
    }
    const row = Math.floor(cell / cols)
    const col = cell % cols
    const spent = cost[cell]
    for (const [dRow, dCol] of steps) {
      const nextRow = row + dRow
      const nextCol = col + dCol
      if (nextRow < 0 || nextCol < 0 || nextRow >= rows || nextCol >= cols) continue
      const next = nextRow * cols + nextCol
      if (!open[next]) continue
      if (dRow && dCol && (!open[row * cols + nextCol] || !open[nextRow * cols + col])) continue
      const nextCost = spent + Math.hypot(dRow * step, dCol * step)
      if (nextCost >= cost[next]) continue
      cost[next] = nextCost
      prev[next] = cell
      const point = center(next)
      heap.push(nextCost + metersBetween(point[1], point[0], goalPoint[1], goalPoint[0]), next)
    }
  }
  if (!found) return null
  const points = [[to.lon, to.lat]]
  let cursor = goal
  let guard = 0
  while (cursor !== start && guard < open.length) {
    points.push(center(cursor))
    cursor = prev[cursor]
    guard += 1
  }
  points.push(center(start))
  points.push([from.lon, from.lat])
  points.reverse()
  const pulled = [points[0]]
  let index = 0
  while (index < points.length - 1) {
    let next = index + 1
    for (let candidate = points.length - 1; candidate > index + 1; candidate -= 1) {
      const fromPoint = points[index]
      const toPoint = points[candidate]
      if (segmentOk(fromPoint[0], fromPoint[1], toPoint[0], toPoint[1])) {
        next = candidate
        break
      }
    }
    pulled.push(points[next])
    index = next
  }
  for (let segment = 1; segment < pulled.length; segment += 1) {
    const fromPoint = pulled[segment - 1]
    const toPoint = pulled[segment]
    if (!segmentOk(fromPoint[0], fromPoint[1], toPoint[0], toPoint[1])) return null
  }
  const meters = pathMeters(pulled)
  if (meters > crow * 2.4 + 40) return null
  return finishRoute(graph, { coordinates: pulled, meters, direct: false, edges: [] }, meters)
}

function routeOnRoad(graph, from, to, penalty, mode, maxMeters, allow) {
  if (!graph || !from || !to || !Number.isFinite(from.lat) || !Number.isFinite(to.lat)) return null
  const previousAllow = graph.allow
  const previousMode = graph.costMode
  graph.allow = allow || null
  graph.costMode = mode || "car"
  try {
    return routeOnRoadBody(graph, from, to, penalty, mode, maxMeters)
  } finally {
    graph.allow = previousAllow
    graph.costMode = previousMode
  }
}

function routeOnRoadBody(graph, from, to, penalty, mode, maxMeters) {
  if (!graph || !from || !to || !Number.isFinite(from.lat) || !Number.isFinite(to.lat)) return null
  const bit = MODE_BIT[mode] || MODE_BIT.car
  if (metersBetween(from.lat, from.lon, to.lat, to.lon) < 8 && linkAllowed(graph, from.lat, from.lon, to.lat, to.lon)) {
    const meters = metersBetween(from.lat, from.lon, to.lat, to.lon)
    return finishRoute(graph, { coordinates: [[from.lon, from.lat], [to.lon, to.lat]], meters, direct: false, edges: [] }, connectorCost(graph, meters))
  }
  const blocked = new Set()
  const crow = metersBetween(from.lat, from.lon, to.lat, to.lon)
  const searchLimit = mode === "walk" ? Math.min(maxMeters, Math.max(crow * 8, crow + 1200)) : maxMeters
  let road = null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const fromAccess = approachNodes(graph, from, bit, blocked)
    const toAccess = approachNodes(graph, to, bit, blocked)
    if (!fromAccess || !toAccess) break
    const same = sameEdgeRoute(graph, from, to, fromAccess, toAccess, bit, penalty)
    const sources = terminalsFor(graph, fromAccess, from, bit, penalty, false)
    const goals = terminalsFor(graph, toAccess, to, bit, penalty, true)
    const found = searchRoads(graph, sources, goals, bit, penalty, to, searchLimit, same ? same.cost : Infinity)
    if (same && (!found || same.cost <= found.cost)) {
      road = sealWalkEnds(graph, same.route, from, to)
      break
    }
    if (found?.route) {
      road = sealWalkEnds(graph, found.route, from, to)
      break
    }
    const blockedBefore = blocked.size
    const reject = attempt < 5 ? [toAccess] : [toAccess, fromAccess]
    for (const access of reject) {
      if (access.kind !== "edge") continue
      blocked.add(access.snap.edge)
      const rev = graph.rev[access.snap.edge]
      if (rev !== ROAD_NONE) blocked.add(rev)
    }
    if (blocked.size === blockedBefore) break
  }
  if (mode !== "walk" || !graph.buildings?.cuts) return road
  const gap = walkGapRoute(graph, from, to)
  if (gap && (!road || gap.meters + 8 < road.meters)) return gap
  return road
}

function findRoadRoutes(graph, from, to, mode) {
  const first = routeOnRoad(graph, from, to, null, mode, Infinity)
  if (!first) return []
  const routes = [first]
  if (!first.edges.length) return routes
  const used = new Set(first.edges)
  for (const edge of first.edges) {
    const rev = graph.rev[edge]
    if (rev !== ROAD_NONE) used.add(rev)
  }
  const limit = Math.max(first.meters * 1.75, first.meters + 600)
  const second = routeOnRoad(graph, from, to, used, mode, limit)
  if (second && !sameEdges(first, second) && second.meters < limit) {
    routes.push(second)
    const usedMore = new Set([...used, ...second.edges])
    for (const edge of second.edges) {
      const rev = graph.rev[edge]
      if (rev !== ROAD_NONE) usedMore.add(rev)
    }
    const third = routeOnRoad(graph, from, to, usedMore, mode, limit)
    if (third && third.meters < limit && !routes.some((route) => sameEdges(route, third))) routes.push(third)
  }
  return routes
}
