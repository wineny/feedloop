/**
 * 로컬 dev 서버용 next-auth 세션 쿠키를 발급한다. **검증 전용**이다.
 *
 * 브라우저 로그인 없이 인증 라우트를 curl 로 치려고 만들었다. 프로덕션 배포에는
 * 아무 영향이 없다 — 서명에 쓰는 `NEXTAUTH_SECRET` 을 가진 사람만 만들 수 있고,
 * 그 시크릿을 가졌다면 이미 무엇이든 할 수 있다.
 *
 *   npx tsx scripts/qa-token.ts            # 쿠키 한 줄 (Cookie 헤더에 그대로)
 *   npx tsx scripts/qa-token.ts --raw      # JWT 만
 */
import { config } from 'dotenv';
import { encode } from 'next-auth/jwt';

// override 를 쓰지 않는다 — Next dev 도 process env 를 .env.local 보다 우선하므로
// 이쪽이 서버와 같은 해석이다. quiet: 배너가 stdout 으로 나가면 출력을 오염시킨다.
config({ path: '.env.local', quiet: true });

/** ny 의 `public.users.id`. `jwt` 콜백이 `token.sub` 에 넣는 값과 같아야 한다. */
const USER_ID = process.env.QA_USER_ID ?? '654c57f8-d0f7-4d4d-baab-33f1740cbb27';

async function main() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET 이 없다 (.env.local 확인)');

  const jwt = await encode({
    token: { sub: USER_ID, name: 'QA', email: 'qa@local' },
    secret,
    maxAge: 60 * 60,
  });

  // dev 는 http 라 `__Secure-` 접두사가 붙지 않는다.
  process.stdout.write(process.argv.includes('--raw') ? jwt : `next-auth.session-token=${jwt}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
