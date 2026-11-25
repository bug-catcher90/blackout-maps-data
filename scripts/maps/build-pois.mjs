#!/usr/bin/env node
// Usage: node build-pois.mjs <features.geojsonseq> <highways.opl> <out-dir>
// Writes places.bin (POI1), water.bin (WTR1), addresses.bin (ADR1) and
// geo.json into <out-dir>. Inputs come from build-country.sh. Formats and the
// tag rules are documented in SPEC.md.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildPlaceBook } from "../readers/places.js"
import { buildWaterBook } from "../readers/water.js"
import { streetKey } from "../readers/search.js"
import { lines, parseWay } from "./lib/opl.mjs"

const [featuresPath, highwaysPath, outDir] = process.argv.slice(2)
if (!featuresPath || !highwaysPath || !outDir) {
  console.error("usage: build-pois.mjs <features.geojsonseq> <highways.opl> <out-dir>")
  process.exit(2)
}

const HEALTH = new Set(["hospital", "clinic", "doctors", "pharmacy", "dentist"])
const FOOD = new Set(["restaurant", "fast_food", "cafe", "food_court"])
const GROCERY = new Set(["supermarket", "convenience", "grocery", "greengrocer"])
const PLACE_RANK = { city: 0, town: 1, suburb: 2, borough: 2, quarter: 2, village: 3, hamlet: 3, neighbourhood: 3, locality: 3, isolated_dwelling: 3 }

export function serviceCategory(tags) {
  if (HEALTH.has(tags.amenity) || HEALTH.has(tags.healthcare)) return 0
  if (tags.amenity === "police") return 1
  if (tags.amenity === "fire_station") return 2
  if (tags.amenity === "fuel") return 3
  if (GROCERY.has(tags.shop)) return 4
  if (FOOD.has(tags.amenity)) return 5
  return -1
}

export function waterType(tags) {
  if (tags.amenity === "drinking_water" || tags.drinking_water === "yes" && tags.man_made === "water_tap") return 0
  if (tags.natural === "spring") return 1
  if (tags.ford === "yes" || tags.highway === "ford") return 2
  if (tags.waterway === "weir" || tags.waterway === "dam") return 3
  if (tags.amenity === "water_point" || tags.man_made === "water_well" || tags.man_made === "water_tap") return 4
  return -1
}

function center(geometry) {
  const points = []
  const collect = (value) => {
    if (typeof value[0] === "number") points.push(value)
    else for (const item of value) collect(item)
  }
  collect(geometry.coordinates)
  if (geometry.type === "Point") return { lat: points[0][1], lon: points[0][0] }
  if (geometry.type === "LineString") {
    const mid = points[points.length >> 1]
    return { lat: mid[1], lon: mid[0] }
  }
  let lat = 0
  let lon = 0
  for (const point of points) {
    lat += point[1]
    lon += point[0]
  }
  return { lat: lat / points.length, lon: lon / points.length }
}

function parts(geometry) {
  const toLatLon = (ring) => ring.map((point) => [point[1], point[0]])
  if (geometry.type === "LineString") return { parts: [toLatLon(geometry.coordinates)], area: false }
  if (geometry.type === "MultiLineString") return { parts: geometry.coordinates.map(toLatLon), area: false }
  if (geometry.type === "Polygon") return { parts: [toLatLon(geometry.coordinates[0])], area: true }
  if (geometry.type === "MultiPolygon") return { parts: geometry.coordinates.map((polygon) => toLatLon(polygon[0])), area: true }
  return { parts: [], area: false }
}

function address(tags) {
  const street = tags["addr:street"] || tags["addr:place"] || ""
  const number = tags["addr:housenumber"] || ""
  const city = tags["addr:city"] || ""
  const line = [street, number].filter(Boolean).join(" ")
  return [line, city].filter(Boolean).join(", ")
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}

const services = []
const water = []
const settlements = []
const doors = []
const seenDoor = new Set()

for await (const line of lines(featuresPath)) {
  const text = line.charCodeAt(0) === 0x1e ? line.slice(1) : line
  let feature
  try {
    feature = JSON.parse(text)
  } catch {
    continue
  }
  const tags = feature.properties || {}
  const geometry = feature.geometry
  if (!geometry) continue
  const at = center(geometry)
  if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue
  const category = serviceCategory(tags)
  if (category >= 0) services.push({ category, name: tags.name || "", address: address(tags), lat: at.lat, lon: at.lon })
  const type = waterType(tags)
  if (type >= 0) {
    const shape = geometry.type === "Point" ? { parts: [], area: false } : parts(geometry)
    water.push({ type, name: tags.name || "", lat: at.lat, lon: at.lon, ...shape })
  }
  if (tags.place in PLACE_RANK && tags.name && geometry.type === "Point") {
    settlements.push([tags.name, round6(at.lat), round6(at.lon), PLACE_RANK[tags.place]])
  }
  const number = tags["addr:housenumber"]
  const street = tags["addr:street"] || tags["addr:place"]
  if (number && street) {
    const key = `${street}\u0000${number}\u0000${Math.round(at.lat * 1e4)}:${Math.round(at.lon * 1e4)}`
    if (!seenDoor.has(key)) {
      seenDoor.add(key)
      doors.push({ street, number, city: tags["addr:city"] || "", postcode: tags["addr:postcode"] || "", lat: at.lat, lon: at.lon })
    }
  }
}
seenDoor.clear()
console.error(`${services.length} services, ${water.length} water, ${settlements.length} places, ${doors.length} doors`)

