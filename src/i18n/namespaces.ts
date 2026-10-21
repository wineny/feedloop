// 사전은 화면별 파일(`messages/<locale>/<namespace>.json`)로 나뉘어 있고 `request.ts` 가 하나로 합친다.
// 새 파일을 만들면 아래 목록에도 넣는다(`__tests__/i18n-messages.test.ts` 가 목록과 폴더가 같은지 본다).
export const MESSAGE_NAMESPACES = ['common', 'meta', 'notFound', 'landing', 'nav', 'auth', 'pricing', 'inbox', 'picked', 'bots', 'connect', 'llm', 'github', 'dashboard'] as const;
