# Draws .claude-plugin/icon.png: python3 scripts/make_icon.py .claude-plugin/icon.png (needs Pillow).
import sys
from PIL import Image, ImageDraw
S = 4                      # supersampling
N = 1024
W = N * S
def s(v): return int(v * S)
DX = 36                    # centres the rows: they span 170..796 before the shift

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

# Background: rounded tile with a vertical indigo gradient.
grad = Image.new('RGBA', (W, W))
gd = ImageDraw.Draw(grad)
top, bot = (52, 70, 128), (24, 30, 64)
for y in range(W):
    t = y / (W - 1)
    gd.line([(0, y), (W, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bot)) + (255,))
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=s(224), fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
teal, amber, coral = (79, 209, 197), (246, 193, 119), (242, 139, 130)
text = (230, 233, 245)

# Three issue rows: ring bullet, title bar, label pill.
rows = [(312, teal, 600, 120), (512, amber, 540, 170), (712, coral, 640, 110)]
for cy, colour, bar_end, pill_w in rows:
    r, stroke = 62, 22
    d.ellipse([s(232 - r + DX), s(cy - r), s(232 + r + DX), s(cy + r)], outline=colour, width=s(stroke))
    d.ellipse([s(232 - 18 + DX), s(cy - 18), s(232 + 18 + DX), s(cy + 18)], fill=colour)
    d.rounded_rectangle([s(334 + DX), s(cy - 26), s(bar_end + DX), s(cy + 26)], radius=s(26), fill=text)
    px = bar_end + 32
    d.rounded_rectangle([s(px + DX), s(cy - 26), s(min(px + pill_w, 832) + DX), s(cy + 26)], radius=s(26), fill=colour)

img.resize((N, N), Image.LANCZOS).save(sys.argv[1], optimize=True)
