"""Generate DropPad PWA icons: a cyan->emerald gradient rounded tile with a white droplet glyph."""
from PIL import Image, ImageDraw

CYAN = (34, 211, 238)
EMERALD = (52, 211, 153)
C1 = (14, 116, 144)   # cyan-dim (top)
C2 = (5, 150, 105)    # emerald-dim (bottom)
WHITE = (255, 255, 255, 255)


def gradient_square(size):
    img = Image.new('RGBA', (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(C1[0] + (C2[0] - C1[0]) * t)
        g = int(C1[1] + (C2[1] - C1[1]) * t)
        b = int(C1[2] + (C2[2] - C1[2]) * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_drop(draw, size):
    r = size * 0.30
    cx = size / 2
    cy = size / 2
    circ_cy = cy + r * 0.45
    circ_r = r * 0.78
    apex_y = cy - r * 1.05
    # triangle (apex + base at circle center height)
    base_y = circ_cy
    half_w = circ_r * 0.96
    draw.polygon([(cx, apex_y), (cx - half_w, base_y), (cx + half_w, base_y)], fill=WHITE)
    draw.ellipse([cx - circ_r, circ_cy - circ_r, cx + circ_r, circ_cy + circ_r], fill=WHITE)


def make_icon(size, radius, out):
    grad = gradient_square(size)
    if radius > 0:
        mask = rounded_mask(size, radius)
        tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        tile.paste(grad, (0, 0), mask)
    else:
        tile = grad
    d = ImageDraw.Draw(tile)
    draw_drop(d, size)
    tile.save(out, 'PNG')
    print('wrote', out, tile.size)


make_icon(512, int(512 * 0.22), 'icons/icon-512.png')
# 192 downscaled from 512 for crispness
Image.open('icons/icon-512.png').resize((192, 192), Image.LANCZOS).save('icons/icon-192.png', 'PNG')
print('wrote icons/icon-192.png')
# maskable: full-bleed, smaller glyph within safe zone
make_icon(512, 0, 'icons/icon-maskable-512.png')
print('done')
