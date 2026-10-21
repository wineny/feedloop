// 「화면에서 선택하기」 스크린샷 저장소 (I-55, 2026-09-25). 기획: docs/07-위젯/화면에서-선택-스크린샷-기획-2026-09-25.md
//
// 흐름: 위젯이 짚는 순간 뷰포트를 찍어 무인증 라우트로 올린다(storeShot) → 방문자가 메시지를 보내면
// messages POST 가 그 shotId 를 «같은 봇·같은 방문자·아직 안 붙은» 조건으로 메시지에 붙인다(attachShot)
// → 운영자 화면이 소유 확인 뒤 10분짜리 서명 URL 로 본다(signShotsForMessages).
//
// 원칙
// - 이미지 URL 은 방문자에게 절대 돌려주지 않는다. 업로드 응답은 shotId 하나다.
// - 이미지는 LLM 프롬프트·PR 본문·알림 메일에 싣지 않는다(PR 은 공개 레포일 수 있다).
// - DB CASCADE 는 Storage 객체를 안 지운다 — 봇 삭제 전 removeBotShots, 하루 1회 cleanupShots.

import { randomUUID } from 'node:crypto';
import { getServiceRoleClient } from '@/lib/supabase';
import { shotExtension, type ShotImageInfo } from './shot-image';
import type { PickedShotView } from './pick';
import { pickedFromContext, type PickedShotData } from './picked-shot';
import type { Locale } from '@/i18n/routing';

export const SHOT_BUCKET = 'widget-shots';
/** 방문자 한 명이 1분에 올릴 수 있는 장수 */
export const VISITOR_SHOTS_PER_MIN = 5;
/** 봇 하나가 하루(최근 24시간) 받을 수 있는 장수. 평균 크기를 첫 주에 재고 조정한다(기획 §8) */
export const BOT_SHOTS_PER_DAY = 300;
/** 보존 기간(ny 결정 2026-09-25) */
export const SHOT_RETENTION_DAYS = 90;
/** 업로드했는데 보내지 않은 것을 치우는 기준 */
export const ORPHAN_AFTER_MS = 24 * 3_600_000;
/** 운영자 화면 서명 URL 수명 */
export const SIGNED_URL_TTL_SEC = 600;

const db = () => getServiceRoleClient();

export type ShotRateLimit = 'visitor' | 'bot';

/**
 * 업로드 속도 판정. 계수가 실패하면 **막는다**(fail-closed) — 위젯 메시지 계수와 반대다.
 * 여기서 막혀도 방문자는 잃는 게 없다(위젯이 「위치만」 보낸다). 반면 열어 두면 저장 비용이 샌다.
 */
export async function checkShotRate(botId: string, visitorId: string): Promise<ShotRateLimit | null> {
  try {
    const now = Date.now();
    const [visitor, bot] = await Promise.all([
      db()
        .from('widget_shots')
        .select('id', { count: 'exact', head: true })
        .eq('bot_id', botId)
        .eq('visitor_id', visitorId)
        .gte('created_at', new Date(now - 60_000).toISOString()),
      db()
        .from('widget_shots')
        .select('id', { count: 'exact', head: true })
        .eq('bot_id', botId)
        .gte('created_at', new Date(now - 24 * 3_600_000).toISOString()),
    ]);
    if (visitor.error || bot.error) {
      console.error('[shots] 계수 실패', { botId, message: (visitor.error ?? bot.error)?.message });
      return 'bot';
    }
    if ((visitor.count ?? 0) >= VISITOR_SHOTS_PER_MIN) return 'visitor';
    if ((bot.count ?? 0) >= BOT_SHOTS_PER_DAY) return 'bot';
    return null;
  } catch (err) {
    console.error('[shots] 계수가 던졌다', { botId, message: err instanceof Error ? err.message : 'unknown' });
    return 'bot';
  }
}

