#!/usr/bin/env bash
# Builds every file of one country package from OpenStreetMap.
#
#   scripts/maps/build-country.sh <id> [work-dir]
#
# Needs: osmium-tool (>= 1.14), pmtiles (go-pmtiles >= 1.20), node (>= 20), pigz, curl.
# Writes <work-dir>/<id>/out/ with the seven package files, then splits them
# into catalog/<id>/, writes catalog/<id>.json (make-catalog.mjs) and
# refreshes catalog/index.json (make-index.mjs).
# See SPEC.md.
#
# Environment:
#   PLANET    Protomaps planet build to cut the basemap from
#             (default: newest build listed at build-metadata.protomaps.dev)
#   MAXZOOM   basemap max zoom (default 14)
#   BASE_URL  where the package files will be served from
#             (default: raw.githubusercontent.com/.../main/catalog/<id>)
#   SOURCE_PBF   the Geofabrik extract to start from instead of downloading it
#   COUNTRY_PBF  an extract already cut to this package's area (skips the cut)
set -euo pipefail

id="${1:?usage: build-country.sh <id> [work-dir]}"
work_root="${2:-${WORK_DIR:-/tmp/blackout-maps}}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
node_run() { node --no-warnings --max-old-space-size="${NODE_HEAP_MB:-12000}" "$@"; }

entry="$(node -e '
  const list = require(process.argv[1]); const c = list.find((x) => x.id === process.argv[2]);
  if (!c) { console.error("unknown country " + process.argv[2]); process.exit(1) }
  if (c.split) { console.error(process.argv[2] + " is split into regions; build those (see make-regions.py)"); process.exit(1) }
  console.log([c.geofabrik, c.region || ""].join("\t"))' "$here/countries.json" "$id")"
geofabrik="$(cut -f1 <<<"$entry")"
region_file="$(cut -f2 <<<"$entry")"

work="$work_root/$id"
out="$work/out"
mkdir -p "$work" "$out"
cd "$work"

echo "== $id: OpenStreetMap extract"
src="${SOURCE_PBF:-source.osm.pbf}"
if [ -n "${COUNTRY_PBF:-}" ]; then
  src="$COUNTRY_PBF"
elif [ ! -s "$src" ]; then
  curl -fL --retry 5 -o "$src.part" "https://download.geofabrik.de/$geofabrik-latest.osm.pbf"
  mv "$src.part" "$src"
fi
osmium fileinfo -g header.option.osmosis_replication_timestamp "$src" > osm-timestamp.txt || true

if [ -n "$region_file" ]; then
  cp "$here/$region_file" region.geojson
  if [ -n "${COUNTRY_PBF:-}" ]; then ln -sf "$COUNTRY_PBF" country.osm.pbf
  else osmium extract -O -s smart -p region.geojson "$src" -o country.osm.pbf; fi
else
  curl -fsL --retry 5 -o region.poly "https://download.geofabrik.de/$geofabrik.poly"
  node_run "$here/poly-to-geojson.mjs" region.poly region.geojson
  ln -sf "$src" country.osm.pbf
fi

echo "== $id: basemap"
planet="${PLANET:-}"
if [ -z "$planet" ]; then
  planet="https://build.protomaps.com/$(curl -fsL https://build-metadata.protomaps.dev/builds.json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const b = JSON.parse(s); console.log(b[b.length - 1].key) })')"
fi
echo "$planet" > planet-url.txt
pmtiles extract "$planet" basemap-full.pmtiles --region=region.geojson --maxzoom="${MAXZOOM:-14}" --download-threads=8
node_run "$here/slim-basemap.mjs" basemap-full.pmtiles "$out/map.pmtiles" "$id"

echo "== $id: roads"
osmium tags-filter -O country.osm.pbf w/highway -o highways.osm.pbf
osmium renumber -O -t node highways.osm.pbf -o highways-renumbered.osm.pbf
osmium add-locations-to-ways -O highways-renumbered.osm.pbf -f opl,add_metadata=false -o highways.opl
node_run "$here/build-roads.mjs" highways.opl roads.bin

echo "== $id: buildings"
osmium tags-filter -O country.osm.pbf wr/building -o buildings.osm.pbf
osmium export -O buildings.osm.pbf -f geojsonseq --geometry-types=polygon -x print_record_separator=false -a "" -o buildings.geojsonseq
node_run "$here/build-buildings.mjs" buildings.geojsonseq buildings.bin

echo "== $id: places, water, addresses, search"
osmium tags-filter -O country.osm.pbf \
  nwr/amenity nwr/shop nwr/healthcare nwr/natural=spring nwr/ford nwr/waterway=weir,dam \
  nwr/man_made=water_well,water_tap n/place nwr/addr:housenumber w/highway=ford \
  -o features.osm.pbf
osmium export -O features.osm.pbf -f geojsonseq -x print_record_separator=false -a "" -o features.geojsonseq
node_run "$here/build-pois.mjs" features.geojsonseq highways.opl .

echo "== $id: compress"
for name in places.bin water.bin addresses.bin geo.json roads.bin buildings.bin; do
  pigz -9 -n -c "$name" > "$out/$name.gz"
done

echo "== $id: catalog entry"
node_run "$here/make-catalog.mjs" "$id" "$work" "$repo"
node_run "$repo/scripts/make-index.mjs"
[ -n "${SKIP_VALIDATE:-}" ] || node_run "$repo/scripts/validate-catalog.mjs" "$repo/catalog/$id.json"
ls -l "$out"
