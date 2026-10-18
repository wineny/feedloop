'use client';

// 바뀐 코드 — 파일별 접기, unified diff 를 줄 단위로 색칠. 라이브러리 없음 (I-19).
// 담당자용 화면에서는 접혀 있고 「개발자용」이라고 적힌다 — 판단 재료는 그 위의 설명이다.

import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PrFile } from '@/lib/auto-dev/pr-review';

interface DiffViewProps {
  files: PrFile[];
  filesTruncated?: boolean;
  /** 이 개수까지는 펼쳐 둔다. 기본 0 — 담당자는 코드를 먼저 볼 필요가 없다 */
  openFirst?: number;
}

type LineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'meta';

interface DiffLine {
  kind: LineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

/** `@@ -a,b +c,d @@` 를 따라가며 줄번호를 붙인다. 형식이 깨진 줄은 meta 로 그냥 보여준다 */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      out.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith('\\')) {
      out.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
      continue;
    }
    // 빈 줄(패치 끝) 등
    if (raw === '') continue;
    out.push({ kind: 'meta', oldNo: null, newNo: null, text: raw });
  }
  return out;
}

const STATUS_LABEL: Record<string, string> = {
  added: '새 파일',
  removed: '삭제',
  renamed: '이름 변경',
  modified: '수정',
};

export function DiffView({ files, filesTruncated, openFirst = 0 }: DiffViewProps) {
  if (files.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">바뀐 파일이 없어요.</p>;
  }
  return (
    <div>
      {files.map((f, i) => (
        <details key={f.path} className="group border-t border-border last:border-b" open={i < openFirst}>
          <summary className="grid cursor-pointer list-none grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 py-3 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-4 w-4 text-faint transition-transform group-open:rotate-90" aria-hidden />
            <span className="flex min-w-0 items-baseline gap-2">
              <code className="truncate font-mono text-[12.5px]">{f.path}</code>
              {f.status !== 'modified' && (
                <span className="shrink-0 text-[12.5px] text-faint">{STATUS_LABEL[f.status] ?? f.status}</span>
              )}
            </span>
            <span className="whitespace-nowrap text-[12.5px] tabular-nums">
              <b className="font-semibold text-[#1e6b3a] dark:text-[#7ed69a]">+{f.additions}</b>{' '}
              <b className="font-semibold text-[#a13a2f] dark:text-[#f0a19a]">−{f.deletions}</b>
            </span>
          </summary>
          {f.patch ? (
            <div className="mb-3 overflow-hidden rounded-lg border border-border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse font-mono text-[12.5px] leading-[1.6]">
                  <tbody>
                    {parsePatch(f.patch).map((line, j) => (
                      <tr
                        key={j}
                        className={cn(
                          line.kind === 'add' && 'bg-[#ecf7ee] text-[#1d5e34] dark:bg-[#12281a] dark:text-[#9fdcb2]',
                          line.kind === 'del' && 'bg-[#fdeeed] text-[#8f3a31] dark:bg-[#2e1614] dark:text-[#f0a9a2]',
                          line.kind === 'hunk' && 'bg-muted text-muted-foreground',
                          line.kind === 'meta' && 'text-faint',
                        )}
                      >
                        <td
                          className={cn(
                            'w-10 select-none border-r border-border px-2 text-right text-[12.5px] text-faint',
                            line.kind === 'add' && 'bg-[#d9eedf] text-[#1d5e34] dark:bg-[#1a3a25] dark:text-[#9fdcb2]',
                            line.kind === 'del' && 'bg-[#f6d9d6] text-[#8f3a31] dark:bg-[#45201c] dark:text-[#f0a9a2]',
                            line.kind !== 'add' && line.kind !== 'del' && 'bg-muted',
                          )}
                        >
                          {line.oldNo ?? ''}
                        </td>
                        <td
                          className={cn(
                            'w-10 select-none border-r border-border px-2 text-right text-[12.5px] text-faint',
                            line.kind === 'add' && 'bg-[#d9eedf] text-[#1d5e34] dark:bg-[#1a3a25] dark:text-[#9fdcb2]',
                            line.kind === 'del' && 'bg-[#f6d9d6] text-[#8f3a31] dark:bg-[#45201c] dark:text-[#f0a9a2]',
                            line.kind !== 'add' && line.kind !== 'del' && 'bg-muted',
                          )}
                        >
                          {line.newNo ?? ''}
                        </td>
                        <td className="w-5 select-none text-center">
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
                        </td>
                        <td className="whitespace-pre pr-3">{line.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {f.patchTruncated && (
                <p className="border-t border-border px-3 py-1.5 text-[12.5px] text-faint">
                  변경이 길어 앞부분만 보여요. 전체는 GitHub 에서 볼 수 있어요.
                </p>
              )}
            </div>
          ) : (
            <p className="mb-3 text-[12.5px] text-faint">이 파일은 미리 볼 수 없어요 (바이너리이거나 너무 커요).</p>
          )}
        </details>
      ))}
      {filesTruncated && (
        <p className="pt-2 text-[12.5px] text-faint">파일이 100개를 넘어 일부만 보여요. 전체는 GitHub 에서 볼 수 있어요.</p>
      )}
    </div>
  );
}
