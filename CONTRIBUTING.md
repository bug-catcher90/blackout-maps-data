# Contributing map packages

New countries, new regions and refreshed data are all welcome. App code (the web app, Android, iOS) lives in [bug-catcher90/blackout-maps](https://github.com/bug-catcher90/blackout-maps); this repository holds only the packages and the tools that build and check them.

## Report a problem with the map data

Wrong or missing places almost always come from OpenStreetMap. Fix them at [openstreetmap.org](https://www.openstreetmap.org/fixthemap) so everyone benefits, then open an issue here asking for the package to be rebuilt.

## What every package must have

| Layer | `key` | File |
| --- | --- | --- |
| Basemap with roads, buildings, landuse and labels | `map` | `map.pmtiles` |
| Road graph for routing | `roads` | `roads.bin.gz` |
| Building outlines | `buildings` | `buildings.bin.gz` |
| Places / POIs (health, police, fire, fuel, food, restaurants) | `places` | `places.bin.gz` |
| Water points | `water` | `water.bin.gz` |
| Addresses (streets and doors) | `addresses` | `addresses.bin.gz` |
| Name search | `geo` | `geo.json.gz` |

The validator fails, and so does CI, when any layer is missing, empty or unreadable. [SPEC.md](SPEC.md) is the full specification.

### Folder structure

```
scripts/maps/countries.json      your entry: id, name, flag, Geofabrik extract
scripts/maps/regions/<country>/  region polygons, only for split countries
catalog/<id>.json                generated package entry
catalog/<id>/                    generated parts, nothing else
catalog/index.json               generated list of every entry
```

`<id>` is lowercase words joined by hyphens: `denmark`, `northern-ireland`, `germany-saxony`. A region's id starts with its country's.

### Size and memory limits

- **Parts:** every file is split into parts of at most 45,000,000 bytes (GitHub warns at 50 MB and rejects 100 MB). `make-catalog.mjs` does the splitting.
- **Phone memory budget:** both apps hold the road graph and the buildings in memory at the same time, so `roads` + `buildings` must unpack to under 450 MB. In practice the package's OpenStreetMap extract has to stay under about 420 MB. A bigger country is published as regions (step 2).
- **One package, or one country's regions, per pull request,** so each push stays well under GitHub's 2 GB push limit.

## Add a country or a region

You need `osmium-tool` 1.14 or newer, [`pmtiles`](https://github.com/protomaps/go-pmtiles/releases) 1.20 or newer, Node 20 or newer, `pigz`, `curl` and, for countries split into regions, Python 3 with `shapely`. A country of Portugal's size builds in about ten minutes and needs 10 GB of free disk and 8 GB of memory (swap works).

Clone without downloading the 12 GB of existing parts:

```bash
git clone --filter=blob:none --sparse https://github.com/bug-catcher90/blackout-maps-data
cd blackout-maps-data
git sparse-checkout set --no-cone '/*' '!/catalog/*/'
```

1. **Describe the package** in `scripts/maps/countries.json`:

   ```json
   { "id": "denmark", "name": "Denmark", "flag": "🇩🇰", "geofabrik": "europe/denmark" }
   ```

   `geofabrik` is the extract's path on [download.geofabrik.de](https://download.geofabrik.de/), without `-latest.osm.pbf`. For an area that is part of an extract, add `"region": "regions/<file>.geojson"` with its polygon, as Northern Ireland does.

2. **Split it if it is large.** Add `"split": { "fromLevel": 4 }` to the country's entry and run:

   ```bash
   curl -L -o /tmp/denmark.osm.pbf https://download.geofabrik.de/europe/denmark-latest.osm.pbf
   python3 scripts/maps/make-regions.py denmark /tmp/denmark.osm.pbf
   ```

   This writes the region polygons to `scripts/maps/regions/denmark/` and one `countries.json` entry per region, each with `"country": "denmark"`. Build the regions instead of the country.

3. **Build it** (the extraction):

   ```bash
   scripts/maps/build-country.sh denmark /tmp/blackout-maps
   ```

   This downloads the Geofabrik extract and cuts the basemap from the newest Protomaps planet build. It builds the seven files, splits them into parts in `catalog/denmark/` (deleting what was there), writes `catalog/denmark.json`, refreshes `catalog/index.json` and runs the validator. The script header lists its environment variables (`PLANET`, `MAXZOOM`, `SOURCE_PBF`, `COUNTRY_PBF`, `BASE_URL`).

4. **Validate it:**

   ```bash
   node scripts/validate-catalog.mjs catalog/denmark.json   # open every file of the package
   node scripts/validate-catalog.mjs --shallow              # every entry and the index, JSON only
   ```

   It fails when any layer is missing, when services, water, addresses, search names, roads, buildings or basemap layers are empty, when a checksum or size is wrong, when a part is over 45 MB, when roads plus buildings would not fit in a phone's memory, or when `catalog/index.json` is out of date.

5. **Try it** in the web app before the package is merged:

   ```bash
   node scripts/serve-local.mjs 8000                      # here: serves catalog/ with local part URLs
   cd ../blackout-maps/website && python3 -m http.server 3000   # in a checkout of the app repository
   ```

   Open `http://localhost:3000/maps/?catalog=http://127.0.0.1:8000/catalog/index.json` (the override works on localhost only), import the package from Settings → Import maps, and check roads, buildings, services, search and a walking and a driving route at phone width, in light and dark mode.

6. **Open a pull request** with `scripts/maps/countries.json`, `catalog/<id>.json`, `catalog/<id>/` and `catalog/index.json`. If `index.json` conflicts with another merged package, re-run `node scripts/make-index.mjs` and commit the result. A rebuilt package replaces its parts in place; never keep old versions next to the new ones.

Once merged, the package appears in Settings → Import maps in all three apps, usually within five minutes (GitHub's raw cache).

## Continuous integration

`.github/workflows/validate-catalog.yml` runs on every pull request and push to `main`:

- `validate-catalog.mjs --shallow` checks every entry, every required layer and the index;
- every package the pull request changes is downloaded and opened in full (when scripts change, `northern-ireland` is re-checked end to end);
- every Monday, `--remote` checks that every part URL still answers with its size and CORS header.

A pull request that fails it is not merged.

## Format changes

The binary formats are defined by the readers in blackout-maps `website/maps/` and `ios/BlackoutMaps/Resources/engine.js`. Change them there first, ship the apps, then run `scripts/sync-readers.sh` here, rebuild the packages and bump `INDEX_FORMAT` in `scripts/make-index.mjs` only if old apps can no longer read the index.

Never commit secrets or anything that is not map data or tooling.
