// 밑줄 탭 — 널널투어 v2. radix Tabs 를 쓰되 알약 상자를 걷어내고 inbox·monitor 의
// 인라인 탭(`border-b-2` · 활성 = 잉크 · 비활성 = faint)과 같은 모양으로 맞춘다.
//
// 프리미티브의 `variant="line"` 이 그리는 after: 밑줄은 trigger 아래 5px 에 뜨고 그 위치를
// 바깥에서 이기기 어렵다(group 변형이라 특이도가 높다). 그래서 after 는 숨기고
// inbox 처럼 trigger 자체의 border-b-2 로 긋는다. 목록의 헤어라인과 겹치도록 -mb-px.

/** `<TabsList variant="line" className={LINE_TABS_LIST}>` */
export const LINE_TABS_LIST =
  'group-data-[orientation=horizontal]/tabs:h-auto w-full justify-start gap-5 rounded-none border-b border-border p-0';

/** `<TabsTrigger className={LINE_TAB}>` */
export const LINE_TAB =
  '-mb-px h-auto min-h-10 flex-none rounded-none border-0 border-b-2 border-transparent px-0 text-sm font-semibold text-faint transition-colors hover:text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none after:hidden';
