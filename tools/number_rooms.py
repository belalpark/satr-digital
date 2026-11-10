#!/usr/bin/env python3
"""Number the rooms that share a name, starting from the door.

    python3 tools/number_rooms.py            # writes the names into data/office.json
    python3 tools/number_rooms.py --check    # exit 1 when the data does not follow the rule

Owner (2026-11-11): the offices are «مكتب 1، مكتب 2، …», the employee areas «مكاتب موظفين 1، 2، …» and the
meeting rooms «قاعة اجتماعات 1، 2», numbered by default starting from the door.

The rule. "From the door" is the walk the site already draws for the employees (scenes.paths, route
`employees`): it leaves the lift lobby through the office door, goes round the whole ring corridor once and
comes back. A room's place in the order is the point of that walk nearest to the middle of the room, measured
along the walk from the door. Each kind is numbered by itself in that order. So number 1 of every kind is the
first one a person meets after the door, and neighbours have neighbouring numbers.

The numbers are part of the name, so the plan labels, the room list, the panel, the path bar, the gallery and
the route stops all show them. Inside the data the rooms of a kind stand together in numbered order, so the
room list and the gallery read 1, 2, 3. These are not the key-plan codes (`key`), which stay unseen. Run tools/make_thumbpack.py afterwards: the pack follows the order of the rooms.
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "office.json"
BASE = {"office": "مكتب", "open": "مكاتب موظفين", "meeting": "قاعة اجتماعات"}


def centroid(poly):
    area = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        c = x1 * y2 - x2 * y1
        area += c
        cx += (x1 + x2) * c
        cy += (y1 + y2) * c
    return cx / (3 * area), cy / (3 * area)


def along(route, p):
    """Distance from the start of the walk to its point nearest to p (the first one, when two tie)."""
    best = (float("inf"), 0.0)
    walked = 0.0
    for (x1, y1), (x2, y2) in zip(route, route[1:]):
        seg = math.hypot(x2 - x1, y2 - y1)
        t = 0.0 if seg == 0 else max(0.0, min(1.0, ((p[0] - x1) * (x2 - x1) + (p[1] - y1) * (y2 - y1)) / seg ** 2))
        d = math.hypot(p[0] - (x1 + t * (x2 - x1)), p[1] - (y1 + t * (y2 - y1)))
        if d < best[0] - 1e-6:
            best = (d, walked + t * seg)
        walked += seg
    return best[1]


def numbered(data):
    """{room id: (kind, number)} for the kinds that are numbered."""
    walk = next(r for r in data["scenes"]["paths"]["routes"] if r["id"] == "employees")["points"]
    out = {}
    for kind in BASE:
        rooms = [r for r in data["rooms"] if r["kind"] == kind and r.get("polygon")]
        rooms.sort(key=lambda r: along(walk, centroid(r["polygon"])))
        for n, r in enumerate(rooms, 1):
            out[r["id"]] = (kind, n)
    return out


def apply(data):
    order = numbered(data)
    # the rooms of a numbered kind stand together, in numbered order, where the first of them stood
    rooms, placed = [], set()
    for r in data["rooms"]:
        kind = order.get(r["id"], (None,))[0]
        if kind is None:
            rooms.append(r)
        elif kind not in placed:
            placed.add(kind)
            rooms.extend(sorted((x for x in data["rooms"] if order.get(x["id"], (None,))[0] == kind), key=lambda x: order[x["id"]][1]))
    data["rooms"] = rooms
    for r in rooms:
        if r["id"] in order:
            kind, n = order[r["id"]]
            r["name"] = f"{BASE[kind]} {n}"
    names = {r["id"]: r["name"] for r in rooms}
    for route in data["scenes"]["paths"]["routes"]:
        for stop in route["stops"]:
            stop["label"] = names[stop["roomId"]]
    return data


def main():
    text = DATA.read_text(encoding="utf-8")
    new = json.dumps(apply(json.loads(text)), ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv:
        print("room numbers follow the walk from the door" if new == text else "room numbers are STALE: run python3 tools/number_rooms.py")
        sys.exit(0 if new == text else 1)
    DATA.write_text(new, encoding="utf-8")
    for r in json.loads(new)["rooms"]:
        if r["kind"] in BASE:
            print(f'{r["name"]:<20} {r["id"]}')


if __name__ == "__main__":
    main()
