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

import { Suspense, useCallback, useEffect, useState } from 'react';
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
import {
  callbackBanner,
  type CallbackBanner,
  type GithubAppState,
} from '@/lib/github/app-state-types';

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

// ── 설치 콜백 결과 ────────────────────────────────────────
//
// /api/github/app/callback 이 판정을 끝내고 `?app=<결과>` 로 되돌려보낸다. 한 번만 띄우고 주소에서 지운다 —
// 안 지우면 새로고침할 때마다 「연결했어요」가 다시 뜬다.


/** 「설치 확인」 결과. `ok` 말고는 전부 운영자가 GitHub 에서 뭔가를 해야 한다는 뜻이다 */
function recheckBanner(kind: string | undefined): Status {
  switch (kind) {
    case 'ok':
      return { kind: 'ok', message: '설치가 그대로 있어요. 이 저장소에 PR 을 열 수 있어요' };
    case 'no_repo':
      return { kind: 'error', message: '고칠 저장소가 없어 확인할 수 없어요. 저장소를 먼저 연결해 주세요' };
    case 'not_bound':
      return { kind: 'error', message: '아직 이 봇과 묶이지 않았어요. 위 버튼으로 설치를 진행해 주세요' };
    case 'missing':
      return { kind: 'error', message: '이 저장소에서 Feedloop 앱 설치를 찾지 못했어요. 다시 설치해 주세요' };
    case 'suspended':
      return { kind: 'error', message: '앱이 일시 정지 상태예요. GitHub 설치 관리에서 정지를 풀어 주세요' };
    case 'changed':
      return { kind: 'error', message: '이 저장소에 다른 설치가 있어요. 「다시 설치하기」로 이 봇과 묶어 주세요' };
    default:
      return { kind: 'error', message: '확인 결과를 알 수 없어요. 잠시 후 다시 시도해 주세요' };
  }
}

/**
 * 설치 뒤 되돌아온 결과를 한 번 읽고 주소에서 지운다.
 * `tab=github` 은 남긴다 — 지우면 지금 보고 있는 탭이 「답변 지식」으로 되돌아간다.
 */
function useInstallCallbackBanner(): CallbackBanner | null {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('app');
  // 마운트 시점에 «한 번» 읽어 들고 있는다. 아래에서 주소의 `app` 을 지워도 이 값은 남아 화면에 뜬다 —
  // 렌더 때마다 다시 읽으면 주소를 지우는 순간 안내가 같이 사라져 아무도 결과를 못 본다.
  const [banner] = useState<CallbackBanner | null>(() => callbackBanner(raw));

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
          setStatus({ kind: 'error', message: data?.error ?? 'GitHub 에 확인하지 못했어요' });
          return;
        }
        if (data) {
          setApp(data);
          setStatus(onOk(data));
        }
      } catch {
        setStatus({ kind: 'error', message: '네트워크 오류로 확인하지 못했어요' });
      } finally {
        setBusy(false);
      }
    },
    [botId],
  );

  const recheck = useCallback(() => call('POST', (data) => recheckBanner(data.recheck)), [call]);
  const unbind = useCallback(
    () =>
      call('DELETE', () => ({
        kind: 'ok',
        message: '연결을 풀었어요. GitHub 쪽 설치는 그대로 남아 있어요',
      })),
    [call],
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
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> 불러오는 중…
    </p>
  );
}

