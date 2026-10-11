"""Generate deterministic architectural room illustrations for the mini program.

The images are navigation aids, never evidence or a claim about the user's layout.
Run with the bundled workspace Python or any Python installation with Pillow.
"""

from __future__ import annotations

from pathlib import Path
import random

from PIL import Image, ImageDraw, PngImagePlugin


WIDTH, HEIGHT = 1200, 760
ORIGIN_X, ORIGIN_Y = 600, 188
STEP_X, STEP_Y, STEP_Z = 94, 54, 80
INK = "#6F7772"
SOFT_INK = "#A9B0AB"
PAPER = "#F7F6F2"
FLOOR = "#EEECE5"
BLUE = "#BFD6EE"
GREEN = "#C9DDD4"
WARM = "#DED3C4"
PALE = "#E7E9E5"

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "miniprogram" / "assets" / "space-illustrations"


def iso(x: float, y: float, z: float = 0) -> tuple[int, int]:
    return (
        round(ORIGIN_X + (x - y) * STEP_X),
        round(ORIGIN_Y + (x + y) * STEP_Y - z * STEP_Z),
    )


def shade(hex_color: str, amount: int) -> str:
    color = hex_color.lstrip("#")
    values = [int(color[index:index + 2], 16) for index in (0, 2, 4)]
    values = [max(0, min(255, value + amount)) for value in values]
    return "#" + "".join(f"{value:02X}" for value in values)


def polygon(draw: ImageDraw.ImageDraw, points, fill, outline=INK, width=3):
    draw.polygon(points, fill=fill)
    draw.line([*points, points[0]], fill=outline, width=width, joint="curve")


def line(draw: ImageDraw.ImageDraw, points, fill=INK, width=3):
    draw.line(points, fill=fill, width=width, joint="curve")


def box(draw: ImageDraw.ImageDraw, x, y, w, d, h, color, outline=INK):
    a, b, c, d0 = iso(x, y), iso(x + w, y), iso(x + w, y + d), iso(x, y + d)
    at, bt, ct, dt = iso(x, y, h), iso(x + w, y, h), iso(x + w, y + d, h), iso(x, y + d, h)
    polygon(draw, [d0, c, ct, dt], shade(color, -12), outline)
    polygon(draw, [b, c, ct, bt], shade(color, -24), outline)
    polygon(draw, [at, bt, ct, dt], color, outline)


def floor_and_walls(draw: ImageDraw.ImageDraw):
    a, b, c, d = iso(0, 0), iso(5, 0), iso(5, 4), iso(0, 4)
    at, bt, dt = iso(0, 0, 2.45), iso(5, 0, 2.45), iso(0, 4, 2.45)
    polygon(draw, [at, bt, b, a], "#F1F3F0", SOFT_INK, 3)
    polygon(draw, [at, dt, d, a], "#ECEFEB", SOFT_INK, 3)
    polygon(draw, [a, b, c, d], FLOOR, INK, 4)
    line(draw, [iso(0, -0.22), iso(5, -0.22)], "#C9CECA", 2)
    line(draw, [iso(-0.22, 0), iso(-0.22, 4)], "#C9CECA", 2)
    for x in range(1, 5):
        line(draw, [iso(x, 0), iso(x, 4)], "#DFE2DE", 1)
    for y in range(1, 4):
        line(draw, [iso(0, y), iso(5, y)], "#DFE2DE", 1)


def rug(draw, x, y, w, d, color="#DDE4E0"):
    polygon(draw, [iso(x, y, .02), iso(x + w, y, .02), iso(x + w, y + d, .02), iso(x, y + d, .02)], color, "#B7BFBA", 2)


def draw_living(draw):
    rug(draw, 1.25, 1.25, 2.55, 1.9, "#DDE7E4")
    box(draw, .45, .55, 2.7, .72, .42, GREEN)
    box(draw, .45, .55, 2.7, .22, 1.05, shade(GREEN, -4))
    box(draw, .45, 1.27, .55, .95, .46, GREEN)
    box(draw, 1.75, 2.0, 1.25, .78, .35, WARM)
    box(draw, 3.85, .42, .32, 2.15, .58, PALE)
    polygon(draw, [iso(3.95, .46, .78), iso(4.95, .46, .78), iso(4.95, .46, 1.62), iso(3.95, .46, 1.62)], "#E9EEF0", INK, 3)


def draw_bedroom(draw):
    rug(draw, 1.0, .65, 3.0, 2.45, "#E5E0D8")
    box(draw, 1.05, .72, 2.6, 2.05, .48, "#E7DED2")
    line(draw, [iso(1.08, 1.38, .5), iso(3.62, 1.38, .5)], "#B9AEA1", 3)
    box(draw, 1.24, .82, .82, .48, .16, "#F4F1EA")
    box(draw, 2.65, .82, .82, .48, .16, "#F4F1EA")
    box(draw, .25, .28, .72, 2.45, 2.0, WARM)
    box(draw, 3.82, 2.55, .62, .62, .55, PALE)
    polygon(draw, [iso(1.04, .68, .5), iso(3.67, .68, .5), iso(3.67, .68, 1.08), iso(1.04, .68, 1.08)], "#D6C7B7", INK, 3)


