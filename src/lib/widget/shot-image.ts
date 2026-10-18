// 「화면에서 선택하기」 스크린샷 — 받은 바이트가 정말 이미지인지 판정한다 (I-55, 2026-09-25).
//
// 의존성 0 · 순수 함수. 업로드 라우트는 무인증이라 Content-Type 을 믿지 않는다 — 형식과 크기는
// 파일 머리의 매직 바이트에서 직접 읽는다. WebP(VP8·VP8L·VP8X) 와 JPEG(SOF 마커) 만 받는다.
// 가로세로를 못 읽으면 이미지가 아닌 것으로 본다(잘린 파일·위조 머리).

export const SHOT_MIMES = ['image/webp', 'image/jpeg'] as const;
export type ShotMime = (typeof SHOT_MIMES)[number];

/** 한 장 상한. 버킷 file_size_limit·테이블 CHECK 와 같은 값 */
export const MAX_SHOT_BYTES = 1024 * 1024;
/** 가로·세로 상한. 위젯은 1280 으로 줄여 보내므로 넉넉하다 */
export const MAX_SHOT_DIM = 2560;

export interface ShotImageInfo {
  mime: ShotMime;
  width: number;
  height: number;
}

function ascii(buf: Uint8Array, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && at + i < buf.length; i++) s += String.fromCharCode(buf[at + i]);
  return s;
}

function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}
function u24le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}
function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

function webpInfo(b: Uint8Array): ShotImageInfo | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    // 프레임 태그 3바이트 뒤 시작 코드 9d 01 2a, 그 뒤 14비트 가로·세로
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

function jpegInfo(b: Uint8Array): ShotImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // 채움 바이트
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 길이 없는 마커(RSTn·SOI·TEM)
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // SOF0~SOF15 (DHT c4 · JPG c8 · DAC cc 제외)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: 'image/jpeg', height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xda) return null; // 스캔 시작 전에 SOF 가 없었다
    i += 2 + len;
  }
  return null;
}

/**
 * 받은 바이트의 형식·가로세로. WebP·JPEG 가 아니거나, 크기를 못 읽거나, 상한을 넘으면 null.
 * 이유를 구분하지 않는다 — 방문자에게 돌려줄 말은 어차피 「이미지가 아니에요」 하나다.
 */
export function detectShotImage(buf: Uint8Array): ShotImageInfo | null {
  if (buf.length === 0 || buf.length > MAX_SHOT_BYTES) return null;
  const info = webpInfo(buf) ?? jpegInfo(buf);
  if (!info) return null;
  if (info.width < 1 || info.height < 1 || info.width > MAX_SHOT_DIM || info.height > MAX_SHOT_DIM) return null;
  return info;
}

export function shotExtension(mime: ShotMime): 'webp' | 'jpg' {
  return mime === 'image/webp' ? 'webp' : 'jpg';
}
