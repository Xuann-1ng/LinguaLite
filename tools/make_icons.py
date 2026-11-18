"""生成轻译插件图标：蓝色渐变圆角方块 + 白色气泡 + 三条文本行。纯标准库实现。"""
import zlib, struct, math, os

BASE = 128.0
C1 = (46, 124, 246)   # 上
C2 = (23, 92, 208)    # 下


def in_round_rect(px, py, x0, y0, x1, y1, r):
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return math.hypot(px - cx, py - cy) <= r


def in_triangle(px, py, a, b, c):
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])
    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def gradient(y):
    t = min(max(y / BASE, 0.0), 1.0)
    return tuple(int(round(C1[i] + (C2[i] - C1[i]) * t)) for i in range(3))


def sample(px, py):
    """返回 (r,g,b,a)"""
    if not in_round_rect(px, py, 1, 1, 127, 127, 30):
        return (0, 0, 0, 0)
    bg = gradient(py)
    # 气泡主体
    in_bubble = in_round_rect(px, py, 24, 30, 104, 88, 18)
    # 气泡小尾巴
    in_tail = in_triangle(px, py, (42, 84), (39, 105), (64, 84))
    if in_bubble or in_tail:
        # 气泡里的三条“文字”线，用背景色挖空
        lines = [
            (38, 44, 90, 51),
            (38, 58, 90, 65),
            (38, 72, 74, 79),
        ]
        for x0, y0, x1, y1 in lines:
            if in_round_rect(px, py, x0, y0, x1, y1, 3.5):
                return (bg[0], bg[1], bg[2], 255)
        return (255, 255, 255, 255)
    return (bg[0], bg[1], bg[2], 255)


def render(size, ss=4):
    S = size * ss
    scale = BASE / S
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px = (x * ss + sx + 0.5) * scale
                    py = (y * ss + sy + 0.5) * scale
                    r, g, b, a = sample(px, py)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            a_sum = acc[3]
            if a_sum == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((
                    int(round(acc[0] / a_sum)),
                    int(round(acc[1] / a_sum)),
                    int(round(acc[2] / a_sum)),
                    int(round(a_sum / n)),
                ))
        rows.append(row)
    return rows


def write_png(path, rows):
    h = len(rows)
    w = len(rows[0])
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for px in row:
            raw.extend(px)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print('wrote', path, w, 'x', h, os.path.getsize(path), 'bytes')


out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
os.makedirs(out, exist_ok=True)
for s in (16, 32, 48, 128):
    write_png(os.path.join(out, 'icon%d.png' % s), render(s))
