#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make-icon.py —— 从社区 logo 原图生成应用图标

源图是 1254x1254 的方形图：上半部分是圆形徽记，下半部分是「雾韵社区」文字。
桌面图标尺寸下文字完全糊掉，所以只取徽记。

徽记的实际内容边界不是正方形（宽 743、高 692，因为左右两侧的云纹比圆环更宽），
所以不能直接正方形裁切 —— 那样会左右切到云纹、或者下方切到文字。
做法是：先按实际边界紧裁，再居中贴到一块正方形黑底上，四周留白由留白量控制。

背景保持不透明纯黑（不做圆形遮罩）：云纹本来就伸出圆环之外，
按圆形裁会把云纹切掉；而把纯黑变透明又会连徽记内部的夜空一起抠掉。

跑法：
    python make-icon.py <源图> <输出目录>
产出：
    icon.ico            多尺寸（16~256），electron-builder 用
    icon.png            512x512，界面与 mac/Linux 打包用
    icon-256.png        256x256
    icon-128.png        128x128，标题栏用
"""

import sys
from pathlib import Path

from PIL import Image

# 徽记在源图中的实际内容边界（由内容扫描得到，见 README 说明）
EMBLEM_BOX = (254, 179, 997, 871)  # left, top, right, bottom

# 正方形画布相对徽记长边的留白比例。0.14 大约相当于四周 7% 的边距，
# 在任务栏小图标下既不显得挤，也不至于把徽记缩得太小。
PADDING_RATIO = 0.14

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def background_color(img: Image.Image) -> tuple:
    """取四角的中位数作为背景色，避免 JPEG 噪点造成色差。"""
    w, h = img.size
    corners = [
        img.getpixel((2, 2)),
        img.getpixel((w - 3, 2)),
        img.getpixel((2, h - 3)),
        img.getpixel((w - 3, h - 3)),
    ]
    chans = list(zip(*corners))
    return tuple(sorted(c)[len(c) // 2] for c in chans)


def build_master(src: Path) -> Image.Image:
    img = Image.open(src).convert("RGB")
    bg = background_color(img)

    emblem = img.crop(EMBLEM_BOX)
    side = int(round(max(emblem.size) * (1 + PADDING_RATIO)))

    canvas = Image.new("RGB", (side, side), bg)
    canvas.paste(emblem, ((side - emblem.width) // 2, (side - emblem.height) // 2))
    return canvas


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2

    src = Path(sys.argv[1])
    out = Path(sys.argv[2])
    if not src.exists():
        print(f"找不到源图：{src}")
        return 1
    out.mkdir(parents=True, exist_ok=True)

    master = build_master(src)

    # 从 1024 往下缩：先缩到较大尺寸再逐级缩小，边缘比一步到位更干净
    big = master.resize((1024, 1024), Image.LANCZOS)
    big.save(out / "icon.png")
    big.resize((256, 256), Image.LANCZOS).save(out / "icon-256.png")
    big.resize((128, 128), Image.LANCZOS).save(out / "icon-128.png")
    big.resize((64, 64), Image.LANCZOS).save(out / "icon-64.png")

    big.save(out / "icon.ico", format="ICO", sizes=[(s, s) for s in ICO_SIZES])

    for name in ("icon.png", "icon-256.png", "icon-128.png", "icon-64.png", "icon.ico"):
        p = out / name
        print(f"  {name:16s} {p.stat().st_size / 1024:8.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
