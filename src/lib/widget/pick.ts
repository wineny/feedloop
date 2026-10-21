// 위젯 「화면에서 짚기」 — 방문자가 호스트 페이지에서 요소를 골라 제보에 붙인다 (백로그 B3, 2026-09-16).
//
// 이 파일은 의존성 0 이다. 서버(context.ts 정규화·프롬프트)와 운영자 미리보기(React)와
// 인박스 화면이 같이 본다. `public/widget.js`·`widget-pick.js` 는 import 를 못 하므로
// 같은 문구·같은 라벨 규칙을 리터럴로 들고 있고, __tests__/widget-pick.test.ts 가 둘을 대조한다.

/** 입력창 위 도구 칩. 이모지만으로는 뜻이 안 잡힌다는 ny 지적으로 글자 라벨 — 문구는 ny 가 정했다(2026-09-16) */
export const PICK_LABEL = '화면에서 선택하기';
/** 오버레이 상단 배너 */
export const PICK_BANNER = '고칠 부분을 눌러 주세요';
export const PICK_CANCEL_LABEL = '취소';

/** 방문자가 짚은 요소. 위젯이 보낸 모양 그대로 — 서버는 sanitizeTarget 으로 상한·마스킹을 건다 */
export interface WidgetTarget {
  /** 요소 종류 — 방문자에게 보여줄 말(버튼·링크·입력칸·이미지·영역) */
  kind: string;
  /** 태그 이름(소문자) */
  tag: string;
  /** 요소를 다시 찾을 CSS 셀렉터 (data-testid > id > 태그·클래스·nth-of-type 경로) */
  selector: string;
  /** 요소 안의 글자(앞 120자). 버튼 라벨이 곧 이 값이다 */
  text?: string;
  /** aria-label · placeholder · alt · 가장 가까운 헤딩/라벨 — 글자가 없는 요소의 이름 */
  label?: string;
  /** 조상 태그 경로 `main > section > form > button` — 어느 구역인지 */
  path?: string;
  /** outerHTML 앞 600자. 클래스명·data 속성이 엔진의 파일 선정 단서다 */
  html?: string;
  /** 뷰포트 기준 위치·크기(px, 정수) */
  rect?: { x: number; y: number; w: number; h: number };
  /** 짚은 시점의 페이지 URL — 위젯을 «연» 페이지와 다를 수 있다 */
  url?: string;
  /**
   * 큰 「영역」의 이름 (I-55, 2026-09-25). 안의 글자가 40자를 넘는 영역이면 위젯이 가장 가까운 헤딩
   * (자기 안의 첫 h1~h3 → 조상 section 의 헤딩)을, 없으면 조상 경로 꼬리를 싣는다. 있으면 라벨이
   * 「「오늘의 널널 PICK」 구역 · 1120×973」 이 된다. `label`(aria-label 등)과 뜻이 달라 칸을 따로 둔다 —
   * 옛 행의 label 을 구역 이름으로 오독하지 않게.
   */
  heading?: string;
  /** 짚는 순간의 뷰포트 `390x844` — rect·스크린샷의 좌표계. 보낼 때의 context.viewport 와 다를 수 있다 */
  viewport?: string;
  /** 짚는 순간 찍은 화면(widget_shots.id). 메시지에 붙을 때 서버가 소유를 확인한다 */
  shot?: string;
}

/** 운영자 화면이 받는 스크린샷 — 10분짜리 서명 URL + 원본 크기. 방문자에게는 절대 안 나간다 */
export interface PickedShotView {
  url: string;
  width: number;
  height: number;
}

/** 큰 영역 판정 — 안의 글자가 이보다 길면 글자 대신 구역 이름을 쓴다. `widget-pick.js` 와 같은 값(테스트 대조) */
export const AREA_TEXT_LIMIT = 40;

/** 요소 종류 → 방문자 말. `widget-pick.js` 의 KIND 표와 같아야 한다(테스트 대조) */
export const TARGET_KIND: Record<string, string> = {
  button: '버튼',
  a: '링크',
  input: '입력칸',
  textarea: '입력칸',
  select: '선택칸',
  img: '이미지',
};
export const TARGET_KIND_DEFAULT = '영역';

/** 위젯이 보낸 한국어 요소 종류 → 영어. GitHub PR 본문(영어 고정)에 쓴다 */
const TARGET_KIND_EN: Record<string, string> = {
  버튼: 'button',
  링크: 'link',
  입력칸: 'input',
  선택칸: 'select',
  이미지: 'image',
  영역: 'area',
};

/** 구역 라벨의 꼬리 — 「구역」. 위젯 칩과 같은 말(테스트 대조) */
export const AREA_WORD = '구역';

/**
 * 칩·인박스·프롬프트에 쓰는 한 줄 이름 — 「「쿠폰 받기」 버튼」. 글자가 없으면 「버튼」만.
 * 구역 이름(heading)이 있으면 「「오늘의 널널 PICK」 구역 · 1120×973」 — 큰 영역은 안의 글자로는
 * 어디인지 모른다(2026-09-25 프로덕션 짚은 요소 8건 중 절반 이상이 큰 영역). 옛 행은 heading 이 없어
 * 종전 규칙 그대로다(재가공 안 함).
 */
export function targetLabel(
  t: Pick<WidgetTarget, 'kind' | 'text' | 'label'> & Partial<Pick<WidgetTarget, 'heading' | 'rect'>>,
  max = 24,
): string {
  const kind = t.kind || TARGET_KIND_DEFAULT;
  const heading = (t.heading || '').trim();
  if (heading) {
    const cutH = Array.from(heading).length > max ? `${Array.from(heading).slice(0, max).join('')}…` : heading;
    const size = t.rect && t.rect.w > 0 && t.rect.h > 0 ? ` · ${t.rect.w}×${t.rect.h}` : '';
    return `「${cutH}」 ${AREA_WORD}${size}`;
  }
  const name = (t.text || t.label || '').trim();
  if (!name) return kind;
  const cut = Array.from(name).length > max ? `${Array.from(name).slice(0, max).join('')}…` : name;
  return `「${cut}」 ${kind}`;
}

/** `targetLabel` 의 영어판 — GitHub PR 본문용. `"Join" button` · `"Today's PICK" section · 1120×973` */
export function targetLabelEn(
  t: Pick<WidgetTarget, 'kind' | 'text' | 'label'> & Partial<Pick<WidgetTarget, 'heading' | 'rect'>>,
  max = 24,
): string {
  const kind = TARGET_KIND_EN[t.kind || TARGET_KIND_DEFAULT] ?? 'area';
  const clip = (v: string) => (Array.from(v).length > max ? `${Array.from(v).slice(0, max).join('')}…` : v);
  const heading = (t.heading || '').trim();
  if (heading) {
    const size = t.rect && t.rect.w > 0 && t.rect.h > 0 ? ` · ${t.rect.w}×${t.rect.h}` : '';
    return `"${clip(heading)}" section${size}`;
  }
  const name = (t.text || t.label || '').trim();
  return name ? `"${clip(name)}" ${kind}` : kind;
}
