// 무인증 라우트가 본문을 읽기 전에 거는 크기 가드.
//
// 위젯이 이 규칙으로 서 있었고(`src/lib/widget/http.ts`), 채널톡 웹훅도 같은 것이 필요하다.
// 두 벌을 두면 한쪽만 고쳐지므로 여기 하나로 모은다. 이 모듈은 응답을 만들지 않는다 —
// 위젯은 CORS 헤더가 붙은 JSON 을, 채널톡은 그렇지 않은 것을 돌려주기 때문이다.
// 판정만 하고 문구·헤더는 호출부가 정한다.

/** 위젯이 쓰던 값. 마스킹·상한을 거친 맥락이 수 KB 라 64KB 면 넉넉하다. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export type BoundedJsonFailure = 'too_large' | 'unreadable' | 'invalid_json';

export type BoundedJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: BoundedJsonFailure; status: 413 | 400 };

/**
 * 본문을 읽기 전에 크기부터 본다. `Content-Length` 는 위조·생략될 수 있으므로
 * 실제로 읽은 길이도 함께 확인한다.
 *
 * 두 검사의 단위가 **바이트로 같다.** 처음 옮겨 왔을 때는 읽은 뒤 비교가 문자 수였는데
 * (위젯의 기존 동작), 한글 본문이면 UTF-8 로 문자당 3바이트라 실제 허용치가 상한의
 * 3배까지 열렸다. 무인증 경로에서 「64KB 로 막았다」가 사실이 아니게 되므로 닫았다.
 * 선언값을 믿고 넘긴 뒤 실제 바이트로 다시 재는 순서는 그대로다.
 */
export async function readBoundedJson<T>(
  req: Request,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): Promise<BoundedJsonResult<T>> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'too_large', status: 413 };
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, reason: 'unreadable', status: 400 };
  }

  // 문자 수가 아니라 실제 바이트로 잰다 — 한글 한 글자가 3바이트라 단위를 섞으면
  // 상한이 상한이 아니게 된다.
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    return { ok: false, reason: 'too_large', status: 413 };
  }

  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, reason: 'invalid_json', status: 400 };
  }
}
