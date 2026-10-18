'use client';

// 실행 로그 — SSE 스트림을 한 줄씩 받아 그린다.
// 널널투어 v2: 검은 터미널 흉내 대신 `bg-muted` 위에 모노 12.5px. 마지막 완료 줄만 브랜드색.

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface LogLine {
  type: 'log' | 'complete' | 'error';
  message: string;
  pr_url?: string;
  pr_number?: number;
  files_changed?: object[];
}

export interface CompletionData {
  pr_url: string;
  pr_number: number;
  files_changed: object[];
  duration_ms: number;
}

interface TerminalLogProps {
  streamUrl?: string;
  onComplete?: (data: CompletionData) => void;
  onSettled?: () => void;
  /** 스트림 없이 고정 줄만 보여줄 때(데모) */
  staticLines?: { type: string; message: string }[];
  className?: string;
}

export function TerminalLog({ streamUrl, onComplete, onSettled, staticLines, className }: TerminalLogProps) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [live, setLive] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 최신 onComplete 를 ref 로 들고 있어야 스트림 effect 가 콜백이 바뀔 때마다 재구독하지 않는다.
  const onSettledRef = useRef(onSettled);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onSettledRef.current = onSettled;
  });
  const startTimeRef = useRef(0);

  // streamUrl 이 바뀌면 로그를 비운다 — "렌더 중 파생 상태 조정" 패턴.
  const [shownUrl, setShownUrl] = useState(streamUrl);
  if (shownUrl !== streamUrl) {
    setShownUrl(streamUrl);
    setLines([]);
    setLive(true);
  }

  useEffect(() => {
    if (!streamUrl) return;
    startTimeRef.current = Date.now();

    const eventSource = new EventSource(streamUrl);

    eventSource.onmessage = (event) => {
      try {
        const data: LogLine = JSON.parse(event.data);
        setLines((prev) => [...prev, data]);

        if (data.type === 'complete') {
          setLive(false);
          eventSource.close();
          onCompleteRef.current?.({
            pr_url: data.pr_url || '',
            pr_number: data.pr_number || 0,
            files_changed: data.files_changed || [],
            duration_ms: Date.now() - startTimeRef.current,
          });
        }

        if (data.type === 'complete' || data.type === 'error') onSettledRef.current?.();

        if (data.type === 'error') {
          setLive(false);
          eventSource.close();
        }
      } catch {
        // 파싱 실패 무시
      }
    };

    eventSource.onerror = () => {
      setLive(false);
      eventSource.close();
      setLines((prev) => [...prev, { type: 'error', message: '실시간 연결이 끊어졌어요. 저장된 실행 상태를 다시 확인합니다.' }]);
      onSettledRef.current?.();
    };

    return () => {
      eventSource.close();
    };
  }, [streamUrl]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [lines]);

  const visibleLines: LogLine[] = staticLines
    ? (staticLines as LogLine[])
    : streamUrl
      ? lines
      : [{ type: 'log', message: '실행을 선택하면 로그가 여기 흐릅니다' }];

  return (
    <div
      ref={scrollRef}
      className={cn(
        'max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-muted px-4 py-3.5 font-mono text-[12.5px] leading-[1.7] text-muted-foreground',
        className,
      )}
    >
      {visibleLines.map((line, i) => (
        <div
          key={i}
          className={cn(
            line.type === 'complete' && 'font-semibold text-brand-strong',
            line.type === 'error' && 'font-semibold text-destructive',
          )}
        >
          {line.type === 'complete' && !line.message ? `PR #${line.pr_number} 생성 완료!` : line.message || ' '}
        </div>
      ))}
      {streamUrl && live && !staticLines && (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-foreground align-middle" aria-hidden />
      )}
    </div>
  );
}
