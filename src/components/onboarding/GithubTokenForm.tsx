'use client';

// 봇 설정 › GitHub 연결 (B5) — 「답변 지식」 화면의 세 번째 탭.
//
// 이 화면이 정하는 것은 «어느 계정으로 레포에 PR 을 여는가»다. 길이 둘이다:
//   1. Feedloop 앱 설치 — GitHub 에서 레포를 고르고 Install. PR 은 `<slug>[bot]` 이름으로 열린다. 토큰이 없다
//   2. 직접 토큰(fine-grained PAT) — 운영자 계정으로 열린다. 앱이 닿지 않는 레포나 폴백용
// 우선순위는 설치 → 봇 토큰 → Feedloop 공용 계정이다(lib/auto-dev/github-auth.ts).
//
// 지키는 것 둘:
//  1. 토큰 원문은 저장 뒤 다시 보여주지 않는다. 마지막 4자만 — 서버도 되돌려주지 않는다
//  2. 저장 «전»에 GitHub 에 물어본다(읽기만). 레포 접근·push 권한이 없으면 저장하지 않고 이유를 말한다

import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { validationText } from '@/lib/i18n/message';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, AlertTriangle, KeyRound, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
// 형식 필터만 쓴다. token.ts 는 GitHub 으로 실제 요청을 보내는 verifyGithubToken 을 들고 있어
// 클라이언트 번들에 실을 이유가 없다 — 그래서 의존성 0 인 token-format.ts 로 나눠 뒀다.
import { checkGithubTokenFormat } from '@/lib/github/token-format';
import { githubPatPrefillUrl } from '@/lib/github/pat-link';
// 응답 계약과 콜백 안내 문구는 «서버가 아닌» 모듈에서 가져온다 — 라우트 파일을 가리키면 다음 사람이
// 값 하나를 같은 경로에서 import 하는 순간 서버 코드가 클라이언트 번들로 딸려온다(코드 리뷰 MEDIUM).
import { callbackBanner, type GithubAppState } from '@/lib/github/app-state-types';

interface GithubTokenFormProps {
  botId: string;
  serviceName: string;
}

/** GET /api/bots/[id]/github-token 의 응답. 토큰 원문도 암호문도 여기에 없다. */
interface TokenState {
  repoUrl: string | null;
  hasToken: boolean;
  tokenLast4: string | null;
  verifiedAt: string | null;
  failedAt: string | null;
  failedReason: string | null;
  platformFallback: boolean;
  /** 저장된 토큰이 계정 전체 레포에 닿는 종류(classic PAT·OAuth)인가 — DB 에 남아 새로고침해도 유지된다 */
  broadToken: boolean;
  /** PATCH 응답에만 실린다. 방금 저장한 토큰의 스코프 목록(표시용) */
  broadScopes?: string | null;
}

/** 「설치 확인」(POST) 응답에 덧붙는 판정. lib/github/installation-binding.ts RecheckOutcome 의 kind */
type AppStateWithRecheck = GithubAppState & { recheck?: string; error?: string };

type Status = { kind: 'ok' | 'info' | 'error'; message: string } | null;
type Translate = ReturnType<typeof useTranslations<'github'>>;

// ── 설치 콜백 결과 ────────────────────────────────────────
//
// /api/github/app/callback 이 판정을 끝내고 `?app=<결과>` 로 되돌려보낸다. 한 번만 띄우고 주소에서 지운다 —
// 안 지우면 새로고침할 때마다 「연결했어요」가 다시 뜬다.


/** 「설치 확인」 결과. `ok` 말고는 전부 운영자가 GitHub 에서 뭔가를 해야 한다는 뜻이다 */
function recheckBanner(kind: string | undefined, t: Translate): Status {
  switch (kind) {
    case 'ok':
      return { kind: 'ok', message: t('recheck.ok') };
    case 'no_repo':
      return { kind: 'error', message: t('recheck.noRepo') };
    case 'not_bound':
      return { kind: 'error', message: t('recheck.notBound') };
    case 'missing':
      return { kind: 'error', message: t('recheck.missing') };
    case 'suspended':
      return { kind: 'error', message: t('recheck.suspended') };
    case 'changed':
      return { kind: 'error', message: t('recheck.changed') };
    default:
      return { kind: 'error', message: t('recheck.unknown') };
  }
}