def draw_kitchen(draw):
    box(draw, .2, .25, 3.65, .68, .92, GREEN)
    box(draw, .2, .26, 1.05, .58, 2.02, shade(GREEN, 6))
    box(draw, 3.88, .25, .68, 2.85, .92, GREEN)
    sink = [iso(1.48, .38, .94), iso(2.28, .38, .94), iso(2.28, .76, .94), iso(1.48, .76, .94)]
    polygon(draw, sink, "#EAF0EE", "#87928C", 2)
    for x, y in [(2.65, .47), (3.14, .47), (2.65, .72), (3.14, .72)]:
        cx, cy = iso(x, y, .96)
        draw.ellipse((cx - 11, cy - 7, cx + 11, cy + 7), outline="#7C8580", width=2)
    box(draw, 1.3, 2.1, 2.05, .82, .88, WARM)
    polygon(draw, [iso(.35, .24, 1.2), iso(3.6, .24, 1.2), iso(3.6, .24, 1.32), iso(.35, .24, 1.32)], "#E6E2DA", INK, 2)


def draw_bathroom(draw):
    rug(draw, .25, .3, 1.75, 1.65, "#DCE8E8")
    for start, end in [((.25, .3, .05), (.25, .3, 2.15)), ((2.0, .3, .05), (2.0, .3, 2.15)), ((.25, 1.95, .05), (.25, 1.95, 2.15))]:
        line(draw, [iso(*start), iso(*end)], "#8EA8AC", 3)
    line(draw, [iso(.25, .3, 2.15), iso(2.0, .3, 2.15), iso(2.0, 1.95, 2.15), iso(.25, 1.95, 2.15)], "#A9BFC1", 2)
    box(draw, 2.55, .3, 1.65, .68, .78, BLUE)
    cx, cy = iso(3.36, .62, .81)
    draw.ellipse((cx - 35, cy - 16, cx + 35, cy + 16), fill="#F4F7F6", outline="#81908A", width=3)
    polygon(draw, [iso(2.75, .28, 1.05), iso(4.0, .28, 1.05), iso(4.0, .28, 1.95), iso(2.75, .28, 1.95)], "#E8EEED", "#8B9690", 3)
    box(draw, 3.35, 2.35, .72, .78, .38, PALE)
    tcx, tcy = iso(3.72, 2.75, .42)
    draw.ellipse((tcx - 34, tcy - 18, tcx + 34, tcy + 18), fill="#F4F5F2", outline=INK, width=3)


def draw_balcony(draw):
    rug(draw, .3, .35, 4.1, 3.0, "#E7E5DC")
    box(draw, .35, .35, 1.1, .78, 1.05, PALE)
    cx, cy = iso(.9, .33, .54)
    draw.ellipse((cx - 31, cy - 31, cx + 31, cy + 31), fill="#E2E9E8", outline="#78857E", width=3)
    box(draw, 2.15, .42, 1.15, .58, .52, WARM)
    for x in (3.55, 4.15):
        box(draw, x, .58, .42, .42, .42, GREEN)
        cx, cy = iso(x + .21, .79, .88)
        for dx in (-24, 0, 24):
            line(draw, [(cx, cy + 5), (cx + dx, cy - 35)], "#789589", 3)
    line(draw, [iso(.5, 3.35, 1.72), iso(4.45, 3.35, 1.72)], "#89928D", 4)


def draw_corridor(draw):
    rug(draw, .55, .48, 3.75, 2.85, "#E4E1D8")
    box(draw, .35, .35, 2.0, .48, .72, WARM)
    box(draw, 3.68, .42, .62, 1.75, 1.78, PALE)
    box(draw, 1.42, 2.55, 1.55, .48, .48, GREEN)
    line(draw, [iso(.9, 2.0, .04), iso(2.3, 2.0, .04), iso(3.25, 2.75, .04)], "#7EA8D2", 6)


def draw_other(draw):
    rug(draw, .55, .55, 3.7, 2.75, "#E1E7E4")
    box(draw, 1.05, .65, 2.7, .72, .76, BLUE)
    box(draw, .35, .35, .55, 2.5, 1.72, PALE)
    box(draw, 3.45, 2.45, .65, .65, .46, WARM)
    polygon(draw, [iso(1.25, .24, 1.05), iso(3.5, .24, 1.05), iso(3.5, .24, 1.92), iso(1.25, .24, 1.92)], "#E6DFD2", INK, 3)


DRAWERS = {
    "living-room": draw_living,
    "bedroom": draw_bedroom,
    "kitchen": draw_kitchen,
    "bathroom": draw_bathroom,
    "balcony": draw_balcony,
    "corridor": draw_corridor,
    "other": draw_other,
}


def make_background() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(image)
    for x in range(0, WIDTH, 40):
        draw.line((x, 0, x, HEIGHT), fill="#EFEEE9", width=1)
    for y in range(0, HEIGHT, 40):
        draw.line((0, y, WIDTH, y), fill="#EFEEE9", width=1)
    random.seed(20261011)
    for _ in range(620):
        x, y = random.randrange(WIDTH), random.randrange(HEIGHT)
        draw.point((x, y), fill=random.choice(("#ECEBE6", "#F0EFEA", "#E9E8E3")))
    return image


def render(name: str, drawer):
    image = make_background()
    draw = ImageDraw.Draw(image)
    floor_and_walls(draw)
    drawer(draw)
    line(draw, [(90, 690), (390, 690)], "#C8CECA", 2)
    line(draw, [(810, 84), (1110, 84)], "#C8CECA", 2)
    info = PngImagePlugin.PngInfo()
    info.add_text("Description", "Deterministic space illustration; not a real floor plan or evidence.")
    image.save(OUTPUT / f"{name}.png", optimize=True, pnginfo=info)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, drawer in DRAWERS.items():
        render(name, drawer)
    print(f"generated {len(DRAWERS)} illustrations in {OUTPUT}")


if __name__ == "__main__":
    main()
