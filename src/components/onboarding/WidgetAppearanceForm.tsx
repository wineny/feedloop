'use client';

// 위젯 모양 편집 — 좌측 폼, 우측 미리보기.
//
// 미리보기는 public/widget.js 의 [처음] 상태를 React 로 정적 재현한 것이다.
// 실물이 아니라 사본이라 색·간격을 widget.js 의 값(선 #eeeae9, 칩 배경 #f6f3f2 …)으로
// 직접 박았다. 위젯 CSS 를 고치면 여기도 같이 고쳐야 한다.
// iframe 으로 진짜 위젯을 띄우지 않는 이유는 아직 저장 안 된 입력값을 그리기 위해서다.
//
// 색 두 개(강조색·내 말풍선색)는 운영자가 고를 수 있다. 폴백·틴트·글자색 계산은
// lib/bot/appearance.ts 하나를 위젯(applyColors)과 공유한다.
//
// 말풍선 예시 한 줄은 [처음] 상태에는 원래 없다(실제 위젯은 방문자가 뭔가 보내면
// 칩이 사라진다). 내 말풍선색을 눈으로 확인할 자리가 필요해서 합성해 붙인 것이고,
// 캡션에 "예시"라고 밝힌다.

import { useState } from 'react';
import { ASK_HUMAN_LABEL } from '@/lib/bot/holding';
import { PICK_LABEL } from '@/lib/widget/pick';
import { useForm, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  ACCENT_TINT_RATIO,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_STATUS_TEXT,
  DEFAULT_VISITOR_BUBBLE_COLOR,
  MAX_STARTER_QUESTIONS,
  MAX_STARTER_QUESTION_CHARS,
  accentTint,
  defaultGreeting,
  defaultOperatorName,
  normalizeHexColor,
  readableAccent,
  readableTextOn,
  validateStarterQuestions,
} from '@/lib/bot/appearance';
// 칩 라벨은 위젯과 한 곳(lib/widget/chips.ts)에서 온다 — 예전처럼 사본을 두면
// 칩 문구를 고칠 때 미리보기만 옛 문구로 남는다.
import { WIDGET_CHIPS } from '@/lib/widget/chips';
import { cn } from '@/lib/utils';

interface AppearanceInitial {
  display_name: string | null;
  status_text: string | null;
  greeting: string | null;
  operator_display_name: string | null;
  profile_image_url: string | null;
  accent_color: string | null;
  visitor_bubble_color: string | null;
  starter_questions: unknown;
  starter_faq_fallback: boolean | null;
}

interface WidgetAppearanceFormProps {
  botId: string;
  serviceName: string;
  initial: AppearanceInitial;
  /**
   * 시작 질문을 비워뒀을 때 위젯이 대신 쓸 수 있는 답변 지식 FAQ 질문들.
   * 「자동 채우기」를 꺼 뒀어도 채워서 넘어온다 — 켜면 무엇이 뜨는지 보여주는 재료다.
   */
  faqQuestions: string[];
}

/** 라디오 그룹의 이름·설명을 잇는 id 앞자리. 이 폼은 한 페이지에 하나뿐이라 고정으로 둔다. */
const FALLBACK_LABEL_ID = 'starter-fallback';

// 시작 질문은 한 줄에 하나씩 쓴다. 칸 네 개를 두는 것보다 FAQ 에서 복사해 붙이기 쉽고,
// 순서를 바꾸는 것도 줄을 옮기면 된다.
function questionsToText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((v): v is string => typeof v === 'string').join('\n');
}

function textToQuestions(value: string): string[] {
  return (
    value
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      // 서버(validateStarterQuestions)도 중복을 접는다. 여기서 안 접으면 같은 질문을
      // 두 줄 쓴 운영자가 미리보기에서만 두 개를 보고, 저장 뒤 한 줄로 줄어든다.
      .filter((q, i, all) => all.indexOf(q) === i)
  );
}

// 빈 문자열 = "기본색을 쓰겠다". 그 외에는 #RRGGBB 만.
const hexField = z.string().refine((v) => v.trim() === '' || normalizeHexColor(v) !== null, {
  message: '#RRGGBB 형식의 색상 코드를 넣어주세요',
});

