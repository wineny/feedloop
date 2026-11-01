// Refund Studio's Agent Framework setup: AG Studio's five built-in agents + Feedloop's own "Refund Watch", all on
// Claude (`claude-adapter.ts`). Refund Watch fronts the chat (primary). It has three tools of its own — read the
// refund reasons, look up a reason's fix, place a Reason → Fix alert — and hands dashboard building to the built-in
// Lead, Page and Widget agents through `delegate_to`.
//
// Nothing here writes outside the browser: tools read the sample store and change only the report on screen.

import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgReportState, type AgStudioApi } from 'ag-studio';
import { REASON_FIX_WIDGET } from '@/components/studio/ReasonFixWidget';
import { claudeAdapter } from './claude-adapter';
import { reasonWindows, SAMPLE_REASONS, type SampleStore } from './sample';
import { STUDIO_PAGE_ID } from './initial-report';

const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: 'Which refund reason is repeating?', prompt: 'Which refund reason is repeating right now, and has its fix shipped?' },
  { label: 'Build a spike alert', prompt: 'Build a spike alert for the refund reason that is rising fastest.' },
  { label: 'Refunds vs revenue by week', prompt: 'Add a chart of weekly revenue and refunded amount.' },
];

const ALERT_HEIGHT = 9;

/** Put a Reason → Fix alert for `reasonKey` at the top of the page, moving everything else down. Idempotent per reason. */
export function placeReasonAlert(api: AgStudioApi, reasonKey: string, windowDays: number, label: string): string {
  const state = api.getState() as AgReportState;
  const widgetId = `alert-${reasonKey}`;
  const pages = state.pages.map((page) => {
    if (page.id !== (state.selectedPageId ?? STUDIO_PAGE_ID)) return page;
    const exists = Boolean(page.widgets?.[widgetId]);
    const layout = Object.fromEntries(
      Object.entries(page.widgetLayout ?? {}).map(([id, l]) => [id, !l || exists || id === widgetId ? l : { ...l, yTrack: l.yTrack + ALERT_HEIGHT }]),
    );
    layout[widgetId] = exists ? layout[widgetId] : { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: ALERT_HEIGHT };
    return {
      ...page,
      widgets: {
        ...page.widgets,
        [widgetId]: {
          type: REASON_FIX_WIDGET,
          format: {
            title: { enabled: true, text: `Refund alert: ${label}` },
            style: { highlightReasonKey: reasonKey, windowDays },
          },
        },
      },
      widgetLayout: layout,
      selection: { type: 'widget', id: widgetId },
    };
  });
  api.setState({ ...state, pages } as AgReportState);
  return widgetId;
}

const INSTRUCTIONS = (asOf: string) =>
  [
    'You are Refund Watch, the refund analyst inside Feedloop’s Refund Studio (an AG Studio dashboard).',
    'Feedloop is an AI support agent for small online stores. When a customer asks for a refund, it records the reason and classifies it:',
    '"Bug / UX" reasons go to a fix pull request, "Feature request" reasons to a spec, "Other" needs no code. The product idea: every refund has a reason.',
    `The data is a fixed 90-day SAMPLE store ending ${asOf} (tables "payments" and "refunds"). Say "sample data" if you quote numbers; never present them as measured.`,
    '',
    'How to work:',
    '1. For any question about refund reasons, call scan_refund_reasons first. Use only the numbers it returns — never invent counts or money.',
    '2. Call find_fix_for_reason for the reason you talk about, and say where its fix is (PR merged / PR open / spec drafted / no fix needed).',
    '3. When asked for an alert, or when a reason is clearly rising (recent > previous), call add_reason_alert for it.',
    '4. For any other dashboard change (charts, grids, filters, layout), delegate: "widget" configures one widget, "page" adds or arranges widgets on a page, "lead" handles anything broader.',
    '   Tell the delegate the exact fields to use, e.g. refunds.reason, refunds.amount (sum), payments.amount (sum), calendar::week.',
    'Answer in short English: what is happening, which reason, where its fix is. Two to four sentences.',
  ].join('\n');

