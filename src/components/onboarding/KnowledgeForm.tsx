'use client';

// 봇 설정 › 답변 지식 — 운영자가 봇에게 알려줄 내용을 넣는 곳.
//
// 여기 넣은 것이 시스템 프롬프트에 «통째로» 실린다. 검색(RAG)이 없다.
// 그래서 화면이 "프롬프트에 실리는 크기"를 계속 보여준다 — 이 숫자가 곧
// 호출 1건의 비용이고, 상한이 왜 있는지를 운영자가 눈으로 알게 하는 유일한 자리다.
//
// 모델을 불러보는 미리보기는 없다. 저장할 때마다 돈이 나가면 안 된다.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2, Loader2, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SectionTitle } from '@/components/layout/SectionTitle';
import { KNOWLEDGE_LIMITS, knowledgeSize, type FaqItem } from '@/lib/bot/knowledge';

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
  const t = useTranslations('bots');
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
        setStatus({ kind: 'error', message: (data && data.error) || t('knowledge.errors.save') });
        return;
      }
      // 봇 설정 캐시를 라우트가 바로 비운다 — 5분을 기다릴 필요가 없다.
      setStatus({ kind: 'ok', message: t('knowledge.saved') });
    } catch {
      setStatus({ kind: 'error', message: t('knowledge.errors.network') });
    } finally {
      setSaving(false);
    }
  };

  return { text, setText, faq, addFaq, removeFaq, updateFaq, saving, status, save };
}

export function KnowledgeForm({ botId, serviceName, initial }: KnowledgeFormProps) {
  const t = useTranslations('bots');
  const holding = useTranslations('common')('holdingMessage');
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
          {t('knowledge.emptyNote', { holding })}
        </p>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          {/* 섹션 제목이면서 textarea 의 label 이다 — SectionTitle(h2)로 바꾸면 htmlFor 연결이 끊긴다 */}
          <label htmlFor="knowledge-text" className="text-lg font-bold tracking-[-0.015em]">
            {t('knowledge.textTitle')}
          </label>
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              textOver ? 'font-semibold text-destructive' : 'text-faint',
            )}
          >
            {t('knowledge.count', { count: text.trim().length, max: KNOWLEDGE_LIMITS.text })}
          </span>
        </div>
        <Textarea
          id="knowledge-text"
          rows={14}
          value={text}
          onChange={(e) => draft.setText(e.target.value)}
          placeholder={t('knowledge.textPlaceholder', { name: serviceName })}
          className="resize-y leading-relaxed"
        />
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('knowledge.textNote', { holding })}
        </p>
      </section>

      <section className="flex flex-col gap-4 border-t border-border pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <SectionTitle>{t('knowledge.faqTitle')}</SectionTitle>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
              {t('knowledge.faqHint')}
            </p>
          </div>
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums',
              faqOver ? 'font-semibold text-destructive' : 'text-faint',
            )}
          >
            {t('knowledge.faqCount', { count: filledFaq.length, max: KNOWLEDGE_LIMITS.faqItems })}
          </span>
        </div>

        {faq.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {t('knowledge.faqEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {faq.map((item, i) => (
              <li key={i} className={cn('flex flex-col gap-2', i > 0 && 'border-t border-border pt-4')}>
                <div className="flex items-start gap-2">
                  <Input
                    value={item.q}
                    onChange={(e) => draft.updateFaq(i, { q: e.target.value })}
                    placeholder={t('knowledge.faqQuestionPlaceholder')}
                    maxLength={KNOWLEDGE_LIMITS.faqQuestion}
                    aria-label={t('knowledge.questionLabel', { n: i + 1 })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => draft.removeFaq(i)}
                    aria-label={t('knowledge.questionDelete', { n: i + 1 })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <Textarea
                  rows={3}
                  value={item.a}
                  onChange={(e) => draft.updateFaq(i, { a: e.target.value })}
                  placeholder={t('knowledge.faqAnswerPlaceholder')}
                  maxLength={KNOWLEDGE_LIMITS.faqAnswer}
                  className="resize-none"
                  aria-label={t('knowledge.answerLabel', { n: i + 1 })}
                />
              </li>
            ))}
          </ul>
        )}

        <Button type="button" variant="outline" size="sm" onClick={draft.addFaq} className="self-start">
          <Plus className="h-4 w-4" />
          {t('knowledge.addItem')}
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
          {t('knowledge.publicWarning')}
        </p>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">{t('knowledge.sizeLabel')}</p>
            <p className="text-[26px] font-extrabold leading-none tracking-[-0.025em] tabular-nums">
              {t('knowledge.size', { size })}
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('knowledge.sizeNote')}
            </p>
          </div>
          <Button onClick={draft.save} disabled={blocked}>
            {draft.saving ? <Loader2 className="animate-spin" /> : t('knowledge.save')}
          </Button>
        </div>

        {textOver && (
          <p className="text-xs text-destructive">
            {t('knowledge.textOver')}
          </p>
        )}
        {faqOver && (
          <p className="text-xs text-destructive">
            {t('knowledge.faqOver', { max: KNOWLEDGE_LIMITS.faqItems })}
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
