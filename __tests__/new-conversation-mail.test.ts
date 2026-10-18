// 새 대화 알림 발송기 — 첫 메시지 판정·봇당 상한·템플릿.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ ok: true as const, id: 'pm-1' })),
  tables: {} as Record<string, { rows?: unknown[]; count?: number; error?: { message: string } | null }>,
}));

/** 테이블별 응답을 미리 넣어 두는 아주 작은 supabase 더블. select(head+count) 는 count 를 돌려준다. */
function chainFor(table: string): Record<string, unknown> {
  const t = h.tables[table] ?? {};
  const chain: Record<string, unknown> = {};
  let headCount = false;
  chain.select = vi.fn((_cols?: string, opts?: { head?: boolean; count?: string }) => { headCount = Boolean(opts?.head); return chain; });
  for (const m of ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'order', 'limit', 'not']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data: (t.rows ?? [])[0] ?? null, error: t.error ?? null }));
  chain.then = (resolve: (v: unknown) => void) =>
    resolve(headCount ? { count: t.count ?? 0, error: t.error ?? null } : { data: t.rows ?? [], error: t.error ?? null });
  return chain;
}

vi.mock('@/lib/supabase', () => ({ getServiceRoleClient: () => ({ from: (table: string) => chainFor(table) }) }));
vi.mock('@/lib/email/postmark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/postmark')>()),
  isEmailConfigured: () => true,
  sendEmail: h.sendEmail,
}));

import {
  NEW_CONVERSATION_MAIL_HOURLY_CAP,
  emailOwnerNewConversation,
  newConversationMailAllowed,
  pickFirstRealMessageId,
} from '@/lib/email/notify';
import { renderNewConversationEmail } from '@/lib/email/templates';
import { CHIP_ONLY_LABELS } from '@/lib/widget/chips';

const CHIP = CHIP_ONLY_LABELS[0];

describe('첫 진짜 메시지 고르기', () => {
  it('칩만 누른 턴은 건너뛰고 처음 적은 말을 고른다', () => {
    expect(pickFirstRealMessageId([{ id: 'a', body: CHIP }, { id: 'b', body: '다크 모드요' }, { id: 'c', body: '그리고요' }])).toBe('b');
  });
  it('전부 칩이면 없다', () => {
    expect(pickFirstRealMessageId([{ id: 'a', body: CHIP }])).toBeNull();
  });
});

describe('봇당 시간당 상한', () => {
  it('상한 안쪽(자기 포함)이면 보내고, 넘으면 안 보낸다', () => {
    expect(newConversationMailAllowed(1)).toBe(true);
    expect(newConversationMailAllowed(NEW_CONVERSATION_MAIL_HOURLY_CAP)).toBe(true);
    expect(newConversationMailAllowed(NEW_CONVERSATION_MAIL_HOURLY_CAP + 1)).toBe(false);
  });
});

describe('템플릿', () => {
  const vars = {
    serviceName: 'Feedloop', visitorLabel: '방문자 #62e8', visitorEmail: null,
    firstMessage: '설치하는 데 정말 5분이면 되나요? 그리고 카카오톡도 붙일 수 있나요?',
    pageUrl: 'https://ai-feedloop.vercel.app/', inboxUrl: 'https://ai-feedloop.vercel.app/inbox?c=conv-1',
    receivedAt: new Date('2026-09-23T00:11:46Z'),
  };
  it('제목에 서비스·방문자·첫 메시지 조각(자름)을 싣는다', () => {
    const r = renderNewConversationEmail(vars);
    expect(r.subject).toBe('[Feedloop] 새 대화 · 방문자 #62e8 「설치하는 데 정말 5분이면 되나요? 그리고 카카오톡…」');
  });
  it('본문엔 첫 메시지만 있고 「한 번만」 이 명시된다 — 최근 대화·AI 요약은 없다', () => {
    const r = renderNewConversationEmail(vars);
    expect(r.html).toContain('설치하는 데 정말 5분이면 되나요?');
    expect(r.html).toContain('한 번만');
    expect(r.html).not.toContain('최근 대화');
    expect(r.html).not.toContain('AI 요약');
    expect(r.html).toContain('href="https://ai-feedloop.vercel.app/inbox?c=conv-1"');
    expect(r.text).toContain('[처음 남긴 말]');
    expect(r.text).toContain('아직 남기지 않음');
  });
});

describe('발송기', () => {
  beforeEach(() => {
    h.sendEmail.mockClear();
    h.tables = {
      messages: { rows: [{ id: 'm1', body: CHIP }, { id: 'm2', body: '설치 5분 맞나요?' }] },
      conversations: {
        rows: [{ contact_name: null, contact_email: null, external_user_id: '62e8f462-b16b-4efa-a4c1-099660c50044', created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() }],
        count: 1,
      },
      bots: { rows: [{ service_name: 'Feedloop', user_id: 'u1' }] },
      users: { rows: [{ email: 'owner@example.com' }] },
    };
  });

  it('첫 진짜 메시지면 소유자에게 한 통 보낸다', async () => {
    const out = await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm2', firstMessage: '설치 5분 맞나요?' });
    expect(out).toEqual({ sent: true, to: 'owner@example.com' });
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const sent = (h.sendEmail.mock.calls[0] as unknown[])[0] as { tag: string; subject: string; to: string };
    expect(sent.tag).toBe('new-conversation');
    expect(sent.subject).toContain('새 대화');
    expect(sent.subject).toContain('설치 5분 맞나요?');
  });

  it('첫 메시지가 아니면(DB 기준) 보내지 않는다 — 라우트 사전 판정이 틀려도 여기서 막는다', async () => {
    const out = await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm3', firstMessage: '그리고요' });
    expect(out).toEqual({ sent: false, reason: 'not_first' });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('칩만 누른 턴을 첫 메시지로 오인하지 않는다', async () => {
    const out = await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm1', firstMessage: CHIP });
    expect(out).toEqual({ sent: false, reason: 'not_first' });
  });

  it('한 시간에 열린 대화가 상한을 넘으면 조용히 건너뛴다', async () => {
    h.tables.conversations.count = NEW_CONVERSATION_MAIL_HOURLY_CAP + 1;
    const out = await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm2', firstMessage: '설치 5분 맞나요?' });
    expect(out).toEqual({ sent: false, reason: 'rate_limited' });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('대화가 한 시간보다 전에 열렸으면 보내지 않는다 — 미리 쌓아 뒀다 몰아 보내는 우회를 막는다', async () => {
    h.tables.conversations.rows = [{ contact_name: null, contact_email: null, external_user_id: '62e8f462', created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }];
    const out = await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm2', firstMessage: '설치 5분 맞나요?' });
    expect(out).toEqual({ sent: false, reason: 'stale_conversation' });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('첫 메시지의 줄바꿈은 본문에 살아남는다', async () => {
    h.tables.messages.rows = [{ id: 'm2', body: '첫 줄\n둘째 줄' }];
    await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm2', firstMessage: '첫 줄\n둘째 줄' });
    const sent = (h.sendEmail.mock.calls[0] as unknown[])[0] as { text: string; html: string };
    expect(sent.text).toContain('첫 줄\n둘째 줄');
    expect(sent.html).toContain('첫 줄<br />둘째 줄');
  });

  it('소유자 이메일이 없으면 보내지 않는다', async () => {
    h.tables.users = { rows: [] };
    const out = await emailOwnerNewConversation({ botId: 'b1', conversationId: 'c1', messageId: 'm2', firstMessage: '설치 5분 맞나요?' });
    expect(out).toEqual({ sent: false, reason: 'no_owner_email' });
  });
});