/**
 * 설치 뒤 되돌아온 결과를 한 번 읽고 주소에서 지운다.
 * `tab=github` 은 남긴다 — 지우면 지금 보고 있는 탭이 「답변 지식」으로 되돌아간다.
 */
function useInstallCallbackBanner(): Status {
  const t = useTranslations('github');
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('app');
  // 마운트 시점에 «한 번» 읽어 들고 있는다. 아래에서 주소의 `app` 을 지워도 이 값은 남아 화면에 뜬다 —
  // 렌더 때마다 다시 읽으면 주소를 지우는 순간 안내가 같이 사라져 아무도 결과를 못 본다.
  // 종류(ok/error/info)는 lib 의 표가 정하고, 문구는 사전(`github.callback.<코드>`)에서 읽는다
  const [kind] = useState(() => callbackBanner(raw)?.kind ?? null);
  const banner: Status = kind && raw ? { kind, message: t(`callback.${raw}`) } : null;

  useEffect(() => {
    if (!raw) return;
    const next = new URLSearchParams(params.toString());
    next.delete('app');
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : window.location.pathname, { scroll: false });
  }, [raw, params, router]);

  return banner;
}

/**
 * 설치 상태를 읽고, 다시 확인하고, 연결을 푼다.
 *
 * 조회가 실패하면 «앱 절만» 숨긴다(null 유지) — 설치형 env 가 없는 배포에서도 토큰 화면은 그대로 떠야 한다.
 */
