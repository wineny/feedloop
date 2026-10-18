// GitHub App 웹훅 수신 — 설치 제거·정지·레포 제외를 봇에 적는다 (안 B).
//
// 지키는 것:
//  1. 서명(`X-Hub-Signature-256`)이 맞지 않으면 아무것도 안 한다. 시크릿이 없으면 «전부 거절»(503) —
//     서명 없이 받으면 누구나 installation id 를 넣어 남의 봇 연결을 끊을 수 있다
//  2. 원문 바디로 검증한다(`req.text()`). JSON 으로 파싱한 뒤 다시 직렬화하면 서명이 안 맞는다
//  3. 처리기는 «상태만» 쓴다 — 재전송이 와도 결과가 같다(lib/github/installation-events.ts)
//  4. 항상 빨리 200/204 — GitHub 은 10초 넘으면 실패로 기록한다. 처리 실패는 500 으로 돌려 재전송을 받는다

import { NextResponse } from 'next/server';
import { getServiceRoleClient } from '@/lib/supabase';
import { readWebhookSecret, verifyWebhookSignature } from '@/lib/github/app';
import {
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  type BotsTable,
  type InstallationPayload,
} from '@/lib/github/installation-events';

export const dynamic = 'force-dynamic';

/** 설치 이벤트는 레포 목록을 싣는다 — 「All repositories」 큰 조직이면 수백 KB. 2MB 면 넉넉하다 */
const BODY_MAX = 2 * 1024 * 1024;

export async function POST(req: Request) {
  // **웹훅 시크릿만 본다.** `readGithubAppConfig()` 는 OAuth 클라이언트 자격까지 요구하는데, 그건 설치 콜백의
  // 준비물이지 서명 검증과는 무관하다 — 그걸로 막으면 시크릿이 멀쩡한 배포가 모든 웹훅에 503 을 준다(보안 리뷰 LOW)
  const webhookSecret = readWebhookSecret();
  if (!webhookSecret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }
  const len = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > BODY_MAX) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > BODY_MAX) {
    return NextResponse.json({ error: 'payload too large' }, { status: 413 });
  }
  if (!verifyWebhookSignature(webhookSecret, raw, req.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event') ?? '';
  if (event === 'ping') return NextResponse.json({ ok: true, event });

  let payload: InstallationPayload;
  try {
    payload = JSON.parse(raw) as InstallationPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const db = getServiceRoleClient() as unknown as BotsTable;
  try {
    if (event === 'installation') {
      const out = await handleInstallationEvent(db, payload);
      console.log('[github-webhook]', out);
      return NextResponse.json(out);
    }
    if (event === 'installation_repositories') {
      const out = await handleInstallationRepositoriesEvent(db, payload);
      console.log('[github-webhook]', out);
      return NextResponse.json(out);
    }
  } catch (err) {
    // 처리 중 DB 실패 — 500 을 주면 GitHub 이 «재전송하지 않는다»(수동 Redeliver 만). 그래도 200 으로 삼키면 흔적이 없다
    console.error('[github-webhook] handler failed', { event, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, event, ignored: true });
}
