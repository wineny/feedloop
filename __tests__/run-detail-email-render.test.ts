import React from 'react';
import { renderWithIntl } from './helpers/intl';
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
 ['delivery_unknown','Email delivery needs checking · resend on hold until the provider confirms'],
 ['failed','Email failed · can retry'],
 // 합류 되돌림은 메일을 «일부러» 안 붙인다. pending 과 같은 화면이면 운영자가 장애로 읽는다.
 ['skipped','Email not sent · joined a repeat report'],
])('renders %s independently of channel delivery with bounded escaped diagnostics', (status,label) => {
 const html=renderWithIntl(React.createElement(RunDetail,{run:{...run,returns:[{conversationId:'c',source:'web',name:'Visitor',deliveredAt:'2026-09-13T02:00:00Z',confirmation:null,confirmedAt:null,emailSentAt:null,emailDeliveryStatus:status,emailError:'<script>alert(1)</script>\n'+'x'.repeat(200)}]},readOnly:true}));
 expect(html).toContain(label);
 expect(html).toContain('Delivered');
 expect(html).toContain('&lt;script&gt;');
 expect(html).not.toContain('<script>');
 expect(html).not.toContain('x'.repeat(161));
 expect(html).not.toContain('Email sent');
});