function GithubConnectionForm({ botId, serviceName }: GithubTokenFormProps) {
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
    return <p className="py-6 text-sm text-destructive">GitHub 연결 설정을 불러오지 못했습니다. 새로고침해 주세요.</p>;
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
        setStatus({ kind: 'error', message: data?.error ?? '저장하지 못했습니다' });
        return;
      }
      if (data) setState(data);
      setBroadScopes(data?.broadScopes ?? null);
      setToken('');
      setConfirmRemove(false);
      setEditing(!data?.hasToken);
      setStatus({ kind: 'ok', message: okMessage });
    } catch {
      setStatus({ kind: 'error', message: '네트워크 오류로 저장하지 못했습니다' });
    } finally {
      setBusy(false);
    }
  }

  const saveToken = () =>
    send(
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) },
      state?.repoUrl
        ? '토큰을 확인하고 저장했어요. 지금부터 이 계정으로 PR 을 엽니다'
        : '토큰을 확인하고 저장했어요. 저장소를 연결하면 이 계정으로 PR 을 엽니다',
    );
  const removeToken = () => send({ method: 'DELETE' }, '토큰을 제거했어요. 이제 Feedloop 공용 계정으로 시도합니다');

  return (
    <div className="flex max-w-[660px] flex-col gap-6">
      <p className="text-sm leading-relaxed text-muted-foreground">
        {state.repoUrl ? (
          <>
            수정안은 <b className="font-semibold text-foreground">{repoLabel(state.repoUrl)}</b> 에 열립니다.
          </>
        ) : (
          <>아직 고칠 저장소가 없어요. 저장소를 등록하면 그 저장소에 PR 을 엽니다.</>
        )}{' '}
        {appInstalled ? (
          <>
            지금은 <b className="font-semibold text-foreground">Feedloop 앱</b>이
            {app.botLogin ? <b className="font-semibold text-foreground"> {app.botLogin} </b> : ' 봇 '}
            이름으로 브랜치와 PR 을 만들어요.
          </>
        ) : state.hasToken ? (
          <>
            지금은 <b className="font-semibold text-foreground">내 GitHub 계정</b>으로 브랜치와 PR 을 만들어요.
          </>
        ) : state.platformFallback ? (
          <>
            연결이 없으면 <b className="font-semibold text-foreground">Feedloop 공용 계정</b>으로 시도해요 — 그 계정을
            협업자로 초대한 저장소에서만 됩니다. 아래에서 연결하면 초대 없이 내 저장소에 바로 PR 을 열어요.
          </>
        ) : (
          <>연결이 없으면 PR 을 만들 수 없어요.</>
        )}
      </p>

      {installBanner && <Banner status={installBanner} />}

      {appOn && (
        <GithubAppSection app={app} busy={appBusy} status={appStatus} onRecheck={recheck} onUnbind={unbind} />
      )}

      {appOn && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">직접 토큰으로 연결 (대안)</h2>
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
                {patOpen ? '토큰 설정 접기' : '토큰 설정 보기'}
              </Button>
            )}
          </div>
          {!patPinned && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {appInstalled
                ? '앱 설치가 있으면 앱이 우선해요. 토큰은 앱이 닿지 않는 저장소(옛 PR)나, 앱으로 안 될 때만 쓰여요.'
                : '위의 앱 설치를 권해요. 조직 정책 등으로 앱을 설치할 수 없을 때만 토큰을 넣으세요.'}
            </p>
          )}
        </div>
      )}

      {/* 토큰이 실패했으면 접혀 있어도 보여준다 — 「GitHub 토큰 확인 필요」 배지를 누르고 온 자리다 */}
      {state.failedAt && !editing && (
        <div className="flex items-start gap-2.5 border-l-2 border-destructive pl-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-0.5 text-sm">
            <p className="font-semibold text-destructive">{state.failedReason ?? '마지막 GitHub 호출이 실패했어요'}</p>
            <p className="text-xs text-muted-foreground">
              토큰이 만료됐거나 저장소 권한이 바뀌었을 수 있어요. 새 토큰으로 교체하면 표시가 사라집니다.
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
                <b className="font-semibold">GitHub 토큰</b> ····{state.tokenLast4}
                {state.verifiedAt && (
                  <span className="ml-2 text-xs text-muted-foreground">{formatDate(state.verifiedAt)} 확인</span>
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
                토큰 교체
              </Button>
              {confirmRemove ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    {appInstalled
                      ? '제거해도 앱 설치는 그대로예요. 앱이 닿지 않는 저장소에서만 PR 을 못 만들게 됩니다.'
                      : '제거하면 공용 계정으로 돌아가요. 초대되지 않은 저장소면 PR 을 못 만들어요.'}
                  </span>
                  <Button variant="destructive" size="sm" disabled={busy} onClick={removeToken}>
                    {busy ? <Loader2 className="animate-spin" /> : '정말 제거'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(false)}>
                    취소
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  토큰 제거
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className={cn('flex flex-col gap-5', appOn ? 'pt-1' : 'border-t border-border pt-5')}>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">1. fine-grained 토큰을 발급해요</h3>
              <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
                <li>
                  <a
                    href={githubPatPrefillUrl(state.repoUrl, serviceName)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground underline underline-offset-4"
                  >
                    GitHub › Settings › Developer settings › Fine-grained tokens
                  </a>{' '}
                  에서 「Generate new token」 — 이 링크는 이름·권한·만료가 미리 채워진 채로 열려요
                </li>
                <li>
                  Repository access 는 <b className="font-semibold text-foreground">Only select repositories</b> 로 두고
                  {state.repoUrl ? <> {repoLabel(state.repoUrl)} 만</> : <> 고칠 저장소만</>} 고르세요
                </li>
                <li>
                  Permissions › Repository permissions 에서{' '}
                  <b className="font-semibold text-foreground">Contents</b> 와{' '}
                  <b className="font-semibold text-foreground">Pull requests</b> 를 각각{' '}
                  <b className="font-semibold text-foreground">Read and write</b> 로
                </li>
                <li>
                  (선택) <b className="font-semibold text-foreground">Deployments</b> ·{' '}
                  <b className="font-semibold text-foreground">Commit statuses</b> 를 Read 로 주면 「수정안」 화면에
                  프리뷰·빌드 상태도 보여요. 없으면 그 칸만 「모름」으로 뜹니다
                </li>
                <li>
                  내가 소유했거나 멤버인 저장소여야 해요. 협업자(collaborator)로만 초대된 저장소는 fine-grained 토큰으로 안
                  되고 classic 토큰(ghp_)이 필요해요
                </li>
              </ol>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">2. 토큰을 붙여 넣어요</h3>
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="github_pat_…"
                value={token}
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
                aria-label="GitHub 토큰"
              />
              {token && !formatCheck.ok && <p className="text-xs text-destructive">{formatCheck.error}</p>}
              <p className="text-xs leading-relaxed text-muted-foreground">
                저장하기 전에 GitHub 에 {state.repoUrl ? '이 저장소에 접근할 수 있는 토큰인지' : '유효한 토큰인지'}{' '}
                확인해요. 쓰기 권한은 첫 PR 에서 판정돼요. 토큰은 암호화해 보관하고 화면에는 마지막 4자만 남깁니다.
              </p>
            </section>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button onClick={saveToken} disabled={busy || !token || !formatCheck.ok}>
                {busy ? <Loader2 className="animate-spin" /> : '확인하고 저장'}
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
                  취소
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
              이 토큰은 계정 전체 저장소에 접근할 수 있는 종류예요{broadScopes ? ` (${broadScopes})` : ''}
            </p>
            <p className="text-xs text-muted-foreground">
              동작에는 문제없지만, 유출 시 피해 범위가 넓어요. 이 저장소만 고른 fine-grained
              토큰(github_pat_…)으로 바꾸는 걸 권해요.
            </p>
          </div>
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        {appInstalled ? (
          <>
            {serviceName} 봇이 만든 PR 은 {app.botLogin ?? '앱'} 이름으로 열려요.
          </>
        ) : (
          <>{serviceName} 봇이 만든 PR 은 이 토큰의 계정 이름으로 열려요.</>
        )}{' '}
        반영(머지)은 여전히 Feedloop 「수정안」 화면이나 GitHub 에서 사람이 합니다.
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
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const noRepo = !app.repoUrl;
  const lost = Boolean(app.lostAt);
  const botLogin = app.botLogin ?? 'Feedloop 봇';

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h2 className="text-sm font-semibold">
        Feedloop 앱 설치 <span className="ml-1 text-xs font-medium text-brand-strong">권장</span>
      </h2>

      {app.installed ? (
        <>
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-strong" aria-hidden />
            <span className="text-sm">
              <b className="font-semibold">Feedloop 앱으로 연결됨</b>
              {app.installationLogin && <span className="text-muted-foreground"> · @{app.installationLogin}</span>}
              {app.connectedAt && (
                <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(app.connectedAt)} 연결</span>
              )}
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            PR 은 <b className="font-semibold text-foreground">{botLogin}</b> 이름으로 열려요. 토큰을 만들거나 갱신할 일이
            없습니다.
            {app.connectedBy && <> 연결한 사람 @{app.connectedBy}.</>}
            {/* 우리가 쓰는 건 이 봇의 레포 하나지만, 계정 전체를 내준 상태라면 그 사실은 운영자가 알아야 한다(보안 리뷰 M3) */}
            {app.repositorySelection === 'all' && (
              <>
                {' '}
                이 설치는 <b className="font-semibold text-amber-700">계정의 모든 저장소</b>에 접근할 수 있어요. GitHub 설치
                관리에서 「Only select repositories」로 좁힐 수 있습니다.
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {app.manageUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={app.manageUrl} target="_blank" rel="noopener noreferrer">
                  GitHub 에서 설치 관리 →
                </a>
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRecheck}>
              {busy ? <Loader2 className="animate-spin" /> : '설치 확인'}
            </Button>
            {confirmUnbind ? (
              <>
                <span className="text-xs text-muted-foreground">
                  연결을 풀어도 GitHub 쪽 설치는 남아 있어요. 완전히 없애려면 설치 관리 화면에서 제거해 주세요.
                </span>
                <Button variant="destructive" size="sm" disabled={busy} onClick={onUnbind}>
                  {busy ? <Loader2 className="animate-spin" /> : '정말 풀기'}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmUnbind(false)}>
                  취소
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmUnbind(true)}>
                연결 풀기
              </Button>
            )}
          </div>
        </>
      ) : lost ? (
        <>
          <div className="flex items-start gap-2.5 border-l-2 border-amber-500 pl-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
            <div className="space-y-0.5 text-sm">
              <p className="font-semibold">{app.lostMessage ?? 'GitHub 앱 연결을 확인해 주세요'}</p>
              <p className="text-xs text-muted-foreground">
                다시 설치하면 이어서 씁니다. 그 사이에는 아래 토큰이나 Feedloop 공용 계정으로 시도해요.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {app.installUrl && (
              <Button asChild>
                <a href={app.installUrl}>다시 설치하기 →</a>
              </Button>
            )}
            {app.authorizeUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={app.authorizeUrl}>GitHub 에서 고쳤어요 · 다시 연결</a>
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRecheck}>
              {busy ? <Loader2 className="animate-spin" /> : '설치 확인'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {noRepo ? (
              <>고칠 저장소를 먼저 연결하면 설치할 수 있어요. 앱은 그 저장소 하나에만 붙습니다.</>
            ) : (
              <>
                설치 버튼을 누르면 GitHub 으로 갔다가 자동으로 돌아와요. 그 화면에서{' '}
                <b className="font-semibold text-foreground">고칠 저장소 하나</b>만 고르고 Install 을 누르면 끝이고, 토큰을
                만들어 복사·붙여 넣을 일이 없어요. PR 은{' '}
                <b className="font-semibold text-foreground">{botLogin}</b> 이름으로 열립니다. 권한은 그 저장소의
                Contents·Pull requests 읽기/쓰기와 Deployments·Commit statuses 읽기예요. 이 계정에 Feedloop 을 이미
                설치했다면(다른 서비스에서) 옆의 <b className="font-semibold text-foreground">연결하기</b>를 누르세요.
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {noRepo || !app.installUrl ? (
              <Button disabled>GitHub 에 Feedloop 설치하기 →</Button>
            ) : (
              <Button asChild>
                <a href={app.installUrl}>GitHub 에 Feedloop 설치하기 →</a>
              </Button>
            )}
            {app.authorizeUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={app.authorizeUrl}>이미 설치했어요 · 연결하기</a>
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** 연결 시각은 «언제 묶였나»를 사고 때 짚는 값이라 날짜만으론 부족하다 — 분까지, KST 로 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dateTimeFormatter.format(d);
}
