// 사전은 화면별 파일(`messages/<locale>/<namespace>.json`)로 나뉘어 있다.
// 새 파일을 만들면 아래 목록에도 넣는다(`__tests__/i18n-messages.test.ts` 가 목록과 폴더가 같은지 본다).
export const MESSAGE_NAMESPACES = ['common', 'meta', 'notFound', 'landing', 'nav', 'auth', 'pricing', 'inbox', 'picked', 'bots', 'connect', 'llm', 'github', 'dashboard'] as const;

export type MessageNamespace = (typeof MESSAGE_NAMESPACES)[number];

// 클라이언트 컴포넌트가 브라우저로 받는 사전. 서버 컴포넌트는 `request.ts` 가 합친 전체 사전을 쓰므로 여기 안 넣어도 된다.
// `[locale]/layout.tsx` 가 LAYOUT_NAMESPACES 를 싣고, 각 구역의 layout.tsx(또는 page.tsx)가 PAGE_NAMESPACES 를 더 싣는다.
// 클라이언트에서 namespace 를 새로 쓰면 여기에도 넣는다 — `__tests__/i18n-page-namespaces.test.ts` 가 빠진 것을 잡는다.
export const LAYOUT_NAMESPACES = ['common', 'nav', 'auth'] as const satisfies readonly MessageNamespace[];

export const PAGE_NAMESPACES = {
  landing: ['landing'],
  pricing: ['pricing'],
  inbox: ['inbox', 'picked', 'dashboard'],
  dashboard: ['dashboard'],
  classify: ['dashboard', 'picked'],
  monitor: ['dashboard', 'picked'],
  bots: ['bots'],
  'bots.new': ['llm'],
  'bots.connect': ['connect'],
  'bots.knowledge': ['github', 'inbox', 'llm'],
} as const satisfies Record<string, readonly MessageNamespace[]>;

export type PageKey = keyof typeof PAGE_NAMESPACES;