export function buildStudioAi(store: SampleStore): AgAiHarnessSetup {
  const adapter = claudeAdapter();
  const reasonKeys = SAMPLE_REASONS.map((r) => r.key);

  return ({ api }) =>
    createAiHarness(api, ({ builtIn, tools }) => {
      const scan = api.defineAiTool({
        name: 'scan_refund_reasons',
        description:
          'Count refunds per reason: the last N days vs the N days before, plus the total, with each reason’s type and fix status. ' +
          'Sorted by recent count. Read-only.',
        params: (s) => s.object({ windowDays: s.number({ description: 'Window length in days, 3–30. Default 7.' }).optional() }),
        execute: (args: { windowDays?: number }, ctx) => {
          const windowDays = Math.min(30, Math.max(3, Math.round(args.windowDays ?? 7)));
          const rows = reasonWindows(store.refunds, store.asOf, windowDays).map((w) => ({
            reasonKey: w.reasonKey,
            reason: w.reason,
            type: w.bucket,
            fixStatus: w.fixStatus,
            [`last${windowDays}Days`]: w.recent,
            [`previous${windowDays}Days`]: w.previous,
            total90Days: w.total,
            rising: w.recent > w.previous,
          }));
          return ctx.success(JSON.stringify({ sample: true, asOf: store.asOf, windowDays, reasons: rows }));
        },
      });

      const findFix = api.defineAiTool({
        name: 'find_fix_for_reason',
        description: 'Where a refund reason went: fix PR (with status), spec, or nothing. Read-only.',
        params: (s) => s.object({ reasonKey: s.enum(reasonKeys, { description: 'reasonKey from scan_refund_reasons' }) }),
        execute: (args: { reasonKey: string }, ctx) => {
          const r = SAMPLE_REASONS.find((x) => x.key === args.reasonKey);
          if (!r) return ctx.error(`Unknown reasonKey "${args.reasonKey}".`);
          const pr = r.fixUrl ? { number: Number(r.fixUrl.split('/').pop()), url: r.fixUrl, sampleAddress: true } : null;
          return ctx.success(JSON.stringify({ reasonKey: r.key, reason: r.label, type: r.bucket, fixStatus: r.fixStatus, pr }));
        },
      });

      const addAlert = api.defineAiTool({
        name: 'add_reason_alert',
        description:
          'Place a "Reason → Fix" alert widget for one refund reason at the top of the dashboard: refunds in the last N days vs the N days before, and the fix status. ' +
          'Calling it again for the same reason updates that alert.',
        params: (s) =>
          s.object({
            reasonKey: s.enum(reasonKeys, { description: 'reasonKey from scan_refund_reasons' }),
            windowDays: s.number({ description: 'Window length in days, 3–30. Default 7.' }).optional(),
          }),
        execute: (args: { reasonKey: string; windowDays?: number }, ctx) => {
          const r = SAMPLE_REASONS.find((x) => x.key === args.reasonKey);
          if (!r) return ctx.error(`Unknown reasonKey "${args.reasonKey}".`);
          const windowDays = Math.min(30, Math.max(3, Math.round(args.windowDays ?? 7)));
          const widgetId = placeReasonAlert(api, r.key, windowDays, r.label);
          return ctx.success(`Placed alert widget "${widgetId}" for "${r.label}" (${windowDays}-day window) at the top of the page.`);
        },
      });

      const refundWatch = directLlmRunner({
        id: 'refund-watch',
        name: 'Refund Watch',
        description: 'Finds which refund reason is repeating, says where its fix is, and places refund alerts.',
        schema: (s) => s.undefined(),
        adapter,
        instructions: () => INSTRUCTIONS(store.asOf),
        tools: () => [
          scan,
          findFix,
          addAlert,
          tools.studio.viewSchema(),
          tools.studio.viewPage(),
          tools.studio.executeQuery(),
          tools.delegateTo(['lead', 'page', 'widget']),
        ],
        maxTurns: 16,
      });

      return {
        agents: [refundWatch, ...Object.values(builtIn).map((definition) => directLlmRunner({ ...definition, adapter }))],
        primary: 'refund-watch',
        promptStarters: PROMPT_STARTERS,
      };
    });
}
