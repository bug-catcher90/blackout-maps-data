#!/usr/bin/env python3
"""Splits a country that is too large for one package into regions.

    python3 scripts/maps/make-regions.py <country-id> <country.osm.pbf> [work-dir]

Both apps hold a package's road graph and buildings in memory, so a package's
OpenStreetMap extract must stay under LIMIT_BYTES (SPEC.md).
Starting from the whole country, any area over the limit is cut along the
next OpenStreetMap administrative level (boundary=administrative), and small
neighbouring areas are grouped back together up to the limit.

Writes scripts/maps/regions/<country-id>/<region-id>.geojson and replaces the
country's generated region entries in scripts/maps/countries.json. Needs
osmium-tool and shapely.
"""
import json
import math
import os
import re
import subprocess
import sys
import unicodedata

from shapely.geometry import Polygon, mapping, shape
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
LIMIT_BYTES = int(os.environ.get("REGION_LIMIT_MB", "420")) * 1_000_000
LEVELS = ["4", "5", "6", "7", "8"]
EXTRACT_BATCH = int(os.environ.get("EXTRACT_BATCH", "2"))


def slug(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def run(*args):
    subprocess.run(args, check=True)


def extract_boundary(geofabrik, work):
    """The Geofabrik extract's .poly boundary (land and sea) as a shape."""
    path = os.path.join(work, "extract.poly")
    if not os.path.exists(path):
        run("curl", "-sfL", "--retry", "3", "-o", path, f"https://download.geofabrik.de/{geofabrik}.poly")
    rings, holes, current = [], [], None
    with open(path) as handle:
        lines = [line.strip() for line in handle][1:]
    for line in lines:
        if not line:
            continue
        if current is None:
            current = {"hole": line.startswith("!"), "points": []}
        elif line == "END":
            (holes if current["hole"] else rings).append(Polygon(current["points"]))
            current = None
        else:
            x, y = line.split()[:2]
            current["points"].append((float(x), float(y)))
    return unary_union(rings).difference(unary_union(holes)) if holes else unary_union(rings)


def admin_areas(pbf, work):
    """Every administrative area in the country, as {level, name, shape}."""
    flt = os.path.join(work, "admin.osm.pbf")
    seq = os.path.join(work, "admin.geojsonseq")
    run("osmium", "tags-filter", "-O", pbf, "r/boundary=administrative", "-o", flt)
    run("osmium", "export", "-O", flt, "-f", "geojsonseq", "--geometry-types=polygon",
        "-x", "print_record_separator=false", "-o", seq)
    areas = []
    with open(seq) as handle:
        for line in handle:
            feature = json.loads(line)
            props = feature["properties"]
            level = props.get("admin_level")
            name = props.get("name:en") or props.get("name")
            if props.get("boundary") != "administrative" or level not in LEVELS or not name:
                continue
            try:
                geom = shape(feature["geometry"]).buffer(0)
            except Exception:
                continue
            if geom.is_empty:
                continue
            areas.append({"level": level, "name": name, "shape": geom})
    return areas


def extract(pbf, regions, work):
    """Cuts the regions out of pbf, EXTRACT_BATCH per osmium pass; sets region["pbf"] and region["bytes"]."""
    extracts = []
    for region in regions:
        poly = os.path.join(work, f"{region['slug']}.geojson")
        text = json.dumps({"type": "Feature", "properties": {}, "geometry": mapping(region["shape"])})
        region["pbf"] = os.path.join(work, f"{region['slug']}.osm.pbf")
        done = region["pbf"] + ".done"
        if os.path.exists(done) and os.path.exists(poly) and open(poly).read() == text:
            continue
        if os.path.exists(done):
            os.remove(done)
        with open(poly, "w") as handle:
            handle.write(text)
        extracts.append({"output": os.path.basename(region["pbf"]), "polygon": {"file_name": poly, "file_type": "geojson"}})
    # osmium's smart strategy keeps id sets per output; four outputs of England needed 14 GB.
    for start in range(0, len(extracts), EXTRACT_BATCH):
        config = os.path.join(work, "extracts.json")
        with open(config, "w") as handle:
            json.dump({"directory": work, "extracts": extracts[start:start + EXTRACT_BATCH]}, handle)
        run("osmium", "extract", "-O", "-s", "smart", "-c", config, pbf)
        for item in extracts[start:start + EXTRACT_BATCH]:
            open(os.path.join(work, item["output"] + ".done"), "w").close()
    for region in regions:
        region["bytes"] = os.path.getsize(region["pbf"])


def direction(parent, child):
    dx = child.centroid.x - parent.centroid.x
    dy = child.centroid.y - parent.centroid.y
    minx, miny, maxx, maxy = parent.bounds
    if abs(dx) < (maxx - minx) * 0.12 and abs(dy) < (maxy - miny) * 0.12:
        return "Central"
    names = ["East", "North-East", "North", "North-West", "West", "South-West", "South", "South-East"]
    return names[int(((math.degrees(math.atan2(dy, dx)) + 360 + 22.5) % 360) // 45)]


def group(parent, children):
    """Packs neighbouring children into compact areas under the limit by halving along the longer side."""
    def bisect(members):
        total = sum(m["bytes"] for m in members)
        if total <= LIMIT_BYTES or len(members) == 1:
            return [members]
        points = [m["shape"].centroid for m in members]
        scale = math.cos(math.radians(sum(p.y for p in points) / len(points)))
        wide = (max(p.x for p in points) - min(p.x for p in points)) * scale > max(p.y for p in points) - min(p.y for p in points)
        ordered = sorted(members, key=(lambda m: m["shape"].centroid.x) if wide else (lambda m: m["shape"].centroid.y))
        parts = math.ceil(total / LIMIT_BYTES)
        goal = total * (parts // 2) / parts
        size, cut = 0, 1
        for i, member in enumerate(ordered[:-1]):
            size += member["bytes"]
            cut = i + 1
            if size >= goal:
                break
        return bisect(ordered[:cut]) + bisect(ordered[cut:])

    bins = bisect(children)
    out = []
    for members in bins:
        if len(members) == 1:
            out.append(members[0])
            continue
        geom = unary_union([m["shape"] for m in members])
        names = [m["name"] for m in members]
        if len(names) <= 5:
            label = ", ".join(names[:-1]) + " & " + names[-1]
        else:
            label = direction(parent["shape"], geom) if parent.get("root") else f"{parent['name']} {direction(parent['shape'], geom)}"
        out.append({"name": label, "shape": geom, "bytes": sum(m["bytes"] for m in members), "members": members})
    seen = {}
    for region in out:
        seen[region["name"]] = seen.get(region["name"], 0) + 1
    counters = {}
    for region in out:
        if seen[region["name"]] > 1:
            counters[region["name"]] = counters.get(region["name"], 0) + 1
            region["name"] = f"{region['name']} {counters[region['name']]}"
    return out


def split(area, areas, work, depth=0):
    """Returns the packages for area: itself if small enough, else its regions."""
    if area["bytes"] <= LIMIT_BYTES:
        return [area]
    inside = area["shape"].buffer(0.01)
    for level in LEVELS:
        if level <= area.get("level", "0"):
            continue
        children = [
            {"level": a["level"], "name": a["name"], "shape": a["shape"].intersection(area["shape"]).buffer(0)}
            for a in areas
            if a["level"] == level and inside.contains(a["shape"].representative_point())
        ]
        children = [c for c in children if not c["shape"].is_empty]
        covered = unary_union([c["shape"] for c in children]).area / area["shape"].area if children else 0
        if len(children) < 2 or covered <= 0.9:
            continue
        # What this level leaves out still needs a home: Greater London is in no English county,
        # so a large gap becomes an area named after the boundary that matches it best.
        threshold = area["shape"].area * 0.002
        rest = area["shape"].difference(unary_union([c["shape"] for c in children]))
        pieces = [p for p in getattr(rest, "geoms", [rest]) if not p.is_empty]
        for piece in (p for p in pieces if p.area > threshold):
            near = [a for a in areas if a["shape"].intersects(piece)]
            match = max(near, key=lambda a: a["shape"].intersection(piece).area / a["shape"].union(piece).area)
            children.append({"level": level, "name": match["name"], "shape": piece})
        kept = [c for c in children if c["shape"].area > threshold]
        # Tiny areas such as Bremen or Melilla, and slivers, join their nearest neighbour rather than leaving a hole.
        tiny = [c["shape"] for c in children if c["shape"].area <= threshold] + [p for p in pieces if p.area <= threshold]
        for shape_ in tiny:
            closest = min(kept, key=lambda k: k["shape"].distance(shape_))
            closest.setdefault("extra", []).append(shape_)
        for child in kept:
            if child.get("extra"):
                child["shape"] = unary_union([child["shape"]] + child.pop("extra"))
        children = kept
        if len(children) >= 2:
            break
    else:
        print(f"warning: {area['name']} is {area['bytes'] / 1e6:.0f} MB and has no smaller administrative areas", file=sys.stderr)
        return [area]
    for child in children:
        child["slug"] = slug(f"{area['slug']}-{child['name']}")[:80]
    child_work = os.path.join(work, area["slug"])
    os.makedirs(child_work, exist_ok=True)
    extract(area["pbf"], children, child_work)
    print(f"{'  ' * depth}{area['name']}: {len(children)} areas at admin_level {level}", file=sys.stderr)
    small = [c for c in children if c["bytes"] <= LIMIT_BYTES]
    large = [c for c in children if c["bytes"] > LIMIT_BYTES]
    packages = group(area, small) if small else []
    for child in large:
        packages += split(child, areas, work, depth + 1)
    return packages


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    country_id, pbf = sys.argv[1], sys.argv[2]
    work = os.path.abspath(sys.argv[3] if len(sys.argv) > 3 else f"/tmp/blackout-regions/{country_id}")
    os.makedirs(work, exist_ok=True)
    countries_path = os.path.join(HERE, "countries.json")
    with open(countries_path) as handle:
        countries = json.load(handle)
    country = next(c for c in countries if c["id"] == country_id)
    split_spec = country.get("split") or {}
    start = str(split_spec.get("fromLevel", "4"))

    areas = admin_areas(pbf, work)
    tops = [a for a in areas if a["level"] == str(int(start) - 1)] if start != "4" else []
    if tops:
        outline = max(tops, key=lambda a: a["shape"].area)["shape"]
    elif start == "4":
        outline = unary_union([a["shape"] for a in areas if a["level"] == start])
    else:
        # The country's own boundary did not export (England's relation is too large to be complete in
        # its extract); the areas below it, trimmed to the extract's boundary, are the next best outline.
        inside = extract_boundary(country["geofabrik"], work).buffer(-0.02)
        below = [a for a in areas if a["level"] >= start and inside.contains(a["shape"].representative_point())]
        outline = unary_union([a["shape"] for a in below])
    root = {"name": country["name"], "slug": country_id, "shape": outline, "pbf": os.path.abspath(pbf),
            "bytes": os.path.getsize(pbf), "level": str(int(start) - 1), "root": True}
    packages = split(root, areas, work)
    if packages == [root]:
        print(f"{country_id} fits in one package", file=sys.stderr)
        return

    out_dir = os.path.join(HERE, "regions", country_id)
    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):
        os.remove(os.path.join(out_dir, name))
    entries = []
    for package in sorted(packages, key=lambda p: p["name"]):
        region_slug = slug(package["name"])
        region_id = f"{country_id}-{region_slug}"[:60].strip("-")
        geom = package["shape"].simplify(0.002).buffer(0.01).simplify(0.002)
        path = os.path.join(out_dir, f"{region_slug}.geojson")
        with open(path, "w") as handle:
            json.dump({"type": "Feature", "properties": {"name": package["name"]}, "geometry": mapping(geom)}, handle)
        entries.append({
            "id": region_id,
            "name": f"{country['name']} · {package['name']}",
            "flag": country["flag"],
            "geofabrik": country["geofabrik"],
            "region": os.path.relpath(path, HERE),
            "country": country_id,
        })
        print(f"{region_id}: {package['bytes'] / 1e6:.0f} MB of OpenStreetMap data", file=sys.stderr)

    countries = [c for c in countries if c.get("country") != country_id]
    at = next(i for i, c in enumerate(countries) if c["id"] == country_id)
    countries[at + 1:at + 1] = entries
    with open(countries_path, "w") as handle:
        handle.write(json.dumps(countries, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
