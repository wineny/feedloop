'use client';

// The AG Studio instance behind Refund Studio. Loaded only by `/dashboard/refunds` through `next/dynamic`
// (ssr:false) — AG Studio pulls in AG Grid/Charts Enterprise, so no other page carries it.
//
// Always the sample store (`lib/studio/sample.ts`): it reads and writes nothing in the database, logged in or not.
// Layout edits live only in this browser tab; Reset puts the built-in report back.

import { useMemo, useState } from 'react';
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

export default function RefundStudio({ licenseKey, aiEnabled, mode, onApi }: RefundStudioProps) {
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
        onApiReady={(event) => onApi?.(event.api as AgStudioApi)}
      />
    </AgStudioProvider>
  );
}
