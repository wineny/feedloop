import { describe, expect, it } from 'vitest';
import { AutoDevError, autoDevErrorCode } from '../src/lib/auto-dev/errors';
import {
  DRAFT_PROMOTED_MARKER,
  DRAFT_WAIT_MARKER,
  hasDraftWaitMarker,
  hasPromotedMarker,
} from '../src/lib/auto-dev/draft-markers';
import { failureMessage, failureReasonText } from '../src/lib/llm/key';
import { personLabel } from '../src/lib/channel/labels';

describe('AutoDevError code', () => {
  it('판정은 문구가 아니라 code 로 한다', () => {
    expect(autoDevErrorCode(new AutoDevError('no_files', 'any text'))).toBe('no_files');
    expect(autoDevErrorCode(new AutoDevError('missing_target', 'x'))).toBe('missing_target');
  });
  it('같은 한국어 문구라도 일반 Error 는 코드가 없다', () => {
    expect(autoDevErrorCode(new Error('AI 응답에 수정할 파일이 없습니다'))).toBeNull();
    expect(autoDevErrorCode('수정 대상 또는 저장소 URL')).toBeNull();
  });
});

describe('draft markers', () => {
  it('새 마커와 옛 한국어 문구를 둘 다 인식한다', () => {
    expect(hasDraftWaitMarker(`본문\n${DRAFT_WAIT_MARKER}\n`)).toBe(true);
    expect(hasDraftWaitMarker('본문\n\n## 자동 검사 대기\n...')).toBe(true);
    expect(hasDraftWaitMarker('본문만')).toBe(false);
    expect(hasDraftWaitMarker(null)).toBe(false);
  });
  it('전환 완료 댓글도 새 마커와 옛 문구를 둘 다 인식한다', () => {
    expect(hasPromotedMarker(`${DRAFT_PROMOTED_MARKER}\nanything`)).toBe(true);
    expect(hasPromotedMarker('자동 검사를 통과해 검토 요청으로 바꿨습니다')).toBe(true);
    expect(hasPromotedMarker('자동 검사 판정을 마쳐 검토 요청으로 전환합니다.')).toBe(false);
  });
});

describe('LLM failure reason', () => {
  it.each(['key_rejected', 'model_invalid', 'quota', 'connection'] as const)('코드 %s 를 문장으로 바꾼다', (kind) => {
    expect(failureReasonText(kind, 'm-1')).toBe(failureMessage(kind, 'm-1'));
  });
  it('옛 문장·NULL 은 그대로 돌려준다', () => {
    expect(failureReasonText('키가 거부됐어요')).toBe('키가 거부됐어요');
    expect(failureReasonText(null)).toBeNull();
  });
});

describe('author_name NULL fallback', () => {
  it('출처별 호칭을 고른다', () => {
    expect(personLabel('web')).toBe('방문자');
    expect(personLabel('kakao')).toBe('카카오 사용자');
    expect(personLabel('channel')).toBe('채널톡 이용자');
  });
});
