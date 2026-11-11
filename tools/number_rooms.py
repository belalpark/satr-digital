#!/usr/bin/env python3
"""Number the rooms that share a name, starting from the door.

    python3 tools/number_rooms.py            # writes the names into data/office.json
    python3 tools/number_rooms.py --check    # exit 1 when the data does not follow the rule

Owner (2026-11-11): the offices are «مكتب 1، مكتب 2، …», the employee areas «مكاتب موظفين 1، 2، …» and the
meeting rooms «قاعة اجتماعات 1، 2», numbered by default starting from the door.

The rule. "From the door" is the walk the site already draws for the employees (scenes.paths, route
`employees`): it leaves the lift lobby through the office door, goes round the whole ring corridor once and
comes back. A room's place in the order is where that walk first comes alongside it: the first point of the
walk that is as close to the room's outline as the walk ever gets, give or take a metre. Each kind is numbered
by itself in that order. So number 1 of every kind is the first one a person meets after the door, and
neighbours have neighbouring numbers.

(Until 2026-11-11 the place was the point of the walk nearest to the room's middle. A room on a corner of the
walk is passed on two sides, and its middle can be nearer to the second: the two glass offices that stand side
by side on the south corridor came out as 2 and 4 with another office between them. Where the walk first
reaches a room is what a person walking from the door sees.)

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


REACH = 32.0  # plan px: one metre (tools/twin/layout.py SCALE)
STEP = 1.0    # plan px between the points of the walk that are tried


def to_segment(p, a, b):
    (x1, y1), (x2, y2) = a, b
    seg = math.hypot(x2 - x1, y2 - y1)
    t = 0.0 if seg == 0 else max(0.0, min(1.0, ((p[0] - x1) * (x2 - x1) + (p[1] - y1) * (y2 - y1)) / seg ** 2))
    return math.hypot(p[0] - (x1 + t * (x2 - x1)), p[1] - (y1 + t * (y2 - y1)))


def to_room(p, poly):
    """Distance from a point to a room: 0 inside it, else to its outline."""
    inside = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1:
            inside = not inside
    return 0.0 if inside else min(to_segment(p, a, b) for a, b in zip(poly, poly[1:] + poly[:1]))


def first_reach(route, poly):
    """Distance walked from the door to the first point that is within REACH of the walk's closest approach to the room."""
    points, walked = [], 0.0
    for (x1, y1), (x2, y2) in zip(route, route[1:]):
        seg = math.hypot(x2 - x1, y2 - y1)
        n = max(1, round(seg / STEP))
        points += [(walked + seg * i / n, (x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n)) for i in range(n + 1)]
        walked += seg
    far = [(s, to_room(p, poly)) for s, p in points]
    closest = min(d for _, d in far)
    return next(s for s, d in far if d <= closest + REACH)


def numbered(data):
    """{room id: (kind, number)} for the kinds that are numbered."""
    walk = next(r for r in data["scenes"]["paths"]["routes"] if r["id"] == "employees")["points"]
    out = {}
    for kind in BASE:
        rooms = [r for r in data["rooms"] if r["kind"] == kind and r.get("polygon")]
        rooms.sort(key=lambda r: first_reach(walk, r["polygon"]))
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
