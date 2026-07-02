from PIL import Image, ImageDraw, ImageFont

BG = (15, 23, 42)        # #0f172a
ACCENT = (56, 189, 248)  # #38bdf8
HOLE = (15, 23, 42)

def make_icon(size, path):
    img = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(img)

    pad = size * 0.16
    tag_w = size - pad * 2
    tag_h = tag_w * 0.62
    left = pad
    top = (size - tag_h) / 2
    tip = left + tag_w * 0.28
    right = left + tag_w
    bottom = top + tag_h
    mid_y = (top + bottom) / 2

    points = [
        (tip, top),
        (right - tag_h * 0.18, top),
        (right, mid_y),
        (right - tag_h * 0.18, bottom),
        (tip, bottom),
        (left, mid_y),
    ]
    draw.polygon(points, fill=ACCENT)

    hole_r = tag_h * 0.11
    hole_cx = tip + tag_h * 0.28
    hole_cy = mid_y
    draw.ellipse(
        [hole_cx - hole_r, hole_cy - hole_r, hole_cx + hole_r, hole_cy + hole_r],
        fill=HOLE,
    )

    font_size = int(tag_h * 0.42)
    try:
        font = ImageFont.truetype("segoeuib.ttf", font_size)
    except Exception:
        font = ImageFont.load_default()

    text = "TI"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    text_x = hole_cx + hole_r * 2.4
    text_y = mid_y - th / 2 - bbox[1]
    draw.text((text_x, text_y), text, fill=BG, font=font)

    img.save(path, "PNG")

make_icon(192, "icon-192.png")
make_icon(512, "icon-512.png")
print("icons generated")
