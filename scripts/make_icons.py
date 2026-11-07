#!/usr/bin/env python3
"""Generate the extension icons with only the Python standard library.

Run from the repo root:  python3 scripts/make_icons.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "frontend" / "icons"
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def rounded_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def point_in_triangle(px: float, py: float, ax: float, ay: float, bx: float, by: float, cx: float, cy: float) -> bool:
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def near_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float, thickness: float) -> bool:
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return (px - ax) ** 2 + (py - ay) ** 2 <= (thickness / 2) ** 2
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    cx, cy = ax + t * dx, ay + t * dy
    return (px - cx) ** 2 + (py - cy) ** 2 <= (thickness / 2) ** 2


def sample(x: float, y: float) -> tuple[float, float, float, float]:
    """Return straight RGBA in 0..255 for a point in the unit square."""
    if not rounded_rect(x, y, 0.02, 0.02, 0.98, 0.98, 0.23):
        return (0.0, 0.0, 0.0, 0.0)

    t = (x + y) / 2
    bg = (
        lerp(0x3F, 0x7A, t),
        lerp(0x74, 0x5C, t),
        lerp(0xF0, 0xF0, t),
        255.0,
    )

    bubble = rounded_rect(x, y, 0.17, 0.18, 0.83, 0.66, 0.15) or point_in_triangle(
        x, y, 0.30, 0.62, 0.24, 0.84, 0.46, 0.66
    )
    if not bubble:
        return bg

    # Letter "A" cut out of the white bubble, filled with the brand blue.
    in_a = (
        near_segment(x, y, 0.50, 0.29, 0.385, 0.58, 0.070)
        or near_segment(x, y, 0.50, 0.29, 0.615, 0.58, 0.070)
        or near_segment(x, y, 0.442, 0.485, 0.558, 0.485, 0.055)
    )
    if in_a:
        return (0x2E, 0x57, 0xC8, 255.0)
    return (255.0, 255.0, 255.0, 255.0)


def render(size: int) -> bytes:
    hi = size * SUPERSAMPLE
    rows: list[bytearray] = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px * SUPERSAMPLE + sx + 0.5) / hi
                    y = (py * SUPERSAMPLE + sy + 0.5) / hi
                    sr, sg, sb, sa = sample(x, y)
                    # Premultiply to avoid dark fringes when averaging.
                    r += sr * sa
                    g += sg * sa
                    b += sb * sa
                    a += sa
            count = SUPERSAMPLE * SUPERSAMPLE
            if a <= 0:
                row.extend((0, 0, 0, 0))
            else:
                row.extend(
                    (
                        int(round(r / a)),
                        int(round(g / a)),
                        int(round(b / a)),
                        int(round(a / count)),
                    )
                )
        rows.append(row)
    return encode_png(size, size, rows)


def encode_png(width: int, height: int, rows: list[bytearray]) -> bytes:
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon-{size}.png"
        path.write_bytes(render(size))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