/**
 * 견본·미리보기가 쓸 색. 7자가 되기 전에는 «입력 중»으로 보고 기본색을 쓴다.
 *
 * 왜: `#2d2f2e` 를 손으로 타이핑하면 중간에 `#2d2` 를 지나는데 그게
 * #22dd22(초록)로 펼쳐져 견본과 미리보기가 초록으로 번쩍인다.
 * 서버는 3자리 표기도 그대로 받는다 — 이건 화면에서만 쓰는 규칙이다.
 */
function committedHex(value: string, fallback: string): string {
  const raw = value.trim();
  if (raw.length !== 7) return fallback;
  return normalizeHexColor(raw) ?? fallback;
}

/**
 * 기본색과 같은 값은 저장하지 않는다 — 견본을 눌러보기만 해도 값이 확정되기 때문.
 * `input type=color` 는 취소가 없고 열려 있는 동안 input 이벤트가 계속 떠서,
 * 아무것도 안 고르고 닫아도 폼에는 견본이 띄우고 있던 기본색이 박힌다.
 */
function foldDefault(value: string, fallback: string): string {
  return normalizeHexColor(value) === fallback ? '' : value;
}

/** PATCH 응답(봇 행)을 폼 값으로. 서버가 정규화한 형태를 화면에 되돌려 놓는다. */
function toFormValues(row: Record<string, unknown>): FormValues {
  const str = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  return {
    display_name: str('display_name'),
    status_text: str('status_text'),
    greeting: str('greeting'),
    operator_display_name: str('operator_display_name'),
    profile_image_url: str('profile_image_url'),
    accent_color: str('accent_color'),
    visitor_bubble_color: str('visitor_bubble_color'),
    starter_questions: questionsToText(row.starter_questions),
    // 켜짐이 기본값이다 (20260911_02 DEFAULT true 와 같게).
    // ⚠️ PATCH 응답 SELECT 에서 이 컬럼이 빠지면 undefined 가 되어, 저장 직후 라디오가
    // 「채우기」로 말없이 되돌아가고 DB 는 꺼진 채로 남는다 — 두 곳이 한 문자열에 매달려 있다.
    starter_faq_fallback: row.starter_faq_fallback !== false,
  };
}

