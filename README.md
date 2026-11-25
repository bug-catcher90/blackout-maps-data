# Blackout Maps data

The offline map packages for [Blackout Maps](https://github.com/bug-catcher90/blackout-maps): free emergency maps that work with no network, at [blackoutmaps.com/maps](https://blackoutmaps.com/maps/) and in the Android and iOS apps.

Each package covers one country or region and holds everything the apps need offline: a basemap, the road graph for routing, building outlines, services (POIs), water points, addresses and name search. The apps list the packages from [`catalog/index.json`](catalog/index.json) and download them from this repository through `raw.githubusercontent.com`. **A package merged here shows up in the web app, Android and iOS without any app change.**

## Layout

```
catalog/
  index.json            every package entry in one file; the apps read this (generated)
  <id>.json             one package entry: name, flag, view, files, sizes, SHA-256s, part URLs
  <id>/                 that package's data parts, nothing else
    map.pmtiles[.NNN]   basemap (PMTiles, not gzipped)
    roads.bin.gz[.NNN]  road graph
    buildings.bin.gz[.NNN]
    places.bin.gz       services / POIs
    water.bin.gz
    addresses.bin.gz
    geo.json.gz         name search
scripts/
  validate-catalog.mjs  the validator CI runs
  make-index.mjs        rewrites catalog/index.json
  maps/                 the extraction pipeline (build-country.sh and helpers)
    countries.json      how each package is built
    regions/            polygons for regions of large countries
  readers/              copies of the apps' format readers, used by the validator and build
  sync-readers.sh       refreshes scripts/readers/ from the app repository
SPEC.md                 the package format and every rule the validator enforces
CONTRIBUTING.md         how to add or rebuild a package
AGENTS.md               instructions for coding agents
```

## Rules in short

- **Seven layers, always:** basemap (`map`), roads, buildings, places/POIs, water, addresses and search (`geo`). CI rejects a package missing any of them.
- **Parts of 45 MB or less** (45,000,000 bytes), each with its size and SHA-256 in the entry.
- **Roads plus buildings under 450 MB unpacked**, because phones hold both in memory. Larger countries are split into regions.
- **`catalog/index.json` must match the entries.** `node scripts/make-index.mjs` rewrites it.

[SPEC.md](SPEC.md) has the details; [CONTRIBUTING.md](CONTRIBUTING.md) has the steps.

## Quick start

```bash
node scripts/validate-catalog.mjs --shallow          # every entry, JSON only (seconds)
node scripts/validate-catalog.mjs catalog/wales.json # open every file of one package
scripts/maps/build-country.sh <id> /tmp/blackout-maps # rebuild a package from OpenStreetMap
```

Cloning everything downloads about 12 GB. To work on the scripts or one package, clone without the data:

```bash
git clone --filter=blob:none --sparse https://github.com/bug-catcher90/blackout-maps-data
cd blackout-maps-data
git sparse-checkout set --no-cone '/*' '!/catalog/*/' '/catalog/wales/'
```

## Hosting

Parts are served from `https://raw.githubusercontent.com/bug-catcher90/blackout-maps-data/main/catalog/<id>/<part>`, which sends `Access-Control-Allow-Origin: *` and honours `Range`, so the web app can download and resume them. GitHub Releases would keep the data out of git history, but release downloads send no CORS header, so the web app could not use them. jsDelivr refuses files over 20 MB.

## License

The map data is derived from [OpenStreetMap](https://www.openstreetmap.org/copyright) and [Protomaps](https://protomaps.com) builds of it, and is available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). © OpenStreetMap contributors. The scripts are under the MIT License. See [LICENSE](LICENSE).
