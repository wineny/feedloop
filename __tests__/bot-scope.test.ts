import { describe, expect, it } from 'vitest';
import {
  carryQuery,
  resolveScope,
  routeBotSegment,
  scopedBody,
  scopedUrl,
  swapRouteBot,
  type ScopeBot,
} from '@/lib/scope/scope';

const bots: ScopeBot[] = [
  { id: 'a', service_name: 'A', widget_connected_at: null, channel_connected_at: null },
  { id: 'b', service_name: 'B', widget_connected_at: null, channel_connected_at: null },
];

describe('resolveScope — 저장된 선택이 지금 목록에 있을 때만 유효하다', () => {
  it('목록에 있는 id 는 그대로', () => {
    expect(resolveScope('b', bots)).toBe('b');
  });

  it('삭제됐거나 남의 봇 id 면 전체(null)로 떨어진다 — 그대로 실으면 403 이 화면에 샌다', () => {
    expect(resolveScope('deleted', bots)).toBeNull();
    expect(resolveScope('a', [])).toBeNull();
  });

  it('저장값이 없으면 전체', () => {
    expect(resolveScope(null, bots)).toBeNull();
    expect(resolveScope(undefined, bots)).toBeNull();
    expect(resolveScope('', bots)).toBeNull();
  });
});

describe('scopedUrl / scopedBody — 전체면 원본 그대로, 아니면 botId 를 싣는다', () => {
  it('전체(null)는 주소·본문을 건드리지 않는다', () => {
    expect(scopedUrl('/api/inbox', null)).toBe('/api/inbox');
    const body = { x: 1 };
    expect(scopedBody(body, null)).toBe(body);
  });

  it('쿼리가 없으면 ? 로, 있으면 & 로 잇고 값은 인코딩한다', () => {
    expect(scopedUrl('/api/inbox', 'a b')).toBe('/api/inbox?botId=a%20b');
    expect(scopedUrl('/api/classify?category=bug', 'a')).toBe('/api/classify?category=bug&botId=a');
  });

  it('본문에는 다른 라우트와 같은 이름(botId)으로 얹는다', () => {
    expect(scopedBody({}, 'a')).toEqual({ botId: 'a' });
    expect(scopedBody({ groupId: 'g' }, 'a')).toEqual({ groupId: 'g', botId: 'a' });
  });
});

describe('routeBotSegment — 주소가 한 서비스를 가리키는 화면인가', () => {
  it('`/bots/<id>/<하위화면>` 이면 봇과 하위 경로를 돌려준다', () => {
    expect(routeBotSegment('/bots/b/knowledge', bots)).toEqual({ botId: 'b', sub: 'knowledge' });
    expect(routeBotSegment('/bots/a/connect', bots)).toEqual({ botId: 'a', sub: 'connect' });
  });

  it('목록에 없는 id 는 인정하지 않는다 — `/bots/new` 가 봇으로 읽히면 안 된다', () => {
    expect(routeBotSegment('/bots/new', bots)).toBeNull();
    expect(routeBotSegment('/bots/deleted/knowledge', bots)).toBeNull();
  });

  it('하위 화면이 없거나 다른 탭이면 null — 범위 셀렉터가 이동 셀렉터로 둔갑하지 않는다', () => {
    expect(routeBotSegment('/bots', bots)).toBeNull();
    expect(routeBotSegment('/bots/a', bots)).toBeNull();
    expect(routeBotSegment('/dashboard', bots)).toBeNull();
    expect(routeBotSegment('/inbox/a/knowledge', bots)).toBeNull();
  });
});

describe('swapRouteBot — 같은 하위 화면을 다른 서비스로', () => {
  it('쿼리는 그대로 들고 간다 — `?tab=github` 에서 고르면 그 탭 그대로 열린다', () => {
    expect(swapRouteBot('knowledge', 'b', '?tab=github')).toBe('/bots/b/knowledge?tab=github');
  });

  it('쿼리가 없으면 경로만', () => {
    expect(swapRouteBot('appearance', 'a')).toBe('/bots/a/appearance');
  });
});

describe('carryQuery — 서비스를 바꿔 옮길 때 무엇을 들고 가나', () => {
  it('답변 지식의 탭은 들고 간다 — 세 탭이 모든 봇에 있어 다른 서비스에서도 참말이다', () => {
    expect(carryQuery('knowledge', '?tab=github')).toBe('?tab=github');
    expect(carryQuery('knowledge', '?tab=key')).toBe('?tab=key');
  });

  it('연결 화면의 쿼리는 두고 간다 — `via`·`tab` 은 그 서비스의 연결 «상태»에 딸린 값이다', () => {
    // 이미 붙은 서비스로 들고 가면 「이제 연결하세요」 제목이 「연결됐어요」 본문 위에 선다
    expect(carryQuery('connect', '?via=channel')).toBe('');
    expect(carryQuery('connect', '?tab=channel')).toBe('');
    expect(carryQuery('appearance', '?anything=1')).toBe('');
  });

  it('쿼리가 없거나 tab 이 없으면 빈 문자열', () => {
    expect(carryQuery('knowledge', '')).toBe('');
    expect(carryQuery('knowledge', '?other=1')).toBe('');
  });

  it('값은 인코딩한다 — 주소에 그대로 이어 붙이는 문자열이다', () => {
    expect(carryQuery('knowledge', '?tab=a%20b')).toBe('?tab=a%20b');
    expect(carryQuery('knowledge', '?tab=' + encodeURIComponent('x&y=1'))).toBe('?tab=x%26y%3D1');
  });

  it('`swapRouteBot` 과 이어 붙였을 때 실제로 열리는 주소', () => {
    expect(swapRouteBot('knowledge', 'b', carryQuery('knowledge', '?tab=github'))).toBe(
      '/bots/b/knowledge?tab=github',
    );
    expect(swapRouteBot('connect', 'b', carryQuery('connect', '?via=channel'))).toBe('/bots/b/connect');
  });
});
