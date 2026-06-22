"""Genera icon-192.png e icon-512.png para la PWA (pin de ubicacion)."""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web"
BG = (15, 118, 110)      # teal oscuro (brand-d)
BG2 = (20, 184, 166)     # teal claro (brand)
PIN = (255, 255, 255)
DOT = (15, 118, 110)


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # fondo con esquinas redondeadas
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)
    # circulo decorativo claro
    pad = int(size * 0.5)
    # --- pin ---
    cx = size / 2
    cy = size * 0.40
    radius = size * 0.20
    # cabeza del pin (circulo)
    d.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=PIN)
    # punta del pin (triangulo)
    tip = (cx, size * 0.82)
    left = (cx - radius * 0.82, cy + radius * 0.55)
    right = (cx + radius * 0.82, cy + radius * 0.55)
    d.polygon([left, right, tip], fill=PIN)
    # punto interior
    ir = radius * 0.42
    d.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=DOT)
    return img


for s in (192, 512):
    make(s).save(OUT / f"icon-{s}.png")
    print(f"icon-{s}.png OK")
