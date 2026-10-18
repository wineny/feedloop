import { describe, it, expect } from 'vitest';
import { parsePatch } from '@/components/monitor/DiffView';

// 실측 PR #8 의 patch 머리 그대로 — 줄번호가 hunk 헤더에서 이어져야 한다.
const PATCH = [
  "@@ -16,15 +16,18 @@ export const fetchCache = 'force-no-store'",
  " const includeDetail = process.env.NODE_ENV !== 'production'",
  ' ',
  ' export async function GET(request: NextRequest) {',
  '-  const visitorKey = request.cookies.get(VISITOR_KEY_COOKIE)?.value ?? null',
  '-  const userId = await resolveCouponUserId()',
  '   try {',
  '+    const visitorKey = request.cookies.get(VISITOR_KEY_COOKIE)?.value ?? null',
  '+    const userId = await resolveCouponUserId()',
  '\\ No newline at end of file',
].join('\n');

describe('parsePatch', () => {
  it('hunk 헤더에서 옛/새 줄번호를 시작해 +/-/문맥에 따라 이어 붙인다', () => {
    const lines = parsePatch(PATCH);
    expect(lines[0]).toMatchObject({ kind: 'hunk', oldNo: null, newNo: null });
    expect(lines[1]).toMatchObject({ kind: 'ctx', oldNo: 16, newNo: 16 });
    expect(lines[2]).toMatchObject({ kind: 'ctx', oldNo: 17, newNo: 17, text: '' });
    expect(lines[4]).toMatchObject({ kind: 'del', oldNo: 19, newNo: null });
    expect(lines[5]).toMatchObject({ kind: 'del', oldNo: 20, newNo: null });
    expect(lines[6]).toMatchObject({ kind: 'ctx', oldNo: 21, newNo: 19 });
    expect(lines[7]).toMatchObject({ kind: 'add', oldNo: null, newNo: 20 });
    expect(lines[8]).toMatchObject({ kind: 'add', oldNo: null, newNo: 21 });
    expect(lines[9]).toMatchObject({ kind: 'meta' });
  });

  it('접두 문자를 떼고 본문만 남긴다', () => {
    const lines = parsePatch('@@ -1 +1 @@\n-a\n+b');
    expect(lines.map((l) => l.text)).toEqual(['@@ -1 +1 @@', 'a', 'b']);
  });

  it('hunk 가 여럿이면 번호를 다시 잡는다', () => {
    const lines = parsePatch('@@ -1,1 +1,1 @@\n a\n@@ -40,1 +50,1 @@\n b');
    expect(lines[1]).toMatchObject({ oldNo: 1, newNo: 1 });
    expect(lines[3]).toMatchObject({ oldNo: 40, newNo: 50 });
  });
});
