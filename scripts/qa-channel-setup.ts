/**
 * 테스트 전용 봇에 채널톡 설정을 **직접** 심는다. 검증 전용이다.
 *
 * `PATCH /api/bots/:id/channel` 은 저장 전에 `verifyCredentials()` 로 실제 채널톡 API 를
 * 두드린다. 그 경로는 2026-09-10 실계정 검증에서 이미 통과했고(실측기록 참고), 수용 기준
 * 1~44 중 그 라우트를 겨냥하는 항목(7)은 **인증이 자격증명 검사보다 앞**이라 가짜 키로도
 * 그대로 잰다. 그래서 여기서는 저장 결과만 재현한다 — 실계정 키 없이 웹훅 경로를 열려고.
 *
 *   npx tsx scripts/qa-channel-setup.ts <botId>
 *
 * 출력: 웹훅 토큰 한 줄.
 */
import { config } from 'dotenv';
// override 를 쓰지 않는다 — Next dev 도 process env 를 .env.local 보다 우선하므로
// 이쪽이 서버와 같은 해석이다. quiet: 배너가 stdout 으로 나가면 출력을 오염시킨다.
config({ path: '.env.local', quiet: true });

import { createClient } from '@supabase/supabase-js';


const botId = process.argv[2];
if (!botId) throw new Error('사용법: npx tsx scripts/qa-channel-setup.ts <botId>');

/** 가짜 값이다. 실제 채널톡 API 호출은 이 스크립트가 만든 설정으로 성공하지 않는다. */
const FAKE_ACCESS_KEY = 'QA-ACCESS-KEY-00000000';
const FAKE_ACCESS_SECRET = 'TESTSECRET-a1b2c3';
const CHANNEL_SLUG = 'qa-test-channel';
const CHANNEL_ID = '999999';
const BOT_NAME = '[TEST] 채널톡 검증';

async function main() {
  // ⚠️ **정적 import 로 가져오면 안 된다.** `crypto.ts` 가 `AES_KEY` 를 **모듈 로드 시점**에
  // 잡는데, ESM 은 import 를 본문(위 `config()`)보다 먼저 평가한다. 정적으로 부르면 키가
  // 아직 없는 채로 굳어 「AES key is not set」이 난다 — .env.local 에 값이 멀쩡히 있는데도.
  const { encrypt } = await import('../src/lib/utils/crypto');
  const { generateWebhookToken } = await import('../src/lib/channel/verify');

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const token = generateWebhookToken();

  const { error } = await db
    .from('bots')
    .update({
      channel_access_key_encrypted: encrypt(FAKE_ACCESS_KEY),
      channel_access_secret_encrypted: encrypt(FAKE_ACCESS_SECRET),
      channel_webhook_token_encrypted: encrypt(token),
      channel_slug: CHANNEL_SLUG,
      channel_id: CHANNEL_ID,
      channel_bot_name: BOT_NAME,
    })
    .eq('id', botId);

  if (error) throw new Error(`설정 실패: ${error.message}`);
  process.stdout.write(token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