/** 저장 경로 `{botId}/{yyyy-mm}/{shotId}.{ext}` — 봇 단위로 지울 수 있게 봇이 맨 앞이다 */
export function shotPath(botId: string, shotId: string, info: Pick<ShotImageInfo, 'mime'>, at = new Date()): string {
  const ym = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${botId}/${ym}/${shotId}.${shotExtension(info.mime)}`;
}

export type StoreShotResult = { ok: true; id: string } | { ok: false; limit: ShotRateLimit } | { ok: false; limit: null };

/**
 * 행을 «먼저» 예약하고(잠금 안에서 세고 INSERT — reserve_widget_shot) 객체를 올린다. 보안 리뷰 M1·L1:
 * 예전엔 센 뒤 업로드·INSERT 까지 수 초의 창이 있어 동시 요청이 상한을 통째로 넘었고, 업로드 뒤 INSERT 전에
 * 함수가 죽으면 행 없는 객체(정리 단계가 영영 못 찾는 것)가 남았다. 이제 업로드가 실패하면 예약 행을 지우고,
 * 함수가 도중에 죽어도 행이 남아 정리 단계가 치운다.
 */
export async function storeShot(params: {
  botId: string;
  visitorId: string;
  bytes: Uint8Array;
  info: ShotImageInfo;
}): Promise<StoreShotResult> {
  const id = randomUUID();
  const path = shotPath(params.botId, id, params.info);
  const client = db();
  try {
    const { data: verdict, error: rErr } = await client.rpc('reserve_widget_shot', {
      p_id: id,
      p_bot: params.botId,
      p_visitor: params.visitorId,
      p_path: path,
      p_mime: params.info.mime,
      p_bytes: params.bytes.length,
      p_width: params.info.width,
      p_height: params.info.height,
      p_visitor_limit: VISITOR_SHOTS_PER_MIN,
      p_bot_limit: BOT_SHOTS_PER_DAY,
    });
    if (rErr) {
      console.error('[shots] 예약 실패', { botId: params.botId, message: rErr.message });
      return { ok: false, limit: null };
    }
    if (verdict === 'visitor' || verdict === 'bot') return { ok: false, limit: verdict };
    const up = await client.storage
      .from(SHOT_BUCKET)
      .upload(path, params.bytes, { contentType: params.info.mime, upsert: false });
    if (up.error) {
      console.error('[shots] 업로드 실패', { botId: params.botId, message: up.error.message });
      await client.from('widget_shots').delete().eq('id', id);
      return { ok: false, limit: null };
    }
    return { ok: true, id };
  } catch (err) {
    console.error('[shots] 저장이 던졌다', { botId: params.botId, message: err instanceof Error ? err.message : 'unknown' });
    // 예약한 뒤 업로드가 던졌으면 행도 거둔다(없는 행이면 0행 삭제 — 무해)
    await client.from('widget_shots').delete().eq('id', id).then(undefined, () => undefined);
    return { ok: false, limit: null };
  }
}

/**
 * 메시지에 shot 을 붙인다. **같은 봇 · 같은 방문자 · 아직 아무 메시지에도 안 붙은** 행만.
 * 남의 shotId(다른 방문자·다른 봇·이미 붙은 것)를 실어 보내면 0행 → false.
 */
export async function attachShot(params: {
  botId: string;
  visitorId: string;
  messageId: string;
  shotId: string;
}): Promise<boolean> {
  try {
    const { data, error } = await db()
      .from('widget_shots')
      .update({ message_id: params.messageId })
      .eq('id', params.shotId)
      .eq('bot_id', params.botId)
      .eq('visitor_id', params.visitorId)
      .is('message_id', null)
      .select('id');
    if (error) {
      console.error('[shots] 붙이기 실패', { botId: params.botId, message: error.message });
      return false;
    }
    return (data ?? []).length === 1;
  } catch (err) {
    console.error('[shots] 붙이기가 던졌다', { message: err instanceof Error ? err.message : 'unknown' });
    return false;
  }
}

/**
 * 붙이지 못한 shotId 를 메시지 context 에서 뗀다. 남겨 두면 운영자 화면이 「화면을 불러오지 못했어요」를
 * 띄운다 — 처음부터 없던 것과 구별이 안 된다. 실패해도 조용히 끝낸다(표시는 message_id 로 찾으므로
 * 남의 이미지가 보이는 경로는 어차피 없다).
 */
export async function detachShotFromContext(messageId: string, context: Record<string, unknown>): Promise<void> {
  const target = context.target as Record<string, unknown> | undefined;
  if (!target || !('shot' in target)) return;
  const { shot: _drop, ...rest } = target;
  void _drop;
  try {
    const { error } = await db()
      .from('messages')
      .update({ context: { ...context, target: rest } })
      .eq('id', messageId);
    if (error) console.error('[shots] shot 떼기 실패', { messageId, message: error.message });
  } catch {
    /* 표시는 message_id 로 찾으므로 여기 실패는 무해 */
  }
}

/**
 * 메시지 저장 «뒤»에 부른다. context 에 shot 이 있으면 붙이고, 못 붙이면 context 에서 뗀다.
 * messages·escalate 두 라우트가 같은 규칙을 쓴다.
 */
export async function settleMessageShot(params: {
  botId: string;
  visitorId: string;
  messageId: string;
  context: { target?: { shot?: string } } | null | undefined;
}): Promise<void> {
  const shotId = params.context?.target?.shot;
  if (!shotId || !params.context) return;
  const attached = await attachShot({ botId: params.botId, visitorId: params.visitorId, messageId: params.messageId, shotId });
  if (!attached) await detachShotFromContext(params.messageId, params.context as Record<string, unknown>);
}

/**
 * 운영자 화면용 — 메시지 id 들에 붙은 shot 의 서명 URL. **호출부가 소유 확인을 끝낸 뒤에만** 부른다.
 * 실패하면 빈 객체(화면은 미니맵으로 폴백한다).
 */
export async function signShotsForMessages(
  messageIds: string[],
  botIds: string[],
): Promise<Record<string, PickedShotView>> {
  const ids = [...new Set(messageIds)].filter(Boolean).slice(0, 500);
  // 봇 범위를 함께 받는다(보안 리뷰 L2) — 호출부가 소유 확인을 빠뜨려도 남의 봇 이미지는 서명되지 않게
  if (ids.length === 0 || botIds.length === 0) return {};
  try {
    const client = db();
    const { data, error } = await client
      .from('widget_shots')
      .select('message_id, storage_path, width, height')
      .in('message_id', ids)
      .in('bot_id', botIds);
    if (error || !data || data.length === 0) {
      if (error) console.error('[shots] 조회 실패', { message: error.message });
      return {};
    }
    const rows = data as { message_id: string; storage_path: string; width: number; height: number }[];
    const signed = await client.storage
      .from(SHOT_BUCKET)
      .createSignedUrls(
        rows.map((r) => r.storage_path),
        SIGNED_URL_TTL_SEC,
      );
    if (signed.error || !signed.data) {
      console.error('[shots] 서명 실패', { message: signed.error?.message });
      return {};
    }
    const byPath = new Map(signed.data.map((s) => [s.path, s.signedUrl]));
    const out: Record<string, PickedShotView> = {};
    for (const r of rows) {
      const url = byPath.get(r.storage_path);
      if (url) out[r.message_id] = { url, width: r.width, height: r.height };
    }
    return out;
  } catch (err) {
    console.error('[shots] 서명이 던졌다', { message: err instanceof Error ? err.message : 'unknown' });
    return {};
  }
}

async function removeObjects(paths: string[]): Promise<boolean> {
  const client = db();
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await client.storage.from(SHOT_BUCKET).remove(paths.slice(i, i + 100));
    if (error) {
      console.error('[shots] 객체 삭제 실패', { message: error.message });
      return false;
    }
  }
  return true;
}

/**
 * 봇 삭제 «전»에 부른다. 행(CASCADE 대상)에서 경로를 읽어 객체를 지운다.
 * 실패하면 false — 삭제 라우트가 봇을 지우지 않고 500 을 낸다(지우고 나면 경로를 알 길이 없다).
 */
export async function removeBotShots(botId: string): Promise<boolean> {
  try {
    const { data, error } = await db().from('widget_shots').select('storage_path').eq('bot_id', botId);
    if (error) {
      console.error('[shots] 봇 경로 조회 실패', { botId, message: error.message });
      return false;
    }
    const paths = (data ?? []).map((r) => (r as { storage_path: string }).storage_path);
    if (paths.length === 0) return true;
    return await removeObjects(paths);
  } catch (err) {
    console.error('[shots] 봇 정리가 던졌다', { botId, message: err instanceof Error ? err.message : 'unknown' });
    return false;
  }
}

/**
 * 봇 행을 지운 «뒤»에 부른다(보안 리뷰 L1 ②). removeBotShots 와 삭제 사이에 들어온 업로드는 행이 CASCADE 로
 * 사라져 경로를 잃는다 — 그 봇 접두사 아래를 목록으로 한 번 더 비운다. 실패해도 조용히 끝낸다(봇은 이미 지워졌다).
 */
export async function sweepBotShotPrefix(botId: string): Promise<void> {
  try {
    const bucket = db().storage.from(SHOT_BUCKET);
    const { data: months } = await bucket.list(botId, { limit: 1000 });
    for (const m of months ?? []) {
      const dir = `${botId}/${m.name}`;
      const { data: files } = await bucket.list(dir, { limit: 1000 });
      const paths = (files ?? []).map((f) => `${dir}/${f.name}`);
      if (paths.length > 0) await removeObjects(paths);
    }
  } catch (err) {
    console.error('[shots] 봇 접두사 정리 실패', { botId, message: err instanceof Error ? err.message : 'unknown' });
  }
}

export interface ShotCleanupResult {
  orphans: number;
  expired: number;
  failed: boolean;
}

const CLEANUP_BATCH = 500;

/**
 * 하루 1회 정리(check-merged 크론 끝). 붙지 않은 지 24시간 된 고아 + 보존 90일 지난 것.
 * 객체를 먼저 지우고 행을 지운다 — 거꾸로 하면 객체 경로를 잃는다.
 */
export async function cleanupShots(now = Date.now(), budgetMs = 30_000): Promise<ShotCleanupResult> {
  const result: ShotCleanupResult = { orphans: 0, expired: 0, failed: false };
  const client = db();
  const passes: { kind: 'orphans' | 'expired'; build: () => PromiseLike<{ data: unknown; error: { message: string } | null }> }[] = [
    {
      kind: 'orphans',
      build: () =>
        client
          .from('widget_shots')
          .select('id, storage_path')
          .is('message_id', null)
          .lt('created_at', new Date(now - ORPHAN_AFTER_MS).toISOString())
          .order('created_at', { ascending: true })
          .limit(CLEANUP_BATCH),
    },
    {
      kind: 'expired',
      build: () =>
        client
          .from('widget_shots')
          .select('id, storage_path')
          .lt('created_at', new Date(now - SHOT_RETENTION_DAYS * 86_400_000).toISOString())
          .order('created_at', { ascending: true })
          .limit(CLEANUP_BATCH),
    },
  ];
  // 빌 때까지 반복하되 시간 예산 안에서(보안 리뷰 M2) — 하루 500건 상한이면 적체가 끝없이 자랄 수 있었다
  const deadline = Date.now() + budgetMs;
  for (const pass of passes) {
    while (Date.now() < deadline) {
      try {
        const { data, error } = await pass.build();
        if (error) {
          console.error('[shots] 정리 조회 실패', { kind: pass.kind, message: error.message });
          result.failed = true;
          break;
        }
        const rows = (data ?? []) as { id: string; storage_path: string }[];
        if (rows.length === 0) break;
        if (!(await removeObjects(rows.map((r) => r.storage_path)))) {
          result.failed = true;
          break;
        }
        const del = await client
          .from('widget_shots')
          .delete()
          .in(
            'id',
            rows.map((r) => r.id),
          );
        if (del.error) {
          console.error('[shots] 정리 행 삭제 실패', { kind: pass.kind, message: del.error.message });
          result.failed = true;
          break;
        }
        result[pass.kind] += rows.length;
        if (rows.length < CLEANUP_BATCH) break;
      } catch (err) {
        console.error('[shots] 정리가 던졌다', { kind: pass.kind, message: err instanceof Error ? err.message : 'unknown' });
        result.failed = true;
        break;
      }
    }
  }
  return result;
}

/**
 * 「수정안」 근거 칸용 — 이 실행의 근거 제보 중 화면에서 짚은 것(최대 3개, 찍은 화면이 있는 것 먼저).
 * 호출부(runs/[id]/pr)가 loadOwnedRun 으로 소유 확인을 끝낸 뒤에만 부른다. 실패하면 빈 배열.
 */
export async function loadRunPickedShots(run: {
  botId: string;
  groupId: string | null;
  insightId: string | null;
}, limit = 3, locale: Locale = 'ko'): Promise<PickedShotData[]> {
  if (!run.groupId && !run.insightId) return [];
  try {
    const client = db();
    let q = client.from('insights').select('message_id, source_message_ids').eq('bot_id', run.botId);
    q = run.groupId ? q.eq('group_id', run.groupId) : q.eq('id', run.insightId as string);
    const { data: ins, error } = await q.limit(50);
    if (error || !ins) return [];
    const ids = new Set<string>();
    for (const r of ins as { message_id: string | null; source_message_ids: string[] | null }[]) {
      if (r.message_id) ids.add(r.message_id);
      for (const m of r.source_message_ids ?? []) ids.add(m);
    }
    if (ids.size === 0) return [];
    const { data: msgs, error: mErr } = await client
      .from('messages')
      .select('id, context, detected_at')
      .eq('bot_id', run.botId)
      .in('id', [...ids].slice(0, 200))
      .not('context', 'is', null);
    if (mErr || !msgs) return [];
    const withTarget = (msgs as { id: string; context: { target?: { shot?: string } } | null; detected_at: string }[]).filter(
      (m) => m.context?.target,
    );
    const shots = await signShotsForMessages(
      withTarget.filter((m) => m.context?.target?.shot).map((m) => m.id),
      [run.botId],
    );
    return withTarget
      .map((m) => pickedFromContext(m.context, shots[m.id], m.detected_at, locale))
      .filter((d): d is PickedShotData => d !== null)
      .sort((a, b) => Number(Boolean(b.shot)) - Number(Boolean(a.shot)))
      .slice(0, limit);
  } catch (err) {
    console.error('[shots] 실행 근거 조회가 던졌다', { message: err instanceof Error ? err.message : 'unknown' });
    return [];
  }
}
