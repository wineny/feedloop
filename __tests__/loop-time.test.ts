import { describe, expect, it } from 'vitest';
import {
  EMPTY_LOOP_TIME,
  FAILED_LOOP_TIME,
  formatLoopDuration,
  loopClosedConversationIds,
  loopTimeStats,
  type LoopTimeInsight,
  type LoopTimeMessage,
  type LoopTimeResponse,
  type LoopTimeRun,
} from '@/lib/dashboard/loop-time';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const base = Date.parse('2026-09-15T00:00:00.000Z');
const at = (ms: number) => new Date(base + ms).toISOString();

function fixtures(): {
  responses: LoopTimeResponse[];
  runs: LoopTimeRun[];
  insights: LoopTimeInsight[];
  messages: LoopTimeMessage[];
} {
  return {
    responses: [
      { conversation_id: 'conv-1', response_type: 'loop_closed', delivered_at: at(2 * DAY), auto_dev_run_id: 'run-1' },
    ],
    runs: [{ id: 'run-1', insight_id: 'ins-1', group_id: null }],
    insights: [{ id: 'ins-1', message_id: 'msg-1', source_message_ids: [], group_id: null }],
    messages: [{ id: 'msg-1', conversation_id: 'conv-1', detected_at: at(0) }],
  };
}

