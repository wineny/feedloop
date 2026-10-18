'use client';

// 봇 설정 › 답변 지식 — 운영자가 봇에게 알려줄 내용을 넣는 곳.
//
// 여기 넣은 것이 시스템 프롬프트에 «통째로» 실린다. 검색(RAG)이 없다.
// 그래서 화면이 "프롬프트에 실리는 크기"를 계속 보여준다 — 이 숫자가 곧
// 호출 1건의 비용이고, 상한이 왜 있는지를 운영자가 눈으로 알게 하는 유일한 자리다.
//
// 모델을 불러보는 미리보기는 없다. 저장할 때마다 돈이 나가면 안 된다.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, Loader2, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionTitle } from '@/components/layout/SectionTitle';
import { KNOWLEDGE_LIMITS, knowledgeSize, type FaqItem } from '@/lib/bot/knowledge';
import { HOLDING_MESSAGE } from '@/lib/bot/holding';

interface KnowledgeFormProps {
  botId: string;
  serviceName: string;
  initial: { knowledge_text: string | null; knowledge_faq: FaqItem[] };
}

type Status = { kind: 'ok' | 'error'; message: string } | null;

/**
 * 초안 상태와 저장을 한 곳에 모은다.
 * (컴포넌트에 useState 를 늘어놓지 않기 위한 추출 — 화면은 그리기만 한다)
 */
