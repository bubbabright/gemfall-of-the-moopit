#!/usr/bin/env python3
"""Offline visual checks for the GEMFALL POC screenshots.

A WebGL canvas cannot be read back through drawImage in headless Chromium, so
tools/playtest.mjs saves real PNGs with Page.captureScreenshot and writes the
ground-truth layout to poc/geometry.json. This script reads both: no pixel
guesswork about where the canvas or the board actually is.

Usage:  python3 tools/analyze-shots.py [poc-dir]
"""
from __future__ import annotations

import colorsys
import json
import sys
from pathlib import Path

from PIL import Image

# Fallback when geometry.json predates the per-screen layout (canvas.game).
GAME_W, GAME_H = 720, 900


def dist(a, b) -> float:
    return max(abs(a[i] - b[i]) for i in range(3))


class Frame:
    """Maps game coordinates onto screenshot pixels using geometry.json."""

    def __init__(self, img: Image.Image, canvas: dict):
        self.img = img
        self.px = img.load()
        self.dpr = canvas.get("dpr") or 1
        self.left = canvas["left"]
        self.top = canvas["top"]
        game = canvas.get("game") or {}
        self.sw = canvas["w"] / game.get("width", GAME_W)
        self.sh = canvas["h"] / game.get("height", GAME_H)

    def to_px(self, gx: float, gy: float) -> tuple[int, int]:
        return (
            int(round((self.left + gx * self.sw) * self.dpr)),
            int(round((self.top + gy * self.sh) * self.dpr)),
        )

    def patch(self, gx: float, gy: float, r: int = 6):
        cx, cy = self.to_px(gx, gy)
        w, h = self.img.size
        pts = [
            self.px[x, y]
            for x in range(max(0, cx - r), min(w, cx + r + 1))
            for y in range(max(0, cy - r), min(h, cy + r + 1))
        ]
        n = len(pts) or 1
        return tuple(sum(p[i] for p in pts) // n for i in range(3))


def lit(c, sat: float = 0.45, val: float = 0.45) -> bool:
    """A vivid pixel: a gem, or a highlighted label. The dim menu text and the faint falling
    gems behind the cards stay under these thresholds."""
    _, s, v = colorsys.rgb_to_hsv(c[0] / 255, c[1] / 255, c[2] / 255)
    return s >= sat and v >= val


def bright(c, val: float = 0.6) -> bool:
    return max(c) / 255 >= val


def purple_fill(c) -> bool:
    """The selected chip's violet fill: dark but strongly coloured. Unselected chips are black
    with light grey-violet text, whose edges are never this saturated."""
    _, s, v = colorsys.rgb_to_hsv(c[0] / 255, c[1] / 255, c[2] / 255)
    return 0.18 <= v <= 0.45 and s >= 0.5


def count_in(img, dpr: float, box: dict, y0: float, y1: float, test) -> int:
    """Pixels passing `test` in a horizontal band of a page-space box (fractions of its height)."""
    px = img.load()
    w, h = img.size
    left, right = int(box["left"] * dpr) + 2, int(box["right"] * dpr) - 2
    top = int((box["top"] + (box["bottom"] - box["top"]) * y0) * dpr)
    bottom = int((box["top"] + (box["bottom"] - box["top"]) * y1) * dpr)
    return sum(
        1
        for x in range(max(0, left), min(w, right))
        for y in range(max(0, top), min(h, bottom))
        if test(px[x, y])
    )


def check_menu(d: Path, geo: dict) -> bool:
    """The HTML menu (src/ui/front.ts), from the page-space button boxes playtest recorded.

    Playtest already proves the boxes don't overlap and taps land. This proves the screen
    shows it: every mode card draws its gem, and only the selected card's label and the
    selected difficulty chip are lit, so the highlight on screen matches the state.
    """
    path = d / "menu.png"
    img = Image.open(path).convert("RGB")
    dpr = geo["canvas"].get("dpr") or 1
    menu = geo.get("menu") or {}
    print(f"\n=== {path.name} {img.size} (HTML menu, dpr={dpr}) ===")

    ok = True
    modes = (menu.get("mode") or {}).get("boxes") or []
    if len(modes) != 3:
        print(f"  FAIL: expected 3 mode cards, geometry has {len(modes)}")
        return False
    for b in modes:
        gem = count_in(img, dpr, b, 0.1, 0.45, lit)
        label = count_in(img, dpr, b, 0.45, 0.72, lit)
        state = "selected" if b["selected"] else "not selected"
        print(f"mode {b['name']:8} {state:13} gem px={gem:4} lit label px={label:4}")
        if gem < 25:
            print(f"  FAIL: the '{b['name']}' card shows no gem")
            ok = False
        # A lit label is hundreds of pixels; a falling gem or a glow drifting behind the card
        # can add a few dozen, so the line sits well clear of both.
        if b["selected"] and label < 100:
            print(f"  FAIL: the selected '{b['name']}' card's label isn't lit")
            ok = False
        if not b["selected"] and label >= 100:
            print(f"  FAIL: the '{b['name']}' card looks selected but isn't")
            ok = False

    chips = (menu.get("difficulty") or {}).get("boxes") or []
    if len(chips) != 3:
        print(f"  FAIL: expected 3 difficulty chips, geometry has {len(chips)}")
        return False
    for b in chips:
        text = count_in(img, dpr, b, 0.2, 0.8, bright)
        fill = count_in(img, dpr, b, 0.15, 0.85, purple_fill)
        state = "selected" if b["selected"] else "not selected"
        print(f"difficulty {b['name']:6} {state:13} text px={text:4} fill px={fill:5}")
        # Every chip's text must show (they're all readable now, not just the selected one).
        if text < 20:
            print(f"  FAIL: the '{b['name']}' chip's label doesn't show")
            ok = False
        if b["selected"] and fill < 200:
            print(f"  FAIL: the selected '{b['name']}' chip isn't filled")
            ok = False
        if not b["selected"] and fill >= 200:
            print(f"  FAIL: the '{b['name']}' chip looks selected but isn't")
            ok = False

    play = ((menu.get("play") or {}).get("boxes") or [None])[0]
    if not play or count_in(img, dpr, play, 0.25, 0.75, bright) < 40:
        print("  FAIL: PLAY NOW isn't drawn")
        ok = False
    return ok


def hue_of(c) -> int:
    h, s, v = colorsys.rgb_to_hsv(c[0] / 255, c[1] / 255, c[2] / 255)
    return int(h * 360)


def check_game(d: Path, name: str, geo: dict) -> bool:
    path = d / name
    if not path.exists():
        return True
    g = geo["game"]
    img = Image.open(path).convert("RGB")
    fr = Frame(img, geo["canvas"])
    print(f"\n=== {name} {img.size} ===")
    print(f"board {g['cols']}x{g['rows']} tile={g['tile']} at game ({g['boardX']},{g['boardY']})")

    cells = []
    for r in range(g["rows"]):
        row = []
        for c in range(g["cols"]):
            row.append(fr.patch(g["boardX"] + c * g["tile"] + g["tile"] / 2,
                                g["boardY"] + r * g["tile"] + g["tile"] / 2))
        cells.append(row)

    flat = [c for row in cells for c in row]
    # Reference the empty board panel, sampled in the padding strip beside the
    # slots. Deriving it from the cells themselves fails on a full board, where
    # the darkest cell is simply a dark gem.
    panel = fr.patch(g["boardX"] - 7, g["boardY"] + (g["rows"] * g["tile"]) / 2, r=4)
    lit = [c for c in flat if dist(c, panel) > 40]
    hues = {hue_of(c) // 30 for c in lit}
    print(f"panel=#{panel[0]:02x}{panel[1]:02x}{panel[2]:02x} "
          f"occupied={len(lit)}/{len(flat)} distinct hue buckets={len(hues)}")

    for row in cells:
        print("   " + " ".join(f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}" for c in row))

    ok = True
    if len(lit) < len(flat) * 0.95:
        print(f"  FAIL: {len(flat) - len(lit)} cells look empty on a full board")
        ok = False
    if len(hues) < 4:
        print("  FAIL: too few distinct gem colours")
        ok = False
    return ok


def main() -> int:
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "poc")
    geo_path = d / "geometry.json"
    if not geo_path.exists():
        print(f"missing {geo_path} - run: node tools/playtest.mjs <base-url>")
        return 2
    geo = json.loads(geo_path.read_text())

    ok = check_menu(d, geo)
    for name in ("game-start.png", "game-played.png"):
        ok = check_game(d, name, geo) and ok

    print("\nVISUAL", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
