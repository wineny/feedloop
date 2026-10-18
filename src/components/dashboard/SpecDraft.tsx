// 스펙 초안 본문. `<pre>` 에 원문을 넣던 자리(I-21) — 소제목·불릿·굵게만 풀고 나머지는 원문 그대로다.
// 해석은 `spec-markdown.ts`(순수 함수, 테스트 대상)가 하고 여기는 그리기만 한다.
// v4: 본문 14 한 단계만 쓴다 — 13px 는 이 시스템에서 사라졌다.

import { parseSpecMarkdown, type SpecInline } from '@/lib/groups/spec-markdown';

function Inlines({ inlines }: { inlines: SpecInline[] }) {
  return (
    <>
      {inlines.map((s, i) =>
        s.bold ? (
          <b key={i} className="font-semibold text-foreground">
            {s.text}
          </b>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export function SpecDraft({ text }: { text: string }) {
  const blocks = parseSpecMarkdown(text);
  return (
    <div className="flex flex-col gap-2 break-words text-sm leading-relaxed text-foreground">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          return (
            <h4 key={i} className={i === 0 ? 'font-semibold' : 'mt-2 font-semibold'}>
              {block.text}
            </h4>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inlines inlines={item} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line">
            <Inlines inlines={block.inlines} />
          </p>
        );
      })}
    </div>
  );
}