function useKnowledgeDraft(botId: string, initial: KnowledgeFormProps['initial']) {
  const [text, setText] = useState(initial.knowledge_text ?? '');
  const [faq, setFaq] = useState<FaqItem[]>(initial.knowledge_faq);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const addFaq = () => setFaq((prev) => [...prev, { q: '', a: '' }]);
  const removeFaq = (index: number) => setFaq((prev) => prev.filter((_, i) => i !== index));
  const updateFaq = (index: number, patch: Partial<FaqItem>) =>
    setFaq((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/bots/${botId}/knowledge`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // 빈 행은 서버가 버린다. 여기서 미리 지우면 반쯤 쓰다 만 행이 눈앞에서 사라진다.
        body: JSON.stringify({ knowledge_text: text, knowledge_faq: faq }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setStatus({ kind: 'error', message: (data && data.error) || '저장하지 못했습니다' });
        return;
      }
      // 봇 설정 캐시를 라우트가 바로 비운다 — 5분을 기다릴 필요가 없다.
      setStatus({ kind: 'ok', message: '저장했어요. 지금부터 이 내용으로 답합니다' });
    } catch {
      setStatus({ kind: 'error', message: '네트워크 오류로 저장하지 못했습니다' });
    } finally {
      setSaving(false);
    }
  };

  return { text, setText, faq, addFaq, removeFaq, updateFaq, saving, status, save };
}

export function KnowledgeForm({ botId, serviceName, initial }: KnowledgeFormProps) {
  const draft = useKnowledgeDraft(botId, initial);
  const { text, faq } = draft;

  const filledFaq = faq.filter((f) => f.q.trim() && f.a.trim());
  const size = knowledgeSize(text, faq);
  const textOver = text.trim().length > KNOWLEDGE_LIMITS.text;
  const faqOver = filledFaq.length > KNOWLEDGE_LIMITS.faqItems;
  const blocked = textOver || faqOver || draft.saving;
  const isEmpty = text.trim().length === 0 && filledFaq.length === 0;

  return (
    <div className="flex max-w-[660px] flex-col gap-7">
      {isEmpty && (
        <p className="border-l-2 border-border-strong pl-3 text-[13px] leading-relaxed text-muted-foreground">
          지식이 비어 있는 동안 봇은 사실 질문(정책·가격·수량 같은 것)에 답하지 않고
          &ldquo;{HOLDING_MESSAGE}&rdquo;로 넘깁니다. 피드백에는 평소처럼 답해요. 여기에
          지식을 넣으면 그 범위 안에서 바로 답합니다.
        </p>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          {/* 섹션 제목이면서 textarea 의 label 이다 — SectionTitle(h2)로 바꾸면 htmlFor 연결이 끊긴다 */}
          <label htmlFor="knowledge-text" className="text-lg font-bold tracking-[-0.015em]">
            알려줄 내용
          </label>
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              textOver ? 'font-semibold text-destructive' : 'text-faint',
            )}
          >
            {text.trim().length.toLocaleString('ko-KR')} / {KNOWLEDGE_LIMITS.text.toLocaleString('ko-KR')}자
          </span>
        </div>
        <Textarea
          id="knowledge-text"
          rows={14}
          value={text}
          onChange={(e) => draft.setText(e.target.value)}
          placeholder={`${serviceName}에 대해 봇이 알아야 할 것을 그대로 붙여넣으세요. 이용 안내, 요금, 배송·환불 규정, 자주 나오는 상황 같은 것들이요.`}
          className="resize-y leading-relaxed"
        />
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          노션이나 README 에 이미 쓴 글을 그대로 붙여넣어도 됩니다. 여기 없는 내용은 봇이
          지어내지 않고 &ldquo;{HOLDING_MESSAGE}&rdquo;로 넘깁니다.
        </p>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <SectionTitle>자주 묻는 질문</SectionTitle>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              질문과 답을 나눠 적으면 봇이 훨씬 잘 찾아냅니다.
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              faqOver ? 'font-semibold text-destructive' : 'text-faint',
            )}
          >
            {filledFaq.length} / {KNOWLEDGE_LIMITS.faqItems}개
          </span>
        </div>

        {faq.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            아직 없습니다. 아래에서 첫 항목을 추가하세요.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {faq.map((item, i) => (
              <li key={i} className={cn('flex flex-col gap-2', i > 0 && 'border-t border-border pt-4')}>
                <div className="flex items-start gap-2">
                  <Input
                    value={item.q}
                    onChange={(e) => draft.updateFaq(i, { q: e.target.value })}
                    placeholder="예: 환불은 언제까지 되나요?"
                    maxLength={KNOWLEDGE_LIMITS.faqQuestion}
                    aria-label={`질문 ${i + 1}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => draft.removeFaq(i)}
                    aria-label={`질문 ${i + 1} 삭제`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <Textarea
                  rows={3}
                  value={item.a}
                  onChange={(e) => draft.updateFaq(i, { a: e.target.value })}
                  placeholder="봇이 이렇게 답하면 좋겠다 싶은 내용을 적으세요."
                  maxLength={KNOWLEDGE_LIMITS.faqAnswer}
                  className="resize-none"
                  aria-label={`답변 ${i + 1}`}
                />
              </li>
            ))}
          </ul>
        )}

        <Button type="button" variant="outline" size="sm" onClick={draft.addFaq} className="self-start">
          <Plus className="h-4 w-4" />
          항목 추가
        </Button>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-5">
        {/*
          닫거나 지울 수 없는 고정 문구다. 여기 넣은 내용은 방문자에게 답변으로 인용되는데,
          운영자는 이 화면을 "내부 메모장"으로 착각하기 쉽다 — 요금표를 붙여넣다가 원가나
          내부 정책이 딸려 들어오는 식이다. 한 번 보여주고 마는 안내로는 못 막는다.
        */}
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          여기 넣은 내용은 방문자 답변에 그대로 인용될 수 있어요. 공개해도 되는 정보만 넣어 주세요.
        </p>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">프롬프트에 실리는 크기</p>
            <p className="text-[26px] font-extrabold leading-none tracking-[-0.025em] tabular-nums">
              ≈ {size.toLocaleString('ko-KR')}자
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              답변할 때마다 이만큼이 모델에 함께 들어갑니다. 길수록 비용과 응답 시간이 늘어요.
            </p>
          </div>
          <Button onClick={draft.save} disabled={blocked}>
            {draft.saving ? <Loader2 className="animate-spin" /> : '저장'}
          </Button>
        </div>

        {textOver && (
          <p className="text-xs text-destructive">
            알려줄 내용이 상한을 넘었습니다. 줄여야 저장할 수 있어요 — 잘라서 저장하지 않습니다.
          </p>
        )}
        {faqOver && (
          <p className="text-xs text-destructive">
            자주 묻는 질문이 {KNOWLEDGE_LIMITS.faqItems}개를 넘었습니다.
          </p>
        )}
        {draft.status && (
          <p
            className={cn(
              'text-xs',
              draft.status.kind === 'ok' ? 'text-brand-strong' : 'text-destructive',
            )}
          >
            {draft.status.message}
          </p>
        )}
      </section>
    </div>
  );
}