// Street names for search: one point per name per ~2 km cell.
const streetSeen = new Set()
const streets = []
for await (const line of lines(highwaysPath)) {
  if (line[0] !== "w" || !line.includes("name=")) continue
  const way = parseWay(line)
  if (!way || !way.tags.name || !way.lat.length) continue
  const mid = way.lat.length >> 1
  const lat = way.lat[mid]
  const lon = way.lon[mid]
  const key = `${way.tags.name}\u0000${Math.round(lat / 0.02)}:${Math.round(lon / 0.02)}`
  if (streetSeen.has(key)) continue
  streetSeen.add(key)
  streets.push([way.tags.name, round6(lat), round6(lon)])
}
streetSeen.clear()

// Doors with no addr:city take the nearest town or village.
const towns = settlements.filter((row) => row[3] <= 3)
const townGrid = new Map()
for (const row of towns) {
  const key = `${Math.floor(row[1] / 0.1)}:${Math.floor(row[2] / 0.1)}`
  if (!townGrid.has(key)) townGrid.set(key, [])
  townGrid.get(key).push(row)
}
function nearestTown(lat, lon) {
  const cy = Math.floor(lat / 0.1)
  const cx = Math.floor(lon / 0.1)
  let best = ""
  let bestD = Infinity
  for (let ring = 0; ring <= 3 && !best; ring += 1) {
    for (let y = cy - ring; y <= cy + ring; y += 1) {
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        for (const row of townGrid.get(`${y}:${x}`) || []) {
          const d = (row[1] - lat) ** 2 + ((row[2] - lon) * Math.cos((lat * Math.PI) / 180)) ** 2
          if (d < bestD) {
            bestD = d
            best = row[0]
          }
        }
      }
    }
  }
  return best
}

function postcodeNumber(text) {
  const match = /^(\d{4})-(\d{3})$/.exec(String(text).trim())
  return match ? Number(match[1]) * 1000 + Number(match[2]) : 0
}

function buildAddressBook(rows) {
  const cityIndex = new Map()
  const numberIndex = new Map()
  const byStreet = new Map()
  for (const row of rows) {
    const city = row.city || nearestTown(row.lat, row.lon)
    if (!city) continue
    if (!cityIndex.has(city)) cityIndex.set(city, cityIndex.size)
    if (!numberIndex.has(row.number)) numberIndex.set(row.number, numberIndex.size)
    if (!byStreet.has(row.street)) byStreet.set(row.street, [])
    byStreet.get(row.street).push({ ...row, city })
  }
  if (cityIndex.size > 65535) throw new Error("too many cities for ADR1")
  const streetsSorted = [...byStreet.keys()].map((name) => ({ name, key: streetKey(name) })).filter((row) => row.key)
  streetsSorted.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const encoder = new TextEncoder()
  const strings = []
  const pushString = (text) => {
    let bytes = encoder.encode(text)
    if (bytes.length > 65535) bytes = bytes.subarray(0, 65535)
    const head = Buffer.alloc(2)
    head.writeUInt16LE(bytes.length)
    strings.push(head, Buffer.from(bytes))
  }
  for (const city of cityIndex.keys()) pushString(city)
  for (const number of numberIndex.keys()) pushString(number)
  const records = []
  let first = 0
  for (const street of streetsSorted) {
    const doorsOnStreet = byStreet.get(street.name).sort((a, b) => a.city.localeCompare(b.city) || a.number.localeCompare(b.number, undefined, { numeric: true }))
    pushString(street.name)
    const span = Buffer.alloc(8)
    span.writeUInt32LE(first, 0)
    span.writeUInt32LE(doorsOnStreet.length, 4)
    strings.push(span)
    for (const door of doorsOnStreet) {
      const record = Buffer.alloc(18)
      record.writeUInt32LE(numberIndex.get(door.number), 0)
      record.writeUInt16LE(cityIndex.get(door.city), 4)
      record.writeUInt32LE(postcodeNumber(door.postcode), 6)
      record.writeInt32LE(Math.round(door.lat * 1e6), 10)
      record.writeInt32LE(Math.round(door.lon * 1e6), 14)
      records.push(record)
    }
    first += doorsOnStreet.length
  }
  const index = Buffer.concat(strings)
  const header = Buffer.alloc(28)
  header.write("ADR1", 0, "latin1")
  header.writeUInt32LE(streetsSorted.length, 4)
  header.writeUInt32LE(cityIndex.size, 8)
  header.writeUInt32LE(numberIndex.size, 12)
  header.writeUInt32LE(first, 16)
  header.writeUInt32LE(28 + index.length, 20)
  header.writeUInt32LE(18, 24)
  return Buffer.concat([header, index, ...records])
}

writeFileSync(join(outDir, "places.bin"), Buffer.from(buildPlaceBook(services)))
writeFileSync(join(outDir, "water.bin"), Buffer.from(buildWaterBook(water)))
writeFileSync(join(outDir, "addresses.bin"), buildAddressBook(doors))
writeFileSync(join(outDir, "geo.json"), JSON.stringify({ p: settlements, s: streets }))
console.error(`${streets.length} streets written to ${outDir}`)
