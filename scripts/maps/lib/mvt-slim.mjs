// Rewrites a Mapbox Vector Tile at the protobuf level: drops layers and
// feature properties without decoding geometry.
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

function readVarint(buf, state) {
  let result = 0
  let shift = 0
  for (;;) {
    const byte = buf[state.pos++]
    result += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) return result
    shift += 7
  }
}

function varintBytes(value) {
  const out = []
  while (value >= 0x80) {
    out.push((value % 0x80) | 0x80)
    value = Math.floor(value / 0x80)
  }
  out.push(value)
  return Buffer.from(out)
}

function field(number, wire) {
  return varintBytes(number * 8 + wire)
}

function lengthDelimited(number, body) {
  return Buffer.concat([field(number, 2), varintBytes(body.length), body])
}

function skip(buf, state, wire) {
  if (wire === 0) readVarint(buf, state)
  else if (wire === 1) state.pos += 8
  else if (wire === 2) state.pos += readVarint(buf, state)
  else if (wire === 5) state.pos += 4
  else throw new Error(`wire type ${wire}`)
}

function* fields(buf) {
  const state = { pos: 0 }
  while (state.pos < buf.length) {
    const tag = readVarint(buf, state)
    const number = Math.floor(tag / 8)
    const wire = tag & 7
    const start = state.pos
    if (wire === 2) {
      const length = readVarint(buf, state)
      const bodyStart = state.pos
      state.pos += length
      yield { number, wire, body: buf.subarray(bodyStart, state.pos), raw: buf.subarray(start, state.pos) }
    } else {
      skip(buf, state, wire)
      yield { number, wire, raw: buf.subarray(start, state.pos) }
    }
  }
}

function packed(body) {
  const state = { pos: 0 }
  const out = []
  while (state.pos < body.length) out.push(readVarint(body, state))
  return out
}

function packedBytes(values) {
  return Buffer.concat(values.map(varintBytes))
}

function stringValue(value) {
  for (const part of fields(value)) if (part.number === 1 && part.wire === 2) return part.body.toString("utf8")
  return undefined
}

function slimLayer(body, keepKey, keepFeature) {
  let name = ""
  const keys = []
  const values = []
  const features = []
  const extra = []
  for (const part of fields(body)) {
    if (part.number === 1 && part.wire === 2) name = part.body.toString("utf8")
    else if (part.number === 2 && part.wire === 2) features.push(part.body)
    else if (part.number === 3 && part.wire === 2) keys.push(part.body.toString("utf8"))
    else if (part.number === 4 && part.wire === 2) values.push(part.body)
    else extra.push(part)
  }
  const keyMap = keys.map(() => -1)
  const keptKeys = []
  keys.forEach((key, index) => {
    if (keepKey(name, key)) {
      keyMap[index] = keptKeys.length
      keptKeys.push(key)
    }
  })
  const valueMap = new Map()
  const keptValues = []
  const outFeatures = []
  const watched = new Map()
  keys.forEach((key, index) => {
    if (key === "kind" || key === "kind_detail") watched.set(index, key)
  })
  for (const feature of features) {
    if (keepFeature) {
      const props = {}
      for (const part of fields(feature)) {
        if (part.number !== 2 || part.wire !== 2) continue
        const tags = packed(part.body)
        for (let i = 0; i + 1 < tags.length; i += 2) {
          const key = watched.get(tags[i])
          if (key) props[key] = stringValue(values[tags[i + 1]])
        }
      }
      if (!keepFeature(name, props)) continue
    }
    const parts = []
    for (const part of fields(feature)) {
      if (part.number === 2 && part.wire === 2) {
        const tags = packed(part.body)
        const next = []
        for (let i = 0; i + 1 < tags.length; i += 2) {
          const key = keyMap[tags[i]]
          if (key < 0) continue
          let value = valueMap.get(tags[i + 1])
          if (value === undefined) {
            value = keptValues.length
            valueMap.set(tags[i + 1], value)
            keptValues.push(values[tags[i + 1]])
          }
          next.push(key, value)
        }
        if (next.length) parts.push(lengthDelimited(2, packedBytes(next)))
      } else parts.push(Buffer.concat([field(part.number, part.wire), part.raw]))
    }
    outFeatures.push(lengthDelimited(2, Buffer.concat(parts)))
  }
  if (!outFeatures.length) return null
  const out = [lengthDelimited(1, Buffer.from(name, "utf8")), ...outFeatures]
  for (const key of keptKeys) out.push(lengthDelimited(3, Buffer.from(key, "utf8")))
  for (const value of keptValues) out.push(lengthDelimited(4, value))
  for (const part of extra) out.push(Buffer.concat([field(part.number, part.wire), part.raw]))
  return { name, bytes: Buffer.concat(out) }
}

export function layerName(body) {
  for (const part of fields(body)) if (part.number === 1 && part.wire === 2) return part.body.toString("utf8")
  return ""
}

// keepLayer(name) -> boolean; keepKey(layer, key) -> boolean;
// keepFeature(layer, { kind, kind_detail }) -> boolean, optional.
export function slimTile(tile, keepLayer, keepKey, keepFeature) {
  const out = []
  for (const part of fields(tile)) {
    if (part.number !== 3 || part.wire !== 2) continue
    const name = layerName(part.body)
    if (!keepLayer(name)) continue
    const layer = slimLayer(part.body, keepKey, keepFeature)
    if (!layer) continue
    out.push(lengthDelimited(3, layer.bytes))
  }
  return Buffer.concat(out)
}
