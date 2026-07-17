#!/usr/bin/env python3
"""Generate the SatObserver-MX app icon: orthographic Earth render from the
bundled Blue Marble with an orbit ring + satellite dot. Writes icon_1024.png."""

import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(__file__).resolve().parent

SIZE = 1024
R = 400                 # globe radius px
CX = CY = SIZE // 2
VIEW_LON0 = -30.0       # Atlantic view
VIEW_LAT0 = 18.0
ACCENT = (79, 195, 247, 255)


def render_globe():
    tex = np.asarray(Image.open(ROOT / "app/assets/earth_day.jpg").convert("RGB"), dtype=np.float32)
    th, tw, _ = tex.shape

    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    nx = (xx - CX) / R
    ny = -(yy - CY) / R
    rr2 = nx * nx + ny * ny
    inside = rr2 <= 1.0
    nz = np.sqrt(np.clip(1.0 - rr2, 0, 1))

    # tilt view down by VIEW_LAT0 (rotation about x-axis)
    phi = np.deg2rad(VIEW_LAT0)
    ny2 = ny * np.cos(phi) + nz * np.sin(phi)
    nz2 = -ny * np.sin(phi) + nz * np.cos(phi)

    lat = np.arcsin(np.clip(ny2, -1, 1))
    lon = np.deg2rad(VIEW_LON0) + np.arctan2(nx, nz2)

    u = ((np.degrees(lon) + 180.0) % 360.0) / 360.0 * (tw - 1)
    v = (90.0 - np.degrees(lat)) / 180.0 * (th - 1)
    ui = np.clip(u.astype(np.int32), 0, tw - 1)
    vi = np.clip(v.astype(np.int32), 0, th - 1)

    rgb = tex[vi, ui]
    shade = (0.35 + 0.65 * nz)[..., None]           # limb darkening
    rgb = np.clip(rgb * shade, 0, 255).astype(np.uint8)

    alpha = np.zeros((SIZE, SIZE), dtype=np.uint8)
    alpha[inside] = 255
    img = np.dstack([rgb, alpha])
    img[~inside] = 0
    globe = Image.fromarray(img, "RGBA")

    # soft atmosphere rim
    rim = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(rim)
    d.ellipse([CX - R - 14, CY - R - 14, CX + R + 14, CY + R + 14],
              outline=(110, 180, 255, 170), width=16)
    rim = rim.filter(ImageFilter.GaussianBlur(10))
    return Image.alpha_composite(rim, globe)


def orbit_ring():
    """Ring layer + the split point so it can pass behind the globe's top."""
    lay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    a, b = 480, 168      # ellipse semi-axes
    d.ellipse([CX - a, CY - b, CX + a, CY + b], outline=ACCENT, width=14)
    # satellite dot at the ellipse's right vertex (carried by the rotation)
    d.ellipse([CX + a - 26, CY - 26, CX + a + 26, CY + 26], fill=(255, 213, 79, 255))
    return lay.rotate(-22, resample=Image.BICUBIC, center=(CX, CY))


def main():
    globe = render_globe()
    ring = orbit_ring()

    # ring behind the globe on the upper half, in front on the lower half
    top = ring.copy()
    top.paste((0, 0, 0, 0), (0, CY, SIZE, SIZE))
    bottom = ring.copy()
    bottom.paste((0, 0, 0, 0), (0, 0, SIZE, CY))

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas = Image.alpha_composite(canvas, top)
    canvas = Image.alpha_composite(canvas, globe)
    canvas = Image.alpha_composite(canvas, bottom)

    canvas.save(OUT / "icon_1024.png")
    print("wrote", OUT / "icon_1024.png")


if __name__ == "__main__":
    main()
