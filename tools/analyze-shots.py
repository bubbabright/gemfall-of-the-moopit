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
from collections import Counter
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

    def pill_spans(self, gy: float, boxes: list[dict], band: int = 10):
        """The drawn extent of each pill along a game-space row, tolerant of text inside it.

        Each pill's fill is sampled just inside its own left edge, on the centre line, where
        no label, sub-label or icon is drawn (a selected pill can carry its own colour wash, so
        one fill for the whole row doesn't hold). From the box's
        centre, the span grows sideways while columns still show that fill somewhere in a
        small vertical band, which bridges the label glyphs; a run of more than 3 columns
        without it ends the span, so neighbouring pills never merge through their gap.
        """
        _, cy = self.to_px(0, gy)
        w, h = self.img.size
        ys = [y for y in range(max(0, cy - band), min(h, cy + band + 1))]

        fills, spans = [], []
        for box in boxes:
            x0, _ = self.to_px(box["left"], gy)
            x1, _ = self.to_px(box["right"], gy)
            fill = self.patch(box["left"] + 14, gy, r=3)
            has_fill = lambda x: any(dist(self.px[x, y], fill) <= 18 for y in ys)

            mid = (x0 + x1) // 2
            left = right = mid
            miss = 0
            for x in range(mid, -1, -1):
                if has_fill(x):
                    left, miss = x, 0
                elif (miss := miss + 1) > 3:
                    break
            miss = 0
            for x in range(mid, w):
                if has_fill(x):
                    right, miss = x, 0
                elif (miss := miss + 1) > 3:
                    break
            fills.append(fill)
            spans.append([left, right])
        return fills, spans


def check_menu(d: Path, geo: dict) -> bool:
    path = d / "menu.png"
    img = Image.open(path).convert("RGB")
    fr = Frame(img, geo["canvas"])
    print(f"\n=== {path.name} {img.size} ===")
    print(f"canvas: left={geo['canvas']['left']:.1f} top={geo['canvas']['top']:.1f} "
          f"w={geo['canvas']['w']:.1f} h={geo['canvas']['h']:.1f} dpr={fr.dpr}")
    print(f"scale: {fr.sw:.4f}x{fr.sh:.4f}")

    ok = True
    for group in ("mode", "difficulty"):
        row = geo["menu"].get(group)
        if not row:
            continue
        # All pills in a picker row share a centre line; take it from the audit.
        gy = row["boxes"][0]["cy"]
        fills, spans = fr.pill_spans(gy, row["boxes"])
        spans_game = [
            (round((a / fr.dpr - fr.left) / fr.sw), round((b / fr.dpr - fr.left) / fr.sw))
            for a, b in spans
        ]
        expected = [(round(b["left"]), round(b["right"])) for b in row["boxes"]]
        shown = " ".join(f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}" for c in fills)
        print(f"{group}: fills={shown} expected={expected} visible={spans_game}")

        if len(spans_game) != len(expected):
            print(f"  FAIL: {len(expected)} pills declared but {len(spans_game)} visible")
            ok = False
            continue

        gaps = [spans_game[i + 1][0] - spans_game[i][1] for i in range(len(spans_game) - 1)]
        print(f"  visible gaps: {gaps}px (declared menu gaps: {row['gaps']})")
        if min(gaps) < 8:
            print("  FAIL: pills render as one blob (overlap)")
            ok = False
        for (a, b), (ea, eb) in zip(spans_game, expected):
            if abs(a - ea) > 12 or abs(b - eb) > 12:
                print(f"  FAIL: drawn pill [{a},{b}] is not aligned with its hit box [{ea},{eb}]")
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