function useGithubApp(botId: string) {
  const t = useTranslations('github');
  const [app, setApp] = useState<GithubAppState | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/bots/${botId}/github-app`);
        if (!res.ok) return;
        const data = (await res.json()) as GithubAppState;
        if (alive) setApp(data);
      } catch {
        /* 앱 절을 숨기고 토큰 화면만 쓴다 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [botId]);

  const call = useCallback(
    async (method: 'POST' | 'DELETE', onOk: (data: AppStateWithRecheck) => Status) => {
      setBusy(true);
      setStatus(null);
      try {
        const res = await fetch(`/api/bots/${botId}/github-app`, { method });
        const data = (await res.json().catch(() => null)) as AppStateWithRecheck | null;
        if (!res.ok) {
          setStatus({ kind: 'error', message: data?.error ?? t('errors.checkFailed') });
          return;
        }
        if (data) {
          setApp(data);
          setStatus(onOk(data));
        }
      } catch {
        setStatus({ kind: 'error', message: t('errors.networkCheck') });
      } finally {
        setBusy(false);
      }
    },
    [botId, t],
  );

  const recheck = useCallback(() => call('POST', (data) => recheckBanner(data.recheck, t)), [call, t]);
  const unbind = useCallback(
    () =>
      call('DELETE', () => ({
        kind: 'ok',
        message: t('status.unbound'),
      })),
    [call, t],
  );

  return { app, busy, status, recheck, unbind };
}

// ── 화면 ─────────────────────────────────────────────────

export function GithubTokenForm(props: GithubTokenFormProps) {
  // useSearchParams 는 정적 렌더에서 CSR 로 내려앉는다. 이 페이지는 force-dynamic 이지만
  // 경계를 명시해 두면 렌더 방식이 바뀌어도 빌드가 깨지지 않는다.
  return (
    <Suspense fallback={<LoadingLine />}>
      <GithubConnectionForm {...props} />
    </Suspense>
  );
}

function LoadingLine() {
  const t = useTranslations('github');
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
    </p>
  );
}

function GithubConnectionForm({ botId, serviceName }: GithubTokenFormProps) {
  const t = useTranslations('github');
  const format = useFormatter();
  const tRoot = useTranslations();
  const b = (chunks: ReactNode) => <b className="font-semibold text-foreground">{chunks}</b>;
  const [state, setState] = useState<TokenState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [token, setToken] = useState('');
  /** 방금 저장한 토큰의 스코프 목록(표시용). 경고 자체는 `state.broadToken` 이 켠다 — 새로고침해도 남는다 */
  const [broadScopes, setBroadScopes] = useState<string | null>(null);
  /** 토큰 절을 펼쳐 두었는가. 기본은 접힘 — 아래 patPinned 가 참이면 접는 것과 무관하게 늘 보인다 */
  const [patOpen, setPatOpen] = useState(false);

  const installBanner = useInstallCallbackBanner();
  const { app, busy: appBusy, status: appStatus, recheck, unbind } = useGithubApp(botId);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/bots/${botId}/github-token`);
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as TokenState;
      setState(data);
      setLoadError(false);
      setEditing(!data.hasToken);
    } catch {
      setLoadError(true);
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) {
    return <p className="py-6 text-sm text-destructive">{t('loadError')}</p>;
  }
  if (!state) {
    return <LoadingLine />;
  }

  const formatCheck = checkGithubTokenFormat(token);
  const appOn = app?.configured === true;
  const appInstalled = appOn && app.installed;
  // 토큰 절을 «기본으로 펼치는» 경우 둘: 앱을 못 쓰는 배포(토큰이 유일한 경로)이거나, 이미 토큰이 있거나
  // 실패 표시가 있어 운영자가 상태를 봐야 할 때. 그 밖에는 접는다 — 권장 경로는 앱 설치인데
  // 발급 안내 다섯 단계가 펼쳐져 있으면 화면 대부분을 차지해 «결국 토큰을 만들어야 하는구나»로 읽힌다
  const patPinned = !appOn || state.hasToken || Boolean(state.failedAt);
  const showPatBody = patPinned || patOpen;

  async function send(init: RequestInit, okMessage: string) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/bots/${botId}/github-token`, init);
      const data = (await res.json().catch(() => null)) as (TokenState & { error?: string }) | null;
      if (!res.ok) {
        setStatus({ kind: 'error', message: data?.error ?? t('errors.save') });
        return;
      }
      if (data) setState(data);
      setBroadScopes(data?.broadScopes ?? null);
      setToken('');
      setConfirmRemove(false);
      setEditing(!data?.hasToken);
      setStatus({ kind: 'ok', message: okMessage });
    } catch {
      setStatus({ kind: 'error', message: t('errors.networkSave') });
    } finally {
      setBusy(false);
    }
  }

  const saveToken = () =>
    send(
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
      state?.repoUrl
        ? t('status.tokenSaved')
        : t('status.tokenSavedNoRepo'),
    );
  const removeToken = () => send({ method: 'DELETE' }, t('status.tokenRemoved'));

  return (
    <div className="flex max-w-[660px] flex-col gap-6">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {state.repoUrl ? t.rich('summary.repo', { repo: repoLabel(state.repoUrl), b }) : t('summary.noRepo')}{' '}
        {appInstalled
          ? t.rich('summary.app', { login: app.botLogin ?? 'none', b })
          : state.hasToken
            ? t.rich('summary.token', { b })
            : state.platformFallback
              ? t.rich('summary.shared', { b })
              : t('summary.noConnection')}
      </p>

      {installBanner && <Banner status={installBanner} />}

      {appOn && (
        <GithubAppSection app={app} busy={appBusy} status={appStatus} onRecheck={recheck} onUnbind={unbind} />
      )}

      {appOn && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('alt.title')}</h2>
            {!patPinned && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={patOpen}
                onClick={() => {
                  setStatus(null);
                  setPatOpen((v) => !v);
                }}
              >
                {patOpen ? t('alt.collapse') : t('alt.expand')}
              </Button>
            )}
          </div>
          {!patPinned && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {appInstalled
                ? t('alt.hintApp')
                : t('alt.hintNoApp')}
            </p>
          )}
        </div>
      )}

      {/* 토큰이 실패했으면 접혀 있어도 보여준다 — 「GitHub 토큰 확인 필요」 배지를 누르고 온 자리다 */}
      {state.failedAt && !editing && (
        <div className="flex items-start gap-2.5 border-l-2 border-destructive pl-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold text-destructive">{state.failedReason ?? t('failedFallback')}</p>
            <p className="text-xs text-muted-foreground">
              {t('failedNote')}
            </p>
          </div>
        </div>
      )}

      {showPatBody &&
        (!editing && state.hasToken ? (
          <div className={cn('flex flex-col gap-4', appOn ? 'pt-1' : 'border-t border-border pt-5')}>
            <div className="flex items-center gap-3">
              <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
              <span className="text-sm">
                {t.rich('token.line', { last4: state.tokenLast4 ?? '', b: (chunks) => <b className="font-semibold">{chunks}</b> })}
                {state.verifiedAt && (
                  <span className="ml-2 text-xs text-muted-foreground">{t('token.verified', { date: format.dateTime(new Date(state.verifiedAt), { month: 'numeric', day: 'numeric' }) })}</span>
                )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setStatus(null);
                  setToken('');
                  setEditing(true);
                }}
              >
                {t('token.replace')}
              </Button>
              {confirmRemove ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {appInstalled
                      ? t('token.removeNoteApp')
                      : t('token.removeNote')}
                  </span>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={removeToken}>
                    {busy ? <Loader2 className="animate-spin" /> : t('token.confirmRemove')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(false)}>
                    {t('cancel')}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  {t('token.remove')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className={cn('flex flex-col gap-5', appOn ? 'pt-1' : 'border-t border-border pt-5')}>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t('steps.issueTitle')}</h3>
              <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
                <li>
                  {t.rich('steps.s1', {
                    link: (chunks) => (
                      <a
                        href={githubPatPrefillUrl(state.repoUrl, serviceName)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-foreground underline underline-offset-4"
                      >
                        {chunks}
                      </a>
                    ),
                  })}
                </li>
                <li>{t.rich('steps.s2', { repo: state.repoUrl ? repoLabel(state.repoUrl) : 'none', b })}</li>
                <li>{t.rich('steps.s3', { b })}</li>
                <li>{t.rich('steps.s4', { b })}</li>
                <li>{t('steps.s5')}</li>
              </ol>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">{t('steps.pasteTitle')}</h3>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="github_pat_…"
                value={token}
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
                aria-label={t('token.label')}
              />
              {token && !formatCheck.ok && <p className="text-xs text-destructive">{validationText(tRoot, formatCheck)}</p>}
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('steps.pasteNote', { repo: state.repoUrl ? 'has' : 'none' })}
              </p>
            </section>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button onClick={saveToken} disabled={busy || !token || !formatCheck.ok}>
                {busy ? <Loader2 className="animate-spin" /> : t('verifyAndSave')}
              </Button>
              {state.hasToken && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setStatus(null);
                    setToken('');
                    setEditing(false);
                  }}
                >
                  {t('cancel')}
                </Button>
              )}
            </div>
          </div>
        ))}

      {status && (
        <p className={cn('text-xs', status.kind === 'error' ? 'text-destructive' : 'text-brand-strong')}>
          {status.message}
        </p>
      )}

      {/* classic PAT·OAuth 토큰은 «이 레포» 가 아니라 «이 계정이 닿는 모든 레포» 에 권한이 있다. 저장은 받되 사실을 말한다 */}
      {state.hasToken && state.broadToken && showPatBody && (
        <div className="flex items-start gap-2.5 border-l-2 border-amber-500 pl-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold">
              {t('broad.title', { scopes: broadScopes ? ` (${broadScopes})` : '' })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('broad.note')}
            </p>
          </div>
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        {appInstalled
          ? t('footer.app', { service: serviceName, login: app.botLogin ?? t('footer.appDefault') })
          : t('footer.token', { service: serviceName })}{' '}
        {t('footer.merge')}
      </p>
    </div>
  );
}

// ── Feedloop 앱 설치 절 ───────────────────────────────────

interface GithubAppSectionProps {
  app: GithubAppState;
  busy: boolean;
  status: Status;
  onRecheck: () => void;
  onUnbind: () => void;
}

/**
 * 상태 넷을 그린다: 레포 없음 · 미설치 · 설치됨 · 잃어버림.
 * 「설치 확인」은 **이미 묶인 설치를 다시 보는 것**이지 새로 묶지 않는다 — 새로 묶는 길은 설치 버튼 하나뿐이다.
 */
function GithubAppSection({ app, busy, status, onRecheck, onUnbind }: GithubAppSectionProps) {
  const t = useTranslations('github');
  const format = useFormatter();
  const b = (chunks: ReactNode) => <b className="font-semibold text-foreground">{chunks}</b>;
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const noRepo = !app.repoUrl;
  const lost = Boolean(app.lostAt);
  const botLogin = app.botLogin ?? t('app.defaultBotLogin');

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h2 className="text-sm font-semibold">
        {t('app.title')} <span className="ml-1 text-xs font-medium text-brand-strong">{t('app.recommended')}</span>
      </h2>

      {app.installed ? (
        <>
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-strong" aria-hidden />
            <span className="text-sm">
              <b className="font-semibold">{t('app.connected')}</b>
              {app.installationLogin && <span className="text-muted-foreground"> · @{app.installationLogin}</span>}
              {app.connectedAt && (
                <span className="ml-2 text-xs text-muted-foreground">{t('app.connectedAt', { date: format.dateTime(new Date(app.connectedAt), { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'Asia/Seoul' }) })}</span>
              )}
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t.rich('app.prOpened', { login: botLogin, b })}
            {app.connectedBy && <> {t('app.connectedBy', { user: app.connectedBy })}</>}
            {/* 우리가 쓰는 건 이 봇의 레포 하나지만, 계정 전체를 내준 상태라면 그 사실은 운영자가 알아야 한다(보안 리뷰 M3) */}
            {app.repositorySelection === 'all' && (
              <> {t.rich('app.allRepos', { b: (chunks) => <b className="font-semibold text-amber-700">{chunks}</b> })}</>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {app.manageUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={app.manageUrl} target="_blank" rel="noopener noreferrer">
                  {t('app.manage')}
                </a>
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRecheck}>
              {busy ? <Loader2 className="animate-spin" /> : t('app.recheck')}
            </Button>
            {confirmUnbind ? (
              <>
                <span className="text-xs text-muted-foreground">
                  {t('app.unbindNote')}
                </span>
                <Button variant="destructive" size="sm" disabled={busy} onClick={onUnbind}>
                  {busy ? <Loader2 className="animate-spin" /> : t('app.confirmUnbind')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmUnbind(false)}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmUnbind(true)}>
                {t('app.unbind')}
              </Button>
            )}
          </div>
        </>
      ) : lost ? (
        <>
          <div className="flex items-start gap-2.5 border-l-2 border-amber-500 pl-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <div className="space-y-0.5 text-sm">
              <p className="font-semibold">{app.lostMessage ?? t('app.lostFallback')}</p>
              <p className="text-xs text-muted-foreground">
                {t('app.lostNote')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {app.installUrl && (
              <Button asChild>
                <a href={app.installUrl}>{t('app.reinstall')}</a>
              </Button>
            )}
            {app.authorizeUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={app.authorizeUrl}>{t('app.reauthorize')}</a>
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRecheck}>
              {busy ? <Loader2 className="animate-spin" /> : t('app.recheck')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {noRepo ? (
              <>{t('app.needRepo')}</>
            ) : (
              <>{t.rich('app.installExplain', { login: botLogin, b })}</>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {noRepo || !app.installUrl ? (
              <Button disabled>{t('app.install')}</Button>
            ) : (
              <Button asChild>
                <a href={app.installUrl}>{t('app.install')}</a>
              </Button>
            )}
            {app.authorizeUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={app.authorizeUrl}>{t('app.alreadyInstalled')}</a>
              </Button>
            )}
          </div>
        </>
      )}

      {status && (
        <p className={cn('text-xs', status.kind === 'error' ? 'text-destructive' : 'text-brand-strong')}>
          {status.message}
        </p>
      )}
    </section>
  );
}

/** 설치 콜백 결과 한 줄. 성공·진행 중·실패를 색으로 가른다 */
function Banner({ status }: { status: NonNullable<Status> }) {
  return (
    <div
      role="status"
      className={cn(
        'border-l-2 pl-3 text-sm',
        status.kind === 'ok' && 'border-primary text-foreground',
        status.kind === 'info' && 'border-border-strong text-foreground',
        status.kind === 'error' && 'border-destructive text-destructive',
      )}
    >
      {status.message}
    </div>
  );
}

function repoLabel(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\/$/, '');
}
