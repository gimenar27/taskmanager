"""Draws the TaskFlow app icons (peach gradient with a white check mark). Run: npm run icons"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
THEMES = {
    "": ((246, 173, 107), (231, 111, 81)),          # peach
    "-matcha": ((168, 201, 132), (104, 148, 76)),   # matcha green
}
TOP, BOTTOM = THEMES[""]
SS = 4  # draw big, then shrink, for smooth edges


def gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
    return img


def check(draw, size, scale, color, width_ratio=0.075):
    # Check mark centered in the icon; `scale` shrinks it for maskable safe zones.
    c = size / 2
    pts = [(-0.155, 0.01), (-0.045, 0.12), (0.165, -0.1)]
    pts = [(c + x * size * scale, c + y * size * scale) for x, y in pts]
    w = round(size * width_ratio * scale)
    draw.line(pts, fill=color, width=w, joint="curve")
    r = w / 2
    for x, y in (pts[0], pts[-1]):
        draw.ellipse((x - r, y - r, x + r, y + r), fill=color)


def icon(size, scale=1.0, rounded=False):
    big = size * SS
    img = gradient(big).convert("RGBA")
    # soft translucent disc behind the check
    overlay = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ring = big * 0.3 * scale
    ImageDraw.Draw(overlay).ellipse((big / 2 - ring, big / 2 - ring, big / 2 + ring, big / 2 + ring), fill=(255, 255, 255, 46))
    img = Image.alpha_composite(img, overlay)
    check(ImageDraw.Draw(img), big, scale, (255, 255, 255, 255))
    if rounded:
        mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(big * 0.22), fill=255)
        img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)


def badge(size):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    check(ImageDraw.Draw(img), big, 2.2, (255, 255, 255, 255), width_ratio=0.07)
    return img.resize((size, size), Image.LANCZOS)


def main():
    global TOP, BOTTOM
    OUT.mkdir(parents=True, exist_ok=True)
    for suffix, (TOP, BOTTOM) in THEMES.items():
        icon(192, rounded=True).save(OUT / f"icon-192{suffix}.png")
        icon(512, rounded=True).save(OUT / f"icon-512{suffix}.png")
        icon(512, scale=0.78).save(OUT / f"maskable-512{suffix}.png")
        icon(180).convert("RGB").save(OUT / f"apple-touch-icon{suffix}.png")  # iPhone rounds the corners itself
        icon(64, rounded=True).resize((32, 32), Image.LANCZOS).save(OUT / f"favicon-32{suffix}.png")
    badge(96).save(OUT / "badge-96.png")
    print("Icons written to", OUT)


if __name__ == "__main__":
    main()
