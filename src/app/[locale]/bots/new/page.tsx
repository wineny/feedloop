"use client";

// 봇 등록 = 피드백을 받을 서비스 등록.
//
// 채널은 여기서 고르지 않는다. 2026-09-06 에는 「붙일 수 있는 채널이 카카오뿐이라 고르게 하면
// 고른 뒤에야 안 된다는 걸 만난다」가 이유였는데, 채널톡이 붙으면서 그 전제는 사라졌다.
// 지금 이유는 다르다 — 고르는 일 자체가 **다음 화면의 첫 질문**이고(「지금 고객 문의를 어떻게
// 받고 계세요?」), 거기서는 각 선택지가 무엇을 요구하는지까지 같이 보여줄 수 있다.
// 등록 폼에서 먼저 물으면 같은 질문을 근거 없이 두 번 하는 셈이 된다.
// 여기서 만드는 건 레코드뿐이고, 실제 연결은 다음 화면(/bots/[id]/connect)에서 끝난다.
//
// 「AI 답변」 절만 예외다 — 여기서 고른 것이 다음 화면에서 «바로» 쓰인다.
// 위젯이 붙는 순간 답이 나가기 시작하므로, 「누구 키로 답하는가」를 그 전에 묻는다.
// 키 저장은 봇이 생긴 뒤에야 가능해(라우트가 botId 를 요구한다) 등록 → 키 두 단계로 보낸다.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { PLATFORM_MODEL_LABEL } from '@/lib/llm/limits';
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type * as z from "zod";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { useDemoMode } from "@/lib/demo/useDemoMode";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHero } from "@/components/layout/PageHero";
import { SectionTitle } from "@/components/layout/SectionTitle";
import { LlmKeyFields } from "@/components/onboarding/LlmKeyFields";
import { cn } from "@/lib/utils";
import { DEFAULT_LIMITS } from "@/lib/llm/limits";
import {
  DEFAULT_KEY_PROVIDER,
  llmKeyPayload,
  newBotFormSchema,
  registrationPayload,
  githubTokenPayload,
} from "@/lib/bot/new-bot-form";

const formSchema = newBotFormSchema;

// 라디오 카드의 이름·설명 id. label 이 설명 문단까지 감싸고 있어 그냥 두면
// 선택지의 «이름»이 문단 전체가 된다 — 스크린리더가 문단을 통째로 읽는다.
// 이름은 제목만, 설명은 describedby 로 가른다. 클릭 영역은 그대로다.
const AI_MODE_LABEL_ID = "bot-ai-mode";
const PR_MODE_LABEL_ID = "bot-pr-mode";

