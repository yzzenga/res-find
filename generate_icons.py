#!/usr/bin/env python3
"""Generate Res-Find extension icons (16, 48, 128)."""
from PIL import Image, ImageDraw, ImageFont
import os

COLORS = {
    'bg1': (30, 30, 45),      # dark navy
    'bg2': (50, 45, 80),      # lighter navy
    'accent': (99, 102, 241), # indigo
    'accent2': (120, 120, 255),
    'white': (220, 220, 240),
    'green': (34, 197, 94),
    'ring': (70, 72, 180),
}

def draw_radar_circle(draw, cx, cy, r, fill=None, outline=COLORS['accent'], width=1):
    """Draw a circle centered at (cx, cy)."""
    bbox = [cx - r, cy - r, cx + r, cy + r]
    draw.ellipse(bbox, fill=fill, outline=outline, width=width)

def make_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = size // 2
    r = size // 2 - 1

    # Background circle with gradient (approximate with radial rings)
    steps = 8
    for i in range(steps, 0, -1):
        t = i / steps
        sr = int(r * (i / steps))
        color = tuple(int(COLORS['bg1'][j] * (1 - t) + COLORS['bg2'][j] * t) for j in range(3))
        draw_radar_circle(draw, cx, cy, sr, fill=color + (255,), outline=None)

    # Outer ring
    ring_width = max(1, size // 16)
    draw_radar_circle(draw, cx, cy, r - ring_width // 2, outline=COLORS['ring'], width=ring_width)

    # Crosshair lines
    margin = size // 8
    line_color = COLORS['accent'] + (180,)
    draw.line([(cx, margin), (cx, size - margin)], fill=line_color, width=max(1, size // 32))
    draw.line([(margin, cy), (size - margin, cy)], fill=line_color, width=max(1, size // 32))

    # Center dot
    center_r = max(2, size // 16)
    draw_radar_circle(draw, cx, cy, center_r, fill=COLORS['accent2'] + (255,), outline=None)
    draw_radar_circle(draw, cx, cy, center_r // 2, fill=(255, 255, 255, 200), outline=None)

    # Radar sweep arc (wedge)
    if size >= 48:
        from math import pi, sin, cos
        sweep_r = int(r * 0.65)
        # Draw arc using points (approximate with polygon)
        points = [(cx, cy)]
        for angle_deg in range(-30, 61, 5):
            angle_rad = -angle_deg * pi / 180
            px = cx + sweep_r * cos(angle_rad)
            py = cy + sweep_r * sin(angle_rad)
            points.append((px, py))
        draw.polygon(points, fill=COLORS['green'] + (60,), outline=None)

    # Small circle at sweep edge
    if size >= 48:
        from math import pi, cos, sin
        sweep_r = int(r * 0.65)
        angle_rad = 15 * pi / 180
        edge_x = cx + sweep_r * cos(angle_rad)
        edge_y = cy + sweep_r * sin(angle_rad)
        dot_r = max(1, size // 32)
        draw_radar_circle(draw, int(edge_x), int(edge_y), dot_r, fill=COLORS['green'] + (220,), outline=None)

    # Outer border
    draw_radar_circle(draw, cx, cy, r, outline=COLORS['ring'] + (100,), width=1)

    return img

if __name__ == '__main__':
    icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    for size in (16, 48, 128):
        img = make_icon(size)
        path = os.path.join(icons_dir, f'icon{size}.png')
        img.save(path, 'PNG')
        print(f'  Created {path} ({size}x{size})')

    print('Done.')
