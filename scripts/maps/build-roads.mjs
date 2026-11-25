#!/usr/bin/env node
// Usage: node build-roads.mjs <highways.opl> <roads.bin>
// Input: OPL ways with locations, nodes renumbered densely from 1 (see
// build-country.sh). Output: the RDG1 road graph read by openRoadGraph() in
// scripts/readers/route.js, a copy of blackout-maps website/maps/route.js. Format: SPEC.md.
import { writeFileSync } from "node:fs"
import { GrowableInt32, lines, metersBetween, parseWay } from "./lib/opl.mjs"

const WALK = 1
const BIKE = 2
const CAR = 4
const LINK_BIT = 8
const TOLL_BIT = 16
const GRID_STEP = 100000
const MAX_MID = 60000
// Douglas-Peucker tolerance for the shape points between two junctions. The
// route line is drawn from them, so a few metres is invisible at street zoom.
const SIMPLIFY_METERS = 2.5

// Keeps the shape points (int e7 arrays) that matter for a line from
// (lat0, lon0) to (lat1, lon1), dropping those within SIMPLIFY_METERS of it.
function simplify(lat0, lon0, midLat, midLon, lat1, lon1) {
  const n = midLat.length
  if (!n) return [midLat, midLon]
  const scaleLat = 0.011132
  const scaleLon = scaleLat * Math.cos(((lat0 + lat1) / 2) * 1e-7 * (Math.PI / 180))
  const lat = [lat0, ...midLat, lat1]
  const lon = [lon0, ...midLon, lon1]
  const keep = new Uint8Array(n + 2)
  keep[0] = 1
  keep[n + 1] = 1
  const stack = [[0, n + 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const ax = lon[a] * scaleLon
    const ay = lat[a] * scaleLat
    const dx = lon[b] * scaleLon - ax
    const dy = lat[b] * scaleLat - ay
    const len2 = dx * dx + dy * dy
    let worst = -1
    let far = 0
    for (let i = a + 1; i < b; i += 1) {
      const px = lon[i] * scaleLon - ax
      const py = lat[i] * scaleLat - ay
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0
      const ex = px - t * dx
      const ey = py - t * dy
      const d = ex * ex + ey * ey
      if (d > far) {
        far = d
        worst = i
      }
    }
    if (worst > 0 && far > SIMPLIFY_METERS * SIMPLIFY_METERS) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const outLat = []
  const outLon = []
  for (let i = 1; i <= n; i += 1) {
    if (!keep[i]) continue
    outLat.push(lat[i])
    outLon.push(lon[i])
  }
  return [outLat, outLon]
}

// highway=track is left out, as in the Portugal graph the apps ship: rural
// tracks are a quarter of the edges and would push large countries past the
// memory budget in SPEC.md.
const CLASS = {
  motorway: [0, CAR],
  motorway_link: [0 | LINK_BIT, CAR],
  trunk: [1, WALK | BIKE | CAR],
  trunk_link: [1 | LINK_BIT, WALK | BIKE | CAR],
  primary: [2, WALK | BIKE | CAR],
  primary_link: [2 | LINK_BIT, WALK | BIKE | CAR],
  secondary: [3, WALK | BIKE | CAR],
  secondary_link: [3 | LINK_BIT, WALK | BIKE | CAR],
  tertiary: [4, WALK | BIKE | CAR],
  tertiary_link: [4 | LINK_BIT, WALK | BIKE | CAR],
  unclassified: [5, WALK | BIKE | CAR],
  residential: [5, WALK | BIKE | CAR],
  living_street: [5, WALK | BIKE | CAR],
  road: [5, WALK | BIKE | CAR],
  service: [5, WALK | BIKE | CAR],
  pedestrian: [6, WALK],
  footway: [6, WALK],
  path: [6, WALK],
  steps: [6, WALK],
  bridleway: [6, WALK],
  corridor: [6, WALK],
  cycleway: [7, WALK | BIKE],
}

const SKIP_SERVICE = new Set(["parking_aisle", "driveway", "drive-through"])
const NO = new Set(["no", "private"])
const YES = new Set(["yes", "designated", "permissive", "destination", "official"])

export function classify(tags) {
  const base = CLASS[tags.highway]
  if (!base) return null
  if (tags.area === "yes" && tags.highway !== "pedestrian") return null
  if (tags.highway === "service" && SKIP_SERVICE.has(tags.service)) return null
  let [klass, access] = base
  if (NO.has(tags.access)) access = 0
  if (tags.motorroad === "yes") access &= CAR
  if (NO.has(tags.vehicle)) access &= ~(BIKE | CAR)
  if (NO.has(tags.motor_vehicle) || NO.has(tags.motorcar)) access &= ~CAR
  if (NO.has(tags.foot)) access &= ~WALK
  if (NO.has(tags.bicycle) || tags.bicycle === "dismount") access &= ~BIKE
  if (YES.has(tags.foot) && (klass & 7) !== 0) access |= WALK
  if (YES.has(tags.bicycle) && (klass & 7) !== 0) access |= BIKE
  if ((YES.has(tags.motor_vehicle) || YES.has(tags.motorcar)) && (klass & 7) <= 5) access |= CAR
  if (!access) return null
  if (tags.toll === "yes") klass |= TOLL_BIT
  let forward = access
  let backward = access
  const oneway = tags.oneway
  const roundabout = tags.junction === "roundabout" || tags.junction === "circular"
  const isOneway = oneway === "yes" || oneway === "true" || oneway === "1" || (roundabout && oneway !== "no")
  if (access !== WALK && (isOneway || oneway === "-1")) {
    const bikeBoth = tags["oneway:bicycle"] === "no" || String(tags.cycleway || "").startsWith("opposite")
    const against = access & (WALK | (bikeBoth ? BIKE : 0))
    if (oneway === "-1") forward = against
    else backward = against
  }
  return { klass, forward, backward }
}

async function main() {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.error("usage: build-roads.mjs <highways.opl> <roads.bin>")
    process.exit(2)
  }

  // Pass 1: count how many routable ways touch each node, and record ends.
  let uses = new Uint8Array(1 << 24)
  const bump = (id, by) => {
    if (id >= uses.length) {
      let size = uses.length
      while (size <= id) size *= 2
      const next = new Uint8Array(size)
      next.set(uses)
      uses = next
    }
    uses[id] = Math.min(255, uses[id] + by)
  }
  let ways = 0
  for await (const line of lines(input)) {
    const way = parseWay(line)
    if (!way || way.refs.length < 2 || !classify(way.tags)) continue
    ways += 1
    const n = way.refs.length
    for (let i = 0; i < n; i += 1) bump(way.refs[i], i === 0 || i === n - 1 ? 2 : 1)
    if (way.refs[0] === way.refs[n - 1] && n > 3) bump(way.refs[n >> 1], 2)
  }
  console.error(`${ways} routable ways`)

  // Pass 2: split ways at junctions into directed edges.
  const nodeIndex = new Int32Array(uses.length).fill(-1)
  const nodeLat = new GrowableInt32()
  const nodeLon = new GrowableInt32()
  const indexOf = (id, lat, lon) => {
    let index = nodeIndex[id]
    if (index < 0) {
      index = nodeLat.length
      nodeIndex[id] = index
      nodeLat.push(Math.round(lat * 1e7))
      nodeLon.push(Math.round(lon * 1e7))
    }
    return index
  }
  const eFrom = new GrowableInt32(1 << 22, Uint32Array)
  const eTo = new GrowableInt32(1 << 22, Uint32Array)
  const eLen = new GrowableInt32(1 << 22, Uint32Array)
  const eRev = new GrowableInt32(1 << 22, Uint32Array)
  const eAccess = new GrowableInt32(1 << 22, Uint8Array)
  const eKlass = new GrowableInt32(1 << 22, Uint8Array)
  const eGeomOff = new GrowableInt32(1 << 22, Uint32Array)
  const eGeomN = new GrowableInt32(1 << 22, Uint32Array)
  const gLat = new GrowableInt32(1 << 23)
  const gLon = new GrowableInt32(1 << 23)
  const NONE = 0xffffffff

  const addEdge = (from, to, length, access, klass, midLat, midLon, reverse) => {
    const index = eFrom.length
    eFrom.push(from)
    eTo.push(to)
    eLen.push(length)
    eRev.push(NONE)
    eAccess.push(access)
    eKlass.push(klass)
    const count = midLat.length
    eGeomN.push(count)
    eGeomOff.push(count ? gLat.length : NONE)
    for (let k = 0; k < count; k += 1) {
      const at = reverse ? count - 1 - k : k
      gLat.push(midLat[at])
      gLon.push(midLon[at])
    }
    return index
  }

  for await (const line of lines(input)) {
    const way = parseWay(line)
    if (!way || way.refs.length < 2) continue
    const kind = classify(way.tags)
    if (!kind) continue
    const n = way.refs.length
    let start = 0
    let length = 0
    let midLat = []
    let midLon = []
    for (let i = 1; i < n; i += 1) {
      length += metersBetween(way.lat[i - 1], way.lon[i - 1], way.lat[i], way.lon[i])
      const split = uses[way.refs[i]] >= 2 || i === n - 1 || midLat.length >= MAX_MID
      if (!split) {
        const la = Math.round(way.lat[i] * 1e7)
        const lo = Math.round(way.lon[i] * 1e7)
        const last = midLat.length - 1
        if (last < 0 || midLat[last] !== la || midLon[last] !== lo) {
          midLat.push(la)
          midLon.push(lo)
        }
        continue
      }
      const a = indexOf(way.refs[start], way.lat[start], way.lon[start])
      const b = indexOf(way.refs[i], way.lat[i], way.lon[i])
      if (a !== b) {
        const meters = Math.max(1, Math.round(length))
        ;[midLat, midLon] = simplify(Math.round(way.lat[start] * 1e7), Math.round(way.lon[start] * 1e7), midLat, midLon, Math.round(way.lat[i] * 1e7), Math.round(way.lon[i] * 1e7))
        let fwd = -1
        let back = -1
        if (kind.forward) fwd = addEdge(a, b, meters, kind.forward, kind.klass, midLat, midLon, false)
        if (kind.backward) back = addEdge(b, a, meters, kind.backward, kind.klass, midLat, midLon, true)
        if (fwd >= 0 && back >= 0) {
          eRev.data[fwd] = back
          eRev.data[back] = fwd
        }
      }
      start = i
      length = 0
      midLat = []
      midLon = []
    }
  }

  const nodeCount = nodeLat.length
  const edgeCount = eFrom.length
  console.error(`${nodeCount} nodes, ${edgeCount} edges, ${gLat.length} shape points`)

  // Counting sort edges by source node (CSR order).
  const head = new Uint32Array(nodeCount + 1)
  for (let e = 0; e < edgeCount; e += 1) head[eFrom.data[e] + 1] += 1
  for (let i = 1; i <= nodeCount; i += 1) head[i] += head[i - 1]
  const fill = head.slice(0, nodeCount)
  const order = new Uint32Array(edgeCount)
  const position = new Uint32Array(edgeCount)
  for (let e = 0; e < edgeCount; e += 1) {
    const at = fill[eFrom.data[e]]++
    order[at] = e
    position[e] = at
  }

  const lat = nodeLat.view()
  const lon = nodeLon.view()
  let minLat = Infinity
  let minLon = Infinity
  let maxLat = -Infinity
  let maxLon = -Infinity
  for (let i = 0; i < nodeCount; i += 1) {
    if (lat[i] < minLat) minLat = lat[i]
    if (lat[i] > maxLat) maxLat = lat[i]
    if (lon[i] < minLon) minLon = lon[i]
    if (lon[i] > maxLon) maxLon = lon[i]
  }
  const gridLat0 = Math.floor(minLat / GRID_STEP) * GRID_STEP - GRID_STEP
  const gridLon0 = Math.floor(minLon / GRID_STEP) * GRID_STEP - GRID_STEP
  const gridLatN = Math.ceil((maxLat - gridLat0) / GRID_STEP) + 1
  const gridLonN = Math.ceil((maxLon - gridLon0) / GRID_STEP) + 1
  const cellCount = gridLatN * gridLonN

  // Output arrays in sorted order; shape points re-laid out per edge.
  const geomCount = gLat.length
  const from = new Uint32Array(edgeCount)
  const to = new Uint32Array(edgeCount)
  const len = new Uint32Array(edgeCount)
  const rev = new Uint32Array(edgeCount)
  const access = new Uint8Array(edgeCount)
  const klass = new Uint8Array(edgeCount)
  const geomOff = new Uint32Array(edgeCount)
  const geomN = new Uint16Array(edgeCount)
  const geomLat = new Int32Array(geomCount)
  const geomLon = new Int32Array(geomCount)
  let cursor = 0
  for (let at = 0; at < edgeCount; at += 1) {
    const e = order[at]
    from[at] = eFrom.data[e]
    to[at] = eTo.data[e]
    len[at] = eLen.data[e]
    rev[at] = eRev.data[e] === NONE ? NONE : position[eRev.data[e]]
    access[at] = eAccess.data[e]
    klass[at] = eKlass.data[e]
    const count = eGeomN.data[e]
    geomN[at] = count
    if (count) {
      geomOff[at] = cursor
      geomLat.set(gLat.data.subarray(eGeomOff.data[e], eGeomOff.data[e] + count), cursor)
      geomLon.set(gLon.data.subarray(eGeomOff.data[e], eGeomOff.data[e] + count), cursor)
      cursor += count
    } else geomOff[at] = NONE
  }

  // Edge grid: each cell lists every edge whose bounding box touches it.
  const cellOf = (la, lo) => [Math.floor((la - gridLat0) / GRID_STEP), Math.floor((lo - gridLon0) / GRID_STEP)]
  const cellHead = new Uint32Array(cellCount + 1)
  const boxes = new Int32Array(edgeCount * 4)
  for (let e = 0; e < edgeCount; e += 1) {
    let loLat = Math.min(lat[from[e]], lat[to[e]])
    let hiLat = Math.max(lat[from[e]], lat[to[e]])
    let loLon = Math.min(lon[from[e]], lon[to[e]])
    let hiLon = Math.max(lon[from[e]], lon[to[e]])
    for (let k = 0; k < geomN[e]; k += 1) {
      const la = geomLat[geomOff[e] + k]
      const lo = geomLon[geomOff[e] + k]
      if (la < loLat) loLat = la
      if (la > hiLat) hiLat = la
      if (lo < loLon) loLon = lo
      if (lo > hiLon) hiLon = lo
    }
    const [y0, x0] = cellOf(loLat, loLon)
    const [y1, x1] = cellOf(hiLat, hiLon)
    boxes.set([y0, x0, y1, x1], e * 4)
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cellHead[y * gridLonN + x + 1] += 1
  }
  for (let i = 1; i <= cellCount; i += 1) cellHead[i] += cellHead[i - 1]
  const cellEdges = new Uint32Array(cellHead[cellCount])
  const cellFill = cellHead.slice(0, cellCount)
  for (let e = 0; e < edgeCount; e += 1) {
    const [y0, x0, y1, x1] = boxes.subarray(e * 4, e * 4 + 4)
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) cellEdges[cellFill[y * gridLonN + x]++] = e
  }

  const align4 = (value) => (value + 3) & ~3
  let size = 64
  size += nodeCount * 8 + (nodeCount + 1) * 4 + edgeCount * 16
  size = align4(size + edgeCount)
  size = align4(size + edgeCount)
  size += edgeCount * 4
  size = align4(size + edgeCount * 2)
  size += geomCount * 8 + (cellCount + 1) * 4 + cellEdges.length * 4
  if (size > 0xffffffff) throw new Error("road graph over 4 GB")
  const out = Buffer.alloc(size)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  out.write("RDG1", 0, "latin1")
  view.setUint32(4, 1, true)
  view.setUint32(8, nodeCount, true)
  view.setUint32(12, edgeCount, true)
  view.setUint32(16, geomCount, true)
  view.setUint32(20, cellCount, true)
  view.setInt32(24, gridLat0, true)
  view.setInt32(28, gridLon0, true)
  view.setUint32(32, gridLatN, true)
  view.setUint32(36, gridLonN, true)
  view.setUint32(40, GRID_STEP, true)
  view.setUint32(44, size, true)
  let offset = 64
  const put = (array) => {
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset)
    offset += array.byteLength
  }
  put(lat)
  put(lon)
  put(head)
  put(from)
  put(to)
  put(len)
  put(rev)
  put(access)
  offset = align4(offset)
  put(klass)
  offset = align4(offset)
  put(geomOff)
  put(geomN)
  offset = align4(offset)
  put(geomLat)
  put(geomLon)
  put(cellHead)
  put(cellEdges)
  if (offset !== size) throw new Error(`size mismatch ${offset} != ${size}`)
  writeFileSync(output, out)
  console.error(`${output}: ${(size / 1e6).toFixed(1)} MB`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
