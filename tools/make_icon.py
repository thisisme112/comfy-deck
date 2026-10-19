"""Generate the application icon from the web favicon geometry."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "installer" / "comfydeck.ico"

BG = (22, 24, 27, 255)
FG = (198, 222, 76, 255)
SIZE = 1024
UNIT = SIZE / 24


def draw() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=round(5 * UNIT), fill=BG
    )
    outer = [round(5 * UNIT), round(5 * UNIT), round(19 * UNIT), round(19 * UNIT)]
    width = round(2 * UNIT)
    draw.rectangle(outer, outline=FG, width=width)
    inner = max(width // 2, round(1.6 * UNIT))
    mid = round(12 * UNIT)
    draw.line([outer[0], mid, mid, mid], fill=FG, width=inner)
    draw.line([mid, outer[1], mid, mid], fill=FG, width=inner)
    draw.line([mid, mid, mid, outer[3]], fill=FG, width=inner)
    return img


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    image = draw()
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    image.save(OUT, format="ICO", sizes=sizes)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
