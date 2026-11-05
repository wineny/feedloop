'use client';

// The AG Studio instance behind Refund Studio. Loaded only by `/dashboard/refunds` through `next/dynamic`
// (ssr:false) — AG Studio pulls in AG Grid/Charts Enterprise, so no other page carries it.
//
// Always the sample store (`lib/studio/sample.ts`): it reads and writes nothing in the database, logged in or not.
// Layout edits live only in this browser tab; Reset puts the built-in report back.

import { useEffect, useMemo, useRef, useState } from 'react';
import { AgStudio, AgStudioProvider, createWidgets } from 'ag-studio-react';
import { AgStudioAiModule, enableStudioDevValidations, type AgDataSourcesDefinition, type AgDefaultRegistry, type AgReportState, type AgStudioApi, type AgStudioMode, type AgWidgetsConfig } from 'ag-studio';
import { buildSampleStore } from '@/lib/studio/sample';
import { buildStudioData } from '@/lib/studio/data';
import { feedloopStudioTheme } from '@/lib/studio/theme';
import { initialReport } from '@/lib/studio/initial-report';
import { buildStudioAi } from '@/lib/studio/ai';
import { reasonFixDefinition, REASON_FIX_WIDGET, type StudioContext, type StudioRegistry } from './ReasonFixWidget';

if (process.env.NODE_ENV !== 'production') {
  enableStudioDevValidations();
}

export interface RefundStudioProps {
  licenseKey?: string;
  /** Show the agent chat. Off when the server has no LLM key for Studio. */
  aiEnabled: boolean;
  mode: AgStudioMode;
  onApi?: (api: AgStudioApi) => void;
}

/** Put the built-in report back (the page's Reset button). */
export function resetStudio(api: AgStudioApi) {
  api.setState(initialReport());
  api.clearHistory();
}

/** Entering edit mode opens Studio's compose and data panels; start with just the AI chat beside the canvas. */
const CHAT_FIRST_PANELS = { filters: { collapsed: true }, edit: { collapsed: true }, data: { collapsed: true } };

export default function RefundStudio({ licenseKey, aiEnabled, mode, onApi }: RefundStudioProps) {
  const apiRef = useRef<AgStudioApi | null>(null);
  const store = useMemo(() => buildSampleStore(), []);
  // Data and report state are registry-generic; ours only adds the Reason → Fix widget type.
  const data = useMemo(() => buildStudioData(store) as unknown as AgDataSourcesDefinition<StudioRegistry>, [store]);
  const context = useMemo<StudioContext>(() => ({ asOf: store.asOf }), [store]);
  const [initialState] = useState(() => initialReport() as unknown as AgReportState<StudioRegistry>);
  const widgets = useMemo(
    () => (defaults: AgWidgetsConfig<AgDefaultRegistry>) =>
      createWidgets<StudioRegistry>({
        additionalTypes: [reasonFixDefinition],
        menu: [...defaults.menu, { label: 'Feedloop', widgetIds: [REASON_FIX_WIDGET] }],
      }),
    [],
  );
  // Studio ignores collapsed panels from initial state when the mode switches to edit; setting them after the
  // switch works (checked in the browser, AG Studio 3.0.0).
  useEffect(() => {
    const api = apiRef.current;
    if (mode !== 'edit' || !api) return;
    const id = window.setTimeout(() => api.setState({ ...api.getState(), panels: CHAT_FIRST_PANELS }), 0);
    return () => window.clearTimeout(id);
  }, [mode]);

  // `ai` is read once, when Studio is created.
  const ai = useMemo(() => (aiEnabled ? buildStudioAi(store) : undefined), [aiEnabled, store]);

  return (
    <AgStudioProvider licenseKey={licenseKey} modules={ai ? [AgStudioAiModule] : undefined}>
      <AgStudio<StudioRegistry>
        style={{ height: '100%', width: '100%' }}
        theme={feedloopStudioTheme}
        layout={{ widgetBorderEnabled: true }}
        data={data}
        context={context}
        widgets={widgets}
        ai={ai}
        initialState={initialState}
        mode={mode}
        onApiReady={(event) => {
          const api = event.api as AgStudioApi;
          apiRef.current = api;
          // Development only: lets the browser console read Studio state (`__refundStudio.getState()`).
          if (process.env.NODE_ENV !== 'production') (window as unknown as { __refundStudio?: AgStudioApi }).__refundStudio = api;
          onApi?.(api);
        }}
      />
    </AgStudioProvider>
  );
}
