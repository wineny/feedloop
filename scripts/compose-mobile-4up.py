#!/usr/bin/env python3
"""제출용 이미지 조립 — 기존 제출물과 같은 2240×1260(16:9) 규격으로 맞춘다.

두 가지 모드:

    # 모바일 여러 장을 가로로 붙인 합본
    python3 scripts/compose-mobile-4up.py 4up out.png a.png b.png c.png d.png \
        --labels "위젯,대화,피드백,수정 PR"

    # 데스크톱 한 장을 규격에 맞춰 줄이기(16:9 원본을 그대로 채운다)
    python3 scripts/compose-mobile-4up.py fit out.png shot.png

⚠️ sips 를 쓰지 않는다 — 리샘플링 품질이 낮아 한글이 뭉갠다(프로젝트 규칙).
원본은 항상 목표보다 «크게» 찍어 줄여 쓴다. 키우면 글자가 흐려진다.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("PIL 이 없습니다: python3 -m pip install --user Pillow")

# 기존 제출물(ex-*.png)과 같은 규격
TARGET_W, TARGET_H = 2240, 1260

# 앱의 --canvas 와 같은 값이라 프레임이 화면의 연장처럼 보인다
CANVAS = (250, 248, 247)
FRAME = (226, 220, 218)
INK = (25, 29, 27)

PAD_X, PAD_TOP = 64, 72
LABEL_GAP, LABEL_SIZE = 26, 34
RADIUS = 30

FONT_CANDIDATES = [
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    "/Library/Fonts/AppleGothic.ttf",
]


def load_font(size: int) -> ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def rounded(img: Image.Image, radius: int) -> Image.Image:
    """모서리를 깎고 헤어라인 테두리를 두른다."""
    img = img.convert("RGBA")
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (w - 1, h - 1)], radius=radius, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    ImageDraw.Draw(out).rounded_rectangle(
        [(0, 0), (w - 1, h - 1)], radius=radius, outline=FRAME + (255,), width=3
    )
    return out


def compose_4up(out_path: Path, shots: list[Path], labels: list[str]) -> None:
    if labels and len(labels) != len(shots):
        sys.exit(f"캡션 {len(labels)}개 ≠ 캡처 {len(shots)}개")

    label_band = (LABEL_GAP + LABEL_SIZE + 18) if labels else 0
    avail_h = TARGET_H - PAD_TOP - label_band - 48
    avail_w = TARGET_W - PAD_X * 2

    src = [Image.open(p) for p in shots]
    # 원본 비율을 지키며 «높이»를 맞춘다. 가로가 넘치면 폭 기준으로 다시 줄인다.
    ratio = src[0].width / src[0].height
    panel_h = avail_h
    panel_w = round(panel_h * ratio)
    gap = 36
    total = panel_w * len(src) + gap * (len(src) - 1)
    if total > avail_w:
        scale = avail_w / total
        panel_w = round(panel_w * scale)
        panel_h = round(panel_h * scale)
        gap = round(gap * scale)
        total = panel_w * len(src) + gap * (len(src) - 1)

    canvas = Image.new("RGB", (TARGET_W, TARGET_H), CANVAS)
    draw = ImageDraw.Draw(canvas)
    font = load_font(LABEL_SIZE)

    x = (TARGET_W - total) // 2
    y = PAD_TOP
    for i, im in enumerate(src):
        panel = rounded(im.resize((panel_w, panel_h), Image.LANCZOS), RADIUS)
        canvas.paste(panel, (x, y), panel)
        if labels:
            text = labels[i]
            tw = draw.textbbox((0, 0), text, font=font)[2]
            draw.text((x + (panel_w - tw) / 2, y + panel_h + LABEL_GAP), text, font=font, fill=INK)
        x += panel_w + gap

    canvas.save(out_path, "PNG", optimize=True)
    print(f"{out_path.name}  {TARGET_W}×{TARGET_H}  패널 {len(src)}개 (각 {panel_w}×{panel_h})")


def compose_fit(out_path: Path, shot: Path) -> None:
    """16:9 원본을 규격에 그대로 채운다(전면). 비율이 다르면 가운데를 잘라 맞춘다."""
    im = Image.open(shot).convert("RGB")
    target_ratio = TARGET_W / TARGET_H
    ratio = im.width / im.height
    if abs(ratio - target_ratio) > 0.001:
        if ratio > target_ratio:  # 원본이 더 넓다 → 좌우를 자른다
            new_w = round(im.height * target_ratio)
            left = (im.width - new_w) // 2
            im = im.crop((left, 0, left + new_w, im.height))
        else:  # 원본이 더 높다 → 위에서부터 남긴다(헤더가 잘리면 안 된다)
            new_h = round(im.width / target_ratio)
            im = im.crop((0, 0, im.width, new_h))
    im = im.resize((TARGET_W, TARGET_H), Image.LANCZOS)
    im.save(out_path, "PNG", optimize=True)
    print(f"{out_path.name}  {TARGET_W}×{TARGET_H}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["4up", "fit"])
    ap.add_argument("out")
    ap.add_argument("shots", nargs="+")
    ap.add_argument("--labels", default="", help="4up 전용. 쉼표로 구분한 캡션")
    args = ap.parse_args()

    out_path = Path(args.out)
    shots = [Path(s) for s in args.shots]
    for s in shots:
        if not s.exists():
            sys.exit(f"없는 파일: {s}")

    if args.mode == "4up":
        labels = [s.strip() for s in args.labels.split(",")] if args.labels else []
        compose_4up(out_path, shots, labels)
    else:
        if len(shots) != 1:
            sys.exit("fit 모드는 캡처 1장만 받습니다")
        compose_fit(out_path, shots[0])


if __name__ == "__main__":
    main()
