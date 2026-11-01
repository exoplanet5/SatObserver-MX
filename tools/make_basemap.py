#!/usr/bin/env python3
"""Build the map imagery from NASA's Blue Marble and Black Marble mosaics.

    python tools/make_basemap.py [--day SRC] [--night SRC] [--only day|night]

--day   NASA Blue Marble Next Generation, topo + bathy, 21600x10800
        (default: the September-2004 mosaic
        world.topo.bathy.200409.3x21600x10800.jpg in ~/sda/basemaps)
--night NASA Black Marble 2016 colour map, 3 km, 13500x6750
        (default: BlackMarble_2016_3km.jpg in ~/sda/basemaps; from
        https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps)

Writes, relative to the repo root:

  app/assets/bm/<z>/<x>_<y>.webp   2D-map tile pyramid, 1350-px tiles;
                                   level z is (2700 << z) x (1350 << z),
                                   z = 0..3 (z = 3 is the full 21600 source)
  app/assets/earth_day_8k.webp     8192x4096 day texture for the 3D globe
  app/assets/earth_night_8k.webp   8192x4096 night-lights texture for the globe

Needs Pillow with WebP support.
"""
import argparse
import pathlib
import sys
import time

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASEMAPS = pathlib.Path.home() / "sda/basemaps"
TILE = 1350
LEVELS = 4
QUALITY = 84
NIGHT_QUALITY = 90   # mostly black: point lights deserve the bits
GLOBE_W = 8192


def save_webp(img, path, quality=QUALITY):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "WEBP", quality=quality, method=6)
    return path.stat().st_size


def build_day(src_path):
    src = Image.open(src_path).convert("RGB")
    full_w = TILE * 2 << (LEVELS - 1)
    if src.size != (full_w, full_w // 2):
        sys.exit(f"expected a {full_w}x{full_w // 2} equirectangular day source, got {src.size}")
    total = 0
    for z in range(LEVELS - 1, -1, -1):
        w = 2 * TILE << z
        lvl = src if w == full_w else src.resize((w, w // 2), Image.LANCZOS)
        nx, ny = w // TILE, w // 2 // TILE
        size = 0
        for y in range(ny):
            for x in range(nx):
                tile = lvl.crop((x * TILE, y * TILE, (x + 1) * TILE, (y + 1) * TILE))
                size += save_webp(tile, ROOT / f"app/assets/bm/{z}/{x}_{y}.webp")
        total += size
        print(f"level {z}: {w}x{w // 2}, {nx * ny} tiles, {size / 2**20:.1f} MB")
    gsize = save_webp(src.resize((GLOBE_W, GLOBE_W // 2), Image.LANCZOS),
                      ROOT / "app/assets/earth_day_8k.webp")
    print(f"globe day texture {GLOBE_W}x{GLOBE_W // 2}: {gsize / 2**20:.1f} MB")
    return total + gsize


def build_night(src_path):
    src = Image.open(src_path).convert("RGB")
    w, h = src.size
    if w != 2 * h:
        sys.exit(f"expected a 2:1 equirectangular night source, got {src.size}")
    size = save_webp(src.resize((GLOBE_W, GLOBE_W // 2), Image.LANCZOS),
                     ROOT / "app/assets/earth_night_8k.webp", NIGHT_QUALITY)
    print(f"globe night texture {GLOBE_W}x{GLOBE_W // 2} (from {w}x{h}): {size / 2**20:.1f} MB")
    return size


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--day", type=pathlib.Path,
                    default=BASEMAPS / "world.topo.bathy.200409.3x21600x10800.jpg")
    ap.add_argument("--night", type=pathlib.Path, default=BASEMAPS / "BlackMarble_2016_3km.jpg")
    ap.add_argument("--only", choices=("day", "night"))
    args = ap.parse_args()
    Image.MAX_IMAGE_PIXELS = None
    t0 = time.time()
    total = 0
    if args.only != "night":
        total += build_day(args.day)
    if args.only != "day":
        total += build_night(args.night)
    print(f"total {total / 2**20:.1f} MB in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
