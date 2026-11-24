#!/usr/bin/env python3
"""Generate valid minimal PNG and ICO assets for Tauri v2 (`src-tauri/icons/`) using Python stdlib only."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ICONS_DIR = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"


def render_tempo_rgba(
    size: int,
    *,
    bg: tuple[int, int, int] = (79, 70, 229),
    accent: tuple[int, int, int] = (129, 140, 248),
    dot_color: tuple[int, int, int] | None = None,
) -> bytes:
    """Render a crisp rounded-square clock icon with optional recording indicator dot."""
    pixels = bytearray(size * size * 4)
    half = (size - 1) / 2.0
    corner_r = size * 0.22

    bg_r, bg_g, bg_b = bg
    accent_r, accent_g, accent_b = accent

    for y in range(size):
        for x in range(size):
            # Signed distance to rounded rectangle
            dx = abs(x - half) - (half - corner_r)
            dy = abs(y - half) - (half - corner_r)
            outside = math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - corner_r
            alpha = max(0.0, min(1.0, 0.5 - outside))
            if alpha <= 0.0:
                continue

            # Subtle vertical gradient
            t = y / max(1, size - 1)
            r = bg_r * (1.0 - 0.15 * (1.0 - t)) + accent_r * (0.15 * (1.0 - t))
            g = bg_g * (1.0 - 0.15 * (1.0 - t)) + accent_g * (0.15 * (1.0 - t))
            b = bg_b * (1.0 - 0.15 * (1.0 - t)) + accent_b * (0.15 * (1.0 - t))

            # Clock ring + hands in crisp white
            nx = (x - half) / (size * 0.5)
            ny = (y - half) / (size * 0.5)
            dist = math.hypot(nx, ny)
            ring_dist = abs(dist - 0.54) - 0.085

            # Vertical hand (12 o'clock)
            hand_up = (
                abs(nx) - 0.065
                if -0.34 <= ny <= 0.02
                else math.hypot(nx, min(abs(ny + 0.34), abs(ny - 0.02))) - 0.065
            )
            # Angled hand (~2 o'clock)
            ux, uy = 0.82, -0.57
            proj = max(0.0, min(0.28, nx * ux + ny * uy))
            hand_right = math.hypot(nx - proj * ux, ny - proj * uy) - 0.06

            shape_sdf = min(ring_dist, hand_up, hand_right)
            fg_alpha = max(0.0, min(1.0, 0.5 - shape_sdf * (size * 0.5)))

            r = r * (1.0 - fg_alpha) + 255.0 * fg_alpha
            g = g * (1.0 - fg_alpha) + 255.0 * fg_alpha
            b = b * (1.0 - fg_alpha) + 255.0 * fg_alpha

            # Optional bottom-right active dot badge for running timer state
            if dot_color is not None:
                dot_dist = math.hypot(nx - 0.52, ny - 0.52) - 0.24
                dot_alpha = max(0.0, min(1.0, 0.5 - dot_dist * (size * 0.5)))
                if dot_alpha > 0.0:
                    dr, dg, db = dot_color
                    r = r * (1.0 - dot_alpha) + dr * dot_alpha
                    g = g * (1.0 - dot_alpha) + dg * dot_alpha
                    b = b * (1.0 - dot_alpha) + db * dot_alpha

            idx = (y * size + x) * 4
            pixels[idx] = int(round(r))
            pixels[idx + 1] = int(round(g))
            pixels[idx + 2] = int(round(b))
            pixels[idx + 3] = int(round(alpha * 255.0))

    return bytes(pixels)


def encode_png(size: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw_rows = bytearray()
    stride = size * 4
    for y in range(size):
        raw_rows.append(0)  # Filter type 0 (None)
        raw_rows.extend(rgba[y * stride : (y + 1) * stride])

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw_rows), level=9))
        + chunk(b"IEND", b"")
    )


def encode_ico(images: list[tuple[int, bytes]]) -> bytes:
    """Encode PNG-compressed images inside a standard Windows ICO container."""
    header = struct.pack("<HHH", 0, 1, len(images))
    entries = bytearray()
    offset = 6 + 16 * len(images)
    payload = bytearray()
    for size, png_bytes in images:
        dim = 0 if size >= 256 else size
        entries.extend(
            struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png_bytes), offset)
        )
        payload.extend(png_bytes)
        offset += len(png_bytes)
    return header + bytes(entries) + bytes(payload)


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    rendered: dict[int, bytes] = {}
    for size in (32, 64, 128, 256):
        rendered[size] = encode_png(size, render_tempo_rgba(size))

    (ICONS_DIR / "32x32.png").write_bytes(rendered[32])
    (ICONS_DIR / "128x128.png").write_bytes(rendered[128])
    (ICONS_DIR / "128x128@2x.png").write_bytes(rendered[256])
    (ICONS_DIR / "icon.png").write_bytes(rendered[256])
    (ICONS_DIR / "icon.ico").write_bytes(
        encode_ico([(s, rendered[s]) for s in (32, 64, 128, 256)])
    )

    # Dynamic system tray state icons (32x32 PNGs):
    # - tray-idle.png: muted slate/indigo clock
    # - tray-active.png: vivid rose clock with bright amber indicator dot
    tray_idle = encode_png(
        32,
        render_tempo_rgba(
            32,
            bg=(71, 85, 105),       # Tailwind slate-600
            accent=(148, 163, 184), # slate-400
        ),
    )
    tray_active = encode_png(
        32,
        render_tempo_rgba(
            32,
            bg=(225, 29, 72),       # Tailwind rose-600
            accent=(251, 113, 133), # rose-400
            dot_color=(253, 224, 71), # yellow-300 high-contrast dot
        ),
    )
    (ICONS_DIR / "tray-idle.png").write_bytes(tray_idle)
    (ICONS_DIR / "tray-active.png").write_bytes(tray_active)

    print(f"Generated app and tray icons in {ICONS_DIR}")


if __name__ == "__main__":
    main()
