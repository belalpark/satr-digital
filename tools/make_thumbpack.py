#!/usr/bin/env python3
"""Every small picture of the site in ONE file.

    python3 tools/make_thumbpack.py            # writes media/rooms/thumbs.bin and stamps data/office.json
    python3 tools/make_thumbpack.py --check    # exit 1 when the pack on disk is not what the data asks for

Why: the page used to fetch each small picture by itself (123 requests over a visit). On the live host the
security service in front of the site sometimes answered such a request with its verification page, and the
visitor saw a broken picture. One file, fetched once on arrival and drawn from memory afterwards, leaves the
small pictures independent of the network for the rest of the visit. The separate files stay in place: the page
falls back to them when the pack has not arrived.

Format: uint32 LE header length, then a UTF-8 JSON header {"files": [[path, offset, length], ...]}, then the
files' bytes back to back (offsets count from the end of the header). The bytes are the thumbnails untouched.
Run again after photos change; tests/unit/data.test.mjs fails when the pack and the files differ.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "office.json"
PACK = "media/rooms/thumbs.bin"


def thumb_paths(data):
    seen = []
    for room in data["rooms"]:
        for photo in room.get("photos") or []:
            t = photo.get("thumb")
            if t and t not in seen:
                seen.append(t)
    return seen


def build(data):
    paths = thumb_paths(data)
    blobs = [(ROOT / p).read_bytes() for p in paths]
    index, offset = [], 0
    for p, b in zip(paths, blobs):
        index.append([p, offset, len(b)])
        offset += len(b)
    head = json.dumps({"files": index}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(head)) + head + b"".join(blobs), len(paths)


def main():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    pack, count = build(data)
    stamp = f"{PACK}?v={hashlib.sha1(pack).hexdigest()[:10]}"
    target = ROOT / PACK
    if "--check" in sys.argv:
        ok = target.exists() and target.read_bytes() == pack and data["office"].get("thumbPack") == stamp
        print("thumb pack is current" if ok else "thumb pack is STALE: run python3 tools/make_thumbpack.py")
        sys.exit(0 if ok else 1)
    target.write_bytes(pack)
    if data["office"].get("thumbPack") != stamp:
        data["office"]["thumbPack"] = stamp
        DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{PACK}: {count} pictures, {len(pack) / 1e6:.2f} MB -> {stamp}")


if __name__ == "__main__":
    main()
