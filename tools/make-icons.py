#!/usr/bin/env python3
"""Draw GEMFALL's home-screen icons into public/icons/ (original art, made in code).

    python3 tools/make-icons.py

Re-run only when the icon design changes; the PNGs are committed. Needs Pillow (the same
dependency as `npm run visual`).

Every icon is drawn at 4x and scaled down, which gives smooth edges without an
anti-aliasing library. The maskable icon keeps the gem inside the middle 80% circle,
the part Android promises never to crop, whatever shape the launcher uses.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SS = 4  # supersampling factor

# Same palette as the page (index.html) and the manifest.
BG_TOP = (42, 26, 94)  # #2a1a5e
BG_BOTTOM = (18, 11, 46)  # #120b2e, the theme colour


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def background(size, rounded):
    """Vertical gradient; rounded corners for the plain icon, full bleed for maskable."""
    img = Image.new("RGBA", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        draw.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / (size - 1)) + (255,))
    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=255)
        img.putalpha(mask)
    return img


def gem(draw, cx, cy, r):
    """A cut gem seen from the side: a crown of facets over a pointed pavilion."""
    top = cy - r * 0.62  # table (flat top)
    girdle = cy - r * 0.12  # widest line
    tip = cy + r * 0.92  # pavilion point
    half_table = r * 0.46
    half_girdle = r

    tl, tr = (cx - half_table, top), (cx + half_table, top)
    gl, gr = (cx - half_girdle, girdle), (cx + half_girdle, girdle)
    gml, gmr = (cx - half_girdle * 0.36, girdle), (cx + half_girdle * 0.36, girdle)
    bottom = (cx, tip)

    # Crown facets: left side, middle table facet, right side.
    draw.polygon([tl, gl, gml], fill=(196, 181, 253))  # violet-300
    draw.polygon([tl, tr, gmr, gml], fill=(233, 213, 255))  # purple-200
    draw.polygon([tr, gmr, gr], fill=(167, 139, 250))  # violet-400
    # Pavilion facets meeting at the tip.
    draw.polygon([gl, gml, bottom], fill=(139, 92, 246))  # violet-500
    draw.polygon([gml, gmr, bottom], fill=(240, 171, 252))  # fuchsia-300, the page accent
    draw.polygon([gmr, gr, bottom], fill=(109, 40, 217))  # violet-700

    # Outline and a small sparkle on the table.
    w = max(1, round(r * 0.045))
    draw.polygon([tl, tr, gr, bottom, gl], outline=(255, 255, 255, 235), width=w)
    draw.line([gl, gr], fill=(255, 255, 255, 150), width=max(1, w // 2))
    sx, sy, s = cx - r * 0.18, top + r * 0.2, r * 0.13
    draw.polygon([(sx, sy - s), (sx + s * 0.3, sy), (sx, sy + s), (sx - s * 0.3, sy)], fill=(255, 255, 255))
    draw.polygon([(sx - s, sy), (sx, sy - s * 0.3), (sx + s, sy), (sx, sy + s * 0.3)], fill=(255, 255, 255))


def icon(size, maskable=False, rounded=True):
    big = size * SS
    img = background(big, rounded=rounded and not maskable)
    # Maskable: the gem must fit the 40%-radius safe circle, so it's drawn smaller.
    r = big * (0.3 if maskable else 0.36)
    gem(ImageDraw.Draw(img), big / 2, big / 2 + r * 0.08, r)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon(192).save(OUT / "icon-192.png", optimize=True)
    icon(512).save(OUT / "icon-512.png", optimize=True)
    icon(512, maskable=True).save(OUT / "icon-maskable-512.png", optimize=True)
    for p in sorted(OUT.glob("*.png")):
        print(f"wrote {p.relative_to(OUT.parent.parent)}  ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