describe('루프 시간 — 제보에서 반영 알림까지', () => {
  it('전달된 되돌림과 그 실행에 묶인 첫 제보의 간격을 잰다', () => {
    const f = fixtures();
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages)).toEqual({ state: 'ok', sampleSize: 1, averageMs: 2 * DAY });
  });

  it('아직 전달되지 않은 되돌림은 표본에서 뺀다 — 끝나지 않은 루프다', () => {
    const f = fixtures();
    f.responses.push({ conversation_id: 'conv-1', response_type: 'loop_closed', delivered_at: null, auto_dev_run_id: 'run-1' });
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages).sampleSize).toBe(1);
  });

  it('되돌림이 아닌 응답(운영자 답장·즉답)은 세지 않는다', () => {
    const f = fixtures();
    f.responses.push({ conversation_id: 'conv-1', response_type: 'operator', delivered_at: at(HOUR), auto_dev_run_id: 'run-1' });
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages).sampleSize).toBe(1);
  });

  it('같은 대화의 다른 문제(그 실행과 무관한 제보)는 분자를 부풀리지 않는다', () => {
    const f = fixtures();
    f.insights.push({ id: 'ins-9', message_id: 'msg-9', source_message_ids: [], group_id: 'group-9' });
    // 훨씬 이른 제보지만 run-1 과 묶이지 않았다 — 후보에서 빠져야 평균이 2일 그대로다.
    f.messages.push({ id: 'msg-9', conversation_id: 'conv-1', detected_at: at(-5 * DAY) });
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages).averageMs).toBe(2 * DAY);
  });

  it('묶음(group) 실행은 그 묶음의 인사이트 전부에서 첫 제보를 찾는다', () => {
    const responses: LoopTimeResponse[] = [
      { conversation_id: 'conv-1', response_type: 'loop_closed', delivered_at: at(DAY), auto_dev_run_id: 'run-g' },
    ];
    const runs: LoopTimeRun[] = [{ id: 'run-g', insight_id: null, group_id: 'group-1' }];
    const insights: LoopTimeInsight[] = [
      { id: 'ins-a', message_id: 'msg-a', source_message_ids: [], group_id: 'group-1' },
      { id: 'ins-b', message_id: 'msg-b', source_message_ids: [], group_id: 'group-1' },
    ];
    const messages: LoopTimeMessage[] = [
      { id: 'msg-a', conversation_id: 'conv-1', detected_at: at(6 * HOUR) },
      { id: 'msg-b', conversation_id: 'conv-1', detected_at: at(2 * HOUR) },
    ];
    expect(loopTimeStats(responses, runs, insights, messages).averageMs).toBe(22 * HOUR);
  });

  it('중복 제보로 흡수된 메시지(source_message_ids)도 첫 제보 후보다', () => {
    const f = fixtures();
    f.insights[0].source_message_ids = ['msg-0'];
    f.messages.push({ id: 'msg-0', conversation_id: 'conv-1', detected_at: at(-HOUR) });
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages).averageMs).toBe(2 * DAY + HOUR);
  });

  it('다른 대화의 제보는 이 되돌림의 시작점이 아니다', () => {
    const f = fixtures();
    f.messages[0] = { id: 'msg-1', conversation_id: 'conv-other', detected_at: at(0) };
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages)).toEqual({ state: 'empty', sampleSize: 0, averageMs: null });
  });

  it('되돌림보다 나중에 들어온 제보만 남으면 표본에서 뺀다', () => {
    const f = fixtures();
    f.messages[0] = { id: 'msg-1', conversation_id: 'conv-1', detected_at: at(3 * DAY) };
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages).sampleSize).toBe(0);
  });

  it('표본이 없으면 평균을 0 이 아니라 null 로 둔다', () => {
    expect(loopTimeStats([], [], [], [])).toEqual({ state: 'empty', sampleSize: 0, averageMs: null });
  });

  it('「표본 없음」과 「집계 못 함」은 다른 상태다', () => {
    expect(EMPTY_LOOP_TIME.state).toBe('empty');
    expect(FAILED_LOOP_TIME.state).toBe('error');
  });

  it('인사이트가 많아도 되돌림마다 전부 훑지 않는다 — 실행 id·묶음 id 로 바로 찾는다', () => {
    // 묶음에 속하지 않은 인사이트 500개를 섞어도 결과가 같아야 한다(색인이 맞는지 보는 회귀).
    const f = fixtures();
    for (let i = 0; i < 500; i += 1) {
      f.insights.push({ id: `noise-${i}`, message_id: `noise-msg-${i}`, source_message_ids: [], group_id: `noise-group-${i}` });
      f.messages.push({ id: `noise-msg-${i}`, conversation_id: 'conv-1', detected_at: at(-10 * DAY) });
    }
    expect(loopTimeStats(f.responses, f.runs, f.insights, f.messages).averageMs).toBe(2 * DAY);
  });

  it('여러 건이면 산술 평균이다', () => {
    const responses: LoopTimeResponse[] = [
      { conversation_id: 'conv-1', response_type: 'loop_closed', delivered_at: at(DAY), auto_dev_run_id: 'run-1' },
      { conversation_id: 'conv-2', response_type: 'loop_closed', delivered_at: at(3 * DAY), auto_dev_run_id: 'run-1' },
    ];
    const runs: LoopTimeRun[] = [{ id: 'run-1', insight_id: null, group_id: 'group-1' }];
    const insights: LoopTimeInsight[] = [
      { id: 'ins-1', message_id: 'msg-1', source_message_ids: [], group_id: 'group-1' },
      { id: 'ins-2', message_id: 'msg-2', source_message_ids: [], group_id: 'group-1' },
    ];
    const messages: LoopTimeMessage[] = [
      { id: 'msg-1', conversation_id: 'conv-1', detected_at: at(0) },
      { id: 'msg-2', conversation_id: 'conv-2', detected_at: at(DAY) },
    ];
    expect(loopTimeStats(responses, runs, insights, messages)).toEqual({ state: 'ok', sampleSize: 2, averageMs: 1.5 * DAY });
  });

  it('표본 조회 범위 — 전달된 되돌림이 간 대화만 모은다', () => {
    const responses: LoopTimeResponse[] = [
      { conversation_id: 'conv-1', response_type: 'loop_closed', delivered_at: at(0), auto_dev_run_id: 'run-1' },
      { conversation_id: 'conv-1', response_type: 'loop_closed', delivered_at: at(HOUR), auto_dev_run_id: 'run-2' },
      { conversation_id: 'conv-2', response_type: 'loop_closed', delivered_at: null, auto_dev_run_id: 'run-3' },
      { conversation_id: 'conv-3', response_type: 'ai', delivered_at: at(0), auto_dev_run_id: null },
    ];
    expect(loopClosedConversationIds(responses)).toEqual(['conv-1']);
  });
});

describe('루프 시간 표기 — 사람이 읽는 단위 하나', () => {
  it.each([
    [30_000, '1분 미만'],
    [37 * 60_000, '37분'],
    [59.6 * 60_000, '1시간'],
    [5 * HOUR, '5시간'],
    [23.6 * HOUR, '1일'],
    [2.4 * DAY, '2.4일'],
    [2 * DAY, '2일'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatLoopDuration(ms)).toBe(expected);
  });

  it('음수·NaN 은 시간을 지어내지 않는다', () => {
    expect(formatLoopDuration(-1)).toBe('아직 없음');
    expect(formatLoopDuration(Number.NaN)).toBe('아직 없음');
  });
});
