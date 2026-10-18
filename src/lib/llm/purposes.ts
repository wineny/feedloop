// 봇이 AI 를 쓰는 «자리»의 목록. 의존성 0 이다(models.ts·limits.ts 와 같은 이유).
//
// 이 파일이 있는 이유 하나: **운영자가 넣은 키가 언제 쓰이는지 화면이 말하지 못했다.**
// 키 화면은 줄곧 "이 키로 답합니다"만 말했는데 실제로는 답변 말고도 분류·묶기·요약이
// 같은 키로 돌았고, 정작 제일 비싼 수정안 생성은 «우리» 키로 돌았다. 운영자는 어느
// 쪽도 알 길이 없었다 — 청구서를 보고 나서야 알게 되는 구조였다.
//
// ⚠️ 여기 적힌 것은 «화면이 하는 말»이다. 실제 라우팅은 아직 갈리지 않는다 —
//    `provider.ts` 는 여전히 봇당 키 하나만 읽는다(베타 기간 결정, 2026-09-20 ny).
//    그래서 `open: false` 인 자리는 입력 자체를 막는다. 넣을 수 있게 해 놓고 저장만
//    안 하면, 화면이 「이 키로 분류합니다」라고 거짓말을 하게 된다.
//
// 단계 이름과 이모지는 대시보드 `LoopStages` 와 **같은 것을 쓴다**. 운영자가 이미
// 그 네 칸을 본 뒤에 이 화면에 오므로, 여기서 다른 말을 쓰면 같은 것을 두 번 배우게 된다.

export type LlmPurpose = 'reply' | 'organize' | 'fix';

export interface LlmPurposeSpec {
  key: LlmPurpose;
  /** 대시보드 루프의 어느 칸인가. `LoopStages` 의 라벨과 글자까지 같다 */
  stage: string;
  emoji: string;
  /** 이 자리가 하는 일 — 시스템 용어가 아니라 운영자가 아는 말로 */
  title: string;
  /** 무슨 일이 언제 벌어지는지. 한 문장 */
  what: string;
  /** 모델을 고르는 기준. **재본 것만 단정한다** */
  guide: string;
  /** 지금 운영자가 자기 키를 넣을 수 있는 자리인가 */
  open: boolean;
}

export const LLM_PURPOSES: readonly LlmPurposeSpec[] = [
  {
    key: 'reply',
    stage: '들어온 피드백',
    emoji: '/emoji/mailbox_3d.png',
    title: '고객에게 답하기',
    what: '방문자가 위젯이나 채널에 말을 걸면 그 자리에서 답합니다. 사람을 기다리게 할 수 없어 10초 안에 끝나야 해요.',
    // models.ts §I-08 실측(2026-09-10·09-12). 「저가 모델은 지식이 늘면 이 규칙을 자주 놓친다」가
    // 우리가 실제로 잰 것이다 — 그 이상으로 단정하지 않는다.
    guide: '빠르고 저렴한 모델이 어울리는 자리예요. 다만 답변 지식이 많아질수록, 모르는 것을 지어내지 않고 담당자에게 넘기는 규칙을 저렴한 모델이 놓치는 일이 있었습니다.',
    open: true,
  },
  {
    key: 'organize',
    stage: 'AI 가 분류',
    emoji: '/emoji/card_index_dividers_3d.png',
    title: '피드백 정리하기',
    what: '들어온 피드백을 갈래별로 나누고 같은 문제끼리 묶습니다. 한 번에 수십 건을 함께 읽어요.',
    // 묶기 품질은 아직 모델별로 재보지 않았다. 「입력이 크다」는 사실만 말하고
    // 「중급 이상을 써야 한다」는 단정은 재본 뒤에 적는다.
    guide: '한 번에 읽는 양이 답변 때보다 훨씬 많은 자리라, 저렴한 모델은 놓치는 것이 생기기 쉽습니다.',
    open: false,
  },
  {
    key: 'fix',
    stage: '수정안',
    emoji: '/emoji/hammer_and_wrench_3d.png',
    title: '수정안 만들기',
    what: '묶인 문제를 실제 코드 수정안(PR)으로 만듭니다. 저장소를 읽고 고쳐 쓰는 가장 무거운 작업이에요.',
    guide: '코드를 읽고 직접 고쳐 쓰기 때문에 가장 좋은 모델이 필요한 자리입니다.',
    open: false,
  },
] as const;

/** 설정이 붙지 않는 마지막 칸. 루프를 끊지 않으려고 화면에 같이 그린다. */
export const LOOP_CLOSING_STAGE = {
  stage: '반영 알림',
  emoji: '/emoji/love_letter_3d.png',
  what: '고친 내용을 처음 말해 준 사람에게 돌려줍니다. 정해진 문장을 쓰기 때문에 AI 를 거의 쓰지 않아요.',
} as const;
