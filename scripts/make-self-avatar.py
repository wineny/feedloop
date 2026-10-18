#!/usr/bin/env python3
"""Feedloop 자기 위젯 프로필 사진 만들기.

    python3 scripts/make-self-avatar.py <원본 사진> [--focus 0.5,0.35] [--zoom 0.7] [--brightness 1.15] [--fade 0.35]

원본에서 얼굴 중심(--focus: 가로,세로 비율)으로 정사각 크롭(--zoom: 짧은 변 대비 크롭 변 비율) → 밝기 보정(--brightness) → 가장자리를 흰색으로 부드럽게(--fade: 반지름 대비 페이드 폭, 원형 버튼의 흰 링과 이어진다) → 384px JPEG → public/feedloop-avatar.jpg.
위젯은 56px 원형 버튼과 28px 대화 아바타에 같은 이미지를 쓰므로 여백 없이 얼굴이 꽉 차게 자른다.
결과 URL(https://ai-feedloop.vercel.app/feedloop-avatar.jpg)은 봇 설정 › 위젯 모양 › 프로필 이미지 URL 에 넣는다.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

src = Path(sys.argv[1])
focus = (0.5, 0.35)
zoom = 1.0
brightness = 1.0
fade = 0.0
if '--brightness' in sys.argv:
    brightness = float(sys.argv[sys.argv.index('--brightness') + 1])
if '--fade' in sys.argv:
    fade = float(sys.argv[sys.argv.index('--fade') + 1])
if '--zoom' in sys.argv:
    zoom = float(sys.argv[sys.argv.index('--zoom') + 1])
if '--focus' in sys.argv:
    fx, fy = sys.argv[sys.argv.index('--focus') + 1].split(',')
    focus = (float(fx), float(fy))

im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
w, h = im.size
side = int(min(w, h) * zoom)
cx, cy = int(w * focus[0]), int(h * focus[1])
left = min(max(cx - side // 2, 0), w - side)
top = min(max(cy - side // 2, 0), h - side)
out = im.crop((left, top, left + side, top + side)).resize((384, 384), Image.LANCZOS)
if brightness != 1.0:
    out = ImageEnhance.Brightness(out).enhance(brightness)
if fade > 0:
    # 원형 마스크: 중심은 사진, 바깥 fade 폭만큼 흰색으로 흐려진다. 위젯이 원형으로 자르므로 모서리는 어차피 안 보인다.
    n = 384
    mask = Image.new('L', (n, n), 0)
    r_in = int(n / 2 * (1 - fade))
    ImageDraw.Draw(mask).ellipse((n // 2 - r_in, n // 2 - r_in, n // 2 + r_in, n // 2 + r_in), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(1, int(n / 2 * fade / 2))))
    out = Image.composite(out, Image.new('RGB', (n, n), (255, 255, 255)), mask)
dest = Path(__file__).resolve().parent.parent / 'public' / 'feedloop-avatar.jpg'
out.save(dest, 'JPEG', quality=85, optimize=True)
print(f'saved {dest} ({dest.stat().st_size // 1024} KB) from {w}x{h}, crop side={side} at ({left},{top})')