export default function NewBotPage() {
  const t = useTranslations('bots');
  const tc = useTranslations('common');
  const router = useRouter();
  const demo = useDemoMode('botsNew');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 키 PATCH 가 실패했을 때 «봇은 이미 만들어져 있다». 그 사실을 들고 있어야
  // 다시 제출해도 두 번째 봇이 생기지 않는다.
  const [createdBotId, setCreatedBotId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // GitHub 토큰 저장 실패는 그 칸 아래에 띄운다 — AI 답변 절의 keyError 자리에 두면 가리키는 칸이 화면 아래라 못 찾는다(코드 리뷰)
  const [githubError, setGithubError] = useState<string | null>(null);

  // 입력 타입과 출력 타입이 다르다 — ai_mode 에 default 가 걸려 있어 «보낼 때는 선택»,
  // 「검증을 통과한 값」에서는 반드시 있다. 둘을 갈라 줘야 handleSubmit 이 후자를 넘긴다.
  const form = useForm<z.input<typeof formSchema>, unknown, z.output<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      service_name: "",
      service_description: "",
      service_url: "",
      github_repo_url: "",
      github_token: "",
      pr_mode: "approve",
      ai_mode: "free",
      llm_provider: DEFAULT_KEY_PROVIDER,
      llm_model_choice: "",
      llm_model_custom: "",
      llm_api_key: "",
    },
  });

  // useWatch — form.watch() 는 «폼 전체»의 모든 변경에 이 화면을 다시 그린다.
  // 여기서 보는 건 AI 절의 다섯 값뿐이라 서비스 이름 한 글자마다 다시 그릴 이유가 없다.
  const control = form.control;
  const aiMode = useWatch({ control, name: "ai_mode" });
  const provider = useWatch({ control, name: "llm_provider" });
  const modelChoice = useWatch({ control, name: "llm_model_choice" });
  const customModel = useWatch({ control, name: "llm_model_custom" });
  const apiKey = useWatch({ control, name: "llm_api_key" });

  // 키 저장만 실패해 봇이 «이미 있는» 상태. 재제출은 POST 를 건너뛰므로 그 사이에 고친
  // 기본 정보는 어디에도 안 간다 — 갈 곳이 없는 칸은 잠가서 고칠 수 있는 것처럼 보이지 않게 한다.
  const locked = createdBotId !== null;

  function goToConnect(botId: string) {
    router.push(`/bots/${botId}/connect`);
    router.refresh();
  }

  async function onSubmit(values: z.output<typeof formSchema>) {
    setIsSubmitting(true);
    setKeyError(null);
    setGithubError(null);
    try {
      // 이미 만들어진 봇이 있으면(키 저장만 실패한 재시도) 다시 만들지 않는다.
      let botId = createdBotId;
      if (!botId) {
        const response = await fetch("/api/bots", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          // 등록에 필요한 값만 싣는다. **API 키는 이 요청에 들어가지 않는다** —
          // 받는 쪽이 안 읽는다는 것과 보내지 않는다는 것은 다르다.
          body: JSON.stringify(registrationPayload(values)),
        });

        if (!response.ok) {
          throw new Error("Failed to create bot");
        }

        const bot = await response.json();
        botId = bot.id as string;
        setCreatedBotId(botId);
      }

      if (values.ai_mode === "own") {
        const res = await fetch(`/api/bots/${botId}/llm-key`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(llmKeyPayload(values)),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          // 조용히 넘어가지 않는다 — 키가 없는 채로 연결되면 위젯이 플랫폼 무료분으로
          // 답하기 시작하고, 운영자는 자기 키로 도는 줄 안다.
          setKeyError(data?.error ?? t('new.errors.keySave'));
          return;
        }
      }

      // GitHub 토큰(B5) — 등록 요청과 따로 보낸다. 실패해도 봇은 남는다: 토큰 없이도 공용 계정으로 시도하므로
      // 여기서 막지 않고 설정 탭에서 다시 넣게 안내한다
      const gh = githubTokenPayload(values);
      if (gh) {
        const res = await fetch(`/api/bots/${botId}/github-token`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(gh),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setGithubError(t('new.githubFail', { reason: data?.error ?? t('new.githubFailReason') }));
          return;
        }
      }

      goToConnect(botId);
    } catch (error) {
      console.error("Error creating bot:", error);
      alert(t('new.errors.register'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex max-w-[660px] flex-col gap-7">
      <PageHero
        title={t('new.title')}
        description={t('new.description')}
      />

      {/* 채널을 나열하지 않는다 — 「등록하면 다음에 무슨 일이 일어나는가」 한 문단이면 된다.
          고르는 일은 다음 화면이 맡고, 거기서 각 선택지의 전제까지 같이 보여준다 */}
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t.rich('new.afterRegister', { b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b> })}
      </p>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
          {locked && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('new.lockedNote')}
            </p>
          )}
          {/* 세 그룹으로 나눈다 — 「무엇을 등록하는가」·「누구 키로 답하는가」·「그 뒤에 무엇이 자동으로 일어나는가」는 다른 결정이다 */}
          <SectionTitle className="border-t border-border pt-5" sub={t('new.basicSub')}>
            {t('new.basic')}
          </SectionTitle>
          <FormField
            control={form.control}
            name="service_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-semibold">{t('new.serviceName')}</FormLabel>
                <FormControl>
                  <Input placeholder={t('new.serviceNamePlaceholder')} disabled={locked} {...field} />
                </FormControl>
                <FormDescription className="text-[13px] leading-relaxed">
                  {t('new.serviceNameHelp')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="service_description"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-semibold">{t('new.serviceDescription')}</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder={t('new.serviceDescriptionPlaceholder')}
                    className="resize-none"
                    disabled={locked}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="service_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-semibold">{t('new.serviceUrl')}</FormLabel>
                <FormControl>
                  <Input placeholder="https://example.com" disabled={locked} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <SectionTitle className="mt-2 border-t border-border pt-5" sub={t('new.aiSub')}>
            {t('new.ai')}
          </SectionTitle>
          <FormField
            control={form.control}
            name="ai_mode"
            render={({ field }) => (
              <FormItem>
                {/* FormLabel 은 <label htmlFor={FormItem 의 id}> 다 — 라디오 그룹에는
                    그 id 를 가진 요소가 없어 «어디도 가리키지 않는 label» 이 된다.
                    보이는 이름만 두고 그룹이 aria-labelledby 로 그걸 가리킨다.
                    FormControl(Slot)도 같은 이유로 그룹 컨테이너에는 쓰지 않는다. */}
                <span id={AI_MODE_LABEL_ID} className="text-sm font-semibold">
                  {t('new.apiKey')}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={AI_MODE_LABEL_ID}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                >
                  <label
                    className={cn(
                      'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-4 text-sm transition-colors',
                      field.value === "free" ? "border-foreground" : "border-border",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={field.name}
                        value="free"
                        checked={field.value === "free"}
                        onChange={() => field.onChange("free")}
                        ref={field.ref}
                        aria-labelledby={`${AI_MODE_LABEL_ID}-free-title`}
                        aria-describedby={`${AI_MODE_LABEL_ID}-free-desc`}
                        className="h-4 w-4 accent-foreground"
                      />
                      <span id={`${AI_MODE_LABEL_ID}-free-title`} className="font-semibold">
                        {t('new.freeTitle')}
                      </span>
                    </div>
                    <p
                      id={`${AI_MODE_LABEL_ID}-free-desc`}
                      className="text-[13px] leading-relaxed text-muted-foreground"
                    >
                      {/* 숫자를 문장에 박지 않는다 — 상한이 바뀌면 이 안내가 곧바로 거짓이 된다 */}
                      {t.rich('new.freeBody', {
                        limit: DEFAULT_LIMITS.noKey,
                        model: PLATFORM_MODEL_LABEL,
                        b: (chunks) => <b className="font-semibold tabular-nums text-foreground">{chunks}</b>,
                      })}
                    </p>
                  </label>

                  <label
                    className={cn(
                      'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-4 text-sm transition-colors',
                      field.value === "own" ? "border-foreground" : "border-border",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={field.name}
                        value="own"
                        checked={field.value === "own"}
                        onChange={() => field.onChange("own")}
                        aria-labelledby={`${AI_MODE_LABEL_ID}-own-title`}
                        aria-describedby={`${AI_MODE_LABEL_ID}-own-desc`}
                        className="h-4 w-4 accent-foreground"
                      />
                      <span id={`${AI_MODE_LABEL_ID}-own-title`} className="font-semibold">
                        {t('new.ownTitle')}
                      </span>
                    </div>
                    <p
                      id={`${AI_MODE_LABEL_ID}-own-desc`}
                      className="text-[13px] leading-relaxed text-muted-foreground"
                    >
                      {t('new.ownBody')}
                    </p>
                  </label>
                </div>
                <FormDescription className="text-[13px] leading-relaxed">
                  {t('new.aiNote', { holding: tc('holdingMessage') })}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {aiMode === "own" && (
            <div className="rounded-[10px] border border-foreground p-4">
              {/* 오류 문구는 LlmKeyFields 가 «입력하는 동안» 그린다. 여기서 zod 메시지를 한 번 더
                  그리면 글자까지 같은 줄이 둘로 보이고, setValue 가 지우지 못한 옛 오류가 남는다.
                  제출을 막는 일은 여전히 zod 가 한다. */}
              <LlmKeyFields
                compact
                provider={provider}
                modelChoice={modelChoice}
                customModel={customModel}
                apiKey={apiKey}
                disabled={isSubmitting}
                onProviderChange={(next) => form.setValue("llm_provider", next)}
                onModelChoiceChange={(next) => form.setValue("llm_model_choice", next)}
                onCustomModelChange={(next) => form.setValue("llm_model_custom", next)}
                onApiKeyChange={(next) => form.setValue("llm_api_key", next)}
              />
            </div>
          )}

          {/* 키 저장 실패 안내는 AI 모드 밖에 둔다 — 실패한 뒤 「무료로 시작」으로 바꾸면
              패널이 사라지면서 「키 없이 계속」까지 같이 사라져 빠져나갈 길이 없었다. */}
          {locked && keyError && (
            <div className="flex flex-col gap-2 rounded-[10px] border border-destructive/40 p-4">
              <p className="text-xs text-destructive">{keyError}</p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {t('new.keyFailedNote')}
              </p>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isSubmitting}
                  onClick={() => createdBotId && goToConnect(createdBotId)}
                >
                  {t('new.continueWithoutKey')}
                </Button>
              </div>
            </div>
          )}

          <SectionTitle className="mt-2 border-t border-border pt-5" sub={t('new.fixSub')}>
            {t('new.fix')}
          </SectionTitle>
          <FormField
            control={form.control}
            name="github_repo_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-semibold">{t('new.repoUrl')}</FormLabel>
                <FormControl>
                  <Input placeholder="https://github.com/user/repo" disabled={locked} {...field} />
                </FormControl>
                <FormDescription className="text-[13px] leading-relaxed">
                  {t('new.repoUrlHelp')}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="github_token"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-semibold">{t('new.githubToken')}</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="github_pat_…"
                    disabled={locked}
                    {...field}
                  />
                </FormControl>
                <FormDescription className="text-[13px] leading-relaxed">
                  {t('new.githubTokenHelp')}
                </FormDescription>
                <FormMessage />
                {githubError && <p className="text-sm text-destructive">{githubError}</p>}
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="pr_mode"
            render={({ field }) => (
              <FormItem>
                <span id={PR_MODE_LABEL_ID} className="text-sm font-semibold">
                  {t('new.prMode')}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby={PR_MODE_LABEL_ID}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                >
                    <label
                      className={cn(
                        'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-4 text-sm transition-colors',
                        field.value === "approve" ? "border-foreground" : "border-border",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={field.name}
                          value="approve"
                          checked={field.value === "approve"}
                          onChange={() => field.onChange("approve")}
                          disabled={locked}
                          ref={field.ref}
                          aria-labelledby={`${PR_MODE_LABEL_ID}-approve-title`}
                          aria-describedby={`${PR_MODE_LABEL_ID}-approve-desc`}
                          className="h-4 w-4 accent-foreground"
                        />
                        <span id={`${PR_MODE_LABEL_ID}-approve-title`} className="font-semibold">
                          {t('new.prApprove')}
                        </span>
                      </div>
                      <p
                        id={`${PR_MODE_LABEL_ID}-approve-desc`}
                        className="text-[13px] leading-relaxed text-muted-foreground"
                      >
                        {t('new.prApproveBody')}
                      </p>
                    </label>

                    <label
                      className={cn(
                        'flex cursor-pointer flex-col gap-1.5 rounded-[10px] border p-4 text-sm transition-colors',
                        field.value === "auto" ? "border-foreground" : "border-border",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={field.name}
                          value="auto"
                          checked={field.value === "auto"}
                          onChange={() => field.onChange("auto")}
                          disabled={locked}
                          aria-labelledby={`${PR_MODE_LABEL_ID}-auto-title`}
                          aria-describedby={`${PR_MODE_LABEL_ID}-auto-desc`}
                          className="h-4 w-4 accent-foreground"
                        />
                        <span id={`${PR_MODE_LABEL_ID}-auto-title`} className="font-semibold">
                          {t('new.prAuto')}
                        </span>
                      </div>
                      <p
                        id={`${PR_MODE_LABEL_ID}-auto-desc`}
                        className="text-[13px] leading-relaxed text-muted-foreground"
                      >
                        {t('new.prAutoBody')}
                      </p>
                    </label>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex justify-end gap-2 border-t border-border pt-5">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={isSubmitting || demo.isDemo}
            >
              {t('new.cancel')}
            </Button>
            {demo.isDemo ? (
              <Button type="button" onClick={() => signIn('google')}>
                {t('new.loginToRegister')}
              </Button>
            ) : (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (locked ? t('new.submit.savingKey') : t('new.submit.registering')) : locked ? t('new.submit.saveKey') : t('new.submit.register')}
              </Button>
            )}
          </div>
        </form>
      </Form>
    </div>
  );
}