// 서버(validateAppearanceInput)와 같은 상한. 저장 버튼을 누르기 전에 알려주려는 것뿐이고,
// 진짜 방어선은 서버다.
const schema = z.object({
  display_name: z.string().max(40, { message: '표시 이름은 40자까지 입력할 수 있습니다' }),
  status_text: z.string().max(60, { message: '상태 문구는 60자까지 입력할 수 있습니다' }),
  greeting: z.string().max(300, { message: '첫 인사말은 300자까지 입력할 수 있습니다' }),
  operator_display_name: z
    .string()
    .max(40, { message: '운영자 답장 이름은 40자까지 입력할 수 있습니다' }),
  profile_image_url: z
    .string()
    .max(500, { message: '프로필 이미지 URL 은 500자까지 입력할 수 있습니다' })
    .refine((v) => v.trim() === '' || isHttpsUrl(v.trim()), {
      message: 'https:// 로 시작하는 주소만 넣을 수 있습니다',
    }),
  accent_color: hexField,
  visitor_bubble_color: hexField,
  // 줄 단위로 잘라 서버와 같은 규칙(validateStarterQuestions)에 통과시킨다.
  // 여기서 막는 건 편의고, 진짜 방어선은 서버다.
  starter_questions: z.string().superRefine((value, ctx) => {
    const result = validateStarterQuestions(textToQuestions(value));
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.error });
  }),
  starter_faq_fallback: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function WidgetAppearanceForm({
  botId,
  serviceName,
  initial,
  faqQuestions,
}: WidgetAppearanceFormProps) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      display_name: initial.display_name ?? '',
      status_text: initial.status_text ?? '',
      greeting: initial.greeting ?? '',
      operator_display_name: initial.operator_display_name ?? '',
      profile_image_url: initial.profile_image_url ?? '',
      accent_color: initial.accent_color ?? '',
      visitor_bubble_color: initial.visitor_bubble_color ?? '',
      starter_questions: questionsToText(initial.starter_questions),
      starter_faq_fallback: initial.starter_faq_fallback !== false,
    },
  });

  // 입력할 때마다 미리보기가 따라 움직인다.
  const values = form.watch();

  async function onSubmit(v: FormValues) {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch(`/api/bots/${botId}/appearance`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...v,
          accent_color: foldDefault(v.accent_color, DEFAULT_ACCENT_COLOR),
          visitor_bubble_color: foldDefault(v.visitor_bubble_color, DEFAULT_VISITOR_BUBBLE_COLOR),
          starter_questions: textToQuestions(v.starter_questions),
          starter_faq_fallback: v.starter_faq_fallback,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError((data && data.error) || '저장하지 못했습니다');
        return;
      }
      // 서버가 정규화한 값(#ABC → #aabbcc, 기본색 → null)을 폼에 되돌려 놓는다.
      // 안 하면 새로고침할 때까지 화면이 저장된 것과 다른 문자열을 보여준다.
      if (data && typeof data === 'object') {
        form.reset(toFormValues(data as Record<string, unknown>));
      }
      // config 응답이 CDN 에 `s-maxage=60, stale-while-revalidate=300` 으로 얹혀 있다.
      // 즉 최악의 경우 옛 응답이 몇 분 더 나갈 수 있다 — 「1~2분」이라고 못 박으면
      // 시작 질문을 «내리려고» 끈 운영자가 그 뒤에도 보이는 걸 보고 안 꺼졌다고 오해한다.
      setNotice('저장했어요. 방문자 위젯에는 몇 분 안에 반영돼요');
    } catch {
      setError('네트워크 오류로 저장하지 못했습니다');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,660px)_340px] lg:items-start">
      <div className="min-w-0">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
            <FormField
              control={form.control}
              name="display_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-semibold">표시 이름</FormLabel>
                  <FormControl>
                    <Input placeholder={serviceName} {...field} />
                  </FormControl>
                  <FormDescription className="text-[13px] leading-relaxed">
                    위젯 헤더와 플로팅 버튼에 쓰입니다. 비워두면 서비스 이름을 씁니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="status_text"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-semibold">상태 문구</FormLabel>
                  <FormControl>
                    <Input placeholder={DEFAULT_STATUS_TEXT} {...field} />
                  </FormControl>
                  <FormDescription className="text-[13px] leading-relaxed">
                    표시 이름 아래 한 줄. 답장이 언제쯤 가는지 미리 알려주는 자리입니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="greeting"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-semibold">첫 인사말</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={4}
                      className="resize-none"
                      placeholder={defaultGreeting(values.display_name.trim() || serviceName)}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-[13px] leading-relaxed">
                    위젯을 열면 가장 먼저 보이는 말풍선입니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="starter_questions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-semibold">시작 질문</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={4}
                      className="resize-none"
                      // 비워두면 뜰 것을 미리 보여준다. 자동 채우기를 꺼 두면 비워도
                      // 아무것도 안 뜨므로, 그때는 FAQ 대신 «쓰는 법» 예시를 보여준다.
                      placeholder={
                        values.starter_faq_fallback && faqQuestions.length > 0
                          ? faqQuestions.join('\n')
                          : '쿠폰은 하루 몇 장까지 받나요?\n혼잡도가 실시간인가요?'
                      }
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-[13px] leading-relaxed">
                    {`한 줄에 하나씩, ${MAX_STARTER_QUESTIONS}개까지 (각 ${MAX_STARTER_QUESTION_CHARS}자).`} 인사말
                    아래에 뜨고, 방문자가 누르면 바로 전송돼 그 자리에서 답을 받습니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="starter_faq_fallback"
              render={({ field }) => (
                <FormItem>
                  {/* FormControl 은 Slot 으로 자식 하나에 id 를 심는다 — 라디오 그룹
                      컨테이너에는 맞지 않아(라벨이 div 를 가리킴) 쓰지 않는다. 대신 보이는
                      라벨에 id 를 주고 그룹이 그걸 가리켜, 이름이 «한 벌»만 있게 한다.
                      카드 모양은 `/bots/new` 의 PR 모드 라디오와 같다. */}
                  <FormLabel id={FALLBACK_LABEL_ID} className="text-sm font-semibold">
                    시작 질문을 비워뒀을 때
                  </FormLabel>
                  <div
                    role="radiogroup"
                    aria-labelledby={FALLBACK_LABEL_ID}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <label
                      className={cn(
                        'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-4 text-sm transition-colors',
                        field.value ? 'border-foreground' : 'border-border',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {/* label 이 설명 문단까지 감싸고 있어, 그냥 두면 이 선택지의
                            «이름»이 설명 전체가 된다 — 스크린리더가 문단을 통째로 읽는다.
                            이름은 제목만, 설명은 describedby 로 가른다. 클릭 영역은 그대로. */}
                        <input
                          type="radio"
                          name={field.name}
                          value="on"
                          checked={field.value}
                          onChange={() => field.onChange(true)}
                          ref={field.ref}
                          aria-labelledby={`${FALLBACK_LABEL_ID}-on-title`}
                          aria-describedby={`${FALLBACK_LABEL_ID}-on-desc`}
                          className="h-4 w-4 accent-foreground"
                        />
                        <span id={`${FALLBACK_LABEL_ID}-on-title`} className="font-semibold">
                          답변 지식에서 채우기
                        </span>
                      </div>
                      <p
                        id={`${FALLBACK_LABEL_ID}-on-desc`}
                        className="text-[13px] leading-relaxed text-muted-foreground"
                      >
                        {faqQuestions.length > 0
                          ? `FAQ 앞쪽 질문이 그대로 방문자에게 보입니다. 지금이라면 「${faqQuestions[0]}」 부터 ${faqQuestions.length}개입니다.`
                          : '답변 지식에 FAQ 를 넣으면 그 앞쪽 질문이 방문자에게 보입니다. 지금은 FAQ 가 없어 아무것도 뜨지 않습니다.'}
                      </p>
                    </label>

                    <label
                      className={cn(
                        'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-4 text-sm transition-colors',
                        !field.value ? 'border-foreground' : 'border-border',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={field.name}
                          value="off"
                          checked={!field.value}
                          onChange={() => field.onChange(false)}
                          aria-labelledby={`${FALLBACK_LABEL_ID}-off-title`}
                          aria-describedby={`${FALLBACK_LABEL_ID}-off-desc`}
                          className="h-4 w-4 accent-foreground"
                        />
                        <span id={`${FALLBACK_LABEL_ID}-off-title`} className="font-semibold">
                          띄우지 않기
                        </span>
                      </div>
                      <p
                        id={`${FALLBACK_LABEL_ID}-off-desc`}
                        className="text-[13px] leading-relaxed text-muted-foreground"
                      >
                        첫 화면에 인사말과 의견 남기기만 보입니다. 답변 지식은 그대로 쓰이고,
                        방문자가 직접 물어보면 답합니다.
                      </p>
                    </label>
                  </div>
                  <FormDescription className="text-[13px] leading-relaxed">
                    위 칸에 질문을 직접 쓰면 언제나 그게 우선입니다. 이 선택은 칸이 비었을 때만
                    쓰입니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="operator_display_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-semibold">운영자 답장 이름</FormLabel>
                  <FormControl>
                    <Input placeholder={defaultOperatorName(values.display_name.trim() || serviceName)} {...field} />
                  </FormControl>
                  <FormDescription className="text-[13px] leading-relaxed">
                    대화 탭에서 보낸 답장에 붙는 이름입니다.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="profile_image_url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-semibold">프로필 이미지 URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://…/logo.png" {...field} />
                  </FormControl>
                  <FormDescription className="text-[13px] leading-relaxed">
                    512×512 정사각 PNG/JPG 권장. 파일 업로드는 준비 중이라 지금은 공개 URL 을
                    넣어주세요.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="border-t border-border pt-6">
              <h2 className="text-sm font-semibold">색상</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                비워두면 Feedloop 기본색을 씁니다. 서비스 브랜드색을 넣으면 위젯이 우리 사이트의
                일부처럼 보입니다.
              </p>

              <div className="mt-5 flex flex-col gap-6">
                <ColorField
                  control={form.control}
                  name="accent_color"
                  label="강조색"
                  fallback={DEFAULT_ACCENT_COLOR}
                  description="플로팅 버튼·미읽음 배지·프로필 이니셜·보내기 버튼·링크·반영 알림 카드에 쓰입니다. 그 위의 글자색은 밝기에 따라 흰색·검정 중 읽히는 쪽이 자동으로 선택되고, 밝은 색을 고르면 링크·테두리는 조금 어둡게 조정됩니다."
                />
                <ColorField
                  control={form.control}
                  name="visitor_bubble_color"
                  label="내 말풍선색"
                  fallback={DEFAULT_VISITOR_BUBBLE_COLOR}
                  description="방문자가 보낸 말풍선의 배경색입니다. 글자색은 밝기에 따라 흰색·검정 중 읽히는 쪽이 자동으로 선택됩니다."
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border pt-5">
              {notice && <p className="mr-auto text-sm text-muted-foreground">{notice}</p>}
              {error && <p className="mr-auto text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={saving}>
                {saving ? '저장 중…' : '저장'}
              </Button>
            </div>
          </form>
        </Form>
      </div>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <p className="mb-3 text-xs font-semibold text-muted-foreground">
          방문자에게 보이는 모습 (첫 화면 + 말풍선 예시)
        </p>
        <WidgetPreview serviceName={serviceName} values={values} faqQuestions={faqQuestions} />
      </div>
    </div>
  );
}

// ── 색 고르기 ───────────────────────────────────────
//
// 색 견본(input type=color)과 hex 입력칸이 같은 폼 값을 본다. 견본만 두면 운영자가
// 브랜드 가이드의 hex 를 그대로 붙여넣을 수 없고, 입력칸만 두면 색을 눈으로 못 고른다.
//
// 값이 비면 "기본색" — 견본에는 기본색을 띄우되 입력칸은 비워둔다. 견본은 빈 값을
// 표현할 방법이 없어서(항상 어떤 색을 갖는다) 입력칸이 빈 상태의 근거가 된다.
//
// 그래서 견본을 «눌러보기만» 해도 폼에 기본색이 박힌다(취소가 없다). 저장 직전
// foldDefault 가 그 값을 다시 빈 값으로 접는다 — 안 그러면 아무 색도 안 고른
// 운영자의 봇에 `#2d2f2e` 같은 값이 저장된다.

function ColorField({
  control,
  name,
  label,
  fallback,
  description,
}: {
  control: Control<FormValues>;
  name: 'accent_color' | 'visitor_bubble_color';
  label: string;
  fallback: string;
  description: string;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const swatch = committedHex(field.value, fallback);
        const isDefault = field.value.trim() === '';

        return (
          <FormItem>
            <FormLabel className="text-sm font-semibold">{label}</FormLabel>
            <div className="flex flex-wrap items-center gap-2.5">
              {/* 네이티브 색 선택기. 값은 항상 #rrggbb 라 빈 값을 못 담는다 —
                  비어 있으면 기본색을 띄운다. FormControl 로 감싸지 않는 이유는
                  라벨을 누르면 색 선택기가 열려버리기 때문이다. 라벨은 hex 칸을 잡는다. */}
              <input
                type="color"
                aria-label={`${label} 견본`}
                value={swatch}
                onChange={(e) => field.onChange(e.target.value.toLowerCase())}
                className="h-10 w-12 shrink-0 cursor-pointer rounded-[10px] border border-border-strong bg-transparent p-1"
              />
              <FormControl>
                {/* aria-label 을 안 붙인다 — FormLabel 이 이 칸을 가리키므로
                    접근성 이름은 「강조색」처럼 눈에 보이는 라벨 그대로가 맞다. */}
                <Input
                  placeholder={fallback}
                  className="w-[9.5rem] font-mono"
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  name={field.name}
                />
              </FormControl>
              {isDefault ? (
                <span className="text-[13px] text-muted-foreground">기본값</span>
              ) : (
                <button
                  type="button"
                  onClick={() => field.onChange('')}
                  className="text-[13px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  기본값으로
                </button>
              )}
            </div>
            <FormDescription className="text-[13px] leading-relaxed">{description}</FormDescription>
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}

// ── 미리보기 ────────────────────────────────────────

function WidgetPreview({
  serviceName,
  values,
  faqQuestions,
}: {
  serviceName: string;
  values: FormValues;
  faqQuestions: string[];
}) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  // config 라우트와 같은 폴백. 비워둔 칸이 실제 위젯에서 무엇으로 채워지는지 그대로 보여준다.
  const displayName = values.display_name.trim() || serviceName;
  const statusText = values.status_text.trim() || DEFAULT_STATUS_TEXT;
  const greeting = values.greeting.trim() || defaultGreeting(displayName);
  const profileUrl = values.profile_image_url.trim();
  const showImage = profileUrl !== '' && profileUrl !== brokenUrl;

  // 위젯 applyColors 와 같은 폴백·계산. 입력이 아직 7자가 아니거나 형식이
  // 틀리면 기본색으로 돌아가므로 타이핑 중에도 미리보기가 깨지지 않는다.
  const accent = committedHex(values.accent_color, DEFAULT_ACCENT_COLOR);
  const accentFg = readableTextOn(accent);
  const accentStrong = readableAccent(accent);
  const accentTintBg = accentTint(accent, ACCENT_TINT_RATIO);
  const bubbleBg = committedHex(values.visitor_bubble_color, DEFAULT_VISITOR_BUBBLE_COLOR);
  const bubbleFg = readableTextOn(bubbleBg);

  // 위젯 config 라우트와 같은 폴백 — 비워두면 FAQ 질문이 뜬다는 걸 눈으로 보여준다.
  // 상한을 넘게 쓰는 중에도 미리보기는 앞쪽 몇 개로 계속 그린다(저장은 막힌다).
  const typed = textToQuestions(values.starter_questions);
  const fallback = values.starter_faq_fallback ? faqQuestions : [];
  const starterQuestions = (typed.length > 0 ? typed : fallback).slice(0, MAX_STARTER_QUESTIONS);

  return (
    <div
      className="w-full max-w-[360px] overflow-hidden rounded-[14px] bg-white text-[#191d1b] shadow-[0_24px_64px_rgba(25,29,27,.2),0_4px_16px_rgba(25,29,27,.08)]"
      aria-label="위젯 미리보기"
    >
      <div className="flex items-center gap-2.5 border-b border-[#eeeae9] px-3.5 pt-3.5 pb-3">
        <Avatar
          displayName={displayName}
          url={showImage ? profileUrl : null}
          onError={() => setBrokenUrl(profileUrl)}
          size="lg"
          accent={accent}
          accentFg={accentFg}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold tracking-[-0.02em]">{displayName}</h3>
          <p className="mt-0.5 text-[12px] text-[#6e6968]">{statusText}</p>
        </div>
        <span className="flex h-8 w-8 items-center justify-center text-[#a39d9b]" aria-hidden>
          ✕
        </span>
      </div>

      <div className="flex min-h-[300px] flex-col gap-3 px-3.5 py-4">
        <div className="flex items-start gap-2">
          <Avatar
            displayName={displayName}
            url={showImage ? profileUrl : null}
            onError={() => setBrokenUrl(profileUrl)}
            size="sm"
            accent={accent}
            accentFg={accentFg}
          />
          {/* 인사말에는 이름 라벨이 없다 — 헤더 바로 밑이라 누가 한 말인지 이미 안다.
              위젯 ourRow() 의 greeting 분기와 같아야 한다. */}
          <div className="flex min-w-0 max-w-[78%] flex-col gap-1">
            <div className="rounded-[14px] rounded-bl-[4px] bg-[#f6f3f2] px-3.5 py-2.5 text-[14px] leading-[1.55] tracking-[-0.01em] break-words whitespace-pre-wrap">
              {greeting}
            </div>
          </div>
        </div>

        {/* 시작 줄 — 위는 눌러서 바로 전송되는 질문, 아래는 입력창을 채우는 의견 알약.
            위젯(public/widget.js starterBlock)과 같은 모양이어야 한다. */}
        <div className="ml-9 flex flex-col">
          {starterQuestions.length > 0 && (
            <>
              <p className="mb-[7px] ml-0.5 text-[11px] font-bold tracking-[0.02em] text-[#a39d9b]">
                자주 묻는 질문
              </p>
              <div className="flex flex-col gap-1.5">
                {starterQuestions.map((question) => (
                  <span
                    key={question}
                    className="flex items-center gap-2 rounded-full border border-[#eeeae9] bg-white py-[7px] pr-[14px] pl-[16px] text-[13.5px] leading-[1.4] tracking-[-0.01em]"
                  >
                    <span className="min-w-0 flex-1">{question}</span>
                    <span className="shrink-0 text-[13px]" style={{ color: accentStrong }} aria-hidden>
                      ›
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {WIDGET_CHIPS.map((chip) => (
              <span
                key={chip.hint}
                className="rounded-full border border-[#eeeae9] bg-[#f6f3f2] px-[13px] py-1.5 text-[12.5px] leading-[1.3] whitespace-nowrap text-[#6e6968]"
              >
                {chip.label}
              </span>
            ))}
          </div>
        </div>

        {/* 내 말풍선색·AI 배지를 볼 자리. 실제 [처음] 상태에는 없다 — 캡션에 예시라고 밝힌다. */}
        <div className="mt-1 flex justify-end">
          <div
            className="max-w-[78%] rounded-[14px] rounded-br-[4px] px-3.5 py-2.5 text-[14px] leading-[1.55] tracking-[-0.01em] break-words"
            style={{ background: bubbleBg, color: bubbleFg }}
          >
            쿠폰함이 계속 비어 보여요
          </div>
        </div>

        <div className="flex items-start gap-2">
          <Avatar
            displayName={displayName}
            url={showImage ? profileUrl : null}
            onError={() => setBrokenUrl(profileUrl)}
            size="sm"
            accent={accent}
            accentFg={accentFg}
          />
          <div className="flex min-w-0 max-w-[78%] flex-col gap-1">
            <span className="ml-0.5 flex items-center gap-1.5 text-[11px] text-[#6e6968]">
              {displayName}
              <span
                className="rounded-full px-1.5 py-px text-[9.5px] font-bold"
                style={{ color: accentStrong, background: accentTintBg }}
              >
                AI
              </span>
            </span>
            <div className="rounded-[14px] rounded-bl-[4px] bg-[#f6f3f2] px-3.5 py-2.5 text-[14px] leading-[1.55] tracking-[-0.01em] break-words">
              확인해서 알려드릴게요.
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-[#eeeae9]">
        {/* 도구 줄 — 위젯 render() 의 .tools 와 같은 모양(알약 두 개, 조준점·사람 아이콘). 라벨은 상수 */}
        <div className="flex items-center gap-1.5 px-2.5 pt-2.5">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#eeeae9] bg-white pl-2.5 pr-3 text-[12.5px] font-semibold tracking-[-0.01em] text-[#191d1b]">
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] shrink-0 fill-none stroke-current" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14M12 2v3M12 19v3M2 12h3M19 12h3M12 10.8a1.2 1.2 0 1 0 0 2.4a1.2 1.2 0 1 0 0-2.4" /></svg>
            {PICK_LABEL}
          </span>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[#eeeae9] bg-white pl-2.5 pr-3 text-[12.5px] font-semibold tracking-[-0.01em] text-[#191d1b]">
            <svg viewBox="0 0 24 24" className="h-[15px] w-[15px] shrink-0 fill-none stroke-current" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
            {ASK_HUMAN_LABEL}
          </span>
        </div>
        <div className="flex items-end gap-2 px-2.5 pt-2 pb-1.5">
          <div className="h-[42px] flex-1 rounded-xl border border-[#eeeae9] px-3 py-2.5 text-[14px] text-[#a39d9b]">
            무엇이든 편하게 남겨주세요
          </div>
          <div
            className="flex h-[38px] shrink-0 items-center rounded-full px-[18px] text-[13px] font-bold"
            style={{ background: accent, color: accentFg }}
          >
            보내기
          </div>
        </div>
        {/* 크레딧 — 위젯 render() 의 .credit 과 같은 모양. 도구 줄(.tools)은 입력창 «위»에 있다. */}
        <div className="flex justify-end px-3 pb-[9px]">
          <span className="whitespace-nowrap text-[11px] text-[#a39d9b]">Powered by Feedloop</span>
        </div>
      </div>
    </div>
  );
}

function Avatar({
  displayName,
  url,
  onError,
  size,
  accent,
  accentFg,
}: {
  displayName: string;
  url: string | null;
  onError: () => void;
  size: 'sm' | 'lg';
  accent: string;
  accentFg: string;
}) {
  const box = size === 'lg' ? 'h-9 w-9 text-[15px]' : 'h-7 w-7 text-[12px]';

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold ${box}`}
      style={{ background: accent, color: accentFg }}
    >
      {url ? (
        // next/image 는 외부 도메인 허용목록이 필요하다. 운영자가 아무 URL 이나
        // 넣는 자리라 여기서는 일반 img 를 쓴다. 주소가 깨지면 이니셜로 되돌린다.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" onError={onError} />
      ) : (
        <span>{displayName.charAt(0).toUpperCase()}</span>
      )}
    </div>
  );
}
