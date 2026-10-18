import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RunItem } from '@/app/api/auto-dev/runs/route';
vi.mock('@/components/monitor/PrReviewPanel', () => ({ PrReviewPanel: () => null }));
vi.mock('@/components/monitor/TerminalLog', () => ({ TerminalLog: () => null }));
vi.mock('@/components/dashboard/RecentFeedback', () => ({ ChannelChip: () => null }));
import { RunDetail } from '@/components/monitor/RunDetail';
beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());
const run: RunItem = {
 id:'run',status:'completed',createdAt:'2026-09-13T01:00:00Z',durationMs:100,title:'Test',category:'bug',repo:'test/repo',
 pr:{url:'https://github.com/test/repo/pull/1',number:1,mergedAt:'2026-09-13T02:00:00Z',closedAt:null,closeReason:null,closeNote:null},
 filesChanged:[],errorMessage:null,evidence:{insightCount:1,conversationCount:1},explanation:null,returns:[],
};
it.each([
 ['delivery_unknown','메일 전달 확인 필요 · 제공업체 확인 전 재발송 보류'],
 ['failed','메일 전송 실패 · 재시도 가능'],
 // 합류 되돌림은 메일을 «일부러» 안 붙인다. pending 과 같은 화면이면 운영자가 장애로 읽는다.
 ['skipped','메일 안 보냄 · 재제보 합류'],
])('renders %s independently of channel delivery with bounded escaped diagnostics', (status,label) => {
 const html=renderToStaticMarkup(React.createElement(RunDetail,{run:{...run,returns:[{conversationId:'c',source:'web',name:'Visitor',deliveredAt:'2026-09-13T02:00:00Z',confirmation:null,confirmedAt:null,emailSentAt:null,emailDeliveryStatus:status,emailError:'<script>alert(1)</script>\n'+'x'.repeat(200)}]},readOnly:true}));
 expect(html).toContain(label);
 expect(html).toContain('전달됨');
 expect(html).toContain('&lt;script&gt;');
 expect(html).not.toContain('<script>');
 expect(html).not.toContain('x'.repeat(161));
 expect(html).not.toContain('메일 발송');
});
